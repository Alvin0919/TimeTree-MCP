/**
 * Zod schemas and TS types for the TimeTree MCP.
 *
 * Two layers:
 *   1. TimeTree raw API shapes (`TimeTreeCalendarSchema`, `TimeTreeEventSchema`)
 *      — these mirror what the reverse-engineered TimeTree web API actually
 *      returns. `.passthrough()` means unknown fields are kept so a TimeTree
 *      API change won't crash us, only extra fields will be invisible to us.
 *   2. MCP tool inputs (`CreateEventToolInputSchema`) — human-friendly
 *      shapes that Claude sees. The tool layer converts these into raw
 *      TimeTree shapes before sending.
 */

import { z } from 'zod';

// ============================================================================
// TimeTree raw API types (what the server speaks)
// ============================================================================

export const TimeTreeUserSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  role: z.number().optional(),
  deactivated_at: z.number().nullable().optional(),
}).passthrough();

export const TimeTreeCalendarSchema = z.object({
  id: z.number(),
  name: z.string(),
  alias_code: z.string().optional(),
  color: z.number().optional(),
  deactivated_at: z.number().nullable().optional(),
  calendar_users: z.array(TimeTreeUserSchema).optional(),
}).passthrough();

export const TimeTreeEventSchema = z.object({
  id: z.string(),
  uuid: z.string(),
  calendar_id: z.number(),
  title: z.string(),
  all_day: z.boolean(),
  start_at: z.number(),
  end_at: z.number(),
  start_timezone: z.string().optional(),
  end_timezone: z.string().optional(),
  location: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  label_id: z.number().optional(),
  category: z.number().optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
}).passthrough();

export const CalendarsResponseSchema = z.object({
  calendars: z.array(TimeTreeCalendarSchema),
}).passthrough();

export const CreateEventResponseSchema = z.object({
  event: TimeTreeEventSchema,
}).passthrough();

export type TimeTreeCalendar = z.infer<typeof TimeTreeCalendarSchema>;
export type TimeTreeEvent = z.infer<typeof TimeTreeEventSchema>;

// ============================================================================
// Public calendar API (OpenAPI v2) — what TimeTree's own web app actually
// uses now. Anonymous read, no session cookie required, but the
// `X-Timetreea` header is mandatory or the server returns -401.
// Endpoints:
//   GET /api/v2/public_calendars/{alias_code}
//   GET /api/v2/public_calendars/{alias_code}/public_events?from=&to=&utc_offset=
// ============================================================================

export const PublicCalendarLabelSchema = z.object({
  label_id: z.number(),
  public_calendar_id: z.number(),
  name: z.string(),
  color: z.number(),
  order: z.number(),
}).passthrough();

export const PublicCalendarSchema = z.object({
  id: z.number(),
  alias_code: z.string(),
  name: z.string(),
  category: z.string().optional(),
  overview: z.string().optional(),
  color: z.number().optional(),
  status: z.number().optional(),
  url: z.string().optional(),
  subscription_count: z.number().optional(),
  last_posted_at: z.number().nullable().optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
  public_calendar_labels: z.array(PublicCalendarLabelSchema).optional(),
}).passthrough();

export const PublicCalendarResponseSchema = z.object({
  public_calendar: PublicCalendarSchema,
}).passthrough();

export const PublicEventSchema = z.object({
  id: z.string(),
  public_calendar_id: z.number(),
  title: z.string(),
  headline: z.string().optional(),
  note: z.string().optional(),
  overview: z.string().optional(),
  link_url: z.string().optional(),
  status: z.number().optional(),
  color: z.number().optional(),
  all_day: z.boolean(),
  start_at: z.number(),
  end_at: z.number(),
  start_timezone: z.string().optional(),
  end_timezone: z.string().optional(),
  location_name: z.string().nullable().optional(),
  location_address: z.string().nullable().optional(),
  location_url: z.string().nullable().optional(),
  location_lat: z.number().nullable().optional(),
  location_lon: z.number().nullable().optional(),
  url: z.string().optional(),
  publish_at: z.number().optional(),
  updated_at: z.number().optional(),
  created_at: z.number().optional(),
  interest_count: z.number().optional(),
}).passthrough();

export const PublicEventsResponseSchema = z.object({
  paging: z.object({
    next_cursor: z.string().nullable().optional(),
    next: z.boolean().optional(),
  }).passthrough().optional(),
  public_events: z.array(PublicEventSchema),
}).passthrough();

export type PublicCalendar = z.infer<typeof PublicCalendarSchema>;
export type PublicEvent = z.infer<typeof PublicEventSchema>;

// ============================================================================
// Internal request body for OpenAPI v2:
//   POST /api/v2/managed_public_calendars/{alias_code}/public_events
// ============================================================================

export interface ManagedEventBody {
  title: string;
  label_id: number;
  color: number;
  category: number;
  all_day: boolean;
  start_at: number;
  end_at: number;
  start_timezone: string;
  end_timezone: string;
  region_timezone: string;
  note: string;
  link_url: string;
  location_name: string;
  location_lat: number | null;
  location_lon: number | null;
  recurrences: unknown[] | null;
  publish_at: number | null;
  images: {
    cover: unknown | null;
    overview: unknown | null;
  };
}

// ============================================================================
// MCP tool input schemas (what Claude sees)
// ============================================================================

export const DEFAULT_TIMEZONE = 'Asia/Taipei';

export const ListEventsToolInputSchema = z.object({
  alias_code: z.string().min(1),
  from: z.string(),
  to: z.string(),
  timezone: z.string().optional().default('Asia/Taipei'),
});

export type ListEventsToolInput = z.infer<typeof ListEventsToolInputSchema>;

export const CreateEventToolInputSchema = z.object({
  alias_code: z.string().min(1),
  title: z.string().min(1),
  start: z.string(),
  end: z.string().optional(),
  all_day: z.boolean().optional().default(false),
  timezone: z.string().optional().default(DEFAULT_TIMEZONE),
  location: z.string().optional(),
  description: z.string().optional(),
  link_url: z.string().optional(),
  label_id: z.number().int().min(1).max(10).optional().default(1),
  image_path: z.string().optional(),
});

export const UpdateEventToolInputSchema = CreateEventToolInputSchema.extend({
  event_id: z.string().min(1),
  remove_image: z.boolean().optional(),
});

export type UpdateEventToolInput = z.infer<typeof UpdateEventToolInputSchema>;

export const PosterWorkspaceToolInputSchema = z.object({
  root: z.string().optional(),
  move_loose_images_to_pending: z.boolean().optional().default(true),
});

export type PosterWorkspaceToolInput = z.infer<typeof PosterWorkspaceToolInputSchema>;

export const MarkPosterProcessedToolInputSchema = z.object({
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

export type MarkPosterProcessedToolInput = z.infer<typeof MarkPosterProcessedToolInputSchema>;

export const CreatePublicEventResponseSchema = z.object({
  public_event: PublicEventSchema,
}).passthrough();

export const AttachmentSchema = z.object({
  object_key: z.string(),
  filename: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
}).passthrough();

export const AttachmentsResponseSchema = z.object({
  attachments: z.array(AttachmentSchema),
}).passthrough();

export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Derive the public URLs (full + thumbnail) the create_event body expects
 * for a given attachment object_key returned from POST /api/v1/attachments.
 *
 * Rule (reverse-engineered from web app):
 *   cover     = https://attachments.timetreeapp.com/{object_key}
 *   thumbnail = same as cover, but the FIRST path segment "public_event/"
 *               is rewritten to "public_event_s/" (s = small)
 */
export function attachmentToImageRef(objectKey: string): { url: string; thumbnail_url: string } {
  const base = 'https://attachments.timetreeapp.com/';
  const thumbKey = objectKey.replace(/^public_event\//, 'public_event_s/');
  return { url: base + objectKey, thumbnail_url: base + thumbKey };
}

export type CreateEventToolInput = z.infer<typeof CreateEventToolInputSchema>;
