import type { ErrorInfo, FieldError, ModuleInfo, ModuleInstanceInfo, ModuleState, SettingsPatch, SettingValue, StatusLine } from "@pva/protocol"
import { Cause, Clock, Effect, Exit, Scope, Stream } from "effect"
import { actionTool, defineAction, Param, type RegisteredAction, registerActions } from "./Actions.ts"
import type { Agent } from "./Agent.ts"
import { buildDecisionPlan, type DecisionProvider } from "./Decision.ts"
import type { AssistantModule, ContextProvider, Tool } from "./Module.ts"
import type { FieldActionResult } from "./ModuleContributions.ts"
import { type ModuleDefinition, type ModuleInstance, ModuleStartError } from "./ModuleDefinition.ts"
import { applicableOwnValues, applySettingsPatch, checkOwnValues, type ResolvedSettings, resolveSettings } from "./Settings.ts"
import { makeToolRegistry, type ToolRegistry } from "./ToolRegistry.ts"

/**
 * The module host (docs/UI-AND-MODULES.md §1.4, docs/ASSISTANTS.md §2.6): owns every module of the catalog for the
 * life of the process. It starts modules, enables, disables and reconfigures them while the assistant runs, and
 * publishes an immutable snapshot (tool registry + instructions) that each turn reads once at its start.
 * Persistence is injected, so the host has no Node dependency.
 *
 * A module runs as **instances**. Without `demand` (the CLI modes, agents and decision providers) a module has at
 * most one, following its saved on/off. With `demand` (serve mode's capabilities), a module runs while at least one
 * assistant wants it, one instance per distinct set of effective settings (the assistant's own values of
 * `overridable` fields over the shared ones over the linked defaults): assistants with equal settings share one.
 */

/** What is saved per module (only values the owner set). */
export interface ModuleRecord {
  readonly enabled?: boolean
  readonly settings?: Readonly<Record<string, unknown>>
}

export interface ModulePersistence {
  /** The saved state, read once at startup. */
  readonly initial: {
    readonly modules: Readonly<Record<string, ModuleRecord>>
    readonly secrets: Readonly<Record<string, Readonly<Record<string, string>>>>
  }
  /** Save one module's intent, values and secrets. Failures are logged; the host carries on. */
  readonly save: (
    id: string,
    record: {
      readonly enabled: boolean
      readonly settings: Readonly<Record<string, SettingValue>>
      readonly secrets: Readonly<Record<string, string>>
    }
  ) => Effect.Effect<void, unknown>
}

/** Persistence that remembers nothing (tests, and CLI modes that never write). */
export const readOnlyPersistence = (initial: ModulePersistence["initial"] = { modules: {}, secrets: {} }): ModulePersistence => ({
  initial,
  save: () => Effect.void
})

/** What one turn uses: the running modules' tools and context providers, and their instructions (catalog order). */
export interface ModuleSnapshot {
  /** Increases whenever the set of running instances changes. */
  readonly version: number
  /**
   * Module tools plus one generated tool per action (unless the action says `offerAsTool: false`): one instance per
   * module (the one with the shared settings when it runs).
   */
  readonly registry: ToolRegistry["Service"]
  readonly instructions: ReadonlyArray<string>
  /** Tool name → id of the module that contributes it (generated action tools included; every instance's tools). */
  readonly toolModules: ReadonlyMap<string, string>
  /** Running agents by id (agent modules), catalog order. */
  readonly agents: ReadonlyMap<string, Agent>
  /** Actions of the running modules, catalog order. */
  readonly actions: ReadonlyArray<RegisteredAction>
  /** Running decision providers by id. */
  readonly deciders: ReadonlyMap<string, DecisionProvider>
  /**
   * The same running modules one by one, in `registry` order: what each contributes (its tools, generated action
   * tools included, and context providers, as `registry` holds them) and its instructions ("" if none). For a
   * registry of some of them only (an assistant's module choices, docs/ASSISTANTS.md §2.6).
   */
  readonly parts: ReadonlyArray<ModulePart>
  /**
   * Per assistant named by `demand`: the parts it uses, catalog order: of each module it wants, the instance of its
   * effective settings (left out while that instance is not running), and every module without demand (agents,
   * decision providers). A part is the same object as in `parts` when it is the same instance. Empty without demand.
   */
  readonly assistantParts: ReadonlyMap<string, ReadonlyArray<ModulePart>>
}

/** One running module's share of a `ModuleSnapshot`. */
export interface ModulePart {
  readonly moduleId: string
  /** `name` is the module id. */
  readonly module: AssistantModule
  readonly instructions: string
}

/** One assistant that wants a module (docs/ASSISTANTS.md §2.6), with its own values for the module's fields. */
export interface ModuleDemand {
  readonly assistantId: string
  /** `ModuleChoice.own`: only `overridable` fields count (anything else is ignored here; `checkOwn` refuses it). */
  readonly own?: Readonly<Record<string, unknown>>
}

/** Result of `ModuleHost.fieldAction`. */
export type FieldActionHostResult =
  | { readonly ok: true; readonly result: FieldActionResult }
  | { readonly ok: false; readonly code: "unknown_module" | "unknown_action" | "not_running"; readonly message: string }

export type HostResult = { readonly ok: true } | { readonly ok: false; readonly error: ErrorInfo }

export interface ModuleHost {
  /** The current snapshot (a reference read). */
  readonly snapshot: () => ModuleSnapshot
  /** Every module, in catalog order. */
  readonly modules: () => ReadonlyArray<ModuleInfo>
  /**
   * Start every module that should run (its intent is on, or an assistant wants it), concurrently; completes when
   * all have settled. Reads `demand` first.
   */
  readonly startEnabled: Effect.Effect<void>
  /** Refused `not_allowed` for a module with demand (the assistants switch it on and off). */
  readonly enable: (id: string) => Effect.Effect<HostResult>
  /** Refused `not_allowed` for a module with demand (the assistants switch it on and off). */
  readonly disable: (id: string) => Effect.Effect<HostResult>
  /**
   * Change the shared settings. `includeHidden`: also save fields hidden by `visibleWhen` (moving values out of
   * `.env`). Only the instances whose effective settings change are restarted (all of them when a secret changes);
   * if any of them fails to start, nothing changes.
   */
  readonly configure: (id: string, patch: SettingsPatch, options?: { readonly includeHidden?: boolean }) => Effect.Effect<HostResult>
  /**
   * Replace every module's saved secrets without saving them (the app's key vault was unlocked or locked; a module
   * missing from `secrets` has none). Modules whose secrets changed are announced; instances in `error` are started
   * again (a start that failed for lack of a key). Running instances keep running with what they started with.
   * Completes when those starts have settled.
   */
  readonly setSecrets: (secrets: Readonly<Record<string, Readonly<Record<string, string>>>>) => Effect.Effect<void>
  /**
   * Read `demand` and `defaults` again and bring the instances in line (docs/ASSISTANTS.md §2.6): start the
   * instances now wanted, and retire (after the grace period) those no longer wanted. An instance whose settings did
   * not change is left alone; a replaced one keeps serving until its replacement has started. A module busy with
   * another operation is brought in line when that operation ends. Completes when the starts have settled.
   */
  readonly refresh: Effect.Effect<void>
  /**
   * Check an assistant's own values for a module (`ModuleChoice.own`): only `overridable` fields (never a secret),
   * with values the field accepts. `unknown_module` is an error under the key `null`.
   */
  readonly checkOwn: (id: string, own: Readonly<Record<string, unknown>>) => ReadonlyArray<FieldError>
  /** Called with a module's new info whenever it changes (state, settings, status). Returns an unsubscribe function. */
  readonly subscribe: (listener: (info: ModuleInfo) => void) => () => void
  /**
   * Press an `action` field of a running module (its instance with the shared settings): its own
   * `fieldActions[key]`, or the generated `test` of an agent or decision provider (docs/AGENTS-AND-INTENTS.md §1.6).
   */
  readonly fieldAction: (id: string, key: string) => Effect.Effect<FieldActionHostResult>
}

export interface ModuleHostOptions {
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly persistence: ModulePersistence
  /** The environment (including `.env`); fields with `env` read it and are locked when set. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Where an environment variable came from (`.env` or the process), for the fields' `source`. */
  readonly envOrigin?: (name: string) => "env-file" | "env-process"
  /** The `.env` file and line that set a variable, shown on the locked field. */
  readonly envLocation?: (name: string) => { readonly file: string; readonly line: number } | undefined
  /** Time `start` may take. Default 10 s. */
  readonly startTimeoutMs?: number
  /** Time a replaced or stopped instance keeps running for tool calls in flight. Default 10 s. */
  readonly graceMs?: number
  /** Time a context provider may take per turn. Default 50 ms. */
  readonly contextTimeoutMs?: number
  /**
   * Linked defaults of a module's fields (docs/ASSISTANTS.md §2.6, computed from Home): used instead of the field's
   * own default when nothing is saved and the environment does not set it. Read whenever settings are resolved;
   * `refresh` restarts the instances whose settings they changed.
   */
  readonly defaults?: (moduleId: string) => Readonly<Record<string, unknown>> | undefined
  /**
   * Who wants which module (docs/ASSISTANTS.md §2.6), read by `startEnabled` and `refresh` (never while the host is
   * being made). A module with an entry runs while its list is not empty, one instance per distinct set of effective
   * settings, and its saved on/off is not read (`enable`/`disable` are refused). A module without an entry follows
   * its saved on/off with one instance.
   */
  readonly demand?: () => ReadonlyMap<string, ReadonlyArray<ModuleDemand>>
}

interface Running {
  readonly scope: Scope.Closeable
  readonly instance: ModuleInstance
  readonly generation: number
  /** The instance's tools plus the generated action tools. */
  readonly tools: ReadonlyArray<Tool>
  readonly actions: ReadonlyArray<RegisteredAction>
}

/** One wanted instance of a module: the settings it runs with, who uses it, and how it is doing. */
interface Instance {
  /** The effective non-secret values (own values applied): equal keys share one instance. */
  readonly key: string
  /** The fields its assistants have their own values for. */
  ownKeys: ReadonlyArray<string>
  /** The assistants that use it (empty for a module without demand). */
  users: ReadonlyArray<string>
  state: "starting" | "running" | "error"
  error: string | undefined
  status: StatusLine | undefined
  running: Running | undefined
}

interface Entry {
  readonly def: ModuleDefinition<any>
  /** The saved intent (read only for a module without demand). */
  enabled: boolean
  stored: Readonly<Record<string, unknown>>
  secrets: Readonly<Record<string, string>>
  /** The owner has chosen on or off (saved); before that, `enabledByDefault` / `enabledWhenSet` decide. */
  chosen: boolean
  /** Who wants it, as of the last `startEnabled` / `refresh`; `undefined`: no demand (it follows `enabled`). */
  demand: ReadonlyArray<ModuleDemand> | undefined
  /** The wanted instances, by key. */
  instances: Map<string, Instance>
  /** Replaced instances still serving until the operation that replaced them has settled its starts. */
  leaving: Set<Instance>
  /** Instances in their grace period. */
  retiring: number
  busy: boolean
  /** A refresh came while another operation held the module: it runs when that operation ends. */
  dirty: boolean
  revision: number
  generation: number
}

/** The instances one set of effective settings asks for. */
interface Group {
  readonly key: string
  readonly ownKeys: Array<string>
  readonly users: Array<string>
  readonly resolved: ResolvedSettings<unknown>
}

type Started = { readonly ok: true; readonly running: Running; readonly status: StatusLine | undefined } | { readonly ok: false; readonly message: string }

const failure = (code: ErrorInfo["code"], message: string, extra: Partial<ErrorInfo> = {}): HostResult => ({
  ok: false,
  error: { code, message, ...extra }
})

const OK: HostResult = { ok: true }

const toolNames = (running: { readonly tools: ReadonlyArray<Tool> } | undefined) => (running?.tools ?? []).map((t) => t.name)

/** An instance's actions, registered under the module id, and its tools plus one generated tool per offered action. */
const contributionsOf = (moduleId: string, instance: ModuleInstance) => {
  const actions = registerActions(moduleId, instance.actions ?? [])
  const generated = actions.filter((a) => a.definition.offerAsTool !== false).map(actionTool)
  return { actions, tools: [...(instance.tools ?? []), ...generated] }
}

export const makeModuleHost = Effect.fnUntraced(function*(options: ModuleHostOptions) {
  const hostScope = yield* Effect.scope
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const graceMs = options.graceMs ?? 10_000
  const contextTimeoutMs = options.contextTimeoutMs ?? 50
  const listeners = new Set<(info: ModuleInfo) => void>()
  const retired = new Set<Scope.Closeable>()

  const ids = new Set<string>()
  const entries: Array<Entry> = options.catalog.map((def) => {
    if (ids.has(def.id)) throw new Error(`Two modules have the id "${def.id}"`)
    ids.add(def.id)
    const record = options.persistence.initial.modules[def.id]
    return {
      def,
      enabled: record?.enabled ?? def.enabledByDefault,
      chosen: record?.enabled !== undefined,
      stored: record?.settings ?? {},
      secrets: options.persistence.initial.secrets[def.id] ?? {},
      demand: undefined,
      instances: new Map(),
      leaving: new Set(),
      retiring: 0,
      busy: false,
      dirty: false,
      revision: 0,
      generation: 0
    }
  })
  const byId = new Map(entries.map((e) => [e.def.id, e]))
  const envOrigin = {
    ...(options.envOrigin !== undefined ? { envOrigin: options.envOrigin } : {}),
    ...(options.envLocation !== undefined ? { envLocation: options.envLocation } : {})
  }
  const linked = (entry: Entry) => {
    const defaults = options.defaults?.(entry.def.id)
    return defaults === undefined ? {} : { defaults }
  }

  const resolve = (entry: Entry, stored = entry.stored, secrets = entry.secrets, own?: Readonly<Record<string, unknown>>) =>
    resolveSettings(entry.def.settings, { stored, secrets, env: options.env, ...envOrigin, ...linked(entry), ...(own !== undefined ? { own } : {}) })

  /** Before the owner has chosen: on by default, or on once the `enabledWhenSet` key is set (environment or saved). */
  const defaultIntent = (entry: Entry): boolean => {
    const key = entry.def.enabledWhenSet
    if (entry.def.enabledByDefault || key === undefined) return entry.def.enabledByDefault
    return resolve(entry).form.secrets[key]?.set === true
  }
  for (const entry of entries) if (!entry.chosen) entry.enabled = defaultIntent(entry)

  /** The groups of effective settings the module should run with now (or with `stored`/`secrets`, a change being made). */
  const groupsOf = (entry: Entry, stored = entry.stored, secrets = entry.secrets): Array<Group> => {
    if (entry.demand === undefined) {
      if (!entry.enabled) return []
      const resolved = resolve(entry, stored, secrets)
      return [{ key: JSON.stringify(resolved.form.values), ownKeys: [], users: [], resolved }]
    }
    const groups = new Map<string, Group>()
    for (const d of entry.demand) {
      const own = applicableOwnValues(entry.def.settings, d.own)
      const resolved = resolve(entry, stored, secrets, own)
      const key = JSON.stringify(resolved.form.values)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { key, ownKeys: Object.keys(own), users: [d.assistantId], resolved })
      else {
        group.users.push(d.assistantId)
        for (const k of Object.keys(own)) if (!group.ownKeys.includes(k)) group.ownKeys.push(k)
      }
    }
    return [...groups.values()]
  }

  const newInstance = (group: Group): Instance => ({
    key: group.key,
    ownKeys: group.ownKeys,
    users: group.users,
    state: "starting",
    error: undefined,
    status: undefined,
    running: undefined
  })

  /** Running instances: the wanted ones in order, then the leaving ones. */
  const runningOf = (entry: Entry): Array<Instance> => [...entry.instances.values(), ...entry.leaving].filter((r) => r.running !== undefined)

  /** The instance with the shared settings when it runs, else the first running one. */
  const mainOf = (entry: Entry): Instance | undefined => {
    const running = runningOf(entry)
    return running.find((r) => r.ownKeys.length === 0) ?? running[0]
  }

  /** The instance an assistant uses now: its wanted one when it runs, else the one it used before (still leaving). */
  const instanceFor = (entry: Entry, assistantId: string): Instance | undefined => {
    for (const r of entry.instances.values()) if (r.running !== undefined && r.users.includes(assistantId)) return r
    for (const r of entry.leaving) if (r.running !== undefined && r.users.includes(assistantId)) return r
    return undefined
  }

  /** The module's state from its instances: `error` when one fails, `starting` while one starts. */
  const stateOf = (entry: Entry): { readonly state: ModuleState; readonly error?: string } => {
    const all = [...entry.instances.values()]
    if (all.length === 0) return { state: entry.retiring > 0 || entry.leaving.size > 0 ? "stopping" : "disabled" }
    if (all.some((r) => r.state === "starting")) return { state: "starting" }
    const failed = all.find((r) => r.state === "error")
    if (failed === undefined) return { state: "running" }
    const message = failed.error ?? "The module could not start"
    return { state: "error", error: all.length === 1 || failed.users.length === 0 ? message : `${message} (for ${failed.users.join(", ")})` }
  }

  const instanceInfo = (r: Instance): ModuleInstanceInfo => ({
    assistants: [...r.users],
    own: [...r.ownKeys],
    state: r.state,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.status !== undefined && r.running !== undefined ? { status: r.status } : {})
  })

  const info = (entry: Entry): ModuleInfo => {
    const { state, error } = stateOf(entry)
    const main = mainOf(entry)
    const tools = new Map<string, Tool>()
    for (const r of [...(main === undefined ? [] : [main]), ...runningOf(entry)]) {
      for (const t of r.running?.tools ?? []) if (!tools.has(t.name)) tools.set(t.name, t)
    }
    return {
      id: entry.def.id,
      name: entry.def.name,
      description: entry.def.description,
      enabled: entry.demand === undefined ? entry.enabled : entry.demand.length > 0,
      state,
      ...(error !== undefined ? { error } : {}),
      ...(main?.status !== undefined ? { status: main.status } : {}),
      tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, speculative: t.speculative === true })),
      settings: resolve(entry).form,
      revision: entry.revision,
      ...(entry.def.kind !== undefined ? { kind: entry.def.kind } : {}),
      ...(entry.demand !== undefined ? { instances: [...entry.instances.values()].map(instanceInfo) } : {})
    }
  }

  const notify = (entry: Entry) => {
    entry.revision++
    if (listeners.size === 0) return
    const current = info(entry)
    for (const listener of listeners) {
      try {
        listener(current)
      } catch {
        // A listener must not break the host.
      }
    }
  }

  // Status lines are coalesced: many updates in one tick produce one notification.
  const pendingStatus = new Set<Entry>()
  const scheduleStatus = (entry: Entry) => {
    if (pendingStatus.size === 0) {
      queueMicrotask(() => {
        const due = [...pendingStatus]
        pendingStatus.clear()
        due.forEach(notify)
      })
    }
    pendingStatus.add(entry)
  }

  const wrapProvider = (moduleId: string, provider: ContextProvider): ContextProvider => ({
    name: provider.name,
    get: provider.get.pipe(
      Effect.timeoutOrElse({
        duration: contextTimeoutMs,
        orElse: () =>
          Effect.as(
            Effect.logWarning(`Context provider "${provider.name}" (module ${moduleId}) took over ${contextTimeoutMs} ms; left out of this turn`),
            ""
          )
      }),
      Effect.catchCause((cause) => Effect.as(Effect.logWarning(`Context provider "${provider.name}" failed`, cause), ""))
    )
  })

  /** One part per running instance, made once (so every snapshot and every assistant shares the same object). */
  const parts = new WeakMap<Running, ModulePart>()
  const partOf = (entry: Entry, running: Running): ModulePart => {
    let part = parts.get(running)
    if (part === undefined) {
      part = {
        moduleId: entry.def.id,
        module: { name: entry.def.id, tools: running.tools, context: (running.instance.context ?? []).map((p) => wrapProvider(entry.def.id, p)) },
        instructions: running.instance.instructions?.trim() ?? ""
      }
      parts.set(running, part)
    }
    return part
  }

  let snapshot: ModuleSnapshot = {
    version: 0,
    registry: makeToolRegistry([]),
    instructions: [],
    toolModules: new Map(),
    agents: new Map(),
    actions: [],
    deciders: new Map(),
    parts: [],
    assistantParts: new Map()
  }
  /** The snapshot of the running instances. Throws on a tool name clash. */
  const buildSnapshot = (): ModuleSnapshot => {
    const mains = entries.flatMap((e) => {
      const r = mainOf(e)?.running
      return r === undefined ? [] : [{ e, r }]
    })
    const toolModules = new Map<string, string>()
    for (const e of entries) for (const r of runningOf(e)) for (const name of toolNames(r.running)) toolModules.set(name, e.def.id)
    const agents = new Map<string, Agent>()
    const deciders = new Map<string, DecisionProvider>()
    for (const { r } of mains) {
      for (const agent of r.instance.agents ?? []) if (!agents.has(agent.id)) agents.set(agent.id, agent)
      for (const decider of r.instance.deciders ?? []) if (!deciders.has(decider.id)) deciders.set(decider.id, decider)
    }
    const mainParts = mains.map(({ e, r }) => partOf(e, r))
    const assistantParts = new Map<string, ReadonlyArray<ModulePart>>()
    for (const e of entries) {
      for (const d of e.demand ?? []) {
        if (assistantParts.has(d.assistantId)) continue
        assistantParts.set(
          d.assistantId,
          entries.flatMap((x) => {
            const r = x.demand === undefined ? mainOf(x)?.running : instanceFor(x, d.assistantId)?.running
            return r === undefined ? [] : [partOf(x, r)]
          })
        )
      }
    }
    return {
      version: snapshot.version + 1,
      registry: makeToolRegistry(mainParts.map((p) => p.module)),
      instructions: mainParts.flatMap((p) => (p.instructions.length > 0 ? [p.instructions] : [])),
      toolModules,
      agents,
      actions: mains.flatMap(({ r }) => r.actions),
      deciders,
      parts: mainParts,
      assistantParts
    }
  }
  const rebuild = () => {
    snapshot = buildSnapshot()
  }

  /**
   * Give each instance of `adds` its started one (and make `instances` the entry's wanted set, when given), checked
   * against the instances of the other modules running NOW (another module may have started meanwhile).
   * Synchronous: nothing else can publish in between. On a clash nothing changes and the message is returned; the
   * caller closes the candidates' scopes.
   */
  const publish = (entry: Entry, adds: ReadonlyArray<readonly [Instance, Running]>, instances?: Map<string, Instance>): string | undefined => {
    for (const [, running] of adds) {
      const names = toolNames(running)
      for (const other of entries) {
        if (other === entry) continue
        for (const r of runningOf(other)) {
          const clash = names.find((n) => toolNames(r.running).includes(n))
          if (clash !== undefined) return `Tool name "${clash}" is already used by module ${other.def.name}`
        }
      }
    }
    const before = { instances: entry.instances, running: adds.map(([rec]) => rec.running) }
    for (const [rec, running] of adds) rec.running = running
    if (instances !== undefined) entry.instances = instances
    try {
      snapshot = buildSnapshot()
    } catch (error) {
      adds.forEach(([rec], i) => {
        rec.running = before.running[i]
      })
      entry.instances = before.instances
      return `The module's tools could not be offered: ${error instanceof Error ? error.message : String(error)}`
    }
    return undefined
  }

  const save = (entry: Entry) =>
    options.persistence.save(entry.def.id, {
      enabled: entry.enabled,
      settings: entry.stored as Record<string, SettingValue>,
      secrets: entry.secrets
    }).pipe(Effect.catchCause((cause) => Effect.logError(`Could not save the settings of module ${entry.def.id}`, cause)))

  /**
   * Close a replaced or stopped instance after the grace period (tool calls in flight finish).
   * The scope is registered for shutdown at once, so an interruption before the timer is forked cannot leak it.
   */
  const retire = (entry: Entry, running: Running) => {
    retired.add(running.scope)
    entry.retiring++
    return Effect.gen(function*() {
      yield* Effect.sleep(graceMs).pipe(
        Effect.andThen(Scope.close(running.scope, Exit.void)),
        Effect.ensuring(Effect.sync(() => {
          retired.delete(running.scope)
          entry.retiring--
          if (entry.instances.size === 0 && entry.retiring === 0 && entry.leaving.size === 0) notify(entry)
        })),
        Effect.forkIn(hostScope)
      )
    })
  }

  /** Retire every leaving instance (their replacements have settled) and publish the snapshot without them. */
  const finishLeaving = (entry: Entry) =>
    Effect.suspend(() => {
      if (entry.leaving.size === 0) return Effect.void
      const leaving = [...entry.leaving]
      entry.leaving.clear()
      rebuild()
      return Effect.forEach(leaving, (r) => (r.running === undefined ? Effect.void : retire(entry, r.running)), { discard: true })
    })

  const describeStartFailure = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.findErrorOption(cause)
    if (error._tag === "Some" && error.value instanceof ModuleStartError) return error.value.message
    return `The module crashed while starting: ${Cause.pretty(cause).split("\n")[0]}`
  }

  /**
   * Start an instance with `settings` and hand the result to `adopt`, which must publish the instance or close its
   * scope. Only the module's own start is interruptible: from the moment it returns until `adopt` has finished the
   * fiber cannot be interrupted, so a started instance is always either published or closed. On every other exit,
   * interruption and a `start` that throws included, the scope is closed here: the cleanup is installed before the
   * module's code runs.
   */
  const startInstance = <A>(entry: Entry, rec: Instance, settings: unknown, adopt: (result: Started) => Effect.Effect<A>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Scope.make(), (scope) =>
        restore(startIn(entry, rec, settings, scope)).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) && exit.value.ok ? Effect.void : Scope.close(scope, Exit.void))),
          Effect.flatMap(adopt)
        )
      )
    )

  /**
   * Several instances started at once, all handed to `adopt` together (which publishes all or closes all). As
   * `startInstance`: a started instance that `adopt` never sees (the starts were interrupted) is closed.
   */
  const startMany = <A>(
    entry: Entry,
    items: ReadonlyArray<{ readonly rec: Instance; readonly settings: unknown }>,
    adopt: (results: ReadonlyArray<Started>) => Effect.Effect<A>
  ) =>
    Effect.uninterruptibleMask((restore) => {
      const opened: Array<Scope.Closeable> = []
      return Effect.forEach(items, ({ rec, settings }) =>
        Effect.flatMap(Scope.make(), (scope) =>
          restore(startIn(entry, rec, settings, scope)).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) && exit.value.ok
                ? Effect.sync(() => {
                  opened.push(scope)
                })
                : Scope.close(scope, Exit.void)
            )
          )), { concurrency: items.length > 1 ? "unbounded" : 1 }).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.forEach(opened, (s) => Scope.close(s, Exit.void), { discard: true }))),
          Effect.flatMap(adopt)
        )
    })

  const closeStarted = (results: ReadonlyArray<Started>) =>
    Effect.forEach(results, (r) => (r.ok ? Scope.close(r.running.scope, Exit.void) : Effect.void), { discard: true })

  const startIn = (entry: Entry, rec: Instance, settings: unknown, scope: Scope.Closeable) =>
    Effect.gen(function*() {
      const generation = ++entry.generation
      let startStatus: StatusLine | undefined
      let started = false
      const setStatus = (status: StatusLine | undefined) => {
        if (!started) {
          startStatus = status
        } else if (rec.running?.generation === generation) {
          rec.status = status
          scheduleStatus(entry)
        }
      }
      const exit = yield* Effect.suspend(() => entry.def.start({ settings: settings as never, setStatus })).pipe(
        Scope.provide(scope),
        Effect.timeoutOrElse({
          duration: startTimeoutMs,
          orElse: () => Effect.fail(new ModuleStartError({ message: `Did not start within ${Math.round(startTimeoutMs / 1000)} s` }))
        }),
        Effect.exit
      )
      // The scope is closed by the caller for every result that is not ok.
      const fail = (message: string): Effect.Effect<Started> => Effect.succeed({ ok: false, message })
      if (Exit.isFailure(exit)) return yield* fail(describeStartFailure(exit.cause))
      const instance = exit.value
      let contributed: ReturnType<typeof contributionsOf>
      try {
        contributed = contributionsOf(entry.def.id, instance)
      } catch (error) {
        return yield* fail(`The module's actions could not be offered as tools: ${String(error)}`)
      }
      const actionIds = contributed.actions.map((a) => a.id)
      const duplicateAction = actionIds.find((n, i) => actionIds.indexOf(n) !== i)
      if (duplicateAction !== undefined) return yield* fail(`The module declares the action "${duplicateAction}" twice`)
      const names = toolNames(contributed)
      const duplicate = names.find((n, i) => names.indexOf(n) !== i)
      if (duplicate !== undefined) return yield* fail(`The module declares the tool "${duplicate}" twice`)
      // Core always words a confirmation question itself (after the final review): a module's own text is ignored.
      for (const a of contributed.actions) {
        if (typeof a.definition.confirm === "function") {
          yield* Effect.logWarning(
            `Module ${entry.def.id}, action "${a.definition.id}": its own confirmation text is ignored; the assistant asks its own question from the action's label and values`
          )
        }
      }
      // Clashes with other modules are checked by `publish`, against the modules running then.
      started = true
      return { ok: true, running: { scope, instance, generation, ...contributed }, status: startStatus } satisfies Started
    })

  /** Start the instance `rec` of `group` on its own (enable, retry, startup, a new assistant). It is already wanted. */
  const startOne = (entry: Entry, group: Group, rec: Instance, isNew: boolean): Effect.Effect<HostResult> =>
    Effect.gen(function*() {
      const resolved = group.resolved
      if (resolved.value === undefined) {
        rec.state = "error"
        rec.error = `The settings are not valid: ${resolved.form.errors.map((e) => e.message).join("; ")}`
        notify(entry)
        return failure("invalid_settings", rec.error, { moduleId: entry.def.id, fieldErrors: resolved.form.errors })
      }
      const before = { state: rec.state, error: rec.error }
      rec.state = "starting"
      rec.error = undefined
      notify(entry)
      const startFailed = (message: string): HostResult => {
        rec.state = "error"
        rec.error = message
        notify(entry)
        return failure("module_start_failed", message, { moduleId: entry.def.id })
      }
      let adopted = false
      // Runs uninterruptibly once the start has returned: publish, or close.
      const adopt = (result: Started): Effect.Effect<HostResult> => {
        adopted = true
        if (!result.ok) return Effect.succeed(startFailed(result.message))
        if (entry.instances.get(rec.key) !== rec) {
          // No longer wanted while it started (only possible at shutdown races): do not keep it.
          return Effect.as(Scope.close(result.running.scope, Exit.void), OK).pipe(Effect.tap(() => Effect.sync(() => notify(entry))))
        }
        const clash = publish(entry, [[rec, result.running]])
        if (clash !== undefined) return Effect.as(Scope.close(result.running.scope, Exit.void), startFailed(clash))
        rec.status = result.status
        rec.state = "running"
        notify(entry)
        return Effect.succeed(OK)
      }
      return yield* startInstance(entry, rec, resolved.value, adopt).pipe(
        // Cancelled during the module's start (shutdown, the caller gave up): the scope is already closed; back to how
        // it was (a new instance is not wanted any more). An interruption that arrives once the result was adopted
        // changes nothing: that outcome stands.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (adopted) return
            if (isNew) {
              if (entry.instances.get(rec.key) === rec) entry.instances.delete(rec.key)
            } else {
              rec.state = before.state
              rec.error = before.error
            }
            notify(entry)
          })
        )
      )
    })

  /**
   * Bring the instances in line with `groupsOf`: start the wanted ones that are missing (and, with `retry`, the ones
   * in error), and retire those no longer wanted, once the starts have settled (a replaced instance keeps serving
   * until then). Returns the first failure of the starts, if any, and whether anything changed.
   */
  const reconcile = (entry: Entry, retry: boolean): Effect.Effect<{ readonly result: HostResult; readonly changed: boolean }> =>
    Effect.suspend(() => {
      const groups = groupsOf(entry)
      const next = new Map<string, Instance>()
      const starts: Array<{ readonly group: Group; readonly rec: Instance; readonly isNew: boolean }> = []
      let changed = false
      for (const group of groups) {
        let rec = entry.instances.get(group.key)
        if (rec === undefined) {
          // Wanted again while it was being replaced: it serves on.
          rec = [...entry.leaving].find((r) => r.key === group.key)
          if (rec !== undefined) entry.leaving.delete(rec)
        }
        if (rec === undefined) {
          rec = newInstance(group)
          starts.push({ group, rec, isNew: true })
        } else {
          if (rec.users.join("\n") !== group.users.join("\n") || rec.ownKeys.join("\n") !== group.ownKeys.join("\n")) changed = true
          rec.users = group.users
          rec.ownKeys = group.ownKeys
          if (retry && rec.state === "error") starts.push({ group, rec, isNew: false })
        }
        next.set(group.key, rec)
      }
      for (const r of entry.instances.values()) {
        if (next.has(r.key)) continue
        changed = true
        if (r.running !== undefined) entry.leaving.add(r)
      }
      entry.instances = next
      if (starts.length > 0) changed = true
      if (changed) rebuild()
      return Effect.forEach(starts, ({ group, isNew, rec }) => startOne(entry, group, rec, isNew), { concurrency: starts.length > 1 ? "unbounded" : 1 }).pipe(
        Effect.ensuring(finishLeaving(entry)),
        Effect.map((results) => ({ result: results.find((r) => !r.ok) ?? OK, changed }))
      )
    })

  /** Run `op` unless another operation on the same module is in progress. A deferred refresh runs after it. */
  const exclusive = (id: string, op: (entry: Entry) => Effect.Effect<HostResult>): Effect.Effect<HostResult> =>
    Effect.suspend(() => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed(failure("unknown_module", `There is no module "${id}"`, {}))
      if (entry.busy) {
        return Effect.succeed(failure("busy", `${entry.def.name} is still applying the previous change; try again in a moment`, { moduleId: id }))
      }
      entry.busy = true
      return op(entry).pipe(Effect.ensuring(Effect.suspend(() => {
        entry.busy = false
        if (!entry.dirty) return Effect.void
        entry.dirty = false
        return Effect.asVoid(Effect.forkIn(refreshEntry(entry), hostScope))
      })))
    })

  /** Bring one module in line (refresh), now, or after the operation that holds it. */
  const refreshEntry = (entry: Entry): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entry.busy) {
        entry.dirty = true
        return Effect.void
      }
      return Effect.asVoid(exclusive(entry.def.id, (e) =>
        Effect.map(reconcile(e, false), ({ changed, result }) => {
          if (changed) notify(e)
          return result
        })))
    })

  /** Read the demand (when there is one). */
  const readDemand = () => {
    if (options.demand === undefined) return
    const demand = options.demand()
    for (const entry of entries) entry.demand = demand.get(entry.def.id)
  }

  const notAllowed = (entry: Entry): HostResult =>
    failure("not_allowed", `${entry.def.name} is switched on and off per assistant (the assistant's Modules tab).`, { moduleId: entry.def.id })

  const enable = (id: string) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        if (entry.demand !== undefined) return notAllowed(entry)
        entry.enabled = true
        entry.chosen = true
        if (mainOf(entry) !== undefined) {
          yield* save(entry)
          notify(entry)
          return OK
        }
        const { result } = yield* reconcile(entry, true)
        yield* save(entry)
        return result
      }))

  const disable = (id: string) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        if (entry.demand !== undefined) return notAllowed(entry)
        entry.enabled = false
        entry.chosen = true
        yield* reconcile(entry, false)
        yield* save(entry)
        notify(entry)
        return OK
      }))

  const configure = (id: string, patch: SettingsPatch, configureOptions: { readonly includeHidden?: boolean } = {}) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        const patched = applySettingsPatch(
          entry.def.settings,
          { stored: entry.stored, secrets: entry.secrets, env: options.env, ...envOrigin, ...linked(entry) },
          patch,
          configureOptions
        )
        if (!patched.ok) {
          return failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: patched.errors })
        }
        if (![...entry.instances.values()].some((r) => r.running !== undefined)) {
          entry.stored = patched.stored
          entry.secrets = patched.secrets
          yield* save(entry)
          if ([...entry.instances.values()].some((r) => r.state === "error")) return (yield* reconcile(entry, true)).result
          notify(entry)
          return OK
        }
        const groups = groupsOf(entry, patched.stored, patched.secrets)
        const invalid = groups.find((g) => g.resolved.value === undefined)
        if (invalid !== undefined) {
          return failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: invalid.resolved.form.errors })
        }
        // An instance whose effective settings stay the same keeps running (a new secret restarts every one).
        const secretsChanged = Object.keys(patch.secrets).length > 0
        const next = new Map<string, Instance>()
        const fresh: Array<{ readonly rec: Instance; readonly settings: unknown; readonly group: Group }> = []
        for (const group of groups) {
          const existing = entry.instances.get(group.key)
          if (existing?.running !== undefined && !secretsChanged) {
            next.set(group.key, existing)
            continue
          }
          const rec = newInstance(group)
          next.set(group.key, rec)
          fresh.push({ rec, settings: group.resolved.value, group })
        }
        const replaced = [...entry.instances.values()].filter((r) => next.get(r.key) !== r)
        // The old instances keep serving while the new ones start. Publication, the new settings and the old
        // instances' retirement happen together, uninterruptibly; if one start fails, nothing changes.
        const adopted = yield* startMany(entry, fresh, (results): Effect.Effect<HostResult | undefined> => {
          const failed = results.find((r): r is Extract<Started, { ok: false }> => !r.ok)
          if (failed !== undefined) return Effect.as(closeStarted(results), failure("module_start_failed", failed.message, { moduleId: id }))
          const adds = results.map((r, i) => [fresh[i]!.rec, (r as Extract<Started, { ok: true }>).running] as const)
          const clash = publish(entry, adds, next)
          if (clash !== undefined) return Effect.as(closeStarted(results), failure("module_start_failed", clash, { moduleId: id }))
          results.forEach((r, i) => {
            const rec = fresh[i]!.rec
            rec.state = "running"
            rec.status = r.ok ? r.status : undefined
          })
          for (const group of groups) {
            const rec = next.get(group.key)!
            rec.users = group.users
            rec.ownKeys = group.ownKeys
          }
          entry.stored = patched.stored
          entry.secrets = patched.secrets
          rebuild()
          return Effect.as(
            Effect.forEach(replaced, (r) => (r.running === undefined ? Effect.void : retire(entry, r.running)), { discard: true }),
            undefined
          )
        })
        if (adopted !== undefined) return adopted
        yield* save(entry)
        notify(entry)
        return OK
      }))

  // Evaluated when run: a module switched on by `setSecrets` before this runs is included (and started once).
  const startEnabled = Effect.suspend(() => {
    readDemand()
    // A module another operation holds is brought in line when that operation ends.
    for (const e of entries) if (e.busy) e.dirty = true
    return Effect.forEach(
      entries.filter((e) => !e.busy),
      (entry) => exclusive(entry.def.id, (e) => Effect.map(reconcile(e, true), ({ result }) => result)),
      { concurrency: "unbounded", discard: true }
    )
  })

  const refresh = Effect.suspend(() => {
    readDemand()
    return Effect.forEach(entries, refreshEntry, { concurrency: "unbounded", discard: true })
  })

  // Shutdown: close every instance at once (no grace).
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...entries.flatMap((e) => runningOf(e).map((r) => r.running!.scope)), ...retired],
      (scope) => Scope.close(scope, Exit.void),
      { concurrency: "unbounded", discard: true }
    )
  )

  const fieldAction = (id: string, key: string): Effect.Effect<FieldActionHostResult> =>
    Effect.suspend((): Effect.Effect<FieldActionHostResult> => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed({ ok: false, code: "unknown_module", message: `There is no module "${id}"` } as const)
      const instance = mainOf(entry)?.running?.instance
      if (instance === undefined) return Effect.succeed({ ok: false, code: "not_running", message: `${entry.def.name} is not running` } as const)
      const own = instance.fieldActions?.[key]
      const handler = own ?? (key === "test" ? generatedTest(instance) : undefined)
      if (handler === undefined) return Effect.succeed({ ok: false, code: "unknown_action", message: `${entry.def.name} has no action "${key}"` } as const)
      // Suspended: a handler that throws is reported like one that fails.
      return Effect.suspend(handler).pipe(
        Effect.catchCause((cause) => Effect.succeed<FieldActionResult>({ ok: false, text: `Failed: ${Cause.pretty(cause).split("\n")[0]}`.slice(0, 500), tone: "error" })),
        Effect.map((result) => ({ ok: true, result }) as const)
      )
    })

  const setSecrets = (all: Readonly<Record<string, Readonly<Record<string, string>>>>) =>
    Effect.suspend(() => {
      const switchedOn = new Set<Entry>()
      for (const entry of entries) {
        const next = all[entry.def.id] ?? {}
        if (JSON.stringify(next) === JSON.stringify(entry.secrets)) continue
        entry.secrets = next
        // A key that now counts (the vault was unlocked) switches on a module the owner has not chosen for.
        if (entry.demand === undefined && !entry.chosen && !entry.busy && entry.instances.size === 0 && stateOf(entry).state === "disabled") {
          const wanted = defaultIntent(entry)
          if (wanted && !entry.enabled) switchedOn.add(entry)
          entry.enabled = wanted
        }
        notify(entry)
      }
      return Effect.forEach(
        entries.filter((e) => !e.busy && (switchedOn.has(e) || [...e.instances.values()].some((r) => r.state === "error"))),
        (entry) => exclusive(entry.def.id, (e) => Effect.map(reconcile(e, true), ({ result }) => result)),
        { concurrency: "unbounded", discard: true }
      )
    })

  const checkOwn = (id: string, own: Readonly<Record<string, unknown>>): ReadonlyArray<FieldError> => {
    const entry = byId.get(id)
    if (entry === undefined) return [{ key: null, message: `There is no module "${id}"` }]
    return checkOwnValues(entry.def.settings, own)
  }

  return {
    fieldAction,
    setSecrets,
    snapshot: () => snapshot,
    modules: () => entries.map(info),
    startEnabled,
    enable,
    disable,
    configure,
    refresh,
    checkOwn,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } satisfies ModuleHost as ModuleHost
})

// ---------------------------------------------------------------------------
// Generated "Test" buttons

const TEST_TIMEOUT_MS = 30_000

const quote = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s)

/** The generated `test` field action of an agent or decision-provider instance, if it is one. */
const generatedTest = (instance: ModuleInstance): (() => Effect.Effect<FieldActionResult>) | undefined => {
  const agent = instance.agents?.[0]
  if (agent !== undefined) return () => testAgent(agent)
  const decider = instance.deciders?.[0]
  if (decider !== undefined) return () => testDecider(decider)
  return undefined
}

/** One turn outside the conversation: "Say hello in five words.", no history, no tools, already committed. */
export const testAgent = (agent: Agent): Effect.Effect<FieldActionResult> =>
  Effect.gen(function*() {
    const start = yield* Clock.currentTimeMillis
    let first: number | undefined
    let text = ""
    const trace = { id: 0, mode: "text" as const, speculative: false, startedAt: start, marks: {}, tools: [], voices: [] }
    const exit = yield* Stream.suspend(() => agent.turn({
      turnId: 0,
      text: "Say hello in five words.",
      conversationId: "agent-test",
      utterance: "Say hello in five words.",
      source: "text",
      spoken: false,
      routedBy: "explicit",
      history: [],
      system: agent.systemPrompt ?? "You are a voice assistant. Answer in one short sentence.",
      context: undefined,
      tools: makeToolRegistry([]),
      actions: [],
      deciders: new Map(),
      promoted: Effect.void,
      speculative: false,
      mark: () => {},
      trace,
      maxToolRounds: 0
    })).pipe(
      Stream.runForEach((event) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            if (event._tag !== "TextDelta" || event.text.trim().length === 0) return
            first ??= now
            text += event.text
          }))
      ),
      Effect.timeoutOrElse({ duration: TEST_TIMEOUT_MS, orElse: () => Effect.fail(new Error(`no answer within ${TEST_TIMEOUT_MS / 1000} s`)) }),
      Effect.exit
    )
    const end = yield* Clock.currentTimeMillis
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)
      const message = error._tag === "Some" && error.value instanceof Error ? error.value.message : Cause.pretty(exit.cause).split("\n")[0]
      return { ok: false, text: `Failed after ${end - start} ms: ${message}`.slice(0, 500), tone: "error" }
    }
    if (first === undefined) return { ok: false, text: `Done after ${end - start} ms without saying anything.`, tone: "warning" }
    return { ok: true, text: `First text after ${first - start} ms, done after ${end - start} ms: '${quote(text.trim())}'`.slice(0, 500), tone: "ok" }
  })

const testActions = registerActions("test", [
  defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room.",
    params: {
      room: Param.choice({ label: "Room", options: [{ value: "kitchen", label: "Kitchen" }, { value: "living_room", label: "Living room" }] })
    },
    run: () => Effect.void
  }),
  defineAction({ id: "time_now", label: "Tell the time", description: "Say what time it is now.", params: {}, speculative: true, run: () => Effect.void })
])

/** A fixed two-action request: round trip and answer. */
export const testDecider = (decider: DecisionProvider): Effect.Effect<FieldActionResult> =>
  Effect.gen(function*() {
    const plan = buildDecisionPlan({ utterance: "Turn on the kitchen lights", actions: testActions })
    const start = yield* Clock.currentTimeMillis
    const exit = yield* Effect.suspend(() => decider.decide(plan.request)).pipe(
      Effect.timeoutOrElse({ duration: TEST_TIMEOUT_MS, orElse: () => Effect.fail(new Error("no answer")) }),
      Effect.exit
    )
    const ms = (yield* Clock.currentTimeMillis) - start
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)
      const message = error._tag === "Some" && error.value instanceof Error ? error.value.message : "failed"
      return { ok: false, text: `Failed after ${ms} ms: ${message}`.slice(0, 500), tone: "error" }
    }
    const action = exit.value.answers["action"]
    const room = exit.value.answers["test.lights_on/room"]
    const describe = (a: typeof action) =>
      a === undefined ? "no answer" : a.type === "choice" ? `${a.choice} (${Math.round((a.probabilities[a.choice] ?? 0) * 100)} %)` : `${Math.round(a.value * 100)} %`
    return { ok: true, text: `Answered in ${ms} ms: action ${describe(action)}, room ${describe(room)}.`, tone: "ok" }
  })
