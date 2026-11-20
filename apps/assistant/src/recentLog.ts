import { Cause, Logger } from "effect"

/**
 * The server's recent warnings and errors, in memory (docs/REPORTS.md): the last `MAX_LINES` log lines at warning level
 * and above, each cut to `MAX_LINE_CHARS`, for a report. A second logger beside the stderr one (`main.ts`); nothing is
 * written anywhere. A report scrubs secrets from what it takes.
 */

export const MAX_LINES = 200
export const MAX_LINE_CHARS = 500

export interface RecentLogLine {
  readonly at: number
  readonly level: "warning" | "error"
  readonly text: string
}

const lines: Array<RecentLogLine> = []

/** `text` cut to `MAX_LINE_CHARS`, never between the halves of a surrogate pair (a lone half breaks a report's readers). */
const cut = (text: string) => {
  if (text.length <= MAX_LINE_CHARS) return text
  let end = MAX_LINE_CHARS - 1
  const c = text.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** Keep one line (tests, and the logger below). */
export const recordWarning = (level: RecentLogLine["level"], text: string, at: number = Date.now()): void => {
  lines.push({ at, level, text: cut(text.replace(/\s+/g, " ").trim()) })
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
}

/** The kept lines, oldest first. */
export const recentWarnings = (): ReadonlyArray<RecentLogLine> => lines.slice()

/** The logger that keeps them: warnings, errors and fatal lines, with the first line of a cause. */
export const recentWarningsLogger = Logger.make(({ cause, logLevel, message, date }) => {
  if (logLevel !== "Warn" && logLevel !== "Error" && logLevel !== "Fatal") return
  const text = Array.isArray(message) ? message.map(String).join(" ") : String(message)
  const first = cause.reasons.length > 0 ? Cause.pretty(cause).split("\n")[0] : undefined
  recordWarning(logLevel === "Warn" ? "warning" : "error", first !== undefined && first !== "" ? `${text}: ${first}` : text, date.getTime())
})
