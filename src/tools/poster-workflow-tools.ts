/**
 * Local poster workflow tools.
 *
 * These helpers organize poster images on disk after the MCP user has read
 * them and created or updated the corresponding TimeTree event.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const POSTER_DIRS = {
  pending: '00_pending',
  created: '10_created',
  updated: '20_updated_existing_event',
  needsReview: '90_needs_manual_review',
  log: '_log',
} as const;

const POSTER_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const PosterWorkspaceInputSchema = z.object({
  root: z.string().optional(),
  move_loose_images_to_pending: z.boolean().optional().default(true),
});

const MarkPosterProcessedInputSchema = z.object({
  image_path: z.string().min(1),
  status: z.enum(['created', 'updated', 'needs_review']),
  event_id: z.string().optional(),
  event_url: z.string().optional(),
  title: z.string().optional(),
  event_date: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  root: z.string().optional(),
});

export type MarkPosterProcessedInput = z.infer<typeof MarkPosterProcessedInputSchema>;

function defaultPosterWorkspaceRoot(): string {
  return process.env.TIMETREE_POSTER_WORKSPACE_ROOT || join(homedir(), 'Desktop', 'timetree-posters');
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

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function appendPosterLog(root: string, row: MarkPosterProcessedInput & { image_path: string }): Promise<string> {
  const logDir = join(root, POSTER_DIRS.log);
  await fs.mkdir(logDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logPath = join(logDir, `${date}-processed.csv`);

  if (!(await exists(logPath))) {
    await fs.writeFile(
      logPath,
      'processed_at,file,status,event_id,event_url,event_date,start,end,title,source_path\r\n',
      'utf8'
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

export async function markPosterProcessed(input: MarkPosterProcessedInput): Promise<{
  moved: boolean;
  from: string;
  to: string | null;
  log_path: string | null;
}> {
  const root = await ensurePosterWorkspace(input.root);
  const from = resolve(input.image_path);

  if (!(await exists(from))) {
    return { moved: false, from, to: null, log_path: null };
  }

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

function ok(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errorContent(error: string, message: string, details?: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error, message, ...(details !== undefined && { details }) }, null, 2),
      },
    ],
    isError: true,
  };
}

function mapPosterError(error: unknown, action: string) {
  logger.error(`Tool: ${action} failed`, { error });

  if (error instanceof z.ZodError) {
    return errorContent('Invalid input', `Please provide valid data to ${action}`, error.issues);
  }

  return errorContent(`Failed to ${action}`, (error as Error).message);
}

export function createPosterWorkspaceStatusTool() {
  return {
    name: 'poster_workspace_status',
    description:
      'Prepare and inspect the local poster workflow folder. Creates standard folders, moves loose image files from the root into 00_pending by default, and returns pending poster image paths.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Optional poster workspace root. Defaults to TIMETREE_POSTER_WORKSPACE_ROOT or ~/Desktop/timetree-posters.',
        },
        move_loose_images_to_pending: {
          type: 'boolean',
          description: 'Whether to move loose image files in the root folder into 00_pending before listing. Default true.',
        },
      },
    },
    handler: async (args: unknown) => {
      try {
        const input = PosterWorkspaceInputSchema.parse(args ?? {});
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
      } catch (error) {
        return mapPosterError(error, 'inspect poster workspace');
      }
    },
  };
}

export function createMarkPosterProcessedTool() {
  return {
    name: 'mark_poster_processed',
    description:
      'Move one poster image out of 00_pending after processing and append the CSV log. create_event/update_event also do this automatically when image_path points inside 00_pending.',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Absolute path to the poster image.' },
        status: {
          type: 'string',
          enum: ['created', 'updated', 'needs_review'],
          description:
            'created -> 10_created, updated -> 20_updated_existing_event, needs_review -> 90_needs_manual_review.',
        },
        event_id: { type: 'string', description: 'Optional TimeTree event UUID.' },
        event_url: { type: 'string', description: 'Optional TimeTree event URL.' },
        title: { type: 'string', description: 'Optional event title for the log.' },
        event_date: { type: 'string', description: 'Optional event date for the log.' },
        start: { type: 'string', description: 'Optional start time/date for the log.' },
        end: { type: 'string', description: 'Optional end time/date for the log.' },
        root: {
          type: 'string',
          description: 'Optional poster workspace root. Defaults to TIMETREE_POSTER_WORKSPACE_ROOT or ~/Desktop/timetree-posters.',
        },
      },
      required: ['image_path', 'status'],
    },
    handler: async (args: unknown) => {
      try {
        const input = MarkPosterProcessedInputSchema.parse(args);
        const result = await markPosterProcessed(input);
        return ok({ success: true, ...result });
      } catch (error) {
        return mapPosterError(error, 'mark poster processed');
      }
    },
  };
}
