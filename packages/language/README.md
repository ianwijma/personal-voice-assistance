# @pva/language

English and Dutch helpers every module shares, so that "half acht", "a kilo of rice" and "every second Tuesday" mean the same
thing everywhere. Pure functions with a `language: "en" | "nl"` argument; no global state, no network, no model, no
dependency except `@pva/core` (for `parseDuration`, re-exported). Parsers return `Parsed<T>`: `ok` (`value`, `said`),
`ambiguous` (`candidates`, `reason`, `said`) or `not-understood`; they never throw.

## Parsing

- `parseTimeOfDay(text, language, { band?, afterMinutes? })` → `Parsed<TimeOfDay>` (`hour`, `minute`, `guessed`, `alternatives`).
  English "half seven" is 7:30, Dutch "half zeven" is 6:30 (the hour before); "kwart voor zeven" 6:45; "kwart over zeven" 7:15.
  Without am/pm the reading inside the band (default 07:00–21:00) wins, `guessed` is true and `alternatives` lists the other readings
  inside the band ("seven" → 07:00, alternative 19:00). `afterMinutes` (minutes since midnight now) picks the next reading after now.
  `ambiguous` only when the band holds no reading.
- `parseDateTime(text, language, { now, timeZone, band? })` → `Parsed<DateTimeParsed>`: `date`, `weekday`, `time?`, `instant?`,
  `partOfDay?` ("tonight"), `inPast`, and `start`/`end` offsets in the text. Reads "today", "tomorrow", "on Friday", "the 3rd", "3 March",
  "in two days", "tomorrow at five", "in two hours", "over twee weken", "vrijdag om half acht". **`next Friday` / `volgende vrijdag`
  is `ambiguous`** with both candidates (the coming one and a week later; unambiguous when today is that weekday). "this Friday"/
  "komende vrijdag" is the coming one, a bare "Friday" is the next one after today. A bare time is today if it is still ahead, else tomorrow.
  Daylight saving: a wall-clock time the clocks skip moves forward by the jump, a time that happens twice is the first one.
- `parseQuantity(text, language, { cupMl? })` → `Parsed<Quantity>`: `amount`, `unit`, `dimension` (`mass | volume | count | pack | vague | none`),
  `approx`, `rest`, `base` (grams, millilitres or pieces), `said`, `item` ("rice"). "een ons" is 100 g, "een pond" 500 g (Dutch), a dozen is 12 pieces,
  "a handful"/"some" are `approx`, "the rest" has `rest: true`. `convertAmount(amount, from, to, { cupMl? })` converts within mass or volume
  (a teaspoon is 5 ml, a tablespoon 15 ml, a cup 250 ml unless `cupMl` says 236.588).
- `parseDuration` is core's, re-exported.
- Lower level: `readNumber`, `readAmount`, `readOrdinal`, `matchTime`, `resolveTime`, `tokenize`.

## Speaking

`speakNumber`, `speakAmount(q, language, { item?, humanize? })` ("about 750 grams", "2 liter melk"), `speakDuration(ms, language)` ("6 minutes 10
seconds", "anderhalf uur"), `speakTime(t, language, { style: "12h" | "24h", period? })` ("half past twelve", "kwart over zeven"),
`speakDate(date, language, today)` ("tomorrow", "Friday the third"), `speakMoment`, `speakList(items, language, { max? })` ("a, b and two more"),
`numberToWords`, `ordinalToWords`.

## Recurrence

- `parseRecurrence(text, language, { now, timeZone, defaultTime?, band? })` → `Parsed<Recurrence>` with `rrule` (RFC 5545 value), a `dtstart` line
  (`DTSTART;TZID=…`, the first occurrence after now, matching the rule), `ics`, `time?`. "every second Tuesday" is every other week on Tuesday
  (`INTERVAL=2`); "the second Tuesday of every month" is `BYDAY=2TU`. Dutch: "elke dag", "elke werkdag", "elke tweede dinsdag", "om de week", "op de eerste van de maand".
- `describeRRule(rrule, language, { time?, start? })` says a rule in the same words; `parseRRule` / `formatRRule` / `parseDtstart` read and write it.
- `nextOccurrence(spec, after)` and `occurrencesAfter(spec, after, n)` with `spec = { rrule, dtstart, timeZone }`: DAILY, WEEKLY, MONTHLY, YEARLY
  (and HOURLY, MINUTELY in elapsed time) with INTERVAL, BYDAY (ordinals too), BYMONTHDAY, BYMONTH, COUNT, UNTIL. Hand-written, so there is no `ical.js`
  dependency; unsupported parts (BYSETPOS, BYYEARDAY, WKST other than MO) make `parseRRule` return `undefined`.
