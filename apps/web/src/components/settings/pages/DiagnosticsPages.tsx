"use client"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { TraceInfo } from "@pva/protocol"
import { hearingModelNames } from "@/lib/assistants.ts"
import { firstSoundMs, modulesInOrder } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { inputClass } from "../../fields/types.ts"
import { useClient, useClientState } from "../../context.tsx"
import { changedSince, factsOf, type LatencyContext, latencyTone, median, ROUTE_FILTERS, TRACE_COLUMNS, TraceRow, TracePopover, type TraceView, voiceLabel } from "../latency.tsx"
import { cx, Segmented } from "../../ui/controls.tsx"
import { SELECT_CHEVRON } from "./assistants/parts.tsx"
import { useVoiceNameOf } from "./AssistantsPage.tsx"

/** The turn's own key: its device and number (turn numbers count per device). */
const traceKey = (t: TraceInfo, index: number) => `${t.deviceId ?? t.session ?? ""}:${t.turnId}:${index}`

const selectClass = `${inputClass} min-w-[11rem] max-w-full appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9`

function FilterSelect({ label, value, options, onChange, testId }: {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  readonly onChange: (v: string) => void
  readonly testId: string
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass} style={{ backgroundImage: SELECT_CHEVRON, width: "auto" }} data-testid={testId}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

/**
 * Diagnostics › Latency (docs/ASSISTANTS.md §7.1): the turns' traces with who answered, on which device and how it was
 * chosen; filters by assistant, device and route; the median per assistant (the audible time), so a slow assistant
 * stands out from a slow device; what the assistant was set to at that turn (hover or focus its name, or open the row)
 * and what has changed since.
 */
export function LatencyPage() {
  const traces = useClientState((s) => s.traces, shallowEqual)
  const assistants = useClientState((s) => s.assistants)
  const devices = useClientState((s) => s.devices)
  const moduleState = useClientState((s) => s.modules)
  const sections = useClientState((s) => s.sections)
  const voiceName = useVoiceNameOf()
  const [assistantFilter, setAssistant] = useState("all")
  const [deviceFilter, setDevice] = useState("all")
  const [routeFilter, setRoute] = useState("all")
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [pop, setPop] = useState<{ readonly key: string; readonly anchor: HTMLElement } | undefined>()

  const ctx: LatencyContext = {
    assistants,
    devices,
    modules: Object.values(moduleState.byId),
    hearingName: hearingModelNames(sections).hearing,
    voiceName
  }
  const all: ReadonlyArray<TraceView> = [...traces].reverse().map((t, i) => ({ key: traceKey(t, i), t, voices: t.voices.map((v) => voiceLabel(v, ctx)), facts: factsOf(t, ctx), changed: changedSince(t, ctx) }))

  // The filters offer who is in the turns (an assistant or device since removed still shows in them).
  const assistantOptions = [...new Map(all.flatMap(({ t }) => (t.assistant === undefined ? [] : [[t.assistant.id, t.assistant.name] as const]))).entries()]
  const listed = new Map(assistants.map((a, i) => [a.id, i]))
  assistantOptions.sort(([a], [b]) => (listed.get(a) ?? 999) - (listed.get(b) ?? 999))
  const deviceOptions = [...new Map(all.flatMap(({ t }) => {
    const id = t.deviceId ?? t.device ?? t.session
    return id === undefined ? [] : [[id, t.device ?? t.session ?? id] as const]
  })).entries()]
  const effectiveAssistant = assistantFilter === "all" || assistantOptions.some(([id]) => id === assistantFilter) ? assistantFilter : "all"
  const effectiveDevice = deviceFilter === "all" || deviceOptions.some(([id]) => id === deviceFilter) ? deviceFilter : "all"
  const rows = all.filter(({ t }) =>
    (effectiveAssistant === "all" || t.assistant?.id === effectiveAssistant) &&
    (effectiveDevice === "all" || (t.deviceId ?? t.device ?? t.session) === effectiveDevice) &&
    (routeFilter === "all" || t.route?.by === routeFilter)
  )

  const audible = (t: TraceInfo) => firstSoundMs(t)?.ms
  const timed = (list: ReadonlyArray<TraceView>) => list.map(({ t }) => audible(t)).filter((x): x is number => x !== undefined)
  const perAssistant = assistantOptions
    .map(([id, name]) => ({ id, name, med: median(timed(rows.filter(({ t }) => t.assistant?.id === id))) }))
    .filter((x) => x.med !== undefined)
  const everyone = timed(rows)
  const toggle = (key: string) => setOpen((s) => {
    const next = new Set(s)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const popped = pop === undefined ? undefined : rows.find((v) => v.key === pop.key)
  const Ms = ({ ms }: { readonly ms: number | undefined }) => <span className={cx(ms !== undefined && latencyTone(ms))}>{ms === undefined ? "—" : `${Math.round(ms)} ms`}</span>

  return (
    <div className="flex flex-col gap-4">
      {traces.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="latency-filters">
          <div className="max-w-full overflow-x-auto [&_button]:whitespace-nowrap">
            <Segmented
              value={effectiveAssistant}
              onChange={setAssistant}
              label="Assistant"
              name="latency-assistant"
              testId="filter-assistant"
              options={[{ value: "all", label: "All assistants" }, ...assistantOptions.map(([id, name]) => ({ value: id, label: name }))]}
            />
          </div>
          <FilterSelect label="Device" value={effectiveDevice} onChange={setDevice} testId="filter-device" options={[{ value: "all", label: "All devices" }, ...deviceOptions.map(([id, name]) => ({ value: id, label: name }))]} />
          <FilterSelect label="Route" value={routeFilter} onChange={setRoute} testId="filter-route" options={ROUTE_FILTERS} />
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[13px] tabular-nums" data-testid="latency-summary">
        {effectiveAssistant === "all" && perAssistant.length > 0 ? (
          perAssistant.map((a, i) => (
            <span key={a.id} data-testid="median-assistant">
              {i > 0 && <span className="mr-6 text-ink-faint" aria-hidden="true">·</span>}
              {a.name} median <Ms ms={a.med} />
            </span>
          ))
        ) : everyone.length > 0 ? (
          <>
            <span data-testid="median">median <Ms ms={median(everyone)} /></span>
            <span data-testid="worst">worst <Ms ms={Math.max(...everyone)} /></span>
          </>
        ) : (
          <span className="text-ink-faint">{traces.length > 0 ? "No turns match." : ""}</span>
        )}
      </div>
      {traces.length === 0 ? (
        <p className="text-[14px] text-ink-muted">No turns yet. Each turn's latency trace appears here.</p>
      ) : rows.length === 0 ? (
        <p className="text-[14px] text-ink-faint" data-testid="no-match">No turns match these filters.</p>
      ) : (
        <div>
          <p className="mb-1 text-[12px] text-ink-faint sm:hidden">Scroll sideways for all timings.</p>
          <ScrollX label="Latency of the last turns">
            <table className="w-full min-w-[740px] border-collapse font-mono text-[12px] tabular-nums sm:min-w-0">
              <thead>
                <tr className="text-left text-ink-faint">
                  {TRACE_COLUMNS.map((h) => (
                    <th key={h} className="label whitespace-nowrap px-2 py-2 text-[10px] font-medium first:pl-0 last:pr-0" title={h === "routing" ? "Time TypeSafe took to choose the assistant" : undefined}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <TraceRow key={v.key} view={v} open={open.has(v.key)} onToggle={() => toggle(v.key)} onPop={(anchor) => setPop(anchor === undefined ? undefined : { key: v.key, anchor })} />
                ))}
              </tbody>
            </table>
          </ScrollX>
        </div>
      )}
      {popped !== undefined && pop !== undefined && <TracePopover view={popped} anchor={pop.anchor} />}
      <p className="text-[12px] text-ink-faint">
        Milliseconds from the moment the assistant decided you had finished, from each turn's latency trace. "Early" under a turn: the reply was
        started before you had quite finished. Routing: the time TypeSafe took to choose the assistant, on devices that let it decide; it comes
        before the other timings. The voice is under the outcome. Hover or focus an assistant for what it was set to at that turn; click a row for
        more. Not included: microphone capture and the silence the recogniser waits for.
      </p>
    </div>
  )
}

/** Diagnostics › Problems: engine problems and modules in error, each with the page that fixes it. */
export function ProblemsPage() {
  const client = useClient()
  const problems = useClientState((s) => s.engine.problems, shallowEqual)
  const modules = useClientState((s) => modulesInOrder(s).filter((m) => m.state === "error"), shallowEqual)
  if (problems.length === 0 && modules.length === 0) return <p className="text-[14px] text-ink-muted" data-testid="no-problems">No problems.</p>
  return (
    <ul className="flex flex-col gap-3">
      {problems.map((p, i) => (
        <li key={`e${i}`} className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-[13px]">
          <span className="font-mono text-ink">{p.stage}</span>: <span className="text-ink-muted">{p.message}</span>
        </li>
      ))}
      {modules.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-[13px]">
          <span className="text-ink">{m.name}:</span>
          <span className="min-w-0 flex-1 text-ink-muted">{m.error ?? "Could not start"}</span>
          <button type="button" className="text-voice underline-offset-4 hover:underline" onClick={() => client.settings(["shared", m.kind === "agent" ? "accounts" : m.kind === "decider" ? "routing" : "modules"])}>
            Open
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * A table that may be wider than the page (narrow screens): it scrolls sideways, can be scrolled with the keyboard
 * (focusable, labelled), and fades at the edge that has more.
 */
function ScrollX({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState<{ readonly left: boolean; readonly right: boolean }>({ left: false, right: false })
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const update = () => setMore({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener("scroll", update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", update)
    }
  }, [])
  const scrolls = more.left || more.right
  const mask = more.left && more.right
    ? "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)"
    : more.right ? "linear-gradient(to right, black calc(100% - 32px), transparent)" : more.left ? "linear-gradient(to right, transparent, black 24px)" : undefined
  return (
    <div
      ref={ref}
      role="region"
      aria-label={scrolls ? `${label} (scrolls sideways)` : label}
      tabIndex={scrolls ? 0 : undefined}
      data-testid="latency-table"
      data-scrolls={scrolls ? "true" : "false"}
      style={mask === undefined ? undefined : { maskImage: mask, WebkitMaskImage: mask }}
      className="overflow-x-auto rounded-sm scrollbar-quiet"
    >
      {children}
    </div>
  )
}
