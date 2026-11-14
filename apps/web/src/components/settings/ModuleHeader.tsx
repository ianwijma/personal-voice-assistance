"use client"
import type { ModuleInfo } from "@pva/protocol"
import { useClient, useClientState } from "../context.tsx"
import { StatusLine } from "../StatusLine.tsx"
import { Spinner } from "../ui/Icon.tsx"
import { Button, cx, Switch } from "../ui/controls.tsx"

// `stopping` is shown as off: the module left the snapshot at once and only its scope lingers for the
// server's 10 s grace (docs/UI-AND-MODULES.md §1.4), so a badge or spinner there would say it is still on.
const BADGE: Partial<Record<ModuleInfo["state"], string>> = { starting: "Starting", error: "Error" }
export const moduleBadge = (state: ModuleInfo["state"]): string | undefined => BADGE[state]
export const moduleSwitchBusy = (state: ModuleInfo["state"], requestPending: boolean) => requestPending || state === "starting"

/** "Off", "Starting", "Ready · …" or the error: one line for a module's state. */
export const moduleStateText = (m: ModuleInfo): string =>
  !m.enabled || m.state === "disabled" || m.state === "stopping"
    ? "Off"
    : m.state === "starting"
    ? "Starting…"
    : m.state === "error"
    ? "Could not start"
    : m.status?.text ?? "Running"

/** Switch a module on or off (requests through the client; a refusal is a toast). */
export const useModuleToggle = (m: ModuleInfo) => {
  const client = useClient()
  const busy = useClientState((s) => Object.values(s.pending).some((p) => p.target === m.id && (p.kind === "module.enable" || p.kind === "module.disable")))
  const toggle = async (enabled: boolean) => {
    const result = await client.enableModule(m.id, enabled) // continuation(none): shows this request's own outcome for this module
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: `${m.name}: ${result.error?.message ?? "the change failed."}`, tone: "error" })
    return result
  }
  return { busy, toggle }
}

/** A module's switch, state and error (with Retry): the top of its page, and the card next to a choice it serves. */
export function ModuleHeader({ module: m, editable, compact = false }: { readonly module: ModuleInfo; readonly editable: boolean; readonly compact?: boolean }) {
  const { busy, toggle } = useModuleToggle(m)
  const badge = moduleBadge(m.state)
  return (
    <div className="flex flex-col gap-3" data-testid={`module-${m.id}`} data-state={m.state} data-locked={editable ? undefined : "true"}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Switch checked={m.enabled} onChange={(v) => void toggle(v)} label={`${m.name} enabled`} busy={moduleSwitchBusy(m.state, busy)} disabled={busy || !editable} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx("font-medium text-ink", compact ? "text-[14px]" : "text-[15px]")}>{compact ? `${m.name} module: ${m.enabled ? "on" : "off"}` : m.enabled ? "On" : "Off"}</span>
            {badge !== undefined && (
              <span className={cx("label inline-flex items-center gap-1 text-[10px]", m.state === "error" ? "text-danger" : "text-ink-faint")}>
                {m.state !== "error" && <Spinner size={10} />}
                {badge}
              </span>
            )}
          </div>
          {m.status !== undefined && m.state === "running" && <span className="mt-1 flex"><StatusLine status={m.status} /></span>}
        </div>
      </div>
      {m.state === "error" && m.error !== undefined && (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5">
          <p className="text-[13px] text-ink">{m.error}</p>
          {m.enabled && editable && <Button size="sm" onClick={() => void toggle(true)} disabled={busy}>{busy && <Spinner size={12} />}Retry</Button>}
        </div>
      )}
    </div>
  )
}

/** The module's tools, under its form. */
export function ModuleTools({ module: m }: { readonly module: ModuleInfo }) {
  if (m.tools.length === 0) return null
  return (
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
  )
}
