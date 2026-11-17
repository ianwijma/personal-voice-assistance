import type { ErrorInfo, ModuleInfo, ModuleState, SettingsPatch, SettingValue, StatusLine } from "@pva/protocol"
import { Cause, Clock, Effect, Exit, Scope, Stream } from "effect"
import { actionTool, defineAction, Param, type RegisteredAction, registerActions } from "./Actions.ts"
import type { Agent } from "./Agent.ts"
import { buildDecisionPlan, type DecisionProvider } from "./Decision.ts"
import type { AssistantModule, ContextProvider, Tool } from "./Module.ts"
import type { FieldActionResult } from "./ModuleContributions.ts"
import { type ModuleDefinition, type ModuleInstance, ModuleStartError } from "./ModuleDefinition.ts"
import { applySettingsPatch, resolveSettings } from "./Settings.ts"
import { makeToolRegistry, type ToolRegistry } from "./ToolRegistry.ts"

/**
 * The module host (docs/UI-AND-MODULES.md §1.4): owns every module of the
 * catalog for the life of the process. It starts enabled modules, enables,
 * disables and reconfigures them while the assistant runs, and publishes an
 * immutable snapshot (tool registry + instructions) that each turn reads once
 * at its start. Persistence is injected, so the host has no Node dependency.
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
  /** Module tools plus one generated tool per action (unless the action says `offerAsTool: false`). */
  readonly registry: ToolRegistry["Service"]
  readonly instructions: ReadonlyArray<string>
  /** Tool name → id of the module that contributes it (generated action tools included). */
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
}

/** One running module's share of a `ModuleSnapshot`. */
export interface ModulePart {
  readonly moduleId: string
  /** `name` is the module id. */
  readonly module: AssistantModule
  readonly instructions: string
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
  /** Start every module whose intent is on, concurrently; completes when all have settled. */
  readonly startEnabled: Effect.Effect<void>
  readonly enable: (id: string) => Effect.Effect<HostResult>
  readonly disable: (id: string) => Effect.Effect<HostResult>
  /** `includeHidden`: also save fields hidden by `visibleWhen` (moving values out of `.env`). */
  readonly configure: (id: string, patch: SettingsPatch, options?: { readonly includeHidden?: boolean }) => Effect.Effect<HostResult>
  /**
   * Replace every module's saved secrets without saving them (the app's key vault was unlocked or locked; a module
   * missing from `secrets` has none). Modules whose secrets changed are announced; enabled modules in `error` are
   * started again (a start that failed for lack of a key). Running modules keep running with what they started with.
   * Completes when those starts have settled.
   */
  readonly setSecrets: (secrets: Readonly<Record<string, Readonly<Record<string, string>>>>) => Effect.Effect<void>
  /** Called with a module's new info whenever it changes (state, settings, status). Returns an unsubscribe function. */
  readonly subscribe: (listener: (info: ModuleInfo) => void) => () => void
  /**
   * Press an `action` field of a running module: its own `fieldActions[key]`,
   * or the generated `test` of an agent or decision provider (docs/AGENTS-AND-INTENTS.md §1.6).
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
  /** Time a replaced or disabled instance keeps running for tool calls in flight. Default 10 s. */
  readonly graceMs?: number
  /** Time a context provider may take per turn. Default 50 ms. */
  readonly contextTimeoutMs?: number
}

interface Running {
  readonly scope: Scope.Closeable
  readonly instance: ModuleInstance
  readonly generation: number
  /** The instance's tools plus the generated action tools. */
  readonly tools: ReadonlyArray<Tool>
  readonly actions: ReadonlyArray<RegisteredAction>
}

interface Entry {
  readonly def: ModuleDefinition<any>
  enabled: boolean
  state: ModuleState
  error: string | undefined
  status: StatusLine | undefined
  stored: Readonly<Record<string, unknown>>
  secrets: Readonly<Record<string, string>>
  /** The owner has chosen on or off (saved); before that, `enabledByDefault` / `enabledWhenSet` decide. */
  chosen: boolean
  running: Running | undefined
  busy: boolean
  revision: number
  generation: number
}

const failure = (code: ErrorInfo["code"], message: string, extra: Partial<ErrorInfo> = {}): HostResult => ({
  ok: false,
  error: { code, message, ...extra }
})

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
      state: "disabled",
      error: undefined,
      status: undefined,
      stored: record?.settings ?? {},
      secrets: options.persistence.initial.secrets[def.id] ?? {},
      running: undefined,
      busy: false,
      revision: 0,
      generation: 0
    }
  })
  const byId = new Map(entries.map((e) => [e.def.id, e]))
  const envOrigin = {
    ...(options.envOrigin !== undefined ? { envOrigin: options.envOrigin } : {}),
    ...(options.envLocation !== undefined ? { envLocation: options.envLocation } : {})
  }

  const resolve = (entry: Entry, stored = entry.stored, secrets = entry.secrets) =>
    resolveSettings(entry.def.settings, { stored, secrets, env: options.env, ...envOrigin })

  /** Before the owner has chosen: on by default, or on once the `enabledWhenSet` key is set (environment or saved). */
  const defaultIntent = (entry: Entry): boolean => {
    const key = entry.def.enabledWhenSet
    if (entry.def.enabledByDefault || key === undefined) return entry.def.enabledByDefault
    return resolve(entry).form.secrets[key]?.set === true
  }
  for (const entry of entries) if (!entry.chosen) entry.enabled = defaultIntent(entry)

  const info = (entry: Entry): ModuleInfo => ({
    id: entry.def.id,
    name: entry.def.name,
    description: entry.def.description,
    enabled: entry.enabled,
    state: entry.state,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.status !== undefined && entry.running !== undefined ? { status: entry.status } : {}),
    tools: (entry.running?.tools ?? []).map((t) => ({ name: t.name, description: t.description, speculative: t.speculative === true })),
    settings: resolve(entry).form,
    revision: entry.revision,
    ...(entry.def.kind !== undefined ? { kind: entry.def.kind } : {})
  })

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

  let snapshot: ModuleSnapshot = {
    version: 0,
    registry: makeToolRegistry([]),
    instructions: [],
    toolModules: new Map(),
    agents: new Map(),
    actions: [],
    deciders: new Map(),
    parts: []
  }
  /** The snapshot of the running instances, with `candidate` in place of its entry's instance. Throws on a tool name clash. */
  const buildSnapshot = (candidate?: { readonly entry: Entry; readonly running: Running }): ModuleSnapshot => {
    const running = entries.flatMap((e) => {
      const r = candidate?.entry === e ? candidate.running : e.running
      return r === undefined ? [] : [{ e, r }]
    })
    const toolModules = new Map<string, string>()
    for (const { e, r } of running) for (const name of toolNames(r)) toolModules.set(name, e.def.id)
    const agents = new Map<string, Agent>()
    const deciders = new Map<string, DecisionProvider>()
    for (const { r } of running) {
      for (const agent of r.instance.agents ?? []) if (!agents.has(agent.id)) agents.set(agent.id, agent)
      for (const decider of r.instance.deciders ?? []) if (!deciders.has(decider.id)) deciders.set(decider.id, decider)
    }
    const parts: Array<ModulePart> = running.map(({ e, r }) => ({
      moduleId: e.def.id,
      module: {
        name: e.def.id,
        tools: r.tools,
        context: (r.instance.context ?? []).map((p) => wrapProvider(e.def.id, p))
      },
      instructions: r.instance.instructions?.trim() ?? ""
    }))
    return {
      version: snapshot.version + 1,
      registry: makeToolRegistry(parts.map((p) => p.module)),
      instructions: parts.flatMap((p) => (p.instructions.length > 0 ? [p.instructions] : [])),
      toolModules,
      agents,
      actions: running.flatMap(({ r }) => r.actions),
      deciders,
      parts
    }
  }
  const rebuild = () => {
    snapshot = buildSnapshot()
  }

  /**
   * Make a started instance the entry's running one, checked against the
   * instances running NOW (another module may have started while this one did).
   * Synchronous: nothing else can publish in between. On a clash nothing changes
   * and the message is returned; the caller closes the candidate's scope.
   */
  const publish = (entry: Entry, running: Running): string | undefined => {
    const names = toolNames(running)
    for (const other of entries) {
      if (other === entry || other.running === undefined) continue
      const clash = names.find((n) => toolNames(other.running).includes(n))
      if (clash !== undefined) return `Tool name "${clash}" is already used by module ${other.def.name}`
    }
    let next: ModuleSnapshot
    try {
      next = buildSnapshot({ entry, running })
    } catch (error) {
      return `The module's tools could not be offered: ${error instanceof Error ? error.message : String(error)}`
    }
    entry.running = running
    snapshot = next
    return undefined
  }

  const save = (entry: Entry) =>
    options.persistence.save(entry.def.id, {
      enabled: entry.enabled,
      settings: entry.stored as Record<string, SettingValue>,
      secrets: entry.secrets
    }).pipe(Effect.catchCause((cause) => Effect.logError(`Could not save the settings of module ${entry.def.id}`, cause)))

  /**
   * Close a replaced or disabled instance after the grace period (tool calls in flight finish).
   * The scope is registered for shutdown at once, so an interruption before the timer is forked cannot leak it.
   */
  const retire = (entry: Entry, running: Running) => {
    retired.add(running.scope)
    return Effect.gen(function*() {
      yield* Effect.sleep(graceMs).pipe(
        Effect.andThen(Scope.close(running.scope, Exit.void)),
        Effect.ensuring(Effect.sync(() => {
          retired.delete(running.scope)
          if (entry.state === "stopping" && entry.running === undefined) {
            entry.state = "disabled"
            notify(entry)
          }
        })),
        Effect.forkIn(hostScope)
      )
    })
  }

  const describeStartFailure = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.findErrorOption(cause)
    if (error._tag === "Some" && error.value instanceof ModuleStartError) return error.value.message
    return `The module crashed while starting: ${Cause.pretty(cause).split("\n")[0]}`
  }

  /**
   * Start an instance with `settings` and hand the result to `adopt`, which
   * must publish the instance or close its scope. Only the module's own start
   * is interruptible: from the moment it returns until `adopt` has finished the
   * fiber cannot be interrupted, so a started instance is always either
   * published or closed (an interruption right after a successful start used to
   * leave it running unpublished). On every other exit, interruption and a
   * `start` that throws included, the scope is closed here: the cleanup is
   * installed before the module's code runs.
   */
  const startInstance = <A>(
    entry: Entry,
    settings: unknown,
    adopt: (result: Effect.Success<ReturnType<typeof startIn>>) => Effect.Effect<A>
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Scope.make(), (scope) =>
        restore(startIn(entry, settings, scope)).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) && exit.value.ok ? Effect.void : Scope.close(scope, Exit.void))),
          Effect.flatMap(adopt)
        )
      )
    )

  const startIn = (entry: Entry, settings: unknown, scope: Scope.Closeable) =>
    Effect.gen(function*() {
      const generation = ++entry.generation
      let startStatus: StatusLine | undefined
      let started = false
      const setStatus = (status: StatusLine | undefined) => {
        if (!started) {
          startStatus = status
        } else if (entry.running?.generation === generation) {
          entry.status = status
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
      // The scope is closed by `startInstance` for every result that is not ok.
      const fail = (message: string) => Effect.succeed({ ok: false as const, message })
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
      return { ok: true as const, running: { scope, instance, generation, ...contributed }, status: startStatus }
    })

  /** Resolve settings and start (enable, retry, startup). Intent is already on. */
  const start = (entry: Entry): Effect.Effect<HostResult> =>
    Effect.gen(function*() {
      const resolved = resolve(entry)
      if (resolved.value === undefined) {
        entry.state = "error"
        entry.error = `The settings are not valid: ${resolved.form.errors.map((e) => e.message).join("; ")}`
        notify(entry)
        return failure("invalid_settings", entry.error, { moduleId: entry.def.id, fieldErrors: resolved.form.errors })
      }
      const before = { state: entry.state, error: entry.error }
      entry.state = "starting"
      entry.error = undefined
      notify(entry)
      const startFailed = (message: string): HostResult => {
        entry.state = "error"
        entry.error = message
        notify(entry)
        return failure("module_start_failed", message, { moduleId: entry.def.id })
      }
      let adopted = false
      // Runs uninterruptibly once the start has returned: publish, or close.
      const adopt = (result: Effect.Success<ReturnType<typeof startIn>>): Effect.Effect<HostResult> => {
        adopted = true
        if (!result.ok) return Effect.succeed(startFailed(result.message))
        if (!entry.enabled) {
          // Disabled while starting (only possible at shutdown races): do not keep it.
          return Effect.as(Scope.close(result.running.scope, Exit.void), { ok: true } as HostResult).pipe(Effect.tap(() =>
            Effect.sync(() => {
              entry.state = "disabled"
              notify(entry)
            })
          ))
        }
        const clash = publish(entry, result.running)
        if (clash !== undefined) return Effect.as(Scope.close(result.running.scope, Exit.void), startFailed(clash))
        entry.status = result.status
        entry.state = "running"
        notify(entry)
        return Effect.succeed({ ok: true })
      }
      return yield* startInstance(entry, resolved.value, adopt).pipe(
        // Cancelled during the module's start (shutdown, the caller gave up): the scope is already closed; back to how
        // it was. An interruption that arrives once the result was adopted changes nothing: that outcome stands.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (adopted) return
            entry.state = before.state
            entry.error = before.error
            notify(entry)
          })
        )
      )
    })

  /** Run `op` unless another operation on the same module is in progress. */
  const exclusive = (id: string, op: (entry: Entry) => Effect.Effect<HostResult>): Effect.Effect<HostResult> =>
    Effect.suspend(() => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed(failure("unknown_module", `There is no module "${id}"`, {}))
      if (entry.busy) {
        return Effect.succeed(failure("busy", `${entry.def.name} is still applying the previous change; try again in a moment`, { moduleId: id }))
      }
      entry.busy = true
      return op(entry).pipe(Effect.ensuring(Effect.sync(() => {
        entry.busy = false
      })))
    })

  const enable = (id: string) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        entry.enabled = true
        entry.chosen = true
        if (entry.running !== undefined) {
          yield* save(entry)
          notify(entry)
          return { ok: true } as HostResult
        }
        const result = yield* start(entry)
        yield* save(entry)
        return result
      }))

  const disable = (id: string) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        entry.enabled = false
        entry.chosen = true
        entry.error = undefined
        const running = entry.running
        if (running !== undefined) {
          entry.running = undefined
          entry.status = undefined
          entry.state = "stopping"
          rebuild()
          yield* retire(entry, running)
        } else if (entry.state !== "stopping") {
          entry.state = "disabled"
        }
        yield* save(entry)
        notify(entry)
        return { ok: true } as HostResult
      }))

  const configure = (id: string, patch: SettingsPatch, configureOptions: { readonly includeHidden?: boolean } = {}) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        const patched = applySettingsPatch(
          entry.def.settings,
          { stored: entry.stored, secrets: entry.secrets, env: options.env, ...envOrigin },
          patch,
          configureOptions
        )
        if (!patched.ok) {
          return failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: patched.errors })
        }
        const old = entry.running
        if (old !== undefined) {
          const resolved = resolve(entry, patched.stored, patched.secrets)
          if (resolved.value === undefined) {
            return failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: resolved.form.errors })
          }
          // The old instance keeps serving while the new one starts. Publication, the
          // new settings and the old instance's retirement happen together, uninterruptibly.
          const adopted = yield* startInstance(entry, resolved.value, (result): Effect.Effect<HostResult | undefined> => {
            if (!result.ok) return Effect.succeed(failure("module_start_failed", result.message, { moduleId: id }))
            const clash = publish(entry, result.running)
            if (clash !== undefined) return Effect.as(Scope.close(result.running.scope, Exit.void), failure("module_start_failed", clash, { moduleId: id }))
            entry.stored = patched.stored
            entry.secrets = patched.secrets
            entry.status = result.status
            return Effect.as(retire(entry, old), undefined)
          })
          if (adopted !== undefined) return adopted
          yield* save(entry)
          notify(entry)
          return { ok: true } as HostResult
        }
        entry.stored = patched.stored
        entry.secrets = patched.secrets
        yield* save(entry)
        if (entry.state === "error" && entry.enabled) return yield* start(entry)
        notify(entry)
        return { ok: true } as HostResult
      }))

  // Evaluated when run: a module switched on by `setSecrets` before this runs is included (and started once).
  const startEnabled = Effect.suspend(() =>
    Effect.forEach(
      entries.filter((e) => e.enabled && e.running === undefined && e.state !== "starting"),
      (entry) => exclusive(entry.def.id, (e) => (e.enabled && e.running === undefined ? start(e) : Effect.succeed({ ok: true } as HostResult))),
      { concurrency: "unbounded", discard: true }
    )
  )

  // Shutdown: close every instance at once (no grace).
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...entries.flatMap((e) => (e.running === undefined ? [] : [e.running.scope])), ...retired], (scope) =>
      Scope.close(scope, Exit.void), { concurrency: "unbounded", discard: true })
  )

  const fieldAction = (id: string, key: string): Effect.Effect<FieldActionHostResult> =>
    Effect.suspend((): Effect.Effect<FieldActionHostResult> => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed({ ok: false, code: "unknown_module", message: `There is no module "${id}"` } as const)
      const instance = entry.running?.instance
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
        if (!entry.chosen && !entry.busy && entry.running === undefined && entry.state === "disabled") {
          const wanted = defaultIntent(entry)
          if (wanted && !entry.enabled) switchedOn.add(entry)
          entry.enabled = wanted
        }
        notify(entry)
      }
      return Effect.forEach(
        entries.filter((e) => e.enabled && !e.busy && (e.state === "error" || switchedOn.has(e))),
        (entry) =>
          exclusive(entry.def.id, (e) =>
            e.enabled && e.running === undefined && (e.state === "error" || e.state === "disabled") ? start(e) : Effect.succeed({ ok: true } as HostResult)),
        { concurrency: "unbounded", discard: true }
      )
    })

  return {
    fieldAction,
    setSecrets,
    snapshot: () => snapshot,
    modules: () => entries.map(info),
    startEnabled,
    enable,
    disable,
    configure,
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
