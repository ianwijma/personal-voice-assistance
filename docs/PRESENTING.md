# Presenting: what a module shows on a device's screen

How a module shows something on the screen of a voice page: a card, a list (a checklist with ticks), a timer, an image
or the weather. This is the first version of docs/MODULES-PLAN.md §4 P10, after its first review round; what is left out
is at the end. The contract is `packages/core/src/Present.ts`, the engine (the Presenter) `PresentEngine.ts`, the one
decision `decidePresentation`, what a device shows of what applies to it (`selectPresentations`), the module-facing
checks (`presentationProblem`, `showOptionsProblem`) and lifetimes (`presentLifetime`) in
`packages/protocol/src/presentation.ts` (shared with the web mock), the image cache `apps/assistant/src/serve/media.ts`.
Every promise on this page has a case in `@pva/core/present-contract` (run on the in-memory store and on SQLite, in
memory and on a file), in the decision table (`packages/protocol/test/presentation.test.ts`), in the kit's examples
(`packages/module-contracts/test/kit/presentExample.test.ts`), in the serve tests
(`apps/assistant/test/servePresentation.test.ts`, `media.test.ts`) or in the page's tests
(`apps/web/test/presentation.test.tsx`, `mockServer.test.ts`).

## In one paragraph

A tool or an action returns `{ forModel, present }`, or a module calls `ctx.present.show(target, presentation, options?)`.
Either way one row is stored in the core collection `core.present/presentations`. **What is shown is decided from the
current state at once**: an in-memory index of the live presentations is the truth of what is eligible, and a
presentation that ends, is dismissed or replaced, or whose module part stopped leaves it at that moment; removing its
row from the store follows, and is repeated until it succeeds. **Showing is reconciliation**: one function makes what
each voice connection holds equal to what it should hold now (each presentation decided now by `decidePresentation`,
with `Privacy.mayReveal` asked for that device and the kinds that connection's own page draws), withdrawing first, and
it is the only thing that sends `present.show`, `present.update` and `present.dismiss`. The model is told what the
server decided ("Showing on "Kitchen display".", "Not showing it: "Office speaker" has no display. Say this instead: …"),
never what the eye saw. A tick or a button is admitted only from a page that holds the presentation and may press it
there; it is claimed and reaches the press handler the module registered in `shared`. An image reaches a page only as an
address of that page's own, `/media/<token>`.

## The two ways in

```ts
// 1. From a tool or an action: the model gets `forModel` and, after it, "[Screen: <what the server decided>]".
return { forModel: { open: ["Bread", "Stamps"] }, present: { kind: "list", title: "Errands", items, spoken: "…", handler: "errands" }, show: { lifetime: "pinned", key: "errands" } }
// An action's outcome: { say, present, show }; the intent agent speaks `say`. A phrase command's trace says `presented`.

// 2. From module code (a tool, a job, a press handler, a part's fiber):
const handle = yield* ctx.present.show("origin" | { device } | { room }, presentation, { lifetime?, expiresInMs?, key? })
handle.outcome        // { devices: [{ deviceId, shown, why? }], note }
yield* handle.update(presentation)   // the same kind and sensitivity; undefined once it ended or was replaced
yield* handle.dismiss                // false once it ended or was replaced
ctx.present.handle(name, { run: (press) => Effect<{ say? } | void> })   // in shared: a registration of the part
```

- **Way 1** costs the turn one enqueue after the checks (the presentation is validated, the bounds are read from memory,
  the origin device is decided): it is **accepted** then, and the Presenter's writer stores it and reconciliation shows
  it, off the turn's path. An accepted presentation is written, or dropped only because it no longer applies (it ended,
  or its module stopped): a write the store refuses is tried again (100, 400 and 1,600 ms, then every minute by
  maintenance) with the Health issue "A presentation could not be shown yet" meanwhile. A presentation that is not
  valid, passes a bound, comes from a module that cannot show things, arrives while the stored presentations are still
  being read, or has no device to show it on is not accepted, and the note says why; the turn never fails because of it.
  It is shown on the device the call came from (the turn's, the job's or the press's).
- **Speculative turns** (R8, review round 2): nothing a speculative turn asks for reaches a screen before the turn is
  promoted. A tool that may run speculatively returns its presentation with its result and never calls
  `ctx.present.show` or dismisses in its run. Way 1 from a turn that is not committed yet is checked and its note
  composed as above, but it is accepted only when the turn is promoted (its times and key's id taken then) and dropped
  without reaching a screen when the turn is discarded. Way 2 from inside such a turn changes nothing: `show` is refused
  `uncommitted` ("not shown: the turn is not committed yet"), `update` answers `undefined` and `dismiss` `false`. A call
  from a committed turn, a job, a press or a route is not affected (`CurrentTurnCommit`, which `Conversation` provides
  for a turn's calls and the gateway clears for a call made as another principal).
- **Way 2** is one synchronous transaction and an enqueue, and answers with a typed refusal (`PresentError`): `invalid`,
  `limit`, `busy` (the store was busy, or the stored presentations are still being read at start), `unavailable`,
  `uncommitted` (called from inside a turn that is not committed yet). Its
  times (when it was shown, when it ends) and the checks that depend on the clock (a timer's `endsAt`) are taken in the
  attempt of the transaction that commits; a show that waited on a busy store for longer than it would have been shown
  is refused `busy` rather than committed already ended (review round 2). An `update` likewise judges the end and the
  timer with the clock of its committing attempt.
- A tool of a hand-made registry, or in the CLI modes (no Presenter), still gives the model `forModel`, with the note
  `Not shown: nothing can be shown here; say it instead.`

### The note for the model, exactly

| What the server decided | Note |
|---|---|
| every device of the target shows it | `Showing on "A".` (`"A" and "B"`, `"A", "B" and "C"`) |
| some do | `Showing on "A"; not on "B" (has no display).` |
| none does | `Not showing it: "A" has no display.` |
| not accepted (way 1) | `Not showing it: <why>.` (`the presentation was not valid (…)`, `too much is on screen (…)`, `this module cannot show things (…)`, `the screen's data is still being read`, `there is no device to show it on`, `this tool belongs to no module`) |
| and when the asking device does not show it for a reason other than privacy (no display, a kind its page cannot draw, offline, or not accepted for a bound, a stopping module or the start-up read), and the privacy rule allows the content on the asking device | ` Say this instead: <the presentation's spoken text>` (at most 300 characters, through the module's page boundary) |
| and while its image is still to be fetched, when it is shown somewhere | ` Its image is being fetched; if that fails it shows without it.` |

The reasons are: `is not connected`, `may not show this person's things`, `has no display`, `cannot show this kind of
thing`. After a privacy refusal the note carries nothing of the content. **Privacy comes first** (review round 2): one
check decides, on every path, whether the spoken text may go into a note: household content always; personal content
only when the asking device is known and `Privacy.mayReveal(owner, device)` says yes now. An offline asking device, a
refusal for a bound, a stopping module or the start-up read never forward personal content the asking device could not
be shown; no device, an invalid presentation or a tool of no module never forward anything. Device names are quoted and cut
(`quotedName`). The whole note is at most 600 characters (`MAX_NOTE_CHARS`): the device part is cut first.

## The kinds and their bounds

Every text is storable text (no control character but tab, line feed, carriage return, backspace and form feed; no lone
surrogate); "one line" also refuses line and paragraph separators and bidirectional controls. Every presentation has a
required `spoken` (what the model says instead where nothing is shown, 1 to 300), an optional `sensitivity`
(`"household"`, the default, or `{ personal: <a Members id> }`), up to 3 `buttons` (`{ id, label }`, ids
`[a-z][a-z0-9_]{0,31}`, not `tick`, labels one line of 1 to 20) and a `handler` (required with buttons; a checklist's
ticks are pressable only with one). Anything outside these is refused `invalid` (way 2) or not accepted, with the note
(way 1). The web mock runs the same checks.

| Kind | Fields | Bounds |
|---|---|---|
| `card` | `title`, `text?`, `facts?: [{ label, value }]` | title one line ≤ 60; text ≤ 300 (line breaks kept); ≤ 6 facts, label one line ≤ 30, value one line ≤ 60 |
| `list` | `title`, `style?: "bullets" \| "checklist"`, `items: [{ id, text, done? }]` | title ≤ 60; ≤ 12 items, ids `[A-Za-z0-9_.:-]{1,40}` unique, text one line ≤ 80 |
| `timer` | `label`, `endsAt` (epoch ms, the server's clock) | label one line ≤ 40; `endsAt` from a minute ago to 24 hours ahead |
| `image` | `url`, `alt`, `credit`, `caption?` | `https:` only, printable ASCII ≤ 2,000; alt one line ≤ 200; credit one line ≤ 120, required; caption ≤ 200 |
| `weather` | `place`, `now: { temperature, condition, icon }`, `days?: [{ label, high, low, icon }]` | place ≤ 40; temperatures ≤ 12 (the module formats them: "12°"); condition ≤ 40; ≤ 5 days, labels ≤ 12; icons from a closed set (`sun`, `partly`, `cloud`, `rain`, `snow`, `storm`, `fog`, `wind`, `night`) |

| What | Bound | At the bound |
|---|---|---|
| live presentations in all | 32 (`MAX_LIVE_TOTAL`), accepted ones not written yet included | `limit` |
| live presentations of one module | 8 (`MAX_LIVE_PER_MODULE`), transient and pinned, accepted ones included | `limit` |
| pinned presentations on one device | 8 (`MAX_PINNED_PER_DEVICE`): counted over the target's devices now | `limit` |
| transient presentations on one device | one at a time: a newer one ends the transient ones it would share a device with (of any module); those, written or accepted, do not count against it | (they end) |
| a key | `[A-Za-z0-9_.:@/-]{1,64}`, one per module, **one stable id** across accepted and written shows: showing it again replaces it in place (the same id, `present.update`); two accepted shows of one key count once | `invalid` |
| a page | at most 9 (`MAX_PRESENTATIONS_PER_PAGE`: 8 pinned and 1 transient) | the selection never sends more |
| how long one stays | transient: 30 s by default, 3 s to 5 minutes; pinned: 4 hours by default, 3 s to 24 hours; a pinned timer without `expiresInMs`: until 10 minutes after it ends (at most 24 hours) | `invalid` past the bounds; it ends on time |
| a press handler's run | 5 s (`PRESENT_ACTION_TIMEOUT_MS`) | "That didn't work." (what the handler committed before stays) |
| a handler's answer | `say` cut to 300 at the page boundary | cut |
| presses from pages | the hub's bounded admission (4 per connection, 16 in all, pending at once) | `busy`, "Too much at once; try again in a moment." in the household's language |
| an image | PNG, JPEG, GIF or WebP (never SVG), its type said and its bytes the same; ≤ 2 MiB | shown without the image (`failed`), the reason logged |
| images kept | 256 files and 64 MiB in `data/media` (files whose removal failed counted until they are gone), each a day | `full` (what has expired goes first) |
| image fetches at once | 4 | `busy` |
| image addresses remembered (not fetched again) | 1,024, in memory, this run | the oldest forgotten |
| the note for the model | ≤ 600 | the device part cut |

The collection's `maxChars` is 5,000: the worst legal row (a checklist of twelve items with every text at its bound in
the costliest characters, three buttons, a key, an owner, a room, a show id, the ended mark) fits it, so one read lists 5
rows.

## Lifetimes, ownership and what happens when

- **Transient** (the default; a timer defaults to pinned): a device shows one at a time, the newest. It ends by itself.
- **Pinned**: several per device, each shown until it is dismissed or ends; a page that reconnects is given them again.
- **A presentation belongs to the module part that made it** (a tool's presentation to the module's newest open part).
  When that part's scope closes (its module stopped, after its calls in flight had their grace period) its **transient**
  presentations leave the index at once and are taken down from every page; accepted ones of that part not written yet
  are dropped. Its **pinned** ones are stored and stay until they are dismissed or end; a handle the stopped part had
  dies with `ModuleStopped`; the module, started again, replaces one by showing the same `key`. After a server restart
  pinned ones come back (transient and ended rows are removed at start: no part survives a restart).
- **Each show has its own id** (`showId`): a handle acts only on the show it was given for. A key shown again is another
  show, so an earlier handle's `update` answers `undefined` and its `dismiss` `false`, and change nothing.
- **Leaving the index at once** (review round 1): an end, a dismissal, a replacement by a newer transient and a stopped
  part take the presentation out of the in-memory index at that moment and reconcile its holders, **whether or not the
  store can be written then**. Removing the row is separate work: a dismissal or a replacement first marks the row
  `ended` in the caller's transaction where it can (an update, which starts no log checkpoint on a turn's path), and the
  row is removed ten seconds later by maintenance; a row that has ended is removed by the run at its end. A removal that
  fails is repeated a minute later until it succeeds. An ended row is never shown and is removed at start. (A dismissed
  row whose `ended` mark and removal both failed before a crash comes back at the restart: durable state is the row.)
- **Maintenance** uses the notification service's pattern: one one-shot scheduler job `core.present/due`, planned by
  `plan()` for the next thing due (the earliest end of a live presentation, a removal, failed work to repeat a minute
  from its failure: a pass, an accepted write, an image's outcome, the start-up read; none when nothing is due), planned
  again after every change, at the end of every run and at start; and `core.present/hourly` (cron `0 * * * *` in UTC),
  the safety net that runs the same work. A failure keeps the retry time it was given: planning again for other changes
  never moves it later. The hourly job, if it could not be scheduled, is scheduled again with every change (a show, a
  plan, a page's hello or a reconciliation), not only by maintenance. The Presenter has no timer of its own. So ends
  happen on time, and work that failed is done at most a minute after its failure, or an hour later after a lost plan.
- **Accepted work a newer show replaces is retired** (review round 2): an accepted tool result not yet written is dropped
  when a newer show of the same key is accepted or committed, and, for a transient, when a newer transient on one of its
  devices is; it is never written after the newer one, and what waits is checked again against the current show of its
  id in the attempt that writes it.
- **Start-up reads everything**: the whole collection, a page (5 rows) at a time with a yield between, the rows to remove
  noted as it goes. Until it has read to the end nothing is shown or withdrawn, a show is refused `busy` and a tool's
  presentation is not accepted (the note says so); a read that fails is tried again a minute later (Health:
  "Presentations could not be read").

## The decision

`decidePresentation` is the one place that decides whether a device shows a presentation, and in what form; nothing else
does. It is a pure function of the kind, whether it is personal, `Privacy.mayReveal(owner, device)` asked at that moment
for that device, and the device (connected, has a display, the kinds the page draws, has touch or a pointer). In order:

| | Result |
|---|---|
| the device is not connected | `offline` |
| personal, and the privacy rule says no for this device | `private` |
| no display (none declared, or "Treat as no display") | `no-display` |
| the page does not draw this kind at this version, or the owner excluded it | `cannot-show-kind` |
| otherwise | shown; its ticks and buttons pressable where the device has touch or a pointer |

A device's outputs come from one place, `devicePresentFrom`: its display as declared, minus the owner's overrides ("Treat
as no display", the excluded kinds; its own, else its type's), and **the kinds of the page that is to show it**: what is
sent to a connection is decided with that connection's own declared kinds (its hello, then each `device.caps`), never the
device's latest declaration (review round 1, G11). A page that never declared any kind (every page before this version)
is sent no presentation message, also beside a newer tab of the same device. For the note, a device draws a kind when
one of its open pages does. Of what applies to a device (its target is the device, or a room it is in now),
`selectPresentations` keeps, per connection, the pinned ones the decision allows, oldest first, at most 8, and the newest
transient the decision allows.

## Reconciliation

- **The only sender.** `reconcile(device)` makes every voice connection of the device hold exactly what it should hold
  now, in one synchronous step. **It withdraws first** (review round 1, G2): from the index and the decision alone, with
  no store read, it sends `present.dismiss` for everything a connection holds and may not hold now; what a connection
  holds is judged as the show it holds (its show id, owner and kind are remembered with it), so when a key is shown again
  the content held is kept until the new content is read only while that held content itself is still allowed there
  (review round 2). Only then does it read
  the content of what stays or is added, item by item: what a connection lacks (`present.show`) or holds at another
  revision, form or language (`present.update`). A failed read affects that item only, and the device's pass is repeated
  by the next trigger or a minute later. The bookkeeping is **per connection**: a withdrawal reaches every page that holds
  it, and a page's image addresses are revoked with it.
- **No stale sends.** Nothing is sent from a row or a decision obtained before a wait. Passes run one at a time in one
  fiber, a device per step, yielding between devices.
- **Triggers**: a show, an update, a dismiss, an end, a part that stops, an image's outcome, a page saying hello (once its
  record exists), a page's `device.caps` or closing, every settings commit (rooms, places, privacy, overrides, the
  household's language: every device is decided again; a change of privacy or an override also ends the device's
  session, so its pages say hello again).
- **Privacy is asked at the moment of showing**, for the device that would show it, at every pass: personal content no
  longer allowed on a device is withdrawn from its pages, not just not sent again, also when a read of another item fails.

## Presses

- **What a press is**: the module's registered handler, run with the press's principal (`CurrentPrincipal`
  `presentation`: the presentation, and the device and connection it was pressed on), after three checks: the
  connection holds the presentation, the decision still lets it be pressed there (`interactive`), and the press is
  claimed. **It is not a tool call**: it has no risk class and no trace of its own, and the assistant's module and tool
  switches do not apply to it (it is admitted by the gateway's principal check, as a notification's action is; serve mode
  checks that the connection is the device's). Whatever the handler calls through the gateway (a tool, an action) is
  checked there as always, risk policy included.
- **Admission** (synchronous, against this moment): the connection holds the presentation, it is live, the decision lets
  it be pressed there, and the press is a tick of an item a checklist has (with `done`) or a button it has. Knowing an id
  is not enough; another device's page gets "I can't do that right now."
- **The claim**: one press at a time per presentation, in memory, before any module code runs; a second gets "That is
  being handled already." (A restart forgets the claim with the run.)
- **The handler** the module registered with `ctx.present.handle(name, …)` **in `shared`** (a registration of the part:
  published and withdrawn with the module) runs as a call in flight of the part, within 5 s. While it is not published
  (the module is stopped, failed or restarting), the press answers "I can't do that right now." and nothing runs. It
  answers `{ say? }` (default "Done."); a handler that fails or runs out of time answers "That didn't work.", and what it
  committed before that stays (there is no rollback of a handler's own effects). The press itself changes nothing on the
  page: the handler shows the change (`update`, or the same key again), which reconciliation sends. A handler may send a
  notification to `"origin"`: the device it was pressed on.
- The page sends `present.action` `{ id, action: "tick", item, done }` or `{ id, action: <button id> }`; it goes
  through the hub's bounded admission like every other request.

## Images

- **An image's address belongs to one page** (review round 1, G9). A page is never given a content hash. For each image
  it may show, each connection is given an unguessable address of its own, `/media/<token>` (24 random bytes, base64url,
  made by the server for that connection and that presentation's image). It is served only while that connection is open
  and holds a presentation with that image; when the connection closes or the presentation is withdrawn from it, the
  address stops working. Any other request is 404. Two tabs of one device get two addresses.
- **Fetched once a page is to show it.** When reconciliation is about to send an image presentation to a page and its
  image is not there yet, the Presenter asks the image cache to fetch it, off the turn's path; nothing is fetched while no
  device of its target would show it. The row says `loading` until the outcome is written (the content hash, or why
  not: shown without the image, with the server's sentence); an outcome whose write fails is written again a minute
  later; an image left loading by a restart is fetched again when a page is to show it. None stays loading. A fetch
  belongs to its address: a key shown again with the same address while it is fetched gets that fetch's outcome; a
  key shown again with another address fetches its own, and an outcome not yet written for an older address does not
  hold it back (review round 2).
- **The cache** fetches through `safeFetch` (public addresses only, redirects checked again; never the owner-configured
  helper, for anything a model or a page supplies) with its own image policy, checks the type the response says and the
  bytes it is against each other, and its size, keeps it as `data/media/<sha256>.<ext>` (directory `0700`, files `0600`,
  written through a temporary file and one `rename`) for a day within 256 files and 64 MiB. What it promises, exactly:
  an address is not fetched again while it is in this run's bounded in-memory index of addresses (1,024; not kept across
  a restart); the same bytes from two addresses are one file; one fetch is shared by every asker of an address under way;
  what has expired is dealt with before new bytes are matched against it (an expired copy is a new admission); a file is
  never served after its day, and is removed by the next hourly sweep or before a write that needs its room.
- **The directory is the truth** (review round 2, R6). An **inventory** reads the directory as it is, removes temporary
  files (an interrupted write), foreign files and what is past its age, then, oldest first, what is over the bounds, and
  rebuilds the counts and bytes from what is really there. It runs at start, and after any fault every minute (and before
  the next admission) until it succeeds. **Any file operation of the cache that fails** (a write, setting its time, the
  rename, a removal, reading an entry or the directory, reading a file to serve it) makes the cache **not sure**: nothing
  new is admitted (a fetch is refused `unavailable`, so the image shows without its picture) and Health says "The image
  cache could not be read or cleaned", until an inventory has read every entry, removed what it had to and what remains
  is inside 256 files and 64 MiB. An unreadable entry is never taken as absent. There is no list of files to remove
  later: a file is removed by an inventory that sees it expired at that moment, so a copy admitted since is never
  removed by an old retry. While it is not sure, an image already kept is still served if its file can be read. The
  files **survive a restart**: what the inventory at start keeps is served for the rest of its day.
- **The response headers**, exactly: `Content-Type` (the kept type), `Content-Length`, `X-Content-Type-Options:
  nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline; filename="image.<ext>"`,
  `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`. A 404
  is `text/plain` with `nosniff` and `no-store`. No resizing.

## The voice page

- **One stage layout on every character**: a column centred under the character's box, just above the controls, that
  grows upward only as far as it may without covering the box (at least 160 px on a short screen) and scrolls within
  itself beyond that; it slides with the stage while the desktop chat is open. The character's box, its canvas and its
  `focus` are as before (docs/CHARACTERS.md §2.7); the stage only adds its height to the bottom padding of the page's
  scroll area, so captions scroll clear of it.
- P9's **notification cards are drawn first in the stage**, with their wire messages and behaviour unchanged; then the
  presentations, a transient one first, then the pinned ones oldest first.
- One renderer per kind. Every text of a presentation passed the server's page boundary (`ModuleHost.pageText`) and is
  put on the page as text, never as markup; long text, button labels and weather values wrap. **Every word the host
  shows** (the region's name, "Loading the image…", "The image is not available.", the timer's "Done", "Image:", "High",
  "Low", and every answer to a press) **comes from the server in the household's language** (`PresentationWire.texts`,
  English and Dutch).
- **A page without its server shows nothing from it** (review round 1, G10): when the connection is lost the page clears
  its presentations (the notification cards follow their own rule from P9); after the next welcome the server sends what
  applies now. It also empties them at every welcome and when its session ends, and keeps every presentation it is sent
  (the server never sends more than 9).
- **A countdown** runs on the page's monotonic clock: the page notes `performance.now()` when the message arrived and
  counts from the server's clock in it (`serverNow`), taken again at every update; a jump of the page's wall clock
  neither ends nor freezes it.
- **An image the browser cannot load** (a 404 after the address was revoked, a decoding failure) shows the server's
  sentence for a missing image, with its caption and credit.
- **Protocol**: additive within version 11. The decoder answers `Unknown` for a message a page does not know, so an older
  page ignores the new messages, and the server sends it none (it declares no kinds) and needs nothing from it. No closed
  set the decoder checks gains a member: the kinds live inside the new messages, and `present.kinds` was always an open
  record. So the version stays 11. (`ImageState.ready` carries the page's `token`, never a hash.)
- **The web mock** shows presentations with the same pure functions and checks (`presentationProblem`,
  `showOptionsProblem`, `presentLifetime`, `decidePresentation` with each tab's own kinds, `selectPresentations`,
  `devicePresentFrom`): `POST /mock/present` takes what a module passes to `show` and refuses before it changes
  anything; a presentation ends at its end; every saved settings change reconciles every page; images show the mock's
  built-in picture through `/media/<token>`, with the server's rule and headers; a tick from a holder updates every page
  (the mock acts as the module). Review round 2 (R7): the whole request (its fields, an explicit `id` matching the
  protocol's id, a known `deviceId`, the presentation, the options and the page message it would make) is checked before
  any id is consumed or anything changes, so a refused request leaves what pages hold and the capacity as they were;
  admission uses the server's own bounds (`MAX_LIVE_PER_MODULE`, `MAX_LIVE_TOTAL`, `MAX_PINNED_PER_DEVICE`, from
  `@pva/protocol`; the mock counts as one module; the transients a new one ends do not count), given back by a dismissal
  or an end. **What the mock does not model it refuses with a 400 and a sentence**, rather than doing it differently:
  personal content ("the mock shows household presentations only (it has no privacy model): …"; it has no privacy
  model) and `options.key` ("the mock does not replace by key: …"; it has no keyed replacement). Both were refused
  because refusing is smaller than implementing them through the shared functions; test those against the kit
  (`startTestModule`), which runs the real Presenter.

## Testing

`startTestModule` runs the real Presenter on the kit's store, scheduler, test clock and gateway (`kit.present`):
`shown(device)` (what that device's page holds now), `messages` (what each page was sent), `decisions` (every decision:
which device, and why not), `press(id, action, { device, item?, done? })` (as that device's page; the clock is driven
while the handler runs), and `engine` (`live`, `held`, `maintainNow`, `planNow`, `plannedAt`, `loaded`).
`kit.notify.connect` / `disconnect` reconcile it too; a page that disconnects shows nothing, as the real page. A kit
device without `capabilities` declares this build's voice page on a tablet (`KIT_PAGE_CAPABILITIES`: a display with
touch, every kind, a speaker, a microphone), so it is decided as serve mode decides for this build's page; give
`capabilities` to model a speaker or an older page. `StartTestModuleOptions.media` gives the kit a fake image cache
(default none: an image is shown without it, as serve mode shows one it could not fetch). **Where the kit differs from
serve mode**: one page per connected device (two tabs and per-tab kinds are tested in the contract suite), no owner
overrides, and the `Devices` service a module reads still says "nothing declared" for a device the test gave no
capabilities.

## Latency

Measured on the development machine by `packages/store-sqlite/test/presentLatency.test.ts` (the latency step; asserted
with the shared `bound()`), on SQLite on a file at the stated maximum: every text at its bound with the costliest
characters (the worst legal checklist), every message encoded as the hub encodes a frame, through the host's real page
boundary.

| What | Number |
|---|---|
| end of turn → first audio (`TurnTrace`, the real `Conversation`, a tool round through the host's registry and gateway, zero-delay synthesis and output, the model's tokens 5 ms after each request; median of 80 turns × 4 counterbalanced runs; 31 other presentations live, 8 pinned on the turn's device) | without a presentation 10.82 ms (p95 11.24); with the worst legal presentation in the tool's result 11.07 ms (p95 11.88) |
| `show` as a tool calls it (200 calls, a transient replacing the last) | median 0.48 ms, p95 0.63 ms, worst 0.86 ms; longest main-thread stop across the whole workload 1.99 ms |
| a page saying hello with 9 presentations | longest main-thread stop 1.01 ms |
| reconciling every device with real fan-out (64 devices in one room, 8 pinned and 1 transient room-wide, 64 fresh pages: 576 frames, 1.99 MiB encoded) | longest main-thread stop 1.50 ms |

So a tool's presentation at the stated maximum moved the turn's first audio by a median 0.25 ms, not zero: the turn
itself pays the validation, the decision and the note (way 1), and the writer and the reconciliation of the turn's device
run on the same thread while the model thinks. The test asserts the difference stays under 2 ms and the longest stops
under 10 ms.

## Not now

`facts` as its own kind, `table`, `gallery`, `progress`, `confirm`, `handoff`, the built-in `show` and `show_on` tools,
`present.status` (a page's report of a failed load, and the next turn's context), the reveal rule tied to clauses,
resizing images (`sharp`), a reduced form of personal content on a shared screen, a presentation on "wherever this is
already shown", moving or shrinking the character's box, a close button on the page, a risk class and a trace for a
press handler (the gateway has no call kind for registered handlers yet), and keeping the image cache's address index
across a restart.
