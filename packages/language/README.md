# @pva/language

English (British conventions) and Dutch helpers every module shares, so that "half acht", "a kilo of rice" and "every second
Tuesday" mean the same thing everywhere. Pure functions with a `language: "en" | "nl"` argument: no global state, no network, no
model, no dependency. Every claim below is backed by a test; the table at the end says which.

## The rules

**A parser reads a whole phrase of its kind, or nothing.** Each parser's input is a phrase that is only that kind of expression: a
number, a duration, a time, a date-time, a quantity, a recurrence. It is read by a closed grammar (below): a reading counts only if it
uses every word, so a negation, a bound, an alternative, a second expression, a time zone or a word no rule reads makes the answer
`not-understood`, without being named anywhere. Nothing is answered from the part that was recognised. Nothing here searches a
longer sentence: the caller passes the phrase on its own (a tool parameter, a typed slot) and keeps the rest; there is no span to
cut out. A list of quantities is split by the caller first.

**Words.** Between words only spaces and the punctuation `, . ! ?` (not right before digits: ".5" is refused); a hyphen only between
two words ("twenty-one"); an apostrophe before a word only before Dutch "s" ("'s avonds"). An apostrophe inside a word is part of it
and is never repaired away: the grammar's words that have one are "o'clock", "zo'n" and Dutch "kilo's" (each also accepted without it:
"oclock", "zon", "kilos"; `’` is the same as `'`), and an item word may have one ("baker's flour"); any other ("tw'o", "s'o'm'e") is a
word no rule reads. Digits may run into a word ("5kg", "7pm"); a word never runs into digits ("x3", "1e3"). Anything else — a sign, "½", a slash, a bracket, a quote, digits that are not ASCII — makes the phrase
unreadable. Case and accents do not matter, also decomposed ("tweeënhalf" in NFD). Punctuation has no meaning: "every Monday,
Wednesday" and "every Monday Wednesday" are the same list. Word tables are null-prototype: "constructor" is a word no rule reads.

**One front door per function, with a validated domain.** Every exported function checks its data first and answers outside its
domain with its failure value — a parser `not-understood`, a speaker `undefined` ("cannot say this"; never `""`, never "NaN"), a
rule reader `invalid` or `unsupported`, an expansion `undefined`. Which arguments are data, and what is the caller's to get right, is
the first paragraph of the domain below. An unexpected exception inside a function is caught, counted and answered with the failure
value; the fuzz test asserts the count stays 0.

**Nothing leaves the supported domain.** Every date returned is a local date in 2000–2199; every instant's local date is too.
Recurrence expansion stops at 31 December 2199 and says so (`stop: "range"`). A conversion that would underflow, overflow or lose
precision is refused.

## The domain

**Text and numbers are data and may be anything: any string as the phrase to parse, any `number` (`NaN`, the infinities, `-0`, values
outside the range below) wherever a number, an instant or an amount is passed, and any string where a time zone is passed get the
function's failure value below, never a throw. Everything else — the language, style and option objects, units, rule objects, lists —
is the caller's code, checked by the TypeScript compiler, and must have its declared type; a value of another type there (a `null`
style, a sparse array, a unit that is not a string) is a programming error, and the function may throw a `TypeError` or misbehave.**

| Function | Its data must be | Outside |
|---|---|---|
| every parser | `text` a string of at most 200 characters and 40 words | `not-understood` |
| `parseNumber` | — | — |
| `parseDuration` | (the value: whole milliseconds, more than 0, at most 365 days) | `not-understood` |
| `parseTimeOfDay` | `band` `{ from, to }`, each exactly "HH:MM" (no other spelling: "0730" and " 07:30" are not) or whole minutes 0–1439, `from` ≤ `to`; `afterMinutes` whole 0–1439 | `not-understood` |
| `parseDateTime`, `parseRecurrence` | `now` a number or a Date whose local date in `timeZone` is in 2000–2199; `timeZone` an IANA name this machine knows (not an offset); `band` as above; `defaultTime` whole hour 0–23 and minute 0–59 | `not-understood` |
| `parseQuantity` | `cupMl` a number from 50 to 1000 | `not-understood` |
| `convertAmount` | `amount` 0 or 0.000001–1 000 000 000 in size; units of one kind; `cupMl` as above (the result: 12 significant digits, never 0 for an amount that is not 0, at most 1e12) | `undefined` |
| `speakNumber` | a finite number, at most 999 999.99 in size (the number given, before rounding: 999 999.994 is outside), 0 or not rounding to 0 at two decimals | `undefined` |
| `speakAmount` | `amount` a positive number that is whole hundredths of the unit it is said in (after humanising) and that `speakNumber` says, `unit` (Dutch: not `oz` or `lb`), or no amount ("some", with an item) or `rest`; `item` at most 200 characters | `undefined` |
| `speakDuration` | a number of milliseconds that rounds to 1 second – 365 days | `undefined` |
| `speakTime` | whole `hour` 0–23 and `minute` 0–59; `style` `"12h"` or `"24h"` | `undefined` |
| `speakDate`, `speakMoment` | real dates in 2000–2199 (and a time as above) | `undefined` |
| `speakList` | 1–100 strings of 1–200 characters, not only spaces; `max` whole, at least 2 | `undefined` |
| `numberToWords` / `ordinalToWords` | a whole number 0–999 999 / 1–31 | `undefined` |
| `parseRRule`, `parseDtstart` | a string of at most 500 characters; dates (DTSTART, UNTIL) in 2000–2199 | `invalid` / `unsupported` / `undefined` |
| `formatRRule`, `formatDtstart` | a rule of the supported set / a real date-time in 2000–2199 and a known zone | `undefined` |
| `readSeries`, `occurrencesAfter`, `nextOccurrence`, `seriesAfter` | a spec (`seriesAfter`: a series) `readSeries` accepts; `after` a number that is not NaN (or a Date for `nextOccurrence`); `limit` whole 1–10 000 | `invalid` / `unsupported` / `undefined` |
| `describeRRule` | a rule of the supported set; `start` a real date the rule selects (required for an interval above one and for a plain weekly, monthly or yearly rule); `time` a clock time; `timeZone`, when given, a zone this machine knows (required for UNTIL) | `undefined` |
| `normalizeTimeZone` | a string of at most 64 characters | `undefined` |

## Numbers (`parseNumber(text, language)` → `Parsed<number>`)

One number grammar per language; every parser that reads a number uses it, and `parseNumber` reads a phrase that is only a number.
- **Digits**: 0 to 999 999, no leading zero, at most two decimals, the language's separators only: English "1,500" and "2.5", Dutch
  "1.500" and "2,5". One separator followed by three digits is the other language's thousands, so English "1.000" and Dutch "1,000"
  are no number (not 1).
- **English words**: "zero", and 1–999 999 by British rules: "twenty five", "a hundred", "two hundred and five", "two hundred five",
  "one thousand and five", "a thousand", "two thousand three hundred" (after "thousand" the hundreds take a number word: "a thousand
  a hundred" is no number); then optionally "point" and one or two digit words ("two point five").
- **Dutch words**: one word as it is written ("vijfentwintig", "tweehonderd", "tweeduizend driehonderd"), or spaced parts that join
  into one ("vijf en twintig", "twee honderd"), each part itself a number word or "en"; "eenhonderd" and "eenduizend" are not written
  so; then optionally "komma" and one or two digit words. There is no limit on the parts but the number's own: the joined word must be
  a written number up to 999 999, so the most is eleven ("negen honderd negen en negentig duizend negen honderd negen en negentig").
- A sign word: "minus five", "min 2,5" ("minus zero" is not a number).
- Not a number: "5 five", "five five", "one thousand two thousand", "twenty thirty", "1e3", three decimals, a million.

Inside the other grammars an **amount** is a number or a number with a spoken fraction: English "two and a half"; Dutch "twee en een
half", "tweeënhalf", "anderhalf", "een half", "een kwart", "driekwart"; English "half", "a quarter of", "three quarters of" before
"a" / "an" and a unit ("half an hour", "half a kilo").

## Durations (`parseDuration(text, language)` → `Parsed<number>`, milliseconds)

The package's own grammar (not core's); the same production reads a duration inside a date ("in two hours and thirty minutes"). One
or more parts, largest unit first, each unit once, optionally joined by "and" / "en":
- English part: AMOUNT UNIT ("2 hours", "1.5 hours", "two and a half hours"); "a" / "an" UNIT ["and a half"] ("an hour and a half");
  "half" / "a quarter of" / "three quarters of" "a" / "an" UNIT ("half an hour", "a quarter of an hour"). Units: week, day, hour,
  minute, second, singular or plural.
- Dutch part: AMOUNT UNIT ("2 uur", "anderhalf uur", "een half uur", "drie kwartier"); "een" UNIT. Units: week / weken, dag / dagen,
  uur / uren, kwartier (15 minutes, between the hour and the minute), minuut / minuten, seconde / seconden.
- The value is whole milliseconds, more than 0, at most 365 days: "1 day 12 hours" is 36 hours, "three quarters of an hour" 45 minutes.
  It is computed exactly (every amount is whole hundredths), so "128.05 days" is 11 063 520 000 ms, not refused or rounded.

## Time of day (`parseTimeOfDay(text, language, { band?, afterMinutes? })` → `Parsed<TimeOfDay>`)

`["at" | "om"] TIME [PART OF THE DAY]`, `TimeOfDay` = `hour`, `minute`, `guessed`, `alternatives`.
- English TIME: a clock in digits ("7:30", "19.30", "07:00"); "noon", "midday", "midnight"; MINUTES "past" / "to" HOUR (MINUTES: five,
  ten, quarter, a quarter, twenty, twenty five, or 1–29 with "minutes": "seven minutes to eight"; "half past"; "seven to eight" is a
  range, not 7:53); "half" HOUR (British: "half seven" is 7:30); HOUR "o'clock"; HOUR "hundred" (10–23, "oh nine", "zero": the 24-hour
  clock, "ten hundred"); HOUR MINUTES ("seven thirty", "nineteen forty five", "oh seven fifteen", "seven oh five"); a bare hour.
- Dutch TIME: a clock in digits; "middernacht"; MINUTES "over" / "voor" HOUR (vijf, tien, kwart, or 1–29 with "minuten"); "vijf" /
  "tien" "over" / "voor" "half" HOUR ("vijf voor half acht" is 7:25); "half" HOUR ("half acht" is 7:30); HOUR "uur" [MINUTES]
  ("negentien uur dertig"); a bare hour.
- PART OF THE DAY: English "am", "pm", "in the morning", "in the afternoon", "in the evening", "at night"; Dutch "'s ochtends",
  "'s morgens", "'s middags", "'s avonds", "'s nachts", "in de ochtend", "in de middag", "in de avond", "in de nacht".
- An hour the words settle (0, 13–23, a leading zero, "oh", "zero", "hundred", noon, midnight) stays, and a part of the day said with
  it must cover it ("07:00 am" and "13 pm" are read, "07:00 pm" is not). An open hour (1–12) takes the part of the day said; without
  one, the reading inside the band (default 07:00–21:00) wins — the next after `afterMinutes`, else the earliest — `guessed` is true
  and `alternatives` lists the other reading inside the band; `ambiguous` only when the band holds neither. "24:00" is refused here.

## Dates and times (`parseDateTime(text, language, { now, timeZone, band? })` → `Parsed<DateTimeValue>`)

`DateTimeValue` = `date`, `weekday`, `time?`, `instant?`, `partOfDay?`, `inPast`. At most one date and at most one time, in either
order, and nothing else.
- A **day word**: "today", "tomorrow", "yesterday", "tonight", "this morning", "this afternoon", "this evening", "the day after
  tomorrow"; Dutch "vandaag", "morgen", "overmorgen", "gisteren", "eergisteren", "vanochtend", "vanmorgen", "vanmiddag", "vanavond",
  "vannacht", "morgenochtend", "morgenmiddag", "morgenavond", "morgennacht".
- A **weekday**, optionally after "on" / "op": [this | coming | next; deze | komende | aanstaande | volgende] WEEKDAY; WEEKDAY "next
  week" / "volgende week"; WEEKDAY DATE (the weekday must be the date's); Dutch weekday and part in one word ("vrijdagavond"). "this
  Friday" is the coming one (today on a Friday), a bare "Friday" the next one after today, **"next Friday" is `ambiguous`** (the coming
  one and the one after; on a Friday, a week on).
- A **calendar date**, optionally after "on" / "op": English [the] DAY [of] MONTH [YEAR], MONTH [the] DAY [YEAR], "the" ORDINAL ["of
  the month"]; Dutch [de] DAY MONTH [YEAR], "de" ORDINAL ["van de maand"]. DAY: an ordinal ("third", "3rd", "derde", "3e") or a number
  1–31; YEAR: four digits 2000–2199. Without a year: the next such date from today. A date that does not exist is refused.
- A **relative date**: "in" / "over" N day(s) / week(s) / month(s) / year(s) (N 1–999), "in a week", "over een maand" (a date, the day
  of the month clamped); "in" / "over" a DURATION of hours, quarters, minutes and seconds only (a moment: now plus the duration).
- A date may take a part of the day after it, once: "tomorrow evening", "Friday night", "Friday in the evening", "vrijdag 's avonds".
- A **time**: `"at" | "om"` and the time of day; without "at" only a time that is not a bare number, or a bare number that is the
  whole phrase. "24:00" (and Dutch "24 uur") is 00:00 of the next day.
- A time without a date is the next moment after now it names (both readings of a repeated hour considered). A dated time takes the
  first of a repeated hour, except today, where it takes the one after now. A time the clocks skip moves forward by the jump.
- The small hours after a day's night are the next day's: "Friday night at 1" is Saturday 01:00; said in those small hours themselves
  ("vannacht om drie uur" at 01:00) it is this night. **"midnight" with a date is `ambiguous`** (its start or its end), except with a
  night: "tonight at midnight" is the end of today, also when said at 01:00.
- Refused: "next week" alone, "last Friday", "this weekend", "in 2 weeks and 3 days", "tomorrow, Thursday", "in two hours at five".

## Quantities (`parseQuantity(text, language, { cupMl? })` → `Parsed<Quantity>`)

`Quantity` = `amount?`, `unit?`, `dimension` (`mass | volume | count | pack | vague | none`), `approx`, `rest`, `base?` (grams,
millilitres or pieces, 12 significant digits), `said`, `item`.
- `[APPROXIMATOR] AMOUNT UNIT [of] [ITEM]`, `[APPROXIMATOR] a/an/een UNIT [of] [ITEM]`, `[APPROXIMATOR] half / a quarter of / three
  quarters of a/an UNIT [of] [ITEM]` (English), `[APPROXIMATOR] NUMBER ITEM` (a count: "two apples"; a Dutch "een" alone is the article: "een
  appel" is not a quantity), `SOME ITEM`, `the rest [of [the] ITEM]` / `de rest [van [de | het] ITEM]`. "of" only in English, after a
  unit or "the rest".
- Approximators: "about", "around", "roughly", "approximately"; "ongeveer", "circa", "zo'n". Some: "some", "a bit of", "a few", "a
  couple of", "a lot of"; "wat", "een beetje", "een paar", "veel".
- Units (`unitTable` in `src/Quantity.ts`): English g, gram(s), kg, kilo(s), kilogram(s), oz, ounce(s), lb(s), pound(s), ml, cl, dl, l,
  millilitre(s), centilitre(s), decilitre(s), litre(s), liter(s), tsp, teaspoon(s), tbsp, tablespoon(s), cup(s), piece(s), dozen (12),
  pack(s), packet(s), bag(s), bottle(s), can(s), tin(s), jar(s), bunch(es), loaf / loaves, box(es), tub(s), roll(s), handful(s),
  pinch(es), splash(es); Dutch g, gram, kg, kilo('s), kilogram, ons (100 g), pond (500 g), ml, cl, dl, l, milliliter, centiliter,
  deciliter, liter, tl, theelepel(s), el, eetlepel(s), kopje(s), stuk(s), dozijn, pak(ken), pakje(s), zak(ken), zakje(s), fles(sen),
  blik(ken), blikje(s), pot(ten), potje(s), bos(sen), brood / broden, doos / dozen, bak(ken), bakje(s), rol(len), handvol,
  snufje(s), scheutje(s). A handful, a pinch, a splash are `approx` (vague by themselves). A cup is `cupMl` (default 250; US 236.588).
- The **item** is one or more words, none of them reserved, and is the text from its first word to its last as written. Reserved:
  every word of this grammar (numbers, fractions, units, approximators, "some" words, "rest", articles, "of" / "van"), "x", Dutch "lb",
  "lbs", "oz", and conjunctions, negations and bounds (`reservedItemWords` in `src/Quantity.ts`). So "2 kg flour and 3 eggs",
  "2 kg flour, some sugar", "2 kg salt and pepper", "less than 2 kg flour" are `not-understood`: two items, or a changed amount.
- `convertAmount(amount, from, to, { cupMl? })` converts within mass or volume (a teaspoon is 5 ml, a tablespoon 15 ml).

## Speaking

Speak-then-parse is promised for exactly four things: clock times, dates, durations and numbers. The other speakers are for speaking;
what each promises instead is in the table.

| Speaker | Output | Promise |
|---|---|---|
| `speakNumber(n, language, { words? })` | "2.5" / "2,5" (two decimals, trailing zeros dropped), "minus 3"; words: "forty two point five" | reads back with `parseNumber` to the number rounded to two decimals |
| `numberToWords(n, language)` | "forty two", "tweeduizend driehonderd" | reads back with `parseNumber` |
| `speakDuration(ms, language)` | "6 minutes 10 seconds", "1 day 12 hours", "half an hour", "anderhalf uur" | reads back with `parseDuration` to the duration rounded to the second |
| `speakTime(t, language, { style, period })` | "half past seven", "kwart over zeven", "nineteen thirty", "negentien uur dertig", "seven o'clock in the evening" | reads back with `parseTimeOfDay` in its default context (no band, so 07:00–21:00; no `afterMinutes`): "12h" with `period`, exactly and not guessed; "24h" with `period` (which an hour 1–12 then says: "een uur dertig 's nachts", "ten thirty in the morning"), exactly and not guessed; "24h" without `period`, exactly and not guessed when the words settle the hour (English all but 10–12 with minutes, Dutch 0 and 13–23), else the same clock reading modulo 12 hours, guessed, as the band reads it (Dutch "een uur dertig", said for 01:30, is 13:30); "12h" without `period`, the same clock reading modulo 12 hours, guessed, as the band reads it (English noon and midnight and Dutch middernacht exact, not guessed). "As the band reads it": the readings returned are those of the two the band holds, so the time itself is among them exactly when it is inside the band |
| `speakDate(date, language, today)` | "today", "tomorrow", "Friday", "Friday the third", "Friday the third of March 2027"; Dutch "overmorgen", "vrijdag 3 maart" | reads back with `parseDateTime` at `now` on `today`, to the date |
| `speakAmount(q, language, { item?, humanize? })` | "about 750 grams of rice", "2 kilo bloem", "a pack of milk", "3 apples", "some rice", "the rest of the rice" | **never another quantity than it was given**: nothing is rounded — an amount that is not whole hundredths of the unit it is said in (after humanising) is `undefined`; humanising only changes the unit when the amount stays exact (1500 g is "1.5 kilograms", 1.234 kg "1234 grams", 0.25 kg "250 grams"; with `humanize: false` 1.234 kg is `undefined`); "about" / "ongeveer" only when `approx` is true (a handful, a pinch, a splash are vague by themselves and say no "about"). Not promised to read back |
| `describeRRule(rule, language, { time?, start?, timeZone? })` | "every day", "every weekday", "every second Tuesday, from 17 November 2026", "on the first of every month", "the last Friday of every month", "every year on the third of March" | **states every constraint of the rule, or is `undefined`**: frequency and interval, and for an interval above one its phase (", from 20 November 2026" / ", vanaf 20 november 2026": the first day, from `start`); the weekdays, days of the month, ordinal weekday or date (a plain rule's from `start`); the time with `time` (midnight as "00:00"); a COUNT (", 5 times") or UNTIL (", until 31 December 2027 at 23:00", in `timeZone`; an UNTIL in an hour the zone's clocks repeat is `undefined`, since the words could not say which of the two it is). Not promised to read back |
| `speakMoment(value, language, today)` | "tomorrow at half past seven" | not promised to read back |
| `speakList(items, language, { max? })` | "a, b and c", "a, b and two more" | no parser |

## Recurrence

This helper stores what a person says and computes the next occurrence. It is not a general iCalendar engine: calendar events from
elsewhere are expanded by the calendar module with its own library.

**Supported rule shapes** (RFC 5545 §3.3.10), and nothing else:

| FREQ | BY parts | Without BY parts |
|---|---|---|
| `DAILY` | none | every day |
| `WEEKLY` | `BYDAY` of plain weekdays (`MO,WE,FR`) | DTSTART's weekday |
| `MONTHLY` | `BYMONTHDAY` of 1–31 and/or -1 (the last day), or one `BYDAY` with an ordinal 1–5 or -1 (`2TU`, `-1FR`) | DTSTART's day of the month |
| `YEARLY` | one `BYMONTH`, with or without one `BYMONTHDAY` 1–31 | DTSTART's month and day |

each with `INTERVAL` (1–999), optionally `COUNT` (1–1000) or `UNTIL` (a UTC date-time `YYYYMMDDTHHMMSSZ` in 2000–2199, not before
DTSTART), and `WKST` only as `MO`. `DTSTART` is `DTSTART;TZID=<the series' zone>:YYYYMMDDTHHMMSS` in 2000–2199 and must itself be an
instance. `parseRRule` returns `ok` exactly for a rule of this set written by RFC 5545's grammar (a month or a day of the month in one
or two digits: "BYMONTH=003" is not `ok`), and never `ok` for anything else. Anything else is `unsupported` or `invalid`, each with a
reason for a person to read; **which of the two is a hint, not a contract**: `unsupported` is meant for valid RFC 5545 outside this
set (`SECONDLY`, `MINUTELY`, `HOURLY`, `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, X- parts, another `WKST`,
several `BYMONTH`s, `BYMONTHDAY` without `BYMONTH` in a yearly rule, a plain weekday in a monthly rule, a date-only or floating
`UNTIL`, a date outside 2000–2199) and `invalid` for what is not RFC 5545 ("BYHOUR=99", "UNTIL=20270230"), but a rule that is outside
the set and also malformed, or at a limit of the format, may be reported either way. `formatRRule` writes only rules of the set; `parseRRule(formatRRule(rule))` gives the rule back.
`readSeries(spec)` checks a stored series as a whole (`invalid` when the TZID is not the series' zone, DTSTART is not an instance, or
UNTIL is before DTSTART; an UNTIL at DTSTART leaves that one instance).

**Semantics**, by RFC 5545 §3.3.10 and §3.8.5.3, for DTSTART at local date S and time T: an instance is (d, T) for each local day d ≥ S
the rule's BY parts (or the defaults above) select, in a period (day, Monday-to-Sunday week, month, year) whose distance from S's
period is a multiple of `INTERVAL`, counted whether or not a period has an instance. A month or year without the day has no instance
then (no moving). `COUNT` counts distinct instants from DTSTART; `UNTIL` keeps those at or before it. A time the clocks skip is taken
at the offset before the gap (02:30 on the spring day in Amsterdam is 03:30); a time that happens twice is the first. A day a zone
skips altogether (Pacific/Apia, 30 December 2011) lands on the next day's instant: one instance. Instances are increasing, none twice.

`occurrencesAfter(spec, after, limit)` → `Occurrences | undefined`: `instants` strictly after `after` (at most `limit`, default 1,
up to 10 000) and `stop`, in this order: `limit` (as many as were asked for, also when the last of them ended the series), `series`
(the series has ended: its COUNT-th instance is in the list or before `after`, or its UNTIL is passed — also when that happens at the
end of the supported years) or `range` (31 December 2199 reached while the series goes on past it: with UNTIL, only when a day after 2199 that the rule selects, in phase, has its instant at or before UNTIL — in a zone far east, the first days of 2200 can). `undefined` when `readSeries`
refuses the spec, `after` is NaN or `limit` is out of range. `seriesAfter(series, after, limit)` → `Occurrences | undefined` does the
same for a series object: it is written out and read again by `readSeries`, so it refuses exactly what `readSeries` refuses (a
DTSTART that is not an instance, an UNTIL before it, no clock time, an unknown zone). `nextOccurrence(spec, after)` is the first
instant or `undefined`. The cost does not grow with the distance from DTSTART.

**Spoken recurrence** (`parseRecurrence(text, language, { now, timeZone, defaultTime?, band? })` → `Parsed<Recurrence>`, with `rule`,
`rrule`, `dtstart` — the first occurrence after now, an instance, never on a day the zone skips altogether (a gap that only pushes the time past midnight, as in Nuuk on 28 March 2026 at 23:30, is an ordinary gap: the pre-gap reading on that day) —, `ics`, `start`, `startInstant`,
`time?`, `partOfDay?`, `timeDefaulted`). Grammar: `[at TIME] RULE [at TIME]`, at most one time; EVERY is "every" / "each" / "elke" /
"elk" / "iedere" / "ieder":
- INTERVAL: EVERY UNIT ("every day"), EVERY ORDINAL UNIT, from "first" ("every first day" is every day, "every second week"), EVERY N UNITS (2–999), "every other" UNIT, "om de"
  UNIT, "om de" N UNITS, the adverbs "daily", "weekly", "fortnightly", "monthly", "quarterly", "yearly", "annually", "dagelijks",
  "wekelijks", "tweewekelijks", "maandelijks", "jaarlijks". A weekly interval may take "on" WEEKDAYS, a monthly one "on" DAYS OF THE
  MONTH or "on" an ordinal weekday, a yearly one "on" a date.
- EVERY WEEKDAYS [PART] ("every Monday and Friday", "every weekday morning", "elke vrijdagavond"); WEEKDAYS is a list of weekdays,
  "weekday" / "werkdag" (Monday–Friday) and "weekend", by "and" / "en" or side by side, none twice.
- EVERY ("other" | second–fifth) WEEKDAY: every few weeks ("every second Tuesday" is every other week).
- EVERY PART ("every evening"); [on] PLURAL WEEKDAYS [PLURAL PART] ("on Mondays", "weekdays", "on Monday evenings", "op werkdagen",
  "'s maandags").
- [on] DAYS OF THE MONTH OF-MONTH ("on the 1st and 15th of every month", "the last day of the month"); [on] the ORDINAL WEEKDAY
  OF-MONTH ("the second Tuesday of the month"); EVERY ORDINAL OF-MONTH ("every 2nd of the month"); EVERY ORDINAL WEEKDAY OF-MONTH
  ("every first Monday of the month", "every last Friday of every month"); OF-MONTH is "of the month" or "of" a monthly EVERY
  interval.
- EVERY DATE ("every 3 March", "every March 3rd"); "every year on 3 March".
- A part of the day applies to the day it belongs to: "every Friday night at 1" is `BYDAY=SA` at 01:00. "midnight" in a rule that is
  not daily is refused unless with a night; say 00:00. "24:00" is refused. Without a time: the part of the day's usual time (morning
  08:00, afternoon 14:00, evening 19:00, night 22:00, or `defaultTime` when it falls in that part), else `defaultTime`, else 09:00.
  Plain "every week", "every month" and "every year" keep today's weekday, day or date. Two readings that differ are `ambiguous`.
- Refused: "every Monday or Friday", "every hour", "every day except Sunday", "every day until June", "every day at", "the second
  Tuesday" alone.

## The tests

| Test | What it shows |
|---|---|
| `test/support/Cfg.ts`, `test/grammars/*.ts` | The grammars above, written again in the tests as data (a context-free grammar per parser), with their meaning computed by the tests' own calendar (`test/support/Zone.ts`: `Date` and `Intl`, nothing from the package) and durations in exact `BigInt` arithmetic. The engine generates phrases with the value each must mean, and recognises a phrase. Dutch numbers are written in every spacing of their parts. |
| generated phrases (`*.generated.test.ts`, `Numbers.test.ts`, `Durations.test.ts`) | Numbers 3000 per language, durations 3000, times 4000 in the default band and 1500 in each of four other bands and moments (two of them leaving out both readings of most hours, so every candidate of an `ambiguous` answer is compared), quantities 3000, dates 600 at each of 7 moments (an ordinary morning, the small hours, both Amsterdam daylight-saving days, Sydney's autumn change, both ends of the range), recurrence 500 at each of 6 moments (adding Nuuk's gap across midnight and Amsterdam's autumn fold): every phrase parses to its value, also in NFD, and every parsed recurrence agrees with itself (`rule` is `rrule`, `start` is DTSTART's, `startInstant` is its first instant by the tests' own zone lookup, `ics` and `timeZone` match). |
| mutants (same files) | For generated phrases (numbers 150, durations 120, times 200 and 4 × 40, quantities 120, dates 3 × 40, recurrence 2 × 40 per language), each word of a fixed list (negations, bounds, conjunctions, units, weekdays, numbers, fillers, JavaScript property names) inserted at every position (all for numbers, durations and times; half for quantities; a third for dates and recurrence, by seed), each word deleted, each pair swapped, and each word with an apostrophe put inside it: about 620 000 mutants. Each is refused, or is a phrase of the tests' grammar and parses to its value. |
| round trips (the four promised) | `speakTime`: all 1440 times × both styles × with and without `period` × 2 languages, read in the parser's default context. `speakDate`: every day from 400 before to 800 after four todays (one in a leap year, one near 2199) × 2 languages. Every calendar day of 2000, 2027, 2028 and 2100 in 5 English and 4 Dutch written forms. `speakDuration`: every second to an hour, minute to a day, hour to a week, day to 365, and 3000 random, × 2 languages × 2 styles. Numbers: every whole number 0–10 000 in words and digits, 20 000 sampled (magnitudes to 999 999, two decimals, both signs), and 20 000 real numbers of any precision, many just inside or outside 999 999.99. |
| `Durations.test.ts`, decimal amounts | Every unit in both languages: every amount from 0.01 to 20.00, every one up to and just past the unit's 365-day limit, and 3000 between, against `BigInt` arithmetic. |
| `Quantity.generated.test.ts`, `speakAmount` | 40 000 amounts per language, on and off the hundredths, every unit, with and without "about", items up to 200 characters, humanised or not: the utterance, read by the test's own unit table, states the given quantity exactly and "about" exactly when it was given; an amount of whole hundredths is always said. |
| `DomainFuzz.test.ts` | Every exported function (the test checks the list is complete) with 3000 generated calls of declared-type arguments holding any data (extreme and odd numbers, odd strings, unknown time zones): no throw, no escaped exception, no NaN, Infinity, invalid Date, date outside 2000–2199, empty or broken utterance; every function that takes a time zone fails for an unknown one. |
| `RruleReference.test.ts` | The engine against a brute-force reference sharing nothing with it: 5360 rules (8 zones incl. Apia, Lord Howe, and Kiritimati and Pago Pago at the end of the range, daylight-saving days, month ends, 29 February, both ends of the range, intervals 1–4 and sampled 7, 12, 13, 99, 100, 400, 999, seconds, COUNT and UNTIL incl. UNTIL at DTSTART and on daylight-saving days) × about 9 `after` instants: the same instants, in order, none twice, the same `stop` (the reference decides `range` by whether the series has an instance after 2199); fixed stops by hand (COUNT and UNTIL ending on 31 December 2199, a zone at UTC+14); `parseRRule(formatRRule(rule))` is the rule; UNTIL before DTSTART and a DTSTART that is not an instance refused by `readSeries` and `seriesAfter`; every description states every constraint, read by the test's own word tables (the interval's phase included), and a rule whose UNTIL is in a repeated hour (by the test's own zone lookup) is not described; fixed instants computed by hand. |
| `ZoneOffsets.test.ts` | The zone-offset lookup against Intl's offset names over 2000–2199 for 7 zones: every transition to the second; the wall-clock-to-instant conversion every quarter hour around each, and for civil wall-clock times made by arithmetic across every gap and fold, from both sides (Casablanca's gaps follow a zero offset). |
| `ReviewRound1–5.test.ts`, the other files | The reviewers' cases, and examples. |
