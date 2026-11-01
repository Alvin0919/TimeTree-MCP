/**
 * TimeTree client: combined auth, HTTP, and API layer.
 *
 * Talks to TimeTree's INTERNAL web API (reverse-engineered, not officially
 * supported). The official Connect App API was shut down on 2023-12-22.
 *
 * Credit: endpoint mapping informed by ehs208/TimeTree-MCP (MIT) and
 * eoleedi/TimeTree-Exporter.
 *
 * Auth flow:
 *   1. PUT /api/v1/auth/email/signin  →  Set-Cookie: _session_id=...
 *   2. GET https://timetreeapp.com/   →  parse <meta name="csrf-token">
 *   3. Subsequent writes carry both the cookie and the x-csrf-token header.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AttachmentsResponseSchema,
  CalendarsResponseSchema,
  CreateEventResponseSchema,
  EventsSyncResponseSchema,
  CreatePublicEventResponseSchema,
  PublicCalendarResponseSchema,
  PublicEventsResponseSchema,
  attachmentToImageRef,
  type Attachment,
  type ManagedEventBody,
  type PublicCalendar,
  type PublicEvent,
  type TimeTreeCalendar,
  type TimeTreeEvent,
  type PrivateEventBody,
} from './types.js';

// ============================================================================
// Logger — writes to stderr only (stdout is reserved for MCP JSON-RPC).
// Masks credentials in case they ever leak into a log payload.
// ============================================================================

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const currentLevel = (process.env.LOG_LEVEL?.toUpperCase() as LogLevel) || 'INFO';

const SENSITIVE_KEY = /password|secret|token|cookie|session|authorization|_session_id|csrf|^uid$|^email$/i;

function maskString(s: string): string {
  return s
    // Free-form inline forms: `password=xxx`, `token: xxx`, `secret = xxx`, `Bearer xxx`
    .replace(/((?:password|passwd|secret|token|csrf|cookie|session|authorization)\s*[:=]\s*)[^\s,;}'"]+/gi, '$1***')
    .replace(/(\bbearer\s+)[^\s,;}'"]+/gi, '$1***')
    // JSON-quoted forms: `"password":"xxx"`
    .replace(/("(?:password|passwd|secret|token|csrf|cookie|session|authorization)"\s*:\s*")[^"]*(")/gi, '$1***$2')
    // Session cookie pair anywhere in text
    .replace(/(_session_id=)[^;\s]+/gi, '$1***')
    .replace(/(x-csrf-token\s*[:=]\s*)[^\s,;}'"]+/gi, '$1***')
    // Email addresses
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***@***');
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return maskString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '***MASKED***' : sanitize(v, seen);
  }
  seen.delete(value as object);
  return out;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

function emit(level: LogLevel, msg: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta !== undefined && { meta: sanitize(meta) }),
  };
  console.error(JSON.stringify(entry));
}

export const logger = {
  debug: (m: string, x?: unknown) => emit('DEBUG', m, x),
  info: (m: string, x?: unknown) => emit('INFO', m, x),
  warn: (m: string, x?: unknown) => emit('WARN', m, x),
  error: (m: string, x?: unknown) => emit('ERROR', m, x),
};

// ============================================================================
// Config — reverse-engineered TimeTree internal endpoints.
// ============================================================================

const BASE_URL = 'https://timetreeapp.com/api/v1';
const PUBLIC_BASE_URL = 'https://timetreeapp.com/api/v2';
const WEB_ROOT = 'https://timetreeapp.com/';
const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Timetreea': 'web/2.1.0/en',
};

// ============================================================================
// Errors
// ============================================================================

export class TimeTreeError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'TimeTreeError';
  }
}

export class AuthError extends TimeTreeError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = 'AuthError';
  }
}

// ============================================================================
// HTTP client — owns the session cookie and CSRF token across requests.
// ============================================================================

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  requireCsrf?: boolean;
  timeoutMs?: number;
}

class HttpClient {
  private sessionCookie?: string;
  private csrfToken?: string;

  setCsrf(token: string): void { this.csrfToken = token; }
  setSession(cookie: string): void {
    if (!cookie || /[\s;,\x00-\x1f\x7f]/.test(cookie)) throw new AuthError('Invalid session cookie format');
    this.sessionCookie = cookie;
  }
  hasSession(): boolean { return !!this.sessionCookie; }
  hasCsrf(): boolean { return !!this.csrfToken; }
  clearAuth(): void { this.sessionCookie = undefined; this.csrfToken = undefined; }

  async request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, requireCsrf = false, timeoutMs = 30_000 } = opts;
    const isMultipart = body instanceof FormData;
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    // For multipart, let fetch set Content-Type (it needs to include the
    // boundary parameter). Strip our default JSON Content-Type.
    if (isMultipart) delete headers['Content-Type'];
    if (this.sessionCookie) headers['Cookie'] = `_session_id=${this.sessionCookie}`;
    if (requireCsrf && this.csrfToken) headers['x-csrf-token'] = this.csrfToken;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.debug('HTTP request', { method, url, multipart: isMultipart });
      const res = await fetch(url, {
        method,
        headers,
        body: isMultipart
          ? (body as FormData)
          : body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // Capture rotating session cookie / CSRF if the response provides one.
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const m = setCookie.match(/_session_id=([^;]+)/);
        if (m) this.sessionCookie = m[1];
      }
      const csrfHeader = res.headers.get('x-csrf-token');
      if (csrfHeader) this.csrfToken = csrfHeader;

      if (!res.ok) {
        const errBody = await res.text();
        logger.error('HTTP non-2xx', { status: res.status, url });
        throw new TimeTreeError(
          `HTTP ${res.status}: ${res.statusText} - ${errBody.slice(0, 200)}`,
          res.status,
        );
      }

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return (await res.json()) as T;
      return (await res.text()) as unknown as T;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new TimeTreeError(`Request timeout after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// TimeTree client — what tools.ts calls into.
// ============================================================================

export interface TimeTreeClientConfig {
  email: string;
  password: string;
  calendarId?: string;
  sessionCookie?: string;
}

export class TimeTreeClient {
  private http = new HttpClient();
  private authenticated = false;

  constructor(private config: TimeTreeClientConfig) {}

  private async ensureAuth(): Promise<void> {
    if (this.authenticated && this.http.hasSession() && this.http.hasCsrf()) return;

    // A locally supplied web session supports Google/Apple sign-in without their passwords.
    if (!this.http.hasSession() && this.config.sessionCookie) this.http.setSession(this.config.sessionCookie);
    if (!this.http.hasSession()) {
      if (!this.config.email || !this.config.password) throw new AuthError('Set TIMETREE_SESSION_COOKIE or TIMETREE_EMAIL and TIMETREE_PASSWORD');

      logger.info('Authenticating with TimeTree');

      // Step 1: signin → session cookie.
      // TimeTree expects uuid to be a hex string without hyphens.
      const uuid = randomUUID().replace(/-/g, '');
      try {
        await this.http.request(`${BASE_URL}/auth/email/signin`, {
          method: 'PUT',
          body: { uid: this.config.email, password: this.config.password, uuid },
        });
      } catch (e) {
        const code = (e as TimeTreeError).statusCode;
        if (code === 401) throw new AuthError('Invalid email or password', 401);
        if (code === 403) throw new AuthError('Account access forbidden', 403);
        throw new AuthError(`Auth failed: ${(e as Error).message}`);
      }

      if (!this.http.hasSession()) {
        throw new AuthError('No session cookie returned from signin');
      }
    }

    // Step 2: fetch the web root HTML to scrape the CSRF token meta tag.
    const html = await this.http.request<string>(WEB_ROOT);
    const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
    if (m) {
      this.http.setCsrf(m[1]);
    } else {
      logger.warn('CSRF token not found in HTML — write operations will fail');
    }

    this.authenticated = true;
    logger.info('Authentication successful');
  }

  async listCalendars(): Promise<TimeTreeCalendar[]> {
    await this.ensureAuth();
    const raw = await this.http.request<unknown>(`${BASE_URL}/calendars?since=0`);
    const parsed = CalendarsResponseSchema.parse(raw);
    return parsed.calendars.filter((c) => !c.deactivated_at);
  }

  get calendarId(): string {
    const id = this.config.calendarId?.trim();
    if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new TimeTreeError('Set TIMETREE_CALENDAR_ID to the ID of 共用行事曆 returned by list_calendars');
    }
    return id;
  }

  private checkEventTarget(event: TimeTreeEvent): TimeTreeEvent {
    if (String(event.calendar_id) !== this.calendarId) throw new TimeTreeError('Event belongs to another calendar');
    return event;
  }

  async listEvents(): Promise<TimeTreeEvent[]> {
    const id = this.calendarId;
    await this.ensureAuth();
    const events = new Map<string, TimeTreeEvent>();
    const seen = new Set<number>([0]);
    let cursor = 0;
    for (let page = 0; page < 1000; page++) {
      const raw = await this.http.request<unknown>(`${BASE_URL}/calendar/${id}/events/sync?since=${cursor}`);
      const data = EventsSyncResponseSchema.parse(raw);
      for (const event of data.events) {
        this.checkEventTarget(event);
        const previous = events.get(event.uuid);
        if (!previous || (event.updated_at ?? 0) >= (previous.updated_at ?? 0)) events.set(event.uuid, event);
      }
      if (!data.chunk) return [...events.values()].filter((e) => !e.deactivated_at);
      if (data.since === undefined || seen.has(data.since)) throw new TimeTreeError('Incomplete event sync: repeated or missing cursor');
      seen.add(data.since);
      cursor = data.since;
    }
    throw new TimeTreeError('Incomplete event sync: page limit reached');
  }

  async getEvent(uuid: string): Promise<TimeTreeEvent> {
    const id = this.calendarId;
    if (!/^[A-Za-z0-9_-]+$/.test(uuid)) throw new TimeTreeError('Invalid event UUID');
    await this.ensureAuth();
    const raw = await this.http.request<unknown>(`${BASE_URL}/calendar/${id}/event/${encodeURIComponent(uuid)}`);
    return this.checkEventTarget(CreateEventResponseSchema.parse(raw).event);
  }

  async createEvent(body: PrivateEventBody): Promise<TimeTreeEvent> {
    return this.writePrivateEvent('POST', '', body);
  }

  async updateEvent(uuid: string, body: PrivateEventBody): Promise<TimeTreeEvent> {
    if (!/^[A-Za-z0-9_-]+$/.test(uuid)) throw new TimeTreeError('Invalid event UUID');
    return this.writePrivateEvent('PUT', `/${encodeURIComponent(uuid)}`, body);
  }

  private async writePrivateEvent(method: 'POST' | 'PUT', suffix: string, body: PrivateEventBody): Promise<TimeTreeEvent> {
    const id = this.calendarId;
    if (body.calendar_id !== undefined && String(body.calendar_id) !== id) throw new TimeTreeError('Cannot write to another calendar');
    await this.ensureAuth();
    if (!this.http.hasCsrf()) throw new AuthError('CSRF token missing; write not sent');
    const raw = await this.http.request<unknown>(`${BASE_URL}/calendar/${id}/event${suffix}`, { method, body, requireCsrf: true });
    return this.checkEventTarget(CreateEventResponseSchema.parse(raw).event);
  }

  /**
   * Upload a single image file as a public_event attachment.
   *
   * Path: POST /api/v1/attachments (multipart/form-data)
   * Form fields:
   *   type     = "public_event"
   *   id       = numeric public_calendar_id (NOT alias_code)
   *   files[]  = the image file (binary)
   *
   * Returns the attachment object_key + the derived public URLs you'd plug
   * into create_event's `images.cover` array.
   */
  async uploadAttachment(
    publicCalendarId: number,
    filePath: string,
  ): Promise<{ attachment: Attachment; url: string; thumbnail_url: string }> {
    await this.ensureAuth();
    const buf = await readFile(filePath);
    const mime = mimeFromPath(filePath);
    const blob = new Blob([new Uint8Array(buf)], { type: mime });

    const form = new FormData();
    form.append('type', 'public_event');
    form.append('id', String(publicCalendarId));
    form.append('files[]', blob, basename(filePath));

    const url = `${BASE_URL}/attachments`;
    const raw = await this.http.request<unknown>(url, {
      method: 'POST',
      body: form,
      requireCsrf: true,
    });
    const parsed = AttachmentsResponseSchema.parse(raw);
    const attachment = parsed.attachments[0];
    if (!attachment) throw new TimeTreeError('Upload succeeded but no attachment returned');
    return { attachment, ...attachmentToImageRef(attachment.object_key) };
  }

  /**
   * Create an event in a public calendar the authenticated account manages.
   *
   * Path: POST /api/v2/managed_public_calendars/{alias_code}/public_events
   *
   * Requires a valid session cookie AND `x-csrf-token`. The v1 endpoint
   * `/calendar/{id}/event` still exists but is no longer what the web app
   * uses — and it doesn't appear to write to the OpenAPI-backed public
   * calendar store, so events created via v1 don't show up in v2 reads.
   */
  async createManagedEvent(aliasCode: string, body: ManagedEventBody): Promise<PublicEvent> {
    const url = `${PUBLIC_BASE_URL}/managed_public_calendars/${encodeURIComponent(aliasCode)}/public_events`;
    return this.writeManagedEvent(url, 'POST', body);
  }

  /**
   * Update an existing event by id. Body is the full event shape — PUT replaces
   * the whole resource, not a partial merge. To swap a cover image, the
   * caller uploads the new attachment first then PUTs with the new
   * images.cover ref; the old attachment stays in cloud storage but is no
   * longer referenced.
   */
  async updateManagedEvent(aliasCode: string, eventId: string, body: ManagedEventBody): Promise<PublicEvent> {
    const url = `${PUBLIC_BASE_URL}/managed_public_calendars/${encodeURIComponent(aliasCode)}/public_events/${encodeURIComponent(eventId)}`;
    return this.writeManagedEvent(url, 'PUT', body);
  }

  private async writeManagedEvent(
    url: string,
    method: 'POST' | 'PUT',
    body: ManagedEventBody,
  ): Promise<PublicEvent> {
    await this.ensureAuth();
    try {
      const raw = await this.http.request<unknown>(url, { method, body, requireCsrf: true });
      return CreatePublicEventResponseSchema.parse(raw).public_event;
    } catch (e) {
      // 403 typically means the CSRF token expired — force one re-auth and retry once.
      if ((e as TimeTreeError).statusCode === 403) {
        logger.warn('CSRF likely expired; re-authenticating and retrying once');
        this.authenticated = false;
        this.http.clearAuth();
        await this.ensureAuth();
        const raw = await this.http.request<unknown>(url, { method, body, requireCsrf: true });
        return CreatePublicEventResponseSchema.parse(raw).public_event;
      }
      throw e;
    }
  }
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    default: return 'application/octet-stream';
  }
}

// ============================================================================
// PublicTimeTreeClient — TimeTree's current OpenAPI v2 endpoints.
//
// The web app stopped using /api/v1/calendars; instead it reads from
// /api/v2/public_calendars/{alias_code}. No session cookie needed, but the
// `X-Timetreea` header IS required (server returns -401 without it).
//
// Used for read paths. Writing back into a public calendar still needs the
// authenticated v1 path (TimeTreeClient above) until we reverse-engineer the
// v2 write endpoint.
// ============================================================================

export class PublicTimeTreeClient {
  async getCalendar(aliasCode: string): Promise<PublicCalendar> {
    const url = `${PUBLIC_BASE_URL}/public_calendars/${encodeURIComponent(aliasCode)}`;
    const raw = await this.request<unknown>(url);
    return PublicCalendarResponseSchema.parse(raw).public_calendar;
  }

  /**
   * List events in a public calendar.
   *
   * @param fromMs  inclusive lower bound, unix ms
   * @param toMs    exclusive upper bound, unix ms
   * @param utcOffsetSec  user's UTC offset in seconds (e.g. 28800 for UTC+8).
   *                      TimeTree uses this to bucket all-day events into the
   *                      caller's local day boundary.
   */
  async listEvents(
    aliasCode: string,
    fromMs: number,
    toMs: number,
    utcOffsetSec: number,
  ): Promise<PublicEvent[]> {
    const qs = new URLSearchParams({
      from: String(fromMs),
      to: String(toMs),
      utc_offset: String(utcOffsetSec),
    });
    const url = `${PUBLIC_BASE_URL}/public_calendars/${encodeURIComponent(aliasCode)}/public_events?${qs}`;
    const raw = await this.request<unknown>(url);
    return PublicEventsResponseSchema.parse(raw).public_events;
  }

  private async request<T>(url: string, timeoutMs = 30_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      logger.debug('Public HTTP request', { url });
      const res = await fetch(url, { headers: DEFAULT_HEADERS, signal: controller.signal });
      if (!res.ok) {
        const errBody = await res.text();
        logger.error('Public HTTP non-2xx', { status: res.status, url });
        throw new TimeTreeError(
          `HTTP ${res.status}: ${res.statusText} - ${errBody.slice(0, 200)}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new TimeTreeError(`Request timeout after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
