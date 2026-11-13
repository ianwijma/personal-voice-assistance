"use client"
import { useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { TraceInfo } from "@pva/protocol"
import { firstSoundMs, lastLatency } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState, usePrefs } from "./context.tsx"
import { PanelHeader, useDialog } from "./ui/Panel.tsx"
import { cx } from "./ui/controls.tsx"

/** Readout colour: muted below the 800 ms target, warn from 800, danger from 1500. */
export const latencyTone = (ms: number) => (ms >= 1500 ? "text-danger" : ms >= 800 ? "text-warn" : "text-ink-muted")

const fmt = (n: number | undefined) => (n === undefined ? "—" : `${Math.round(n)}`)

export const median = (xs: ReadonlyArray<number>): number | undefined => {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m] : (s[m - 1]! + s[m]!) / 2
}

export function LatencyReadout() {
  const enabled = usePrefs((p) => p.latencyReadout)
  const last = useClientState(lastLatency, shallowEqual)
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  return (
    <>
      <button
        type="button"
        data-testid="latency-readout"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Time from the end of your turn to the first sound of the reply"
        className={cx(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-[12px] tabular-nums transition-colors duration-[120ms] hover:bg-surface-2",
          last === undefined ? "text-ink-faint" : latencyTone(last.ms)
        )}
      >
        <span aria-hidden="true">↯</span>
        {last === undefined ? "— ms" : `${Math.round(last.ms)} ms`}
        {last?.label === "first token" && <span className="hidden text-ink-faint sm:inline">first token</span>}
      </button>
      {open && createPortal(<TracesPopover onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function TracesPopover({ onClose }: { readonly onClose: () => void }) {
  const traces = useClientState((s) => s.traces.slice(-10), shallowEqual)
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, true, onClose)
  const audible = traces.map((t) => firstSoundMs(t)?.ms).filter((x): x is number => x !== undefined)
  const med = median(audible)
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="traces-title"
        className="fixed right-2 top-14 z-50 w-[min(640px,calc(100vw-16px))] animate-[pva-rise_200ms_var(--ease-out)] rounded-lg border border-line bg-surface shadow-panel sm:right-6"
      >
        <PanelHeader title="Latency" titleId="traces-title" onClose={onClose}>
          {med !== undefined && <span className={cx("font-mono text-[12px] tabular-nums", latencyTone(med))}>median {Math.round(med)} ms</span>}
        </PanelHeader>
        <div className="max-h-[60dvh] overflow-auto px-2 pb-3 scrollbar-quiet">
          {traces.length === 0 ? (
            <p className="px-3 py-6 text-[14px] text-ink-muted">No turns yet. Each turn's latency trace appears here.</p>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
              <thead>
                <tr className="text-left text-ink-faint">
                  {["turn", "spec", "1st token", "tts audio", "playback", "audible", "tools", "voice", "outcome"].map((h) => (
                    <th key={h} className="label px-2 py-2 font-medium text-[10px] whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...traces].reverse().map((t) => <TraceRow key={t.turnId} t={t} />)}
              </tbody>
            </table>
          )}
          <p className="px-3 pt-2 text-[12px] text-ink-faint">
            Milliseconds from the moment the assistant decided you had finished. Not included: microphone capture and the silence the recogniser waits for.
          </p>
        </div>
      </div>
    </>
  )
}

export function TraceRow({ t }: { readonly t: TraceInfo }) {
  const first = firstSoundMs(t)
  return (
    <tr className="border-t border-line/60 text-ink-muted">
      <td className="px-2 py-1.5 text-ink">{t.turnId}</td>
      <td className="px-2 py-1.5">{t.speculative ? "yes" : "no"}</td>
      <td className="px-2 py-1.5">{fmt(t.marks.llmFirstToken)}</td>
      <td className="px-2 py-1.5">{fmt(t.marks.ttsFirstAudio)}</td>
      <td className="px-2 py-1.5">{fmt(t.marks.playbackStart)}</td>
      <td className={cx("px-2 py-1.5", first !== undefined && latencyTone(first.ms))}>{fmt(first?.ms)}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">{t.tools.length === 0 ? "—" : t.tools.map((x) => `${x.name} ${Math.round(x.ms)}`).join(", ")}</td>
      <td className="px-2 py-1.5">{t.voices.join(", ") || "—"}</td>
      <td className={cx("px-2 py-1.5", t.outcome !== "completed" && "text-warn")}>{t.outcome}</td>
    </tr>
  )
}
