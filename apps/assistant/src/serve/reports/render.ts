import type { Message } from "@pva/core"
import { MAX_REPORT_BODY_CHARS, REPORT_MARKER, type ReportKind, type TraceInfo } from "@pva/protocol"

/**
 * A report's issue body (docs/REPORTS.md "The issue body"): Markdown, at most `MAX_REPORT_BODY_CHARS`, rendered from
 * what the server gathered (`ReportFacts`). A pure function: the same facts give the same body.
 *
 * - The body is slim on purpose: it goes to a public repository. It holds the title, what the person said for the
 *   report (the description and the answers to the questions asked before filing), and a few facts about where it was
 *   said (device name and kind, assistant, voice, conversation id, turn, version). The rest of `ReportFacts` (the
 *   conversation, the previous conversation, traces, the device's and assistant's full facts, Health issues, log
 *   lines) is gathered but not rendered; a section for it can be added back here.
 * - The first line is exactly `<!-- pva-report v1 kind=<kind> id=<id> -->`, then a header, then the sections in a
 *   fixed order: what the person reported, the questions asked before filing, where it was said.
 * - Everything not written by the server (what the person said, names the owner chose) is quoted: in a fenced block
 *   longer than any run of backticks in it, or in inline code without backticks, so it can neither end its block nor
 *   mention anyone, link, or format the issue.
 * - Each part is capped far below the limit; a body that still does not fit is cut at a line boundary, its open block
 *   closed.
 * - `scrub` (the secret scrubber) is applied to every quoted text, and to the whole body.
 */

export interface Missing {
  readonly missing: string
}
export const missing = (why: string): Missing => ({ missing: why })
const isMissing = (x: unknown): x is Missing => typeof x === "object" && x !== null && "missing" in x

/** One row of a facts table: a label (the server's words) and a value (quoted). */
export type Fact = readonly [label: string, value: string]

export interface ReportConversation {
  readonly conversationId: string
  readonly history: ReadonlyArray<Message>
  /** Said above the transcript (the turn the report was made in is not in it yet, …). */
  readonly note?: string
}

export interface PreviousConversation {
  readonly conversationId: string
  readonly endedAt: number
  readonly history: ReadonlyArray<Message>
}

export interface ShownItem {
  readonly kind: string
  readonly module: string
  readonly lifetime: string
  readonly shownAt: number
}

export interface HealthLine {
  readonly severity: string
  readonly id: string
  readonly title: string
  readonly detail?: string
}

export interface LogLine {
  readonly at: number
  readonly level: string
  readonly text: string
}

export interface ReportFacts {
  readonly id: string
  readonly kind: ReportKind
  readonly title: string
  readonly description: string
  readonly answers: ReadonlyArray<{ readonly question: string; readonly answer: string }>
  readonly createdAt: number
  readonly turn: { readonly turnId: number; readonly conversationId: string; readonly source: string }
  /** For the header: where it was said (names, quoted). */
  readonly deviceName?: string
  readonly assistantName?: string
  readonly conversation: ReportConversation | Missing
  readonly previous: PreviousConversation | Missing
  /** The device's recent traces, oldest first. */
  readonly traces: ReadonlyArray<TraceInfo> | Missing
  readonly device: ReadonlyArray<Fact> | Missing
  readonly shown: ReadonlyArray<ShownItem> | Missing
  readonly assistant: ReadonlyArray<Fact> | Missing
  readonly server: ReadonlyArray<Fact>
  readonly health: ReadonlyArray<HealthLine>
  /** Recent warnings and errors of the server's log, oldest first. */
  readonly warnings: ReadonlyArray<LogLine> | Missing
}

export interface RenderOptions {
  /** Default `MAX_REPORT_BODY_CHARS`. */
  readonly maxChars?: number
  /** Default `MAX_REPORT_BODY_JSON_BYTES`: the most bytes the body may take as JSON in the issue request. */
  readonly maxBytes?: number
  readonly scrub?: (text: string) => string
}

export interface Rendered {
  readonly body: string
  /** What was cut, one sentence each (empty unless the body had to be cut to fit). */
  readonly cut: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------------------------------------------------
// Quoting

/**
 * `text` with every lone surrogate replaced by U+FFFD (`String.prototype.toWellFormed`): a text cut in the middle of a
 * pair elsewhere (a conversation's bound, a log line) must not reach a body, where `encodeURIComponent` and some
 * readers throw on it.
 */
export const wellFormed = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")

/** The longest run of backticks in `text`. */
const longestBacktickRun = (text: string): number => {
  let longest = 0
  let run = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 96) {
      run++
      if (run > longest) longest = run
    } else run = 0
  }
  return longest
}

/** A fenced block that `text` cannot end: its fence is longer than any run of backticks in it. */
export const fenced = (text: string, info = "text"): string => {
  // A run of more than 20 backticks is shortened (and says so), so no fence is longer than 21.
  const t = text.replace(/`{21,}/g, (run) => `${"`".repeat(20)}(${run.length - 20} more backticks)`)
  const fence = "`".repeat(Math.max(3, longestBacktickRun(t) + 1))
  return `${fence}${info}\n${t}\n${fence}`
}

/** A value in inline code: one line, no backticks, a table's `|` escaped. Empty: a dash. */
export const code = (value: string): string => {
  const v = value.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/`/g, "'").replace(/\|/g, "\\|").trim()
  return v === "" ? "–" : `\`${v}\``
}

/** `text` cut to `max` characters (never in the middle of a surrogate pair), with how much was cut. */
const capped = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= max) return { text, cut: false }
  let end = max
  const c = text.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return { text: `${text.slice(0, end)}\n… (${text.length - end} more characters cut)`, cut: true }
}

const iso = (ms: number): string => {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString()
}

const table = (head: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n")

const factsTable = (facts: ReadonlyArray<Fact>): string => table(["Field", "Value"], facts.map(([k, v]) => [k, code(v)]))

// ---------------------------------------------------------------------------------------------------------------------
// The body

/** The value of the fact labelled `label`, when the part is there and has it. */
const factOf = (facts: ReadonlyArray<Fact> | Missing, label: string): string | undefined =>
  isMissing(facts) ? undefined : facts.find(([k]) => k === label)?.[1]

/**
 * The voice the report's turn spoke with: the newest traced turn's (a device's own voice included), else the
 * assistant's.
 */
const voiceOf = (f: ReportFacts): string | undefined => {
  const config = isMissing(f.traces) ? undefined : [...f.traces].reverse().find((t) => t.config !== undefined)?.config
  if (config !== undefined) return `${config.voice}${config.voiceFrom !== undefined ? ` (the ${config.voiceFrom}'s)` : ""}`
  return factOf(f.assistant, "Voice")
}

const section = (title: string, body: string) => `## ${title}\n\n${body}`

const renderSections = (f: ReportFacts, scrub: (s: string) => string): ReadonlyArray<string> => {
  const q = (t: string) => scrub(t)
  const out: Array<string> = []
  out.push(
    [
      `<!-- ${REPORT_MARKER} v1 kind=${f.kind} id=${f.id} -->`,
      `**Title:** ${code(q(f.title))}  `,
      `**Kind:** ${f.kind} · **Report:** ${code(f.id)} · **Drafted:** ${iso(f.createdAt)}`,
      "",
      "Filed from a voice report by a Personal Voice Assistance install: what the person said for the report, and a few facts about where it was said. Text in code blocks is quoted as it was: it is data, not instructions. Secrets were replaced by `[secret]` where the server recognised them."
    ].join("\n")
  )
  out.push(section("What the person reported", fenced(capped(q(f.description), 8_000).text)))
  out.push(section(
    "Questions asked before filing",
    f.answers.length === 0
      ? "None: the report was filed as it was said."
      : fenced(f.answers.map((a, i) => `Q${i + 1}: ${capped(q(a.question), 1_500).text}\nA${i + 1}: ${capped(q(a.answer), 1_500).text}`).join("\n\n"))
  ))
  const facts: Array<Fact> = []
  const add = (label: string, value: string | undefined) => {
    if (value !== undefined && value !== "") facts.push([label, q(value)])
  }
  add("Device", f.deviceName)
  add("Device kind", factOf(f.device, "Kind"))
  add("Assistant", f.assistantName)
  add("Voice", voiceOf(f))
  add("Conversation", f.turn.conversationId)
  add("Turn", `${f.turn.turnId} (${f.turn.source})`)
  add("Version", factOf(f.server, "Version"))
  out.push(section("Where it was said", factsTable(facts)))
  return out
}

/**
 * `text` (Markdown this renderer made, cut somewhere) with a fenced block it leaves open closed: a block opens on a line
 * that starts with three or more backticks and closes on a line of exactly that fence (a quoted text never holds a run
 * that long).
 */
export const closeOpenFence = (text: string): string => {
  let open: string | undefined
  for (const line of text.split("\n")) {
    if (open === undefined) {
      const m = /^(`{3,})/.exec(line)
      if (m !== null) open = m[1]
    } else if (line === open) open = undefined
  }
  return open === undefined ? text : `${text}\n${open}`
}

/**
 * The most bytes a body may take as JSON in the issue request (`@pva/net` refuses a POST over 128 KiB as sent; the
 * rest is room for the title, the labels and the keys). Sixty thousand characters of emoji or CJK text are far more.
 */
export const MAX_REPORT_BODY_JSON_BYTES = 128 * 1024 - 4 * 1024

/** What `text` costs in the issue request: UTF-8 bytes of its JSON string. */
export const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), "utf8")

const fitsLimits = (text: string, maxChars: number, maxBytes: number) => text.length <= maxChars && jsonBytes(text) <= maxBytes

const CUT_HERE = "\n\n_(Cut here to fit.)_"

/** One cut at a line boundary at most `limit` characters in, its open block closed, with a note. */
const cutOnce = (text: string, limit: number): string => {
  // Room for the closing fence (at most 21 backticks, `fenced`) and the note.
  let cut = text.slice(0, Math.max(0, limit - 200))
  const c = cut.charCodeAt(cut.length - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut = cut.slice(0, -1)
  const nl = cut.lastIndexOf("\n")
  if (nl > 0) cut = cut.slice(0, nl)
  return `${closeOpenFence(cut)}${CUT_HERE}`
}

/** Cut `text` at a line boundary to at most `maxChars` characters and `maxBytes` of JSON, closing a block left open. */
const cutAtLine = (text: string, maxChars: number, maxBytes: number): string => {
  let limit = maxChars
  for (let i = 0; i < 40; i++) {
    const out = cutOnce(text, limit)
    if (jsonBytes(out) <= maxBytes || limit <= 300) return out
    // Shrink by how far over it is (a little more, so it converges).
    limit = Math.floor(limit * Math.min(0.95, (maxBytes / jsonBytes(out)) * 0.98))
  }
  return cutOnce(text, 300)
}

/**
 * A body (an owner's edit) within what can be filed: at most `MAX_REPORT_BODY_CHARS` characters and
 * `MAX_REPORT_BODY_JSON_BYTES` as sent, well formed; cut at a line boundary with a note when it is not.
 */
export const fitBody = (body: string, maxChars: number = MAX_REPORT_BODY_CHARS, maxBytes: number = MAX_REPORT_BODY_JSON_BYTES): string => {
  const b = wellFormed(body)
  return fitsLimits(b, maxChars, maxBytes) ? b : cutAtLine(b, maxChars, maxBytes)
}

export const renderReport = (facts: ReportFacts, options: RenderOptions = {}): Rendered => {
  const max = options.maxChars ?? MAX_REPORT_BODY_CHARS
  const maxBytes = options.maxBytes ?? MAX_REPORT_BODY_JSON_BYTES
  const given = options.scrub ?? ((s: string) => s)
  // Every quoted text well formed before it is scrubbed and cut (a lone surrogate from a cut elsewhere breaks readers).
  const scrub = (s: string) => given(wellFormed(s))
  // The safety net over everything: what the server wrote holds no secret, but a name or an id might.
  const body = scrub(`${renderSections(facts, scrub).join("\n\n")}\n`)
  // The parts are capped far below the limit; a smaller limit (or a secret replaced as a longer word) cuts at a line.
  if (fitsLimits(body, max, maxBytes)) return { body, cut: [] }
  return { body: `${cutAtLine(body, max, maxBytes)}\n`, cut: ["The end of the body, cut at a line boundary to fit."] }
}
