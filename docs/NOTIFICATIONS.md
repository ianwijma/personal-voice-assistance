# Notifications, speech outside a reply, ringing

How a module tells the house something nobody on that device just asked for: a **notification** (a card on the voice
page, ringing until someone stops it when its priority is `ring`) and an **announcement** (one spoken line on a device,
a room's devices or everywhere, after whatever is being said there). This is the first version of docs/MODULES-PLAN.md
§4 P9 (after its first review round); what is left out is at the end. The contract is `packages/core/src/Notify.ts`, the
engine `NotifyEngine.ts`, the one delivery decision `decideDelivery` in `packages/protocol/src/notifications.ts` (shared
with the web mock). Every promise on this page has a case in `@pva/core/notify-contract` (run on the in-memory store and
on SQLite, in memory and on a file), in the decision table (`packages/core/test/NotifyDecision.test.ts`), in the kit's
tests (`packages/core/test/notify/NotifyKit.test.ts`), in the serve tests (`apps/assistant/test/serveNotifications*.test.ts`)
or in the page's tests (`apps/web/test/notifications.test.tsx`, `mockServer.test.ts`).

## In one paragraph

`ctx.notify.send({ title, text?, priority?, owner?, target?, key?, expiresInMs?, actions?, handler? })` stores one row in
the core collection `core.notify/notifications` in one synchronous transaction and hands it to delivery. **Delivery is
reconciliation**: one function makes what each voice connection holds equal to what the open rows and the one decision
(`decideDelivery`) allow now, and it is the only thing that sends a card or takes one down. A press of a card's button is
admitted only from a page that holds the card; `stop` (the host's) resolves it; another action is claimed on the row and
runs the handler its module registered in `shared` with `ctx.notify.handle`. `ctx.speech.say(target, text)` queues one
announcement on each device of the target, played after the reply being spoken there, with the reply's own voice and
audio path. Do not disturb, for the house, keeps every ring silent and every announcement unsaid. The service owns **one
job**, repeating every minute: expiry, the end of do not disturb, stale claims, retention and a reconciliation of every
device.

## The calls

```ts
ctx.notify.send(request): Effect<{ notification, deduped }, NotifyError>
ctx.notify.resolve(id | { key }, outcome? = "resolved"): Effect<boolean, NotifyError>   // false: none such of this module, or it had ended
ctx.notify.list({ after?, limit? }?): Effect<Notification[], NotifyError>              // this module's open ones, oldest first, ≤ 12 a page
ctx.notify.handle(name, { run(press) => Effect<{ say?, keepOpen? } | void> }): Effect<void, NotifyError>   // in shared
ctx.notify.dnd.get / .set({ until? }?) / .clear: Effect<DndState, NotifyError>           // { on, until? }
ctx.speech.say(target, text, { cue?, owner? }?): Effect<SpeechHandle, SpeechError>
SpeechTarget = { device } | { room } | "everywhere"
SpeechHandle = { id, deliveries: [{ deviceId, queued, why? }], done: Effect<[{ deviceId, outcome, why? }], SpeechError>, stop: Effect<void> }
```

- **Sent now, never later.** `send` delivers at once; there is no `at` or `inMs` (an unknown field is refused). A module
  that wants a notification at a later time schedules a job of its own and sends from its handler:

  ```ts
  yield* ctx.scheduler.handle("boiled", { payload: Schema.Struct({}), run: () => Effect.asVoid(ctx.notify.send({ title: "The kettle has boiled", priority: "ring" })) })
  yield* ctx.scheduler.schedule({ handler: "boiled", key: "kettle", inMs: 3 * 60_000 })   // from a tool: the job keeps the turn's device as its origin
  ```

  A job scheduled inside a press handler does not take the press's device by itself (the scheduler takes a turn's or a
  job's origin): pass `origin: { deviceId: press.deviceId }` (docs/MODULES.md's kettle does).
- **Target**: `origin` (the default: the device of the turn, the job or the press the call runs for) or `everywhere`
  (every known device). A call with no origin device (code in `shared`, a job made for nobody) that asks for `origin` is
  refused `invalid`.
- **Priority**: `normal` (a silent card) or `ring` (the card and the page's ring cue, until it is resolved). Nothing may
  send above `ring`: any other priority is refused `invalid`.
- **Owner**: a Members id makes it personal content; the privacy rule decides per device, at each reconciliation.
- **Dedupe key**: one open notification per module and key. Sending the same key while one is open answers that one with
  `deduped: true`; nothing is stored or delivered. Once it is resolved the key is free.
- **Expiry**: it is resolved as `expired` `expiresInMs` after it was sent (default: a ring 15 minutes, a normal one a
  day; at most a ring 2 hours, a normal one 7 days; at least 1 s), by the maintenance job: **up to a minute late**.
- **Resolve**: by id or key, only the module's own; its cards go from every page that held them. `stop`, `expired` and
  `withdrawn` are the host's outcomes and cannot be claimed.
- **List**: the module's open notifications, oldest first, a page of at most 12; continue with `after`, a notification
  that `list` itself returned (a view from `send` is not a cursor).
- **Do not disturb**: for the house, on until cleared, or until `until` (after now, at most 7 days ahead), which the
  maintenance job ends **up to a minute late**. While it is on nothing rings (a ring's card is held silent and listed)
  and nothing is announced. When it begins or ends every device is reconciled. It survives a restart. **Until it has been
  read** (at start, or after a store failure) it counts as on: silence is the safe side.
- **Errors**: `NotifyError` `unavailable` (the CLI modes: no service there), `invalid`, `limit`, `busy` (the store was
  busy: say so and let the person try again), `failed`. `SpeechError` `unavailable`, `invalid`, `no-device` (the target
  names no known device), `in-turn` (below). `notifyRefusalText(lang, error)` gives a sentence for each in English and Dutch.

## The bounds

| What | Bound | At the bound |
|---|---|---|
| title | one line, 1 to 60 UTF-16 units | `invalid` |
| text | at most 200, no control characters but tab, line feed, carriage return, backspace, form feed | `invalid` |
| actions | at most 2 beside the host's `stop`; ids `[a-z][a-z0-9_]{0,31}`, not `stop`, not twice; labels one line, 1 to 20 | `invalid` |
| handler | a name the module registered (`[a-z][a-z0-9_.-]{0,63}`), required with actions | `invalid` |
| key | `[A-Za-z0-9_.:@/-]{1,64}` | `invalid` |
| open notifications of one module | 10 (`MAX_OPEN_PER_MODULE`) | `limit`; a resolved one frees its place |
| open notifications in all | 64 (`MAX_OPEN_TOTAL`, also what a page keeps) | `limit` |
| expiry, and do not disturb's end | see above; both happen at the next maintenance run, up to a minute late | `invalid` past the bounds |
| the service's scheduler jobs | 1: `core.notify/maintain`, every minute, scheduled by key at every start | (a start that cannot schedule it: a Health issue, tried again at the next send or hello) |
| one maintenance run | at most 120 open rows read for expiry and stale claims, at most 120 resolved rows removed, each in transactions of one page (12) with a yield between | the next run, a minute later |
| a resolved row | removed a day after it was resolved (`KEEP_RESOLVED_MS`) | (the next run) |
| a module action under way | one per notification (a claim on the row); released by the maintenance job 15 s after it was taken (`CLAIM_RELEASE_MS`) | "That is being handled already." |
| a handler's run | 5 s (`NOTIFY_ACTION_TIMEOUT_MS`) | it fails: "That didn't work.", nothing changes |
| a handler's answer | `say` cut to 300 at the page boundary | cut |
| an announcement | 1 to 300 UTF-16 units, the same characters as a text | `invalid` |
| announcements on one device | 8 (`MAX_SPEECH_QUEUE`), waiting, waiting for quiet or being spoken | that device is not queued (`why: "busy"`) |
| module actions from pages | the hub's bounded admission (4 per connection, 16 in all, pending at once); `stop` is outside it | `busy` |

The collection's `maxChars` is 2,000: the worst legal row (every text at its bound with the costliest characters, two
actions, a claim, every optional field) fits it, so one read lists at most 12 rows. The open counters (`notify_counts`:
`total` and one per module) make each limit one read; they are written in the same transaction as the row and
recounted at every start. Do not disturb is one row (`notify_dnd`).

## The delivery table

`decideDelivery` is the one place that decides whether, where and how something is delivered; nothing else does. It is
a pure function of what is delivered (a notification of a priority, or an announcement; personal or not), the device
(connected, may make sound, can show a card), do not disturb, and `Privacy.mayReveal(owner, device)` asked at that
moment for that device. In order:

| | Result |
|---|---|
| the device is not connected | `offline` |
| personal, and the privacy rule says no for this device | `private` |
| an announcement under do not disturb | `dnd` |
| an announcement on a device that may not speak | `cannot-speak` |
| an announcement otherwise | spoken |
| a `normal` notification where a card can be shown (do not disturb or not) | a silent card |
| a `normal` notification where none can | `cannot-show` |
| a `ring`, do not disturb off, the device may make sound | the card (where it can be shown) and the ring cue |
| a `ring` under do not disturb, or on a device that may not make sound | a silent card where it can be shown, else `dnd` (only do not disturb kept the sound away) or `cannot-show` |

A device's outputs come from one place, `deviceOutputsFrom`: the owner's overrides first ("Don't use its speaker",
"Treat as no display", its own else its type's), then what its page declared; a page that never declared anything
speaks and shows unless an override says not. The message carries `show` and `sound` separately: a device with a
speaker and no display gets the cue and no card.

## Reconciliation

- **The only sender.** `reconcile(device)` makes every voice connection of the device hold exactly what the open rows
  and the decision allow now: it sends a card a connection lacks (or holds in another form: silent instead of ringing),
  and takes down one it may not hold any more (`notification.resolved`, outcome `withdrawn`, or the row's outcome). The
  bookkeeping of what was sent is **per connection**: a withdrawal goes to every page that holds the card.
- **No stale sends.** A pass reads a page of open rows with the store's synchronous reader, decides and sends for it in
  that same step, yields, and goes on; it ends with a step that reads again every card the device's pages hold that
  the pass did not see, deciding and sending in that step. So no send rests on a row or a decision from before a wait.
- **Triggers**: a send, a resolve (its holders), the outcome of a press, do not disturb changing, a page saying hello
  (once the device's record exists) or closing, a changed declaration, an output override (which ends the device's
  session: its pages say hello again), and the maintenance job (every device). Passes run one at a time in one fiber; a
  pass that fails (a store read) marks its device, and the next trigger or the maintenance job repeats it: nothing is
  dropped, nothing waits for a hello.
- After a server restart, a ring that was open rings again on the first page that says hello.

## Actions and what a handler may do

- **Admission**: a press (a page's button; P7's ringing phrase and the kit later) is admitted only for a connection that
  holds that notification (without a connection, one of the device's pages must hold it), and only while the decision
  still allows it on that device; `stop` too. Knowing an id is not enough. A press whose read fails is a failure ("I
  can't do that right now") and changes nothing; it is never "it has ended".
- `stop` is the host's: on every card, first, in the household's language; it needs no handler, works while the owning
  module is stopped, failed or restarting, and wins over a module action under way (that action's outcome is dropped).
- Another action is `{ id, label }` on the request and reaches the handler named by `handler`, which the module
  registered with `ctx.notify.handle(name, …)` **in `shared`** (a registration of the part, like a job handler: published
  and withdrawn with the module). While it is not published, the press answers **"I can't do that right now."** and
  changes nothing. A name the module did not register refuses the `send`.
- **One at a time**: the action is claimed on the row in one transaction before any module code runs; a competing press
  (another device, another tab) is answered **"That is being handled already."**
- The handler runs as a call in flight of the module's part, with the press's notification principal
  (`CurrentPrincipal` `notification`: the notification and the device it was pressed on), admitted by the execution
  gateway first, within 5 s. It answers `{ say?, keepOpen? }`: `say` is shown on the card (cut to 300 at the page
  boundary; default "Done."); unless `keepOpen`, the notification is then resolved with the action as its outcome. A
  handler that fails or times out changes nothing ("That didn't work.").
- **After a store failure the handler may run again**: the outcome is written with a few retries; if it still cannot be
  written the answer is the failure sentence, the claim stays until the maintenance job releases it (15 s), and a later
  press runs the handler again for the same notification. **Handlers are idempotent by notification id.**

## Speech

- `say` decides each device of the target now (the table) and queues the announcement on those that pass; `deliveries`
  says which and why not. A room is matched by `place.room` (case and surrounding spaces ignored). A target with no
  device is `no-device`. The module's text passes the page boundary before it is spoken.
- One queue per device. The voice is made ready first (the answering assistant's `TurnSetup.tts`); then it waits until
  nothing is spoken or heard there (no play holds the output, no turn is in flight, no utterance is open in the
  recogniser, addressed or not, and the state is not hearing, thinking or speaking); then, in the same step as it takes
  the output lease, the quiet check and the delivery decision are made last (privacy, do not disturb, the device). It
  never takes the speaker from a reply that started meanwhile: it waits again. A reply that starts while it plays takes
  the speaker: the announcement ends `stopped` (why: a reply), the reply is intact. Two on one device keep their order.
- `cue: true` plays a short chime first (generated by the server, no asset), with the line, through the same output.
- `stop` on the handle marks every one of its announcements in one synchronous step (waiting ones are taken out,
  playing ones are silenced by the service), so it does not depend on its caller staying. The page's Stop (and Esc,
  and P7's stop later, through `stopSpeech(device)`) stops the announcement being spoken on that device and leaves the
  next reply and the next announcement as they are.
- **Inside a turn, never wait**: `done` awaited by a tool or an action of a model turn fails `in-turn` at once (the
  reply it belongs to is what the announcement waits for); the announcement still plays. Code outside a turn (a job, a
  press handler, a part's fiber) may wait for it. An announcement is not recorded in the conversation.

## The voice page

- `notification.ring` gives a card (title, text, buttons) shown above the dock in a region that scrolls within the
  viewport (long text wraps, every Stop is reachable), outside the character's stage, so every character draws as
  before (P10 moves the card into its presentation stage). A card the server says not to show (`show: false`) is not
  drawn but may still ring. `notification.resolved` takes it down. The page keeps every card the server may have open
  (64) and empties them at every welcome (the server sends what is open again after it).
- Whether the page rings is derived from every card it holds. While one rings, the page plays its ring cue (three soft
  tones, generated in the page, no asset, nothing fetched) every 2.5 s through its player. Only the tab that owns the
  device's audio plays it, while connected, once the audio was started and runs (the Start gesture gives the page its
  audio permission), never over a reply or the echo test, never two loops; it stops when the connection is lost, when
  the page is left (`pagehide`) and with the connection's clean-up. Before Start the card shows without sound, with the
  server's note ("Start audio to hear it." / "Zet het geluid aan om het te horen.").
- Every word on the card comes from the server in the household's language: the labels, the note and the region's name
  (`NotificationCard.texts`). A press sends `notification.action`; its cue stops at once; Stop is always usable, a
  module action disables only its own button while it is pending, and an answer after the card is gone is ignored.
- Protocol: additive within version 11 (`packages/protocol/src/notifications.ts`); a page that does not know these
  messages ignores them, and the server needs nothing from it. The web mock delivers with the same decision function,
  per device and on hello, and never reuses an id.

## What P7 and P10 build on

- P7 (`ringing` window, the spoken "stop"): `engine.ringingOn(deviceId)` (what rings there, with its actions),
  `engine.onRingingChanged(listener)` (open and close the window), `engine.stopRinging(deviceId)` (each ring held there
  stopped through the same admission as a press), `engine.stopSpeech(deviceId)`, and `engine.press(…)` for a ringing
  phrase of an action.
- P10: the card's data is `NotificationCard` on the wire; the stage draws it instead of `NotificationCards.tsx`.

## Latency

Measured on the development machine by `packages/store-sqlite/test/notifyLatency.test.ts` and
`notifyTurnLatency.test.ts` (the latency step; the longest stops asserted with the shared `bound(10)`), on SQLite on a
file at the stated maximum: every text at its bound with the costliest characters, two actions with labels at their
bound, 300-character announcements, 64 devices with a page each, through the host's real page boundary.

| What | Number |
|---|---|
| `send` as a tool calls it (200 calls) | median 0.34 ms, p95 0.45 ms, worst 0.86 ms; longest main-thread stop 1.9 ms |
| `say` to one device / to every device (64 decisions) | median 0.02 ms / 0.23 ms, worst 0.77 / 0.66 ms; longest stop 2.7 ms |
| reconciling every device when do not disturb starts (64 rings × 64 devices: 4,096 frames, 3.9 MiB encoded) | 91 ms of work in 384 steps, the longest step 0.39 ms; longest stop 2.3 ms |
| a page saying hello (64 cards) | longest stop 1.3 ms |
| end of turn → first audio (`TurnTrace`, the real `Conversation`, zero-delay synthesis and output, the model's first token at 5 ms; median of 100 turns × 4 counterbalanced runs) | without a ring 5.39 ms (p95 5.82); with a ring to all 64 devices sent while the model thinks 5.74 ms (p95 6.40) |

So a ring at the stated maximum in the middle of a turn (its `send` transaction and 64 cards reconciled on the turn's
thread) moved the turn's first audio by a median 0.35 ms, not zero; the test asserts it stays under 2 ms.

## Testing

`startTestModule` runs the real service on the kit's store, test clock and gateway (`kit.notify`): `all` (every
notification of the module, oldest first), `messages` (what each page was sent), `decisions` (every decision: which
device, and why not), `press(id, actionId, { device })` (as that device's page; the clock is driven while the handler
runs), `announced` (what was spoken where, when and how it ended), `replying(device, on)` (a reply starts there: an
announcement playing is cut, as serve mode's lease does; announcements wait), `connect` / `disconnect` (the kit's
`Devices` service sees the same), `dnd()`, `settle`, and `engine` (`ringingOn`, `stopRinging`, `stopSpeech`,
`maintainNow`). Announcements take `speechMs` (2 s) of test-clock time. **Where the kit differs from serve mode**: one
page per connected device (two tabs of a device are tested in the contract suite), no owner overrides (a device's
outputs come from the capabilities the test gives it, through `deviceOutputsFrom`), and its speech port has no voice to
make ready and no recogniser: what a real voice session adds (the readiness wait, an open utterance) is tested in
`serveNotificationsRound1.test.ts`.

## Not now

Quiet hours and quiet rooms, do not disturb per device, acceptance settings ("accepts from other devices"), ring
policies beyond the two targets (`origin-then-room`), `update`, sending later inside the service (a module's own job
does it), sequences of several segments with skip, recording announcements in the conversation, the missed badge, the
admin inbox page, a reduced form of personal content on a shared screen, and the measurement of false stops from a
ring's own line (P7's window).
