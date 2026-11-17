# @pva/language

English (British conventions) and Dutch helpers every module shares, so that "half acht", "a kilo of rice" and "every second
Tuesday" mean the same thing everywhere. Pure functions with a `language: "en" | "nl"` argument; no global state, no network, no
model, no dependency except `@pva/core` (for `parseDuration` and its numeric-span rule). Parsers return `Parsed<T>`: `ok` (`value`,
`said`), `ambiguous` (`candidates`, `reason`, `said`) or `not-understood`; they never throw.

## The rule: a parser reads a whole phrase of its kind, or nothing

Each parser's input is a phrase that is *only* that kind of expression: a time, a date-time, a quantity, a recurrence. It is read by
a closed grammar (below), and after the grammar has matched, **every token must have been consumed by a grammar rule** (the
`accountedFor` check in `Tokens.ts`, run by every parser), and every character outside the words must be a space or plain
punctuation (`, . ! ? ' ’` and a hyphen; `onlyWords`). Anything else, anywhere, makes the answer `not-understood`. So negations
("tomorrow not at five"), bounds ("before five", "less than 2 kg", "minder dan"), alternatives ("Monday or Friday", "maandag of
vrijdag"), a second expression ("at 5 and at 6"), explicit time zones and offsets ("at 5 UTC", "+01:00"), a dangling word ("every day
at"), signs and symbols ("<5", "~2 kg") and words no rule reads are refused without being named anywhere. Word tables are
null-prototype, so "constructor" is just a word no rule reads. An unknown time zone is `not-understood`, never UTC.

**What callers do themselves.** Nothing here searches a longer sentence: "remind me to call mum tomorrow at five" is
`not-understood`. The caller passes the time phrase on its own — the language model fills a tool parameter with it ("tomorrow at
five"), and a phrase command gets it from a typed slot — and keeps the title it has. There is no span or offset in any result to cut
out of a sentence. A list of quantities ("2 kg flour and 3 eggs") is split by the caller into one phrase per quantity.

## Numbers

One number grammar per language, total over its input (`readNumber`): a number phrase is exactly one number by the language's rules,
or it is no number. Supported: digits, whole numbers 0–999 999 999 with at most six decimals ("2.5", "2,5"; "1,500" is 1500 in
English and "1.500" in Dutch, and each is no number in the other language); words, 0–999 999 ("twenty five", "two hundred and five",
"a thousand", "one thousand and five"; Dutch one word or spaced parts that join into one: "vijfentwintig", "tweeduizend
driehonderd", "vijf en twintig"), optionally followed by "point" / "komma" and one to six digit words. Not a number: "five five",
"one thousand two thousand", "twenty thirty", "duizend duizend", a seventh decimal, ten digits, anything before "million" /
"miljoen". `readAmount` adds spoken fractions: "half", "a quarter", "three quarters", "one and a half", "anderhalf", "tweeënhalf",
"driekwart".

## Parsing

- `parseTimeOfDay(text, language, { band?, afterMinutes? })` → `Parsed<TimeOfDay>` (`hour`, `minute`, `guessed`, `alternatives`).
  Grammar: `["at" | "om"] time`, where time is a clock token ("7:30", "19.30", "19u30"), "noon", "midnight", "half HOUR" (English
  "half seven" is 7:30; Dutch "half zeven" is 6:30), `MINUTES past|after|to|till|of HOUR` and `MINUTES voor|over [half] HOUR`
  (MINUTES 5, 10, 20, 25, "quarter", "kwart", "half", or any 1–29 with "minutes": "seven to eight" is a range, not 7:53),
  `HOUR o'clock`, `HOUR uur [MINUTES]`, `HOUR MINUTES` ("seven thirty", "nineteen hundred", "oh nine hundred"), or a bare hour;
  then optionally am/pm or a part of the day ("in the evening", "at night", "'s avonds", "in de ochtend"), which must agree with an
  hour already settled ("07:00 in the evening" is refused). Without am/pm the reading inside the band (default 07:00–21:00) wins,
  `guessed` is true and `alternatives` lists the other readings inside the band; `ambiguous` only when the band holds none. "24:00"
  is refused (a time of day cannot say "the next day").
- `parseDateTime(text, language, { now, timeZone, band? })` → `Parsed<DateTimeValue>`: `date`, `weekday`, `time?`, `instant?`,
  `partOfDay?`, `inPast`. Grammar: at most one date and at most one time, in either order, and nothing else. A date: "today",
  "tomorrow", "yesterday", "tonight", "this evening", "the day after tomorrow", Dutch "vandaag", "morgen", "overmorgen", "vanavond",
  "morgenochtend", …; `[on | op] [this | next | coming | deze | volgende | komende] WEEKDAY [next week | volgende week | over een
  week]`, "next week Monday", "vrijdagavond"; `[on] DAY MONTH [YEAR]`, "the 3rd of March", "March 3rd", "the 3rd", "the first of the
  month", "de derde maart"; a weekday said with a date must be its weekday; "in N days | weeks | months | years" (N 1–999), "in a
  fortnight", "over twee weken"; a clock duration read whole by core's grammar ("in two hours and thirty minutes", "over anderhalf
  uur"). A date may take a part of the day after it ("tomorrow evening", "Friday night", "Friday in the evening"), once. A time:
  `"at" | "om"` and the time grammar above; without "at" only a time that says it is one ("5 pm", "17:00", "five o'clock"), or a bare
  number that is the whole phrase. Years are four digits, 1900–2199. **`next Friday` / `volgende vrijdag` is `ambiguous`** (the coming
  one and the one after); "this Friday" is the coming one, a bare "Friday" the next one after today. A date with the word "midnight"
  is `ambiguous` (the start or the end of that day); "tonight at midnight" is the end of today. "24:00" is 00:00 of the next day.
  The small hours after a day's night are the next day's: "Friday night at 1", "tonight at 2 am", "vrijdagnacht om 1 uur" (a part of
  the day said with the clock, "Friday at 1 at night", is the clock's reading: Friday 01:00). A time without a date is the next
  moment after now it names, never now or before, including in the hour the clocks go back (both readings of a repeated hour are
  considered). A dated time takes the first of a repeated hour, except today, where it takes the one after now. A time the clocks
  skip moves forward by the jump. "next week" alone, "last Friday", "this weekend" and "in 2 weeks and 3 days" are `not-understood`.
- `parseQuantity(text, language, { cupMl? })` → `Parsed<Quantity>`: `amount`, `unit`, `dimension` (`mass | volume | count | pack |
  vague | none`), `approx`, `rest`, `base` (grams, millilitres or pieces), `said` (the quantity words), `item`. Grammar:
  `[approximator] amount [x] [unit] [of | van] item`, where the approximator is one of "about", "around", "roughly",
  "approximately", "approx", "circa", "ca", "ongeveer", "rond", "zo'n", "plusminus" (others — "less than", "almost", "bijna",
  "ruim" — are refused); or "some" / "a bit" / "een paar" … and an item; or "the rest" / "de rest" [of item]. The item is everything
  after the amount and unit, verbatim; it may be empty after a unit ("2 kg"). An item that holds a number, a unit, a fraction, "or" /
  "of" (an alternative), an article or amount after "and" / "en", or that starts or ends with "and" / "or", is `not-understood`:
  "2 kg flour and 3 eggs", "2 kg flour or a bag of sugar" are two quantities for the caller to split. "een ons" is 100 g, "een pond"
  500 g, a dozen 12 pieces, "a handful" and "some" are `approx`. Amounts are exact to twelve significant digits; nothing positive
  becomes 0. `convertAmount(amount, from, to, { cupMl? })` converts within mass or volume (a teaspoon is 5 ml, a tablespoon 15 ml, a
  cup 250 ml unless `cupMl` says 236.588).
- `parseDuration` is core's, re-exported.
- Lower level: `readNumber`, `readAmount`, `readOrdinal`, `numbersWhole`, `matchTime`, `matchTimes`, `resolveTime`, `periodHours`,
  `tokenize`, `sliceText`, `onlyWords`, `accountedFor`, `normalizeTimeZone`, `isValidLocal`, `zonedToInstant`, `zonedInstants`,
  `dayNumber`, `dateOfDay`.

Time zones are IANA names this machine knows (`normalizeTimeZone`: padded or differently cased is normalised; a fixed offset such
as "+01:00" is refused, since it cannot be a `TZID`). Local dates are four-digit years, 1000–9999 (`isValidLocal`); a year outside is
refused, never shifted.

## Speaking

`speakNumber` (two decimals, more below 1 so that two significant digits remain: a nonzero number is never said as 0, and its sign is
kept; 0 and sizes from 1e-90 to below 1e21 are said, others are "" — nothing to say), `speakAmount(q, language, { item?, humanize?
})` ("about 750 grams", "2 liter melk"), `speakDuration(ms, language)` ("6 minutes 10 seconds", "anderhalf uur"), `speakTime(t,
language, { style: "12h" | "24h", period? })` ("half past twelve", "kwart over zeven"), `speakDate(date, language, today)`
("tomorrow", "Friday the third"), `speakMoment`, `speakList(items, language, { max? })` ("a, b and two more"), `numberToWords`,
`ordinalToWords`.

## Recurrence

This helper stores what a person says ("every weekday at seven", "every second Tuesday", "on the first of the month", "every year on
3 March") and computes the next occurrence. It is not a general iCalendar engine: calendar events from elsewhere are expanded by the
calendar module with its own library. Expansion is this package's own date arithmetic over local calendar days, then one conversion
to an instant per instance; it jumps to the period of `after` by arithmetic, so its cost does not grow with the distance from
DTSTART. The tests compare it with a brute-force reference (every local day, membership by the definitions below) over 2928
generated rules and about 43 000 `after` instants (`test/RruleReference.test.ts`).

**Supported rule shapes** (RFC 5545 §3.3.10), and nothing else:

| FREQ | BY parts | Without BY parts |
|---|---|---|
| `DAILY` | none | every day |
| `WEEKLY` | `BYDAY` of plain weekdays (`MO,WE,FR`) | DTSTART's weekday |
| `MONTHLY` | `BYMONTHDAY` of 1–31 and/or -1 (the last day), or one `BYDAY` with an ordinal 1–5 or -1 (`2TU`, `-1FR`) | DTSTART's day of the month |
| `YEARLY` | one `BYMONTH`, with or without one `BYMONTHDAY` 1–31 | DTSTART's month and day |

each with `INTERVAL` (1–999), optionally `COUNT` (1–1000) or `UNTIL` (a UTC date-time, `YYYYMMDDTHHMMSSZ`, which RFC 5545 requires
with a zoned DTSTART), and `WKST` only as `MO`. `DTSTART` is `DTSTART;TZID=<the series' zone>:YYYYMMDDTHHMMSS` and must itself be an
instance of the rule. `parseRRule` returns `ok`, `unsupported` (valid RFC 5545 outside this set: `SECONDLY`, `MINUTELY`, `HOURLY` —
short intervals are scheduler jobs —, `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, X- parts, another `WKST`,
several `BYMONTH`s, `BYMONTHDAY` without `BYMONTH` in a yearly rule — RFC 5545 makes that every month's day —, a plain weekday in a
monthly rule, a date-only or floating `UNTIL`) or `invalid` (not RFC 5545), each with a reason. `formatRRule` writes only rules of
the set (`undefined` otherwise); parse → format → parse is the identity. `readSeries(spec)` checks a stored series as a whole
(`unsupported` for a UTC, floating or date-only DTSTART; `invalid` when the TZID is not the series' zone or DTSTART is not an
instance).

**Semantics**, by RFC 5545 §3.3.10 and §3.8.5.3, for DTSTART at local date S and local time T:
- an instance is the local date-time (d, T) for each local day d ≥ S selected by the rule's BY parts (or the defaults above), in a
  period (day, Monday-to-Sunday week, month, year) whose distance from S's period is a multiple of `INTERVAL`. `INTERVAL` counts
  periods from DTSTART's period whether or not a period contains an instance: every 5 months on the 31st skips months without a 31st
  and keeps the five-month step;
- a monthly rule on day 31 (or 30, 29), and a yearly rule on 29 February, simply has no instance in a period without that day (no
  moving to another day); an ordinal weekday that a month does not have (a fifth Friday) likewise;
- `COUNT` counts instances from DTSTART, which is the first; `UNTIL` keeps the instances at or before that instant;
- an instance whose local time does not exist on a daylight-saving day is taken at the UTC offset from before the gap (RFC 5545
  §3.3.10 with §3.3.5: 02:30 on the spring day in Amsterdam is 03:30); a local time that occurs twice is the first;
- instances are returned in increasing instant order with no instant twice (a day a zone skips altogether, as Pacific/Apia did on
  30 December 2011, lands on the next day's instant: one occurrence). The series ends with the year 9999.

`nextOccurrence(spec, after)` and `occurrencesAfter(spec, after, n)` (at most 10 000) with `spec = { rrule, dtstart, timeZone }`
give the instances strictly after `after`, or none when `readSeries` does not accept the spec. `seriesAfter(series, after, n)` does
the same for a series `readSeries` returned.

**Spoken recurrence.** `parseRecurrence(text, language, { now, timeZone, defaultTime?, band? })` → `Parsed<Recurrence>` with `rule`,
`rrule`, `dtstart` (the first occurrence after now, an instance of the rule), `ics`, `start`, `startInstant`, `time?`, `partOfDay?`,
`timeDefaulted`. The whole-input rule applies; the grammar, `[at TIME] RULE [at TIME]` with at most one time:
- `every | each | elke | elk | iedere` and a unit: "every day" (also "daily", "dagelijks"), "every other day", "every second
  day", "every 3 days" (2–99, plural), "om de dag", "om de 3 dagen", "every week [on WEEKDAYS]", "fortnightly", "tweewekelijks",
  "every month [on the 1st and the 15th | on the last day | on the second Tuesday]", "quarterly", "every year [on 3 March]";
- weekdays: "every Monday", "every Monday and Friday", "every Monday, Wednesday and Friday" (a list goes on with "and" or a comma),
  "every weekday", "every weekend", "on Mondays", "Mondays", "op werkdagen", "'s maandags", with a part of the day ("every weekday
  morning", "every Tuesday and Thursday evening", "on Monday evenings", "elke vrijdagavond");
- "every other Tuesday", "every second Tuesday", "every third Friday" (2nd–5th): every few weeks;
- days of the month: "on the 1st [and the 15th] of the month | of every month | of every other month | of every 3 months",
  "every 2nd of the month", "on the last day of the month", "op de eerste van de maand";
- ordinal weekdays: "the second Tuesday of the month | of every month", "every first Monday of the month", "the last Friday of every
  month", "de laatste vrijdag van de maand";
- dates: "every year on 3 March", "every 3 March", "every March 3rd", "on 3 March every year", "elk jaar op 3 maart", "elke 3 maart";
- parts of the day: "every morning | afternoon | evening | night", "elke avond".
"every second Tuesday" is every other week; "the second Tuesday of the month" is `BYDAY=2TU`; "the second Tuesday" alone, "every first
Monday" and "every last Friday" (no month said) are `not-understood`, never a guess. "every Monday or Friday", "every hour", "every day
except Sunday", "every day until June", "every day at", "every Monday and", "every day in winter" are `not-understood`. A part of the
day applies to the calendar day it belongs to: "every Friday night at 1" is `BYDAY=SA` at 01:00 (a part said with the clock, "every
Friday at 1 at night", is Friday 01:00). "midnight" in a rule that is not daily is refused ("every Friday at midnight": the start of
Friday or its end); say 00:00. "24:00" is refused. Without a time: the part of the day's usual time (morning 08:00, afternoon 14:00,
evening 19:00, night 22:00, or `defaultTime` when it falls in that part), else `defaultTime`, else 09:00; a time said without am/pm
is settled by the band (`time.guessed`). Plain "every week", "every month" and "every year" keep today's weekday, day of the month or
date. When the words read as two different rules, the answer is `ambiguous` with both.

`describeRRule(rrule, language, { time?, start?, timeZone? })` says a rule of the set in the words `parseRecurrence` reads back:
"every day", "every weekday", "every Monday and Wednesday", "every second Tuesday", "every three weeks on Monday", "on the first of
every month", "the last Friday of every month", "every year on the third of March"; Dutch "elke dag", "elke werkdag", "elke tweede
dinsdag", "op de eerste van elke maand". COUNT is said (", 5 times"), UNTIL with `timeZone` as a local date and time; midnight is said
"00:00". Every constraint is in the words or the answer is `undefined`; the reference test reads each description of the matrix back
and checks that it gives the same occurrences.
