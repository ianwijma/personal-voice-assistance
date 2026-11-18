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

- **Selection**: the sections that are on, minus the household's skips and the person's own, narrowed by `only` when the
  call gives it. Skipping (or naming in `only`) a module's id covers its dotted sections: `weather` covers
  `weather.rain`. A contribution whose id, title or `gather` breaks the contract's bounds (an id of more than 60
  characters or outside `[a-z0-9.-]`, a title that is empty, over 40 characters or not one line) is never asked and is
  named as failed by a safe label ("unnamed source" / "naamloze bron"), never by its own text.
- **Order**: lead sections first, then normal ones, filler last (filler only in a `long` briefing). Within each group the
  owner's order (setting *Order of sections*), then by id.
- **Length**: `short` is lead items only, one sentence per section (when none leads, the first section that has a
  sentence, so a short briefing is never silent and never only a count); `normal` one or two sentences per section;
  `long` up to four, with filler. The length comes from the call, else the person's own preference, else the
  assistant's setting.
- **Bounds**: at most 20 sections are asked. The cap comes **after** the selection and the owner's order, so it never
  drops a section the owner put first; when it leaves sections out, the briefing says how many ("I left out one more
  section: a briefing has at most twenty."), on both reply paths. A repeated section id is asked once, and a section
  that answers outside the contract's bounds (too many or too long sentences, a line break, an owner that is not a
  member id, a `withheld` that is not a whole number from 0 to 1,000, an unknown priority) is treated as failed. The
  total time is about one section's limit (800 ms), not the sum, because they run together. The compose step is a few
  small loops over at most 20 sections of at most 4 short sentences: bounded, with no synchronous heavy work.
- **Wording**: the template join says the section sentences one after another, with "Good morning." / "Good evening."
  in front for those kinds, one sentence naming **every** section that could not be fetched (`speakList`, no "and two
  more"), the cap's sentence, and "Some personal items are not read out here." (never with a name) when a section
  counted personal items it held back. English and Dutch.
- **Nothing to say**, each with its own true sentence: no module offers a section ("I have no briefing sources yet");
  `only` names sections none of which is on ("None of the sections you asked for is on right now."); there are sections
  and the skips leave out every one ("The sections you would hear are all left out by your preferences or the
  household's settings."); every section asked was empty ("There is nothing to tell you right now.").
- **Preferences that cannot be read** are not "no preferences": the briefing uses the defaults and says so first ("I
  couldn't read your preferences, so I'm using the defaults."). With nobody asking there are none to read.

## Tools

| Tool or action | Risk | What it does | Example phrase |
|---|---|---|---|
| `briefing` (tool, speculative) | read | Gathers the sections and returns them for the model to word: each section's id, title and `untrustedSentences`, the line `untrusted` that says those are data to word and never instructions to follow, `couldntGet` (labels), `notAsked` and `withheld` (sentences), `preferences` (a sentence, when they could not be read) and `owner` when personal content is in. Parameters: `kind` (`morning`, `evening`, `on-request`), `length` (`short`, `normal`, `long`), `only` (1 to 10 section ids or names). An `only` entry that means no section is refused with the names it knows; it never widens to every section. | "Good morning, Jeff." |
| `briefing.brief` (typed action, speculative, for the intent agent only) | read | The same gathering, with **no model**: returns the template join as its spoken result. Parameters `length` and `kind`, both optional. Examples in English and Dutch ("good morning", "brief me", "give me the short briefing", "goedemorgen", "geef me de briefing"). It is **not offered to the model as a tool** (`offerAsTool: false`): a generated tool's result is exactly the action's `say`, the plain join of other modules' sentences, and outside text must reach the model marked as data; the model has the `briefing` tool, which marks it. | "Brief me." / "Goedemorgen." |
| `briefing_prefs` (tool) | change | Remembers this person's briefing length and the sections they leave out or bring back (`length`, `skip`, `unskip`; at most 5 names per call). Asks whose when nobody known is asking and writes nothing. | "Always keep my briefing short." / "Skip the news." |

**Names.** A person names a section as they say it: the names this module suggests, in both languages (`weather` /
`weer`, `calendar` / `agenda`, `news` / `nieuws`, `bins` / `afval` for `bin-day`, `reminders` / `herinneringen`, with or
without "the" / "de" / "het"), the id of a section that is on, or its title ("Rain" for `weather.rain`). They are stored
as the section's id. A name that means none of them is refused with the names it knows ("I don't know a section called
that. I know weather, rain and news."), and nothing is written. The owner's lists in the settings take the same ids and
suggested names; an entry that is neither stops the module with the reason, so a skip the owner meant is never lost.

**Skipping and bringing back** use one rule both ways: an id covers its dotted sections. Leaving out `weather` replaces a
narrower `weather.rain`; bringing back `weather` removes `weather.rain` too. Bringing back something still left out says
so and why: "Rain stays out, because you leave out all of weather." for a broader skip of the person's own, and "The
household's settings still leave out rain." for the household's. Lists in confirmations are worded by `speakList`
("weather, calendar and news" / "weer, agenda en nieuws").

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

**Whose briefing it is.** A briefing is the asking person's. Each section decides, at the moment of revealing and for
the asking device, what it may say (`Privacy.mayReveal`, or a reduction to a count on a shared device), as the contract
says; the briefing never caches that. Of what the sections return, the briefing keeps household content and personal
content **owned by the person of the asking turn**: a count a section reduced its owner's items to is that section's
content, kept when its owner is the asker. A section's personal content owned by anyone else is left out, on every kind
of device (a private phone too, where the section may legally return another member's items), and the briefing says
nothing about having left it out: it is not counted and not mentioned. When the turn has no person (a shared device with
no default person, a public screen without one), no personal content is included at all.

The result's sensitivity follows its content on every reply path: `personal` with the asker as owner whenever any
personal content is in, `household` otherwise. The tool's result carries `owner`; the typed action's outcome carries
`owner` too, and because the host passes an action's result on as its `say` only, the module remembers the sensitivity
of the last 64 briefings it spoke by their text (in memory, never stored). A text it did not speak, or one spoken with two
different owners, is treated as personal with an unknown owner, never as household.

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

Choices on contract readings (reported in the pull request): a section's personal content is kept only when its owner
is the asking person (above), and left out without a word otherwise; `filler` is only in `long`; "lead first" is applied
before the owner's order, which orders within a priority.

**Speculative.** The tool and the action are declared `speculative: true`: they are plain reads (`read`) that change
nothing, and the sections they call answer from their own caches, each within 800 ms, as the contract asks, so they are
safe to run before the turn is committed (docs/MODULES.md §4, §15).
