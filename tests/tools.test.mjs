import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../.test-dist/tools/index.js';
import { createCreateEventTool, createUpdateEventTool } from '../.test-dist/tools/event-crud-tools.js';
import { createCreateMemoTool } from '../.test-dist/tools/memo-tools.js';
import { createPosterWorkspaceStatusTool } from '../.test-dist/tools/poster-workflow-tools.js';

function makeEvent(overrides = {}) {
  return {
    id: overrides.uuid ?? 'event-1',
    uuid: overrides.uuid ?? 'event-1',
    calendar_id: 123,
    title: 'event',
    all_day: false,
    start_at: 1,
    end_at: 2,
    start_timezone: 'UTC',
    end_timezone: 'UTC',
    category: 1,
    label_id: 1,
    alerts: [],
    recurrences: [],
    attendees: [],
    attachment: null,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

function parseToolText(result) {
  return JSON.parse(result.content[0].text);
}

test('registerTools exposes baseline plus Wave 1 tools', () => {
  const names = registerTools({}).map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    'add_event_comment',
    'create_event',
    'create_memo',
    'delete_event',
    'delete_event_comment',
    'delete_memo',
    'get_calendar_labels',
    'get_calendar_members',
    'get_calendar_virtual_members',
    'get_events',
    'get_updated_events',
    'list_calendars',
    'list_event_comments',
    'list_memos',
    'mark_poster_processed',
    'poster_workspace_status',
    'update_calendar_labels',
    'update_event',
    'update_event_comment',
    'update_memo',
  ].sort());
});

test('create_event passes alerts, recurrences, attendees, files, and virtual attendees through', async () => {
  let captured;
  const tool = createCreateEventTool({
    createEvent: async (calendarId, data) => {
      captured = { calendarId, data };
      return makeEvent({
        uuid: 'created',
        calendar_id: Number(calendarId),
        title: data.title,
        all_day: data.all_day,
        start_at: data.start_at,
        end_at: data.end_at,
        alerts: data.alerts,
        recurrences: data.recurrences,
        attendees: data.attendees,
        attachment: data.attachment,
      });
    },
  });

  const result = await tool.handler({
    calendar_id: 123,
    title: 'private',
    start_at: 1000,
    end_at: 2000,
    alerts: [5, 30],
    recurrences: ['RRULE:FREQ=DAILY;COUNT=2'],
    attendees: [42],
    file_uuids: ['file-1'],
    checklist: [{ title: 'todo', checked: false }],
    virtual_user_attendees: ['virtual-1'],
  });

  assert.equal(captured.calendarId, '123');
  assert.deepEqual(captured.data.alerts, [5, 30]);
  assert.deepEqual(captured.data.recurrences, ['RRULE:FREQ=DAILY;COUNT=2']);
  assert.deepEqual(captured.data.attendees, [42]);
  assert.deepEqual(captured.data.file_uuids, ['file-1']);
  assert.deepEqual(captured.data.attachment.virtual_user_attendees, ['virtual-1']);
  assert.equal(parseToolText(result).event.virtual_user_attendees[0], 'virtual-1');
});

test('poster_workspace_status moves loose images into pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'timetree-posters-'));
  const looseImage = join(root, 'poster.jpg');
  await writeFile(looseImage, 'fake image');

  const tool = createPosterWorkspaceStatusTool();
  const result = await tool.handler({ root });
  const body = parseToolText(result);

  assert.equal(body.counts.pending, 1);
  assert.equal(body.moved_loose_images.length, 1);
  assert.equal(body.pending[0].name, 'poster.jpg');
});

test('create_event marks pending poster as created and writes log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'timetree-posters-'));
  const pending = join(root, '00_pending');
  await mkdir(pending, { recursive: true });
  const imagePath = join(pending, 'poster.png');
  await writeFile(imagePath, 'fake image');

  const tool = createCreateEventTool({
    createEvent: async (calendarId, data) => makeEvent({
      uuid: 'created',
      calendar_id: Number(calendarId),
      title: data.title,
      start_at: data.start_at,
      end_at: data.end_at,
      url: 'https://example.test/event',
    }),
  });

  const result = await tool.handler({
    calendar_id: 123,
    title: 'poster event',
    start_at: 1000,
    end_at: 2000,
    image_path: imagePath,
    poster_workspace_root: root,
  });
  const body = parseToolText(result);

  assert.equal(body.poster_workflow.moved, true);
  assert.match(body.poster_workflow.to, /10_created/);

  const log = await readFile(body.poster_workflow.log_path, 'utf8');
  assert.match(log, /poster event/);
  assert.match(log, /created/);
});

test('update_event passes partial scheduling and attachment fields through', async () => {
  let captured;
  const tool = createUpdateEventTool({
    updateEvent: async (calendarId, eventUuid, data) => {
      captured = { calendarId, eventUuid, data };
      return makeEvent({
        uuid: eventUuid,
        calendar_id: Number(calendarId),
        title: data.title ?? 'unchanged',
        alerts: data.alerts ?? [],
        recurrences: data.recurrences ?? [],
        attendees: data.attendees ?? [],
        attachment: data.attachment ?? null,
      });
    },
  });

  const result = await tool.handler({
    calendar_id: 123,
    event_uuid: 'evt',
    alerts: [],
    recurrences: ['RRULE:FREQ=WEEKLY;COUNT=2'],
    attendees: [1, 2],
    checklist: [],
    virtual_user_attendees: [],
  });

  assert.equal(captured.calendarId, '123');
  assert.equal(captured.eventUuid, 'evt');
  assert.deepEqual(captured.data.alerts, []);
  assert.deepEqual(captured.data.recurrences, ['RRULE:FREQ=WEEKLY;COUNT=2']);
  assert.deepEqual(captured.data.attendees, [1, 2]);
  assert.deepEqual(captured.data.attachment, { checklist: [], virtual_user_attendees: [] });
  assert.equal(parseToolText(result).success, true);
});

test('create_memo wraps input as category=2 memo data with UTC date', async () => {
  let captured;
  const tool = createCreateMemoTool({
    createMemo: async (calendarId, data) => {
      captured = { calendarId, data };
      return makeEvent({
        uuid: 'memo',
        calendar_id: Number(calendarId),
        title: data.title,
        all_day: true,
        category: 2,
        start_at: data.start_at,
        end_at: data.start_at,
        note: data.note,
        attachment: { checklist: data.checklist, virtual_user_attendees: data.virtual_user_attendees },
      });
    },
  });

  const result = await tool.handler({
    calendar_id: 123,
    title: 'memo',
    note: 'body',
    date: '2026-05-25',
    checklist: [{ title: 'memo item', checked: true }],
    virtual_user_attendees: ['v1'],
  });

  assert.equal(captured.calendarId, '123');
  assert.equal(captured.data.start_at, Date.UTC(2026, 4, 25));
  assert.deepEqual(captured.data.checklist, [{ title: 'memo item', checked: true }]);
  assert.equal(parseToolText(result).memo.memo_date, '2026-05-25');
});
