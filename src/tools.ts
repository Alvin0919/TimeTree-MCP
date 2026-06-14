/**
 * MCP tools for TimeTree.
 *
 * Two tools:
 *   - list_calendars: enumerate shared calendars (no args).
 *   - create_event:   accepts human-friendly ISO date strings + a timezone,
 *                     converts to TimeTree's ms-timestamp shape internally.
 *
 * The friendly tool layer absorbs three messy bits so Claude doesn't have to:
 *   1. ms timestamp conversion
 *   2. default timezone (Asia/Taipei for TW user)
 *   3. sensible defaults for missing `end` (timed: +1h, all-day: same day)
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  CreateEventToolInputSchema,
  DEFAULT_TIMEZONE,
  ListEventsToolInputSchema,
  MarkPosterProcessedToolInputSchema,
  PosterWorkspaceToolInputSchema,
  UpdateEventToolInputSchema,
  type ManagedEventBody,
  type PublicCalendar,
  type PublicEvent,
} from './types.js';
import {
  AuthError,
  PublicTimeTreeClient,
  TimeTreeError,
  logger,
  type TimeTreeClient,
} from './timetree.js';

export type MCPToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  handler: (args: unknown) => Promise<MCPToolResult>;
}

function ok(payload: unknown): MCPToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function err(error: string, message: string, details?: unknown): MCPToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { error, message, ...(details !== undefined && { details }) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

// ============================================================================
// ISO date → UTC ms (in a given IANA timezone)
// ============================================================================

/**
 * Compute the IANA timezone's offset (in ms, east-positive) from UTC at a
 * specific instant.
 *
 * Trick: take an instant in UTC, render it in the target timezone, then
 * convert THAT wall-clock back as if it were UTC. The difference is the offset.
 *
 * Caveat: near DST transitions the offset can be ambiguous (a wall-clock
 * time may not exist, or exist twice). For non-DST timezones like Asia/Taipei
 * this is exact. We deliberately don't pull in a heavy TZ library for MVP.
 */
function getTzOffsetMs(instant: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(instant));
  const v: Record<string, string> = {};
  for (const p of parts) v[p.type] = p.value;
  // Intl occasionally reports "24" for midnight; normalize.
  const hour = v.hour === '24' ? 0 : Number(v.hour);
  const tzAsUtc = Date.UTC(
    Number(v.year),
    Number(v.month) - 1,
    Number(v.day),
    hour,
    Number(v.minute),
    Number(v.second),
  );
  return tzAsUtc - instant;
}

/**
 * Interpret an ISO string like "2026-06-15T19:00" or "2026-06-15" as a
 * wall-clock time in `timezone` and return the corresponding UTC unix-ms.
 *
 * Note: trailing "Z" or explicit offsets in the ISO string are ignored —
 * the `timezone` argument is authoritative. This keeps Claude from having
 * to encode the offset itself.
 */
export function isoToUtcMs(iso: string, timezone: string): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) throw new Error(`Invalid ISO date: "${iso}". Expected YYYY-MM-DD or YYYY-MM-DDTHH:mm`);
  const [, yyyy, mm, dd, hh = '00', mi = '00', ss = '00'] = m;
  const wallMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  const offsetMs = getTzOffsetMs(wallMs, timezone);
  return wallMs - offsetMs;
}

// ============================================================================
// Error mapping (TimeTree internal → MCP tool response)
// ============================================================================

function mapError(e: unknown, action: string): MCPToolResult {
  logger.error(`Tool: failed to ${action}`, { error: (e as Error).message });
  if (e instanceof z.ZodError) {
    return err('Invalid input', `Validation failed: ${e.message}`, e.issues);
  }
  if (e instanceof AuthError) {
    return err('Authentication failed', e.message);
  }
  if (e instanceof TimeTreeError) {
    if (e.statusCode === 404) return err('Not found', 'Calendar or event not found. Check the alias_code.');
    if (e.statusCode === 429) return err('Rate limited', 'TimeTree rate-limited the request. Try again shortly.');
    return err(`Failed to ${action}`, e.message);
  }
  return err(`Failed to ${action}`, (e as Error).message);
}

function formatPublicEvent(e: PublicEvent) {
  return {
    id: e.id,
    title: e.title,
    all_day: e.all_day,
    start: new Date(e.start_at).toISOString(),
    end: new Date(e.end_at).toISOString(),
    timezone: e.start_timezone ?? null,
    location: e.location_name || null,
    note: e.note || null,
    url: e.url ?? null,
  };
}

function getConfiguredAliases(): string[] {
  const raw = process.env.TIMETREE_CALENDAR_ALIASES;
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getUtcOffsetSec(timezone: string, instant: number = Date.now()): number {
  return Math.round(getTzOffsetMs(instant, timezone) / 1000);
}

// ============================================================================
// Poster workspace helpers
// ============================================================================

const POSTER_DIRS = {
  pending: '00_待處理',
  created: '10_已新增',
  updated: '20_已更新既有事件',
  needsReview: '90_需人工確認',
  log: '_log',
} as const;

const POSTER_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function defaultPosterWorkspaceRoot(): string {
  return process.env.TIMETREE_POSTER_WORKSPACE_ROOT || join(homedir(), 'Desktop', 'timetree海報更新');
}

function getPosterWorkspaceRoot(root?: string): string {
  return resolve(root || defaultPosterWorkspaceRoot());
}

function isPosterImage(filename: string): boolean {
  const lower = filename.toLowerCase();
  return [...POSTER_IMAGE_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensurePosterWorkspace(root?: string): Promise<string> {
  const workspaceRoot = getPosterWorkspaceRoot(root);
  await fs.mkdir(workspaceRoot, { recursive: true });
  await Promise.all(Object.values(POSTER_DIRS).map((dir) => fs.mkdir(join(workspaceRoot, dir), { recursive: true })));
  return workspaceRoot;
}

async function uniqueDestinationPath(directory: string, filename: string): Promise<string> {
  const parsed = filename.match(/^(.*?)(\.[^.]+)?$/);
  const stem = parsed?.[1] || filename;
  const ext = parsed?.[2] || '';
  let candidate = join(directory, filename);
  let i = 2;
  while (await exists(candidate)) {
    candidate = join(directory, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

async function moveLooseImagesToPending(root: string): Promise<{ from: string; to: string }[]> {
  const moved: { from: string; to: string }[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isPosterImage(entry.name)) continue;
    const from = join(root, entry.name);
    const to = await uniqueDestinationPath(join(root, POSTER_DIRS.pending), entry.name);
    await fs.rename(from, to);
    moved.push({ from, to });
  }
  return moved;
}

async function listPosterFiles(directory: string): Promise<{ name: string; path: string; bytes: number; modified_at: string }[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isPosterImage(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = await fs.stat(path);
    files.push({
      name: entry.name,
      path,
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return files;
}

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function appendPosterLog(
  root: string,
  row: {
    image_path: string;
    status: 'created' | 'updated' | 'needs_review';
    event_id?: string;
    event_url?: string | null;
    title?: string;
    event_date?: string;
    start?: string;
    end?: string;
  },
): Promise<string> {
  const logDir = join(root, POSTER_DIRS.log);
  await fs.mkdir(logDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const logPath = join(logDir, `${date}-processed.csv`);
  if (!(await exists(logPath))) {
    await fs.writeFile(
      logPath,
      'processed_at,file,status,event_id,event_url,event_date,start,end,title,source_path\r\n',
      'utf8',
    );
  }
  const line = [
    new Date().toISOString(),
    basename(row.image_path),
    row.status,
    row.event_id || '',
    row.event_url || '',
    row.event_date || '',
    row.start || '',
    row.end || '',
    row.title || '',
    row.image_path,
  ].map(csvCell).join(',') + '\r\n';
  await fs.appendFile(logPath, line, 'utf8');
  return logPath;
}

async function markPosterProcessed(input: {
  image_path: string;
  status: 'created' | 'updated' | 'needs_review';
  event_id?: string;
  event_url?: string | null;
  title?: string;
  event_date?: string;
  start?: string;
  end?: string;
  root?: string;
}): Promise<{ moved: boolean; from: string; to: string | null; log_path: string | null }> {
  const root = await ensurePosterWorkspace(input.root);
  const from = resolve(input.image_path);
  if (!(await exists(from))) return { moved: false, from, to: null, log_path: null };

  const pendingDir = resolve(join(root, POSTER_DIRS.pending));
  const sourceDir = resolve(dirname(from));
  const targetDirName =
    input.status === 'created'
      ? POSTER_DIRS.created
      : input.status === 'updated'
        ? POSTER_DIRS.updated
        : POSTER_DIRS.needsReview;
  const targetDir = join(root, targetDirName);

  let to: string | null = null;
  let finalImagePath = from;
  if (sourceDir === pendingDir) {
    to = await uniqueDestinationPath(targetDir, basename(from));
    await fs.rename(from, to);
    finalImagePath = to;
  }

  const logPath = await appendPosterLog(root, { ...input, image_path: finalImagePath });
  return { moved: to !== null, from, to, log_path: logPath };
}

// ============================================================================
// Tool: list_calendars
//
// Lists TimeTree *public* calendars by alias_code. Configure default aliases
// via TIMETREE_CALENDAR_ALIASES env var (comma-separated), or pass alias_codes
// arg explicitly. Each alias is the short code in the public URL like
// https://timetr.ee/p/<alias_code>.
// ============================================================================

const ListCalendarsToolInputSchema = z.object({
  alias_codes: z.array(z.string().min(1)).optional(),
});

function buildListCalendarsTool(publicClient: PublicTimeTreeClient): MCPTool {
  return {
    name: 'list_calendars',
    description:
      'List configured TimeTree public calendars. Without args, returns the calendars set in TIMETREE_CALENDAR_ALIASES env var. Pass alias_codes to override (each code is the short ID in the URL https://timetr.ee/p/<code>). Returns calendar id, alias_code, name, category, subscription count, and label palette.',
    inputSchema: {
      type: 'object',
      properties: {
        alias_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. List of TimeTree public calendar alias codes to fetch. If omitted, uses TIMETREE_CALENDAR_ALIASES env var.',
        },
      },
    },
    handler: async (args: unknown): Promise<MCPToolResult> => {
      try {
        const input = ListCalendarsToolInputSchema.parse(args ?? {});
        const aliases = input.alias_codes && input.alias_codes.length
          ? input.alias_codes
          : getConfiguredAliases();
        if (aliases.length === 0) {
          return err(
            'No calendars configured',
            'Set TIMETREE_CALENDAR_ALIASES env var (comma-separated alias codes), or pass alias_codes argument explicitly.',
          );
        }
        const results = await Promise.allSettled(
          aliases.map((alias) => publicClient.getCalendar(alias)),
        );
        const calendars = [];
        const errors = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled') {
            const c = r.value;
            calendars.push({
              id: c.id,
              alias_code: c.alias_code,
              name: c.name,
              category: c.category ?? null,
              overview: c.overview || null,
              url: c.url ?? null,
              subscription_count: c.subscription_count ?? null,
              last_posted_at: c.last_posted_at ? new Date(c.last_posted_at).toISOString() : null,
              labels: (c.public_calendar_labels || []).map((l) => ({
                label_id: l.label_id,
                color: l.color,
              })),
            });
          } else {
            errors.push({ alias_code: aliases[i], error: (r.reason as Error).message });
          }
        }
        return ok({ calendars, total: calendars.length, ...(errors.length && { errors }) });
      } catch (e) {
        return mapError(e, 'list calendars');
      }
    },
  };
}

// ============================================================================
// Tool: list_events
// ============================================================================

function buildListEventsTool(publicClient: PublicTimeTreeClient): MCPTool {
  return {
    name: 'list_events',
    description:
      'List events in a TimeTree public calendar within a date range. Pass alias_code (from list_calendars) and ISO date strings for from/to. Timezone defaults to Asia/Taipei.',
    inputSchema: {
      type: 'object',
      properties: {
        alias_code: {
          type: 'string',
          description: 'Public calendar alias code (from list_calendars).',
        },
        from: {
          type: 'string',
          description: 'Inclusive start date as ISO 8601 (e.g. "2026-05-01" or "2026-05-01T00:00").',
        },
        to: {
          type: 'string',
          description: 'Exclusive end date as ISO 8601 (e.g. "2026-06-01").',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone (default "Asia/Taipei"). Used to interpret from/to wall-clock and to bucket all-day events.',
        },
      },
      required: ['alias_code', 'from', 'to'],
    },
    handler: async (args: unknown): Promise<MCPToolResult> => {
      try {
        const input = ListEventsToolInputSchema.parse(args);
        const tz = input.timezone || DEFAULT_TIMEZONE;
        const fromMs = isoToUtcMs(input.from, tz);
        const toMs = isoToUtcMs(input.to, tz);
        const utcOffsetSec = getUtcOffsetSec(tz, fromMs);
        const events = await publicClient.listEvents(input.alias_code, fromMs, toMs, utcOffsetSec);
        return ok({
          alias_code: input.alias_code,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          events: events.map(formatPublicEvent),
          total: events.length,
        });
      } catch (e) {
        return mapError(e, 'list events');
      }
    },
  };
}

// ============================================================================
// Tool: create_event
// ============================================================================

// ============================================================================
// Shared body builder for create_event / update_event
// ============================================================================

interface EventInput {
  alias_code: string;
  title: string;
  start: string;
  end?: string;
  all_day: boolean;
  timezone: string;
  location?: string;
  description?: string;
  link_url?: string;
  label_id: number;
  image_path?: string;
}

async function buildEventBody(
  input: EventInput,
  client: TimeTreeClient,
  publicClient: PublicTimeTreeClient,
): Promise<{ body: ManagedEventBody; calendar: PublicCalendar }> {
  const tz = input.timezone || DEFAULT_TIMEZONE;
  const startMs = isoToUtcMs(input.start, tz);

  let endMs: number;
  if (input.end) {
    endMs = isoToUtcMs(input.end, tz);
  } else if (input.all_day) {
    endMs = startMs;
  } else {
    endMs = startMs + 2 * 60 * 60 * 1000;
  }

  const calendar = await publicClient.getCalendar(input.alias_code);
  const label = (calendar.public_calendar_labels || []).find((l) => l.label_id === input.label_id);
  if (!label) {
    throw new Error(`Calendar "${input.alias_code}" has no label_id=${input.label_id}. Valid range is typically 1-10.`);
  }

  let cover: { url: string; thumbnail_url: string }[] | null = null;
  if (input.image_path) {
    const uploaded = await client.uploadAttachment(calendar.id, input.image_path);
    cover = [{ url: uploaded.url, thumbnail_url: uploaded.thumbnail_url }];
  }

  const body: ManagedEventBody = {
    title: input.title,
    label_id: input.label_id,
    color: label.color,
    category: 1,
    all_day: input.all_day,
    start_at: startMs,
    end_at: endMs,
    start_timezone: tz,
    end_timezone: tz,
    region_timezone: tz,
    note: input.description || '',
    link_url: input.link_url || '',
    location_name: input.location || '',
    location_lat: null,
    location_lon: null,
    recurrences: null,
    publish_at: null,
    images: { cover, overview: null },
  };

  return { body, calendar };
}

function buildCreateEventTool(client: TimeTreeClient, publicClient: PublicTimeTreeClient): MCPTool {
  return {
    name: 'create_event',
    description:
      'Create an event in a TimeTree public calendar that the authenticated account manages. ' +
      'Use this after reading an event poster: pass alias_code (from list_calendars), title, ISO start date, ' +
      'optional location, and a short description (1-2 sentences). Timezone defaults to Asia/Taipei. ' +
      'Returns the created event with id and public URL.',
    inputSchema: {
      type: 'object',
      properties: {
        alias_code: {
          type: 'string',
          description: 'Public calendar alias code (from list_calendars).',
        },
        title: {
          type: 'string',
          description: 'Event title.',
        },
        start: {
          type: 'string',
          description:
            'Start time as ISO 8601. Examples: "2026-06-15T19:00" for a timed event, ' +
            '"2026-06-15" for all-day. Do NOT add a timezone suffix — pass `timezone` separately.',
        },
        end: {
          type: 'string',
          description:
            'End time as ISO 8601 (same format as `start`). If omitted: timed events default to +2 hours (matching TimeTree web default), all-day events to the same day.',
        },
        all_day: {
          type: 'boolean',
          description: 'Whether this is an all-day event (default false).',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone (default "Asia/Taipei"). Examples: "Asia/Taipei", "Asia/Tokyo", "America/New_York".',
        },
        location: {
          type: 'string',
          description: 'Event location (e.g. "台北 信義區 ATT 4 Recharge").',
        },
        description: {
          type: 'string',
          description: 'Short event description / notes. For poster events, write a 1-2 sentence summary here.',
        },
        link_url: {
          type: 'string',
          description: 'Optional URL to attach to the event.',
        },
        image_path: {
          type: 'string',
          description: 'Optional absolute path to a local image file (jpg/png/gif/webp). Will be uploaded as the event cover image.',
        },
        label_id: {
          type: 'number',
          description:
            'Label index 1-10. Each public calendar defines its own 10-label palette; ' +
            'see list_calendars output for the actual colors. Default 1.',
        },
      },
      required: ['alias_code', 'title', 'start'],
    },
    handler: async (args: unknown): Promise<MCPToolResult> => {
      try {
        const input = CreateEventToolInputSchema.parse(args);
        const { body } = await buildEventBody(input, client, publicClient);
        const event = await client.createManagedEvent(input.alias_code, body);
        const poster_workflow = input.image_path
          ? await markPosterProcessed({
            image_path: input.image_path,
            status: 'created',
            event_id: event.id,
            event_url: event.url,
            title: input.title,
            event_date: input.start.slice(0, 10),
            start: input.start,
            end: input.end,
          })
          : null;
        return ok({
          success: true,
          message: 'Event created in TimeTree',
          event: formatCreatedEvent(event),
          ...(poster_workflow && { poster_workflow }),
        });
      } catch (e) {
        return mapError(e, 'create event');
      }
    },
  };
}

function formatCreatedEvent(event: PublicEvent) {
  return {
    id: event.id,
    title: event.title,
    all_day: event.all_day,
    start: new Date(event.start_at).toISOString(),
    end: new Date(event.end_at).toISOString(),
    timezone: event.start_timezone ?? null,
    location: event.location_name || null,
    note: event.note || null,
    has_cover: !!(event.images && (event.images as { cover?: unknown[] }).cover?.length),
    url: event.url ?? null,
  };
}

// ============================================================================
// Tool: update_event
// ============================================================================

function buildUpdateEventTool(client: TimeTreeClient, publicClient: PublicTimeTreeClient): MCPTool {
  return {
    name: 'update_event',
    description:
      'Update an existing event in a TimeTree public calendar (full replace — PUT). ' +
      'Use this to add/replace/remove a cover image on an existing event, or change title/time/etc. ' +
      'Pass event_id (from list_events) plus all the fields you want the event to have. ' +
      'For cover: pass image_path to upload+set a new one, or remove_image=true to clear it; ' +
      'if neither is passed, cover is CLEARED (PUT is full-replace). ' +
      'To preserve the current cover while editing other fields, you must re-upload via image_path.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'Event id (from list_events).',
        },
        alias_code: {
          type: 'string',
          description: 'Public calendar alias code (from list_calendars).',
        },
        title: { type: 'string', description: 'Event title.' },
        start: {
          type: 'string',
          description: 'Start time ISO 8601 (e.g. "2026-06-15T19:00" or "2026-06-15").',
        },
        end: {
          type: 'string',
          description: 'End time ISO 8601. Defaults to +2h for timed events, same day for all-day.',
        },
        all_day: { type: 'boolean', description: 'Whether all-day (default false).' },
        timezone: { type: 'string', description: 'IANA timezone (default Asia/Taipei).' },
        location: { type: 'string', description: 'Event location.' },
        description: { type: 'string', description: 'Event note / description.' },
        link_url: { type: 'string', description: 'Optional URL.' },
        image_path: {
          type: 'string',
          description: 'Absolute path to a local image file. Upload + set as the new cover.',
        },
        remove_image: {
          type: 'boolean',
          description: 'Set true to explicitly clear the cover image (ignored if image_path is also set).',
        },
        label_id: {
          type: 'number',
          description: 'Label index 1-10 (see list_calendars for the palette). Default 1.',
        },
      },
      required: ['event_id', 'alias_code', 'title', 'start'],
    },
    handler: async (args: unknown): Promise<MCPToolResult> => {
      try {
        const input = UpdateEventToolInputSchema.parse(args);
        const { body } = await buildEventBody(input, client, publicClient);
        const event = await client.updateManagedEvent(input.alias_code, input.event_id, body);
        const poster_workflow = input.image_path
          ? await markPosterProcessed({
            image_path: input.image_path,
            status: 'updated',
            event_id: event.id,
            event_url: event.url,
            title: input.title,
            event_date: input.start.slice(0, 10),
            start: input.start,
            end: input.end,
          })
          : null;
        return ok({
          success: true,
          message: 'Event updated in TimeTree',
          event: formatCreatedEvent(event),
          ...(poster_workflow && { poster_workflow }),
        });
      } catch (e) {
        return mapError(e, 'update event');
      }
    },
  };
}

// ============================================================================
// Tool: poster_workspace_status
// ============================================================================

function buildPosterWorkspaceStatusTool(): MCPTool {
  return {
    name: 'poster_workspace_status',
    description:
      'Prepare and inspect the local poster workflow folder. Creates the standard folders if missing, moves loose image files from the root into 00_待處理 by default, and returns only pending poster image paths that should be read next.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Optional poster workspace root. Defaults to TIMETREE_POSTER_WORKSPACE_ROOT or ~/Desktop/timetree海報更新.',
        },
        move_loose_images_to_pending: {
          type: 'boolean',
          description:
            'Whether to move loose image files in the root folder into 00_待處理 before listing. Default true.',
        },
      },
    },
    handler: async (args: unknown): Promise<MCPToolResult> => {
      try {
        const input = PosterWorkspaceToolInputSchema.parse(args ?? {});
        const root = await ensurePosterWorkspace(input.root);
        const moved_loose_images = input.move_loose_images_to_pending
          ? await moveLooseImagesToPending(root)
          : [];
        const pending = await listPosterFiles(join(root, POSTER_DIRS.pending));
        const created = await listPosterFiles(join(root, POSTER_DIRS.created));
        const updated = await listPosterFiles(join(root, POSTER_DIRS.updated));
        const needs_review = await listPosterFiles(join(root, POSTER_DIRS.needsReview));
        return ok({
          root,
          folders: {
            pending: join(root, POSTER_DIRS.pending),
            created: join(root, POSTER_DIRS.created),
            updated: join(root, POSTER_DIRS.updated),
            needs_review: join(root, POSTER_DIRS.needsReview),
            log: join(root, POSTER_DIRS.log),
          },
          moved_loose_images,
          pending,
          counts: {
            pending: pending.length,
            created: created.length,
            updated: updated.length,
            needs_review: needs_review.length,
          },
        });
      } catch (e) {
        return mapError(e, 'inspect poster workspace');
      }
    },
  };
}

// ============================================================================
// Tool: mark_poster_processed
// ============================================================================

function buildMarkPosterProcessedTool(): MCPTool {
  return {
    name: 'mark_poster_processed',
    description:
      'Move one poster image out of 00_待處理 after processing and append the CSV log. Normally create_event/update_event do this automatically when image_path is inside 00_待處理. Use this for manual corrections or posters that need review.',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: {
          type: 'string',
          description: 'Absolute path to the poster image.',
        },
        status: {
          type: 'string',
          enum: ['created', 'updated', 'needs_review'],
          description: 'created -> 10_已新增, updated -> 20_已更新既有事件, needs_review -> 90_需人工確認.',
        },
        event_id: { type: 'string', description: 'Optional TimeTree event id.' },
        event_url: { type: 'string', description: 'Optional TimeTree public URL.' },
        title: { type: 'string', description: 'Optional event title for the log.' },
        event_date: { type: 'string', description: 'Optional event date for the log, e.g. 2026-07-08.' },
        start: { type: 'string', description: 'Optional start time/date for the log.' },
        end: { type: 'string', description: 'Optional end time/date for the log.' },
        root: {
          type: 'string',
          description:
            'Optional poster workspace root. Defaults to TIMETREE_POSTER_WORKSPACE_ROOT or ~/Desktop/timetree海報更新.',
        },
      },
      required: ['image_path', 'status'],
    },
    handler: async (args: unknown): Promise<MCPToolResult> => {
      try {
        const input = MarkPosterProcessedToolInputSchema.parse(args);
        const result = await markPosterProcessed(input);
        return ok({ success: true, ...result });
      } catch (e) {
        return mapError(e, 'mark poster processed');
      }
    },
  };
}

// ============================================================================
// Registry
// ============================================================================

export function buildTools(client: TimeTreeClient, publicClient: PublicTimeTreeClient): MCPTool[] {
  return [
    buildListCalendarsTool(publicClient),
    buildListEventsTool(publicClient),
    buildCreateEventTool(client, publicClient),
    buildUpdateEventTool(client, publicClient),
    buildPosterWorkspaceStatusTool(),
    buildMarkPosterProcessedTool(),
  ];
}
