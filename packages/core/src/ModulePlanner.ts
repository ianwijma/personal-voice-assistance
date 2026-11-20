/**
 * The module host's decisions, as pure functions (docs/ARCHITECTURE.md "Module host"). The host keeps a **desired
 * state** (what should run, with which settings) and publishes what runs; one worker fiber turns the difference into
 * a plan with `planModule`, one module at a time. Nothing here starts, stops or reads anything: the planner is tested
 * directly with a table of cases (`test/ModulePlanner.test.ts`).
 *
 * A module is replaced **whole, stop before start**: when what should run differs from what runs (its fingerprint),
 * the running one is stopped first and the new one started after; there is never an old and a new one at once.
 * A start that failed is not tried again until something it depends on changes (its `attempt` key: the fingerprint,
 * the vault, the requirement probes, the retry counter that enable, configure, startEnabled and Check again advance).
 */

/** One module, for demand: who wants it directly, what it names in `uses`, whether it can run here at all. */
export interface DemandNode {
  readonly id: string
  /** Its switch is on, or at least one assistant has it on. */
  readonly wanted: boolean
  /** Unavailable here, or a member of a `uses` cycle: never runs; an unavailable one does not demand what it uses. */
  readonly blocked: boolean
  readonly uses: ReadonlyArray<string>
}

/**
 * The modules demand reaches (§4 P1): every wanted one and, transitively, what a reached module that can run names in
 * `uses`. A blocked module is reached (its requirements matter for Health) but does not pass demand on.
 */
export const reachedBy = (nodes: ReadonlyArray<DemandNode>): Set<string> => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Set<string>()
  const stack = nodes.filter((n) => n.wanted).map((n) => n.id)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    const node = byId.get(id)
    if (node === undefined) continue
    out.add(id)
    if (node.blocked) continue
    for (const used of node.uses) if (!out.has(used) && byId.has(used)) stack.push(used)
  }
  return out
}

/**
 * The catalogue in start order: a module after the modules it names in `uses` (they are its providers), otherwise in
 * catalogue order. Members of a cycle keep their catalogue order (they never run). Stopping walks it backwards.
 */
export const usesOrder = (nodes: ReadonlyArray<Pick<DemandNode, "id" | "uses">>, cyclic: ReadonlySet<string>): Array<string> => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: Array<string> = []
  const done = new Set<string>()
  const visit = (id: string) => {
    if (done.has(id)) return
    done.add(id)
    if (!cyclic.has(id)) for (const used of byId.get(id)?.uses ?? []) if (byId.has(used) && !cyclic.has(used)) visit(used)
    out.push(id)
  }
  for (const n of nodes) visit(n.id)
  return out
}

/** An instance the desired state asks for: one per distinct set of valid effective settings. */
export interface InstanceTarget {
  /** Its effective non-secret values (equal keys share one instance); for settings that are not valid, per assistant. */
  readonly key: string
  readonly users: ReadonlyArray<string>
  readonly ownKeys: ReadonlyArray<string>
  /** Why it cannot start (its settings are not valid): it is shown as an error for its assistants, never started. */
  readonly invalid: string | undefined
}

/** What the desired state asks of one module. */
export interface ModuleTarget {
  readonly id: string
  /** It should run: demanded, able to run here, and the host is not closing. */
  readonly runs: boolean
  /** Why nothing of it can start (its shared settings, or every instance's, are not valid). */
  readonly invalid: string | undefined
  readonly instances: ReadonlyArray<InstanceTarget>
  /**
   * Exactly what runs: the shared settings, the valid instances' keys, the configured-secret epoch and the restart
   * counter. Equal fingerprints: what runs is left alone (only who uses which instance may change).
   */
  readonly fingerprint: string
  /**
   * The fingerprint plus what else a failed start depends on: whether the settings are valid, the vault, the
   * requirement probes, the retry counter.
   */
  readonly attempt: string
}

/** What the planner needs to know of a module now. */
export interface ModuleCurrent {
  /** The fingerprint of what is published; `undefined`: nothing runs. */
  readonly running: string | undefined
  /** The attempt key of the last start that failed, while the module stays down for it. */
  readonly failed: string | undefined
}

export interface ModulePlan {
  readonly id: string
  /** Withdraw what runs, wait for its calls in flight (the grace period), close it: before anything starts. */
  readonly stop: boolean
  /** Start the target (shared part, then instances) and publish it if every part started. */
  readonly start: boolean
  /** What runs is what should run: keep it, with the target's users. */
  readonly keep: boolean
  /** It should not run: forget its last failure (a new demand tries it again). */
  readonly forget: boolean
}

/**
 * What to do for one module, pure:
 *
 * - It should not run: stop what runs, forget a failure.
 * - Its settings are not valid: stop what runs (even with the same fingerprint: settings that cannot be read may
 *   leave it unchanged), start nothing; the module is down with its error.
 * - What runs has the target's fingerprint: keep it.
 * - Otherwise stop what runs (if anything), then start the target, unless that very attempt failed before (the
 *   module stays down with its error until something in its attempt key changes).
 */
export const planModule = (target: ModuleTarget, current: ModuleCurrent): ModulePlan => {
  const none = { id: target.id, stop: false, start: false, keep: false, forget: false }
  if (!target.runs) return { ...none, stop: current.running !== undefined, forget: true }
  if (target.invalid !== undefined) return { ...none, stop: current.running !== undefined }
  if (current.running === target.fingerprint) return { ...none, keep: true }
  return { ...none, stop: current.running !== undefined, start: target.invalid === undefined && current.failed !== target.attempt }
}
