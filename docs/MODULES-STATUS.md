# Modules: where the work stands

Status of the work planned in [MODULES-PLAN.md](MODULES-PLAN.md), kept here so it does not depend on any one working
session. Updated 2026-11-19, 18:49. Nothing below is merged into `main`; the owner merges.

**State: the work is done and waits for the owner.** Every preparation part, every module that was not deferred and
every follow-up has an open pull request, has had at least one complete Sol review, and has its findings fixed. On
the owner's instruction (2026-11-19 afternoon: wrap up so that testing can start; one review round per pull request, a
second or third only where something is badly broken; "acceptable for now", then iterate) the further checks that
were planned for reminders, timers, routines and the follow-ups were dropped, and no head got another review after its
last fix round. The reviewer's allowance also ran out that afternoon: the last three checks (P10's third round, in two
parts, and the lists follow-up's second) stopped early; what they had already reproduced was fixed or is written down
under "Known gaps kept on purpose".

**The whole, on one branch: `t3/modules-13-all`, pull request #130 (code as of `08b3c65c`; later commits on it are merges that change no code: this page, and branch heads that
moved by a test-only fix).** Every branch below merged
together, merges only, plus one commit of its own (a 20 second test limit for the `node` project on CI). On it:
`pnpm check` passes; `pnpm test`: 10,094 passed and one failed, a measurement (the music module's latency test
"resolving a room at the largest cache": 10.2 ms on the main thread against its 10 ms bound in the full run; alone it
passed three times out of three; the run before the last two merges had 10,085 passed, none failed); the browser
tests pass (218 cases). This is
the branch to try out. Putting the parts together found three faults, fixed on their own branches: the risk layer
withheld every refusal and failure sentence of a module with per-answer privacy (#115, corrected: a module's own
failure sentence goes back as it is, a crash stays withheld); reminders tagged an already reduced confirmation with
its owner (#114); a browser test did not know the new Risk policy page (#115).

**Two ways to merge.** Either #130 alone (it contains every commit of #87 to #129; the others can then be
closed), or the stack one by one in the order of the tables below.

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
| P10 presentation | #108 | `t3/modules-10-present` | `f83e6cae` | closed: two complete reviews (30, then 15 findings, all addressed) and a third check that stopped early (three reproduced faults fixed: a stale card's button could run its replacement's action; an update did not rebuild the maintenance jobs; a failed read forgot a held image). Since round 2: nothing a speculative turn asks for reaches a screen before the turn is promoted |
| P8 risk policy in admin | #115 | `t3/modules-08-risk` | `ca5dc31f` | closed: two reviews (7 findings and 2 notes, then 4), all fixed; a press and a phrase command are decided by the policy; then corrected after the parts were put together (a module's own failure sentence is no longer withheld) |

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
| local info (weather, bin day) | #100 | `t3/module-local-info` | `c85569af` |
| core tools | #101 | `t3/module-core-tools` | `58d41ab4` |
| lists | #102 | `t3/module-lists` | `5aea824e` |
| smart home (Home Assistant) | #103 | `t3/module-smart-home` | `ff54d2fe` |
| kitchen | #104 | `t3/module-kitchen` | `77e84d50` |
| calendar (ICS only) | #105 | `t3/module-calendar` | `d958d507` |

CI is green on all eleven at these heads. They carry the whole scaffold (`5bfeca0d`); their heads moved with that merge (see each pull request).

**Integration branch**: `t3/modules-12-wave-a`, pull request #116 (`130dec1d`): the presentation branch (P10, final)
with the eleven module branches merged in, merges only. It is the base of the follow-up pull requests. Everything in
it is also in the branch with everything.

## Wave B: the modules that need P7 to P10

Each sits on the newest part it needs for now and moves on top of P8 at the end.

| Module | Pull request | Branch | Head | State |
|---|---|---|---|---|
| assistant controls | #109 | `t3/module-assistant-controls` | `634952dc` | closed (review found three test gaps and a doc note, fixed); CI green |
| notifications | #110 | `t3/module-notifications` | `062d8ce1` | closed: two reviews (10, then 4 findings), all fixed, CI green; the second review left out the hook's token handling, which the lead checked by hand, because the review provider refused that part |
| images and photos | #111 | `t3/module-images` | `4965a03d` | closed: two reviews (15, then 3 findings), all fixed, CI green |
| broadcast | #112 | `t3/module-broadcast` | `5e84f110` | closed: reviewed (8 findings and a note), fixed, adapted to P10's fix round |
| music | #113 | `t3/module-music` | `081edbdb` | closed: two reviews (16, then 4 findings), all fixed, CI green |
| reminders | #114 | `t3/module-reminders` | `d2a603b1` | closed: two reviews (22, then 9 findings), both fix rounds done; one fix after the parts were put together (a reduced confirmation carries no owner) |
| timers and alarms | #117 | `t3/module-timers` | `37e0f5ce` | closed: two reviews (14, then 13 findings), both fix rounds done (103 tests). Changing an alarm was cut (cancel and set again); one ring per timer or alarm at a time; Stop pressed in the same instant as a snooze can lose (stated on the page) |
| routines and automations | #129 | `t3/module-routines` | `f9b5a440` | closed: one review (8 findings and a note), fixed (62 tests). A routine is checked step by step and stops, with a true sentence, where a step is refused; a called action's answer is not read out; "cancel the routine" stops one; at most 15 routines |

## The follow-ups: phrase commands and what is shown on a screen

One small pull request per first-wave module on `t3/modules-12-wave-a`, each reviewed once and fixed. Where a list or
card comes from a tool that may run before its turn is committed, it is returned with the answer and is a snapshot of
it (shown when the turn is promoted, never updated or withdrawn later).

| Module | Pull request | Head | What it adds, and what was cut |
|---|---|---|---|
| briefing | #118 | `72d67c78` | phrase command; 6 findings and a note fixed |
| memory and notes | #119 | `f9bcc8d3` | the Remembered card with Undo; recall and notes lists as snapshots; 5 findings fixed |
| kitchen | #120 | `c0bd38f5` | "we're out of …" phrase and a plain list of what the answer named; the kept, ticked checklist was cut (8 findings) |
| presence | #121 | `cdc7da9a` | "who is home" phrase; a list only for one person or the reduced answer; 5 findings fixed |
| lists | #122 | `ff94007b` | phrases; one pinned checklist per device, kept as one saved state; 7 findings fixed, then 3 from a second check that stopped early |
| calendar | #123 | `934740f4` | agenda list and next-appointment card; 7 findings fixed |
| web search | #124 | `cf200315` | the sources of a search as a list; 4 findings fixed |
| smart home | #125 | `91847978` | four room-less phrases and "what is on here"; phrases with a room name and lists that follow device state were cut (11 findings) |
| core tools | #126 | `748f6205` | knowledge card and status list; two reviews (the first stopped early), all fixed |
| news | #127 | `02ee167a` | news phrase and a headline list; 6 findings fixed |
| local info | #128 | `fb5b8d3d` | weather card; the bin-day reminder the evening before; 8 findings fixed |

## What is left

Nothing of this piece of work, except what only the owner can do:

1. Try it out on `t3/modules-13-all` (#130) and merge, in one of the two ways above.
2. Deferred, with a plan of their own ([MODULES-DEFERRED-PLAN.md](MODULES-DEFERRED-PLAN.md): sixteen pull requests in
   order, with eighteen decisions for the owner and a recommendation for each): google, t3-code, mcp-client, calls and
   intercom, CalDAV; connections and OAuth (the rest of P8); streaming and WebSocket to an owner-typed address.
3. One follow-up below the modules for the gaps listed further down, if the way modules and tool calls work stays as
   it is. The owner has said that this may be reworked after testing, so none of it was started.

## Known gaps kept on purpose

Found by the last checks and written down instead of fixed:

- **P10:** a presentation returned by a tool that ran speculatively is checked against the bounds when the tool
  answers, not again at promotion: if the module's eight places fill up in between, the model was told "Showing on …"
  and nothing is shown. While the image cache is not sure of its directory, a request is still fetched before it is
  refused.
- **Timers and alarms, reminders:** delivery is at least once (a ring that was already stopped can sound again after a
  crash between sending and recording); Stop pressed in the same instant as "five more minutes" or a snooze can lose.
- **Routines:** not all-or-nothing; the host's "stop" ends a routine only while it is speaking its own line.
- **No review after the last fix round** of: reminders, timers and alarms, routines, the lists follow-up, the web
  search follow-up (its list was rebuilt after its review), P8's correction, P10's third round. Each has its tests,
  `pnpm check` and the full run on the whole.

## Open points

- **Tests that depend on the CI machine's load.** The CI machine has two cores, and now and then a test that waits
  in real time or starts several test households fails there and passes on a rerun. Fixed where it was cheap: the
  presentation mock's tests (P10), the calendar privacy tests' limit, the bin-day test that looked at the Health page
  right after a job (on the local-info module branch and its follow-up), and a 20 second limit on CI in the branch
  with everything. Still
  seen once each: `ModuleHostP3Round5` "forty modules" (core, 5 s limit), the SQLite scheduler contract's
  daylight-saving test (30 s limit), the calendar privacy test "finding 22" (the kit gave up waiting for the module
  to stop), the bin-day reminder test "a copy too old to trust"; and in local full runs under load the SQLite
  `logStart` test ("database is locked"), the calendar latency test and one timers test ("the repeating series moves
  on although its ring is refused": the alarm's row was not there yet when the test looked; it passes alone 5 times
  out of 5). Four full local runs of the whole: none failed twice, two were clean, two had one such test each.

- **Not run against a real Home Assistant**: the smart-home module's templates (they use `regex_replace`, `unique`
  and `abs`) are only tested against the fake server.
- **Browser tests**: the existing 218 cases pass on the branch with everything. No new cases or screenshots were
  added for what P7, P9, P10, P8 and the modules put on the pages; the accounts of those parts list the cases.
- **Not run against real services**: Music Assistant, calendar feeds, the weather and bin-day sources and the search
  service are tested against fake servers only.
- **The ringing window** (P7) cannot tell a television or another device from a person saying "stop"; false stops
  were not measured.
- **A main-thread write right behind the store's checkpoint worker** waits about 24 ms on a desktop disk (a few
  hundred on an SD card), on a timer, without blocking the event loop (`docs/STORING-DATA.md` on the scaffold).
- **Music at its largest**: resolving a room name against the largest cache, cold, sits at the 10 ms bound: 10.23 ms
  once in a full local run with everything running beside it; under the bound 10 times out of 10 alone, and in the
  latency run the way CI does it (37 files, 420 tests, all pass on the branch with everything).
- **Smart home at its largest**: with 2,000 lights in a single room the first-wave module's own status read stops
  the main thread 8 to 15 ms and "lights off" 13 to 17 ms, over the 10 ms bound at that extreme (measured while
  reviewing its follow-up, whose own work is under 1 ms).
- **The order of P7 to P10 and the two waves** was the lead's decision, reported to the owner and not confirmed.

## Found by the wave B reviews, for one follow-up below the modules

- **Speculative tools.** A tool that may run before its turn is committed must not change a screen from inside its
  run (three follow-ups did). Fixed in P10's second round: a presentation returned with a tool's result is shown at
  promotion, and a direct show from inside an unpromoted turn is refused. What it costs: such a list or card is a
  snapshot (no handle, no update, no withdrawal).
- **Privacy labels and the risk layer (P8).** The gateway acts on a tool's own sensitivity answer: a result that the
  module already reduced must be labelled household, or it is withheld where its owner may not be revealed; a failure
  sentence of a tool with per-answer privacy is not withheld, so it must not carry personal content. Only reminders
  was checked for the first by a test; the other modules pass their tests on the whole, which is not proof.
- **A tool cannot attach a presentation without changing its result's shape** (five follow-up authors); **a
  presentation has one owner** (a list about several people cannot be shown safely: presence); **a phrase cannot
  carry a fixed value or take a parameter whose values the module supplies** (briefing, smart home); **a press
  carries no id**, and there is no handle for a presentation returned with a result (kitchen's kept, ticked
  checklist was cut for this).
- **For a module that runs steps in the background** (routines): asking whether a call would be refused without
  making it; a device's "stop" delivered to the module; a trace for a step that runs after its turn ended; whose
  content an action's answer is; the action catalogue outside a turn (to check a routine when it is saved).
- **Raising a Health issue from module code** (reminders, timers and alarms use a job that fails on purpose).
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
