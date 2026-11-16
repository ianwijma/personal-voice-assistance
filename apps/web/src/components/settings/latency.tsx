"use client"
import { useLayoutEffect, useRef, useState } from "react"
import type { AssistantInfo, DeviceListInfo, ModuleInfo, TraceInfo } from "@pva/protocol"
import { ACCOUNTS, plural, prettyVoice, toolCount } from "@/lib/assistants.ts"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { firstSoundMs } from "@/lib/state.ts"
import { parseKey } from "@/lib/voicePicker.ts"
import { Icon } from "../ui/Icon.tsx"
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
 * The latency table's columns (docs/ASSISTANTS.md §7.1: seven grew to ten). The early start goes under the turn, the
 * voice under the outcome, TypeSafe's outcome under its time.
 */
export const TRACE_COLUMNS = ["turn", "assistant", "device", "routing", "1st token", "tts audio", "playback", "audible", "outcome", "tools"] as const

// ---- How the assistant was chosen

export const ROUTE_FILTERS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "all", label: "All routes" },
  { value: "phrase", label: "Wake phrase" },
  { value: "armed", label: "Phrase alone, then speech" },
  { value: "follow-up", label: "Follow-up" },
  { value: "default", label: "Without a phrase" },
  { value: "typed", label: "Typed" },
  { value: "typesafe", label: "TypeSafe" }
]

const OUTCOME_WORDS = { chosen: "chosen", "none-fits": "none fits", timeout: "timed out", error: "error" } as const

const percent = (p: number) => `${Math.round(p * 100)}%`

/** "Chosen by" in the popover: the phrase, the follow-up window, or TypeSafe with its time and where it sent the turn. */
export const chosenBy = (t: TraceInfo): string => {
  const r = t.route
  if (r === undefined) return "Not recorded"
  switch (r.by) {
    case "phrase":
      return `“${r.phrase}”`
    case "armed":
      return `“${r.phrase}”, then what was said next`
    case "follow-up":
      return "Follow-up"
    case "default":
      return "Answers without a phrase"
    case "typed":
      return "Typed text"
    case "typesafe": {
      const ms = `${Math.round(r.ms)} ms`
      const odds = r.probability !== undefined ? percent(r.probability) : r.fits !== undefined ? `fits ${percent(r.fits)}` : undefined
      const to = r.fallback ? ` → ${t.assistant?.name ?? "the fallback"}` : ""
      if (r.outcome === "chosen") return ["TypeSafe", odds, ms].filter((x) => x !== undefined).join(" · ")
      if (r.outcome === "none-fits") return ["TypeSafe", `none fits${odds === undefined ? "" : ` (${odds})`}`, ms].join(" · ") + to
      return ["TypeSafe", r.outcome === "timeout" ? "no answer in time" : "did not answer", ms].join(" · ") + to
    }
  }
}

// ---- What the assistant was set to at that turn, and what it is now

/** What the facts and "changed since" are worked out from: the assistants, devices and modules as they are now. */
export interface LatencyContext {
  readonly assistants: ReadonlyArray<AssistantInfo>
  readonly devices: ReadonlyArray<Pick<DeviceListInfo, "id" | "name" | "hearer">>
  readonly modules: ReadonlyArray<ModuleInfo>
  /** A hearing preset's label (the speech section's), else the preset. */
  readonly hearingName: (preset: string) => string
  /** The voice catalog's name for a voice, when it has loaded. */
  readonly voiceName: (voice: { readonly provider: string; readonly voiceId: string }) => string | undefined
}

const LANGUAGES: Readonly<Record<string, string>> = { auto: "Automatic", en: "English", nl: "Dutch", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese" }
const accountTitle = (id: string) => ACCOUNTS.find((a) => a.id === id)?.title ?? id

const voiceOf = (key: string, ctx: LatencyContext) => {
  const ref = parseKey(key)
  return ref === undefined ? { name: key, where: "" } : { name: ctx.voiceName(ref) ?? prettyVoice(ref.voiceId), where: ref.provider === "sherpa" ? "on this machine" : ref.provider }
}
/** A voice's own name for the table ("lessac"): the catalog's name, else the id's words. */
export const voiceLabel = (key: string, ctx: LatencyContext): string => voiceOf(key, ctx).name.toLowerCase()
const hearerNow = (t: TraceInfo, ctx: LatencyContext): AssistantInfo | undefined => {
  const device = t.deviceId === undefined ? undefined : ctx.devices.find((d) => d.id === t.deviceId)
  const id = device?.hearer ?? t.config?.hearing.hearer
  return ctx.assistants.find((a) => a.id === id)
}

/** The facts of a turn's configuration, as the popover and the open row show them. */
export const factsOf = (t: TraceInfo, ctx: LatencyContext): ReadonlyArray<readonly [string, string]> => {
  const c = t.config
  const chosen: readonly [string, string] = ["Chosen by", chosenBy(t)]
  if (c === undefined) return [["Configuration", "not recorded"], chosen]
  const hearer = ctx.assistants.find((a) => a.id === c.hearing.hearer)
  const own = t.assistant?.id === c.hearing.hearer
  const engine = c.hearing.engine === "deepgram" ? "Deepgram" : ctx.hearingName(c.hearing.model ?? "")
  const language = c.hearing.language === undefined ? undefined : LANGUAGES[c.hearing.language] ?? c.hearing.language
  const voice = voiceOf(c.voice, ctx)
  const model = c.llm.account === "offline" ? "offline stand-in" : c.llm.model
  return [
    ["Language model", `${accountTitle(c.llm.account)} · ${model} · effort ${c.llm.effort}`],
    [
      "Hearing",
      [engine, language, c.hearing.finalSilenceMs !== undefined ? `end pause ${c.hearing.finalSilenceMs} ms` : undefined].filter((x) => x !== undefined).join(" · ") +
        (own ? "" : ` (${t.device ?? "this device"} hears with ${hearer?.name ?? c.hearing.hearer}'s)`)
    ],
    ["Voice", `${voice.name}${voice.where === "" ? "" : ` · ${voice.where}`}`],
    ["Modules", `${plural(c.modules, "module")} · ${plural(c.tools, "tool")}`],
    chosen
  ]
}

/**
 * What differs between the snapshot of a turn and the assistant as it is now ("voice Lessac → Heart"). Empty when
 * nothing differs, or there is no snapshot or the assistant is gone. Modules and tools are compared by count; hearing
 * through the assistant that hears on that device now.
 */
export const changedSince = (t: TraceInfo, ctx: LatencyContext): ReadonlyArray<string> => {
  const c = t.config
  const a = ctx.assistants.find((x) => x.id === t.assistant?.id)
  if (c === undefined || a === undefined) return []
  const out: Array<string> = []
  const diff = (label: string, was: string | number | boolean | undefined, now: string | number | boolean | undefined) => {
    if (was !== undefined && was !== now) out.push(`${label} ${String(was)} → ${String(now)}`)
  }
  if (c.llm.account !== a.llm.account) out.push(`account ${accountTitle(c.llm.account)} → ${accountTitle(a.llm.account)}`)
  diff("model", c.llm.model, a.llm.model)
  diff("effort", c.llm.effort, a.llm.effort)
  diff("thinking", c.llm.thinking, a.llm.thinking)
  diff("longest reply", c.llm.maxTokens, a.llm.maxTokens)
  const hearer = hearerNow(t, ctx)
  if (hearer !== undefined) {
    if (hearer.id !== c.hearing.hearer) {
      const was = ctx.assistants.find((x) => x.id === c.hearing.hearer)?.name ?? c.hearing.hearer
      out.push(`hearing ${was}'s → ${hearer.name}'s`)
    } else {
      const h = hearer.hearing
      diff("hearing engine", c.hearing.engine, h.engine)
      if (c.hearing.model !== undefined && h.engine === "sherpa") diff("hearing model", ctx.hearingName(c.hearing.model), ctx.hearingName(h.model))
      diff("hearing language", c.hearing.language, h.language)
      diff("early pause", c.hearing.eagerSilenceMs, h.eagerSilenceMs)
      diff("end pause", c.hearing.finalSilenceMs, h.finalSilenceMs)
      if (h.engine === "deepgram") diff("end-of-turn threshold", c.hearing.eotThreshold, h.deepgram.eotThreshold)
    }
  }
  const was = voiceOf(c.voice, ctx)
  const nowKey = `${a.voice.provider}:${a.voice.voiceId}`
  if (c.voice !== nowKey) out.push(`voice ${was.name} → ${voiceOf(nowKey, ctx).name}`)
  diff("modules", c.modules, Object.values(a.modules).filter((m) => m.on).length)
  // A Claude subscription assistant not let to use its modules has no tools, whatever its modules (as the server records it).
  diff("tools", c.tools, a.llm.account === "claude-subscription" && !a.llm.useModules ? 0 : toolCount(a, ctx.modules))
  if (c.replyEarly !== a.replyEarly) out.push(`reply early ${c.replyEarly ? "on" : "off"} → ${a.replyEarly ? "on" : "off"}`)
  diff("tool rounds", c.toolRounds, a.toolRounds)
  return out
}

const changedText = (parts: ReadonlyArray<string>) => parts.join("; ")

/**
 * The turns' own keys, oldest first: device, assistant and turn number (turn numbers count per device), and how many
 * earlier traces had those (a device's numbers can start over). Not the list position: a new trace must not change the
 * keys of the rows already shown (their open state and popover are kept by key).
 */
export const traceKeys = (traces: ReadonlyArray<TraceInfo>): ReadonlyArray<string> => {
  const seen = new Map<string, number>()
  return traces.map((t) => {
    const base = `${t.deviceId ?? t.session ?? ""}:${t.assistant?.id ?? ""}:${t.turnId}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}:${n}`
  })
}

// ---- Rows

export interface TraceView {
  readonly key: string
  readonly t: TraceInfo
  /** The names of the voices that spoke ("lessac"), under the outcome. */
  readonly voices: ReadonlyArray<string>
  readonly facts: ReadonlyArray<readonly [string, string]>
  readonly changed: ReadonlyArray<string>
}

/** The Routing cell: TypeSafe's time, its outcome under it. Empty for every other route (nothing was asked). */
function RoutingCell({ t }: { readonly t: TraceInfo }) {
  if (t.route?.by !== "typesafe") return <td className="px-2 py-1.5" data-testid="trace-routing" />
  const r = t.route
  return (
    <td className="px-2 py-1.5" data-testid="trace-routing">
      {fmt(r.ms)}
      <span className={cx("block whitespace-nowrap text-[10px]", r.outcome === "chosen" ? "text-ink-faint" : "text-warn")}>{OUTCOME_WORDS[r.outcome]}</span>
    </td>
  )
}

export function TraceRow({ view, open, onToggle, onPop }: {
  readonly view: TraceView
  readonly open: boolean
  readonly onToggle: () => void
  /** The assistant's name was hovered or focused (an element) or left (undefined). */
  readonly onPop: (target: HTMLElement | undefined) => void
}) {
  const { t, key } = view
  const first = firstSoundMs(t)
  const detail = `trace-detail-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`
  return (
    <>
      <tr
        className={cx("cursor-pointer border-t border-line/60 align-top text-ink-muted hover:bg-surface-2/40", open && "bg-surface-2/40")}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-pop]")) onToggle()
        }}
        data-testid="trace-row"
        data-turn={t.turnId}
        data-open={open ? "true" : undefined}
      >
        <td className="py-1.5 pl-0 pr-2 text-ink">
          <button type="button" aria-expanded={open} aria-controls={detail} onClick={(e) => { e.stopPropagation(); onToggle() }} className="inline-flex min-h-6 items-center gap-1 text-ink" data-testid="trace-toggle">
            <Icon name="chevron" size={12} className={cx("text-ink-faint transition-transform duration-[120ms]", open && "rotate-90")} />
            {t.turnId}
          </button>
          {t.speculative && <span className="block text-[10px] text-ink-faint" title="Started before you had quite finished">early</span>}
        </td>
        <td className="px-2 py-1.5 text-ink">
          {t.assistant === undefined ? (
            <span className="text-ink-faint" data-testid="trace-assistant">—</span>
          ) : (
            <button
              type="button"
              data-pop=""
              data-testid="trace-assistant"
              aria-describedby="trace-pop"
              onMouseEnter={(e) => onPop(e.currentTarget)}
              onMouseLeave={(e) => { if (document.activeElement !== e.currentTarget) onPop(undefined) }}
              onFocus={(e) => onPop(e.currentTarget)}
              onBlur={() => onPop(undefined)}
              className="cursor-help underline decoration-ink-faint/80 decoration-dotted underline-offset-4"
            >
              {t.assistant.name}
            </button>
          )}
        </td>
        <td className="px-2 py-1.5">
          <span className="block max-w-[10rem] truncate" title={t.device ?? t.session} data-testid="trace-device">{t.device ?? t.session ?? ""}</span>
        </td>
        <RoutingCell t={t} />
        <td className="px-2 py-1.5">{fmt(t.marks.llmFirstToken)}</td>
        <td className="px-2 py-1.5">{fmt(t.marks.ttsFirstAudio)}</td>
        <td className="px-2 py-1.5">{fmt(t.marks.playbackStart)}</td>
        <td className={cx("px-2 py-1.5", first !== undefined && latencyTone(first.ms))} data-testid="trace-audible">{fmt(first?.ms)}</td>
        <td className="px-2 py-1.5">
          <span className={cx(t.outcome !== "completed" && "text-warn")}>{t.outcome}</span>
          {view.voices.length > 0 && <span className="block text-[10px] text-ink-faint">{view.voices.join(", ")}</span>}
        </td>
        <td className="py-1.5 pl-2 pr-0">{t.tools.length === 0 ? <span className="text-ink-faint">none</span> : t.tools.map((x) => `${x.name} ${Math.round(x.ms)}`).join(", ")}</td>
      </tr>
      {open && (
        <tr className="bg-surface-2/40" data-testid="trace-detail-row">
          <td colSpan={TRACE_COLUMNS.length} id={detail} className="pb-4 pt-1 font-sans">
            <div className="sticky left-0 flex w-[min(100%,calc(100vw-40px))] max-w-[640px] flex-col gap-2.5 text-[13px]">
              <Facts facts={view.facts} columns="120px" />
              {view.changed.length > 0 && <p className="text-warn" data-testid="changed-since">Changed since this turn: {changedText(view.changed)}</p>}
              {t.assistant !== undefined && (
                <div><a className="text-voice underline-offset-4 hover:underline" href={formatSettingsHash(["assistants", t.assistant.id])}>Open {t.assistant.name}</a></div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Facts({ facts, columns }: { readonly facts: ReadonlyArray<readonly [string, string]>; readonly columns: string }) {
  return (
    <dl className="m-0 grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: `${columns} 1fr` }} data-testid="trace-facts">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="label pt-0.5 text-[10px] text-ink-faint">{k}</dt>
          <dd className="m-0 break-words font-mono text-[12px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** What the assistant was set to at that turn, next to its name: a tooltip that is also shown on focus. */
export function TracePopover({ view, anchor }: { readonly view: TraceView; readonly anchor: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ readonly left: number; readonly top: number } | undefined>()
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12)
    let top = r.bottom + 8
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8)
    setAt({ left, top })
  }, [anchor, view.key])
  const t = view.t
  return (
    <div
      ref={ref}
      id="trace-pop"
      role="tooltip"
      data-testid="trace-popover"
      className="pointer-events-none fixed z-[65] w-[320px] max-w-[calc(100vw-24px)] rounded-lg border border-line bg-surface px-3.5 py-3 shadow-panel"
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at === undefined ? "hidden" : "visible" }}
    >
      <h4 className="mb-2 text-[13px] font-medium text-ink">{t.assistant?.name ?? "Assistant"} at turn {t.turnId}{t.device !== undefined ? ` · ${t.device}` : ""}</h4>
      <Facts facts={view.facts} columns="96px" />
      {view.changed.length > 0 && <p className="mt-2 text-[13px] text-warn" data-testid="popover-changed">Changed since: {changedText(view.changed)}</p>}
    </div>
  )
}
