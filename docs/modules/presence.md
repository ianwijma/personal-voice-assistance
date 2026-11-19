# Presence (`presence`)

Who is home, and who has just arrived or left, from Home Assistant's people.

- Package: `packages/module-presence`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 19 (wave A)
- Research: [docs/research/modules/presence-and-people.md](../research/modules/presence-and-people.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

It answers "is Sam home?" and "who is home?" from the `person` entities Home Assistant already tracks, and it tells the
rest of the house when someone arrives or leaves (the events `presence.arrived` and `presence.left`). It is off by
default; with it off nothing changes for anyone.

It reads Home Assistant through the `HomeAssistant` service of the `home-assistant` module (`uses`): it has no
connection of its own and makes no request of its own. Which Home Assistant person is which household member is a
setting of this module; the members themselves are the core's (Members).

**Where a person is, is personal.** Every answer about a person is checked with `Privacy.mayReveal(member, turn)` at
the moment of answering, for the device that will speak it (docs/MODULES.md §7):

| asking device | what is said |
|---|---|
| `private` | every linked member's whereabouts |
| `shared` | only its default person's; for others "I don't say where people are from this device" |
| `public`, or a shared device with no default person | nothing about anyone, not even "someone is home" |

For an answer about everyone on a shared device, the people it may not tell are only counted ("Where 2 other people are
is not said here."). The privacy rule is applied first, and only then what Home Assistant knows: a person the device may
be told about whose `person` entity Home Assistant does not expose (or whose state is `unknown` / `unavailable`) is
"unknown", by name; an answer about everyone says who is unknown, and a question about one person never answers about
anyone else. A Home Assistant person linked to nobody (or to someone no longer in Members) is revealed nowhere, by
tool, action or event. Only "home", "out" and "unknown" are said: the name of a zone ("work", "gym") is a place, and is
never said or sent.

**Since when.** "Home since" is Home Assistant's last change of the person's state to `home`. "Out since" is given only
when this module itself saw the person go from home to away (it keeps that in memory with the state); a change from
one away zone to another does not move it, and a person who was already away when the module started, or who went
through `unknown` / `unavailable`, or whose state a reconnect's snapshot reports differently from what the module knew,
gets no time at all.

## Tools

| Tool or action | Parameters | Risk | Says | Example |
|---|---|---|---|---|
| `presence_where` (tool) | `person?`: a household member's name; leave out for everyone | read, speculative | for each person that may be told: `home`, `out` or `unknown`, and since when where it is known (the time in the household's zone, with the date if it was not today); `withheld` and `stale` notes. Terminal cases come back as a `spoken` line: nothing linked, Home Assistant not heard from or off, a stranger, two people with that name ("Which one: …?"), not allowed here | "is Sam home?", "waar is Robin?" |
| `people_list` (tool) | none | read, speculative | the household's members and whether each is followed. Never says where anyone is, so it is answered on any device | "who lives here?" |
| `presence.who_is_home` (typed action) | `person?`: a member (a dynamic choice over Members) | read | the same answer as sentences, with no model, the time worded by `@pva/language` ("Sam has been home since seven o'clock. Robin is out." / "Sam is sinds zeven uur thuis."), at most four people and then "and N more" | "who is home", "is Sam home", "wie is er thuis", "is Sam thuis" |

### Phrase commands and the list

`presence.who_is_home` is also a **phrase command** (docs/PHRASES.md): said after the wake phrase it runs with no model,
the same action, with the same sentences, refusals and risk class, and nothing else of the module changed. The phrases
are fixed words, matched exactly (case and punctuation do not count), for the household's language:

| English | Dutch |
|---|---|
| "who is home", "who is at home", "who's home", "is anyone home" | "wie is er thuis", "wie is thuis", "is er iemand thuis" |

They ask about everyone. "Is Sam home?" is not a phrase (a name is a runtime list, which cannot be a phrase slot): it
goes to the assistant, which has `presence_where`; the action itself still takes a `person` from the model or admin.
"Who is home please" is not matched either.

Whenever the action answers with **one person's** whereabouts (also as the reduced form on a shared device: that person's
line and the count of the others), it also shows them as a list on the screen of the device that asked: the title "Who is
home" ("Wie is thuis"), the person's line ("Robin: out", "Sam: home since 07:00"), and the answer's notes as lines of their
own ("and 2 more", "Where 2 other people are is not said here.", "I lost the connection to Home Assistant, so this is what
I heard last."). It is a transient list (30 seconds), with no buttons.

**An answer that names the whereabouts of more than one person is only spoken, with no list.** A presentation has one
owner, so the Presenter can decide privacy again (when a device's place or default person changes, or a page
reconnects) for one person only; a list of several people would be tagged with one of them. This is left out until a
presentation can have several owners (see below).

- **Privacy is the answer's.** What the list names is exactly what the answer named for that device (a refused or empty
  answer shows nothing, so a public device, or a shared device asked about someone who is not its default person, shows
  no list, not even "nobody"). The list is personal to the person it names, so the Presenter also asks
  `Privacy.mayReveal` for the device whenever it decides what a screen holds, and takes it down if the rule changes. A
  device with no screen, or a page that cannot draw lists, is told nothing different: the answer is spoken as before.
- **The list is the answer.** Its person and its overflow line come from the same selection as the sentences (the same
  people, the same "and N more"), with every note the answer has.
- **What is on screen follows the data.** The module keeps the handle of every list it was given, on each device (in
  memory, at most 32 devices), whether or not a page shows it at that moment (a page that gains a screen later must not
  show what is out of date). The next answer from that device takes it down first (and shows a new one only if it has
  something to show, so an empty answer withdraws it), and any change of a Home Assistant person, a snapshot, a break
  of the connection or the end of its stream takes every list down. A list is not rewritten out of a turn: it is taken
  down, and shown again by asking again.
- **After a restart** of the module its lists are gone with it (the Presenter withdraws a stopped part's transient
  presentations) and the memory of them with it.
- **A phrase turn that repeats** (same assistant, conversation, turn and device) is shown once; a call the model makes
  runs every time.
- **A phrase's answer fits what a phrase may say** (300 characters): in a phrase turn the module names fewer people, whole
  sentences only, so that "and N more", the count of people not said here and the lost-connection warning are never cut
  off. Outside a phrase turn the answer is as it was (up to four people).
- Names are cut to the Presenter's bounds at a code point (30 characters in a line, 80 per line), and outside text is
  shown as plain text on one line (control characters become spaces, a lone surrogate becomes U+FFFD).

### Events

| Event | Data | When |
|---|---|---|
| `presence.arrived` | `{ person, at }`: the member's id, epoch ms | at once, when a linked person's state goes from a known away state to `home` and no departure of theirs was waiting |
| `presence.left` | `{ person, at }`: `at` is when they went | after the **departure delay** (default 3 minutes), if the person is still away |

**These are personal facts.** An arrival or a departure says that this member came home or left at that time: it is
personal presence data whose owner is `person` (the member's id), even without a zone. The bus does not check who
listens, so **a module that speaks or shows anything because of one of these events must ask
`Privacy.mayReveal(person, device)` for the device it would use**, at that moment, and say nothing there when the
answer is no. They are not sent to voice pages (no event type is declared with a projection).

How the delay works: a person's waiting departure is a fiber in the module's shared part that sleeps the delay. Nothing
of it is stored or scheduled. It is called off, at once, by the person being seen home again, by any snapshot of Home
Assistant's state, by the connection to Home Assistant leaving `connected`, by the person's state becoming `unknown` or
`unavailable` or the entity going away, by the module stopping (a change of its links is a restart), and by Home
Assistant's stream ending. When the delay is over it announces the departure only if Home Assistant is connected at
that moment and still says the person is away, on the same time away the module saw begin; otherwise nothing.

- A person back within the delay neither left nor arrived: nothing is announced.
- **A snapshot is not news.** The first load, a reconnect or an overflow of Home Assistant's stream never produces an
  event, so a restart of the server or of Home Assistant does not announce everyone as arrived. A state that goes to or
  from `unknown` / `unavailable` is not a departure or an arrival either.
- **A departure waiting across a restart is lost**, deliberately: after a restart of this module, of the Home Assistant
  module or of the server nothing waiting survives, and the first snapshot only sets what the module knows. Events are
  lost at a restart anyway, and nothing may depend on an event for correctness (docs/MODULES.md §13); a lost departure
  is the price of keeping no personal fact on disk. A person seen coming home from a known away state afterwards is an
  arrival, even though their departure was never announced.

## Settings

| Field | Meaning | Default |
|---|---|---|
| People (`people`) | up to 20 records: the Home Assistant person (`person.sam`) and the household member's **id** (`p-sam`), never a name: an id stays the same when a member is renamed, and is never another person's. Each Home Assistant person and each member may be linked once. Anything else is refused and the module is down with the reason on its page | none |
| Household members (`members`, read-only) | each member with their id (`Sam: p-sam · Robin: p-robin`), to copy into a link, and after it any link whose id is not a member now ("Not a member now, ignored: …") | |
| Departure delay (`departureDelayMinutes`) | 0 to 60 minutes; 0 announces a departure at once | 3 |

Editing a link in admin: open the module's page, read the member's id from the Household members line, and add a
person (or open one) under People with the Home Assistant person and that id. A link whose id is not a current member
(the member was removed; a new member with the same name has a different id) is ignored everywhere: by the tools, the
action and the events. It is named on the Household members line and on the Health page (a warning,
`presence.not-members`), so the owner can link the person again.

With no people linked, the Health page says so (info) and every answer says that nobody is linked yet.

## What it stores

Nothing, and it schedules nothing. Where a person is lives in Home Assistant; what the module knows of it (each person
entity's last state, and when a person was seen going away) and the departures waiting out the delay are in memory
only, and are gone when the module stops. So there is no collection, no job, no migration and no data to forget.

## What it needs

- `uses: ["home-assistant"]`: the `HomeAssistant` service (a transport; a stub of it in tests). While that module is
  off or stops, tools and the action say "The Home Assistant module is off." and the module subscribes again to the
  new provider's changes when it is back.
- The core services `People` (a link's member is looked up by id at each use) and `Privacy`.
- Home Assistant `person` entities (the companion app, a router tracker, …), exposed to the assistant.
- It has no network requirement of its own, so no `requires`.

## What was left out

Left out of the first version by the plan's row (`docs/MODULES-PLAN.md` §5.1 row 19): rooms (Bermuda, mmWave), voice
identification, guest mode, the house guide, who may ask about whom (adults and children, `home-only` and `exact`),
presence history, `presence.room`, `presence.everyone_left` and `presence.first_home`, and the "welcome home" greeting.

Left out for wave B, because they need a notification or the module's own speech (P9): spoken greetings on arrival,
enrolment steps, the Wi-Fi hand-off and QR code, and notifications such as "everyone left and the door is unlocked".
(The phrase command for "who is home" and its `list` presentation are described above.)

Left out because something is missing, and reported in the pull request:

- A phrase for one person ("is Sam home?"): a `Param.dynamic` cannot be a slot, and a text slot would need the name
  resolved in the action with the people's aliases on the matching path. Smallest change: a phrase slot that reads a
  `Param.dynamic` from a list the host prepares when the set is built.
- A presentation with several owners, shown only where every owner's lines may be revealed. Today `sensitivity` takes
  one owner, so a list of several people's whereabouts cannot be shown safely and is left out (the answer is spoken).
  Smallest change: a per-line owner on a list presentation, decided per line by the Presenter.
- Zone names are never said (see above); the setting that would let a person share them (`exact`) belongs to the
  "who may ask about whom" part.
- A linked member is chosen by typing their id (from the Household members line), not from a list: a `records` item
  takes no `combo`, so the runtime list of members cannot be offered inside a link.
- `health()` is given only the settings (docs/MODULES.md §2), not `People`; to name links to someone who is not a
  member, the running shared part lends the health check the one question "is this id a member now?" and takes it back
  when it closes. While the module is not running, Health cannot name them.
