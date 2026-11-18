import { Effect } from "effect"
import type { ExpandLimits, ExpandOutput, Occ } from "./expand.ts"

/**
 * The reading task's input and answer as they cross the thread boundary (docs/MODULES.md §15, `offThread`).
 *
 * - **In**: one flat record of strings and numbers (`TaskInput`): the file, the window, the household's zone, the
 *   forbidden texts as one JSON string, and the limits as plain fields.
 * - **Out**: one string of lines, one JSON record per line (`encodeAnswer`): a header (`{"ok":true,"count":N,
 *   "unreadable":U}` or `{"ok":false,"reason":…}`), then one line per occurrence. A string crosses at the cost of its
 *   bytes; a structure of thousands of objects would cost the main thread by the object, and is refused over 128 KiB.
 *   The main thread reads it in batches of `ANSWER_BATCH` lines with a real yield (a macrotask) between them, checks
 *   every line, and takes nothing of an answer that has a line it cannot read: the whole read fails.
 */

/** The task's input: one level, strings and numbers only. */
export interface TaskInput {
  readonly text: string
  readonly from: number
  readonly to: number
  readonly zone: string
  /** A JSON array of lower-case strings (`secretPartsOf`). */
  readonly forbidden: string
  readonly maxEvents: number
  readonly maxOccurrences: number
  readonly maxRows: number
  readonly seriesSteps: number
  readonly titleChars: number
  readonly placeChars: number
}

export const taskInput = (request: { readonly text: string; readonly from: number; readonly to: number; readonly zone: string; readonly forbidden: ReadonlyArray<string>; readonly limits: ExpandLimits }): TaskInput => ({
  text: request.text,
  from: request.from,
  to: request.to,
  zone: request.zone,
  forbidden: JSON.stringify(request.forbidden),
  maxEvents: request.limits.events,
  maxOccurrences: request.limits.occurrences,
  maxRows: request.limits.rows,
  seriesSteps: request.limits.seriesSteps,
  titleChars: request.limits.titleChars,
  placeChars: request.limits.placeChars
})

/** The task's side: the flat input back into the reading function's request. */
export const fromTaskInput = (input: TaskInput) => {
  const parsed: unknown = JSON.parse(input.forbidden)
  const forbidden = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  return {
    text: input.text,
    from: input.from,
    to: input.to,
    zone: input.zone,
    forbidden,
    limits: { events: input.maxEvents, occurrences: input.maxOccurrences, rows: input.maxRows, seriesSteps: input.seriesSteps, titleChars: input.titleChars, placeChars: input.placeChars }
  }
}

/** The answer as one string of JSON lines (the task's side). */
export const encodeAnswer = (out: ExpandOutput): string => {
  if (!out.ok) return JSON.stringify({ ok: false, reason: out.reason })
  const lines = [JSON.stringify({ ok: true, count: out.occurrences.length, unreadable: out.unreadable })]
  for (const o of out.occurrences) lines.push(JSON.stringify(o))
  return lines.join("\n")
}

/** Lines read between two yields: each batch is well under a millisecond. */
export const ANSWER_BATCH = 200

/** A real yield to the event loop (a macrotask), so audio and timers run between batches. */
const yieldToLoop = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)
const INSTANT_MAX = 8_640_000_000_000_000

/** One occurrence line, checked field by field; `undefined` when it is not one. */
const occOf = (line: string, limits: Pick<ExpandLimits, "titleChars" | "placeChars">): Occ | undefined => {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const known = new Set(["key", "start", "end", "allDay", "first", "last", "beyond", "title", "location", "busy"])
  if (Object.keys(o).some((k) => !known.has(k))) return undefined
  if (typeof o.key !== "string" || !/^[0-9a-f]{24}$/.test(o.key)) return undefined
  if (!isInt(o.start, 0, INSTANT_MAX) || !isInt(o.end, 0, INSTANT_MAX) || o.end < o.start) return undefined
  if (!isInt(o.first, 19_000_101, 29_991_231) || !isInt(o.last, 19_000_101, 29_991_231) || o.last < o.first) return undefined
  if (typeof o.allDay !== "boolean" || typeof o.beyond !== "boolean" || typeof o.busy !== "boolean") return undefined
  if (!isText(o.title, limits.titleChars)) return undefined
  if (o.location !== undefined && (!isText(o.location, limits.placeChars) || o.location === "")) return undefined
  return {
    key: o.key,
    start: o.start,
    end: o.end,
    allDay: o.allDay,
    first: o.first,
    last: o.last,
    beyond: o.beyond,
    title: o.title,
    ...(o.location !== undefined ? { location: o.location as string } : {}),
    busy: o.busy
  }
}

/** The answer could not be read (a line that is not a record, a count that does not match): nothing of it is used. */
export class AnswerUnreadable extends Error {}

/**
 * The answer read on the main thread, `ANSWER_BATCH` lines at a time with a real yield between batches. Fails with
 * `AnswerUnreadable` when any line cannot be read, when the count does not match, or when it is over the limit on
 * occurrences: a refresh never publishes part of an answer.
 */
export const readAnswer = (text: string, limits: Pick<ExpandLimits, "occurrences" | "titleChars" | "placeChars">): Effect.Effect<ExpandOutput, AnswerUnreadable> =>
  Effect.gen(function*() {
    const fail = () => Effect.fail(new AnswerUnreadable())
    const headEnd = text.indexOf("\n")
    let header: unknown
    try {
      header = JSON.parse(headEnd < 0 ? text : text.slice(0, headEnd))
    } catch {
      return yield* fail()
    }
    if (typeof header !== "object" || header === null) return yield* fail()
    const h = header as Record<string, unknown>
    if (h.ok === false) {
      if (h.reason === "not-calendar" || h.reason === "too-many") return { ok: false, reason: h.reason } as const
      return yield* fail()
    }
    if (h.ok !== true || !isInt(h.count, 0, limits.occurrences) || !isInt(h.unreadable, 0, 1_000_000)) return yield* fail()
    const count = h.count
    const out: Array<Occ> = []
    let pos = headEnd < 0 ? text.length : headEnd + 1
    while (out.length < count) {
      for (let n = 0; n < ANSWER_BATCH && out.length < count; n++) {
        if (pos >= text.length) return yield* fail()
        const end = text.indexOf("\n", pos)
        const line = end < 0 ? text.slice(pos) : text.slice(pos, end)
        pos = end < 0 ? text.length : end + 1
        const o = occOf(line, limits)
        if (o === undefined) return yield* fail()
        out.push(o)
      }
      yield* yieldToLoop
    }
    // Nothing may follow the last occurrence.
    if (pos < text.length) return yield* fail()
    return { ok: true, occurrences: out, unreadable: h.unreadable } as const
  })
