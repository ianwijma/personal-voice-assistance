import { type CoreStorage, defineCollection, type Row, type StoreTx } from "@pva/core"
import { MAX_REPORT_BODY_CHARS, MAX_REPORT_TITLE_CHARS } from "@pva/protocol"
import { Schema } from "effect"
import { wellFormed } from "./render.ts"

/**
 * How reports are kept (docs/REPORTS.md "Storage"): a core service's collections in the household store
 * (`core.reports`, reached through `HouseholdStore.forCore`, as the scheduler keeps its jobs), so they share its
 * transactions, durability and daily backups.
 *
 * - `reports`: one row per report with what the list shows (kind, title, status, names, the issue, the last error)
 *   and how many parts its body has. Its id is the report's id.
 * - `report_parts`: the body (at most `MAX_REPORT_BODY_CHARS`), in parts of at most `PART_JSON_CHARS` characters of
 *   JSON each (a row is at most 16,000), ids `<report id>.<n>`. A report and its parts are written and removed in one
 *   transaction, so a body is never half there.
 */

export const REPORTS_OWNER = "core.reports" as const

/** A report id: `r` and 16 lower-case hex digits. */
export const REPORT_ID = /^r[0-9a-f]{16}$/

const line = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }))

export const StoredReport = Schema.Struct({
  kind: Schema.Literals(["problem", "feature"]),
  title: line(MAX_REPORT_TITLE_CHARS),
  status: Schema.Literals(["draft", "sent", "failed"]),
  deviceName: Schema.optionalKey(line(200)),
  assistantName: Schema.optionalKey(line(200)),
  issueNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  issueUrl: Schema.optionalKey(line(500)),
  sentAt: Schema.optionalKey(Time),
  lastError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /**
   * When a send was started, written before the request leaves and cleared when its result is recorded: set on a
   * report that is not `sent`, the issue may exist (the process stopped, or the answer was lost).
   */
  attemptedAt: Schema.optionalKey(Time),
  /** How many `report_parts` rows hold the body. */
  parts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))
})
export type StoredReport = typeof StoredReport.Type

export const ReportPart = Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(16_000)) })
export type ReportPart = typeof ReportPart.Type

/**
 * One row's JSON: the title, two names, the address and the error are one line each (control characters are taken
 * out before they are stored, so each costs a character of JSON per character), well under 4,000.
 */
export const reports = defineCollection({ name: "reports", scope: "household", schema: StoredReport, maxChars: 4_000 })
export const reportParts = defineCollection({ name: "report_parts", scope: "household", schema: ReportPart, maxChars: 16_000 })

export const reportsStorage: CoreStorage = { owner: REPORTS_OWNER, storage: { version: 1, collections: [reports, reportParts] } }

/** The most characters of JSON one part may take (under the row's 16,000, with room for `{"text":""}`). */
export const PART_JSON_CHARS = 15_500

/** What one character costs in JSON (`JSON.stringify`): an escape for `"`, `\`, control characters and lone surrogates. */
const jsonCost = (text: string, i: number): { readonly cost: number; readonly width: number } => {
  const c = text.charCodeAt(i)
  if (c === 0x22 || c === 0x5c) return { cost: 2, width: 1 }
  if (c < 0x20) return { cost: c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6, width: 1 }
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    return next >= 0xdc00 && next <= 0xdfff ? { cost: 2, width: 2 } : { cost: 6, width: 1 }
  }
  if (c >= 0xdc00 && c <= 0xdfff) return { cost: 6, width: 1 }
  return { cost: 1, width: 1 }
}

/** `body` in parts whose JSON fits a row (never splitting a surrogate pair). */
export const splitBody = (body: string, maxJson: number = PART_JSON_CHARS): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let start = 0
  let cost = 0
  for (let i = 0; i < body.length;) {
    const { cost: c, width } = jsonCost(body, i)
    if (cost + c > maxJson) {
      parts.push(body.slice(start, i))
      start = i
      cost = 0
    }
    cost += c
    i += width
  }
  if (start < body.length) parts.push(body.slice(start))
  return parts
}

const partId = (id: string, n: number) => `${id}.${n}`

/** Write `body` as the parts of report `id` in `tx`, replacing the `before` parts it had. */
export const writeParts = (tx: StoreTx, id: string, before: number, body: string): number => {
  const parts = splitBody(body.slice(0, MAX_REPORT_BODY_CHARS))
  const c = tx.collection(reportParts)
  for (let n = 0; n < before; n++) c.remove(partId(id, n))
  parts.forEach((text, n) => void c.insert({ text }, { id: partId(id, n) }))
  return parts.length
}

/** Remove report `id` and its parts in `tx`. */
export const removeReport = (tx: StoreTx, id: string, parts: number): boolean => {
  const c = tx.collection(reportParts)
  for (let n = 0; n < parts; n++) c.remove(partId(id, n))
  return tx.collection(reports).remove(id)
}

/** One line for a stored text: control characters and runs of white space become one space, cut to `max`. */
export const storedLine = (text: string, max: number): string | undefined => {
  // eslint-disable-next-line no-control-regex
  const t = wellFormed(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim()
  if (t === "") return undefined
  if (t.length <= max) return t
  let end = max - 1
  const c = t.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${t.slice(0, end)}…`
}

export type ReportRow = Row<StoredReport>
