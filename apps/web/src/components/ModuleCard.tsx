"use client"
import { useState } from "react"
import type { ModuleInfo } from "@pva/protocol"
import { useClient, useClientState } from "./context.tsx"
import { SettingsForm } from "./SettingsForm.tsx"
import { StatusLine } from "./StatusLine.tsx"
import { Icon, Spinner } from "./ui/Icon.tsx"
import { Button, cx, Switch } from "./ui/controls.tsx"

// `stopping` is shown as off: the module left the snapshot at once and only its scope lingers for the
// server's 10 s grace (docs/UI-AND-MODULES.md §1.4), so a badge or spinner there would say it is still on.
const BADGE: Partial<Record<ModuleInfo["state"], string>> = { starting: "Starting", error: "Error" }
export const moduleBadge = (state: ModuleInfo["state"]): string | undefined => BADGE[state]
export const moduleSwitchBusy = (state: ModuleInfo["state"], requestPending: boolean) => requestPending || state === "starting"

export function ModuleCard({ module: m }: { readonly module: ModuleInfo }) {
  const client = useClient()
  const [expanded, setExpanded] = useState(m.state === "error")
  const busy = useClientState((s) => Object.values(s.pending).some((p) => p.target === m.id && (p.kind === "module.enable" || p.kind === "module.disable")))
  const toggle = async (enabled: boolean) => {
    const result = await client.enableModule(m.id, enabled) // continuation(none): shows this request's own outcome for this card
    if (!result.ok) {
      client.store.dispatch({ type: "local/toast", message: `${m.name}: ${result.error?.message ?? "the change failed."}`, tone: "error" })
      if (result.error?.code === "module_start_failed" || result.error?.code === "invalid_settings") setExpanded(true)
    }
  }
  const badge = moduleBadge(m.state)
  const bodyId = `module-${m.id}-body`
  return (
    <section
      data-testid={`module-${m.id}`}
      data-state={m.state}
      className={cx("rounded-lg border bg-surface transition-colors duration-[240ms]", m.state === "error" ? "border-danger/35" : "border-line")}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="pt-0.5">
          <Switch checked={m.enabled} onChange={(v) => void toggle(v)} label={`${m.name} enabled`} busy={moduleSwitchBusy(m.state, busy)} disabled={busy} />
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
          className="group -m-1 flex min-w-0 flex-1 items-start gap-2 rounded-md p-1 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[15px] font-medium text-ink">{m.name}</span>
              {badge !== undefined && (
                <span className={cx("label inline-flex items-center gap-1 text-[10px]", m.state === "error" ? "text-danger" : "text-ink-faint")}>
                  {m.state !== "error" && <Spinner size={10} />}
                  {badge}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[13px] text-ink-muted">{m.description}</span>
            {m.status !== undefined && m.state === "running" && <span className="mt-1.5 flex"><StatusLine status={m.status} /></span>}
          </span>
          <Icon name="chevronDown" size={18} className={cx("mt-0.5 shrink-0 text-ink-faint transition-transform duration-[120ms] group-hover:text-ink", expanded && "rotate-180")} />
        </button>
      </div>
      {expanded && (
        <div id={bodyId} className="flex flex-col gap-5 border-t border-line/70 px-4 pb-5 pt-4">
          {m.state === "error" && m.error !== undefined && (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5">
              <p className="text-[13px] text-ink">{m.error}</p>
              {m.enabled && <Button size="sm" onClick={() => void toggle(true)} disabled={busy}>{busy && <Spinner size={12} />}Retry</Button>}
            </div>
          )}
          {m.settings.fields.length > 0 && (
            <SettingsForm form={m.settings} revision={m.revision} idPrefix={`m-${m.id}`} onSave={(patch) => client.configureModule(m.id, patch)} />
          )}
          {m.tools.length > 0 && (
            <div>
              <h3 className="label mb-2 text-ink-faint">Tools</h3>
              <ul className="flex flex-col gap-2">
                {m.tools.map((t) => (
                  <li key={t.name} className="text-[13px]">
                    <span className="font-mono text-ink">{t.name}</span>
                    {t.speculative && <span className="label ml-2 rounded-sm border border-line px-1 text-[9px] text-ink-faint">Read-only</span>}
                    <p className="text-ink-muted">{t.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
