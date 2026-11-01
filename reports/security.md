# Independent security review — private calendar and local Google session

Reviewed 2026-11-01 against baseline `6cb82c6`. Scope: current changes in `src/index.ts`, `src/timetree.ts`, `src/tools.ts`, `src/types.ts`, `.env.example`, `.gitignore`, README, and the new import helper/tests. The reviewer read the complete concrete `security-reviewer.md` and `adversarial-reviewer.md` instructions and independently inspected source/diff and ran the checks below. No source was changed by this review.

## Findings and disposition

No reproducible Critical, High, Medium, or Low security vulnerability was established in the reviewed offline paths. A Medium same-process lost-update correctness finding was reproduced, fixed by the implementer, and independently reverified as resolved; details are in `precommit-review.md`.

The independent offline security and precommit review gates have no remaining identified blocker. This is a bounded code/offline review, not proof of live TimeTree writes or a completed dependency audit.

## Independently executed checks

- `npm run typecheck` and `npm run build`: exit 0, repeated after the concurrency fix.
- `node --test tests/private-calendar.test.mjs`: 19 tests passed after the fix. These exercise local session precedence, rejected cookie separators/control characters, safe auth errors, fixed private endpoint, CSRF, read-before-update, unknown-field/attachment retention, traversal/cross-calendar rejection, paging, dates, same-event serialization, failure release, different-event concurrency, and actual local stdio tool discovery.
- `tests/session-import.test.ps1`: mock-only import verified other env fields remain unchanged, no secret echo, clipboard clearing, malformed input rejection, and duplicate-key rejection. It did not access the real clipboard or real `.env`.
- Additional independent mock probes rejected null/array input, empty title, negative/overflow label IDs, non-HTTP URLs, unknown timezone, calendar override, and invalid/unsafe calendar IDs before network calls. Separately injected 403 and AbortError produced safe tool failures with exactly one write attempt and no echoed response marker.
- Post-fix independent queue probe verified three same-UUID updates preserve all field changes in strict GET/PUT order; a later call after queue drain succeeds; GET, PUT, and body-validation failures release queued and later calls; different UUIDs can read concurrently. The reviewer executed these independently written probes from intermediate files outside the repository.
- Source review: only four MCP tools are exposed. Tools cannot supply calendar ID, hostname, arbitrary filesystem paths, or HTTP headers. Private requests use fixed HTTPS TimeTree origins and validated numeric ID / UUID path components. Missing CSRF blocks private POST/PUT. The private write path does not automatically retry writes after errors.
- Source review: helper reads only explicitly copied clipboard content, validates it, refuses a nonignored `.env`, writes locally, verifies the stored value, and clears clipboard in `finally`. It does not read browser databases or perform login.
- `git check-ignore` confirms `.env`, `.env.local`, `dist`, and `node_modules` are ignored while `.env.example` remains eligible. `git ls-files` contains no local credential file. Filename-only secret-pattern scan of publishable source/helper/tests found only mock/import implementation references; no actual values were printed or inspected.
- `npm pack --dry-run --json`: package file listing did not contain `.env`, cookie files, or node_modules. This was a dry run; no package was published. GitHub publication must still use the reviewed tracked/candidate files rather than force-adding ignored files.
- `git diff --check`: exit 0 after the final code change.

## Separate main-task live evidence

The main task reported successful live stdio MCP handshake, calendar discovery, and reading the configured private calendar; it reported zero write calls. The independent reviewer did not reproduce that live run, inspect its credentials, or read private event contents. This evidence is attributed to the main task and is not represented as an independently executed reviewer test.

## Unverified / incomplete

- `npm audit --json`: exit 1, `ENOLOCK`. Dependency vulnerability audit is NOT complete because this repository has no lockfile; no clean-audit claim is made. No dependency versions were changed by the implementation or reviewer.
- Reviewer did not read real `.env` or private event contents, use a real session, perform real authentication, or create/update a live event.
- Actual service behavior for session rotation, permission denial, expired credentials, live CSRF parsing, and writes remains outside this independent execution. Mock failures establish local handling only.
- Another process or calendar member can still edit between GET and PUT. The local per-UUID queue protects updates routed through the same server tool registry; it does not provide a remote revision lock. README explicitly records this limit.

## Reviewed final code fingerprints (SHA-256)

- `src/tools.ts`: `BD0A88CD0F1231944E48943124B6C4D91B9A2A3CF192F2D8C4849C68CF0ABC59`
- `tests/private-calendar.test.mjs`: `717008EA36C5A127A40860A7B3D83171A25FFF3026B0B530498441A71F464053`

Any further source change requires review of the affected paths before commit.
