"use client"
import { type KeyboardEvent } from "react"
import type { TraceInfo } from "@pva/protocol"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { type AxisMode, modulesAndTools, plain, type ToolChip } from "@/lib/traceTimeline.ts"
import { cx } from "../ui/controls.tsx"
import { TimelineTab } from "./TraceTimeline.tsx"

export type TraceTab = "timeline" | "information"
const TABS: ReadonlyArray<readonly [TraceTab, string]> = [["timeline", "Timeline"], ["information", "Information"]]

const chip = "inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[11px] leading-[18px]"

function Chip({ c }: { readonly c: ToolChip }) {
  return (
    <li data-called={c.called ? "true" : undefined} className={cx(chip, c.called ? "border-voice bg-voice-soft font-medium text-ink" : "border-dashed border-line text-ink-muted")}>
      {c.called && <span aria-hidden="true">✓</span>}
      {c.name}
      {c.called && <span aria-hidden="true">{c.calls > 1 ? ` · ${c.calls}× · ${plain(c.ms)} ms` : ` · ${plain(c.ms)} ms`}</span>}
      {c.called && <span className="sr-only"> (called in this turn, {plain(c.ms)} ms)</span>}
    </li>
  )
}

const Heading = ({ children }: { readonly children: string }) => <h4 className="label mb-1.5 text-[10px] font-medium text-ink-faint">{children}</h4>

function ModulesTools({ t }: { readonly t: TraceInfo }) {
  const m = modulesAndTools(t)
  const calledLine = m.called.length > 0 && (
    <div className="flex flex-wrap items-center gap-1 text-[12px] text-ink-muted">
      <span>Called in this turn:</span>
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">{m.called.map((c) => <Chip key={c.name} c={c} />)}</ul>
    </div>
  )
  return (
    <section aria-label="Modules and tools">
      <Heading>MODULES AND TOOLS</Heading>
      <div className="flex flex-col gap-2.5 text-[12px]" data-testid="trace-modules-tools" {...(m.recorded ? {} : { "data-recorded": "false" })}>
        {m.message !== undefined && <p className="text-ink-muted">{m.message}</p>}
        {m.none && <p className="text-ink-muted">No modules were on for this turn.</p>}
        {m.modules.map((mod) => {
          const n = mod.tools?.filter((x) => x.called).length ?? 0
          return (
            <div key={mod.id} data-module={mod.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink">{mod.name}</span>
                <span className="text-[11px] text-ink-faint">
                  {mod.tools === undefined ? "tools not recorded" : mod.tools.length === 0 ? "no tools" : n === 0 ? "none called" : `${n} of ${mod.tools.length} called`}
                </span>
              </div>
              {mod.tools !== undefined && mod.tools.length > 0 && <ul className="m-0 mt-1 flex list-none flex-wrap gap-1 p-0">{mod.tools.map((c) => <Chip key={c.name} c={c} />)}</ul>}
            </div>
          )
        })}
        {m.recorded && m.other.length > 0 && (
          <div data-module="other">
            <div className="text-ink">Other tools</div>
            <ul className="m-0 mt-1 flex list-none flex-wrap gap-1 p-0">{m.other.map((c) => <Chip key={c.name} c={c} />)}</ul>
          </div>
        )}
        {!m.recorded && calledLine}
        {m.recorded && (m.modules.length > 0 || m.other.length > 0) && (
          <p className="text-[11px] text-ink-faint"><span aria-hidden="true">✓</span> called in this turn · dashed: available, not called</p>
        )}
      </div>
    </section>
  )
}

function InformationTab({ t, facts, changed }: { readonly t: TraceInfo; readonly facts: ReadonlyArray<readonly [string, string]>; readonly changed: ReadonlyArray<string> }) {
  const link = t.assistant !== undefined && (
    <a className="shrink-0 text-voice underline-offset-4 hover:underline" href={formatSettingsHash(["assistants", t.assistant.id])}>Open {t.assistant.name}</a>
  )
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      {(changed.length > 0 || t.assistant !== undefined) && (
        <div className={cx("flex items-start gap-4", changed.length > 0 ? "justify-between" : "justify-end")}>
          {changed.length > 0 && <p className="border-l-2 border-warn pl-2 text-warn" data-testid="changed-since">Changed since this turn: {changed.join("; ")}</p>}
          <span className="hidden md:block">{link}</span>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2 md:gap-8">
        <section aria-label="Configuration">
          <Heading>{`CONFIGURATION AT TURN ${t.turnId}`}</Heading>
          <dl className="m-0 flex flex-col gap-3 md:grid md:grid-cols-[128px_minmax(0,1fr)] md:gap-x-4 md:gap-y-1" data-testid="trace-facts">
            {facts.filter(([k]) => k !== "Modules").map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="label text-[10px] text-ink-faint md:pt-0.5">{k}</dt>
                <dd className="m-0 break-words font-mono text-[13px] text-ink md:text-[12px]">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <ModulesTools t={t} />
      </div>
      {link !== false && <div className="md:hidden">{link}</div>}
    </div>
  )
}

/** The open row: a Timeline tab (the default) and an Information tab (configuration, modules and tools, what changed since). */
export function TraceDetail({ t, id, facts, changed, tab, onTab, mode, onMode }: {
  readonly t: TraceInfo
  readonly id: string
  readonly facts: ReadonlyArray<readonly [string, string]>
  readonly changed: ReadonlyArray<string>
  readonly tab: TraceTab
  readonly onTab: (t: TraceTab) => void
  readonly mode: AxisMode
  readonly onMode: (m: AxisMode) => void
}) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys = TABS.map(([k]) => k)
    const at = keys.indexOf(tab)
    const next = e.key === "ArrowRight" ? keys[(at + 1) % keys.length] : e.key === "ArrowLeft" ? keys[(at + keys.length - 1) % keys.length] : e.key === "Home" ? keys[0] : e.key === "End" ? keys[keys.length - 1] : undefined
    if (next === undefined) return
    e.preventDefault()
    onTab(next)
    requestAnimationFrame(() => document.getElementById(`${id}-tab-${next}`)?.focus())
  }
  return (
    <div className="sticky left-0 z-20 w-[min(100%,calc(100vw-40px))] max-w-[1280px] text-[13px]" data-testid="trace-detail">
      <div role="tablist" aria-label={`Turn ${t.turnId}`} className="mb-3 flex gap-1 border-b border-line">
        {TABS.map(([k, label]) => {
          const selected = k === tab
          return (
            <button
              key={k}
              id={`${id}-tab-${k}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${k}`}
              tabIndex={selected ? 0 : -1}
              data-testid={`trace-tab-${k}`}
              onKeyDown={onKey}
              onClick={() => onTab(k)}
              className={cx(
                "relative inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[14px] transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-voice",
                selected ? "border-voice text-ink" : "border-transparent text-ink-muted hover:text-ink"
              )}
            >
              {label}
              {k === "information" && changed.length > 0 && <span aria-hidden="true" className="block size-2 rounded-full bg-warn" />}
              {k === "information" && changed.length > 0 && <span className="sr-only">(changed since this turn)</span>}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`${id}-panel-timeline`} aria-labelledby={`${id}-tab-timeline`} hidden={tab !== "timeline"}>
        <TimelineTab t={t} mode={mode} onMode={onMode} />
      </div>
      <div role="tabpanel" id={`${id}-panel-information`} aria-labelledby={`${id}-tab-information`} hidden={tab !== "information"}>
        <InformationTab t={t} facts={facts} changed={changed} />
      </div>
    </div>
  )
}
