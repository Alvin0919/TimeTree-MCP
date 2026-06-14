# timetree-mcp

A personal-use MCP server that lets Claude write events into your shared TimeTree calendar.
Typical flow: paste an event poster → Claude extracts date / location / title and writes a
short description → calls `create_event` → event shows up in the TimeTree app.

## ⚠️ Disclaimer (read before using)

- TimeTree's **official Connect API was shut down on 2023-12-22**. This MCP talks to
  TimeTree's *internal* web API (the same one the web app uses), reverse-engineered.
- This is **unofficial and not affiliated with TimeTree, Inc.** It may break at any time
  if TimeTree changes the internal API. Using it may **violate TimeTree's Terms of Service**.
- **Use a dedicated TimeTree account**, not your main one. Invite that account to the
  shared calendar(s) you want to manage. If TimeTree flags the account, only the dedicated
  one is at risk.
- **Personal use only.** Don't publish this, don't run it at scale, don't make commercial
  use of it.

Endpoint mapping informed by [ehs208/TimeTree-MCP](https://github.com/ehs208/TimeTree-MCP) (MIT)
and [eoleedi/TimeTree-Exporter](https://github.com/eoleedi/TimeTree-Exporter).

## Install

Requires Node.js 18+.

```powershell
cd C:\Users\user\Desktop\timetree-mcp
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and fill in your dedicated account:

```
TIMETREE_EMAIL=dedicated-bot@example.com
TIMETREE_PASSWORD=...
LOG_LEVEL=INFO
```

The server reads `.env` from the project root at startup, so you do NOT need
to pass credentials on the `claude mcp add` command line (that would put them
in PowerShell history). Just register the binary:

```powershell
claude mcp add timetree node "C:\Users\user\Desktop\timetree-mcp\dist\index.js"
```

Or, if you prefer editing config directly (e.g. `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "timetree": {
      "command": "node",
      "args": ["C:\\Users\\user\\Desktop\\timetree-mcp\\dist\\index.js"]
    }
  }
}
```

Restart Claude Code. `/mcp` should show `timetree` with the TimeTree tools,
including `list_calendars`, `list_events`, `create_event`, `update_event`,
`poster_workspace_status`, and `mark_poster_processed`.

Process-level env vars still override the `.env` file, so CI / one-off
invocations can set `TIMETREE_PASSWORD=xxx node dist/index.js` to bypass it.

## Usage

### Poster folder workflow

Use a single poster workspace folder, defaulting to:

```text
C:\Users\daan\Desktop\timetree海報更新
```

The MCP manages this structure:

```text
timetree海報更新
├─ 00_待處理
├─ 10_已新增
├─ 20_已更新既有事件
├─ 90_需人工確認
└─ _log
```

Rules:

1. Put new poster images in `00_待處理`.
2. Start by calling `poster_workspace_status`; it creates missing folders and lists only pending images.
3. When `create_event` succeeds with an `image_path` from `00_待處理`, the poster is moved to `10_已新增`.
4. When `update_event` succeeds with an `image_path` from `00_待處理`, the poster is moved to `20_已更新既有事件`.
5. Use `mark_poster_processed` with `status: "needs_review"` for unclear posters; they move to `90_需人工確認`.
6. Every move appends a CSV record under `_log`.

If someone drops images directly into the workspace root, `poster_workspace_status`
moves them into `00_待處理` by default so future runs still process only new items.

The intended workflow:

1. Drop an event poster (image) into a Claude Code conversation.
2. Ask Claude something like: *"請把這張海報的活動加到我的家庭共用行事曆。"*
3. Claude reads the poster, calls `list_calendars` to find the right calendar_id,
   writes a short description, and calls `create_event` with an ISO date.
4. Open TimeTree on your phone — the event is there.

## Tools

### `list_calendars`

No arguments. Returns `{calendars: [{calendar_id, name, members}], total}`.
Use this first to know which `calendar_id` to write into.

### `create_event`

Required: `calendar_id` (number), `title` (string), `start` (ISO 8601 string).

Optional:
- `end` — ISO 8601. Defaults to `start + 1h` for timed events, `start` (same day) for all-day.
- `all_day` — boolean (default `false`).
- `timezone` — IANA timezone (default `Asia/Taipei`).
- `location` — string.
- `description` — short note, shows up as the event note in TimeTree.
- `label_id` — 1-10. 1=Emerald 2=Cyan 3=Blue 4=Brown 5=Black 6=Red 7=Rose 8=Pink 9=Orange 10=Violet.

Returns the created event with its `uuid` (useful if you later add `update_event` / `delete_event`).

### `poster_workspace_status`

Creates/checks the poster workspace folders, moves loose root-level images into
`00_待處理` by default, and returns pending image paths.

### `mark_poster_processed`

Moves a poster out of `00_待處理` and writes the CSV log. This is automatic for
successful `create_event` and `update_event` calls when `image_path` points into
`00_待處理`, so this tool is mainly for manual corrections and `needs_review`.

## Troubleshooting

- **`Invalid email or password`** — TimeTree returned 401. Check the dedicated account
  credentials. If the account uses social login (Google / Apple), it won't have an
  email/password and this MCP can't authenticate it. Use a TimeTree account created
  with email/password signup.
- **`CSRF token missing or invalid`** — usually means the session expired between
  calls. The client auto-reauths once on 403; if you see this twice in a row,
  TimeTree may have changed the CSRF token location.
- **Empty `list_calendars` result** — make sure the dedicated account is actually a
  member of at least one shared calendar.
- **Build fails on Windows with esbuild ENOENT** — known npm 10.8.x bug. Try
  `npm install --no-package-lock` or upgrade npm to 10.9+.

## Project structure

```
src/
  index.ts      # MCP server entry (stdio transport)
  timetree.ts   # auth + HTTP + API client + logger
  tools.ts      # MCP tools: list_calendars, create_event
  types.ts      # Zod schemas and TS types
```

Four files, ~700 LOC. MVP scope. Extend by adding more handlers to `buildTools` in `tools.ts`.
