"use client"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { firstSoundMs, modulesInOrder } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { latencyTone, median, TRACE_COLUMNS, TraceRow } from "../latency.tsx"
import { cx } from "../../ui/controls.tsx"

/** Diagnostics › Latency: the last turns' traces with median and worst (the data of the ↯ readout). */
export function LatencyPage() {
  const traces = useClientState((s) => s.traces.slice(-20), shallowEqual)
  const audible = traces.map((t) => firstSoundMs(t)?.ms).filter((x): x is number => x !== undefined)
  const med = median(audible)
  const worst = audible.length === 0 ? undefined : Math.max(...audible)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-6 font-mono text-[13px] tabular-nums">
        <span>median <span className={cx(med !== undefined && latencyTone(med))}>{med === undefined ? "—" : `${Math.round(med)} ms`}</span></span>
        <span>worst <span className={cx(worst !== undefined && latencyTone(worst))}>{worst === undefined ? "—" : `${Math.round(worst)} ms`}</span></span>
      </div>
      {traces.length === 0 ? (
        <p className="text-[14px] text-ink-muted">No turns yet. Each turn's latency trace appears here.</p>
      ) : (
        <ScrollX label="Latency of the last turns">
          <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
            <thead>
              <tr className="text-left text-ink-faint">
                {TRACE_COLUMNS.map((h) => (
                  <th key={h} className="label whitespace-nowrap px-2 py-2 text-[10px] font-medium first:pl-0 last:pr-0">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{[...traces].reverse().map((t, i) => <TraceRow key={`${traces.length - i}-${t.session ?? ""}-${t.turnId}`} t={t} />)}</tbody>
          </table>
        </ScrollX>
      )}
      <p className="text-[12px] text-ink-faint">
        Milliseconds from the moment the assistant decided you had finished, from each turn's latency trace. Under a turn: the device it
        was on, and "early" when the reply was started before you had quite finished. The voice is under the outcome. Not included: microphone capture and the silence the recogniser waits for.
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
          <button type="button" className="text-voice underline-offset-4 hover:underline" onClick={() => client.settings([m.kind === "agent" || m.kind === "decider" ? "language-model" : "modules", m.id])}>
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
