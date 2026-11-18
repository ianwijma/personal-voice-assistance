# Briefing (`briefing`)

A short spoken briefing from the modules the assistant has on.

- Package: `packages/module-briefing`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 17 (wave A)
- Research: [docs/research/modules/briefing.md](../research/modules/briefing.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

Off by default: with it off nothing changes for anyone.

## What it does

"Good morning", "brief me", "what's my day like": it asks every module that offers a briefing section (weather, bin-day,
calendar, news; reminders later) for its sentences **at once**, each within 800 ms, drops the empty ones without a
word, names the ones that failed once ("I couldn't get the weather and news."), puts the important ones first, and
either hands the sections to the model to word (the `briefing` tool) or joins them itself with no model (the typed
action `briefing.brief`).

The sections come from the `BriefingSections` contribution (`packages/module-contracts/src/briefing.ts`), read live
for the asking turn, so only the modules **that turn's assistant has on** are asked. The module owns no data about the
world, no network and no jobs: the sections answer from their own caches, which their own jobs keep fresh.

How the briefing is put together:

- **Order**: lead sections first, then normal ones, filler last (filler only in a `long` briefing). Within each group the
  owner's order (setting *Order of sections*), then by id.
- **Length**: `short` is lead items only, one sentence per section (the first section alone when none leads, so a short
  briefing is never silent); `normal` one or two sentences per section; `long` up to four, with filler. The length
  comes from the call, else the person's own preference, else the assistant's setting.
- **Bounds**: at most 20 sections are asked (more are not), a repeated section id is asked once, and a section that
  answers outside the contract's bounds (too many or too long sentences, a line break, an owner that is not a member
  id, a `withheld` that is not a whole number from 0 to 1,000, an unknown priority) is treated as failed. The total time
  is about one section's limit (800 ms), not the sum, because they run together. The compose step is a few small
  loops over at most 20 sections of at most 4 short sentences: bounded, with no synchronous heavy work.
- **Wording**: the template join says the section sentences one after another, with "Good morning." / "Good evening."
  in front for those kinds, a sentence naming what could not be fetched, and "Some personal items are not read out
  here." (never with a name) when anything personal was held back. English and Dutch.

## Tools

| Tool or action | Risk | What it does | Example phrase |
|---|---|---|---|
| `briefing` (tool) | read | Gathers the sections and returns them (id, title, sentences) for the model to word, with `couldntGet` (titles), `withheld` (a sentence) and `owner` when personal content is in. Parameters: `kind` (`morning`, `evening`, `on-request`), `length` (`short`, `normal`, `long`), `only` (section ids, at most 10). | "Good morning, Jeff." |
| `briefing.brief` (typed action, also the tool `briefing_brief`) | read | The same gathering, with **no model**: returns the template join as its spoken result. Parameters `length` and `kind`, both optional. Examples in English and Dutch ("good morning", "brief me", "give me the short briefing", "goedemorgen", "geef me de briefing"). | "Brief me." / "Goedemorgen." |
| `briefing_prefs` (tool) | change | Remembers this person's briefing length and the sections they leave out or bring back (`length`, `skip`, `unskip`; at most 5 names per call). Asks whose when nobody known is asking and writes nothing. | "Always keep my briefing short." / "Skip the news." |

Leaving out a name leaves out every section of that module: `weather` leaves out `weather` and `weather.rain`.

## Settings

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| Briefing length | choice (short, normal, long), an assistant may own its value | normal | The length when neither the call nor the person says. |
| Order of sections | text list (20 ids) | empty | Section ids in the order they are spoken (listed ids first, the rest after). |
| Sections to leave out | text list (20 ids) | empty | Sections never in a briefing for anyone. |

No secrets. An invalid value (a length that is not one of the three, a list over 20 items) stops the module with the
reason on the Health page, as for every module.

## What it stores

One collection, `preferences`, **person scope**, `maxChars` 1,500, no index (one row per person, read by id, never
listed): `{ length?: "short" | "normal" | "long", skip: string[] (at most 10 section ids of at most 60 characters) }`.
It holds **no personal content**: the names of sections and a length, nothing the sections say. It is the person's
own, so it is kept in their scope: with nobody known asking, it is neither read nor written, and the tool asks whose.
Nothing is scheduled; the module has no jobs.

Privacy of what is *spoken*: each section decides, at the moment of revealing and for the asking device, what it may
say (`Privacy.mayReveal`, or a reduction to a count on a shared device), as the contract says; the briefing never
caches that. As a second guard the briefing keeps a section's sentences **only when the section has no owner or its
owner is the turn's person**; a section naming anyone else is left out, and only counted as withheld. A result with
personal content carries its owner so the gateway can check it.

## What it needs

Nothing outside the process: no network, no key, no program. It **consumes** the `BriefingSections` contribution and
works with none of them (it then says it has no briefing sources, in both languages). It does not name any module in
`uses`: it works, and says what is missing, when a source module is off.

## What was left out

Left out, **waits for wave B** (needs P7, P9 or P10 that do not exist yet):

- The phrase command ("good morning" matched on the device, with no model, as a phrase): today only the typed action
  and the tool exist.
- Cards (the presentation of the sections on a screen, the pinned morning cards).
- Speaking section by section with steering by voice: "skip", "more about that", "carry on" and a resume point after
  barge-in (the module has no speech of its own; the reply is one text).
- A scheduled briefing and a presence-triggered one (notifications, the scheduler delivering speech), and the evening
  low-priority items.

Left out for the plan's row ("Skip and more, scheduled and presence briefings, cards pinned in the morning, 'what did I
miss'"): "what did I miss" and the last-briefing record, per-assistant section lists, a "household briefing" for several
people at a shared device, and the research document's own feeds and watchers (the news module has the feeds; watchers
are not in this wave).

Choices on contract readings (reported in the pull request): `owner` must be the turn's person (conservative); `filler`
is only in `long`; "lead first" is applied before the owner's order, which orders within a priority.
