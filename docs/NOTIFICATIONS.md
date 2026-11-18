# Notifications, speech outside a reply, ringing

How a module tells the house something nobody on that device just asked for: a **notification** (a card on the voice
page, ringing until someone stops it when its priority is `ring`) and an **announcement** (one spoken line on a device,
a room's devices or everywhere, after whatever is being said there). This is the first version of docs/MODULES-PLAN.md
§4 P9; what is left out is at the end. The contract is `packages/core/src/Notify.ts`; the engine `NotifyEngine.ts`.
Every promise on this page has a case in `@pva/core/notify-contract` (run on the in-memory store and on SQLite, in
memory and on a file), in the decision table (`packages/core/test/NotifyDecision.test.ts`) or in the kit's tests
(`packages/core/test/notify/NotifyKit.test.ts`).

## In one paragraph

`ctx.notify.send({ title, text?, priority?, owner?, target?, key?, expiresInMs?, actions?, handler?, at? | inMs? })`
stores one row in the core collection `core.notify/notifications` in one synchronous transaction (with its expiry job,
and its delivery job when it is sent later) and hands it to delivery, which runs in the service's own fiber: for each
device of its target, **one decision** (`decideDelivery`) made at that moment says whether the device gets its card,
silent or ringing. A press of a card's button comes back through the gateway: `stop` (the host's) resolves it; another
action runs the handler its module registered in `shared` with `ctx.notify.handle`. `ctx.speech.say(target, text)`
queues one announcement on each device of the target, played after the reply being spoken there with the reply's own
voice and audio path. Do not disturb, for the house, keeps every ring silent and every announcement unsaid.

## The calls

```ts
ctx.notify.send(request): Effect<{ notification, deduped }, NotifyError>
ctx.notify.resolve(id | { key }, outcome? = "resolved"): Effect<boolean, NotifyError>   // false: none such of this module, or it had ended
ctx.notify.list({ after?, limit? }?): Effect<Notification[], NotifyError>              // this module's live ones, oldest first, ≤ 12 a page
ctx.notify.handle(name, { run(press) => Effect<{ say?, keepOpen? } | void> }): Effect<void, NotifyError>   // in shared
ctx.notify.dnd.get / .set({ until? }?) / .clear: Effect<DndState, NotifyError>           // { on, until? }
ctx.speech.say(target, text, { cue?, owner? }?): Effect<SpeechHandle, SpeechError>
SpeechTarget = { device } | { room } | "everywhere"
SpeechHandle = { id, deliveries: [{ deviceId, queued, why? }], done: Effect<[{ deviceId, outcome, why? }], SpeechError>, stop: Effect<void> }
```

- **Target** of a notification: `origin` (the default: the device of the turn, the job or the press the call runs for)
  or `everywhere` (every known device). A call with no origin device (code in `shared`, a job made for nobody) that
  asks for `origin` is refused `invalid`.
- **Priority**: `normal` (a silent card) or `ring` (the card and the page's ring cue, until it is resolved). Nothing
  may send above `ring`: any other priority is refused `invalid`.
- **Owner**: a Members id makes it personal content; the privacy rule decides per device when it is delivered.
- **Dedupe key**: one live notification per module and key. Sending the same key while one is live answers that one
  with `deduped: true`; nothing is stored or delivered. Once it is resolved the key is free.
- **Expiry**: it is resolved as `expired` `expiresInMs` after it is delivered (default: a ring 15 minutes, a normal
  one a day; at most a ring 2 hours, a normal one 7 days; at least 1 s). A job of the service does it.
- **Later**: `at` or `inMs` (at most 7 days ahead) stores it `scheduled`; a job of the service's own core handler
  (`core.notify`, `deliver`) delivers it then. It counts as live from the moment it is sent. The module has no timer.
- **Resolve**: by id or key, only the module's own; its cards go from every device they were shown on, and nothing
  rings for it any more. `stop` and `expired` are the host's outcomes and cannot be claimed.
- **List**: the module's live (`scheduled` and `open`) notifications, oldest first, a page of at most 12; continue with
  `after` (a notification `list` or `send` returned).
- **Do not disturb**: for the house, on until cleared, or until `until` (after now, at most 7 days ahead), which a job of
  the service ends. While it is on nothing rings (a ring's card is delivered silent and it is listed) and nothing is
  announced. When it begins or ends, every open notification is delivered again (silent or ringing). It survives a
  restart.
- **Errors**: `NotifyError` `unavailable` (the CLI modes: no service there), `invalid` (a bound, an unknown handler,
  no origin device), `limit`, `busy` (the store was busy: say so and let the person try again), `failed` (the store
  said no). `SpeechError` `unavailable`, `invalid` (an empty or too long text, a wrong target), `no-device` (the target
  names no known device: a room nobody is in), `in-turn` (below). `notifyRefusalText(lang, error)` gives a sentence for
  each in English and Dutch.

## The bounds

| What | Bound | At the bound |
|---|---|---|
| title | one line, 1 to 60 UTF-16 units | `invalid` |
| text | at most 200, no control characters but tab, line feed, carriage return, backspace, form feed | `invalid` |
| actions | at most 2 beside the host's `stop`; ids `[a-z][a-z0-9_]{0,31}`, not `stop`, not twice; labels one line, 1 to 20 | `invalid` |
| handler | a name the module registered (`[a-z][a-z0-9_.-]{0,63}`), required with actions | `invalid` |
| key | `[A-Za-z0-9_.:@/-]{1,64}` | `invalid` |
| live notifications of one module | 10 (`MAX_OPEN_PER_MODULE`) | `limit`; a resolved one frees its place |
| live notifications in all | 64 (`MAX_OPEN_TOTAL`) | `limit` |
| expiry | see above | `invalid` |
| sent later | at most 7 days ahead | `invalid` |
| do not disturb's end | after now, at most 7 days ahead | `invalid` |
| a resolved row | removed a day after it was resolved (`KEEP_RESOLVED_MS`), by the retention job every 10 minutes, at most 120 rows a run in transactions of 12 | (the next run) |
| an announcement | 1 to 300 UTF-16 units, the same characters as a text | `invalid` |
| announcements waiting on one device | 8 (`MAX_SPEECH_QUEUE`), the one being spoken not counted | that device is not queued (`why: "busy"`) |
| a handler's answer | `say` cut to 300 at the page boundary | cut |
| a handler's run | 5 s (`NOTIFY_ACTION_TIMEOUT_MS`) | it fails: "That didn't work.", nothing changes |

The collection's `maxChars` is 2,000: the worst legal row (every text at its bound with the costliest characters, two
actions, every optional field) fits it, so one read lists at most 12 rows. The live counters (`notify_counts`: `total`
and one per module) make each limit one read; they are written in the same transaction as the row and recounted at
every start. Do not disturb is one row (`notify_dnd`). The service's jobs (`deliver`, `expire`, `dnd-end`,
`retention`) are at most 64 + 64 + 2 live, within the scheduler's 200 per owner.

## The delivery table

`decideDelivery` is the one place that decides whether, where and how something is delivered; nothing else does. It
is a pure function of what is delivered (a notification of a priority, or an announcement; personal or not), the
device (connected, may make sound, can show a card), do not disturb, and `Privacy.mayReveal(owner, device)` asked at
that moment for that device. In order:

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

"May make sound" is the device's effective speaker (serve mode's `speakerAllowed`: the owner's "Don't use its speaker"
and what the page declared); "can show" is a display the page declared, or a page that never declared anything (the
voice page draws cards). The privacy rule is asked **at delivery, for the device that would show or speak it**, never
when the notification was made and never kept across a wait: a page that says hello later, a delivery after do not
disturb ends, and an announcement that waited behind a reply are each decided again then. A personal notification is
withheld where the rule says no (no reduced form in this version).

## Delivery, reconnects, restarts

- Delivered when it is sent (or due), to the connected devices of its target; and again to each voice connection that
  says hello while it is open (a device that reconnects while it rings gets the ring again; after a server restart a
  ring that was open rings again on the first page that says hello).
- A device whose last page goes is not ringing any more. A resolved notification is taken down on every device it was
  shown on (`notification.resolved`), and a press of `stop` on one of them stops it on all.
- **Records first**: a notification sent later is decided, then its delivery is recorded (`scheduled` → `open`), and
  only then are its cards sent. A store failure there sends nothing; the job runs again (back-off) and delivers it.
- A store failure at `send` stores nothing and delivers nothing (`failed`); at `resolve` it stays open and keeps ringing.

## Actions and what a handler may do

- `stop` is the host's: on every card, first, in the household's language; it always works, also while the owning
  module is stopped, failed or restarting.
- Another action is `{ id, label }` on the request and reaches the handler named by `handler`, which the module
  registered with `ctx.notify.handle(name, …)` **in `shared`** (a registration of the part, like a job handler:
  published and withdrawn with the module in the host's one step). While it is not published (the module is down,
  starting, being replaced), the press answers **"I can't do that right now."** and changes nothing. A name the module
  did not register refuses the `send`.
- The handler runs as a call in flight of the module's part (the grace period when it stops), with the press's
  notification principal (`CurrentPrincipal` `notification`: the notification and the device it was pressed on),
  admitted by the execution gateway first, within 5 s. A `send` it makes has that device as its origin.
- It answers `{ say?, keepOpen? }`: `say` is shown on the card (cut to 300 at the page boundary; default "Done.");
  unless `keepOpen`, the notification is then resolved with the action as its outcome. A handler that fails or times
  out changes nothing ("That didn't work.").
- A press of a notification that has ended answers "That has ended already." (and takes its card down there). A press
  from a device the notification is not for, or of an action it does not have, does nothing.

## Speech

- `say` decides each device of the target now (the table) and queues the announcement on those that pass; `deliveries`
  says which and why not. A room is matched by `place.room` (case and surrounding spaces ignored). A target with no device is
  `no-device`.
- One queue per device: an announcement waits until nothing is spoken or heard there (no reply plays, no turn is in
  flight, the person is not speaking), is decided again (privacy, do not disturb) and is then spoken with the device's
  answering assistant's voice, through the same synthesis and output lease as a reply. Two on one device keep their
  order. A reply that starts while one plays takes the speaker: the announcement ends `stopped`, the reply is intact.
- `cue: true` plays a short chime first (generated by the server, no asset), with the line, through the same output.
- `stop` on the handle takes it out of every queue and silences it where it plays; the next one on that device goes on.
  The host's stop on a device (`stopSpeech`, what P7 calls) stops the one being spoken there and those waiting.
- **Inside a turn, never wait**: `done` awaited by a tool or an action of a model turn fails `in-turn` at once (the
  reply it belongs to is what the announcement waits for); the announcement still plays. Code outside a turn (a job, a
  press handler, a part's fiber) may wait for it. Speech that answers a turn is the tool's result, as before.
- An announcement is not recorded in the conversation.

## The voice page

- `notification.ring` shows a plain card (title, text, buttons) above the dock, outside the character's stage, so every
  character draws as before (P10 moves the card into its presentation stage). `notification.resolved` takes it down.
  The page keeps at most 16 cards and empties them at every welcome (the server sends what is open again after it).
- While a card that is not silent is shown, the page plays its ring cue (three soft tones, generated in the page, no
  asset, nothing fetched) every 2.5 s through its player. Only the tab that owns the device's audio plays it, once the
  audio was started and runs (the Start gesture gives the page its audio permission), never over a reply or the echo
  test. Before that the card shows without sound, with "Start audio to hear it."; the next beat after Start plays it.
- A press sends `notification.action`; the cue stops for that card at once, and the answer is shown on the card until
  the server takes it down. A reconnect stops the loop with the cards and starts it again with the server's rings.
- Protocol: additive within version 11 (`packages/protocol/src/notifications.ts`); a page that does not know these
  messages ignores them, and the server needs nothing from it.

## What P7 and P10 build on

- P7 (`ringing` window, the spoken "stop"): `engine.ringingOn(deviceId)` (the notifications ringing there, with their
  actions), `engine.onRingingChanged(listener)` (open and close the window), `engine.stopRinging(deviceId)` (resolve
  what rings there, `stop`), `engine.stopSpeech(deviceId)`, and `engine.press(…)` for a ringing phrase of an action.
- P10: the card's data is `NotificationCard` on the wire; the stage draws it instead of `NotificationCards.tsx`.

## Latency

Measured (development machine; `packages/store-sqlite/test/notifyLatency.test.ts` and `notifyTurnLatency.test.ts`
print them; the bounds are asserted with `bound()`, three times them on CI). See the pull request for the numbers of
the run that wrote this page; nothing here runs on a turn's path but `send` (one transaction and an enqueue), `resolve`
and `say` (decisions and an enqueue).

## Testing

`startTestModule` runs the real service on the kit's store, test clock and gateway (`kit.notify`): `all` (every
notification of the module), `messages` (what the pages were sent, per device), `decisions` (every decision: which
device, and why not), `press(id, actionId, { device })`, `announced` (what was spoken where, when and how it ended),
`replying(device, on)` (a reply is being spoken there), `connect` / `disconnect`, `dnd()`, `settle`, and `engine`
(`ringingOn`, `stopRinging`, `stopSpeech`). Announcements take `speechMs` (2 s) of test-clock time.

## Not now

Quiet hours and quiet rooms, do not disturb per device, acceptance settings ("accepts from other devices"), ring
policies beyond the two targets (`origin-then-room`), `update`, sequences of several segments with skip, recording
announcements in the conversation, the missed badge, the admin inbox page, a reduced form of personal content on a
shared screen, and the measurement of false stops from a ring's own line (P7's window).
