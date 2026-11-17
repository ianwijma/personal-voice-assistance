// A parsed recurrence agrees with itself (review round 5, finding 5): used by the generated recurrence test and the round-5 cases.
import type { Recurrence } from "../../src/index.ts"
import { stable } from "./Cfg.ts"
import { canonicalZone, instantsOf } from "./Zone.ts"

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
/** The RRULE value of a rule object, written by the test (RFC 5545 part order as the README's rules use it). */
const ruleText = (r: Recurrence["rule"]): string => [`FREQ=${r.freq}`, ...(r.interval > 1 ? [`INTERVAL=${r.interval}`] : []),
  ...(r.byMonth.length > 0 ? [`BYMONTH=${r.byMonth.join(",")}`] : []), ...(r.byMonthDay.length > 0 ? [`BYMONTHDAY=${r.byMonthDay.join(",")}`] : []),
  ...(r.byDay.length > 0 ? [`BYDAY=${r.byDay.map((d) => `${d.nth ?? ""}${d.weekday}`).join(",")}`] : []),
  ...(r.count !== undefined ? [`COUNT=${r.count}`] : []), ...(r.until !== undefined ? [`UNTIL=${r.until}`] : [])].join(";")

/**
 * Every representation of a parsed recurrence says the same series (review round 5, finding 5): `rule` is `rrule`, `start` is
 * DTSTART's date-time in the zone asked for, `startInstant` is `start`'s first instant by the tests' own zone lookup (the first of a
 * repeated hour, the pre-gap reading of a skipped one), `ics` is DTSTART and the RRULE, and `timeZone` is the zone. Throws on a
 * disagreement, so that every generated phrase and mutant checks it.
 */
export const agree = (r: Recurrence, zone: string): void => {
  const z = canonicalZone(zone)
  const s = r.start
  const problems = [
    ruleText(r.rule) === r.rrule ? undefined : `rule ${stable(r.rule)} is not ${r.rrule}`,
    r.timeZone === z ? undefined : `timeZone ${r.timeZone} is not ${z}`,
    r.dtstart === `DTSTART;TZID=${z}:${pad(s.year, 4)}${pad(s.month)}${pad(s.day)}T${pad(s.hour)}${pad(s.minute)}${pad(s.second ?? 0)}` ? undefined : `dtstart ${r.dtstart} is not start ${stable(s)}`,
    r.ics === `${r.dtstart}\nRRULE:${r.rrule}` ? undefined : `ics ${JSON.stringify(r.ics)}`,
    r.startInstant === instantsOf({ year: s.year, month: s.month, day: s.day, hour: s.hour, minute: s.minute, second: s.second ?? 0 }, zone)[0] ? undefined : `startInstant ${new Date(r.startInstant).toISOString()} is not start ${stable(s)}`,
    r.time === undefined || (r.time.hour === s.hour && r.time.minute === s.minute) ? undefined : `time ${stable(r.time)} is not start's clock`
  ].filter((p) => p !== undefined)
  if (problems.length > 0) throw new Error(`${r.ics}: ${problems.join("; ")}`)
}

