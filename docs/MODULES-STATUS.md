# Modules: where the work stands

Status of the work planned in [MODULES-PLAN.md](MODULES-PLAN.md), kept here so it does not depend on any one working
session. Updated 2026-11-19, 15:20. Nothing below is merged into `main`; the owner merges.

## The stack

Each pull request is based on the one above it in this table. "Closed" means its review rounds are done and its
findings fixed; it does not mean merged.

| Part | Pull request | Branch | Head | State |
|---|---|---|---|---|
| Plan and this page | #87 | `t3/modules-00-plan` | (this branch) | kept up to date |
| P1 module API, gateway | #89 | `t3/modules-01-module-api` | `83a71d0` | closed |
| P2 language and network helpers | #88 | `t3/modules-02-helpers` | `0bdb2af` | closed |
| P3 settings fields, module routes | #90 | `t3/modules-03-forms-routes` | `4cbcfe1` | closed |
| P4 household store, event bus | #91 | `t3/modules-04-store-bus` | `282ebb9` | closed |
| P5 people, rooms, devices | #93 | `t3/modules-05-people-rooms` | `3e19fba` | closed |
| P6 scheduler | #92 | `t3/modules-06-scheduler` | `c842653` | closed |
| P11 scaffold, contracts, test kit, guide | #94 | `t3/modules-11-scaffold` | `5bfeca0d` | closed; CI green |
| P9 notifications, speech, ringing | #106 | `t3/modules-09-notify` | `a7fccff9` | closed after three review rounds; carries the scaffold's last store fix |
| P7 phrase commands, essential controls | #107 | `t3/modules-07-phrases` | `3ce75007` | closed after two review rounds (24, then 8 findings, all fixed); CI was green at `86ab9161`; the head adds a merge of P9 and one test fix (a wall-clock limit that failed on a loaded CI machine) |
| P10 presentation | #108 | `t3/modules-10-present` | `d6f7034d` | first review found 30 problems, fixed (CI green at this head); the two deciding reviews found 8 and 7 more; a second, small fix round is running, with one added rule: nothing a speculative turn asks for reaches a screen before the turn is promoted |
| P8 risk policy in admin | #115 | `t3/modules-08-risk` | `2b0ce0c5` | first review found 7 problems and 2 notes; the fix round is running; it has merged the base (the head holds the risk policy with the phrase commands and the presentation layer, pushed early so the routines module could start) |

**Fixes to P1 to P6 code found later live on the scaffold branch**, not on their own branches: the worker-thread
helper `offThread`; POST and typed loopback in `@pva/net`; the gateway no longer timing its own risk lookup (an
ordinary tool call could be refused under load); the device registry's write gap counted from the end of the previous
write; the SQLite store starting a new write-ahead log on its checkpoint worker and converting a backup's journal on a
worker (both were disk syncs on the main thread); latency tests running in their own serial step, on a real disk; and
about a dozen tests that assumed an order or a timing the code never promised.

## Wave A: the eleven modules that need only P1 to P6

All closed (one thorough review and one fix round each; smart home and calendar had a second, deciding round). Each is
its own pull request on the scaffold.

| Module | Pull request | Branch | Head |
|---|---|---|---|
| briefing | #95 | `t3/module-briefing` | `eeab82d4` |
| presence and people | #96 | `t3/module-presence` | `db4a3346` |
| memory and notes | #97 | `t3/module-memory` | `b3b827c8` |
| web search | #98 | `t3/module-web-search` | `cacdd17c` |
| news and feeds | #99 | `t3/module-news` | `eceee3b5` |
| local info (weather, bin day) | #100 | `t3/module-local-info` | `72507efb` |
| core tools | #101 | `t3/module-core-tools` | `58d41ab4` |
| lists | #102 | `t3/module-lists` | `5aea824e` |
| smart home (Home Assistant) | #103 | `t3/module-smart-home` | `ff54d2fe` |
| kitchen | #104 | `t3/module-kitchen` | `77e84d50` |
| calendar (ICS only) | #105 | `t3/module-calendar` | `159b08b8` |

CI is green on all eleven at these heads. They carry the whole scaffold (`5bfeca0d`); their heads moved with that merge (see each pull request).

**Integration branch**: `t3/modules-12-wave-a`, pull request #116 (`33ea5b77`): the presentation branch (P10, after its
fix round) with the eleven module branches merged in, merges only, no conflict. `pnpm check` passes; the full local
test run had 9,143 passing and one failing (the calendar latency test could not read its store in the parallel run; it
passes alone, three times out of three). It is the base for the follow-up pull requests below. P8 is merged into it
when it closes, and it is then retargeted to the top of the stack.

## Wave B: the modules that need P7 to P10

Each sits on the newest part it needs for now and moves on top of P8 at the end.

| Module | Pull request | Branch | Head | State |
|---|---|---|---|---|
| assistant controls | #109 | `t3/module-assistant-controls` | `634952dc` | closed (review found three test gaps and a doc note, fixed); CI green |
| notifications | #110 | `t3/module-notifications` | `062d8ce1` | closed: two reviews (10, then 4 findings), all fixed, CI green; the second review left out the hook's token handling, which the lead checked by hand, because the review provider refused that part |
| images and photos | #111 | `t3/module-images` | `4965a03d` | closed pending CI: two reviews (15, then 3 findings), all fixed |
| broadcast | #112 | `t3/module-broadcast` | `5e84f110` | closed: reviewed (8 findings and a note), fixed, adapted to P10's fix round |
| music | #113 | `t3/module-music` | `081edbdb` | closed pending CI: two reviews (16, then 4 findings), all fixed |
| reminders | #114 | `t3/module-reminders` | `f27f18af` | reviewed (22 findings); fix round running (one state and one job per reminder); a deciding review follows |
| timers and alarms | #117 | `t3/module-timers` | `cc2788e3` | reviewed (14 findings), rebuilt around one state and one job per timer and alarm; deciding review running |
| routines and automations | none yet | `t3/module-routines` | | being built on `t3/modules-08-risk` |

## What is left, in order

1. P10 (#108): review, fix, merge P7 into it, make P7 its base.
2. P8, first version (the risk policy as a household setting in admin): finish the build, review, fix.
3. A browser-test run with new cases and fresh screenshots at the top of the stack (the last one on the whole stack was at P6; the existing 218 cases pass on P9).
4. Wave B, one pull request per module (table above): finish the review and fix rounds, build timers and routines,
   move every one on top of P8, CI green.
5. The phrase commands and presentations wave A left out: one small pull request per module on
   `t3/modules-12-wave-a` (#116), branches `t3/follow-<module>`, each reviewed and fixed. Started 2026-11-19 on the
   fixed P10: lists, kitchen, smart home, calendar, memory and local info are being built; presence, briefing, news,
   web search and core tools start as those report.
   State: ten of the eleven have a pull request (briefing #118, memory #119, kitchen #120, presence #121, lists
   #122, calendar #123, web search #124, smart home #125, core tools #126, news #127); local info is being built.
   Reviewed so far, each with a fix round running: briefing (6 findings), memory (5), presence (5), web search (4),
   kitchen (8; cut down to the phrase and a plain list). The others are in review.
6. Deferred, with a plan of their own ([MODULES-DEFERRED-PLAN.md](MODULES-DEFERRED-PLAN.md): sixteen pull requests in order, with eighteen decisions for the owner and a recommendation for each): google, t3-code, mcp-client, calls and intercom, CalDAV; connections and
   OAuth (the rest of P8); streaming and WebSocket to an owner-typed address.

## Open points

- **Not run against a real Home Assistant**: the smart-home module's templates (they use `regex_replace`, `unique`
  and `abs`) are only tested against the fake server.
- **Playwright** was run last at the top of P6 (218 of 218). P9 and P7 changed the voice page and have not had a
  browser run or screenshots; their accounts list the cases to add.
- **The ringing window** (P7) cannot tell a television or another device from a person saying "stop"; false stops
  were not measured.
- **A main-thread write right behind the store's checkpoint worker** waits about 24 ms on a desktop disk (a few
  hundred on an SD card), on a timer, without blocking the event loop (`docs/STORING-DATA.md` on the scaffold).
- **The order of P7 to P10 and the two waves** was the lead's decision, reported to the owner and not confirmed.

## Found by the wave B reviews, for one follow-up below the modules

- **Speculative tools.** A tool that may run before its turn is committed must not change a screen from inside its
  run (three follow-ups did). Being fixed in P10's second round: a presentation returned with a tool's result is
  shown at promotion, and a direct show from inside an unpromoted turn does nothing.
- **A tool cannot attach a presentation without changing its result's shape** (five follow-up authors); **a
  presentation has one owner** (a list about several people cannot be shown safely: presence); **a phrase cannot
  carry a fixed value or take a parameter whose values the module supplies** (briefing, smart home); **a press
  carries no id**, and there is no handle for a presentation returned with a result (kitchen's kept, ticked
  checklist was cut for this).
- **Repeated calls.** The gateway hands a tool or an action no per-call id (the model's tool-call id stops at the
  registry), so a module cannot tell a replay from a second deliberate call in one turn. Decided for now: a phrase
  command heard once acts once; the assistant's own calls always run ("skip two songs" as two calls skips twice).

- **Send once.** The notification service forgets a notification's key when it is resolved, so a module cannot make a
  delivery exactly once across a crash between sending and recording. Reminders, timers and alarms therefore deliver
  at least once (a ring that was already stopped can sound again after such a crash; none is lost), and say so.
- **Stop against a press in flight.** A notification's action handler is not told that its notification was ended
  before its outcome was recorded, so "five more minutes" pressed in the same instant as Stop can win.
- `ctx.present.dismiss({ key })` for a module's own presentation after a restart; a bound per kind or per device
  instead of eight live presentations per module (a ninth timer has no countdown).
- The test kit has no fault option for the store or the notification service, and no way to run a module's latency
  test on the SQLite store.
- Music wants `music_assistant.search` on the smart-home allow-list (a real name-only lookup, naming the match) and a
  fresh read of one entity in the Home Assistant contract (a relative `Playback.changeVolume`).

## Gaps reported below the modules

Things module authors and reviewers found missing or awkward in the shared code, collected for one follow-up on the
scaffold. As recorded, not yet triaged:

# Gaps below the modules, reported by wave A authors (for one scaffold/core follow-up)

- lists: the core refuses an unknown value of a dynamic action parameter with its own English sentence before the module runs (`Actions.ts`), even in a Dutch household. Smallest fix: an optional sentence on a dynamic parameter for a value it does not know, or a flag that passes the unmatched text through to the action.
- memory: the test kit has no handle for a module's context provider (tests build the registry from `host.snapshot().assistantParts`).
- memory, core-tools: `health()` gets only `{ settings, running }`; it cannot read the module's store or the host view.
- web-search: a tool cannot be marked speculative per call.
- core-tools: `HostView` does not carry internet reachability, disk, load or health issues for `system_status`.
- presence (fixed in scaffold 67c3f9c): module packages lacked `@pva/language`.
- briefing: `BriefingSection` contract should say that the briefing keeps a section's personal content only when its owner is the asking person.
- presence: `health()` gets only the settings, not `People`; the module lends the check a membership function from its running shared part, so Health cannot name broken links while the module is stopped. Smallest change: pass a membership check to `health()`.
- presence: a `records` item cannot hold a `combo`, so a member is linked by typing an id copied from an info line instead of picking from a list.
- smart-home, mcp-client, calendar (CalDAV): `@pva/net` has no POST, streaming or WebSocket to an address the owner typed.
- web-search, news, calendar, core-tools (spell check): slow synchronous parsers; answered by the off-thread helper added to the scaffold.
- calendar: the kit's `advance`/`runJob` do not wait for a job handler that does real I/O in several steps (tests poll in real time). Smallest change: `advance` waits until the engine has no running job, with a real-time cap.
- calendar: row ids are unique across scopes within a collection, contradicting `docs/STORING-DATA.md` ("a row of the same id in another scope is invisible"). Smallest change: correct the sentence, or make ids per scope.
- calendar: `AmbientContext` carries no Home values (zone, language).
- calendar: calendars on the home network cannot be read (`safeFetch` refuses private addresses; `fetchOwnerConfiguredLan` is the lead's call).
- briefing: an action cannot give its generated tool a result different from its spoken `say` (`Gateway.runForTool` returns `outcome.say`), so outside text cannot be marked untrusted there; the module switched its generated tool off. Smallest change: `ActionOutcome.forModel`.
- briefing: an action's result loses its sensitivity data (`host.actions.run` reduces it to `{ ok, say }`), so a per-result sensitivity has only the text to go on. P8's sensitivity check should receive the action's own outcome.
- briefing: `Setting.textList` has no `check`, so a bad entry can only be refused by failing the start.
- core-tools: a version 1 module's context has no host view, so it cannot read the household's language; the clock was declared API v2 to get it. `HostModuleView` gives only free text for why a module is unavailable (unsafe to pass on): a short reason code would let `system_status` name the cause.
- lists (confirmed by Sol): `Actions.ts:279` throws its English refusal for an unknown dynamic parameter value before module code runs.
- web-search: `@pva/net` has no per-hop hook, and with `maxRedirects: 0` a redirect is refused without exposing its `Location`, so a module cannot follow redirects itself. Smallest change: an `onHop(url)` option, or the `Location` on the refusal.
- web-search, briefing: `Setting.textList` has no `check` option (the `records` kind has one).
- offThread (seen by web-search): a rare 6-8 ms pause on the main thread near the end of a heavy worker run; unexplained (the fixer's guess: the worker giving memory back in the same process).
- lists (fix round): because an unknown choice value is refused by the core in English before the module runs (Actions.ts:279), each list also appears as a "my …" choice (value `<id>~mine`) and those names show up in the core's English "Valid names" sentence. Goes away when the core lets a module word (or handle) an unknown choice.
- local-info (fix round): a settings button (the Test button) gets only the module's settings, not Home (time zone, language), so it reads dates in the machine's zone.
- kitchen (fix round): `@pva/language` does not read an article as a count: "een ui" / "an onion" are not understood as 1, while "1 ui" and "one egg" work.
- news (fix round): the kit's in-memory store sorts the whole collection on every list (limits what a latency test can say about big caches; serve mode reads SQLite by index). Also again: kit `runJob`/`advance` return before a job that is still parsing has finished; a module's `health()` cannot read the store.
- product follow-up (from the CI flaky diagnosis, reports/ci-flaky.md): `silentUnless` in apps/assistant/src/serve/VoiceSession.ts ends reply audio with `Stream.takeWhile` (a normal end), so when a device's speaker is taken away while the voice still streams, the server can send `reply.end` just before `reply.stop`. The page still stops; the order contradicts the P5 round-3 comment and no test covers it. Fix idea: end in an interruption instead of a normal end.
- @pva/net POST (known limit, from the fix round): a body far over `maxRequestBytes` is still serialised in full on the main thread before it is refused (a size-counting serialiser made legal bodies 15x slower). Callers must bound what they put in a body.
- test follow-up (reports/ci-flaky.md): serveHousehold's burst test hardly ever exercises "changes during its snapshot" (the study page's feed starts after the writes); the account suggests how to cover it on purpose.
- smart-home (fix round): an action's generated tool returns only the spoken sentence, so outside text in it (room and device names) cannot be marked as outside content; `@pva/net` gives no status for an answer too large to read; `@pva/net`'s time limit runs on the wall clock, not the test kit's clock.
- calendar (fix round): in the kit, a job's time limit runs on test-clock time while an offThread worker runs in real time (tests must step the clock and wait). The kit's in-memory store reads every row on each list (5-14 ms at 5,800 rows), so write/prune latency can only be measured on SQLite.

## Where the working notes are

Outside the repository, on the build machine, under `/workspace/build-cache/ian/pva-review/`: `briefs/` (every build,
review and fix brief), `reports/` (every review report and fix account; `reports/modules/_status.md` is the running
log this page was written from), `pr-bodies/` (descriptions waiting to be posted) and `probes/` (the reviewers'
reproductions). Scratch worktrees are under `/workspace/build-cache/ian/pva-fix/` (preparation stack) and
`/workspace/build-cache/ian/pva-mod/` (one per module). That directory is a cache: this page and the pull requests are
the durable record.
