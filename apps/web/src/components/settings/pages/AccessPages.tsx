"use client"
import { useMemo } from "react"
import { buildSettingsTree } from "@/lib/settingsTree.ts"
import { modulesInOrder } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { keysList, secretStatus } from "@/lib/vault.ts"
import { useClient, useClientState } from "../../context.tsx"
import { KeysPanel } from "../../KeysPanel.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { cx } from "../../ui/controls.tsx"

/** Keys & access › Edit access & vault: the vault's controls (`KeysPanel`) and what admin access means. */
export function AccessPage() {
  const admin = useClientState((s) => s.vault.admin)
  const state = useClientState((s) => s.vault.state)
  return (
    <div className="flex flex-col gap-6">
      <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2/40 px-3 py-2.5 text-[13px] text-ink-muted" data-testid="access-state">
        <Icon name="lock" size={15} className="mt-0.5 shrink-0" />
        <span>
          {state === "none"
            ? "Every page may change every setting until you set a password."
            : admin
            ? "This page has edit access: it may change keys, providers and agents."
            : "This page can change open settings only. Pages marked with a padlock need the password, typed on this page."}
        </span>
      </p>
      <KeysPanel />
    </div>
  )
}

/** Keys & access › Keys: every key with its state and the pages that use it (no values: the server never sends them). */
export function KeysListPage() {
  const client = useClient()
  const sections = useClientState((s) => s.sections)
  const modules = useClientState(modulesInOrder, shallowEqual)
  const byId = useClientState((s) => s.modules.byId)
  const vault = useClientState((s) => s.vault, shallowEqual)
  const keys = useMemo(() => keysList(buildSettingsTree({ sections, modules, clientPages: [] }), byId), [sections, modules, byId])
  if (keys.length === 0) return <p className="text-[14px] text-ink-faint">No setting uses a key.</p>
  return (
    <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="keys-list">
      {keys.map((k) => (
        <li key={k.id} className="flex flex-col gap-1.5 px-3 py-3" data-key={k.env ?? k.id} data-set={k.state.set ? "true" : "false"}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[14px] text-ink">{k.label}</span>
            {k.env !== undefined && <span className="font-mono text-[12px] text-ink-faint">{k.env}</span>}
            <span className={cx("ml-auto inline-flex items-center gap-1.5 text-[12px]", k.state.set ? "text-ok" : vault.state === "locked" ? "text-ink-muted" : "text-ink-faint")}>
              {vault.state === "locked" && k.state.source !== "env" ? <Icon name="key" size={13} /> : <span aria-hidden="true" className={cx("size-1.5 rounded-full", k.state.set ? "bg-ok" : "bg-ink-faint")} />}
              {secretStatus(k.state, vault, k.env, k.source)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-muted">
            <span>Used by</span>
            {k.usedBy.map((u, i) => (
              <span key={u.title}>
                {i > 0 && <span className="mr-2">·</span>}
                <button type="button" className="text-voice underline-offset-4 hover:underline" onClick={() => client.settings(u.path)}>{u.title}</button>
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
