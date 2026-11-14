"use client"
import type { TraceInfo } from "@pva/protocol"
import { firstSoundMs } from "@/lib/state.ts"
import { cx } from "../ui/controls.tsx"

/** Latency colour: muted below the 800 ms target, warn from 800, danger from 1500. */
export const latencyTone = (ms: number) => (ms >= 1500 ? "text-danger" : ms >= 800 ? "text-warn" : "text-ink-muted")

const fmt = (n: number | undefined) => (n === undefined ? "—" : `${Math.round(n)}`)

export const median = (xs: ReadonlyArray<number>): number | undefined => {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m] : (s[m - 1]! + s[m]!) / 2
}

/**
 * The latency table's columns (seven, so they fit the page column at 1280 px; the device (admin: `session`) and early
 * start go under the turn, the voice under the outcome).
 */
export const TRACE_COLUMNS = ["turn", "1st token", "tts audio", "playback", "audible", "outcome", "tools"] as const

export function TraceRow({ t }: { readonly t: TraceInfo }) {
  const first = firstSoundMs(t)
  return (
    <tr className="border-t border-line/60 align-top text-ink-muted">
      <td className="py-1.5 pl-0 pr-2 text-ink">
        {t.turnId}
        {t.session !== undefined && (
          <span className="block max-w-[10rem] truncate text-[10px] text-ink-faint" title={t.session} data-testid="trace-device">{t.session}</span>
        )}
        {t.speculative && <span className="block text-[10px] text-ink-faint" title="Started before you had quite finished">early</span>}
      </td>
      <td className="px-2 py-1.5">{fmt(t.marks.llmFirstToken)}</td>
      <td className="px-2 py-1.5">{fmt(t.marks.ttsFirstAudio)}</td>
      <td className="px-2 py-1.5">{fmt(t.marks.playbackStart)}</td>
      <td className={cx("px-2 py-1.5", first !== undefined && latencyTone(first.ms))}>{fmt(first?.ms)}</td>
      <td className="px-2 py-1.5">
        <span className={cx(t.outcome !== "completed" && "text-warn")}>{t.outcome}</span>
        {t.voices.length > 0 && <span className="block text-[10px] text-ink-faint">{t.voices.join(", ")}</span>}
      </td>
      <td className="py-1.5 pl-2 pr-0">{t.tools.length === 0 ? "—" : t.tools.map((x) => `${x.name} ${Math.round(x.ms)}`).join(", ")}</td>
    </tr>
  )
}
