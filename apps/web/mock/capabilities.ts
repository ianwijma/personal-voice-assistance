import type { Assistant, ModuleInfo, ModuleInstanceInfo, SettingValue } from "@pva/protocol"

/** The fields of a capability module an assistant may own (`overridable`, never a secret), as the server marks them. */
export const ownableKeys = (m: ModuleInfo) => new Set(m.settings.fields.filter((f) => f.overridable === true && f.type !== "secret").map((f) => f.key))

/** An instance's key: the effective non-secret values (an assistant's own applied), as the host keys them. */
export const instanceKey = (m: ModuleInfo, own: Readonly<Record<string, SettingValue>> | undefined) => {
  const over = ownableKeys(m)
  const values: Record<string, SettingValue> = { ...m.settings.values }
  for (const [k, v] of Object.entries(own ?? {})) if (over.has(k)) values[k] = v
  return JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]]))
}

/** What the mock server knows about a running capability module (mock/server.ts gives it). */
export interface CapabilityParts {
  /** A failure injected into its instances (`/mock/module-error`). */
  readonly forced: (id: string) => string | undefined
  readonly runningStatus: (id: string, m: ModuleInfo) => ModuleInfo["status"]
  readonly runningTools: (id: string) => ModuleInfo["tools"]
  readonly instanceStatus: (id: string, m: ModuleInfo, own: Readonly<Record<string, SettingValue>> | undefined) => ModuleInstanceInfo["status"]
}

/**
 * A capability module's info for the assistants now: it runs while at least one switched-on assistant has it on;
 * assistants whose effective values are equal share one instance, an assistant with its own values may run another.
 * The shared instance is listed first. A module that cannot run here (`unavailable`: an unmet requirement) stays
 * unavailable whoever has it on, with no instances and no tools, as the server's host never starts it.
 */
export const reconcileCapability = (m: ModuleInfo, assistants: ReadonlyArray<Assistant>, parts: CapabilityParts): ModuleInfo => {
  const wanting = assistants.filter((a) => a.on && a.modules[m.id]?.on === true)
  const { error: _e, status: _s, ...rest } = m
  if (m.unavailable !== undefined) return { ...rest, enabled: wanting.length > 0, state: "unavailable", tools: [], instances: [] }
  const over = ownableKeys(m)
  const sharedKey = instanceKey(m, undefined)
  const groups = new Map<string, { assistants: Array<string>; own: Set<string>; values: Record<string, SettingValue> | undefined }>()
  for (const a of wanting) {
    const own = a.modules[m.id]!.own
    const key = instanceKey(m, own)
    const g = groups.get(key) ?? { assistants: [], own: new Set<string>(), values: key === sharedKey ? undefined : (own as Record<string, SettingValue> | undefined) }
    g.assistants.push(a.id)
    if (key !== sharedKey) for (const [k, v] of Object.entries(own ?? {})) if (over.has(k) && JSON.stringify(v) !== JSON.stringify(m.settings.values[k])) g.own.add(k)
    groups.set(key, g)
  }
  const forced = parts.forced(m.id)
  const status = parts.runningStatus(m.id, m)
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === sharedKey ? -1 : b === sharedKey ? 1 : 0)).map(([, g]) => g)
  const instances = ordered.map((g) => {
    const own = parts.instanceStatus(m.id, m, g.values)
    return {
      assistants: g.assistants,
      own: [...g.own],
      state: forced !== undefined ? ("error" as const) : ("running" as const),
      ...(forced !== undefined ? { error: `${forced} (for ${g.assistants.join(", ")})` } : own !== undefined ? { status: own } : {})
    }
  })
  return {
    ...rest,
    enabled: wanting.length > 0,
    state: wanting.length === 0 ? "disabled" : forced !== undefined ? "error" : "running",
    tools: wanting.length > 0 && forced === undefined ? [...parts.runningTools(m.id)] : [],
    ...(wanting.length > 0 && forced !== undefined ? { error: forced } : wanting.length > 0 && status !== undefined ? { status } : {}),
    instances
  }
}
