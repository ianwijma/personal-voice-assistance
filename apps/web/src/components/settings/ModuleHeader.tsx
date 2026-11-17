"use client"
import type { ModuleInfo } from "@pva/protocol"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { StatusLine } from "../StatusLine.tsx"
import { Spinner } from "../ui/Icon.tsx"
import { Button, cx, Switch } from "../ui/controls.tsx"
import { IssueFix } from "./pages/HealthPage.tsx"

// `stopping` is shown as off: the module left the snapshot at once and only its scope lingers for the
// server's 10 s grace (docs/UI-AND-MODULES.md §1.4), so a badge or spinner there would say it is still on.
const BADGE: Partial<Record<ModuleInfo["state"], string>> = { starting: "Starting", error: "Error", unavailable: "Not available" }
export const moduleBadge = (state: ModuleInfo["state"]): string | undefined => BADGE[state]
export const moduleSwitchBusy = (state: ModuleInfo["state"], requestPending: boolean) => requestPending || state === "starting"

/**
 * Running only because another module uses it (`uses`): its switch, or every assistant's, is off, yet its shared part
 * runs for the modules that need it (the server's `running` with no instances; docs/UI-AND-MODULES.md §1.10.1).
 */
export const runsForOthers = (m: ModuleInfo): boolean => m.state === "running" && !m.enabled && (m.instances ?? []).length === 0

/** "Off", "Starting", "Ready · …" or the error: one line for a module's state. */
export const moduleStateText = (m: ModuleInfo): string =>
  m.state === "unavailable"
    ? "Not available on this server"
    : runsForOthers(m)
    ? "Running for the modules that use it"
    : !m.enabled || m.state === "disabled" || m.state === "stopping"
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
            {m.version !== undefined && !compact && <span className="text-[12px] text-ink-faint" data-testid="module-version">version {m.version}</span>}
            {badge !== undefined && (
              <span className={cx("label inline-flex items-center gap-1 text-[10px]", m.state === "error" ? "text-danger" : m.state === "unavailable" ? "text-warn" : "text-ink-faint")}>
                {m.state === "starting" && <Spinner size={10} />}
                {badge}
              </span>
            )}
          </div>
          {m.status !== undefined && m.state === "running" && <span className="mt-1 flex"><StatusLine status={m.status} /></span>}
        </div>
      </div>
      {m.state === "unavailable" && <ModuleUnavailableNote module={m} />}
      {m.state === "error" && m.error !== undefined && (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5">
          <p className="text-[13px] text-ink">{m.error}</p>
          {m.enabled && editable && <Button size="sm" onClick={() => void toggle(true)} disabled={busy}>{busy && <Spinner size={12} />}Retry</Button>}
        </div>
      )}
    </div>
  )
}

/** Why a module cannot run on this server (protocol 9 `unavailable`), with its fix and a link to Health. */
export function ModuleUnavailableNote({ module: m }: { readonly module: ModuleInfo }) {
  const u = m.unavailable
  return (
    <div role="status" className="flex flex-col items-start gap-1.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-2.5" data-testid="module-unavailable">
      <p className="text-[13px] text-ink">{m.name} cannot run on this server{u !== undefined ? `: ${u.reason.replace(/[.]$/, "")}.` : "."}</p>
      {u?.fix !== undefined && <IssueFix fix={u.fix} />}
      <a href={formatSettingsHash(["diagnostics", "health"])} className="text-[13px] text-voice underline-offset-4 hover:underline">Diagnostics › Health</a>
    </div>
  )
}

/** Risks worth a word next to a tool (read and change are the usual ones; protocol 9). */
const RISK_LABEL: Partial<Record<NonNullable<ModuleInfo["tools"][number]["risk"]>, string>> = { message: "Sends messages", money: "Money", security: "Security" }

/** The module's tools, under its form. */
export function ModuleTools({ module: m }: { readonly module: ModuleInfo }) {
  const left = m.toolsLeft ?? 0
  if (m.tools.length === 0 && left === 0) return null
  return (
    <div>
      <h3 className="label mb-2 text-ink-faint">Tools</h3>
      <ul className="flex flex-col gap-2">
        {m.tools.map((t) => (
          <li key={t.name} className="text-[13px]">
            <span className="font-mono text-ink">{t.name}</span>
            {t.speculative && <span className="label ml-2 rounded-sm border border-line px-1 text-[9px] text-ink-faint">Read-only</span>}
            {t.risk !== undefined && RISK_LABEL[t.risk] !== undefined && <span className="label ml-2 rounded-sm border border-warn/50 px-1 text-[9px] text-warn" data-testid="tool-risk">{RISK_LABEL[t.risk]}</span>}
            {t.sensitivity === "personal" && <span className="label ml-2 rounded-sm border border-line px-1 text-[9px] text-ink-faint">Personal</span>}
            <p className="text-ink-muted">{t.description}</p>
          </li>
        ))}
      </ul>
      {left > 0 && <p className="mt-2 text-[13px] text-ink-muted" data-testid="tools-left">{m.tools.length === 0 ? `${left} tools` : `and ${left} more`}</p>}
    </div>
  )
}

/** The labels of the fields an instance's assistants have their own values for ("date format"). */
const ownLabels = (m: ModuleInfo, keys: ReadonlyArray<string>): string =>
  keys.map((k) => (m.settings.fields.find((f) => f.key === k)?.label ?? k).toLowerCase()).join(", ")

/**
 * A capability module's use (docs/ASSISTANTS.md §2.6, §7.1): whether it runs follows the assistants that have it on, so
 * there is no switch. Each running instance is listed with the assistants that use it ("Shared settings", or "Own date
 * format" for the assistants that have their own values), its state, status and error.
 */
export function ModuleInstances({ module: m }: { readonly module: ModuleInfo }) {
  const names = useClientState((s) => Object.fromEntries(s.assistants.map((a) => [a.id, a.name])), shallowEqual)
  const instances = m.instances ?? []
  const nameOf = (id: string) => names[id] ?? id
  return (
    <div className="flex flex-col gap-2" data-testid={`module-${m.id}`} data-state={m.state}>
      {m.version !== undefined && <span className="text-[12px] text-ink-faint" data-testid="module-version">version {m.version}</span>}
      {m.state === "unavailable" ? (
        <ModuleUnavailableNote module={m} />
      ) : instances.length === 0 && runsForOthers(m) ? (
        <p className="text-[13px] text-ink-muted" data-testid="no-instances" data-shared="true">
          Running for the modules that use it: no assistant has {m.name} switched on itself.
        </p>
      ) : instances.length === 0 && m.state === "starting" ? (
        <p className="text-[13px] text-ink-muted" data-testid="no-instances">Starting…</p>
      ) : instances.length === 0 && m.state === "error" ? (
        <p role="alert" className="text-[13px] text-danger" data-testid="no-instances">Could not start{m.error !== undefined ? `: ${m.error}` : ""}</p>
      ) : instances.length === 0 ? (
        <p className="text-[13px] text-ink-muted" data-testid="no-instances">Not running: no assistant has {m.name} switched on.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={`${m.name} instances`}>
          {instances.map((inst, i) => {
            const own = inst.own.length > 0
            return (
              <li key={i} className="flex flex-col gap-1 rounded-md border border-line/70 px-3 py-2" data-testid="instance" data-state={inst.state} data-own={own ? "true" : "false"}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                  <span className={cx("inline-block size-2 shrink-0 self-center rounded-full", inst.state === "error" ? "bg-danger" : inst.state === "starting" ? "bg-warn" : "bg-ok")} aria-hidden="true" />
                  <span className="font-medium text-ink">{inst.state === "error" ? "Could not start" : inst.state === "starting" ? "Starting…" : "Running"}</span>
                  <span className="text-ink-muted">
                    {own ? <>Own {ownLabels(m, inst.own)}</> : "Shared settings"}
                    {" · "}
                    {inst.assistants.map((id, j) => (
                      <span key={id}>
                        {j > 0 && ", "}
                        <a href={formatSettingsHash(["assistants", id, "modules"])} className="text-voice underline-offset-4 hover:underline">{nameOf(id)}</a>
                      </span>
                    ))}
                  </span>
                </div>
                {inst.status !== undefined && inst.state === "running" && <span className="flex"><StatusLine status={inst.status} /></span>}
                {inst.state === "error" && inst.error !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="instance-error">{inst.error}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
