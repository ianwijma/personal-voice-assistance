# Clock (`clock`)

The local date and time in every turn's context, and the time elsewhere.

- Package: `packages/modules-builtin`: `src/clock.ts`, and new files only under `src/clock/`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 3 (wave A); extended by the core-tools pull request (the extended `current_time`)
- Research: [docs/research/modules/core-tools.md](../research/modules/core-tools.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

An existing module. The core-tools pull request extends it in `src/clock.ts` and in new files only under
`src/clock/` (exported from `clock.ts`; never other files of `modules-builtin`), and fills in this page
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The clock puts the local date and time in every turn's context, and `current_time` tells the time anywhere. This pull
request extends `current_time` (same name, so an assistant that switched it off stays off) with an `op`:

| `op` | What it answers | Example |
|---|---|---|
| (none) | the original answer, unchanged: `{ timeZone, date, time, iso }`, in the Date format's words | "what time is it in Tokyo" (`timeZone` required, as before) |
| `now` | the time there, said for the ear, with the city | "It's six o'clock in the evening in Tokyo, Wednesday." |
| `convert` | what `time` in `from` on `date` (read in `from`'s zone; absent, today there) is in `timeZone` or `place`, with both dates: `{ from: { timeZone, date, time }, to: { timeZone, date, time, dayOffset? } }` | "On Sunday the fifteenth of March 2026, nine o'clock in the morning in New York is two o'clock in the afternoon in Amsterdam." / "three o'clock in the afternoon in London today is midnight in Tokyo tomorrow." |
| `until`, `since` | days to or from a date | "37 days until Friday the twenty fifth of December." |
| `add` | a date plus `amount` days, weeks, months or years (month ends clamp: 31 January + 1 month is 28 February) | "That is Wednesday the ninth of December." |
| `week` | the ISO week number (the one the Netherlands uses) | "week 47" |

**A wall-clock time is never guessed.** A time the clocks jump over that day is said not to exist ("half past two at
night does not exist in Amsterdam on Sunday the twenty ninth of March 2026: the clocks go forward over it."); a time
they go back over is a question ("… happens twice in Amsterdam on Sunday the twenty fifth of October 2026, because the
clocks go back. Do you mean the earlier one or the later one?"), answered by calling again with `repeat` (`earlier` or
`later`). Both hemispheres are tested (Amsterdam and Sydney).

`place` is a city from a built-in table of about 60 (English and Dutch names: "Londen", "Den Haag") and replaces
`timeZone`; a place that is not in it is a question ("Tell me its time zone, for example Europe/Paris."). Dates are ISO
or words read by `@pva/language` ("3 March", "next monday", "morgen"), which never guesses: an ambiguous one is a
question back ("next friday": "Do you mean Friday or Friday the twenty seventh?").

**Language.** The new operations speak and read dates in **the household's language as it is set now** (Home ›
Language, `HOME_LANGUAGE`, read from the host's view at each call; Dutch is Dutch, anything else English), not the Date
format: a Dutch household with the `en-GB` date format hears Dutch and has "morgen" read as tomorrow. The original
answer (no `op`) keeps the Date format's words, as before. To read the household's language the clock declares module
API version 2; nothing else about it changed (it is on by default, has no shared part, and its `start` still takes the
version 1 context its existing callers give it, in which case the Date format's language is used).

Everything is offline, imports no library (the cut holiday and sun libraries are not imported anywhere), and is
answered in a few milliseconds; loading the clock costs nothing new at start. An existing installation's call
(`current_time` with a `timeZone` only) answers exactly as before (tested).

## Tools

`current_time` (read, speculative, `instant`). Parameters: `timeZone` (required, IANA: the household's own is in the
context line), `op?`, `place?`, `date?`, `time?` (for `convert`), `from?` (for `convert`), `repeat?` (for `convert`: a
time that happens twice), `amount?` and `unit?` (for `add`). Every sentence it speaks itself is in English and Dutch.
The typed action `clock.time_now` ("what time is it", "hoe laat is het in New York") is unchanged.

## Settings

Unchanged: Time zone (follows Home's; empty is this machine's), Date format. Not added: new settings would change what
the existing tests pin (the decoded settings are exactly those two).

## What it stores

Nothing. No personal content.

## What it needs

Nothing outside the process.

## What was left out

- **Public holidays** (`op: "holidays"`): cut; it held the event loop 13 to 43 ms a call and reported regional holidays as ordinary days.
- **Sunrise and sunset** (`op: "sun"`): cut; with only a time zone it silently used another city of that zone.
- **Natural dates in places the Dutch parser does not know**, and `chrono-node` (not a dependency of the package): the
  model may normalise to ISO before calling.
- **Geocoding unusual places, `geo-tz`** (tens of MB): the table of about 60 cities, or an IANA zone, covers it.
- **The "today is a public holiday" context fact** (research §5.2): left out with the holidays.
- **Moon phases, twilight, workdays**, a 12/24-hour speech setting, **the `facts`, `table` and `list` presentations**
  (P10): left out or waiting for wave B.
- **The conformance check:** the clock is an existing module that is on by default, so `checkModule` reports
  `off-by-default` for it, as it did before this change ("with it off, nothing changes" holds only for the modules that
  were off). The extension is tested through the kit's real host and gateway in
  `packages/module-core-tools/test/clock.test.ts`, which imports it by path because `modules-builtin` is not a
  dependency of that package and this pull request may not add one.
