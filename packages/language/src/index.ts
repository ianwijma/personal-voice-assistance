// The package's front doors (review round 3, decision 1): each validates its data and never throws for it (round 4: arguments that are
// not data must have their declared type; README, "The domain"). The grammar productions,
// the tokenizer and the calendar arithmetic behind them are internal.
export type { Language, Parsed, LocalDate, ClockTime, LocalDateTime } from "./Result.ts"
export { languages, maxDurationMs, maxNumber, maxTextLength, maxWords, maxYear, minYear, numberDecimals } from "./Domain.ts"
export { parseNumber } from "./Numbers.ts"
export { parseDuration } from "./Durations.ts"
export { parseTimeOfDay, type Period, type TimeOfDay, type TimeOptions } from "./Time.ts"
export { parseDateTime, type DateOptions, type DateTimeValue } from "./Dates.ts"
export {
  convertAmount, metricCupMl, parseQuantity, usCupMl, type Dimension, type MassUnit, type PackUnit, type Quantity, type QuantityOptions, type UnitId,
  type VolumeUnit
} from "./Quantity.ts"
export { parseRecurrence, type Recurrence, type RecurrenceOptions } from "./Recurrence.ts"
export {
  describeRRule, formatDtstart, formatRRule, maxCount, maxInterval, nextOccurrence, occurrencesAfter, parseDtstart, parseRRule, readSeries, seriesAfter,
  weekdayCodes, type DescribeOptions, type Dtstart, type Freq, type Occurrences, type RecurrenceRule, type RecurrenceSpec, type RRuleRead, type RuleDay,
  type Series, type SeriesRead, type Weekday
} from "./Rrule.ts"
export {
  speakAmount, speakDate, speakDuration, speakList, speakMoment, speakNumber, speakTime, type AmountLike, type SpeakAmountOptions, type SpeakTimeOptions
} from "./Speak.ts"
export { numberToWords, ordinalToWords } from "./Words.ts"
export { normalizeTimeZone } from "./Zoned.ts"
