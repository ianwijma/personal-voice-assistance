# Presenting: what a module shows on a device's screen

How a module shows something on the screen of a voice page: a card, a list (a checklist with ticks), a timer, an image
or the weather. This is the first version of docs/MODULES-PLAN.md §4 P10; what is left out is at the end. The contract
is `packages/core/src/Present.ts`, the engine (the Presenter) `PresentEngine.ts`, the one decision `decidePresentation`
and what a device shows of what applies to it, `selectPresentations`, in `packages/protocol/src/presentation.ts` (shared
with the web mock), the image cache `apps/assistant/src/serve/media.ts`. Every promise on this page has a case in
`@pva/core/present-contract` (run on the in-memory store and on SQLite, in memory and on a file), in the decision table
(`packages/protocol/test/presentation.test.ts`), in the kit's example (`packages/module-contracts/test/kit/presentExample.test.ts`),
in the serve tests (`apps/assistant/test/servePresentation.test.ts`, `media.test.ts`) or in the page's tests
(`apps/web/test/presentation.test.tsx`, `mockServer.test.ts`).

## In one paragraph

A tool or an action returns `{ forModel, present }`, or a module calls `ctx.present.show(target, presentation, options?)`.
Either way one row is stored in the core collection `core.present/presentations` and **showing is reconciliation**: one
function makes what each voice connection holds equal to what should be shown there now (the live rows, each decided
now by `decidePresentation` with `Privacy.mayReveal` asked for that device, and what the device shows of them), and it
is the only thing that sends `present.show`, `present.update` and `present.dismiss`. The model is told what the server
did ("Shown on "Kitchen display".", "Not shown: "Office speaker" has no display; say it instead."), never what the eye
saw. A tick or a button is admitted only from a page that holds the presentation and may press it there; it is claimed
and reaches the press handler the module registered in `shared`. An image is fetched once by the server and reaches a
page only as `/media/<hash>`.

## The two ways in

```ts
// 1. From a tool or an action: the model gets `forModel` and, after it, "[Screen: <what the server did>]".
return { forModel: { open: ["Bread", "Stamps"] }, present: { kind: "list", title: "Errands", items, spoken: "…", handler: "errands" }, show: { lifetime: "pinned", key: "errands" } }
// An action's outcome: { say, present, show }; the intent agent speaks `say`.

// 2. From module code (a tool, a job, a press handler, a part's fiber):
const handle = yield* ctx.present.show("origin" | { device } | { room }, presentation, { lifetime?, expiresInMs?, key? })
handle.outcome        // { devices: [{ deviceId, shown, why? }], note }
yield* handle.update(presentation)   // the same kind and sensitivity; undefined once it has ended
yield* handle.dismiss                // false once it has ended
ctx.present.handle(name, { run: (press) => Effect<{ say? } | void> })   // in shared: a registration of the part
```

- **Way 1** costs the turn one synchronous enqueue after the checks (the presentation is validated, the bounds are
  read from memory, the origin device is decided): the Presenter's writer stores it and reconciliation shows it, off the
  turn's path. A presentation that is not valid or passes a bound is not shown, and the note says why ("Not shown: the
  presentation was not valid (…)", "Not shown: too much is on screen (…)"); the turn never fails because of it. It is
  shown on the device the call came from (the turn's, the job's or the press's).
- **Way 2** is one synchronous transaction and an enqueue, and answers with a typed refusal (`PresentError`) at a bound.
- A tool of a hand-made registry, or in the CLI modes (no Presenter), still gives the model `forModel`, with the note
  that nothing can be shown here.

## The kinds and their bounds

Every text is storable text (no control character but tab, line feed, carriage return, backspace and form feed; no lone
surrogate); "one line" also refuses line and paragraph separators and bidirectional controls. Every presentation has a
required `spoken` (what the model says instead where nothing is shown, 1 to 300), an optional `sensitivity`
(`"household"`, the default, or `{ personal: <a Members id> }`), up to 3 `buttons` (`{ id, label }`, ids
`[a-z][a-z0-9_]{0,31}`, not `tick`, labels one line of 1 to 20) and a `handler` (required with buttons; a checklist's
ticks are pressable only with one). Anything outside these is refused `invalid` (way 2) or not shown with the note (way 1).

| Kind | Fields | Bounds |
|---|---|---|
| `card` | `title`, `text?`, `facts?: [{ label, value }]` | title one line ≤ 60; text ≤ 300 (line breaks kept); ≤ 6 facts, label one line ≤ 30, value one line ≤ 60 |
| `list` | `title`, `style?: "bullets" \| "checklist"`, `items: [{ id, text, done? }]` | title ≤ 60; ≤ 12 items, ids `[A-Za-z0-9_.:-]{1,40}` unique, text one line ≤ 80 |
| `timer` | `label`, `endsAt` (epoch ms, the server's clock) | label one line ≤ 40; `endsAt` from a minute ago to 24 hours ahead |
| `image` | `url`, `alt`, `credit`, `caption?` | `https:` only, printable ASCII ≤ 2,000; alt one line ≤ 200; credit one line ≤ 120, required; caption ≤ 200 |
| `weather` | `place`, `now: { temperature, condition, icon }`, `days?: [{ label, high, low, icon }]` | place ≤ 40; temperatures ≤ 12 (the module formats them: "12°"); condition ≤ 40; ≤ 5 days, labels ≤ 12; icons from a closed set (`sun`, `partly`, `cloud`, `rain`, `snow`, `storm`, `fog`, `wind`, `night`) |

| What | Bound | At the bound |
|---|---|---|
| live presentations in all | 32 (`MAX_LIVE_TOTAL`) | `limit` |
| live presentations of one module | 8 (`MAX_LIVE_PER_MODULE`), transient and pinned | `limit` |
| pinned presentations on one device | 8 (`MAX_PINNED_PER_DEVICE`): counted over the target's devices now | `limit` |
| transient presentations on one device | one at a time: a newer one ends the transient ones it would share a device with (of any module); they do not count against it | (they end) |
| a page | at most 9 (`MAX_PRESENTATIONS_PER_PAGE`: 8 pinned and 1 transient) | the selection never sends more |
| how long one stays | transient: 30 s by default, 3 s to 5 minutes; pinned: 4 hours by default, 3 s to 24 hours; a pinned timer without `expiresInMs`: until 10 minutes after it ends (at most 24 hours) | `invalid` past the bounds; it ends on time |
| a key | `[A-Za-z0-9_.:@/-]{1,64}`, one per module: showing it again replaces it in place (the same id, `present.update`) | `invalid` |
| a press handler's run | 5 s (`PRESENT_ACTION_TIMEOUT_MS`) | "That didn't work.", nothing changes |
| a handler's answer | `say` cut to 300 at the page boundary | cut |
| presses from pages | the hub's bounded admission (4 per connection, 16 in all, pending at once) | `busy`, "Too much at once; try again in a moment." in the household's language |
| an image | PNG, JPEG, GIF or WebP (never SVG), its type said and its bytes the same; ≤ 2 MiB | shown without the image (`failed`), the reason logged |
| images kept | 256 files and 64 MiB in `data/media`, each a day | `full` (what has expired goes first) |
| image fetches at once | 4 | `busy` |
| the note for the model | ≤ 400 | cut |

The collection's `maxChars` is 5,000: the worst legal row (a checklist of twelve items with every text at its bound in
the costliest characters, three buttons, a key, an owner, a room, the ended mark) fits it, so one read lists 5 rows.

## Lifetimes and ownership

- **Transient** (the default; a timer defaults to pinned): a device shows one at a time, the newest. It ends by itself.
- **Pinned**: several per device, each shown until it is dismissed or ends; a page that reconnects is given them again.
- **A presentation belongs to the module part that made it** (a tool's presentation to the module's newest open part).
  When that part's scope closes (its module stopped, after its calls in flight had their grace period) its **transient**
  presentations are removed from the store and taken down from every page. Its **pinned** ones are stored and stay until
  they are dismissed or end; a handle the stopped part had dies with `ModuleStopped`; the module, started again, replaces
  one by showing the same `key`. After a server restart pinned ones come back (transient ones are removed at start: no
  part survives a restart).
- **Ending**: the end removes the row (one fiber sleeps until the earliest end). Dismissing it, or a newer transient
  that takes its device, marks the row `ended` in the caller's transaction (an update, which starts no log checkpoint)
  and the service removes ended rows ten seconds later, off every caller's path; an ended row is never shown and is
  removed at start.

## The decision

`decidePresentation` is the one place that decides whether a device shows a presentation, and in what form; nothing else
does. It is a pure function of the kind, whether it is personal, `Privacy.mayReveal(owner, device)` asked at that moment
for that device, and the device (connected, has a display, the kinds it draws, has touch or a pointer). In order:

| | Result |
|---|---|
| the device is not connected | `offline` |
| personal, and the privacy rule says no for this device | `private` |
| no display (none declared, or "Treat as no display") | `no-display` |
| the page does not draw this kind at this version, or the owner excluded it | `cannot-show-kind` |
| otherwise | shown; its ticks and buttons pressable where the device has touch or a pointer |

A device's outputs come from one place, `devicePresentFrom`: what its page declared (`present.kinds`), minus the owner's
overrides ("Treat as no display", the excluded kinds; its own, else its type's). **A page that never declared any kind
(every page before this version) is shown nothing**, and it needs nothing: it ignores the new messages. Of what applies
to a device (its target is the device, or a room it is in now), `selectPresentations` keeps the pinned ones the decision
allows, oldest first, at most 8, and the newest transient the decision allows.

## Reconciliation

- **The only sender.** `reconcile(device)` makes every voice connection of the device hold exactly what should be shown
  there now: in one synchronous step it takes what applies from the in-memory index of live presentations, decides each,
  selects, reads each chosen row with the store's synchronous reader, and sends what a connection lacks (`present.show`),
  holds in another form (`present.update`) or holds and may not any more (`present.dismiss`), withdrawals first. The
  bookkeeping is **per connection**: a withdrawal reaches every page that holds it.
- **No stale sends.** Nothing is sent from a row or a decision obtained before a wait: the step reads and decides what it
  sends. Passes run one at a time in one fiber, a device per step, yielding between devices.
- **Triggers**: a show, an update, a dismiss, an end, a part that stops, a page saying hello (once its record exists) or
  closing, a changed declaration, every settings commit (rooms, places, privacy, overrides: every device is decided
  again; a change of privacy or an override also ends the device's session, so its pages say hello again). A pass that
  fails (a store read) is repeated by the next trigger, or a minute later.
- **Privacy is asked at the moment of showing**, for the device that would show it, at every pass: personal content no
  longer allowed on a device is withdrawn from its pages, not just not sent again.

## Presses

- **Admission** (synchronous, against this moment): the connection holds the presentation, it is live, the decision lets
  it be pressed there (`interactive`), and the press is a tick of an item a checklist has (with `done`) or a button it
  has. Knowing an id is not enough; another device's page gets "I can't do that right now."
- **The claim**: one press at a time per presentation, in memory, before any module code runs; a second gets "That is
  being handled already." (A restart forgets the claim with the run.)
- **The handler** the module registered with `ctx.present.handle(name, …)` **in `shared`** (a registration of the part:
  published and withdrawn with the module) runs as a call in flight of the part, with the press's principal
  (`CurrentPrincipal` `presentation`: the presentation and the device and connection it was pressed on), admitted by the
  execution gateway first (serve mode checks that the connection is the device's), within 5 s. While it is not
  published (the module is stopped, failed or restarting), the press answers "I can't do that right now." and changes
  nothing. It answers `{ say? }` (default "Done."); the press itself changes nothing on the page: the handler shows the
  change (`update`, or the same key again), which reconciliation sends.
- The page sends `present.action` `{ id, action: "tick", item, done }` or `{ id, action: <button id> }`; it goes
  through the hub's bounded admission like every other request.

## Images

`/media/<hash>` is the only way an image reaches a page. When an image presentation is stored, the Presenter asks the
image cache, off the turn's path, to fetch its address; the row first says `loading`, then holds the content hash, or why
not (`failed`: shown without the image, with the server's sentence). The cache fetches once through `safeFetch` (public
addresses only, redirects checked again; never the owner-configured helper, for anything a model or a page supplies) with
its own image policy, checks the type the response says and the bytes it is against each other, and its size, keeps it
as `data/media/<sha256>.<ext>` (directory `0700`, files `0600`, written through a temporary file and one `rename`) for a
day within 256 files and 64 MiB, remembers the address it came from for that day (the same address is not fetched
again; the same bytes from two addresses are one file), and shares one fetch between every asker of an address under
way. The cache **survives a restart**: the directory is read back at start, and what has expired or is not one of its
files is removed. It serves `GET /media/<hash>` only while some open voice connection holds that image (a hash a page
was never told, or no page holds any more, is 404), with `Content-Type` of the kept type, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and a private cache time for the rest of its
day. No resizing.

## The voice page

- **One stage layout on every character**: a column centred under the character's box, just above the controls, that
  grows upward only as far as it may without covering the box (at least 160 px on a short screen) and scrolls within
  itself beyond that; it slides with the stage while the desktop chat is open. The character's box, its canvas and its
  `focus` are as before (docs/CHARACTERS.md §2.7); the stage only adds its height to the bottom padding of the page's
  scroll area, so captions scroll clear of it.
- P9's **notification cards are drawn first in the stage**, with their wire messages and behaviour unchanged; then the
  presentations, a transient one first, then the pinned ones oldest first.
- One renderer per kind. Every text of a presentation passed the server's page boundary (`ModuleHost.pageText`) and is
  put on the page as text, never as markup; long text wraps. **Every word the host shows** (the region's name, "Loading
  the image…", "The image is not available.", the timer's "Done", "Image:", "High", "Low", and every answer to a press)
  **comes from the server in the household's language** (`PresentationWire.texts`, English and Dutch).
- **A countdown** runs on the page from the server's instant: each message carries the server's clock (`serverNow`), and
  the page keeps the difference to its own clock when the message arrived, so a page whose clock is off counts down to
  the server's instant.
- The page keeps every presentation it is sent (the server never sends more than 9) and empties them at every welcome
  and when its session ends (the server sends what applies again after the hello).
- **Protocol**: additive within version 11. The decoder answers `Unknown` for a message a page does not know, so an older
  page ignores the new messages, and the server sends it none (it declares no kinds) and needs nothing from it. No closed
  set the decoder checks gains a member: the kinds live inside the new messages, and `present.kinds` was always an open
  record. So the version stays 11.
- The web mock shows presentations with the same pure functions (`decidePresentation`, `selectPresentations`,
  `devicePresentFrom`), per connection, again after a hello; a tick from a holder updates every page (the mock acts as
  the module); its own words follow the saved household language (`POST /mock/present`, `/mock/present/dismiss`).

## Testing

`startTestModule` runs the real Presenter on the kit's store, test clock and gateway (`kit.present`): `shown(device)`
(what that device's page holds now), `messages` (what each page was sent), `decisions` (every decision: which device,
and why not), `press(id, action, { device, item?, done? })` (as that device's page; the clock is driven while the
handler runs), and `engine` (`live`, `held`, `expireNow`). `kit.notify.connect` / `disconnect` reconcile it too (a page
says hello, or goes). A kit device without `capabilities` declares this build's voice page on a tablet
(`KIT_PAGE_CAPABILITIES`: a display with touch, every kind, a speaker, a microphone), so it is decided as serve mode
decides for this build's page; give `capabilities` to model a speaker or an older page. `StartTestModuleOptions.media`
gives the kit a fake image cache (default none: an image is shown without it, as serve mode shows one it could not fetch).
**Where the kit differs from serve mode**: one page per connected device (two tabs are tested in the contract suite), no
owner overrides, and the `Devices` service a module reads still says "nothing declared" for a device the test gave no
capabilities.

## Latency

Measured on the development machine by `packages/store-sqlite/test/presentLatency.test.ts` (the latency step; asserted
with the shared `bound()`), on SQLite on a file at the stated maximum: 31 other presentations live, every text at its
bound with the costliest characters (the worst legal checklist), 8 pinned on the turn's device, 64 devices with a page
each, every message encoded as the hub encodes a frame, through the host's real page boundary.

| What | Number |
|---|---|
| end of turn → first audio (`TurnTrace`, the real `Conversation`, a tool round through the host's registry and gateway, zero-delay synthesis and output, the model's tokens 5 ms after each request; median of 80 turns × 4 counterbalanced runs) | without a presentation 10.68 ms (p95 11.76); with the worst legal presentation in the tool's result 11.08 ms (p95 11.88) |
| `show` as a tool calls it (200 calls, a transient replacing the last) | median 0.45 ms, p95 0.51 ms, worst 0.73 ms |
| a page saying hello with 9 presentations | longest main-thread stop 0.71 ms |
| reconciling every device (64) | longest main-thread stop 0.95 ms |

So a tool's presentation at the stated maximum moved the turn's first audio by a median 0.4 ms, not zero: the turn
itself pays the validation, the decision and the note (way 1), and the writer and the reconciliation of the turn's device
(the transaction, nine rows read and their messages built and encoded) run on the same thread while the model thinks.
The test asserts the difference stays under 2 ms; every turn's presentation reached the turn's page (100 frames a run).

## Not now

`facts` as its own kind, `table`, `gallery`, `progress`, `confirm`, `handoff`, the built-in `show` and `show_on` tools,
`present.status` (a page's report of a failed load, and the next turn's context), the reveal rule tied to clauses,
resizing images (`sharp`), a reduced form of personal content on a shared screen, a presentation on "wherever this is
already shown", moving or shrinking the character's box, and a close button on the page.
