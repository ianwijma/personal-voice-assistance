# Broadcast (`broadcast`)

Announces a message on every device or in one room, with a chime.

- Package: `packages/module-broadcast`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 16 (wave B)
- Research: [docs/research/modules/broadcast.md](../research/modules/broadcast.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Says a short message in the assistant's voice, with a chime first, on the other devices of the house: every device, or
the devices of one room. **Never on the device that asked** (the sender is already there). It goes through
`ctx.speech`, so the one delivery decision of [NOTIFICATIONS.md](../NOTIFICATIONS.md) applies to each device: a device
that is not connected, one that may not speak, do not disturb. The answer says where it was queued and where it was
not, and why, from what the service decided for each device (`SpeechHandle.deliveries`), never from what was hoped.

- **Queued, not said.** A tool inside a turn does not wait for an announcement (it fails `in-turn`; the reply it belongs
  to is what the announcement waits for). So the answer says "Announcing on …": it is queued on those devices and is
  said after whatever is being said there. It does not say that it was heard.
- **A card.** The message is also put on the screens in the target, as a transient `card` (30 seconds) titled
  "Announcement" (or "Announcement for the room") with the message and a "From" line naming the device that asked.
  A card goes to a screen where the message is queued, and to a screen that cannot speak it (a display with no
  speaker); never to a device that is not connected. **Do not disturb is read again immediately before each card is
  started**: while it is on, no card is started on any device (and the answer counts the screens that got none).
  A card that was already showing when do not disturb came on stays until its 30 seconds end, and a page that
  reconnects within them is given it again by the Presenter (the module does not manage the card after showing it). A
  device's card is replaced in place by the next broadcast (one `key` per device). At most 8 cards are made per
  broadcast, the most the Presenter lets one module hold live; **screens beyond the eight are counted and said**, as
  are refusals. A setting turns cards off.
- **Who asked is left out and named.** The origin is the device of whoever made the call: a turn's device, a job's origin
  device, a press's device. It is left out of the announcement and named in the card's "From". With no origin device at
  all (a job made in the module's own start, say) it refuses with a sentence: it cannot know whom to leave out.
- **One broadcast at a time.** One semaphore in the module's shared part holds the whole bounded operation (the speech
  calls and the cards), for tools and actions alike, so two broadcasts at once are in the same order in sound and on
  screen (an older card never replaces a newer one).
- **Answers fit 300 characters** (`ANSWER_MAX`: a phrase command's answer is cut there by the page boundary, and the tools
  are held to the same bound). At most two devices are named per group (announced, not announced with their reason,
  shown), the rest as a count with the reasons, and when that is still too long names go and counts remain; no group is
  dropped. Names are cut at a code point boundary with the ellipsis inside the budget; questions about rooms are held
  to the same bound.
- **A room is text.** The name is matched against the rooms of the devices the house knows: spelling, case, accents,
  apostrophes and a leading "the"/"de"/"het" are ignored; an exact name wins ("Kitchen" over "Kitchen annex"); else the
  rooms whose words contain the spoken words (or the other way round: "kids room" for "Kids' room upstairs"). **No
  match, or more than one: it asks** (it names up to eight rooms) and announces nowhere. "Everyone", "everywhere",
  "the house", "iedereen", "overal" and similar mean no room.
- **Nobody else there.** If the asking device is the only one in the room (or in the house), nothing is announced and
  it says so.
- **At most 64 devices** are queued per broadcast (one enqueue each); a house with more says how many it left out.
- **The message is what the person said**: one line, 1 to 200 characters, never reworded. It is the sender's own
  content, so **household content, not personal**: it is announced and shown on every device the delivery decision
  allows, **including a public device**, exactly like any other broadcast. Nothing about the sender's person is
  attached (the card names the sending *device*), and the module stores the message nowhere. Anyone who says something
  personal in a broadcast says it to the house.

Risk class: **`change`**. Speaking and showing on the house's own devices changes something in the house and sends
nothing outside it; `message` is for people outside the house (docs/MODULES.md §4, plan §2 decision 5), and would be
refused here as needing a confirmation the assistant cannot ask for yet.

## Tools

| Tool | Parameters | Answers (`spoken`) | Example phrases |
|---|---|---|---|
| `broadcast_send` (`change`, quick) | `message` (one line, ≤ 200), `room?` (text, ≤ 40) | "Announcing on Hall screen, Kids tablet and 3 more. Not announced on Attic node (not connected) and Garage screen (cannot speak). Also showing it on Garage screen." | "tell everyone dinner is ready"; "tell the kids' room it's lights out"; "zeg tegen de keuken dat ik eraan kom" |
| `broadcast_chime` (`change`, quick) | `room?` | the same, for the chime | "ring the dinner bell"; "bel de gong in de studeerkamer" |

Other answers: "I don't know a room called Garden. The rooms are …"; "Which room do you mean: Guest bedroom and Master
bedroom?"; "Do not disturb is on, so nothing was announced."; "Study has no device but this one, and announcements
never go to the device that asked, so nothing was announced."; "What should I announce?". A device whose speech call
failed is listed as "(failed)". Every sentence is in English and Dutch (`src/texts.ts`); lists go through
`@pva/language`.

**The chime alone is not built.** `ctx.speech.say` refuses an empty line (a chime is only played with one), so
`broadcast_chime` plays the chime and **one word** after it ("Attention." / "Aandacht."). Its description says so, so
the model is not told otherwise. No card is shown for a chime.

### Typed actions and phrase commands (no model)

Both actions have `phrases`, so after the wake phrase (or in a follow-up window) the words run them without the
language model ([PHRASES.md](../PHRASES.md)); the answer is a canned reply on the device that asked. **A phrase never
widens the audience: phrase commands exist only for the whole house, and only where the words say "everyone".** There is
no unrestricted "announce …" phrase and no room-directed one; those utterances ("announce in the study that dinner is
ready", "tell the kitchen that …", "omroepen in de keuken dat …", "ring the dinner bell") are not taken and go to the
assistant, whose `broadcast_send` call names the room. A message is a text slot, so at most eight words this way.
The actions have no room parameter. Even then the action refuses a message that opens with a destination word
("tell everyone in the study that …": "That sounds meant for one room, so I did not announce it to everyone.").

| Action | Parameters | Phrases (English) | Phrases (Dutch) |
|---|---|---|---|
| `broadcast.send` | `message` | "tell everyone dinner is ready", "tell everyone that …", "announce to everyone …", "announce to everyone that …" | "zeg tegen iedereen het eten is klaar", "zeg tegen iedereen dat …", "omroepen voor iedereen …", "omroepen voor iedereen dat …" |
| `broadcast.chime` | none | "ring the bell for everyone", "sound the chime for everyone" | "bel de gong voor iedereen", "luid de bel voor iedereen" |

After "that"/"dat" the message starts, so "zeg tegen iedereen dat het eten klaar is" announces "het eten klaar is". Both
are `change`, not offered to the model as tools of their own (`offerAsTool: false`). An action's text is checked like
the tool's (one line, at most 200 characters). They return `{ say }` with the same sentences as the tools.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Show the message on screens (`showCard`) | on | The card on the screens the message goes to. Off: the announcement is the same, nothing is shown. |

Nothing else: the house's rooms, devices, do not disturb and privacy are the core's (Devices, Notifications).

## What it stores

**Nothing.** No collection, no job, no event, nothing personal: the message lives in the announcement queue of the
notification service and in a transient presentation, both of the core, and leaves with them. (So there is no
data version and no migration.) What a presentation or an announcement keeps, and for how long, is on
[NOTIFICATIONS.md](../NOTIFICATIONS.md) and [PRESENTING.md](../PRESENTING.md).

## What it needs

`requires`: nothing outside the process (no network, no program). Uses the core's `Devices` service (to read the
rooms and which devices have a screen; when it is not there it says "I can't see the house's devices"), `ctx.speech` and
`ctx.present`. It provides no service and no contribution, and uses no other module. In the CLI modes, where there is
no notification service, the tools say "I can't announce anything on this installation."

Off by default; with it off nothing changes for anyone.

## Latency and bounds

A broadcast reads the device list once (a cached snapshot), matches a room by words over the devices' rooms, makes one
`speech.say` per device (a synchronous enqueue in the notification service), at most 64, and one `present.show` per
screen, at most 8: each of those is the core's one synchronous store transaction and an enqueue (PRESENTING.md, way 2),
which may be refused (`busy`, `limit`) and is then said. The module itself has no collection, no job and makes no
network call, and nothing runs through `offThread`. The announcement is never waited for. No latency number is claimed
for a whole broadcast: it has no module-level measurement; the numbers of the two services are on their pages.

## What was left out

Because the preparation parts' first versions do not have it:

- **The reply `capture` window** on each target (a 30-second window in which the next thing a person says there is
  routed back to the sender, and not on a device that is in a call): [NOTIFICATIONS.md](../NOTIFICATIONS.md) "Not now"
  (no `capture` window; ringing phrases are P7's).
- **Quiet rooms, quiet hours and devices that accept nothing from others**: the same page's "Not now" (no quiet
  hours or rooms, no acceptance settings). Today the only things that keep a device quiet are do not disturb for the
  house, a device that cannot speak and a device that is not connected.
- **A message of more than eight words as a phrase command** ([PHRASES.md](../PHRASES.md): a text slot is at most
  eight words): it goes to the assistant, which calls `broadcast_send`.
- **Phrase commands for one room**: left out on purpose (a phrase never widens the audience, above).
- **Do not disturb for a card already showing**, and a card after a reconnect while do not disturb is on: the
  Presenter has no do-not-disturb rule, so this module only declines to start cards under it.
- **The chime alone** (above).

By the plan's row: the speaker's own voice, voice messages, scheduled broadcasts and phones.

## Ambiguities in the contracts, and the reading chosen

- Whether a broadcast to a room means the *devices in the room* or the *room's other devices*: the latter (the asking
  device is excluded in both the room and "everyone").
- Whether do not disturb should keep a *silent card* from appearing: the conservative reading, no card is *started*
  while it is on (read again before each card); one already showing stays until its 30 seconds end. A display that
  merely cannot speak still gets the card, since that is what it is for.
- `SpeechHandle.deliveries` says "queued", not "will be heard": the answer is worded as queued.
