# Verification: Inbox tabs share one event connection

What changed: every Inbox tab of one browser origin shares ONE event stream
(`packages/inbox/sharedEvents.ts`). A Web Locks leader holds the EventSource
and passes each frame on over a BroadcastChannel; followers only listen. See
"One event stream per browser" in CLAUDE.md.

All runs: macOS, the compiled binary built from this branch
(`.local/plannotator`), scratch data dirs under the OS temp dir (never `/tmp`,
never `~/.plannotator`), `PLANNOTATOR_INBOX_CONNECT=0`, `NO_BROWSER`,
headless browsers, notifications fully stubbed (no OS notification), the sound
counted (never played). "Streams" is the server's own count of open event
streams (`event_streams` on `/api/inbox/health`), less the test's reference
stream.

How a tab is checked: each tab logs the records it handled
(`window.__plannotatorInboxEventLog`). The ground truth is a reference stream
the test holds from the start. "Exact" means the tab handled exactly the
reference's lines after its subscribe cursor, once each, in order.

## Browser proofs (Playwright, real tabs in one browser context)

| Case | Browser | Result |
| --- | --- | --- |
| 1 tab | Chromium | 1 stream, exact, notify_reach windows 1 |
| 3 tabs | Chromium, WebKit | 1 stream, every tab exact, windows 3 |
| 8 tabs | Chromium, WebKit | 1 stream, every tab exact, windows 8 |
| 12 tabs | Chromium | 1 stream, every tab exact, windows 12; tab loads 440-495 ms each |
| Old build (origin/main), 7th tab | Chromium | 6 tabs load (~460 ms); the 7th does not load in 8 s; closing one tab lets it load in 534 ms: the six-connection limit |
| New build, 9th tab with 8 open | Chromium / WebKit | loads in 467 ms / under 3 s, 1 stream |
| Leader closes while an agent writes (~48 messages) | Chromium, WebKit | another tab leads 1 ms after (Chromium); under 1 s (WebKit); every tab exact; 1 stream |
| Leader reloads while an agent writes | Chromium, WebKit | another leads in 8 ms; every tab (the reloaded one from its new cursor) exact; 1 stream |
| Leader crashes (`Page.crash`, no unload) while an agent writes | Chromium | another leads in 2 ms; every tab exact; 1 stream |
| Leader frozen (`freeze`, main thread held, `resume`) while an agent writes | Chromium | another leads in 217 ms; the frozen tab catches up on resume; every tab exact; 1 stream |
| Notifications, 4 tabs all in the background | Chromium | 1 notice and 1 ring in total |
| A follower in front, the leader in the background | Chromium | 1 notice, raised by the front tab; 0 rings |
| A question in the thread the front tab has open | Chromium | 0 notices, 0 rings |
| notify_reach: follower closes / crashes / leader closes / tab opens | Chromium | 4→3 in 1 ms, 3→2 in 27 ms (crash: the leader saw its lock freed), 2→1 in 1 ms, held at 1 for 17 s (past the grace), 1→2 in 26 ms |
| notify_reach: follower closes, leader closes | WebKit | each step within the timeout (see results-webkit.json) |
| Inbox restart (stopped, started on the same port) | Chromium | 1 stream again 1.2 s after start; windows 4; every tab exact |
| Two origins (`localhost` and `inbox-second.localhost`, standing in for the tailnet address) | Chromium | 2 streams, one leader per origin, every tab exact |
| No Web Locks (removed by an init script) | Chromium, WebKit | each tab its own stream (3 streams for 3 tabs), as before |
| Soak: 5 minutes, tabs opening, closing, reloading and crashing at random (87 opens, 51 closes, 48 reloads, 34 crashes) while an agent wrote 5,577 messages | Chromium | streams never above 1 in 231 samples; every surviving tab exact; every leaving tab in order and never twice |
| Page errors | both | none |

## Unit and server tests

| Test | Result |
| --- | --- |
| `packages/inbox/sharedEvents.test.ts` (fakes for Web Locks, BroadcastChannel, the server's stream): 1/3/12 tabs, cursor skip, served_by, all frame kinds, leader close/crash during writes, follower gone (crash and close), freeze/resume, back/forward cache, a sleeping follower behind a new leader, a late subscriber, a failed catch-up retried at the next hello, junk messages, unsubscribe, 40 seeded random lives of up to 12 tabs | 17 pass |
| `packages/server/inbox-shared-windows.test.ts`: served_by, gone, the grace through a handover, event_streams, once=1 | 4 pass |
| `packages/server/inbox*.test.ts` | all pass (the door's health key list gained `event_streams`) |
| `packages/inbox` DOM tests (`DOM_TESTS=1 --isolate`), which run the fallback path (happy-dom has no Web Locks) | 552 pass |
| Typecheck (`bun run typecheck`) | clean |

## Not verified

- A real Chrome freeze (Energy Saver). Headless pages are always visible, so
  `Page.setWebLifecycleState` does nothing; the proof plays the same sequence
  (`freeze`, the main thread held, `resume`).
- A leader that hangs (a busy loop) without freezing: the others get nothing
  until it recovers or closes.
- Firefox, and Safari itself (WebKit through Playwright only).
- The tailnet address itself (another origin, stood in for by a second
  loopback name).
- Mixed tabs of an older and a newer Inbox build on one origin (an older tab
  keeps its own stream; not run).
