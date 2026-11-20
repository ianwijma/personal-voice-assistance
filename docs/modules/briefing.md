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

## Phrase commands and the list

**Said after the wake phrase, with no model.** `briefing.brief` has phrases, so these run it as it is (same parameters,
same sentences, same risk class `read`) on the device that heard them:

| Language | Phrases |
|---|---|
| English | "good morning", "good evening", "brief me", "give me my briefing" |
| Dutch | "goedemorgen", "goedenavond", "geef me mijn briefing" |

Matching is exact on words: "good night", "good morning please", "good any time", "good the morning", "brief me about
the news" and "goede morgen" are not phrases and go on to the assistant. A refusal or an empty answer is the action's
own ("There is nothing to tell you right now."). **A phrase cannot fix a parameter's value**, so the greetings (both
languages) are plain words that run the action with the kind left out: the same briefing without the "Good morning." /
"Goedemorgen." sentence in front. (That gap stays: a phrase that could carry a fixed value would close it.)

**A phrase's answer fits what a phrase may say.** The host cuts a phrase command's spoken answer at 300 characters. In a
phrase turn (`CurrentTurn.source === "phrase"`) the action therefore builds its answer inside that limit: whole
sections in the briefing's order, with room kept for what it always says (what failed, the cap, what was held back)
and for one closing sentence when something does not fit: "There is more: three more sections. Ask me for the full
briefing." / "Er is meer: nog drie onderdelen. Vraag me om de volledige briefing." A sentence is never cut and nothing
is left out silently; one section that alone is longer than the limit is counted, not cut. What fits whole is exactly
the briefing as before. In any other kind of turn (the intent agent, the model, a routine) the action and the tool
answer exactly as before.

**A phrase heard once acts once.** A call in a phrase turn is remembered by its full identity (assistant, conversation,
turn, device, the action and its resolved input) in a bounded record in the module's shared part (256 finished calls;
one still running is never dropped): a repeat, also one at the same moment, returns the first outcome and shows nothing
again. A new utterance is a new turn and runs again; a call in any other kind of turn runs every time.

**A list on the screen.** Whenever the action answers it also shows a transient `list` on the asking device, 60
seconds, titled "Your briefing" / "Je briefing": one bullet per section that was spoken, in the briefing's order (lead
first), each the section's first sentence when it fits an item whole (80 characters), else the section's title (never
cut). In a phrase answer that did not fit, the list holds exactly the sections that were spoken and counts the rest
("And three more."). After the sections come short notes of what the answer also said: preferences that could not be
read, how many sources failed, how many sections were left out by the cap, and "Some personal items are not shown
here." With more bullets than fit the twelve items, the first ones are kept and "And seven more." says the rest. The
text is data: shown as text, never markup. The presentation's `spoken` ("Your briefing covers weather, calendar and
news.", at most four names, then "and two more") is its fallback text, for a caller that shows it through the
Presenter's note; this action does not hand it to the model: where nothing can be shown it keeps its ordinary spoken
briefing, unchanged.

- **Privacy** is the spoken briefing's: each section already decided what it may say for the asking device, and the list
  holds only that. When any personal content is in, the list is personal with the asker as owner, so the Presenter asks
  `Privacy.mayReveal` for the device that would show it, at the moment of showing: a public screen gets none of it (the
  household's lines too: one list is one decision), a private phone of the owner gets it. A device without a screen
  shows nothing and the spoken answer is unchanged.
- **Updated and withdrawn**: the module keeps one record of the last list of at most 64 devices in its shared part,
  used by every assistant's instance under one lock. A later briefing on that device, by any assistant, replaces the
  list; one with nothing to list (an empty or unknown answer) takes the earlier list down; and when the new list cannot
  be shown, the old one is taken down too (the handle is kept for another try if even that fails), so the screen never
  keeps an outdated list. A restart forgets the record and the Presenter takes a stopped module's transient lists
  down, so nothing is left to withdraw. It has no buttons, ticks or handlers, and sends no notification.
- The model's `briefing` tool shows nothing; only the action does.

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

Left out (what is not here yet):

- Cards on the screen other than the transient list: the pinned morning cards, and the presentation from the model's
  `briefing` tool.
- Speaking section by section with steering by voice: "skip", "more about that", "carry on" and a resume point after
  barge-in (the module has no speech of its own; the reply is one text).
- A scheduled briefing and a presence-triggered one (notifications, the scheduler delivering speech), and the evening
  low-priority items.
- Dutch greeting phrases that carry the kind (see above), and phrases for length ("the short briefing").

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
