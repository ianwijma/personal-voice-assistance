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
is not said here."). A Home Assistant person linked to nobody (or to someone no longer in Members) is revealed
nowhere, by tool, action or event. Only "home", "out" and "unknown" are said: the name of a zone ("work", "gym") is a
place, and is never said or sent.

## Tools

| Tool or action | Parameters | Risk | Says | Example |
|---|---|---|---|---|
| `presence_where` (tool) | `person?`: a household member's name; leave out for everyone | read, speculative | for each person that may be told: `home`, `out` or `unknown`, and since when (the time in the household's zone, with the date if it was not today); `withheld` and `stale` notes. Terminal cases come back as a `spoken` line: nothing linked, Home Assistant not heard from, a stranger, two people with that name ("Which one: …?"), not allowed here | "is Sam home?", "waar is Robin?" |
| `people_list` (tool) | none | read, speculative | the household's members and whether each is followed. Never says where anyone is, so it is answered on any device | "who lives here?" |
| `presence.who_is_home` (typed action) | `person?`: a member (a dynamic choice over Members) | read | the same answer as sentences, with no model ("Sam is home. Robin is out."), at most four people and then "and N more" | "who is home", "is Sam home", "wie is er thuis", "is Sam thuis" |

Every sentence the module speaks itself is in English and Dutch, by the household's language.

### Events

| Event | Data | When |
|---|---|---|
| `presence.arrived` | `{ person, at }`: the member's id, epoch ms | at once, when a linked person's state goes from away to `home` |
| `presence.left` | `{ person, at }` | after the **departure delay** (default 3 minutes), if the person is still away |

- A person back within the delay neither left nor arrived: nothing is announced.
- **A snapshot is not news.** The first load, a reconnect or an overflow of Home Assistant's stream never produces an
  event, so a restart of the server or of Home Assistant does not announce everyone as arrived. A state that goes to or
  from `unknown` / `unavailable` is not a departure or an arrival either.
- The delayed departure is a scheduled job, so it survives a restart. When it falls due it looks at Home Assistant
  again and announces nothing if the person is home or no longer known.
- The events say who and when, never where (no zone). They are not sent to voice pages (no event type is declared with
  a projection); other modules on the server may listen.

## Settings

| Field | Meaning | Default |
|---|---|---|
| People (`people`) | up to 20 records: the Home Assistant person (`person.sam`) and the household member (the member's name or id, as in Members). A person or a member may be linked once. Anything else is refused and the module is down with the reason on its page | none |
| Departure delay (`departureDelayMinutes`) | 0 to 60 minutes; 0 announces a departure at once | 3 |

With no people linked, the Health page says so (info) and every answer says that nobody is linked yet.

## What it stores

Nothing. Where a person is lives in Home Assistant, a pending departure is a scheduler job (one per person, key
`left:<entity>`, payload the entity id and when it happened), and no personal content is written to the module's
store. So there is no collection, no migration and no data to forget. The job's payload holds a Home Assistant entity
id and a time, no name.

## What it needs

- `uses: ["home-assistant"]`: the `HomeAssistant` service (a transport; a stub of it in tests). While that module is
  off, tools and the action say "The Home Assistant module is off." and the module watches for it to come back.
- The core services `People` and `Privacy`.
- Home Assistant `person` entities (the companion app, a router tracker, …), exposed to the assistant.
- It has no network requirement of its own, so no `requires`.

## What was left out

Left out of the first version by the plan's row (`docs/MODULES-PLAN.md` §5.1 row 19): rooms (Bermuda, mmWave), voice
identification, guest mode, the house guide, who may ask about whom (adults and children, `home-only` and `exact`),
presence history, `presence.room`, `presence.everyone_left` and `presence.first_home`, and the "welcome home" greeting.

Left out for wave B, because they need a phrase command, a presentation, a notification or the module's own speech
(P7, P9, P10): spoken greetings on arrival, the `list` presentation of who is home, enrolment steps, the Wi-Fi hand-off
and QR code, notifications such as "everyone left and the door is unlocked", and phrase commands for "who is home".

Left out because something is missing, and reported in the pull request:

- The spoken "since" in the typed action's sentence ("since ten past four"): `@pva/language` (`speakTime`, `speakDate`)
  is not a dependency of this package, and the lockfile may not change here. The tool gives the model the time as
  `07:00` (or `2026-11-17 08:00`) and the model words it; the action's sentence leaves it out. Smallest change: add
  `"@pva/language": "workspace:*"` to this package's `package.json`.
- Zone names are never said (see above); the setting that would let a person share them (`exact`) belongs to the
  "who may ask about whom" part.
