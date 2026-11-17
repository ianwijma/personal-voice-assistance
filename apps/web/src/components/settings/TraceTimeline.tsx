"use client"
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { TraceEvent, TraceInfo } from "@pva/protocol"
import { firstSoundMs } from "@/lib/state.ts"
import {
  type Axis,
  type AxisMode,
  audibleDetail,
  derivedPairs,
  endInfo,
  endNote,
  endOf,
  eventText,
  fmtDur,
  gapExtraPx,
  groupLanes,
  inlineLabels,
  inlineText,
  latencyTone,
  laneDef,
  laneOf,
  type ListRow,
  listRows,
  makeAxis,
  navOrder,
  nearestInLane,
  packLane,
  PAIR_WORD,
  type PhoneRow,
  phoneRows,
  plain,
  rebuiltNote,
  signed,
  timelineOf
} from "@/lib/traceTimeline.ts"
import { cx } from "../ui/controls.tsx"

const ROW_H = 18
const PAD_V = 3
const GRID = "grid grid-cols-[128px_minmax(0,1fr)] lg:grid-cols-[160px_minmax(0,1fr)]"
const MOTION = "transition-transform duration-[120ms] motion-reduce:transition-none"

// ---- The marks, as one set of shapes for the chart, the legend, the table and the phone list

type Shape = "moment" | "zero" | "audible" | "span" | "dot" | "end"
const shapeOf = (e: TraceEvent, notCompleted = false): Shape =>
  e.ms !== undefined ? "span" : e.name === "endOfTurn" ? "zero" : e.name === "audible" ? "audible" : e.name === "turnStarted" ? "dot" : e.name === "turnEnded" ? (notCompleted ? "end" : "dot") : "moment"

function Glyph({ shape, vertical, className }: { readonly shape: Shape; readonly vertical?: boolean; readonly className?: string }) {
  switch (shape) {
    case "moment": return <span aria-hidden="true" className={cx("block size-2 rotate-45 rounded-[1px] bg-ink-muted", className)} />
    case "zero": return <span aria-hidden="true" className={cx("block size-[11px] rotate-45 rounded-[1px] bg-ink", className)} />
    case "audible": return <span aria-hidden="true" className={cx("block size-[11px] rotate-45 rounded-[1px] bg-voice ring-1 ring-ink", className)} />
    case "span": return <span aria-hidden="true" className={cx("block rounded-[2px] bg-voice", vertical ? "h-3.5 w-1" : "h-2.5 w-4", className)} />
    case "dot": return <span aria-hidden="true" className={cx("block size-[5px] rounded-full bg-ink-faint", className)} />
    case "end": return <span aria-hidden="true" className={cx("block size-2 bg-warn", className)} />
  }
}

// ---- The tooltip

interface Tip {
  readonly label: string
  readonly lines: ReadonlyArray<{ readonly text: string; readonly tone: "main" | "faint" | "detail" }>
  /** The same, joined: a mark's accessible name. */
  readonly name: string
}

function tipOf(row: ListRow, t: TraceInfo, events: ReadonlyArray<TraceEvent>): Tip {
  const e = row.event
  const lines: Array<{ text: string; tone: "main" | "faint" | "detail" }> = [
    { text: `${signed(e.at)} ms${row.gap === undefined ? "" : ` · ${signed(row.gap)} after previous`}`, tone: "main" }
  ]
  if (e.ms !== undefined) lines.push({ text: `took ${plain(e.ms)} ms`, tone: "faint" })
  if (row.derivedMs !== undefined && row.derivedKind !== undefined) lines.push({ text: `${PAIR_WORD[row.derivedKind]} took ${plain(row.derivedMs)} ms`, tone: "faint" })
  const detail = e.name === "audible" ? audibleDetail(t, events) : row.text.detail
  if (detail !== undefined) lines.push({ text: detail, tone: "detail" })
  return { label: row.text.label, lines, name: [row.text.label, ...lines.map((l) => l.text)].join(", ") }
}

function Tooltip({ tip, anchor, bounds }: { readonly tip: Tip; readonly anchor: HTMLElement; readonly bounds: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ readonly left: number; readonly top: number } | undefined>()
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const r = anchor.getBoundingClientRect()
    const b = bounds?.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const lo = Math.max(8, (b?.left ?? 0) + 8)
    const hi = Math.min(window.innerWidth - 8, (b?.right ?? window.innerWidth) - 8) - w
    const left = Math.max(lo, Math.min(r.left + r.width / 2 - w / 2, hi))
    let top = r.top - h - 8
    if (top < 8) top = r.bottom + 8
    setAt({ left, top })
  }, [anchor, tip, bounds])
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="trace-tooltip"
      className="pointer-events-none fixed z-[65] max-w-[280px] rounded-md border border-line bg-surface px-3 py-2 shadow-panel"
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at === undefined ? "hidden" : "visible" }}
    >
      <div className="text-[13px] font-medium text-ink">{tip.label}</div>
      {tip.lines.map((l, i) => (
        <div key={i} className={cx("font-mono text-[12px]", l.tone === "main" ? "text-ink" : l.tone === "faint" ? "text-ink-faint" : "text-ink-muted")}>{l.text}</div>
      ))}
    </div>
  )
}

// ---- Axis mode control

function AxisMode({ mode, onMode }: { readonly mode: AxisMode; readonly onMode: (m: AxisMode) => void }) {
  const options: ReadonlyArray<readonly [AxisMode, string, string]> = [
    ["reply", "Reply", "The reply at full scale; speaking and playback are shortened"],
    ["entire", "Entire turn", "The whole turn on one linear scale"]
  ]
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return
    e.preventDefault()
    const next: AxisMode = mode === "reply" ? "entire" : "reply"
    // Taken now: React clears `currentTarget` once the handler returns.
    const group = e.currentTarget.parentElement
    onMode(next)
    requestAnimationFrame(() => (group?.querySelector(`[data-mode=${next}]`) as HTMLElement | null)?.focus())
  }
  return (
    <div role="radiogroup" aria-label="Time axis" data-testid="timeline-axis-mode" className="inline-flex rounded-md border border-line bg-surface p-0.5">
      {options.map(([value, label, title]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          tabIndex={mode === value ? 0 : -1}
          data-mode={value}
          title={title}
          onKeyDown={onKey}
          onClick={() => onMode(value)}
          className={cx(
            "h-7 whitespace-nowrap rounded-[5px] px-2.5 text-[12px] transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-voice",
            mode === value ? "bg-voice-soft font-medium text-ink" : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// ---- The header: ticks, flags, captions

const flagWidth = (text: string) => text.length * 6.2 + 8

function Header({ axis, zeroText, audible, end }: {
  readonly axis: Axis
  readonly zeroText: string
  readonly audible: TraceEvent | undefined
  readonly end: { readonly outcome: string; readonly at: number | undefined } | undefined
}) {
  const W = axis.width
  const zx = axis.x(0)
  const zeroW = flagWidth(zeroText)
  const zeroLeft = zx + 2 + zeroW > W
  const zeroBox: readonly [number, number] = zeroLeft ? [zx - zeroW, zx] : [zx, zx + zeroW]
  const place = (x: number, text: string, taken: ReadonlyArray<readonly [number, number]>) => {
    const w = flagWidth(text)
    const right: readonly [number, number] = [x, x + w]
    const hits = (b: readonly [number, number]) => taken.some((o) => b[0] < o[1] && b[1] > o[0])
    const left = x + w > W || hits(right)
    return { left, box: left ? ([x - w, x] as const) : right }
  }
  const audText = audible === undefined ? undefined : `audible ${signed(audible.at)}`
  const capBoxes = axis.captions.map((c) => [c.x0, c.x1] as const)
  const aud = audible === undefined || audText === undefined ? undefined : place(axis.x(audible.at), audText, [zeroBox, ...capBoxes])
  const endText = end?.at === undefined ? undefined : `${end.outcome} ${signed(end.at)}`
  const endFlag = end?.at === undefined || endText === undefined ? undefined : place(axis.x(end.at), endText, [zeroBox, ...capBoxes, ...(aud === undefined ? [] : [aud.box])])
  const flag = (x: number, left: boolean, text: string, tone: string) => (
    <span className={cx("absolute top-0 whitespace-nowrap px-1 font-mono text-[10px] leading-[14px]", left && "text-right", tone)} style={left ? { right: W - x } : { left: x }}>{text}</span>
  )
  return (
    <div className="relative h-10" data-testid="timeline-axis">
      {axis.ticks.map((k) => {
        const nearEdge = k.x < 3 ? "left" : k.x > W - 3 ? "right" : "mid"
        return (
          <span
            key={`${k.t}-${k.edge}`}
            className={cx("absolute top-0 whitespace-nowrap font-mono text-[10px] leading-4", k.t === 0 ? "font-medium text-ink" : "text-ink-faint")}
            style={{ left: k.x, transform: nearEdge === "left" ? undefined : nearEdge === "right" ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {k.label}
          </span>
        )
      })}
      {axis.breaks.map((b) => (
        <span key={b.x0} aria-hidden="true" className="absolute top-1 h-2 w-[10px]" style={{ left: (b.x0 + b.x1) / 2 - 5 }}>
          <span className="absolute left-[1px] top-0 h-2 w-px rotate-[20deg] bg-ink-faint" />
          <span className="absolute left-[5px] top-0 h-2 w-px rotate-[20deg] bg-ink-faint" />
        </span>
      ))}
      <div className="absolute inset-x-0 top-[18px] h-[14px]">
        {axis.captions.map((c) => (
          <span key={c.x0} className="absolute top-0 text-center text-[10px] leading-[14px] text-ink-faint" style={{ left: c.x0, width: c.x1 - c.x0 }}>{c.text}</span>
        ))}
        {flag(zx, zeroLeft, zeroText, "text-ink")}
        {aud !== undefined && audible !== undefined && audText !== undefined && flag(axis.x(audible.at), aud.left, audText, "text-voice")}
        {endFlag !== undefined && end?.at !== undefined && endText !== undefined && flag(axis.x(end.at), endFlag.left, endText, "text-warn")}
      </div>
    </div>
  )
}

// ---- The chart

interface Interaction {
  readonly hover: number | undefined
  readonly rowHover: number | undefined
  readonly pin: number | undefined
  readonly active: number | undefined
  readonly setHover: (i: number | undefined) => void
  readonly setHoverRow: (i: number | undefined) => void
  readonly setPin: (i: number | undefined) => void
  readonly setActive: (i: number) => void
  readonly leave: () => void
  readonly markRefs: React.RefObject<Map<number, HTMLElement>>
}

function Chart({ t, events, rows, mode, ix, bounds, zeroText, plotRef, width }: {
  readonly t: TraceInfo
  readonly events: ReadonlyArray<TraceEvent>
  readonly rows: ReadonlyArray<ListRow>
  readonly mode: AxisMode
  readonly ix: Interaction
  readonly bounds: HTMLElement | null
  readonly zeroText: string
  readonly plotRef: React.RefObject<HTMLDivElement | null>
  readonly width: number
}) {
  const end = endInfo(t, events)
  const axis = useMemo(() => makeAxis(events, width, mode, end?.at), [events, width, mode, end?.at])
  const lanes = useMemo(() => groupLanes(events), [events])
  const pairs = useMemo(() => derivedPairs(events), [events])
  const nav = useMemo(() => navOrder(events), [events])
  const tips = useMemo(() => rows.map((r) => tipOf(r, t, events)), [rows, t, events])
  const packed = useMemo(() => lanes.map((l) => {
    const entries = l.indices.map((i) => events[i]!)
    const p = packLane(entries, axis)
    return { ...p, labels: inlineLabels(entries, p.rowOf, axis) }
  }), [lanes, events, axis])
  const audible = events.find((e) => e.name === "audible")
  const linked = new Set([ix.hover, ix.rowHover, ix.pin].filter((x): x is number => x !== undefined))
  const posOf = useMemo(() => new Map(nav.order.map((i, p) => [i, p])), [nav])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      ix.setPin(undefined)
      ix.setHover(undefined)
      return
    }
    const from = Number((e.target as HTMLElement).closest("[data-index]")?.getAttribute("data-index"))
    if (Number.isNaN(from)) return
    const p = posOf.get(from) ?? 0
    let next: number | undefined
    switch (e.key) {
      case "ArrowLeft": next = nav.order[Math.max(0, p - 1)]; break
      case "ArrowRight": next = nav.order[Math.min(nav.order.length - 1, p + 1)]; break
      case "ArrowUp": next = nearestInLane(nav, events, from, -1); break
      case "ArrowDown": next = nearestInLane(nav, events, from, 1); break
      case "Home": next = nav.order[0]; break
      case "End": next = nav.order[nav.order.length - 1]; break
      case "PageUp": next = nav.order[Math.max(0, p - 10)]; break
      case "PageDown": next = nav.order[Math.min(nav.order.length - 1, p + 10)]; break
      default: return
    }
    e.preventDefault()
    if (next !== undefined) ix.markRefs.current.get(next)?.focus()
  }

  const shortNote = axis.shortened
    ? `Before ${signed(axis.segments[0]!.shortened ? axis.segments[0]!.to : axis.min)} ms and after ${signed(axis.segments[axis.segments.length - 1]!.shortened ? axis.segments[axis.segments.length - 1]!.from : axis.max)} ms the axis is shortened; times in the list are exact.`
    : undefined
  const describedBy = shortNote === undefined ? undefined : "timeline-short-note"
  const legendKinds = new Set(events.map((e) => shapeOf(e)))
  const mini = (label: ReactNode, glyph: ReactNode) => <span className="inline-flex items-center gap-1.5">{glyph}{label}</span>

  return (
    <>
      <div
        role="group"
        aria-label={`Time line graphic: ${nav.order.length} entries in ${lanes.length} lanes. Arrow keys move between entries; the table below lists the same entries.`}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
        data-testid="trace-timeline"
        data-mode={mode}
        onKeyDown={onKeyDown}
      >
        {shortNote !== undefined && <span id="timeline-short-note" className="sr-only">{shortNote}</span>}
        <div className={GRID}>
          <div />
          <div className="pr-4"><div ref={plotRef} className="relative"><Header axis={axis} zeroText={zeroText} audible={audible} end={end} /></div></div>
        </div>
        {width > 0 && lanes.map((lane, li) => {
          const p = packed[li]!
          const height = PAD_V * 2 + ROW_H * p.rows
          const rowByIndex = new Map(lane.indices.map((gi, k) => [gi, p.rowOf[k]!]))
          const first = events[lane.indices[0]!]!.at
          const last = Math.max(...lane.indices.map((gi) => endOf(events[gi]!)))
          return (
            <div key={lane.id} data-lane={lane.id} role="group" aria-label={lane.label} className={cx(GRID, li > 0 && "border-t border-line/40")}>
              <div className="flex items-start pt-[3px] text-[12px] leading-[18px] text-ink-muted" aria-hidden="true">{lane.short}</div>
              <div className="pr-4" onClick={() => ix.setPin(undefined)}>
                <div className="relative" style={{ height }}>
                  {axis.pieces(first, last).map(([a, b], k) => <span key={k} aria-hidden="true" className="absolute h-px bg-line" style={{ left: a, width: Math.max(b - a, 0), top: PAD_V + ROW_H / 2 }} />)}
                  <span aria-hidden="true" data-testid="timeline-zero" className="pointer-events-none absolute inset-y-0 w-px bg-ink" style={{ left: axis.x(0) }} />
                  {audible !== undefined && <span aria-hidden="true" data-testid="timeline-audible" className="pointer-events-none absolute inset-y-0 w-0 border-l border-dashed border-voice" style={{ left: axis.x(audible.at) }} />}
                  {end?.at !== undefined && <span aria-hidden="true" data-testid="timeline-end" className="pointer-events-none absolute inset-y-0 w-px bg-warn" style={{ left: axis.x(end.at) }} />}
                  {ix.rowHover !== undefined && laneOf(events[ix.rowHover]!.name) !== undefined && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-voice/50" style={{ left: axis.x(events[ix.rowHover]!.at) }} />}
                  {pairs.filter((pr) => pr.lane === lane.id).flatMap((pr) =>
                    axis.pieces(events[pr.from]!.at, events[pr.to]!.at).map(([a, b], k) => (
                      <span
                        key={`${pr.from}-${k}`}
                        aria-hidden="true"
                        data-testid="trace-derived"
                        className="pointer-events-none absolute rounded-[2px] border border-ink-faint/60"
                        style={{ left: a, width: Math.max(b - a, 2), height: 14, top: PAD_V + (rowByIndex.get(pr.from) ?? 0) * ROW_H + 2 }}
                      />
                    ))
                  )}
                  {lane.indices.map((gi, k) => {
                    const e = events[gi]!
                    const [l, r] = [axis.x(e.at), axis.x(endOf(e))]
                    const top = PAD_V + p.rowOf[k]! * ROW_H
                    const isSpan = e.ms !== undefined
                    const barW = Math.max(r - l, 4)
                    const hit = isSpan ? Math.max(barW, 16) : 16
                    const left = isSpan ? l + barW / 2 - hit / 2 : l - 8
                    const on = linked.has(gi)
                    const text = p.labels.has(k) ? inlineText(e) : undefined
                    return (
                      <span key={gi}>
                        <button
                          type="button"
                          ref={(el) => {
                            if (el === null) ix.markRefs.current.delete(gi)
                            else ix.markRefs.current.set(gi, el)
                          }}
                          data-testid="trace-mark"
                          data-event={e.name}
                          data-index={gi}
                          data-linked={on ? "true" : undefined}
                          data-pinned={ix.pin === gi ? "true" : undefined}
                          aria-label={tips[gi]!.name}
                          aria-pressed={ix.pin === gi}
                          tabIndex={ix.active === gi ? 0 : -1}
                          onMouseEnter={() => ix.setHover(gi)}
                          onMouseLeave={ix.leave}
                          onFocus={() => { ix.setActive(gi); ix.setHover(gi) }}
                          onBlur={ix.leave}
                          onClick={(ev) => { ev.stopPropagation(); ix.setPin(ix.pin === gi ? undefined : gi) }}
                          className="absolute z-10 grid h-[18px] place-items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-voice"
                          style={{ left, top, width: hit }}
                        >
                          {isSpan ? (
                            <span aria-hidden="true" className={cx("block h-2.5 rounded-[2px] bg-voice", MOTION, on && "scale-125 ring-2 ring-ink ring-offset-1 ring-offset-surface")} style={{ width: barW }} />
                          ) : (
                            <Glyph shape={shapeOf(e)} className={cx(MOTION, on && "scale-125 ring-2 ring-ink ring-offset-1 ring-offset-surface")} />
                          )}
                        </button>
                        {text !== undefined && <span aria-hidden="true" className="pointer-events-none absolute whitespace-nowrap font-mono text-[10px] leading-[18px] text-ink-muted" style={{ left: r + 4, top }}>{text}</span>}
                      </span>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint" data-testid="timeline-legend">
        {legendKinds.has("moment") && mini("moment", <Glyph shape="moment" />)}
        {legendKinds.has("span") && mini("took time", <Glyph shape="span" />)}
        {pairs.length > 0 && mini("between two moments", <span aria-hidden="true" className="block h-3.5 w-4 rounded-[2px] border border-ink-faint/60" />)}
        {mini(zeroText, <span aria-hidden="true" className="block h-3 w-px bg-ink" />)}
        {audible !== undefined && mini("audible", <span aria-hidden="true" className="block h-3 w-0 border-l border-dashed border-voice" />)}
        {axis.shortened && mini("axis shortened here", <span aria-hidden="true" className="font-mono text-ink-faint">//</span>)}
        {end?.at !== undefined && mini("turn ended early", <span aria-hidden="true" className="block h-3 w-px bg-warn" />)}
      </p>
    </>
  )
}

// ---- The table (desktop) and the list (phone)

function EntryTable({ t, rows, ix }: { readonly t: TraceInfo; readonly rows: ReadonlyArray<ListRow>; readonly ix: Interaction }) {
  const notCompleted = t.outcome !== "completed"
  const linked = new Set([ix.hover, ix.rowHover, ix.pin].filter((x): x is number => x !== undefined))
  const events = rows.map((x) => x.event)
  return (
    <table className="w-full border-collapse font-mono text-[11px] tabular-nums" data-testid="trace-events">
      <thead>
        <tr className="text-ink-faint">
          <th scope="col" className="label py-1 pr-2 text-left text-[10px] font-medium">Entry</th>
          <th scope="col" className="label px-2 py-1 text-right text-[10px] font-medium" title="Milliseconds from the end of the turn (0: the final transcript)">At (ms)</th>
          <th scope="col" className="label px-2 py-1 text-right text-[10px] font-medium" title="Milliseconds since the entry before">After previous</th>
          <th scope="col" className="label px-2 py-1 text-right text-[10px] font-medium">Took (ms)</th>
          <th scope="col" className="label py-1 pl-2 text-left text-[10px] font-medium">Detail</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const e = r.event
          const pinned = ix.pin === r.index
          const strong = e.name === "endOfTurn" || e.name === "audible"
          const detail = e.name === "audible" ? audibleDetail(t, events) : r.text.detail
          return (
            <tr
              key={r.index}
              data-event={e.name}
              data-index={r.index}
              data-linked={linked.has(r.index) ? "true" : undefined}
              onMouseEnter={() => ix.rowHover !== r.index && ix.setHoverRow(r.index)}
              onMouseLeave={() => ix.setHoverRow(undefined)}
              onClick={() => ix.setPin(pinned ? undefined : r.index)}
              className={cx("cursor-pointer border-t border-line/50", linked.has(r.index) ? "bg-voice-soft" : "hover:bg-surface-2/60", pinned && "shadow-[inset_2px_0_0_var(--color-voice)]")}
            >
              <td className={cx("py-0.5 pr-2 text-left font-sans text-[12px]", strong ? "font-medium text-ink" : "text-ink-muted")}>
                <span aria-hidden="true" className="inline-flex w-4 justify-center align-middle"><Glyph shape={shapeOf(e, notCompleted)} /></span>
                <span className="ml-1.5">{r.text.label}</span>
              </td>
              <td className="px-2 py-0.5 text-right text-ink">{signed(e.at)}</td>
              <td className="px-2 py-0.5 text-right text-ink-faint">{r.gap === undefined ? "" : signed(r.gap)}</td>
              <td className="px-2 py-0.5 text-right">
                {e.ms !== undefined ? <span className="text-ink-muted">{plain(e.ms)}</span> : r.derivedMs !== undefined ? <span className="text-ink-faint" title={`From “${r.derivedFrom}” to this entry`}>{plain(r.derivedMs)}</span> : ""}
              </td>
              <td className="py-0.5 pl-2 text-left text-ink-muted">{detail ?? ""}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const gapLabel = (ms: number) => fmtDur(ms)

function SpineRow({ r, t, events, completed }: { readonly r: ListRow; readonly t: TraceInfo; readonly events: ReadonlyArray<TraceEvent>; readonly completed: boolean }) {
  const e = r.event
  const lane = laneOf(e.name)
  const gap = r.gap ?? 0
  const extra = r.gap === undefined || gap < 50 ? 0 : gapExtraPx(gap)
  const audible = e.name === "audible"
  const ended = e.name === "turnEnded" && !completed
  const detail = audible ? audibleDetail(t, events) : e.name === "turnEnded" && !completed ? undefined : r.text.detail
  const parts = [
    lane === undefined ? (ended ? `Turn · ${t.outcome}` : "Turn") : laneDef(lane).short,
    e.ms !== undefined ? `took ${plain(e.ms)} ms` : undefined,
    r.derivedMs !== undefined && r.derivedKind !== undefined ? `${PAIR_WORD[r.derivedKind]} took ${plain(r.derivedMs)} ms` : undefined,
    detail
  ].filter((x): x is string => x !== undefined)
  return (
    <li data-event={e.name} data-index={r.index}>
      {r.gap !== undefined && gap >= 50 && (
        <div className="grid grid-cols-[28px_minmax(0,1fr)]" style={{ height: 12 + extra }} aria-hidden="true">
          <span className="mx-auto h-full border-l-2 border-dashed border-line" />
          <span className="self-center pl-1 font-mono text-[10px] text-ink-faint">{gapLabel(gap)}</span>
        </div>
      )}
      <div className={cx("grid grid-cols-[28px_minmax(0,1fr)] py-1", e.name === "endOfTurn" && "border-t border-ink", audible && "bg-voice-soft")}>
        <div className="relative">
          <span aria-hidden="true" className="absolute inset-y-[-4px] left-1/2 w-0.5 -translate-x-1/2 bg-line" />
          <span className="absolute left-1/2 top-[9px] -translate-x-1/2 -translate-y-1/2"><Glyph shape={shapeOf(e, !completed)} vertical /></span>
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2 leading-[18px]">
            <span className={cx("text-[13px]", e.name === "endOfTurn" || audible ? "font-medium text-ink" : "text-ink")}>{r.text.label}</span>
            <span className={cx("whitespace-nowrap font-mono text-[13px] tabular-nums", audible ? cx("font-medium", latencyTone(e.at)) : "text-ink")}>{signed(e.at)}</span>
          </div>
          <div className="text-[11px] leading-snug text-ink-faint">{parts.join(" · ")}</div>
        </div>
      </div>
    </li>
  )
}

function Spine({ t, events }: { readonly t: TraceInfo; readonly events: ReadonlyArray<TraceEvent> }) {
  const items = useMemo(() => phoneRows(events), [events])
  const completed = t.outcome === "completed"
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  return (
    <ol className="m-0 list-none p-0" data-testid="trace-spine">
      {items.map((it: PhoneRow) => {
        if (it.kind === "row") return <SpineRow key={it.row.index} r={it.row} t={t} events={events} completed={completed} />
        const isOpen = open.has(it.id)
        return (
          <li key={it.id} data-run={it.name} className="grid grid-cols-[28px_minmax(0,1fr)] py-1">
            <div className="relative">
              <span aria-hidden="true" className="absolute inset-y-[-4px] left-1/2 w-0.5 -translate-x-1/2 bg-line" />
              <span className="absolute left-1/2 top-[9px] -translate-x-1/2 -translate-y-1/2"><Glyph shape={it.rows[0]!.event.ms !== undefined ? "span" : "moment"} vertical /></span>
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 leading-[18px]">
                <span className="text-[13px] text-ink">{eventText(it.rows[0]!.event).label} × {it.rows.length}</span>
                <span className="whitespace-nowrap font-mono text-[12px] tabular-nums text-ink">{signed(it.from)} to {signed(it.to)}</span>
              </div>
              <div className="text-[11px] text-ink-faint">{it.lane} · took {plain(it.totalMs)} ms in all</div>
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (!n.delete(it.id)) n.add(it.id); return n })} className="min-h-11 text-[13px] text-voice underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-voice">
                {isOpen ? "Hide" : "Show"} {it.rows.length}
              </button>
              {isOpen && <ol className="m-0 -ml-[28px] list-none p-0">{it.rows.map((r) => <SpineRow key={r.index} r={r} t={t} events={events} completed={completed} />)}</ol>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Summary({ t }: { readonly t: TraceInfo }) {
  const sound = firstSoundMs(t)
  const cells: ReadonlyArray<readonly [string, number | undefined, string]> = [
    ["First token", t.marks.llmFirstToken, ""],
    ["First audio", t.marks.ttsFirstAudio, ""],
    ["Audible", sound?.ms, sound === undefined ? "" : latencyTone(sound.ms)]
  ]
  return (
    <div className="grid grid-cols-3 gap-2 md:hidden" data-testid="trace-summary">
      {cells.map(([label, v, tone]) => (
        <div key={label}>
          <div className="label text-[10px] text-ink-faint">{label}</div>
          <div className={cx("font-mono text-[15px] tabular-nums", v === undefined ? "text-ink-faint" : tone === "" ? "text-ink" : tone)}>
            {v === undefined ? <>—<span className="sr-only"> not reached</span></> : signed(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- The Timeline tab

export function TimelineTab({ t, mode, onMode }: { readonly t: TraceInfo; readonly mode: AxisMode; readonly onMode: (m: AxisMode) => void }) {
  const { events, source } = useMemo(() => timelineOf(t), [t])
  const rows = useMemo(() => listRows(events), [events])
  const root = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const markRefs = useRef(new Map<number, HTMLElement>())
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | undefined>()
  const [rowHover, setHoverRow] = useState<number | undefined>()
  const [pin, setPin] = useState<number | undefined>()
  const nav = useMemo(() => navOrder(events), [events])
  const initial = nav.order.find((i) => events[i]!.name === "endOfTurn") ?? nav.order[0]
  const [activeRaw, setActive] = useState<number | undefined>()
  const active = activeRaw !== undefined && nav.order.includes(activeRaw) ? activeRaw : initial
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    const el = plotRef.current
    if (el === null) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [source])
  useEffect(() => { setPin(undefined) }, [mode])

  const ix: Interaction = {
    hover,
    rowHover,
    pin,
    active,
    setHover: (i) => { clearTimeout(timer.current); setHover(i) },
    setHoverRow,
    setPin,
    setActive,
    leave: () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(undefined), 100) },
    markRefs
  }

  if (source === "none") {
    return (
      <div className="flex flex-col gap-2">
        <Summary t={t} />
        <p className="text-[13px] text-ink-muted" data-testid="trace-timeline-none">This turn has no time line recorded.</p>
      </div>
    )
  }
  const note = endNote(t, events)
  const zeroText = t.mode === "text" ? "text sent" : "you stopped talking"
  const tipIndex = hover ?? pin
  const tip = tipIndex === undefined ? undefined : tipOf(rows[tipIndex]!, t, events)
  const anchor = tipIndex === undefined ? undefined : markRefs.current.get(tipIndex)
  const canShorten = makeAxis(events, width || 800, "reply", endInfo(t, events)?.at).shortened
  return (
    <div ref={root} className="flex flex-col gap-2" data-source={source}>
      {(source === "rebuilt" || note !== undefined || canShorten) && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-[12px] text-ink-muted">
            {source === "rebuilt" && <p data-testid="timeline-rebuilt">{rebuiltNote(t)}</p>}
            {note !== undefined && <p data-testid="timeline-end-note">{note}</p>}
          </div>
          {canShorten && <div className="hidden shrink-0 md:block"><AxisMode mode={mode} onMode={onMode} /></div>}
        </div>
      )}
      <Summary t={t} />
      <div className="hidden flex-col gap-2 md:flex">
        <Chart t={t} events={events} rows={rows} mode={canShorten ? mode : "reply"} ix={ix} bounds={root.current} zeroText={zeroText} plotRef={plotRef} width={width} />
        <EntryTable t={t} rows={rows} ix={ix} />
      </div>
      <div className="md:hidden"><Spine t={t} events={events} /></div>
      {tip !== undefined && anchor !== undefined && anchor.isConnected && <Tooltip tip={tip} anchor={anchor} bounds={root.current} />}
    </div>
  )
}
