# @pva/language

English and Dutch helpers every module shares, so that "half acht", "a kilo of rice" and "every second Tuesday" mean the same
thing everywhere. Pure functions with a `language: "en" | "nl"` argument; no global state, no network, no model, no
dependency except `@pva/core` (for `parseDuration` and its numeric-span rule) and `ical.js` (recurrence expansion). Parsers return
`Parsed<T>`: `ok` (`value`, `said`), `ambiguous` (`candidates`, `reason`, `said`) or `not-understood`; they never throw.

**The rule.** Input the code cannot fully account for is `not-understood` or `ambiguous`, never a confident result built from the part
it recognised. A number is read as core's whole connected expression or not at all (".5 kg", "-2 kg", "1/2 kg", "five five" are not
5, 2, 1 or 5). Every word that says when must be read ("last Friday", "29 February 2027", "Tuesday 3 March 2027" when that is a
Wednesday, "every day except weekends" are refused). A part of the day said with a clock time must agree with it ("07:00 in the
evening" is refused). Word tables are null-prototype, so "constructor" is just a word. An unknown time zone is `not-understood`, never
UTC; a padded or differently cased zone is normalised (`normalizeTimeZone`).

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
  "Wednesday 3 March 2027" checks the weekday; "in two hours and thirty minutes", "in an hour and a half" use core's duration grammar.
  Daylight saving: a wall-clock time the clocks skip moves forward by the jump, a time that happens twice is the first one.
- `parseQuantity(text, language, { cupMl? })` → `Parsed<Quantity>`: `amount`, `unit`, `dimension` (`mass | volume | count | pack | vague | none`),
  `approx`, `rest`, `base` (grams, millilitres or pieces), `said`, `item` ("rice"). "een ons" is 100 g, "een pond" 500 g (Dutch), a dozen is 12 pieces,
  "a handful"/"some" are `approx`, "the rest" has `rest: true`. `convertAmount(amount, from, to, { cupMl? })` converts within mass or volume
  (a teaspoon is 5 ml, a tablespoon 15 ml, a cup 250 ml unless `cupMl` says 236.588).
- `parseDuration` is core's, re-exported.
- Lower level: `readNumber`, `readAmount`, `readOrdinal`, `numbersWhole`, `matchTime`, `resolveTime`, `periodHours`, `tokenize`, `sliceText`,
  `normalizeTimeZone`, `isValidLocal`.

## Speaking

`speakNumber` (two decimals, more below 1 so a nonzero number is never said as 0), `speakAmount(q, language, { item?, humanize? })` ("about 750 grams", "2 liter melk"), `speakDuration(ms, language)` ("6 minutes 10
seconds", "anderhalf uur"), `speakTime(t, language, { style: "12h" | "24h", period? })` ("half past twelve", "kwart over zeven"),
`speakDate(date, language, today)` ("tomorrow", "Friday the third"), `speakMoment`, `speakList(items, language, { max? })` ("a, b and two more"),
`numberToWords`, `ordinalToWords`.

## Recurrence

- `parseRecurrence(text, language, { now, timeZone, defaultTime?, band? })` → `Parsed<Recurrence>` with `rrule` (RFC 5545 value), a `dtstart` line
  (`DTSTART;TZID=…`, the first occurrence after now, matching the rule), `ics`, `time?`, `partOfDay?`, `timeDefaulted`. "every second Tuesday"
  is every other week on Tuesday (`INTERVAL=2`), "every second month" is `FREQ=MONTHLY;INTERVAL=2`, "the second Tuesday of every month" is
  `BYDAY=2TU`, "every 2nd of the month" is `BYMONTHDAY=2`. A part of the day sets the clock: "every evening" is 19:00 (morning 08:00,
  afternoon 14:00, night 22:00, or `defaultTime` when it falls in that part). Exceptions, ends, starts and counts ("except weekends",
  "until December 1st", "3 times") are not built and make the text `not-understood`. `said` is the text as written. Dutch: "elke dag",
  "elke werkdag", "elke tweede dinsdag", "om de week", "op de eerste van de maand", "elke avond".
- `describeRRule(rrule, language, { time?, start? })` says a rule in the same words, every constraint of it, or `undefined`.
- `parseRRule` / `formatRRule` / `parseDtstart` read and write strictly (RFC 5545 §3.3.10: each part once, digits only, ordinals in range and
  only in monthly and yearly rules, not COUNT with UNTIL; DTSTART keeps seconds and UTC, refuses dates that do not exist). Read and
  expanded: FREQ MINUTELY to YEARLY, INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY, BYDAY (ordinals too), BYHOUR, BYMINUTE, BYSETPOS (monthly and
  weekly), WKST. Not read (`undefined`): SECONDLY, BYSECOND, BYWEEKNO, BYYEARDAY, X- parts, and the few combinations named in `parseRRule`.
- `nextOccurrence(spec, after)` and `occurrencesAfter(spec, after, n)` with `spec = { rrule, dtstart, timeZone }` expand with `ical.js` on
  wall-clock times, each then turned into an instant in the zone (09:00 stays 09:00 across daylight saving; a time the clocks skip is read
  with the offset before the gap, RFC 5545 §3.3.10 and §3.3.5). YEARLY rules are rewritten first, because `ical.js` 2.2.1 expands several
  of them wrongly (see `Rrule.ts`). HOURLY and MINUTELY rules without BY parts run in elapsed time. A UTC DTSTART runs in UTC; a TZID that
  disagrees with `timeZone` gives no occurrence. Long series cost little: an unbounded HOURLY or MINUTELY rule starts just before `after`.
