"use client"
import { modulesInOrder } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState } from "./context.tsx"
import { ModuleCard } from "./ModuleCard.tsx"

export function ModulesTab() {
  const modules = useClientState(modulesInOrder, shallowEqual)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-muted">Capabilities the assistant can use. Changes apply from the next turn.</p>
      {modules.length === 0 && <p className="py-6 text-center text-[14px] text-ink-faint">No modules.</p>}
      {modules.map((m) => <ModuleCard key={m.id} module={m} />)}
    </div>
  )
}
