# timetree-mcp

個人使用的非官方 TimeTree MCP，專門讀取、新增及更新自己帳號中的非公開「共用行事曆」。日曆仍由 TimeTree 既有成員共用，MCP 不會把它轉成公開日曆。

TimeTree 已於 [2023-12-22 停止官方 Connect API](https://timetreeapp.com/intl/en/newsroom/2023-12-14/connect-app-api-202312)。本專案使用非官方 web API，可能隨服務變動失效，沒有官方支援。Endpoint 與事件格式參考 [ehs208/TimeTree-MCP](https://github.com/ehs208/TimeTree-MCP)（MIT），並未匯入其程式。請自行確認服務使用條款。

## 安裝與設定

需要 Node.js 18+。在本專案目錄執行：

```powershell
npm install
npm run build
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

使用 email 登入時，在本機 `.env` 填入 `TIMETREE_EMAIL` 與 `TIMETREE_PASSWORD`。Google/Apple 登入請使用下方的本機 session 匯入。不要把密碼或 session 貼到對話、命令列或同步筆記；`.env` 已被 git 忽略。

### Google 登入的本機 session 匯入

本程式不代替 Google 登入，也不讀取 Chrome cookie 資料庫。先在 Chrome 登入 TimeTree，開啟 DevTools → Application → Cookies → https://timetreeapp.com，找到 `_session_id`，只複製 Value 欄位，然後在本專案目錄的 PowerShell 執行：

```powershell
& .\scripts\Import-TimeTreeSession.ps1
```

腳本只把剪貼簿中的值寫入 gitignored `.env` 的 `TIMETREE_SESSION_COOKIE`，保留其他設定，不印出值，完成後清空剪貼簿；含換行、空白或 Cookie header 的輸入會拒絕。Session 等同帳號憑證，不要貼到聊天。若 PowerShell 不允許執行腳本，可以直接在本機編輯 `.env`，同樣不要將值輸出或分享。

使用 session 時不需要 TimeTree 密碼；session 優先於帳密。過期時本機重新登入與匯入，不會自動改用帳密重試。CSRF 仍從 TimeTree 頁面讀取，缺少 CSRF 不會送出寫入。Session 交接方式參考 [第三方實作的認證文件](https://github.com/kfa-ai/hermes-timetree-sync/blob/main/docs/authentication.md)，不是官方支援的 API。

### 連接 Codex App

在專案目錄執行以下命令，讓 Codex 記住實際的 server 絕對路徑；命令不包含帳號密碼：

```powershell
codex mcp add timetree-private -- (Get-Command node).Source (Join-Path (Get-Location) 'dist/index.js')
```

也可以在本機 `~/.codex/config.toml` 加入以下設定，將路徑換成實際位置：

```toml
[mcp_servers.timetree-private]
command = "node"
args = ['C:\path\to\TimeTree-MCP\dist\index.js']
```

Codex App 與 CLI 共用這份 MCP 設定，見 [OpenAI 官方 MCP 文件](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本機 `codex mcp add --help` 已確認命令格式。設定完成後重新啟動 Codex；可用 `codex mcp list` 檢查註冊。這個 server 使用自己的 TimeTree 帳號登入流程，不使用 `codex mcp login` 的 OAuth。

沒有 credentials 時 server 仍可啟動、列出四個工具，但所有日曆呼叫會回傳驗證失敗；填好本機 `.env` 或匯入 session 後重新啟動。沒有設定日曆 ID 時，可先完成以下 discovery：

1. 呼叫 `list_calendars`，從目前帳號可存取的日曆找出「共用行事曆」的 ID。
2. 把 ID 填入本機 `.env` 的 `TIMETREE_CALENDAR_ID`，重新啟動 MCP。
3. 先呼叫 `list_events` 確認日曆與日期範圍，再新增或更新正式事件。

名稱只用於人工辨識；若有多個同名日曆，必須先確認正確 ID，程式不會任選。沒有設定有效 ID 時，只有 `list_calendars` 可用。所有事件操作只使用鎖定的 ID，不接受工具參數覆寫日曆。設定錯誤但有效的 ID 仍會操作該日曆，請先確認讀回內容。

伺服器從專案根目錄載入 `.env`；既有 process 環境變數優先。匯入的 session 會保存在本機 `.env`；程式執行時的 session/CSRF 更新只存於記憶體。登入失效需本機刷新 session 並重新啟動 MCP；寫入遇到 timeout 或錯誤時不自動重送，請先讀回確認是否已建立，以免重複事件。

## 工具

只提供 `list_calendars`、`list_events`、`create_event`、`update_event`。不再提供公開日曆、圖片上傳或海報檔案搬移工具。

- `list_calendars {}`：列出帳號可存取的有效日曆 ID 與名稱，用於第一次設定。
- `list_events {"from":"2026-11-01","to":"2026-12-01"}`：列出鎖定日曆與 `[from,to)` 重疊的事件，回傳 `uuid` 供更新使用。會同步所有分頁後依日期篩選；遇到不完整分頁會回報錯誤。
- `create_event {"title":"晚餐","start":"2026-11-05T18:00","end":"2026-11-05T20:00"}`：新增一般事件；未給 end 預設一小時。
- `create_event {"title":"休假","start":"2026-11-05","end":"2026-11-06","all_day":true}`：全日日期包含 end，以上為 11/5–11/6 兩天；未給 end 為單日。
- `update_event {"event_uuid":"從 list_events 取得的 uuid","title":"新標題"}`：先讀取原事件，再保留未指定欄位送出更新，包括附件、checklist、提醒、重複設定及未知欄位。`link_url` 只修改 attachment.url，空字串可清除連結。

日期使用當地 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm[:ss]`，不接受尾端 Z 或 UTC offset。`timezone` 預設 `Asia/Taipei`；DST 不存在或有兩種解讀的時間會拒絕。全日事件只接受日期。更新時若變更 timezone 或 all_day，必須同時提供 start/end；只改 start 不會自動移動原 end。時間或範圍不合法會拒絕。

新增與更新還可指定 `location`、`description`、`link_url`（HTTP/HTTPS）與 `label_id`（1–10）。新增預設一般事件，不預設指定出席成員；日曆其他成員仍可能看見變更或收到通知。同一 MCP 程序會循序處理同一事件的更新，避免自己的兩個更新互相覆蓋；不同事件可以並行。讀取後到寫入之間若其他成員或其他程序同時改動事件，仍有覆蓋風險；非官方 API 沒有已驗證的版本鎖定機制。

## 驗證

```powershell
npm run typecheck
npm run build
node --test tests/private-calendar.test.mjs
& .\tests\session-import.test.ps1
```

測試使用 mock fetch 驗證私人 endpoint、固定 ID、更新欄位保留、日期與分頁，以及本機 MCP 握手。這些是離線驗證，不能證明真實帳號登入、權限或 TimeTree 實際寫入成功。需在本機設定帳號和日曆 ID 後，再驗證實際讀寫。獨立安全審查見 `reports/security.md`；依賴 audit 因沒有 lockfile 而回報 ENOLOCK，尚未完成。
