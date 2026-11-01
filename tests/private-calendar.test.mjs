import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeTreeClient } from '../dist/timetree.js';
import { buildTools, isoToUtcMs } from '../dist/tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const event = {
  id: 'event-id', uuid: 'event-uuid', calendar_id: 42, title: 'Original', all_day: false,
  start_at: Date.parse('2026-11-01T10:00:00+08:00'), end_at: Date.parse('2026-11-01T11:00:00+08:00'),
  start_timezone: 'Asia/Taipei', end_timezone: 'Asia/Taipei', note: 'Keep note',
  attendees: [7], alerts: [10], recurrences: ['RRULE:FREQ=WEEKLY'], file_uuids: ['file-id'],
  attachment: { url: 'https://example.com/old', checklist: [{ title: 'Keep', checked: true }], custom: { keep: true } },
  future_field: { must: 'survive' },
};

function fixture(responses, calendarId = '42', config = {}) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const reply = responses.shift();
    assert.ok(reply, `Unexpected fetch: ${url}`);
    return reply;
  };
  const client = new TimeTreeClient({ email: 'test@example.invalid', password: 'mock-only', calendarId, ...config });
  return { client, requests, tool: (name) => buildTools(client).find((t) => t.name === name),
    restore: () => { globalThis.fetch = original; } };
}
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const auth = () => [
  new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': '_session_id=mock-session; Secure; HttpOnly' } }),
  new Response('<meta name="csrf-token" content="mock-csrf">'),
];
const payload = (result) => JSON.parse(result.content[0].text);

test('concurrent updates to one event preserve both field changes', async () => {
  const originalFetch = globalThis.fetch;
  let state = structuredClone(event);
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://timetreeapp.com/') return new Response('<meta name="csrf-token" content="mock-csrf">');
    if (options.method === 'GET') {
      const snapshot = structuredClone(state);
      reads++;
      await new Promise(setImmediate);
      return json({ event: snapshot });
    }
    assert.equal(options.method, 'PUT');
    state = JSON.parse(options.body);
    return json({ event: state });
  };
  try {
    const client = new TimeTreeClient({ email: '', password: '', sessionCookie: 'mock-session', calendarId: '42' });
    const update = buildTools(client).find((t) => t.name === 'update_event');
    const results = await Promise.all([
      update.handler({ event_uuid: event.uuid, title: 'Changed title' }),
      update.handler({ event_uuid: event.uuid, description: 'Changed note' }),
    ]);
    assert.ok(results.every((r) => !r.isError));
    assert.equal(reads, 2);
    assert.equal(state.title, 'Changed title');
    assert.equal(state.note, 'Changed note');
  } finally { globalThis.fetch = originalFetch; }
});

test('same-event read waits for the preceding write to finish', async () => {
  let releaseFirstRead, startedFirstRead;
  const firstRead = new Promise((resolve) => { startedFirstRead = resolve; });
  const gate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const calls = [];
  let state = structuredClone(event);
  const client = {
    async getEvent() {
      calls.push('GET');
      if (calls.length === 1) { startedFirstRead(); await gate; }
      return structuredClone(state);
    },
    async updateEvent(uuid, body) { calls.push('PUT'); state = body; return structuredClone(state); },
  };
  const update = buildTools(client).find((t) => t.name === 'update_event');
  const first = update.handler({ event_uuid: event.uuid, title: 'First' });
  await firstRead;
  const second = update.handler({ event_uuid: event.uuid, description: 'Second' });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['GET']);
  releaseFirstRead();
  assert.ok((await Promise.all([first, second])).every((r) => !r.isError));
  assert.deepEqual(calls, ['GET', 'PUT', 'GET', 'PUT']);
  assert.equal(state.title, 'First');
  assert.equal(state.note, 'Second');
});

test('failed GET or PUT releases the next queued update and later updates', { timeout: 2000 }, async () => {
  for (const failure of ['GET', 'PUT']) {
    let gets = 0, puts = 0;
    let state = structuredClone(event);
    const client = {
      async getEvent() { if (++gets === 1 && failure === 'GET') throw new Error('Mock read failure'); return structuredClone(state); },
      async updateEvent(uuid, body) { if (++puts === 1 && failure === 'PUT') throw new Error('Mock write failure'); state = body; return structuredClone(state); },
    };
    const update = buildTools(client).find((t) => t.name === 'update_event');
    const results = await Promise.all([
      update.handler({ event_uuid: event.uuid, title: 'Fails' }),
      update.handler({ event_uuid: event.uuid, description: 'Survives' }),
    ]);
    assert.equal(results[0].isError, true);
    assert.ok(!results[1].isError);
    assert.equal(state.note, 'Survives');
    assert.ok(!(await update.handler({ event_uuid: event.uuid, title: 'After queue' })).isError);
    assert.equal(state.title, 'After queue');
  }
});

test('updates to different events can read concurrently', { timeout: 2000 }, async () => {
  let release, bothStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { bothStarted = resolve; });
  const reads = [];
  const client = {
    async getEvent(uuid) { reads.push(uuid); if (reads.length === 2) bothStarted(); await gate; return { ...structuredClone(event), uuid }; },
    async updateEvent(uuid, body) { return body; },
  };
  const update = buildTools(client).find((t) => t.name === 'update_event');
  const results = [update.handler({ event_uuid: 'event-a', title: 'A' }), update.handler({ event_uuid: 'event-b', title: 'B' })];
  await started;
  assert.deepEqual(reads, ['event-a', 'event-b']);
  release();
  assert.ok((await Promise.all(results)).every((r) => !r.isError));
});

test('local Google web session skips password sign-in and retrieves CSRF for private writes', async () => {
  const f = fixture([new Response('<meta name="csrf-token" content="mock-csrf">'), json({ calendars: [{ id: 42, name: 'Target' }] }), json({ event })], '42', { email: '', password: '', sessionCookie: 'mock-google-session' });
  try {
    assert.ok(!(await f.tool('list_calendars').handler({})).isError);
    assert.ok(!(await f.tool('create_event').handler({ title: 'Example', start: '2026-11-01' })).isError);
    assert.equal(f.requests[0].url, 'https://timetreeapp.com/');
    assert.equal(f.requests[0].headers.Cookie, '_session_id=mock-google-session');
    assert.equal(f.requests[2].headers['x-csrf-token'], 'mock-csrf');
    assert.ok(!f.requests.some((r) => r.url.includes('/auth/email/signin')));
  } finally { f.restore(); }
});

test('invalid local session values are rejected before any network access', async () => {
  for (const cookie of ['value; other=x', 'value\r\nInjected: header', 'value with space']) {
    const f = fixture([], '42', { sessionCookie: cookie });
    try { assert.ok((await f.tool('list_calendars').handler({})).isError); assert.equal(f.requests.length, 0); }
    finally { f.restore(); }
  }
});

test('expired local session errors do not echo response body and are not retried', async () => {
  const f = fixture([new Response('private-cookie-detail', { status: 401 })], '42', { sessionCookie: 'mock-expired-session' });
  try {
    const result = await f.tool('list_calendars').handler({});
    assert.ok(result.isError);
    assert.ok(!JSON.stringify(result).includes('private-cookie-detail'));
    assert.equal(f.requests.length, 1);
  } finally { f.restore(); }
});

test('private discovery and create use session, CSRF and pinned endpoint with a direct body', async () => {
  const f = fixture([...auth(), json({ calendars: [{ id: 42, name: '共用行事曆' }, { id: 43, name: '共用行事曆' }] }), json({ event })]);
  try {
    assert.equal(payload(await f.tool('list_calendars').handler({})).calendars.length, 2);
    assert.equal(f.requests[2].url, 'https://timetreeapp.com/api/v1/calendars?since=0');
    const result = await f.tool('create_event').handler({ title: 'Dinner', start: '2026-11-01T18:00', link_url: 'https://example.com/new' });
    assert.ok(!result.isError);
    const request = f.requests[3];
    assert.equal(request.url, 'https://timetreeapp.com/api/v1/calendar/42/event');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Cookie, '_session_id=mock-session');
    assert.equal(request.headers['x-csrf-token'], 'mock-csrf');
    assert.equal(request.body.start_at, Date.parse('2026-11-01T18:00+08:00'));
    assert.equal(request.body.end_at - request.body.start_at, 3600000);
    assert.deepEqual(request.body.attachment, { url: 'https://example.com/new' });
    assert.equal(request.body.event, undefined);
  } finally { f.restore(); }
});

test('update fetches existing event then preserves unknown, attachments and schedule fields', async () => {
  const f = fixture([...auth(), json({ event }), json({ event: { ...event, title: 'Changed' } })]);
  try {
    assert.ok(!(await f.tool('update_event').handler({ event_uuid: event.uuid, title: 'Changed', link_url: '' })).isError);
    assert.equal(f.requests[2].method, 'GET');
    assert.equal(f.requests[2].url, 'https://timetreeapp.com/api/v1/calendar/42/event/event-uuid');
    const write = f.requests[3];
    assert.equal(write.method, 'PUT');
    assert.equal(write.url, f.requests[2].url);
    assert.deepEqual(write.body, { ...event, title: 'Changed', attachment: { ...event.attachment, url: null } });
  } finally { f.restore(); }
});

test('missing target and calendar override are refused before network access', async () => {
  const f = fixture([], '');
  try {
    assert.ok((await f.tool('create_event').handler({ title: 'Blocked', start: '2026-11-01' })).isError);
    assert.ok((await f.tool('list_events').handler({ from: '2026-11-01', to: '2026-11-02', calendar_id: 43 })).isError);
    assert.ok((await f.tool('list_events').handler({ from: '2026-11-01', to: '2026-11-02' })).isError);
    assert.equal(f.requests.length, 0);
    await assert.rejects(f.client.updateEvent('uuid', { ...event, calendar_id: 43 }));
  } finally { f.restore(); }
});

test('event UUID traversal is refused before any request', async () => {
  const f = fixture([]);
  try {
    for (const uuid of ['..', '../other', 'x?calendar_id=43']) {
      assert.ok((await f.tool('update_event').handler({ event_uuid: uuid, title: 'Blocked' })).isError);
      await assert.rejects(f.client.getEvent(uuid));
      await assert.rejects(f.client.updateEvent(uuid, event));
    }
    await assert.rejects(f.client.createEvent({ ...event, calendar_id: 43 }));
    assert.equal(f.requests.length, 0);
  } finally { f.restore(); }
});

test('title-only update preserves attachment object without normalization', async () => {
  const f = fixture([...auth(), json({ event }), json({ event })]);
  try {
    assert.ok(!(await f.tool('update_event').handler({ event_uuid: event.uuid, title: 'Only title' })).isError);
    assert.deepEqual(f.requests[3].body, { ...event, title: 'Only title' });
  } finally { f.restore(); }
});

test('cross-calendar event read is refused without PUT', async () => {
  const f = fixture([...auth(), json({ event: { ...event, calendar_id: 43 } })]);
  try {
    assert.ok((await f.tool('update_event').handler({ event_uuid: event.uuid, title: 'Blocked' })).isError);
    assert.equal(f.requests.length, 3);
  } finally { f.restore(); }
});

test('sync pages descending cursor and filters overlap including all-day inclusive end', async () => {
  const allDay = { ...event, uuid: 'all-day', all_day: true, start_at: isoToUtcMs('2026-10-31', 'Asia/Taipei'), end_at: isoToUtcMs('2026-11-01', 'Asia/Taipei') };
  const f = fixture([...auth(), json({ events: [allDay], chunk: true, since: 200 }), json({ events: [event], chunk: true, since: 100 }), json({ events: [{ ...event, uuid: 'deleted', deactivated_at: 1 }], chunk: false })]);
  try {
    const result = await f.tool('list_events').handler({ from: '2026-11-01', to: '2026-11-02' });
    assert.ok(!result.isError);
    assert.equal(payload(result).total, 2);
    assert.deepEqual(f.requests.slice(2).map((r) => r.url), [0, 200, 100].map((n) => `https://timetreeapp.com/api/v1/calendar/42/events/sync?since=${n}`));
  } finally { f.restore(); }
});

test('incomplete pagination returns an error, never a truncated event list', async () => {
  const f = fixture([...auth(), json({ events: [event], chunk: true, since: 0 })]);
  try { assert.ok((await f.tool('list_events').handler({ from: '2026-11-01', to: '2026-11-02' })).isError); }
  finally { f.restore(); }
});

test('date parsing rejects overflow, offsets and DST ambiguity and converts Taipei correctly', () => {
  assert.equal(isoToUtcMs('2026-11-01T00:00', 'Asia/Taipei'), Date.parse('2026-10-31T16:00Z'));
  for (const date of ['2026-02-30', '2026-11-01T24:00', '2026-11-01T10:00Z', '2026-11-01junk']) {
    assert.throws(() => isoToUtcMs(date, 'Asia/Taipei'));
  }
  assert.throws(() => isoToUtcMs('2026-03-08T02:30', 'America/New_York'));
  assert.throws(() => isoToUtcMs('2026-11-01T01:30', 'America/New_York'));
});

test('all-day creation uses inclusive same-day default and timed cross-day is preserved', async () => {
  const f = fixture([...auth(), json({ event }), json({ event })]);
  try {
    assert.ok(!(await f.tool('create_event').handler({ title: 'Day', start: '2026-11-01', all_day: true })).isError);
    assert.equal(f.requests[2].body.start_at, f.requests[2].body.end_at);
    assert.ok(!(await f.tool('create_event').handler({ title: 'Night', start: '2026-11-01T23:00', end: '2026-11-02T01:00' })).isError);
    assert.equal(f.requests[3].body.end_at - f.requests[3].body.start_at, 7200000);
    assert.ok((await f.tool('create_event').handler({ title: 'Invalid', start: '2026-11-01T23:00', end: '2026-11-01T01:00' })).isError);
    assert.equal(f.requests.length, 4);
  } finally { f.restore(); }
});

test('missing CSRF prevents POST; HTTP errors cannot echo server secrets in tool result', async () => {
  const f = fixture([auth()[0], new Response('no CSRF')]);
  try {
    assert.ok((await f.tool('create_event').handler({ title: 'Blocked', start: '2026-11-01' })).isError);
    assert.equal(f.requests.length, 2);
  } finally { f.restore(); }
  const g = fixture([...auth(), new Response('private-server-detail', { status: 403 })]);
  try {
    const result = await g.tool('create_event').handler({ title: 'Blocked', start: '2026-11-01' });
    assert.ok(result.isError);
    assert.ok(!JSON.stringify(result).includes('private-server-detail'));
    assert.equal(g.requests.length, 3);
  } finally { g.restore(); }
});

test('real local stdio MCP handshake exposes only four private calendar tools', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } });
  const client = new Client({ name: 'offline-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name), ['list_calendars', 'list_events', 'create_event', 'update_event']);
    assert.ok(result.tools.every((tool) => !JSON.stringify(tool.inputSchema).includes('alias_code')));
  } finally { await client.close(); }
});
