"use client"
import { PROTOCOL_VERSION } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState } from "./context.tsx"
import { ShortcutList } from "./ShortcutsDialog.tsx"

export function AboutTab() {
  const c = useClientState((s) => s.connection, shallowEqual)
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Assistant", c.server === undefined ? "—" : `${c.server.name} ${c.server.version}`],
    ["Protocol", `${PROTOCOL_VERSION}${c.protocol !== undefined && c.protocol !== PROTOCOL_VERSION ? ` (server ${c.protocol})` : ""}`],
    ["Connection", c.connectionId ?? "—"],
    ["Status", c.status]
  ]
  return (
    <div className="flex flex-col gap-7">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="break-all font-mono text-[13px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <section>
        <h3 className="label text-ink-faint">Keyboard</h3>
        <div className="-mx-5">
          <ShortcutList />
        </div>
      </section>
    </div>
  )
}
