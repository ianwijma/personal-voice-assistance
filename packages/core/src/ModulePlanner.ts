/**
 * The module host's decisions, as pure functions (docs/ARCHITECTURE.md "Module host: the reconciler"). The host keeps
 * a **desired state** (what should run, with which settings) and a **current state** (what is published); one
 * reconciler fiber turns the difference into a plan with `planModule` and executes it. Nothing here starts, stops or
 * reads anything: the planner is tested directly with a table of cases (`test/ModulePlanner.test.ts`).
 *
 * Fingerprints name a start exactly: a part whose fingerprint equals the published one's is left alone; any change of
 * settings, of a configured secret (`secretEpoch`) or of a restart counter gives a new fingerprint and a new start.
 * A start that failed is remembered with its fingerprint and the module's retry counter: the same start is not tried
 * again until something changes or a trigger asks for a retry (enable, configure, startEnabled, a vault change,
 * Check again).
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
 * catalogue order. Members of a cycle keep their catalogue order (they never run). Rank = position.
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

/** An instance the desired state asks for. */
export interface InstanceTarget {
  /** Its effective non-secret values: equal keys share one instance. */
  readonly key: string
  readonly users: ReadonlyArray<string>
  readonly ownKeys: ReadonlyArray<string>
  /** Why it cannot start (its settings are not valid); `undefined`: it can. */
  readonly invalid: string | undefined
  /** Exactly this start: the generation, the key, the configured-secret epoch, its restart counter. */
  readonly fingerprint: string
}

/** The shared part the desired state asks for (a module with `shared`). */
export interface SharedTarget {
  /** Its non-secret shared values. */
  readonly key: string
  readonly invalid: string | undefined
  /** The generation: the key, the configured-secret epoch, the shared restart counter. */
  readonly fingerprint: string
}

export interface ModuleTarget {
  readonly id: string
  /** It should run: demanded and able to run (and the host is not shutting down). */
  readonly runs: boolean
  /** Present for a module with `shared` that runs. */
  readonly shared: SharedTarget | undefined
  readonly instances: ReadonlyArray<InstanceTarget>
}

/** A start that failed: the same fingerprint is not tried again at the same retry counter. */
export interface Failure {
  readonly fingerprint: string
  readonly retry: number
  readonly message: string
}

/** What the planner needs to know of what is published now. */
export interface ModuleCurrent {
  /** The published shared part's fingerprint; `undefined`: none. */
  readonly generation: string | undefined
  /** Published instances: key → fingerprint and users. */
  readonly instances: ReadonlyMap<string, { readonly fingerprint: string; readonly users: ReadonlyArray<string> }>
  readonly failedGeneration: Failure | undefined
  readonly failedInstances: ReadonlyMap<string, Failure>
  /** The module's retry counter now (desired state). */
  readonly retry: number
}

export interface ModulePlan {
  readonly id: string
  /**
   * Start a new generation: this shared part and every instance in `start`, published together at the switch only if
   * all of them started and passed their checks; then the published generation (shared part and every instance) is
   * retired. Otherwise the published generation keeps serving (or the module stays down) and the failure is kept.
   */
  readonly generation: SharedTarget | undefined
  /** Instances to start: of the new generation, or (no `generation`) within the published one, each on its own. */
  readonly start: ReadonlyArray<InstanceTarget>
  /** Published instances to retire at the switch (no longer wanted). A generation retires all of them instead. */
  readonly retire: ReadonlyArray<string>
  /** Retire the published shared part (the module no longer runs). */
  readonly stop: boolean
  /** Published instances that keep running, with who uses them after the switch. */
  readonly keep: ReadonlyArray<{ readonly key: string; readonly users: ReadonlyArray<string>; readonly ownKeys: ReadonlyArray<string> }>
  /**
   * The published generation stays because the new one failed before (`failedGeneration`, same fingerprint and retry):
   * nothing starts until the desired state or the retry counter changes.
   */
  readonly kept: boolean
}

const failedBefore = (failure: Failure | undefined, fingerprint: string, retry: number) =>
  failure !== undefined && failure.fingerprint === fingerprint && failure.retry === retry

/** Whether a plan does anything (a fixpoint: the planner asks for nothing more). Users moving between kept instances count. */
export const isEmptyPlan = (plan: ModulePlan, current: ModuleCurrent): boolean =>
  plan.generation === undefined && plan.start.length === 0 && plan.retire.length === 0 && !plan.stop &&
  plan.keep.every((k) => (current.instances.get(k.key)?.users ?? []).join("\n") === k.users.join("\n"))

/**
 * What to do for one module to bring what is published in line with `target`. Pure.
 *
 * - It should not run: retire everything.
 * - With a shared part: a different generation fingerprint (or none published) starts a new generation with every
 *   instance; unless that very start failed at this retry counter, in which case the published generation is kept
 *   (instances whose assistants all left are retired, the others keep their remaining users).
 * - Within the published generation (or without a shared part): an instance whose fingerprint changed (a restart, a
 *   configured secret) starts again and replaces the old one only if it starts; a missing one starts unless that
 *   start failed at this retry counter; one no longer wanted is retired.
 */
export const planModule = (target: ModuleTarget, current: ModuleCurrent): ModulePlan => {
  const none = { id: target.id, generation: undefined, start: [], retire: [], stop: false, keep: [], kept: false }
  if (!target.runs) {
    return { ...none, retire: [...current.instances.keys()], stop: current.generation !== undefined }
  }
  if (target.shared !== undefined && current.generation !== target.shared.fingerprint) {
    if (failedBefore(current.failedGeneration, target.shared.fingerprint, current.retry)) {
      // The new generation failed: the old one serves on (if there is one) for the assistants still on it.
      const wanted = new Set(target.instances.flatMap((i) => i.users))
      const keep: Array<ModulePlan["keep"][number]> = []
      const retire: Array<string> = []
      for (const [key, live] of current.instances) {
        const users = live.users.filter((u) => wanted.has(u))
        if (live.users.length > 0 && users.length === 0) retire.push(key)
        else keep.push({ key, users, ownKeys: [] })
      }
      return { ...none, keep, retire, kept: true }
    }
    return { ...none, generation: target.shared, start: target.instances, retire: [...current.instances.keys()] }
  }
  const start: Array<InstanceTarget> = []
  const keep: Array<ModulePlan["keep"][number]> = []
  for (const instance of target.instances) {
    const live = current.instances.get(instance.key)
    if (live !== undefined && live.fingerprint === instance.fingerprint) {
      keep.push({ key: instance.key, users: instance.users, ownKeys: instance.ownKeys })
      continue
    }
    if (failedBefore(current.failedInstances.get(instance.key), instance.fingerprint, current.retry)) {
      // Its new start failed before: a live one of the same key (a failed restart) serves on.
      if (live !== undefined) keep.push({ key: instance.key, users: instance.users, ownKeys: instance.ownKeys })
      continue
    }
    start.push(instance)
  }
  const wanted = new Set(target.instances.map((i) => i.key))
  const retire = [...current.instances.keys()].filter((key) => !wanted.has(key))
  return { ...none, start, keep, retire }
}
