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
| (none) | the original answer, unchanged: `{ timeZone, date, time, iso }` | "what time is it in Tokyo" (`timeZone` required, as before) |
| `now` | the time there, said for the ear, with the city | "It's six o'clock in the evening in Tokyo, Wednesday." |
| `convert` | what `time` in `from` is in `timeZone` or `place`, across midnight | "three o'clock in the afternoon in London is midnight in Tokyo." |
| `until`, `since` | days to or from a date | "37 days until Friday the twenty fifth of December." |
| `add` | a date plus `amount` days, weeks, months or years (month ends clamp: 31 January + 1 month is 28 February) | "That is Wednesday the ninth of December." |
| `week` | the ISO week number (the one the Netherlands uses) | "week 47" |
| `holidays` | the next public holiday, or whether `date` is one, in the household's language (`date-holidays`) | "Yes, Monday the twenty seventh of April 2026 is a public holiday: King’s Day." |
| `sun` | sunrise and sunset in the zone's own time (`suncalc`) | "Sunrise is at … and sunset at …" (each said as a time, in the zone asked for) |

`place` is a city from a built-in table of about 60 (English and Dutch names: "Londen", "Den Haag") and replaces
`timeZone`; a place that is not in it is a question ("Tell me its time zone, for example Europe/Paris."). Dates are ISO
or words read by `@pva/language` ("3 March", "next monday", "morgen"), which never guesses: an ambiguous one is a
question back. The spoken language is the Date format setting's: `nl-NL` is Dutch, anything else English. Everything is
offline and answered in a few milliseconds; the holiday and sun libraries are loaded the first time they are used.

## Tools

`current_time` (read, speculative, `instant`). Parameters: `timeZone` (required, IANA: the household's own is in the
context line), `op?`, `place?`, `date?`, `time?` (for `convert`), `from?` (for `convert`), `amount?` and `unit?` (for
`add`), `country?` (for `holidays`; default the zone's country from the table). Every sentence it speaks itself is in
English and Dutch. The typed action `clock.time_now` ("what time is it", "hoe laat is het in New York") is unchanged.

## Settings

Unchanged: Time zone (follows Home's; empty is this machine's), Date format. Not added: new settings would change what
the existing tests pin (the decoded settings are exactly those two), so the holiday country comes from the zone and the
sun times use the first table city in the household's zone (Amsterdam for `Europe/Amsterdam`, a few minutes from any
other Dutch city).

## What it stores

Nothing. No personal content.

## What it needs

Nothing outside the process.

## What was left out

- **Natural dates in places the Dutch parser does not know**, and `chrono-node` (not a dependency of the package): the
  model may normalise to ISO before calling.
- **Geocoding unusual places, `geo-tz`** (tens of MB): the table of about 60 cities, or an IANA zone, covers it; the sun
  needs a city of the table.
- **The "today is a public holiday" context fact** (research §5.2): the context line is per turn and is the existing
  module's; adding to it changes what the existing test pins.
- **Moon phases, twilight, workdays**, a 12/24-hour speech setting, **the `facts`, `table` and `list` presentations**
  (P10): left out or waiting for wave B.
- **The conformance check:** the clock is a version 1 module that is on by default, so `checkModule` reports `api-version`
  and `off-by-default` for it, as it did before this change (the existing tests start it as version 1, and "with it off,
  nothing changes" holds only for the modules that were off). The extension is tested through the kit's real host and
  gateway in `packages/module-core-tools/test/clock.test.ts`, which imports it by path because `modules-builtin` is not
  a dependency of that package and this pull request may not add one.
