import type { Trace, TraceMark } from "@pva/core"

/** One benchmark turn: a label, its trace (absent when no reply came) and extra measured intervals. */
export interface BenchRow {
  readonly label: string
  readonly trace?: Trace | undefined
  readonly extra?: Readonly<Record<string, number | undefined>> | undefined
  /** A line printed under the table (e.g. what the STT heard). */
  readonly note?: string | undefined
}

export interface ReportOptions {
  /** Show the trace marks relative to the end of turn. Default true. */
  readonly traceColumns?: boolean
  /** The headline interval: an `extra` key and how to describe it. Default: end of turn → playback start. */
  readonly headline?: { readonly key: string; readonly label: string }
}

/** Marks shown as columns, relative to the end of turn. `playbackStart` is the headline. */
const columns: ReadonlyArray<readonly [TraceMark, string]> = [
  ["llmRequestSent", "llm req"],
  ["llmFirstToken", "1st token"],
  ["firstClause", "1st clause"],
  ["ttsFirstAudio", "tts audio"],
  ["playbackStart", "PLAYBACK"]
]

export const sinceEndOfTurn = (trace: Trace, mark: TraceMark): number | undefined => {
  const origin = trace.marks.endOfTurn
  const at = trace.marks[mark]
  return origin === undefined || at === undefined ? undefined : at - origin
}

const fmt = (n: number | undefined) =>
  n === undefined ? "-" : Math.abs(n) < 10 ? n.toFixed(1) : String(Math.round(n))

export const median = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const table = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>, leftColumns = 1): string => {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((c, i) => (i < leftColumns ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ").trimEnd()
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n")
}

/**
 * Per-turn table plus a median / worst-case summary of every interval (ms,
 * relative to the end of turn; negative = done before the end of turn by a
 * promoted speculative turn). Discarded speculative turns are not rows.
 */
export const formatReport = (title: string, rows: ReadonlyArray<BenchRow>, options: ReportOptions = {}): string => {
  const traceColumns = options.traceColumns === false ? [] : columns
  const extraKeys = [...new Set(rows.flatMap((r) => Object.keys(r.extra ?? {})))]
  const header = ["turn", "spec", "outcome", ...traceColumns.map(([, name]) => name), ...extraKeys, "tools"]
  const valuesOf = (row: BenchRow): Array<number | undefined> => [
    ...traceColumns.map(([mark]) => row.trace === undefined ? undefined : sinceEndOfTurn(row.trace, mark)),
    ...extraKeys.map((k) => row.extra?.[k])
  ]
  const body = rows.map((row) => [
    row.label,
    row.trace?.speculative ? "yes" : "no",
    row.trace?.outcome ?? "no reply",
    ...valuesOf(row).map(fmt),
    row.trace?.tools.map((t) => `${t.name} ${fmt(t.ms)}`).join(", ") ?? ""
  ])
  const columnValues = header.slice(3, 3 + traceColumns.length + extraKeys.length).map((_, i) =>
    rows.map((r) => valuesOf(r)[i]).filter((v): v is number => v !== undefined)
  )
  const summary = [
    ["median", "", "", ...columnValues.map((v) => fmt(median(v))), ""],
    ["worst", "", "", ...columnValues.map((v) => fmt(v.length === 0 ? undefined : Math.max(...v))), ""]
  ]
  const headlineIndex = options.headline === undefined
    ? columns.length - 1
    : traceColumns.length + extraKeys.indexOf(options.headline.key)
  const playback = columnValues[headlineIndex] ?? []
  const headline = `${options.headline?.label ?? "end of turn -> playback start"}: median ${fmt(median(playback))} ms, worst ${
    fmt(playback.length === 0 ? undefined : Math.max(...playback))
  } ms over ${playback.length} turns`
  const notes = rows.flatMap((r) => (r.note === undefined ? [] : [`  ${r.note}`]))
  return [`== ${title}`, table(header, [...body, ...summary], 3), headline, ...notes, ""].join("\n")
}
