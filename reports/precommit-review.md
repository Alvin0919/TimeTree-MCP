# Independent precommit adversarial review

Reviewed 2026-11-01, baseline `6cb82c6`; concrete source instructions: `05-Claude-Config/Agents/adversarial-reviewer.md` and `security-reviewer.md`. The reviewer independently read the source/diff and ran checks rather than accepting implementer results. No commit, push, login, live event read/write, or source change was performed by the reviewer.

## Open findings (0)

No Critical or High issue was reproduced. The one Medium correctness issue found during review has been fixed and independently reverified.

## Resolved finding

### [Medium, resolved] Same-process simultaneous updates could discard an earlier update

- **Original location**: `src/tools.ts:74` and the `update_event` read/modify/write handler.
- **Original reproduction**: Mock both GET requests to return the same snapshot. Invoke concurrent updates to title and description for one UUID. Both succeed; the later full-body PUT restores the original title, losing the earlier title update. The reviewer executed this probe before the fix.
- **Fix reviewed**: A per-UUID completion-promise queue now wraps the entire GET, body merge, and PUT in the server tool registry. `finally` releases the next caller and removes the map entry only when it is still the current tail. Different UUIDs use different queue entries.
- **Independent re-verification**: Reviewer reran typecheck, build, all 19 tests, and the mock PowerShell helper suite. The reviewer also wrote and executed a separate probe: three simultaneous updates to one UUID retain title, description, and location in strict GET/PUT order; a later update after queue drain succeeds; GET failure, PUT failure, and event-body validation failure each release the next queued update and later updates; two different UUIDs can read concurrently.
- **Residual scope**: Other processes and other calendar members can still cause read/modify/write races. This is explicitly documented; no verified server revision lock is claimed.

## Independently verified checks

- Typecheck and build: exit 0 after the final source change.
- Node suite: 19/19 passed, including local stdio MCP handshake exposing only `list_calendars`, `list_events`, `create_event`, `update_event`.
- PowerShell helper suite: mock-only import passed; config preservation, secret-free output, clipboard cleanup, invalid values, duplicate keys.
- Additional runtime boundaries: null, arrays, empty fields, invalid IDs, negative/out-of-range labels, unknown timezone, disallowed link schemes, and calendar override rejected before network.
- Permission/failure mocks: a 403 and AbortError each yielded one write attempt, no automatic retry, a tool error, and no mocked response body disclosure.
- Existing suite covers pagination cycles, cross-calendar response refusal, UUID traversal, date overflow, DST ambiguity, missing CSRF, session-only auth, and omitted-field preservation.
- Public Git/package candidate file review: ignored local `.env` absent from tracked files and npm dry-run listing. No credential value was read or printed.
- `git diff --check`: exit 0.

## Separate evidence and incomplete verification

- Main task reported live new-process stdio handshake, discovery, and private calendar reads succeeded with zero write calls. This is separately attributed evidence, not a reviewer-executed live test.
- `npm audit --json` returned ENOLOCK; dependency vulnerability audit is incomplete, not PASS.
- No live write test was performed. Remote write semantics, notification behavior, member write permissions, and session expiry/rotation are not fully verified by this review.

## Gate result

Independent offline precommit and security gates: **no remaining identified blocker**. The Medium same-process concurrency finding is resolved. This result does not certify live writes or a completed dependency audit. Any source changes after this review require rechecking the affected paths before commit.

Reviewed final SHA-256:

- `src/tools.ts`: `BD0A88CD0F1231944E48943124B6C4D91B9A2A3CF192F2D8C4849C68CF0ABC59`
- `tests/private-calendar.test.mjs`: `717008EA36C5A127A40860A7B3D83171A25FFF3026B0B530498441A71F464053`
