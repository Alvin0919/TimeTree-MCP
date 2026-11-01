/** MCP tools restricted to the configured private TimeTree calendar. */
import { z } from 'zod';
import { TimeTreeClient, logger } from './timetree.js';
import type { PrivateEventBody, TimeTreeEvent } from './types.js';

export type MCPToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  handler: (args: unknown) => Promise<MCPToolResult>;
}

const timezoneSchema = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}, 'Invalid IANA timezone');

/** Accept local wall-clock ISO input only; reject invalid and ambiguous DST times. */
export function isoToUtcMs(iso: string, timezone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(iso);
  if (!match) throw new Error('Use YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss], without an offset');
  const [, y, m, d, h = '00', min = '00', s = '00'] = match;
  const parts = [y, m, d, h, min, s].map(Number);
  const wall = new Date(0);
  wall.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  wall.setUTCHours(parts[3], parts[4], parts[5], 0);
  const wallMs = wall.getTime();
  const expected = `${y}-${m}-${d}T${h}:${min}:${s}`;
  if (wall.toISOString().slice(0, 19) !== expected) throw new Error('Invalid calendar date or time');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const rendered = (ms: number) => {
    const p = Object.fromEntries(formatter.formatToParts(ms).map((v) => [v.type, v.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  };
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const instant = wallMs + delta;
    offsets.add(Date.parse(`${rendered(instant)}Z`) - instant);
  }
  const candidates = [...offsets].map((offset) => wallMs - offset).filter((ms) => rendered(ms) === expected);
  if (candidates.length !== 1) throw new Error('Nonexistent or ambiguous local time; choose an unambiguous time');
  return candidates[0];
}

const eventFields = {
  title: z.string().trim().min(1),
  start: z.string(), end: z.string(), all_day: z.boolean(),
  timezone: timezoneSchema, location: z.string(), description: z.string(),
  link_url: z.union([z.literal(''), z.string().url().refine((url) => /^https?:/.test(url), 'Use an HTTP(S) URL')]),
  label_id: z.number().int().min(1).max(10),
};
const createSchema = z.object(eventFields).partial().extend({ title: eventFields.title, start: eventFields.start }).strict();
const updateSchema = z.object(eventFields).partial().extend({ event_uuid: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict()
  .refine((value) => Object.keys(value).length > 1, 'Provide at least one field to update');
type EventInput = Partial<z.infer<typeof createSchema>> & { title: string };

function eventBody(input: EventInput, current?: TimeTreeEvent): PrivateEventBody {
  const tz = input.timezone ?? current?.start_timezone ?? 'Asia/Taipei';
  const allDay = input.all_day ?? current?.all_day ?? false;
  if (current && input.timezone && (!input.start || !input.end)) throw new Error('Changing timezone requires start and end');
  if (current && input.all_day !== undefined && input.all_day !== current.all_day && (!input.start || !input.end)) {
    throw new Error('Changing all_day requires start and end');
  }
  if (allDay && [input.start, input.end].some((v) => v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v))) {
    throw new Error('All-day start/end must be YYYY-MM-DD; end is inclusive');
  }
  const start = input.start !== undefined ? isoToUtcMs(input.start, tz) : current!.start_at;
  const endTz = input.timezone ?? current?.end_timezone ?? tz;
  const end = input.end !== undefined ? isoToUtcMs(input.end, endTz) : current?.end_at ?? (allDay ? start : start + 3600000);
  if (allDay ? end < start : end <= start) throw new Error('End must follow start (all-day end may equal start)');
  const body: PrivateEventBody = current ? { ...current } : {
    title: input.title, all_day: allDay, start_at: start, end_at: end, category: 1,
    attendees: [], recurrences: [], alerts: [], file_uuids: [],
  };
  Object.assign(body, { all_day: allDay, start_at: start, end_at: end });
  if (!current || input.start !== undefined || input.timezone !== undefined) body.start_timezone = tz;
  if (!current || input.end !== undefined || input.timezone !== undefined) body.end_timezone = endTz;
  for (const [key, value] of Object.entries({ title: input.title, location: input.location, note: input.description, label_id: input.label_id })) {
    if (value !== undefined) body[key] = value;
  }
  if (input.link_url !== undefined) {
    body.attachment = { ...(current?.attachment as Record<string, unknown> | undefined), url: input.link_url || null };
  }
  return body;
}

function formatEvent(event: TimeTreeEvent) {
  return { uuid: event.uuid, calendar_id: event.calendar_id, title: event.title,
    start: new Date(event.start_at).toISOString(), end: new Date(event.end_at).toISOString(),
    all_day: event.all_day, timezone: event.start_timezone, location: event.location, note: event.note,
    label_id: event.label_id, attachment: event.attachment };
}

export function buildTools(client: TimeTreeClient): MCPTool[] {
  const pendingUpdates = new Map<string, Promise<void>>();
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: unknown) => Promise<unknown>): MCPTool => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    handler: async (args) => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await run(args ?? {}), null, 2) }] }; }
      catch (error) {
        logger.error(`Tool ${name} failed`);
        const message = error instanceof z.ZodError ? 'Invalid input: check the tool schema' :
          error instanceof Error && error.name === 'TimeTreeError' ? 'TimeTree request failed; check configuration and account access' :
          error instanceof Error && error.name === 'AuthError' ? 'Authentication failed; check account credentials and CSRF' :
          error instanceof Error ? error.message : 'Request failed';
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
      }
    },
  });
  const properties = {
    title: { type: 'string' }, start: { type: 'string', description: 'Local ISO date/time without offset; all-day: YYYY-MM-DD' },
    end: { type: 'string', description: 'Timed: exclusive; all-day date: inclusive. Create default: +1h or same day.' },
    all_day: { type: 'boolean' }, timezone: { type: 'string', description: 'IANA timezone; default Asia/Taipei' },
    location: { type: 'string' }, description: { type: 'string' }, link_url: { type: 'string' },
    label_id: { type: 'integer', minimum: 1, maximum: 10 },
  };
  return [
    tool('list_calendars', 'Discover your account calendars and their IDs. Choose 共用行事曆 and set TIMETREE_CALENDAR_ID; names are not unique.', {}, [], async (args) => {
      z.object({}).strict().parse(args);
      return { calendars: (await client.listCalendars()).map((c) => ({ id: c.id, name: c.name })) };
    }),
    tool('list_events', 'List events overlapping [from,to) in the configured private calendar only. All-day end dates are inclusive.', {
      from: { type: 'string' }, to: { type: 'string' }, timezone: { type: 'string' },
    }, ['from', 'to'], async (args) => {
      const input = z.object({ from: z.string(), to: z.string(), timezone: timezoneSchema.default('Asia/Taipei') }).strict().parse(args);
      const from = isoToUtcMs(input.from, input.timezone), to = isoToUtcMs(input.to, input.timezone);
      if (to <= from) throw new Error('to must follow from');
      const events = (await client.listEvents()).filter((e) => {
        let end = e.end_at;
        if (e.all_day) {
          const tz = e.end_timezone ?? e.start_timezone ?? input.timezone;
          const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(end).map((p) => [p.type, p.value]));
          const next = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          end = isoToUtcMs(next.toISOString().slice(0, 10), tz);
        }
        return e.start_at < to && end > from;
      });
      return { calendar_id: client.calendarId, events: events.map(formatEvent), total: events.length };
    }),
    tool('create_event', 'Create an event only in TIMETREE_CALENDAR_ID (共用行事曆). Calendar members may be notified.', properties, ['title', 'start'], async (args) => {
      const input = createSchema.parse(args);
      return { event: formatEvent(await client.createEvent(eventBody(input))) };
    }),
    tool('update_event', 'Update an event UUID only in the configured private calendar; omitted fields and attachments are preserved. Read list_events first.', {
      event_uuid: { type: 'string' }, ...properties,
    }, ['event_uuid'], async (args) => {
      const input = updateSchema.parse(args);
      const previous = pendingUpdates.get(input.event_uuid) ?? Promise.resolve();
      let release!: () => void;
      const finished = new Promise<void>((resolve) => { release = resolve; });
      pendingUpdates.set(input.event_uuid, finished);
      await previous;
      try {
        const current = await client.getEvent(input.event_uuid);
        return { event: formatEvent(await client.updateEvent(input.event_uuid, eventBody({ ...input, title: input.title ?? current.title }, current))) };
      } finally {
        release();
        if (pendingUpdates.get(input.event_uuid) === finished) pendingUpdates.delete(input.event_uuid);
      }
    }),
  ];
}
