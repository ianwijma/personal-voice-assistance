"use client"
import { useRef } from "react"
import { shallowEqual } from "@/lib/store.ts"
import { optionTabs } from "@/ui/registry.ts"
import { useClient, useClientState } from "./context.tsx"
import { PanelHeader, useDialog } from "./ui/Panel.tsx"
import { cx } from "./ui/controls.tsx"

/** Options: a right drawer (420 px) on larger screens, a full-screen sheet on phones. Tabs come from the registry. */
export function OptionsDrawer() {
  const client = useClient()
  const open = useClientState((s) => s.ui.optionsOpen)
  const tab = useClientState((s) => s.ui.optionsTab)
  const visible = useClientState((s) => optionTabs.filter((t) => t.when?.(s) ?? true).map((t) => t.id), shallowEqual)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => client.store.dispatch({ type: "local/ui", patch: { optionsOpen: false } })
  useDialog(ref, open, close, "[role=tab][aria-selected=true]")
  if (!open) return null
  const tabs = optionTabs.filter((t) => visible.includes(t.id))
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!
  const select = (id: string) => client.store.dispatch({ type: "local/ui", patch: { optionsTab: id } })
  const Current = current.component
  return (
    <>
      <div className="fixed inset-0 z-40 bg-bg/60 animate-[pva-fade-in_200ms_var(--ease-out)]" onClick={close} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="options-title"
        data-testid="options"
        className="fixed inset-0 z-50 flex flex-col bg-surface shadow-panel animate-[pva-slide-in_320ms_var(--ease-out)] sm:left-auto sm:w-[420px] sm:border-l sm:border-line"
      >
        <PanelHeader title="Options" titleId="options-title" onClose={close} />
        <div role="tablist" aria-label="Options sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 scrollbar-quiet">
          {tabs.map((t) => {
            const selected = t.id === current.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`panel-${t.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
                  e.preventDefault()
                  const i = tabs.findIndex((x) => x.id === current.id)
                  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!
                  select(next.id)
                  requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus())
                }}
                className={cx(
                  "relative h-11 shrink-0 px-3 text-[14px] transition-colors duration-[120ms]",
                  selected ? "text-ink" : "text-ink-muted hover:text-ink"
                )}
              >
                {t.title}
                <span aria-hidden="true" className={cx("absolute inset-x-3 bottom-0 h-px transition-colors", selected ? "bg-ink" : "bg-transparent")} />
              </button>
            )
          })}
        </div>
        <div role="tabpanel" id={`panel-${current.id}`} aria-labelledby={`tab-${current.id}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-quiet" tabIndex={-1}>
          <Current />
        </div>
      </div>
    </>
  )
}
