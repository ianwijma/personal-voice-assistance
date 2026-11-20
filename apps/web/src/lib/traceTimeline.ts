/**
 * The pure model behind the latency page's open row (docs/ASSISTANTS.md §7.1): labels, lanes, the time axis in pixels
 * (a shortened "reply" view and an "entire turn" view), sub-row packing, the derived "between two moments" bars, the
 * keyboard order, the phone list, the notes for a turn that did not complete, and the modules-and-tools model. No DOM:
 * every function takes the widths it needs, so it is tested without a layout.
 */
import type { TraceEvent, TraceEventName, TraceInfo } from "@pva/protocol"

/** The most entries a trace carries (the protocol's limit); the model is one sort and linear passes over them. */
export const MAX_ENTRIES = 200

/** A plain-words label for every name the protocol knows (`TRACE_EVENT_NAMES`); the type makes a missing one a compile error. */
export const EVENT_LABELS: Readonly<Record<TraceEventName, string>> = {
  speechStarted: "Started talking",
  firstInterim: "First words recognised",
  eagerEndOfTurn: "Early transcript (reply started early)",
  turnResumed: "Kept talking (early start dropped)",
  endOfTurn: "Finished talking",
  turnStarted: "Turn began",
  wakePhrase: "Wake phrase heard",
  routing: "TypeSafe chose the assistant",
  assistantChosen: "Assistant chosen",
  llmRequestSent: "Language model: request sent",
  llmFirstToken: "Language model: first token",
  llmDone: "Language model: finished",
  decisionSent: "Intent: decision asked",
  decisionReceived: "Intent: decision answered",
  action: "Action ran",
  tool: "Tool call",
  firstClause: "First clause ready to speak",
  // Older servers sent it; the current one does not, but the name is still in the protocol list.
  ttsRequestSent: "Voice: synthesis asked for",
  ttsFirstAudio: "Voice: first audio",
  ttsDone: "Voice: all audio made",
  audioSent: "First audio sent to the device",
  playbackStart: "Device started playing",
  audible: "Sound audible",
  playbackEnd: "Playback ended",
  turnEnded: "Turn ended"
}

const isKnown = (name: string): name is TraceEventName => Object.prototype.hasOwnProperty.call(EVENT_LABELS, name)

/**
 * The page's name for a typed turn's `endOfTurn` (`timelineOf` renames it): the text was sent, nobody talked. It is
 * only in the lists, as the zero line says "text sent"; a typed turn has no speaking lane.
 */
export const TEXT_SENT = "textSent"
/** The end of turn (0), spoken or typed: drawn and listed in bold. */
export const isZeroEntry = (name: string): boolean => name === "endOfTurn" || name === TEXT_SENT

export interface EventText {
  readonly label: string
  /** What is left for the detail column ("round N" is part of the label of a language-model entry). */
  readonly detail: string | undefined
}

/** The words for one entry. An unknown name is shown as it is. */
export const eventText = (e: TraceEvent): EventText => {
  // An action or tool without a duration was still running when the turn ended (its time line was published then).
  const unfinished = e.ms === undefined && (e.name === "action" || e.name === "tool")
  const base = unfinished
    ? `${e.name === "action" ? "Action" : "Tool call"} started (still running when the turn ended)`
    : isKnown(e.name) ? EVENT_LABELS[e.name] : e.name === TEXT_SENT ? "Text sent" : e.name
  if (e.detail !== undefined && /^round \d+$/.test(e.detail)) return { label: `${base} · ${e.detail}`, detail: undefined }
  return { label: base, detail: e.detail }
}

// ---- Formatting

/** −2,400 / +312 / 0, the way the page prints a time (a real minus sign, thousands apart). */
export const signed = (n: number): string => {
  const r = Math.round(n)
  const body = Math.abs(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return r === 0 ? "0" : `${r < 0 ? "−" : "+"}${body}`
}
export const plain = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
/** "380 ms" below a second, else one decimal of seconds ("2.3 s"). */
export const fmtDur = (ms: number): string => (Math.abs(ms) < 1000 ? `${plain(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

/** Latency colour: muted below the 800 ms target, warn from 800, danger from 1500. */
export const latencyTone = (ms: number) => (ms >= 1500 ? "text-danger" : ms >= 800 ? "text-warn" : "text-ink-muted")

// ---- Lanes

export type LaneId = "hearing" | "choosing" | "model" | "tools" | "voice" | "playback" | "other"

export interface LaneDef {
  readonly id: LaneId
  /** The full name (a lane's aria-label). */
  readonly label: string
  /** The gutter label, and the phone list's. */
  readonly short: string
  readonly names: ReadonlyArray<string>
}

/** The lanes in turn order, with the names each takes. `turnStarted` and `turnEnded` are only in the lists; an unknown name goes to "other". */
export const LANES: ReadonlyArray<LaneDef> = [
  { id: "hearing", label: "Speaking and hearing", short: "Speaking", names: ["speechStarted", "firstInterim", "eagerEndOfTurn", "turnResumed", "endOfTurn"] },
  { id: "choosing", label: "Choosing the assistant", short: "Choosing assistant", names: ["wakePhrase", "routing", "assistantChosen"] },
  { id: "model", label: "Language model", short: "Language model", names: ["llmRequestSent", "llmFirstToken", "llmDone", "decisionSent", "decisionReceived", "action"] },
  { id: "tools", label: "Tools", short: "Tools", names: ["tool"] },
  { id: "voice", label: "Voice", short: "Voice", names: ["firstClause", "ttsRequestSent", "ttsFirstAudio", "ttsDone"] },
  { id: "playback", label: "Playback", short: "Playback", names: ["audioSent", "playbackStart", "audible", "playbackEnd"] },
  { id: "other", label: "Other", short: "Other", names: [] }
]

const NOT_IN_A_LANE: ReadonlySet<string> = new Set(["turnStarted", "turnEnded", TEXT_SENT])

/** The lane of an entry; undefined for the two that only the lists show. */
export const laneOf = (name: string): LaneId | undefined => {
  if (NOT_IN_A_LANE.has(name)) return undefined
  return LANES.find((l) => l.names.includes(name))?.id ?? "other"
}
export const laneDef = (id: LaneId): LaneDef => LANES.find((l) => l.id === id)!
const laneRank = (id: LaneId): number => LANES.findIndex((l) => l.id === id)

export const endOf = (e: TraceEvent): number => e.at + (e.ms ?? 0)

export interface LaneView {
  readonly id: LaneId
  readonly label: string
  readonly short: string
  /** The lane's entries as indices into the time line, in order. */
  readonly indices: ReadonlyArray<number>
}

/** The lanes that have entries, in turn order; each holds indices into `events` (which is sorted by `at`). */
export const groupLanes = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<LaneView> =>
  LANES.flatMap((lane) => {
    const indices: Array<number> = []
    events.forEach((e, i) => {
      if (laneOf(e.name) === lane.id) indices.push(i)
    })
    return indices.length === 0 ? [] : [{ id: lane.id, label: lane.label, short: lane.short, indices }]
  })

// ---- The axis

export type AxisMode = "reply" | "entire"

export interface Segment {
  readonly from: number
  readonly to: number
  readonly x0: number
  readonly x1: number
  readonly shortened: boolean
}

export interface Axis {
  readonly mode: AxisMode
  readonly width: number
  readonly min: number
  readonly max: number
  readonly segments: ReadonlyArray<Segment>
  /** Time to a pixel; a time in a shortened part is placed linearly inside that part. */
  readonly x: (t: number) => number
  /** Labelled ticks, only over the linear part, plus the outer edge of a shortened part (`edge`). */
  readonly ticks: ReadonlyArray<{ readonly t: number; readonly x: number; readonly label: string; readonly edge: boolean }>
  /** The 14 px gaps between a shortened part and the linear one: their pixel range. */
  readonly breaks: ReadonlyArray<{ readonly x0: number; readonly x1: number }>
  readonly captions: ReadonlyArray<{ readonly x0: number; readonly x1: number; readonly text: string }>
  readonly shortened: boolean
  /** The pixel ranges a time range covers, without the gaps (so a bar crossing a break is two pieces). */
  readonly pieces: (t0: number, t1: number) => ReadonlyArray<readonly [number, number]>
}

export const BREAK_PX = 14
const SHORT_SHARE = 0.12
const SHORT_TRIGGER = 0.18
const TICK_GAP_PX = 80
const STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 30000, 60000, 120000, 300000]
const niceStep = (perMs: number): number => STEPS.find((s) => s * perMs >= TICK_GAP_PX) ?? STEPS[STEPS.length - 1]!

const NOT_WORK: ReadonlySet<string> = new Set(["speechStarted", "firstInterim", "wakePhrase", "turnResumed"])

/**
 * The shared time axis in pixels for a plot `widthPx` wide.
 *
 * "reply" (the default): the speaking before the reply's work and the playback after the sound are shortened to a
 * fixed 12 % of the width each when they would take more than 18 % of the whole range, each followed by a 14 px break
 * (drawn `//`) and captioned ("2.3 s, shortened"); everything between is one linear scale. Labels exist only where the
 * scale is linear (plus the outer edge of a shortened part); every entry's exact time is in the tooltip and the lists.
 * "entire": one linear scale over the whole range, no breaks.
 *
 * `endAt`: where a turn that did not complete ended, so its end line fits in the range.
 */
export const makeAxis = (events: ReadonlyArray<TraceEvent>, widthPx: number, mode: AxisMode, endAt?: number): Axis => {
  const W = Math.max(widthPx, 1)
  const placed = events.filter((e) => laneOf(e.name) !== undefined)
  const min = Math.min(0, ...placed.map((e) => e.at))
  const ends = placed.map(endOf)
  if (endAt !== undefined) ends.push(endAt)
  const max = Math.max(50, ...ends)
  const core = Math.max(0, ...placed.filter((e) => e.name !== "playbackEnd").map(endOf), ...(endAt === undefined ? [] : [endAt]))
  const work = placed.filter((e) => !NOT_WORK.has(e.name))
  const earliestWork = Math.min(0, ...work.map((e) => e.at))
  const pad = Math.max(20, 0.03 * (core - earliestWork))
  const a1 = Math.max(min, earliestWork - pad)
  const b1 = Math.min(max, core + pad)
  const range = max - min
  const shortA = mode === "reply" && a1 > min && (a1 - min) / range > SHORT_TRIGGER
  const shortC = mode === "reply" && max > b1 && (max - b1) / range > SHORT_TRIGGER
  const linLo = shortA ? a1 : min
  const linHi = shortC ? b1 : max
  const shortW = SHORT_SHARE * W
  const left = shortA ? shortW + BREAK_PX : 0
  const right = shortC ? shortW + BREAK_PX : 0
  const linW = Math.max(W - left - right, 40)
  const perMs = linW / Math.max(linHi - linLo, 1)
  const segments: Array<Segment> = []
  if (shortA) segments.push({ from: min, to: a1, x0: 0, x1: shortW, shortened: true })
  segments.push({ from: linLo, to: linHi, x0: left, x1: left + linW, shortened: false })
  if (shortC) segments.push({ from: b1, to: max, x0: left + linW + BREAK_PX, x1: left + linW + BREAK_PX + shortW, shortened: true })
  const x = (t: number): number => {
    if (shortA && t < linLo) return (Math.max(t, min) - min) / (a1 - min) * shortW
    if (shortC && t > linHi) return left + linW + BREAK_PX + (Math.min(t, max) - b1) / (max - b1) * shortW
    return left + (Math.min(Math.max(t, linLo), linHi) - linLo) * perMs
  }
  const breaks: Array<{ x0: number; x1: number }> = []
  if (shortA) breaks.push({ x0: shortW, x1: shortW + BREAK_PX })
  if (shortC) breaks.push({ x0: left + linW, x1: left + linW + BREAK_PX })
  const captions: Array<{ x0: number; x1: number; text: string }> = []
  if (shortA) captions.push({ x0: 0, x1: shortW, text: `${fmtDur(a1 - min)}, shortened` })
  if (shortC) captions.push({ x0: left + linW + BREAK_PX, x1: left + linW + BREAK_PX + shortW, text: `${fmtDur(max - b1)}, shortened` })
  const step = niceStep(perMs)
  const ticks: Array<{ t: number; x: number; label: string; edge: boolean }> = []
  if (shortA) ticks.push({ t: min, x: 0, label: signed(min), edge: true })
  for (let t = Math.ceil(linLo / step) * step; t <= linHi + 1e-9; t += step) ticks.push({ t, x: x(t), label: signed(t), edge: false })
  if (shortC) ticks.push({ t: max, x: W, label: signed(max), edge: true })
  const pieces = (t0: number, t1: number): ReadonlyArray<readonly [number, number]> => {
    const out: Array<readonly [number, number]> = []
    for (const seg of segments) {
      const a = Math.max(t0, seg.from)
      const b = Math.min(t1, seg.to)
      // Placed inside this segment: at a boundary `x` would give the next segment's pixel, across the break.
      const within = (t: number) => seg.x0 + (seg.to > seg.from ? (t - seg.from) / (seg.to - seg.from) : 0) * (seg.x1 - seg.x0)
      if (b >= a && (b > a || (t0 === t1 && t0 >= seg.from && t0 <= seg.to))) out.push([within(a), within(b)])
    }
    return out
  }
  return { mode, width: W, min, max, segments, x, ticks, breaks, captions, shortened: shortA || shortC, pieces }
}

// ---- Packing into sub-rows

export const SUB_ROWS = 3
const MOMENT_HALF = 6
const SPAN_MIN = 4
const ROW_GAP = 2

/** Where an entry sits in pixels: [left, right]. A moment is ±6 px around its time, a span runs from its start for at least 4 px. */
export const extentOf = (e: TraceEvent, axis: Axis): readonly [number, number] => {
  const x = axis.x(e.at)
  if (e.ms === undefined) return [x - MOMENT_HALF, x + MOMENT_HALF]
  return [x, x + Math.max(axis.x(endOf(e)) - x, SPAN_MIN)]
}

/**
 * Put a lane's entries (sorted by time) in at most `SUB_ROWS` sub-rows, one pass: the first sub-row whose last right
 * edge plus 2 px is at or before the entry's left edge; when all are taken, the one with the smallest right edge (least
 * overlap). `rowOf[i]` is the sub-row of the lane's i-th entry.
 */
export const packLane = (entries: ReadonlyArray<TraceEvent>, axis: Axis): { readonly rowOf: ReadonlyArray<number>; readonly rows: number } => {
  const lasts: Array<number> = []
  const rowOf = entries.map((e) => {
    const [l, r] = extentOf(e, axis)
    let row = lasts.findIndex((last) => last + ROW_GAP <= l)
    if (row === -1) {
      if (lasts.length < SUB_ROWS) row = lasts.length
      else row = lasts.indexOf(Math.min(...lasts))
    }
    lasts[row] = Math.max(r, lasts[row] ?? -Infinity)
    return row
  })
  return { rowOf, rows: Math.max(lasts.length, 1) }
}

const CHAR_PX = 6.2
/** The text beside a Tools or Choosing span: "add_note 2 ms". */
export const inlineText = (e: TraceEvent): string | undefined =>
  e.ms === undefined || (laneOf(e.name) !== "tools" && laneOf(e.name) !== "choosing") ? undefined : `${e.detail ?? eventText(e).label} ${plain(e.ms)} ms`

/** Which of a lane's spans may show their inline text: it must end (4 px after the bar) before the next entry of its sub-row and inside the plot. */
export const inlineLabels = (entries: ReadonlyArray<TraceEvent>, rowOf: ReadonlyArray<number>, axis: Axis): ReadonlySet<number> => {
  const shown = new Set<number>()
  entries.forEach((e, i) => {
    const text = inlineText(e)
    if (text === undefined) return
    const [, r] = extentOf(e, axis)
    const end = r + 4 + text.length * CHAR_PX
    if (end > axis.width) return
    for (let j = i + 1; j < entries.length; j++) {
      if (rowOf[j] === rowOf[i]) {
        if (extentOf(entries[j]!, axis)[0] < end + ROW_GAP) return
        break
      }
    }
    shown.add(i)
  })
  return shown
}

// ---- Derived bars: between two moments

export type PairKind = "round" | "voice" | "playback" | "decision" | "speaking"
export interface Pair {
  /** Indices into the time line. */
  readonly from: number
  readonly to: number
  readonly lane: LaneId
  readonly kind: PairKind
  readonly label: string
}
/** The words after an entry that ends a derived bar: "round took 794 ms". */
export const PAIR_WORD: Readonly<Record<PairKind, string>> = { round: "round", voice: "voice", playback: "playback", decision: "decision", speaking: "speaking" }

/**
 * The hollow bars between two moments, matched within the time line in order (and by "round N" where there is one):
 * request to done per language-model round, first clause to the last audio made, playback start to end, decision asked to
 * answered, started talking to finished. A bar needs both ends; a missing end gives no bar.
 */
export const derivedPairs = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<Pair> => {
  const out: Array<Pair> = []
  const idx = (name: string) => events.flatMap((e, i) => (e.name === name ? [i] : []))
  // Each completion (in time order) ends the latest compatible request still open before it. A request with a later
  // compatible one before that completion got no answer (a model that failed, then a fallback numbered from round 1
  // again): it is closed unpaired, so no completion is matched across a later request.
  const compatible = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined || a === b
  const closed = new Set<number>()
  const requests = idx("llmRequestSent")
  for (const j of [...idx("llmDone")].sort((a, b) => events[a]!.at - events[b]!.at || a - b)) {
    const done = events[j]!
    const open = requests.filter((i) => !closed.has(i) && events[i]!.at <= done.at && compatible(events[i]!.detail, done.detail))
    if (open.length === 0) continue
    const i = open.reduce((best, k) => (events[k]!.at > events[best]!.at || (events[k]!.at === events[best]!.at && k > best) ? k : best))
    for (const k of open) closed.add(k)
    const want = events[i]!.detail
    out.push({ from: i, to: j, lane: "model", kind: "round", label: want === undefined ? "Language model round" : `Language model ${want}` })
  }
  const once = (a: string, b: string, lane: LaneId, kind: PairKind, label: string) => {
    const i = idx(a)[0]
    const js = idx(b)
    const j = i === undefined ? undefined : js.filter((k) => events[k]!.at >= events[i]!.at).pop()
    if (i !== undefined && j !== undefined) out.push({ from: i, to: j, lane, kind, label })
  }
  once("firstClause", "ttsDone", "voice", "voice", "Voice")
  once("playbackStart", "playbackEnd", "playback", "playback", "Playback")
  once("speechStarted", "endOfTurn", "hearing", "speaking", "Speaking")
  const ds = idx("decisionSent")
  const dr = idx("decisionReceived")
  ds.forEach((i, n) => {
    const j = dr[n]
    if (j !== undefined && events[j]!.at >= events[i]!.at) out.push({ from: i, to: j, lane: "model", kind: "decision", label: "Decision" })
  })
  return out
}

// ---- Keyboard order

const lowerBound = (list: ReadonlyArray<number>, events: ReadonlyArray<TraceEvent>, at: number): number => {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[list[mid]!]!.at < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface Nav {
  /** Indices of the entries that have a mark, in time order, ties by lane order then list order. */
  readonly order: ReadonlyArray<number>
  readonly byLane: ReadonlyMap<LaneId, ReadonlyArray<number>>
  /** The lanes that have entries, top to bottom. */
  readonly lanes: ReadonlyArray<LaneId>
}

export const navOrder = (events: ReadonlyArray<TraceEvent>): Nav => {
  const marked = events.flatMap((e, i) => (laneOf(e.name) === undefined ? [] : [i]))
  const order = [...marked].sort((a, b) => events[a]!.at - events[b]!.at || laneRank(laneOf(events[a]!.name)!) - laneRank(laneOf(events[b]!.name)!) || a - b)
  const byLane = new Map<LaneId, Array<number>>()
  for (const i of order) {
    const lane = laneOf(events[i]!.name)!
    byLane.set(lane, [...(byLane.get(lane) ?? []), i])
  }
  return { order, byLane, lanes: LANES.map((l) => l.id).filter((id) => byLane.has(id)) }
}

/** Up / Down: the entry nearest in time in the nearest lane above (-1) or below (1); undefined at the edge. */
export const nearestInLane = (nav: Nav, events: ReadonlyArray<TraceEvent>, from: number, dir: -1 | 1): number | undefined => {
  const here = laneOf(events[from]!.name)
  if (here === undefined) return undefined
  const target = nav.lanes[nav.lanes.indexOf(here) + dir]
  if (target === undefined) return undefined
  const list = nav.byLane.get(target)!
  const at = events[from]!.at
  const k = lowerBound(list, events, at)
  const cands = [list[k - 1], list[k]].filter((c): c is number => c !== undefined)
  return cands.sort((a, b) => Math.abs(events[a]!.at - at) - Math.abs(events[b]!.at - at))[0]
}

// ---- The lists

export interface ListRow {
  readonly index: number
  readonly event: TraceEvent
  readonly text: EventText
  /** Since the previous entry; undefined for the first. */
  readonly gap: number | undefined
  /** For an entry that ends a derived bar: how long from its start, and the start's label and the kind. */
  readonly derivedMs?: number
  readonly derivedFrom?: string
  readonly derivedKind?: PairKind
}

export const listRows = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<ListRow> => {
  const ends = new Map(derivedPairs(events).map((p) => [p.to, p]))
  return events.map((event, index) => {
    const p = ends.get(index)
    return {
      index,
      event,
      text: eventText(event),
      gap: index === 0 ? undefined : event.at - events[index - 1]!.at,
      ...(p === undefined ? {} : { derivedMs: event.at - events[p.from]!.at, derivedFrom: eventText(events[p.from]!).label, derivedKind: p.kind })
    }
  })
}

export type PhoneRow =
  | { readonly kind: "row"; readonly row: ListRow; readonly gapMs: number | undefined }
  | { readonly kind: "run"; readonly id: string; readonly rows: ReadonlyArray<ListRow>; readonly name: string; readonly lane: string; readonly from: number; readonly to: number; readonly totalMs: number }

export const RUN_MIN = 4

/** The phone list: the rows in order, with a run of 4 or more of the same name in the same lane folded into one. */
export const phoneRows = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<PhoneRow> => {
  const rows = listRows(events)
  const out: Array<PhoneRow> = []
  let i = 0
  while (i < rows.length) {
    const lane = laneOf(rows[i]!.event.name)
    let j = i + 1
    while (j < rows.length && rows[j]!.event.name === rows[i]!.event.name && laneOf(rows[j]!.event.name) === lane) j++
    if (j - i >= RUN_MIN) {
      const run = rows.slice(i, j)
      const first = run[0]!.event
      out.push({
        kind: "run",
        id: `run-${i}`,
        rows: run,
        name: first.name,
        lane: lane === undefined ? "Turn" : laneDef(lane).short,
        from: first.at,
        to: Math.max(...run.map((r) => endOf(r.event))),
        totalMs: Math.max(...run.map((r) => endOf(r.event))) - first.at
      })
    } else for (let k = i; k < j; k++) out.push({ kind: "row", row: rows[k]!, gapMs: rows[k]!.gap })
    i = j
  }
  return out
}

/** The rail gap above a phone row: nothing under 50 ms, else a dashed segment 6 px per doubling (up to 36 px) taller. */
export const gapExtraPx = (gapMs: number): number => (gapMs < 50 ? 0 : Math.min(36, Math.max(0, 6 * Math.log2(gapMs / 50))))

// ---- Where the time line comes from

export interface TimelineOf {
  readonly events: ReadonlyArray<TraceEvent>
  /** "recorded": the server's `timeline`; "rebuilt": from the older marks; "none": nothing to show. */
  readonly source: "recorded" | "rebuilt" | "none"
}

/**
 * What an older server's trace allows: its marks (llmRequestSent, llmFirstToken, firstClause, ttsFirstAudio,
 * playbackStart), the audible moment from the client's output latency, TypeSafe's request from the route, and the end
 * of the turn from `totalMs`. Tool calls have no start time there, so they are left to the note.
 */
export const rebuildTimeline = (t: TraceInfo): ReadonlyArray<TraceEvent> => {
  const m = t.marks
  const out: Array<TraceEvent> = []
  const add = (name: TraceEvent["name"], at: number | undefined, extra?: Partial<TraceEvent>) => {
    if (at !== undefined) out.push({ name, at, ...extra })
  }
  if (t.route?.by === "typesafe" && m.routeSent !== undefined) {
    const ms = m.routeReceived !== undefined ? m.routeReceived - m.routeSent : t.route.ms
    out.push({ name: "routing", at: m.routeSent, ms: Math.max(0, ms) })
  }
  add("llmRequestSent", m.llmRequestSent)
  add("llmFirstToken", m.llmFirstToken)
  add("firstClause", m.firstClause)
  add("ttsFirstAudio", m.ttsFirstAudio)
  add("playbackStart", m.playbackStart)
  if (m.playbackStart !== undefined && t.client !== undefined) add("audible", m.playbackStart + t.client.outputLatencyMs)
  if (out.length === 0) return []
  out.push({ name: "endOfTurn", at: 0 })
  if (t.totalMs !== undefined) out.push({ name: "turnEnded", at: t.totalMs, detail: t.outcome })
  return out.sort((a, b) => a.at - b.at)
}

/** Sorted once. A recorded time line is used as it is (at most `MAX_ENTRIES`, the protocol's limit). */
export const timelineOf = (t: TraceInfo): TimelineOf => {
  // A typed turn's end of turn is when the text was sent (`TEXT_SENT`).
  const named = (events: ReadonlyArray<TraceEvent>): Array<TraceEvent> =>
    t.mode === "text" ? events.map((e) => (e.name === "endOfTurn" ? { ...e, name: TEXT_SENT } : e)) : [...events]
  if (t.timeline !== undefined && t.timeline.length > 0) return { events: named(t.timeline).sort((a, b) => a.at - b.at), source: "recorded" }
  const events = rebuildTimeline(t)
  return events.length > 0 ? { events: named(events), source: "rebuilt" } : { events: [], source: "none" }
}

// ---- A turn that did not complete

const OUTCOME_WORD: Readonly<Record<TraceInfo["outcome"], string>> = { completed: "completed", interrupted: "interrupted", failed: "failed", discarded: "discarded" }
export const outcomeWord = (o: TraceInfo["outcome"]): string => OUTCOME_WORD[o]

/** Where a turn that did not complete ended (`turnEnded.at`, else `totalMs`; undefined when neither is known); undefined for a completed one. */
export const endInfo = (t: TraceInfo, events: ReadonlyArray<TraceEvent>): { readonly outcome: string; readonly at: number | undefined } | undefined => {
  if (t.outcome === "completed") return undefined
  const at = events.find((e) => e.name === "turnEnded")?.at ?? t.totalMs
  return { outcome: outcomeWord(t.outcome), at }
}

/** The notes above the time line: it was rebuilt, and/or the turn did not complete. */
export const endNote = (t: TraceInfo, events: ReadonlyArray<TraceEvent>): string | undefined => {
  const end = endInfo(t, events)
  if (end === undefined) return undefined
  return `This turn was ${end.outcome}${end.at === undefined ? "" : ` at ${signed(end.at)} ms`}; later steps did not happen and are not drawn.`
}

export const rebuiltNote = (t: TraceInfo): string =>
  `This server did not record a full time line; this is rebuilt from the turn's main timings.${
    t.tools.length > 0 ? ` Tool calls (start not recorded): ${t.tools.map((x) => `${x.name} ${plain(x.ms)} ms`).join(", ")}.` : ""
  }`

/** "playback start +1,490 + output latency 54 ms" when both are known, else the words. */
export const audibleDetail = (t: TraceInfo, events: ReadonlyArray<TraceEvent>): string => {
  const start = events.find((e) => e.name === "playbackStart")
  return start !== undefined && t.client !== undefined
    ? `playback start ${signed(start.at)} + output latency ${plain(t.client.outputLatencyMs)} ms`
    : "playback start + output latency"
}

// ---- Modules and tools of the Information tab

export interface ToolChip {
  readonly name: string
  readonly called: boolean
  readonly calls: number
  readonly ms: number
}
export interface ModuleBlock {
  readonly id: string
  readonly name: string
  /** Undefined: the server did not send the tool list. */
  readonly tools: ReadonlyArray<ToolChip> | undefined
}
export interface ModulesTools {
  readonly recorded: boolean
  readonly modules: ReadonlyArray<ModuleBlock>
  /** Tools without a module and called tools the list lacks. */
  readonly other: ReadonlyArray<ToolChip>
  /** What the turn called, for traces without a list. */
  readonly called: ReadonlyArray<ToolChip>
  /** "Modules and tools not recorded for this turn" and so on, when not recorded. */
  readonly message: string | undefined
  /** A known empty list of modules. */
  readonly none: boolean
}

/** The turn's called tools by name (calls and total ms). */
export const calledTools = (t: TraceInfo): ReadonlyArray<ToolChip> => {
  const map = new Map<string, { calls: number; ms: number }>()
  for (const x of t.tools) {
    const c = map.get(x.name) ?? { calls: 0, ms: 0 }
    map.set(x.name, { calls: c.calls + 1, ms: c.ms + x.ms })
  }
  return [...map.entries()].map(([name, c]) => ({ name, called: true, calls: c.calls, ms: c.ms }))
}

/** Modules, each with its tools (called ones marked), in the server's order; or what is known when it did not send the lists. */
export const modulesAndTools = (t: TraceInfo): ModulesTools => {
  const c = t.config
  const called = calledTools(t)
  const byName = new Map(called.map((x) => [x.name, x]))
  const chip = (name: string): ToolChip => byName.get(name) ?? { name, called: false, calls: 0, ms: 0 }
  if (c === undefined) return { recorded: false, modules: [], other: [], called, message: "Modules and tools not recorded for this turn.", none: false }
  if (c.moduleList === undefined && c.toolList === undefined) {
    return { recorded: false, modules: [], other: [], called, message: `Modules and tools not recorded for this turn · ${c.modules} ${c.modules === 1 ? "module" : "modules"} · ${c.tools} ${c.tools === 1 ? "tool" : "tools"}`, none: false }
  }
  if (c.toolList === undefined) {
    return { recorded: false, modules: (c.moduleList ?? []).map((m) => ({ id: m.id, name: m.name, tools: undefined })), other: [], called, message: undefined, none: false }
  }
  const modules = (c.moduleList ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    tools: c.toolList!.filter((x) => x.module === m.id).map((x) => chip(x.name))
  }))
  const ids = new Set((c.moduleList ?? []).map((m) => m.id))
  const seen = new Set<string>()
  const other: Array<ToolChip> = []
  for (const x of c.toolList) {
    if ((x.module === undefined || !ids.has(x.module)) && !seen.has(x.name)) {
      seen.add(x.name)
      other.push(chip(x.name))
    }
  }
  const listed = new Set(c.toolList.map((x) => x.name))
  for (const x of called) if (!listed.has(x.name)) other.push(x)
  return { recorded: true, modules, other, called, message: undefined, none: c.moduleList !== undefined && c.moduleList.length === 0 && other.length === 0 }
}
