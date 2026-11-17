import {
  type AssistantTemplate,
  type ChoiceOption,
  type ErrorInfo,
  type FieldError,
  HealthIssue,
  type ModuleInfo,
  type ModuleInstanceInfo,
  type ModuleState,
  type ModuleUnavailable,
  type SettingsPatch,
  type SettingValue,
  type StatusLine
} from "@pva/protocol"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import {
  ACTION_TIMEOUT_MS,
  ActionError,
  type ActionOutcome,
  type ActionParams,
  actionTool,
  actionToolName,
  checkedActionValues,
  defineAction,
  Param,
  type RegisteredAction,
  registerActions
} from "./Actions.ts"
import type { Agent } from "./Agent.ts"
import { buildDecisionPlan, type DecisionProvider } from "./Decision.ts"
import { type ExecutionGateway, type GatewayAccess, type GatewayOptions, isGatewayRefusal, makeExecutionGateway } from "./Gateway.ts"
import { makeIssueRegistry, type IssueRegistry } from "./Issues.ts"
import { type AssistantModule, type ContextProvider, metadataProblem, type Tool, toolMetadata } from "./Module.ts"
import {
  type ActionRunRequest,
  type ActionRunResult,
  type CatalogAction,
  type ContributionKey,
  type HostView,
  type HostViewSource,
  type Issue,
  isOptionalRequirement,
  MODULE_API,
  type ModuleHostApi,
  type ModuleServicesV2,
  type RequirementCheck,
  requirementKey,
  type RequirementStatus,
  type ServiceKey,
  type SharedPart
} from "./ModuleApi.ts"
import type { FieldActionResult } from "./ModuleContributions.ts"
import { type ModuleDefinition, type ModuleInstance, ModuleStartError } from "./ModuleDefinition.ts"
import { applicableOwnValues, applySettingsPatch, checkOwnValues, overridableKeys, type ResolvedSettings, resolveSettings, type SettingsSpec } from "./Settings.ts"
import { CurrentJob, CurrentTurn, type Principal } from "./TurnContext.ts"
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
  /**
   * Actions of the running modules, catalog order, and the stand-ins of an unavailable wanted module's declared
   * actions (they answer with its "not set up" line).
   */
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
  /**
   * The module cannot run on this server (module API v2): the part has no tools, its `instructions` are the one line
   * that says so (`unavailableInstruction`), and `module.intentActions` holds stand-ins of its declared actions for intent
   * agents, which answer with its "not set up" line (`unavailableLine`).
   */
  readonly unavailable?: boolean
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
  /**
   * The `settingOptions` of a running module (its instance with the shared settings): choices known only while it
   * runs, such as the models Claude Code reports at start. `undefined` when the module does not run or gives none.
   */
  readonly settingOptions: (id: string) => Readonly<Record<string, ReadonlyArray<ChoiceOption>>> | undefined
  /**
   * The issue registry (module API v2, §C.5): every module's requirement, availability, start and `health()` issues,
   * plus what the app adds (`core`). Module issues are kept current by the host; `checkHealth` refreshes the rest.
   */
  readonly issues: IssueRegistry
  /**
   * Read `demand` and bring the issues in line with it (an unused module missing a program is a warning, a used one
   * an error, through `uses` too), starting and stopping nothing: `pnpm start doctor`, which judges and never starts.
   */
  readonly evaluate: Effect.Effect<void>
  /**
   * Judge every module's availability again (`requirements`, after the app probed again: "Check again"): a module that
   * became available is started if it is wanted, one that became unavailable is retired with the grace period.
   * Completes when the starts have settled.
   */
  readonly recheck: Effect.Effect<void>
  /**
   * Run every available module's `health()` (5 s each, concurrently; never on a turn) with its shared settings and
   * put what they return in `issues`. A health check that fails or times out is a warning of its own.
   */
  readonly checkHealth: Effect.Effect<void>
  /** The turn's action catalogue (`ModuleHostApi.actions`), for the app and tests. */
  readonly actions: ModuleHostApi["actions"]
  /** The read-only view modules get (`ModuleHostApi.view`). */
  readonly view: () => HostView
  /** A service of a demanded module's `shared` part (`ModuleHostApi.service`). */
  readonly service: ModuleHostApi["service"]
  /** The values contributed under a key (`ModuleHostApi.contributions`). */
  readonly contributions: ModuleHostApi["contributions"]
  /**
   * The execution gateway every registry of this host runs its calls through (`Gateway.ts`); serve mode builds each
   * assistant's registry with it.
   */
  readonly gateway: ExecutionGateway
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
  /** This server's platform (`process.platform`, `process.arch`) for `ModuleDefinition.platforms`. Absent: not judged. */
  readonly platform?: { readonly os: string; readonly arch: string }
  /**
   * The app's judgement of a module's `requires` (synchronous, from its probe cache; never probes itself). Read when
   * the host is made and on `recheck`. Absent: every requirement is `unchecked` (never unavailable for it).
   */
  readonly requirements?: RequirementCheck
  /** The app's half of `HostView` (vault, engines, devices, Home values). Absent: the CLI defaults. */
  readonly view?: HostViewSource
  /**
   * Which modules and tools each assistant has on (serve mode: its module choices and `offTools`): the execution
   * gateway's first two checks, and the turn's action catalogue. Absent: no access checks (the CLI modes).
   */
  readonly access?: GatewayAccess
  /** The gateway's later check (P8: the risk policy). There is no confirmation hook (§2 row 6). */
  readonly gatewayHooks?: Pick<GatewayOptions, "risk">
  /**
   * A call with no turn and no job runs for the local principal (the CLI modes: the person at the terminal). Default:
   * true without `access`, false with it (serve mode: such a call is refused).
   */
  readonly localPrincipal?: boolean
  /**
   * A running module reported that a program it requires failed with ENOENT or EACCES (`reportMissingProgram`): the
   * app marks it missing in its probe cache (synchronously, no probe); the host then judges every module again.
   */
  readonly programMissing?: (tool: string) => void
  /** The issue registry to keep the module issues in (the app adds its own). Default: a new one. */
  readonly issues?: IssueRegistry
  /** Time a module's `health()` may take. Default 5 s. */
  readonly healthTimeoutMs?: number
}

interface Running {
  readonly scope: Scope.Closeable
  readonly instance: ModuleInstance
  /** Which start this is (a counter per module): a status from an older start is ignored. */
  readonly generation: number
  /** The instance's tools plus the generated action tools. */
  readonly tools: ReadonlyArray<Tool>
  readonly actions: ReadonlyArray<RegisteredAction>
  /** The settings it was started with: a restart reuses them (a vault locked since cannot stop it). */
  readonly settings: unknown
}

/**
 * A module's `shared` part (version 2): the generation's shared half. Its settings, and the sources they came from,
 * are kept: a restart of the generation and `settingsFor` read them.
 */
interface SharedRun {
  readonly key: string
  readonly scope: Scope.Closeable
  readonly part: SharedPart<unknown>
  readonly spec: SharedSpec
}

/** The shared settings a shared part starts with: the key is their non-secret values. */
interface SharedSpec {
  readonly key: string
  /** `undefined`: not valid (`errors` says why). */
  readonly settings: Readonly<Record<string, unknown>> | undefined
  readonly errors: ReadonlyArray<FieldError>
  readonly stored: Readonly<Record<string, unknown>>
  readonly secrets: Readonly<Record<string, string>>
}

/** One wanted instance of a module: the settings it runs with, who uses it, and how it is doing. */
interface Instance {
  /** The effective non-secret values (own values applied): equal keys share one instance. */
  readonly key: string
  /** The fields its assistants have their own values for. */
  ownKeys: ReadonlyArray<string>
  /** The assistants that use it (empty for a module without demand). */
  users: ReadonlyArray<string>
  /** Assistants that moved to another instance and use this one until that operation has settled its starts. */
  departing: ReadonlyArray<string>
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
  /** What was last announced about who wants it (a change is announced even when nothing starts or stops). */
  announced: string
  /** The wanted instances of the published generation, by key. */
  instances: Map<string, Instance>
  /** Replaced instances still serving until the operation that replaced them has settled its starts. */
  leaving: Set<Instance>
  /** A shared part withdrawn (demand ended) and retired with the leaving instances. */
  sharedLeaving: SharedRun | undefined
  /** Retirements in their grace period. */
  retiring: number
  busy: boolean
  /** A refresh came while another operation held the module: it runs when that operation ends. */
  dirty: boolean
  /**
   * Secrets the vault reported while an operation held the module (it was locked or unlocked meanwhile): applied when
   * that operation ends, so the operation's own commit cannot overwrite them.
   */
  pendingSecrets: Readonly<Record<string, string>> | undefined
  revision: number
  generation: number
  /** Why it cannot run here (`unavailable`), judged at creation and on `recheck`; `undefined`: it can. */
  unavailable: ModuleUnavailable | undefined
  /** Its requirements as last judged. */
  statuses: ReadonlyArray<RequirementStatus>
  /** The catalogue itself is wrong for it (its `uses` form a cycle): an error, never started. */
  catalogError: string | undefined
  /**
   * A new generation or a restart that failed while the old one kept serving (title and why); cleared when a later
   * one succeeds or the module stops.
   */
  kept: { readonly title: string; readonly message: string } | undefined
  /** The published `shared` part (version 2), while the module is demanded. */
  shared: SharedRun | undefined
  /** Why the `shared` part could not start (no generation runs; the module is in `error`). */
  sharedError: string | undefined
}

/** The instances one set of effective settings asks for. */
interface Group {
  readonly key: string
  readonly ownKeys: Array<string>
  readonly users: Array<string>
  readonly resolved: ResolvedSettings<unknown>
}

type Started = { readonly ok: true; readonly running: Running; readonly status: StatusLine | undefined } | { readonly ok: false; readonly message: string }

/** One instance of a new generation: its settings (`undefined`: not valid) and whether it must start for the switch. */
interface GenerationItem {
  readonly key: string
  readonly ownKeys: ReadonlyArray<string>
  readonly users: ReadonlyArray<string>
  readonly settings: unknown
  readonly invalid?: string
  /** It serves now (or the change was asked for by the owner): the new generation is refused if it fails. */
  readonly required: boolean
}

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const failure = (code: ErrorInfo["code"], message: string, extra: Partial<ErrorInfo> = {}): HostResult => ({
  ok: false,
  error: { code, message, ...extra }
})

const OK: HostResult = { ok: true }

const toolNames = (running: { readonly tools: ReadonlyArray<Tool> } | undefined) => (running?.tools ?? []).map((t) => t.name)

/**
 * The instructions line of a module an assistant has on that cannot run here (module-definition §C.4, option a): the
 * assistant says it is not set up in one sentence instead of improvising, and no tool round is spent on it.
 */
export const unavailableInstruction = (name: string, reason: string): string =>
  `${name} is not set up on this server (${reason.replace(/[.!?]+$/, "")}). If you are asked for anything it does, say so in one sentence; the owner can fix it in the admin page under Diagnostics › Health.`

/** What an unavailable module's declared action answers on the intent path (§C.4): one spoken sentence. */
export const unavailableLine = (name: string, reason: string): string => `${name} is not set up on this server (${reason.replace(/[.!?]+$/, "")}).`

/** An instance's actions, registered under the module id, and its tools plus one generated tool per offered action. */
const contributionsOf = (moduleId: string, instance: ModuleInstance) => {
  const actions = registerActions(moduleId, instance.actions ?? [])
  const generated = actions.filter((a) => a.definition.offerAsTool !== false).map(actionTool)
  return { actions, tools: [...(instance.tools ?? []), ...generated] }
}

/** Module code started by the host runs outside any turn or job, whoever asked for the start (a tool's restart). */
const outsideTurns = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(CurrentTurn, undefined), Effect.provideService(CurrentJob, undefined))

const isWireIssue = Schema.is(HealthIssue)

/** Find every module in a `uses` cycle (Tarjan): id → the cycle, for its error. */
const usesCycles = (catalog: ReadonlyArray<ModuleDefinition<any>>): Map<string, ReadonlyArray<string>> => {
  const ids = new Set(catalog.map((d) => d.id))
  const edges = new Map(catalog.map((d) => [d.id, (d.uses ?? []).filter((u) => ids.has(u))]))
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: Array<string> = []
  const on = new Set<string>()
  const out = new Map<string, ReadonlyArray<string>>()
  let next = 0
  const visit = (v: string) => {
    index.set(v, next)
    low.set(v, next)
    next++
    stack.push(v)
    on.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) {
      const component: Array<string> = []
      let w: string
      do {
        w = stack.pop()!
        on.delete(w)
        component.push(w)
      } while (w !== v)
      if (component.length > 1) {
        const cycle = [...component].reverse()
        for (const id of component) out.set(id, cycle)
      }
    }
  }
  for (const d of catalog) if (!index.has(d.id)) visit(d.id)
  return out
}

export const makeModuleHost = Effect.fnUntraced(function*(options: ModuleHostOptions) {
  const hostScope = yield* Effect.scope
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const graceMs = options.graceMs ?? 10_000
  const contextTimeoutMs = options.contextTimeoutMs ?? 50
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const local = options.localPrincipal ?? options.access === undefined
  const gateway = makeExecutionGateway({
    ...(options.access !== undefined ? { access: options.access } : {}),
    ...options.gatewayHooks,
    withoutPrincipal: local ? "local" : "refuse"
  })
  const issues = options.issues ?? makeIssueRegistry()
  const listeners = new Set<(info: ModuleInfo) => void>()
  /** Scopes in their grace period (closed at once at shutdown). */
  const retired = new Set<Scope.Closeable>()
  /** Scopes started by an operation and not yet published or closed (closed at shutdown). */
  const pending = new Set<Scope.Closeable>()

  const ids = new Set<string>()
  const cycles = usesCycles(options.catalog)
  const entries: Array<Entry> = options.catalog.map((def) => {
    if (ids.has(def.id)) throw new Error(`Two modules have the id "${def.id}"`)
    ids.add(def.id)
    const record = options.persistence.initial.modules[def.id]
    const cycle = cycles.get(def.id)
    return {
      def,
      enabled: record?.enabled ?? def.enabledByDefault,
      chosen: record?.enabled !== undefined,
      stored: record?.settings ?? {},
      secrets: options.persistence.initial.secrets[def.id] ?? {},
      demand: undefined,
      announced: "",
      instances: new Map(),
      leaving: new Set(),
      sharedLeaving: undefined,
      retiring: 0,
      busy: false,
      dirty: false,
      pendingSecrets: undefined,
      revision: 0,
      generation: 0,
      unavailable: undefined,
      statuses: [],
      catalogError: cycle === undefined ? undefined : `Its "uses" form a cycle (${[...cycle, cycle[0]].join(" → ")}), so it cannot start. Fix the module catalogue.`,
      kept: undefined,
      shared: undefined,
      sharedError: undefined
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

  /**
   * Whether the module can run on this server (module API v2): a supported `apiVersion`, a listed platform, and every
   * required requirement met (as the app's probes last judged them). Synchronous; never probes.
   */
  const judge = (entry: Entry): { readonly unavailable: ModuleUnavailable | undefined; readonly statuses: ReadonlyArray<RequirementStatus> } => {
    const def = entry.def
    const api = def.apiVersion ?? 1
    const supports: ReadonlyArray<number> = MODULE_API.supports
    if (!supports.includes(api)) {
      const range = `${Math.min(...supports)}–${Math.max(...supports)}`
      return {
        unavailable: {
          reason: api > MODULE_API.current
            ? `Written for module API ${api}; this assistant supports ${range}. Update the assistant.`
            : `Written for module API ${api}, which this assistant no longer supports (${range}). Update the module.`
        },
        statuses: []
      }
    }
    const platform = options.platform
    if (platform !== undefined && def.platforms !== undefined) {
      const { os, arch } = def.platforms
      if (os !== undefined && os.length > 0 && !os.includes(platform.os)) {
        return { unavailable: { reason: `Runs on ${os.join(" or ")}; this server runs ${platform.os}.` }, statuses: [] }
      }
      if (arch !== undefined && arch.length > 0 && !arch.includes(platform.arch)) {
        return { unavailable: { reason: `Runs on ${arch.join(" or ")} processors; this server has ${platform.arch}.` }, statuses: [] }
      }
    }
    const requires = def.requires ?? []
    const statuses = requires.length === 0 ? [] : options.requirements?.(requires) ?? requires.map((requirement): RequirementStatus => ({
      requirement,
      state: "unchecked",
      detail: "not checked"
    }))
    const missing = statuses.find((st) => st.state === "missing" && !isOptionalRequirement(st.requirement))
    return {
      unavailable: missing === undefined ? undefined : { reason: missing.detail, ...(missing.fix !== undefined ? { fix: missing.fix } : {}) },
      statuses
    }
  }
  for (const entry of entries) {
    const judged = judge(entry)
    entry.unavailable = judged.unavailable
    entry.statuses = judged.statuses
  }

  /** Someone wants the module now (its saved switch, or an assistant has it on). */
  const wanted = (entry: Entry) => (entry.demand === undefined ? entry.enabled : entry.demand.length > 0)

  /**
   * The modules demand reaches: every wanted one, and (transitively) what they name in `uses`. A module that cannot
   * run here is reached (its own requirements matter) but does not run, so its `uses` are not followed.
   */
  const reached = (): Set<Entry> => {
    const out = new Set<Entry>()
    const stack = entries.filter((e) => e.catalogError === undefined && wanted(e))
    while (stack.length > 0) {
      const e = stack.pop()!
      if (out.has(e)) continue
      out.add(e)
      if (e.unavailable !== undefined || e.catalogError !== undefined) continue
      for (const id of e.def.uses ?? []) {
        const used = byId.get(id)
        if (used !== undefined && used.catalogError === undefined && !out.has(used)) stack.push(used)
      }
    }
    return out
  }

  /** Demanded (§4 P1): wanted, or named in `uses` by a demanded module; and able to run. Its shared part runs. */
  const isDemanded = (target: Entry): boolean => target.unavailable === undefined && target.catalogError === undefined && reached().has(target)

  /** The modules `entry` names in `uses` that are in the catalogue (it starts after their shared parts). */
  const providersOf = (entry: Entry): ReadonlyArray<Entry> =>
    entry.catalogError !== undefined ? [] : (entry.def.uses ?? []).flatMap((id) => {
      const used = byId.get(id)
      return used === undefined ? [] : [used]
    })

  /** The module's own issues (source `module:<id>`): requirements, unavailable, a failed start or restart. */
  const moduleIssues = (entry: Entry, demandedNow: ReadonlySet<Entry> = reached()): ReadonlyArray<Issue> => {
    const id = entry.def.id
    const name = entry.def.name
    const out: Array<Issue> = []
    // An error only for a module that would run (someone wants it, directly or through `uses`): an unused module
    // missing a program does not fail `doctor`.
    const severity = demandedNow.has(entry) ? "error" : "warning"
    const unused = severity === "warning" && entry.demand !== undefined ? " (No assistant has it on.)" : ""
    const page = { kind: "link", label: `Open ${name}`, value: `#settings/shared/modules/${id}` } as const
    if (entry.catalogError !== undefined) {
      out.push({ id: `${id}.uses`, module: id, severity: "error", title: `${name} cannot start`, detail: entry.catalogError })
    }
    for (const st of entry.statuses) {
      if (st.state !== "missing") continue
      const r = st.requirement
      const why = "why" in r && r.why !== undefined ? r.why : undefined
      out.push({
        id: `${id}.requires.${requirementKey(r)}`,
        module: id,
        severity: isOptionalRequirement(r) ? "warning" : severity,
        title: st.detail,
        detail: `${name} ${isOptionalRequirement(r) ? "can use it" : "needs it"}${why === undefined ? "." : `: ${why}${/[.!?]$/.test(why) ? "" : "."}`}${isOptionalRequirement(r) ? "" : unused}`,
        ...(st.fix !== undefined ? { fix: st.fix } : {})
      })
    }
    if (entry.unavailable !== undefined && out.length === 0) {
      out.push({
        id: `${id}.unavailable`,
        module: id,
        severity,
        title: `${name} cannot run on this server`,
        detail: `${entry.unavailable.reason}${unused}`,
        ...(entry.unavailable.fix !== undefined ? { fix: entry.unavailable.fix } : {})
      })
    }
    const { state, error } = stateOf(entry)
    if (state === "error" && entry.catalogError === undefined) {
      out.push({ id: `${id}.start`, module: id, severity: "error", title: `${name} could not start`, detail: error ?? "", fix: page })
    }
    if (entry.kept !== undefined) {
      out.push({ id: `${id}.restart`, module: id, severity: "warning", title: entry.kept.title, detail: `It keeps running as it was. ${entry.kept.message}`, fix: page })
    }
    return normaliseIssues(entry, out)
  }

  /** Every module's issues again (after a change of demand: the severity of the modules it reaches changes too). */
  const refreshIssues = () => {
    const demandedNow = reached()
    for (const entry of entries) issues.set(`module:${entry.def.id}`, moduleIssues(entry, demandedNow))
  }

  /** The groups of effective settings the module should run with now (or with `stored`/`secrets`, a change being made). */
  const groupsOf = (entry: Entry, stored = entry.stored, secrets = entry.secrets): Array<Group> => {
    // A module that cannot run here is never started (it is `unavailable`, not `error`).
    if (entry.unavailable !== undefined || entry.catalogError !== undefined) return []
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

  const newInstance = (group: { readonly key: string; readonly ownKeys: ReadonlyArray<string>; readonly users: ReadonlyArray<string> }): Instance => ({
    key: group.key,
    ownKeys: [...group.ownKeys],
    users: [...group.users],
    departing: [],
    state: "starting",
    error: undefined,
    status: undefined,
    running: undefined
  })

  const invalidMessage = (errors: ReadonlyArray<FieldError>) => `The settings are not valid: ${errors.map((e) => e.message).join("; ")}`

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
    for (const r of entry.instances.values()) if (r.running !== undefined && r.departing.includes(assistantId)) return r
    return undefined
  }

  /**
   * The module's state from its instances and its shared part: `error` when one fails, `starting` while one starts,
   * `running` while one runs or (no instance: demanded only through `uses`) while its shared part runs.
   */
  const stateOf = (entry: Entry): { readonly state: ModuleState; readonly error?: string } => {
    if (entry.catalogError !== undefined) return { state: "error", error: entry.catalogError }
    if (entry.unavailable !== undefined) return { state: "unavailable" }
    const all = [...entry.instances.values()]
    if (entry.sharedError !== undefined && entry.shared === undefined) return { state: "error", error: entry.sharedError }
    if (all.length === 0) {
      if (entry.shared !== undefined) return { state: "running" }
      return { state: entry.retiring > 0 || entry.leaving.size > 0 ? "stopping" : "disabled" }
    }
    if (all.some((r) => r.state === "starting")) return { state: "starting" }
    const failed = all.find((r) => r.state === "error")
    if (failed === undefined) return { state: "running" }
    const message = failed.error ?? "The module could not start"
    return { state: "error", error: all.length === 1 || failed.users.length === 0 ? message : `${message} (for ${failed.users.join(", ")})` }
  }

  /** It runs in some form: an instance, or its shared part (`health()`'s `running`). */
  const isRunning = (entry: Entry) => mainOf(entry) !== undefined || entry.shared !== undefined

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
      tools: [...tools.values()].map((t) => {
        const { risk, ...meta } = toolMetadata(t)
        return { name: t.name, description: t.description, speculative: t.speculative === true, ...(risk !== undefined ? { risk } : {}), ...meta, risks: [...meta.risks] }
      }),
      settings: resolve(entry).form,
      revision: entry.revision,
      ...(entry.def.kind !== undefined ? { kind: entry.def.kind } : {}),
      ...(entry.demand !== undefined ? { instances: [...entry.instances.values()].map(instanceInfo) } : {}),
      ...(entry.unavailable !== undefined ? { unavailable: entry.unavailable } : {}),
      ...(entry.def.version !== undefined ? { version: entry.def.version } : {}),
      ...(entry.def.apiVersion !== undefined ? { apiVersion: entry.def.apiVersion } : {}),
      ...(entry.def.templates !== undefined && entry.def.templates.length > 0 ? { templates: templatesOf(entry) } : {})
    }
  }

  const templatesOf = (entry: Entry): Array<AssistantTemplate> =>
    (entry.def.templates ?? []).map((t) => ({
      id: `${entry.def.id}.${t.id}`,
      name: t.name,
      prompt: t.prompt,
      ...(t.purpose !== undefined ? { purpose: t.purpose } : {}),
      ...(t.handles !== undefined ? { handles: t.handles } : {}),
      modules: [...(t.modules ?? [entry.def.id])],
      ...(t.suggestedPhrases !== undefined ? { suggestedPhrases: [...t.suggestedPhrases] } : {})
    }))

  const notify = (entry: Entry) => {
    entry.revision++
    issues.set(`module:${entry.def.id}`, moduleIssues(entry))
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

  /**
   * The part of a module that cannot run here but is wanted (C.4 option a): no tools, one instructions line so the
   * conversational model says it is not set up instead of improvising, and stand-ins of its declared actions so an
   * intent agent still recognises them and answers with the module's "not set up" line instead of running some other
   * action. Made once per reason, so the cached prompt prefix changes only when availability changes.
   */
  const unavailableParts = new Map<Entry, ModulePart>()
  const unavailablePartOf = (entry: Entry, unavailable: ModuleUnavailable): ModulePart => {
    const line = unavailableInstruction(entry.def.name, unavailable.reason)
    let part = unavailableParts.get(entry)
    if (part === undefined || part.instructions !== line) {
      const say = unavailableLine(entry.def.name, unavailable.reason)
      const standIns = registerActions(
        entry.def.id,
        (entry.def.declaredActions ?? []).map((a) =>
          defineAction({
            id: a.id,
            label: a.label,
            description: a.description,
            ...(a.examples !== undefined ? { examples: a.examples } : {}),
            params: {},
            // It does nothing but say why: safe before the turn is confirmed, and a read.
            speculative: true,
            risk: "read",
            offerAsTool: false,
            run: () => Effect.succeed({ say })
          })
        )
      )
      part = { moduleId: entry.def.id, module: { name: entry.def.id, tools: [], context: [], intentActions: standIns }, instructions: line, unavailable: true }
      unavailableParts.set(entry, part)
    }
    return part
  }

  /** One part per running instance, made once (so every snapshot and every assistant shares the same object). */
  const parts = new WeakMap<Running, ModulePart>()
  const partOf = (entry: Entry, running: Running): ModulePart => {
    let part = parts.get(running)
    if (part === undefined) {
      const intentOnly = running.actions.filter((a) => a.definition.offerAsTool === false)
      part = {
        moduleId: entry.def.id,
        module: {
          name: entry.def.id,
          tools: running.tools,
          context: (running.instance.context ?? []).map((p) => wrapProvider(entry.def.id, p)),
          ...(intentOnly.length > 0 ? { intentActions: intentOnly } : {})
        },
        instructions: running.instance.instructions?.trim() ?? ""
      }
      parts.set(running, part)
    }
    return part
  }

  let snapshot: ModuleSnapshot = {
    version: 0,
    registry: makeToolRegistry([], { gateway }),
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
      // A module judged unavailable whose instance still winds down offers its stand-ins only.
      if (e.unavailable !== undefined) return []
      const r = mainOf(e)?.running
      return r === undefined ? [] : [{ e, r }]
    })
    /** The main parts in catalog order: the running ones, and an unavailable one wherever it is wanted (no demand). */
    const mainParts = entries.flatMap((e) => {
      if (e.unavailable !== undefined) return e.demand === undefined && e.enabled ? [unavailablePartOf(e, e.unavailable)] : []
      const r = mainOf(e)?.running
      return r === undefined ? [] : [partOf(e, r)]
    })
    const toolModules = new Map<string, string>()
    for (const e of entries) for (const r of runningOf(e)) for (const name of toolNames(r.running)) toolModules.set(name, e.def.id)
    const agents = new Map<string, Agent>()
    const deciders = new Map<string, DecisionProvider>()
    for (const { r } of mains) {
      for (const agent of r.instance.agents ?? []) if (!agents.has(agent.id)) agents.set(agent.id, agent)
      for (const decider of r.instance.deciders ?? []) if (!deciders.has(decider.id)) deciders.set(decider.id, decider)
    }
    const assistantParts = new Map<string, ReadonlyArray<ModulePart>>()
    for (const e of entries) {
      for (const d of e.demand ?? []) {
        if (assistantParts.has(d.assistantId)) continue
        assistantParts.set(
          d.assistantId,
          entries.flatMap((x) => {
            if (x.unavailable !== undefined) {
              const wants = x.demand === undefined ? x.enabled : x.demand.some((w) => w.assistantId === d.assistantId)
              return wants ? [unavailablePartOf(x, x.unavailable)] : []
            }
            const r = x.demand === undefined ? mainOf(x)?.running : instanceFor(x, d.assistantId)?.running
            return r === undefined ? [] : [partOf(x, r)]
          })
        )
      }
    }
    return {
      version: snapshot.version + 1,
      registry: makeToolRegistry(mainParts.map((p) => p.module), { gateway }),
      instructions: mainParts.flatMap((p) => (p.instructions.length > 0 ? [p.instructions] : [])),
      toolModules,
      agents,
      actions: [
        ...mains.flatMap(({ r }) => r.actions),
        ...mainParts.flatMap((p) => (p.unavailable === true ? p.module.intentActions ?? [] : []))
      ],
      deciders,
      parts: mainParts,
      assistantParts
    }
  }
  const rebuild = () => {
    snapshot = buildSnapshot()
  }

  // -- Publication -----------------------------------------------------------------------------------------------------

  /** A service of `part` that another module's published shared part already provides (or that `part` provides twice). */
  const serviceClash = (entry: Entry, part: SharedPart<unknown>): string | undefined => {
    const ids = (part.services ?? []).map((p) => p.key.id)
    const twice = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twice !== undefined) return `The module provides the service "${twice}" twice`
    for (const other of entries) {
      if (other === entry || other.shared === undefined) continue
      const taken = ids.find((id) => (other.shared!.part.services ?? []).some((p) => p.key.id === id))
      if (taken !== undefined) return `The service "${taken}" is already provided by module ${other.def.name}`
    }
    return undefined
  }

  /**
   * THE switch (synchronous: nothing else can publish in between). Checks everything against the modules running NOW
   * (another module may have started meanwhile): the new shared part's services, every new instance's tool names,
   * and the snapshot built from the result. Then, all together, the module's published shared part, the instances'
   * started ones and (when given) its wanted set become the new state, and the snapshot is replaced. On any problem
   * nothing has changed and the message is returned; the caller's candidates are closed by its transaction.
   */
  const commit = (
    entry: Entry,
    change: {
      /** The new published shared part; `null` withdraws it; absent: unchanged. */
      readonly shared?: SharedRun | null
      readonly adds: ReadonlyArray<readonly [Instance, Running]>
      readonly instances?: Map<string, Instance>
      /** The leaving instances belong to the replaced generation: they go now (the caller retires them). */
      readonly clearLeaving?: boolean
    }
  ): string | undefined => {
    if (change.shared) {
      const clash = serviceClash(entry, change.shared.part)
      if (clash !== undefined) return clash
    }
    for (const [, running] of change.adds) {
      const names = toolNames(running)
      for (const other of entries) {
        if (other === entry) continue
        for (const r of runningOf(other)) {
          const clash = names.find((n) => toolNames(r.running).includes(n))
          if (clash !== undefined) return `Tool name "${clash}" is already used by module ${other.def.name}`
        }
      }
    }
    const before = { shared: entry.shared, instances: entry.instances, leaving: entry.leaving, running: change.adds.map(([rec]) => rec.running) }
    if (change.shared !== undefined) entry.shared = change.shared ?? undefined
    for (const [rec, running] of change.adds) rec.running = running
    if (change.instances !== undefined) entry.instances = change.instances
    if (change.clearLeaving === true) entry.leaving = new Set()
    try {
      snapshot = buildSnapshot()
    } catch (error) {
      entry.shared = before.shared
      change.adds.forEach(([rec], i) => {
        rec.running = before.running[i]
      })
      entry.instances = before.instances
      entry.leaving = before.leaving
      return `The module's tools could not be offered: ${error instanceof Error ? error.message : String(error)}`
    }
    // Published: no longer candidates of the operation.
    if (change.shared) pending.delete(change.shared.scope)
    for (const [, running] of change.adds) pending.delete(running.scope)
    if (change.shared !== undefined) entry.sharedError = undefined
    return undefined
  }

  const save = (entry: Entry) =>
    options.persistence.save(entry.def.id, {
      enabled: entry.enabled,
      settings: entry.stored as Record<string, SettingValue>,
      secrets: entry.secrets
    }).pipe(Effect.catchCause((cause) => Effect.logError(`Could not save the settings of module ${entry.def.id}`, cause)))

  /**
   * Retire what a switch replaced or demand no longer needs, as ONE generation: after the grace period (tool calls in
   * flight finish) its instances close, then its shared part (which they may still be using). The scopes are
   * registered for shutdown at once, so an interruption before the timer is forked cannot leak them.
   */
  const retire = (entry: Entry, runnings: ReadonlyArray<Running>, shared?: SharedRun) =>
    Effect.suspend(() => {
      const scopes = [...runnings.map((r) => r.scope), ...(shared !== undefined ? [shared.scope] : [])]
      if (scopes.length === 0) return Effect.void
      for (const scope of scopes) retired.add(scope)
      entry.retiring++
      return Effect.asVoid(Effect.forkIn(
        outsideTurns(
          Effect.sleep(graceMs).pipe(
            Effect.andThen(Effect.forEach(runnings, (r) => Scope.close(r.scope, Exit.void), { concurrency: "unbounded", discard: true })),
            Effect.andThen(shared === undefined ? Effect.void : Scope.close(shared.scope, Exit.void)),
            Effect.ensuring(Effect.sync(() => {
              for (const scope of scopes) retired.delete(scope)
              entry.retiring--
              if (entry.instances.size === 0 && entry.retiring === 0 && entry.leaving.size === 0) notify(entry)
            }))
          )
        ),
        hostScope
      ))
    })

  /** Retire every leaving instance (their replacements have settled), with a withdrawn shared part, and publish. */
  const finishLeaving = (entry: Entry) =>
    Effect.suspend(() => {
      const departed = [...entry.instances.values()].filter((r) => r.departing.length > 0)
      for (const r of departed) r.departing = []
      const shared = entry.sharedLeaving
      entry.sharedLeaving = undefined
      if (entry.leaving.size === 0 && shared === undefined) {
        if (departed.length > 0) rebuild()
        return Effect.void
      }
      const leaving = [...entry.leaving]
      entry.leaving.clear()
      rebuild()
      return retire(entry, leaving.flatMap((r) => (r.running === undefined ? [] : [r.running])), shared)
    })

  const describeStartFailure = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.findErrorOption(cause)
    if (error._tag === "Some" && error.value instanceof ModuleStartError) return error.value.message
    return `The module crashed while starting: ${Cause.pretty(cause).split("\n")[0]}`
  }

  /**
   * Run `body` with the candidates it starts: uninterruptible except where `body` restores (the modules' own code),
   * and every candidate scope that `commit` did not publish is closed on EVERY exit (success, failure, interruption,
   * a start that throws), so a started part is always either published or closed.
   */
  const transaction = <A>(body: (restore: Restore, candidates: Array<Scope.Closeable>) => Effect.Effect<A>): Effect.Effect<A> =>
    Effect.uninterruptibleMask((restore) => {
      const candidates: Array<Scope.Closeable> = []
      return body(restore, candidates).pipe(
        Effect.ensuring(Effect.suspend(() => {
          const left = candidates.filter((s) => pending.has(s))
          for (const s of left) pending.delete(s)
          return Effect.forEach(left, (s) => Scope.close(s, Exit.void), { concurrency: "unbounded", discard: true })
        }))
      )
    })

  /** A new scope, a candidate of the transaction until published. */
  const candidateScope = (candidates: Array<Scope.Closeable>) =>
    Effect.map(Scope.make(), (scope) => {
      pending.add(scope)
      candidates.push(scope)
      return scope
    })

  /** The shared settings: everything resolved except the fields an assistant may own; the key is their non-secret values. */
  const sharedSpecOf = (entry: Entry, stored = entry.stored, secrets = entry.secrets): SharedSpec => {
    const resolved = resolve(entry, stored, secrets)
    const owned = new Set(overridableKeys(entry.def.settings))
    const without = (record: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(record).filter(([k]) => !owned.has(k)))
    // Only the fields the shared part receives are judged here: an assistant-owned field's invalid shared default
    // does not stop it (each instance validates its own effective settings in full).
    const errors = resolved.form.errors.filter((e) => e.key === null || !owned.has(e.key))
    const values = without(resolved.form.values)
    const raw = without(resolved.value ?? (resolvedRaw(entry, stored, secrets) as Record<string, unknown>))
    return { key: JSON.stringify(values), settings: errors.length === 0 ? raw : undefined, errors, stored, secrets }
  }

  /**
   * The resolved values even where some field is invalid (an overridable field's): secrets included. The form's
   * values hold no secrets, so they are added from the sources the same way `resolveSettings` does.
   */
  const resolvedRaw = (entry: Entry, stored: Readonly<Record<string, unknown>>, secrets: Readonly<Record<string, string>>) => {
    const form = resolve(entry, stored, secrets).form
    const out: Record<string, unknown> = { ...form.values }
    for (const [key, setting] of Object.entries(entry.def.settings as SettingsSpec)) {
      if (!setting.secret) continue
      const fromEnv = setting.env !== undefined && (options.env[setting.env] ?? "") !== "" ? options.env[setting.env] : undefined
      const saved = secrets[key]
      out[key] = fromEnv ?? (saved !== undefined && saved.length > 0 ? saved : undefined)
    }
    return out
  }

  /** `ctx.settingsFor` of a shared part: an assistant's own values over the shared ones it started with. */
  const settingsForOf = (entry: Entry, spec: SharedSpec) => (assistantId: string | undefined): unknown => {
    const own = assistantId === undefined ? undefined : entry.demand?.find((d) => d.assistantId === assistantId)?.own
    return resolve(entry, spec.stored, spec.secrets, own === undefined ? undefined : applicableOwnValues(entry.def.settings, own)).value
  }

  /** Start a shared part with `spec` as a candidate (10 s). Fails only with an interruption. */
  const startShared = (entry: Entry, spec: SharedSpec, restore: Restore, candidates: Array<Scope.Closeable>) =>
    Effect.gen(function*() {
      const shared = entry.def.shared!
      if (spec.settings === undefined) return { ok: false as const, message: invalidMessage(spec.errors) }
      const scope = yield* candidateScope(candidates)
      const context = { settings: spec.settings as never, settingsFor: settingsForOf(entry, spec) as never, ...servicesFor(entry, "all") }
      const exit = yield* restore(
        outsideTurns(
          Effect.suspend(() => shared(context)).pipe(
            Scope.provide(scope),
            Effect.timeoutOrElse({
              duration: startTimeoutMs,
              orElse: () => Effect.fail(new ModuleStartError({ message: `Its shared part did not start within ${Math.round(startTimeoutMs / 1000)} s` }))
            })
          )
        )
      ).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
        return { ok: false as const, message: describeStartFailure(exit.cause) }
      }
      const ids = (exit.value.services ?? []).map((p) => p.key.id)
      const twice = ids.find((id, i) => ids.indexOf(id) !== i)
      if (twice !== undefined) return { ok: false as const, message: `The module provides the service "${twice}" twice` }
      return { ok: true as const, run: { key: spec.key, scope, part: exit.value, spec } satisfies SharedRun }
    })

  /** Start one instance as a candidate (10 s). Fails only with an interruption. */
  const startCandidate = (
    entry: Entry,
    rec: Instance,
    settings: unknown,
    shared: SharedRun | undefined,
    restore: Restore,
    candidates: Array<Scope.Closeable>
  ): Effect.Effect<Started> =>
    Effect.gen(function*() {
      const scope = yield* candidateScope(candidates)
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
      // Version 1 modules get exactly the context they always had; version 2 modules also get the host's services and
      // what their `shared` part returned.
      const context = (entry.def.apiVersion ?? 1) >= 2
        ? { settings: settings as never, setStatus, shared: shared?.part.value, ...servicesFor(entry, { rec, generation }) }
        : { settings: settings as never, setStatus }
      const exit = yield* restore(
        outsideTurns(
          Effect.suspend(() => entry.def.start(context)).pipe(
            Scope.provide(scope),
            Effect.timeoutOrElse({
              duration: startTimeoutMs,
              orElse: () => Effect.fail(new ModuleStartError({ message: `Did not start within ${Math.round(startTimeoutMs / 1000)} s` }))
            })
          )
        )
      ).pipe(Effect.exit)
      const fail = (message: string): Started => ({ ok: false, message })
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
        return fail(describeStartFailure(exit.cause))
      }
      const instance = exit.value
      let contributed: ReturnType<typeof contributionsOf>
      try {
        contributed = contributionsOf(entry.def.id, instance)
      } catch (error) {
        return fail(`The module's actions could not be offered as tools: ${String(error)}`)
      }
      const actionIds = contributed.actions.map((a) => a.id)
      const duplicateAction = actionIds.find((n, i) => actionIds.indexOf(n) !== i)
      if (duplicateAction !== undefined) return fail(`The module declares the action "${duplicateAction}" twice`)
      const names = toolNames(contributed)
      const duplicate = names.find((n, i) => names.indexOf(n) !== i)
      if (duplicate !== undefined) return fail(`The module declares the tool "${duplicate}" twice`)
      const metadata = [...(instance.tools ?? []).map((t) => metadataProblem(`Tool "${t.name}"`, t)), ...contributed.actions.map((a) => metadataProblem(`Action "${a.definition.id}"`, a.definition))]
        .find((p) => p !== undefined)
      if (metadata !== undefined) return fail(metadata)
      // Core always words a confirmation question itself (after the final review): a module's own text is ignored.
      for (const a of contributed.actions) {
        if (typeof a.definition.confirm === "function") {
          yield* Effect.logWarning(
            `Module ${entry.def.id}, action "${a.definition.id}": its own confirmation text is ignored; the assistant asks its own question from the action's label and values`
          )
        }
      }
      started = true
      return { ok: true, running: { scope, instance, generation, settings, ...contributed }, status: startStatus }
    })

  // -- Operations --------------------------------------------------------------------------------------------------

  /** Start the instance `rec` of `group` on its own (enable, retry, startup, a new assistant). It is already wanted. */
  const startOne = (entry: Entry, group: Group, rec: Instance, isNew: boolean): Effect.Effect<HostResult> =>
    Effect.suspend(() => {
      const resolved = group.resolved
      if (resolved.value === undefined) {
        rec.state = "error"
        rec.error = invalidMessage(resolved.form.errors)
        notify(entry)
        return Effect.succeed(failure("invalid_settings", rec.error, { moduleId: entry.def.id, fieldErrors: resolved.form.errors }))
      }
      if (entry.def.shared !== undefined && entry.shared === undefined) {
        // Its shared part is not running (it failed): the instance cannot get its value.
        rec.state = "error"
        rec.error = entry.sharedError ?? "Its shared part is not running"
        notify(entry)
        return Effect.succeed(failure("module_start_failed", rec.error, { moduleId: entry.def.id }))
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
      let settled = false
      return transaction((restore, candidates) =>
        Effect.map(startCandidate(entry, rec, resolved.value, entry.shared, restore, candidates), (result): HostResult => {
          settled = true
          if (!result.ok) return startFailed(result.message)
          // No longer wanted while it started (demand changed, the generation was replaced): not kept.
          if (entry.instances.get(rec.key) !== rec) {
            notify(entry)
            return OK
          }
          const clash = commit(entry, { adds: [[rec, result.running]] })
          if (clash !== undefined) return startFailed(clash)
          rec.status = result.status
          rec.state = "running"
          notify(entry)
          return OK
        })
      ).pipe(
        // Cancelled during the module's start (shutdown, the caller gave up): its scope is closed; back to how it was
        // (a new instance is not wanted any more). An interruption once the result was settled changes nothing.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (settled) return
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
   * A new generation (§4 P1 "Replacement"): a new shared part and every instance start while the old generation
   * serves; then, in one `commit`, the snapshot switches to them; then the old generation (its instances and its
   * shared part, together) is retired with the grace period. The old shared part's services and contributions are
   * withdrawn at the switch, never live beside the new ones. If the new shared part fails, an instance that is
   * `required` fails, or the switch is refused, nothing changes and the message is returned.
   */
  const replaceGeneration = (
    entry: Entry,
    plan: {
      readonly spec: SharedSpec
      readonly items: ReadonlyArray<GenerationItem>
      /** Adopted at the switch (an owner's `configure`). */
      readonly settings?: { readonly stored: Readonly<Record<string, unknown>>; readonly secrets: Readonly<Record<string, string>> }
    }
  ): Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly message: string }> =>
    transaction((restore, candidates) =>
      Effect.gen(function*() {
        const shared = yield* startShared(entry, plan.spec, restore, candidates)
        if (!shared.ok) return shared
        const recs = plan.items.map((item) => ({ item, rec: newInstance(item) }))
        const valid = recs.filter(({ item }) => item.invalid === undefined)
        const results = yield* Effect.forEach(valid, ({ item, rec }) => startCandidate(entry, rec, item.settings, shared.run, restore, candidates), {
          concurrency: valid.length > 1 ? "unbounded" : 1
        })
        const failed = results.findIndex((r, i) => !r.ok && valid[i]!.item.required)
        if (failed >= 0) return { ok: false as const, message: (results[failed] as Extract<Started, { ok: false }>).message }
        const required = recs.find(({ item }) => item.invalid !== undefined && item.required)
        if (required !== undefined) return { ok: false as const, message: required.item.invalid! }
        const next = new Map(recs.map(({ rec }) => [rec.key, rec]))
        const adds = results.flatMap((r, i) => (r.ok ? [[valid[i]!.rec, r.running] as const] : []))
        const old = { runnings: runningOf(entry).flatMap((r) => (r.running === undefined ? [] : [r.running])), shared: entry.shared, leaving: entry.sharedLeaving }
        const clash = commit(entry, { shared: shared.run, adds, instances: next, clearLeaving: true })
        if (clash !== undefined) return { ok: false as const, message: clash }
        results.forEach((r, i) => {
          const rec = valid[i]!.rec
          rec.state = r.ok ? "running" : "error"
          rec.error = r.ok ? undefined : r.message
          rec.status = r.ok ? r.status : undefined
        })
        for (const { item, rec } of recs) {
          if (item.invalid !== undefined) {
            rec.state = "error"
            rec.error = item.invalid
          }
        }
        if (plan.settings !== undefined) {
          entry.stored = plan.settings.stored
          entry.secrets = plan.settings.secrets
        }
        entry.kept = undefined
        entry.sharedLeaving = undefined
        yield* retire(entry, old.runnings, old.shared)
        if (old.leaving !== undefined) yield* retire(entry, [], old.leaving)
        return { ok: true as const }
      })
    )

  /** The items of a new generation from the groups of now: an instance that serves an assistant now must start. */
  const itemsOf = (entry: Entry, groups: ReadonlyArray<Group>, allRequired: boolean): Array<GenerationItem> =>
    groups.map((group) => ({
      key: group.key,
      ownKeys: group.ownKeys,
      users: group.users,
      settings: group.resolved.value,
      ...(group.resolved.value === undefined ? { invalid: invalidMessage(group.resolved.form.errors) } : {}),
      required: allRequired || (entry.demand === undefined ? mainOf(entry) !== undefined : group.users.some((u) => instanceFor(entry, u) !== undefined))
    }))

  const demandKeyOf = (entry: Entry) => JSON.stringify([wanted(entry), isDemanded(entry), entry.demand ?? null])

  /**
   * Bring the module in line with its demand and settings. A changed shared setting (or `force`) starts a new
   * generation (`replaceGeneration`; if it fails the old one serves on and Health says why). Otherwise, within the
   * generation: the shared part starts first when there is none yet (and is published at once: it is demanded
   * whatever its instances do), the wanted instances that are missing start (with `retry`, also those in error), each
   * on its own, and those no longer wanted are retired, with a withdrawn shared part, once the starts have settled (a
   * replaced instance serves until then). Returns the first failure, and whether anything changed.
   */
  const reconcile = (entry: Entry, retry: boolean, reconcileOptions: { readonly force?: boolean } = {}): Effect.Effect<{ readonly result: HostResult; readonly changed: boolean }> =>
    Effect.suspend(() => {
      const groups = groupsOf(entry)
      const demanded = isDemanded(entry)
      const needShared = entry.def.shared !== undefined && demanded
      const demandKey = demandKeyOf(entry)
      let changed = demandKey !== entry.announced
      entry.announced = demandKey
      if (needShared && entry.shared !== undefined) {
        const spec = sharedSpecOf(entry)
        if (spec.key !== entry.shared.key || reconcileOptions.force === true) {
          return Effect.map(replaceGeneration(entry, { spec, items: itemsOf(entry, groups, false) }), (outcome) => {
            if (outcome.ok) return { result: OK, changed: true }
            entry.kept = { title: `${entry.def.name} could not apply its new settings`, message: outcome.message }
            return { result: failure("module_start_failed", outcome.message, { moduleId: entry.def.id }), changed: true }
          })
        }
      }
      const next = new Map<string, Instance>()
      const starts: Array<{ readonly group: Group; readonly rec: Instance; readonly isNew: boolean }> = []
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
          // An assistant moving to an instance that still starts keeps this one until then (`finishLeaving`).
          rec.departing = rec.users.filter((u) => !group.users.includes(u))
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
      // Demand ended: the shared part is withdrawn now and retired with the leaving instances.
      if (!needShared && entry.shared !== undefined) {
        entry.sharedLeaving = entry.shared
        entry.shared = undefined
        changed = true
      }
      if (!demanded) entry.sharedError = undefined
      if (changed) rebuild()
      return Effect.gen(function*() {
        if (needShared && entry.shared === undefined) {
          const spec = sharedSpecOf(entry)
          const started = yield* transaction((restore, candidates) =>
            Effect.map(startShared(entry, spec, restore, candidates), (r) => {
              if (!r.ok) return r
              const clash = commit(entry, { shared: r.run, adds: [] })
              return clash === undefined ? r : { ok: false as const, message: clash }
            })
          ).pipe(Effect.onInterrupt(() =>
            Effect.sync(() => {
              for (const { isNew, rec } of starts) if (isNew && entry.instances.get(rec.key) === rec) entry.instances.delete(rec.key)
              notify(entry)
            })
          ))
          if (!started.ok) {
            entry.sharedError = started.message
            for (const { rec } of starts) {
              rec.state = "error"
              rec.error = started.message
            }
            notify(entry)
            yield* finishLeaving(entry)
            return { result: failure("module_start_failed", started.message, { moduleId: entry.def.id }), changed: true }
          }
          changed = true
          // Instances that failed for want of it are started again with it.
          for (const [key, rec] of entry.instances) {
            const group = groups.find((g) => g.key === key)
            if (group !== undefined && rec.state === "error" && !starts.some((x) => x.rec === rec)) starts.push({ group, rec, isNew: false })
          }
          notify(entry)
        }
        const results = yield* Effect.forEach(starts, ({ group, isNew, rec }) => startOne(entry, group, rec, isNew), { concurrency: starts.length > 1 ? "unbounded" : 1 }).pipe(
          Effect.ensuring(finishLeaving(entry))
        )
        // Nothing of it runs any more: an old failed restart is no longer news.
        if (entry.instances.size === 0 && entry.shared === undefined && entry.kept !== undefined) {
          entry.kept = undefined
          changed = true
        }
        return { result: results.find((r) => !r.ok) ?? OK, changed }
      })
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
      return outsideTurns(op(entry)).pipe(Effect.ensuring(Effect.suspend(() => {
        entry.busy = false
        let retry = false
        if (entry.pendingSecrets !== undefined) {
          entry.secrets = entry.pendingSecrets
          entry.pendingSecrets = undefined
          entry.dirty = true
          retry = true
          notify(entry)
        }
        if (!entry.dirty) return Effect.void
        entry.dirty = false
        // This module only: whoever marked it also reconciled the others (re-running everything here could bounce
        // between two passes that each find the other's module busy).
        return Effect.asVoid(Effect.forkIn(outsideTurns(Effect.andThen(refreshEntry(entry, retry), Effect.sync(refreshIssues))), hostScope))
      })))
    })

  /** Bring one module in line (refresh), now, or after the operation that holds it. */
  const refreshEntry = (entry: Entry, retry = false): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entry.busy) {
        entry.dirty = true
        return Effect.void
      }
      return Effect.asVoid(exclusive(entry.def.id, (e) =>
        Effect.map(reconcile(e, retry), ({ changed, result }) => {
          if (changed) notify(e)
          return result
        })))
    })

  /**
   * Bring every module in line, in `uses` order: a module is reconciled after the modules it names in `uses` (so it
   * starts after their shared parts have started or failed). Demand is re-read from the entries as each one goes, so
   * a change of one module's state or of an assistant's switches reaches the modules it uses, transitively. A cycle
   * cannot block it (its members are catalogue errors and wait for nobody). Then every module's issues again.
   */
  const reconcileAll = (retry: (entry: Entry) => boolean = () => false): Effect.Effect<void> =>
    Effect.suspend(() => {
      const done = new Map(entries.map((e) => [e, Deferred.makeUnsafe<void>()]))
      return Effect.forEach(
        entries,
        (entry) =>
          Effect.forEach(providersOf(entry), (p) => Deferred.await(done.get(p)!), { discard: true }).pipe(
            Effect.andThen(refreshEntry(entry, retry(entry))),
            Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(done.get(entry)!, Effect.void)))
          ),
        { concurrency: "unbounded", discard: true }
      ).pipe(Effect.ensuring(Effect.sync(refreshIssues)))
    })

  /** Read the demand (when there is one). */
  const readDemand = () => {
    if (options.demand === undefined) return
    const demand = options.demand()
    let unavailableChanged = false
    for (const entry of entries) {
      const next = demand.get(entry.def.id)
      if (entry.unavailable !== undefined && JSON.stringify(next) !== JSON.stringify(entry.demand)) unavailableChanged = true
      entry.demand = next
    }
    // An unavailable module starts nothing, so nothing else would rebuild its instructions lines for its new assistants.
    if (unavailableChanged) rebuild()
  }

  const notAllowed = (entry: Entry): HostResult =>
    failure("not_allowed", `${entry.def.name} is switched on and off per assistant (the assistant's Modules tab).`, { moduleId: entry.def.id })

  /** Its own switch changed: everything it uses follows (and the issues of all of them). */
  const enable = (id: string) => outsideTurns(Effect.tap(exclusiveSwitch(id, true), () => reconcileAll()))
  const disable = (id: string) => outsideTurns(Effect.tap(exclusiveSwitch(id, false), () => reconcileAll()))

  const exclusiveSwitch = (id: string, on: boolean) =>
    exclusive(id, (entry) =>
      Effect.gen(function*() {
        if (entry.demand !== undefined) return notAllowed(entry)
        entry.enabled = on
        entry.chosen = true
        const revision = entry.revision
        const { result } = yield* reconcile(entry, on)
        yield* save(entry)
        // The switch itself is news even when nothing starts or stops (an unavailable module: its instructions line).
        if (entry.revision === revision || !on) {
          rebuild()
          notify(entry)
        }
        return on ? result : OK
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
        const secretsChanged = Object.keys(patch.secrets).length > 0
        // Nothing runs that the new settings could break (no instance, no shared part): they are saved, then tried.
        const live = entry.shared !== undefined || [...entry.instances.values()].some((r) => r.running !== undefined)
        if (!live) {
          entry.stored = patched.stored
          entry.secrets = patched.secrets
          yield* save(entry)
          if ([...entry.instances.values()].some((r) => r.state === "error") || entry.sharedError !== undefined || (entry.def.shared !== undefined && isDemanded(entry))) {
            const { result } = yield* reconcile(entry, true, { force: secretsChanged })
            notify(entry)
            return result
          }
          notify(entry)
          return OK
        }
        // Something runs: the change is a transaction. It is saved only once what it starts has replaced it.
        const groups = groupsOf(entry, patched.stored, patched.secrets)
        const invalid = groups.find((g) => g.resolved.value === undefined)
        if (invalid !== undefined) {
          return failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: invalid.resolved.form.errors })
        }
        const done = (): Effect.Effect<HostResult> =>
          Effect.andThen(save(entry), Effect.sync(() => {
            notify(entry)
            return OK
          }))
        if (entry.def.shared !== undefined && isDemanded(entry)) {
          const spec = sharedSpecOf(entry, patched.stored, patched.secrets)
          if (spec.settings === undefined) return failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: spec.errors })
          if (secretsChanged || spec.key !== entry.shared?.key) {
            // A changed shared setting or secret: a new generation, all of it or nothing.
            const outcome = yield* replaceGeneration(entry, { spec, items: itemsOf(entry, groups, true), settings: { stored: patched.stored, secrets: patched.secrets } })
            if (!outcome.ok) return failure("module_start_failed", outcome.message, { moduleId: id })
            return yield* done()
          }
        }
        // Within the generation: an instance whose effective settings stay the same keeps running (a new secret
        // restarts every one). The old ones serve while the new ones start; the switch is one `commit`.
        const next = new Map<string, Instance>()
        const fresh: Array<{ readonly rec: Instance; readonly settings: unknown }> = []
        for (const group of groups) {
          const existing = entry.instances.get(group.key)
          if (existing?.running !== undefined && !secretsChanged) {
            next.set(group.key, existing)
            continue
          }
          const rec = newInstance(group)
          next.set(group.key, rec)
          fresh.push({ rec, settings: group.resolved.value })
        }
        const replaced = [...entry.instances.values()].filter((r) => next.get(r.key) !== r)
        const outcome = yield* transaction((restore, candidates) =>
          Effect.gen(function*() {
            const results = yield* Effect.forEach(fresh, ({ rec, settings }) => startCandidate(entry, rec, settings, entry.shared, restore, candidates), {
              concurrency: fresh.length > 1 ? "unbounded" : 1
            })
            const failed = results.find((r): r is Extract<Started, { ok: false }> => !r.ok)
            if (failed !== undefined) return failed.message
            const adds = results.map((r, i) => [fresh[i]!.rec, (r as Extract<Started, { ok: true }>).running] as const)
            const clash = commit(entry, { adds, instances: next })
            if (clash !== undefined) return clash
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
            entry.kept = undefined
            rebuild()
            yield* retire(entry, replaced.flatMap((r) => (r.running === undefined ? [] : [r.running])))
            return undefined
          })
        )
        if (outcome !== undefined) return failure("module_start_failed", outcome, { moduleId: id })
        return yield* done()
      }))

  // Evaluated when run: a module switched on by `setSecrets` before this runs is included (and started once).
  const startEnabled = outsideTurns(Effect.suspend(() => {
    readDemand()
    return reconcileAll(() => true)
  }))

  const refresh = outsideTurns(Effect.suspend(() => {
    readDemand()
    return reconcileAll()
  }))

  const evaluate = Effect.sync(() => {
    readDemand()
    refreshIssues()
  })

  // Shutdown: close every instance at once (no grace).
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [
        ...entries.flatMap((e) => runningOf(e).map((r) => r.running!.scope)),
        ...entries.flatMap((e) => [e.shared, e.sharedLeaving].flatMap((s) => (s === undefined ? [] : [s.scope]))),
        ...pending,
        ...retired
      ],
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
    outsideTurns(Effect.suspend(() => {
      const retryFor = new Set<Entry>()
      for (const entry of entries) {
        const next = all[entry.def.id] ?? {}
        if (entry.busy) {
          // Applied when the operation that holds it ends (its commit would otherwise overwrite them).
          if (JSON.stringify(next) !== JSON.stringify(entry.pendingSecrets ?? entry.secrets)) entry.pendingSecrets = next
          continue
        }
        if (JSON.stringify(next) === JSON.stringify(entry.secrets)) continue
        entry.secrets = next
        // A key that now counts (the vault was unlocked) switches on a module the owner has not chosen for.
        if (entry.demand === undefined && !entry.chosen && !entry.busy && entry.instances.size === 0 && stateOf(entry).state === "disabled") {
          const wants = defaultIntent(entry)
          if (wants && !entry.enabled) retryFor.add(entry)
          entry.enabled = wants
        }
        notify(entry)
      }
      // Starts that failed (for lack of a key) are tried again; a module switched on brings what it uses along.
      for (const e of entries) if (e.sharedError !== undefined || [...e.instances.values()].some((r) => r.state === "error")) retryFor.add(e)
      return reconcileAll((e) => retryFor.has(e))
    }))

  const checkOwn = (id: string, own: Readonly<Record<string, unknown>>): ReadonlyArray<FieldError> => {
    const entry = byId.get(id)
    if (entry === undefined) return [{ key: null, message: `There is no module "${id}"` }]
    return checkOwnValues(entry.def.settings, own)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Module API v2: availability, health, the action catalogue, services, restarts

  const recheck = outsideTurns(Effect.suspend(() => {
    const changed: Array<Entry> = []
    const key = (e: { readonly unavailable: ModuleUnavailable | undefined; readonly statuses: ReadonlyArray<RequirementStatus> }) =>
      JSON.stringify([e.unavailable ?? null, e.statuses.map((st) => [st.state, st.detail, st.fix ?? null])])
    for (const entry of entries) {
      const before = key(entry)
      const judged = judge(entry)
      entry.unavailable = judged.unavailable
      entry.statuses = judged.statuses
      if (key(entry) !== before) changed.push(entry)
    }
    if (changed.length === 0) return Effect.void
    // The instructions lines and the tools change from the next turn on; then every module is brought in line, in
    // `uses` order (a module that became unavailable no longer demands what it uses; one that became available does).
    rebuild()
    for (const entry of changed) notify(entry)
    return reconcileAll()
  }))

  const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

  /**
   * A module's own issues, made safe for the wire: its id as prefix and `module`, every bounded text within its limit
   * (the fix's label and value too), at most 50. An issue that still does not fit the wire's `HealthIssue` is replaced
   * by one that says so, so one malformed issue cannot break the health message or the admin snapshot.
   */
  function normaliseIssues(entry: Entry, list: ReadonlyArray<Issue>): ReadonlyArray<Issue> {
    const id = entry.def.id
    return list.slice(0, 50).map((issue, i): Issue => {
      const fix = issue.fix === undefined ? undefined : {
        kind: issue.fix.kind,
        label: clip(String(issue.fix.label ?? ""), 200),
        ...(issue.fix.value !== undefined ? { value: clip(String(issue.fix.value), 1000) } : {})
      }
      const out: Issue = {
        id: clip(issue.id.startsWith(`${id}.`) ? issue.id : `${id}.${issue.id}`, 200),
        module: id,
        ...(issue.device !== undefined ? { device: clip(String(issue.device), 200) } : {}),
        severity: issue.severity,
        title: clip(String(issue.title ?? ""), 200),
        detail: clip(String(issue.detail ?? ""), 2000),
        ...(fix !== undefined ? { fix } : {})
      }
      if (isWireIssue(out)) return out
      return { id: `${id}.malformed-issue-${i}`, module: id, severity: "warning", title: `${entry.def.name} reported an issue that cannot be shown`, detail: "Its severity or fix kind is not one the page knows." }
    })
  }

  const checkHealth = outsideTurns(Effect.forEach(
    entries,
    (entry) =>
      Effect.suspend(() => {
        const health = entry.def.health
        const source = `health:${entry.def.id}`
        if (health === undefined) return Effect.void
        if (entry.unavailable !== undefined || entry.catalogError !== undefined) {
          issues.set(source, [])
          return Effect.void
        }
        const settings = resolve(entry).value
        const own = (title: string, detail: string): ReadonlyArray<Issue> => [{ id: `${entry.def.id}.health`, module: entry.def.id, severity: "warning", title, detail }]
        // Suspended: a health check that throws is reported like one that fails.
        return Effect.suspend(() => health({ settings, running: isRunning(entry) })).pipe(
          Effect.timeoutOrElse({
            duration: healthTimeoutMs,
            orElse: () => Effect.succeed(own(`${entry.def.name}'s health check did not finish`, `It took longer than ${Math.round(healthTimeoutMs / 1000)} s.`))
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.succeed(own(`${entry.def.name}'s health check failed`, Cause.pretty(cause).split("\n")[0] ?? ""))
          ),
          Effect.flatMap((list) => Effect.sync(() => issues.set(source, normaliseIssues(entry, Array.isArray(list) ? list : []))))
        )
      }),
    { concurrency: "unbounded", discard: true }
  ))

  /** The instance an action lookup uses: the assistant's own one, or the main one. */
  const instanceUsedBy = (entry: Entry, assistantId: string | undefined): Instance | undefined => {
    if (entry.unavailable !== undefined) return undefined
    return assistantId !== undefined && entry.demand !== undefined ? instanceFor(entry, assistantId) : mainOf(entry)
  }

  /** The assistant may use this module (the gateway's own first check, so the catalogue lists what would run). */
  const moduleOnFor = (assistantId: string | undefined, entry: Entry) =>
    assistantId === undefined || options.access === undefined || options.access.moduleOn(assistantId, entry.def.id)

  /** The assistant may use this action (the gateway's first two checks). */
  const offered = (assistantId: string | undefined, entry: Entry, actionId: string) =>
    moduleOnFor(assistantId, entry) &&
    (assistantId === undefined || options.access === undefined || !options.access.toolOff(assistantId, entry.def.id, actionToolName(entry.def.id, actionId)))

  /** An unavailable module the caller has on (an assistant's choice, or its saved switch without demand). */
  const unavailableFor = (entry: Entry, assistantId: string | undefined) =>
    entry.unavailable !== undefined &&
    (entry.demand === undefined ? entry.enabled : assistantId === undefined ? entry.demand.length > 0 : entry.demand.some((d) => d.assistantId === assistantId))

  const catalogEntry = (entry: Entry, action: RegisteredAction): CatalogAction => {
    const d = action.definition
    const meta = toolMetadata(d)
    return {
      moduleId: entry.def.id,
      actionId: d.id,
      id: action.id,
      label: d.label,
      description: d.description,
      examples: [...(d.examples ?? [])],
      params: Object.entries(d.params as ActionParams).map(([name, p]) => ({ name, kind: p.kind, label: p.label, optional: p.optional === true })),
      speculative: d.speculative === true,
      confirm: d.confirm !== undefined && d.confirm !== false,
      ...meta,
      risks: [...meta.risks]
    }
  }

  /** The assistant a principal acts for: a turn's, a job's; `undefined` for the local principal (every module). */
  const assistantOf = (principal: Principal): string | undefined =>
    principal._tag === "turn" ? principal.turn.assistantId : principal._tag === "job" ? principal.job.assistantId : undefined

  /**
   * The catalogue for an assistant: each module's actions from the instance it uses, as the gateway would admit them,
   * and an unavailable module's declared actions (their stand-ins say it is not set up).
   */
  const catalogOf = (assistantId: string | undefined) =>
    entries.flatMap((entry) => {
      if (unavailableFor(entry, assistantId) && moduleOnFor(assistantId, entry)) {
        const standIns = unavailablePartOf(entry, entry.unavailable!).module.intentActions ?? []
        return standIns.filter((a) => offered(assistantId, entry, a.definition.id)).map((action) => ({ entry, action }))
      }
      const running = instanceUsedBy(entry, assistantId)?.running
      if (running === undefined) return []
      return running.actions.filter((a) => offered(assistantId, entry, a.definition.id)).map((action) => ({ entry, action }))
    })

  const actions: ModuleHostApi["actions"] = {
    list: Effect.gen(function*() {
      const principal = yield* gateway.principal
      if ("refused" in principal) return []
      return catalogOf(assistantOf(principal)).map(({ action, entry }) => catalogEntry(entry, action))
    }),
    run: (request: ActionRunRequest) =>
      Effect.gen(function*() {
        const refuse = (code: Extract<ActionRunResult, { ok: false }>["code"], message: string): ActionRunResult => ({ ok: false, code, message })
        const entry = byId.get(request.moduleId)
        if (entry === undefined) return refuse("unknown_module", `There is no module "${request.moduleId}"`)
        const principal = yield* gateway.principal
        if ("refused" in principal) return refuse("refused", `Not run: ${principal.refused}`)
        const assistantId = assistantOf(principal)
        if (unavailableFor(entry, assistantId) && moduleOnFor(assistantId, entry)) {
          // Known but not set up here: the module's line, never another action.
          const declared = (entry.def.declaredActions ?? []).some((a) => a.id === request.actionId)
          if (!declared) return refuse("unknown_action", `${entry.def.name} has no action "${request.actionId}"`)
          return refuse("unavailable", unavailableLine(entry.def.name, entry.unavailable!.reason))
        }
        const running = instanceUsedBy(entry, assistantId)?.running
        if (running === undefined) {
          return assistantId !== undefined && mainOf(entry) !== undefined && entry.unavailable === undefined
            ? refuse("refused", `Not run: the ${entry.def.id} module is not on for this assistant.`)
            : refuse("not_running", `${entry.def.name} is not running`)
        }
        const action = running.actions.find((a) => a.definition.id === request.actionId)
        if (action === undefined) return refuse("unknown_action", `${entry.def.name} has no action "${request.actionId}"`)
        const def = action.definition
        if (def.confirm !== undefined && def.confirm !== false) {
          return refuse("needs_confirmation", `${def.label} needs the owner's spoken confirmation, which only a conversation can ask for`)
        }
        let values: Record<string, unknown>
        try {
          // Resolved once: the gateway admits these values and the action runs with exactly them.
          values = checkedActionValues(action, request.params)
        } catch (error) {
          return refuse("invalid_params", error instanceof Error ? error.message : String(error))
        }
        return yield* gateway.action(action, values, { principal }).pipe(
          Effect.timeoutOrElse({
            duration: ACTION_TIMEOUT_MS,
            orElse: () => Effect.fail(new ActionError({ message: `${def.label} did not finish within ${ACTION_TIMEOUT_MS / 1000} s` }))
          }),
          Effect.map((outcome): ActionRunResult => {
            const say = (outcome as ActionOutcome | undefined)?.say
            return say !== undefined ? { ok: true, say } : { ok: true }
          }),
          Effect.catch((error) => Effect.succeed(refuse(isGatewayRefusal(error) ? "refused" : "failed", error.message))),
          Effect.catchDefect((defect) => Effect.succeed(refuse("failed", `${def.label} crashed: ${String(defect)}`)))
        )
      })
  }

  const view = (): HostView => ({
    modules: entries.map((e) => ({
      id: e.def.id,
      name: e.def.name,
      kind: e.def.kind ?? "capability",
      state: stateOf(e).state,
      ...(e.def.version !== undefined ? { version: e.def.version } : {}),
      ...(e.unavailable !== undefined ? { unavailable: e.unavailable.reason } : {})
    })),
    vaultLocked: options.view?.vaultLocked?.(),
    engine: options.view?.engine?.(),
    devices: options.view?.devices?.() ?? [],
    home: options.view?.home?.() ?? {}
  })

  const service = <T>(key: ServiceKey<T>): T | undefined => {
    for (const entry of entries) {
      const found = entry.shared?.part.services?.find((p) => p.key.id === key.id)
      if (found !== undefined) return found.service as T
    }
    return undefined
  }

  /**
   * The contributions under `key`: inside a turn, only those of modules the turn's assistant has on (read from the
   * calling fiber, synchronously); outside a turn, all. Services are not filtered so (§2 row 18).
   */
  const contributions = <T>(key: ContributionKey<T>): ReadonlyArray<T> => {
    const turn = Fiber.getCurrent()?.getRef(CurrentTurn)
    const assistantId = turn?.assistantId
    return entries.flatMap((entry) =>
      assistantId !== undefined && !moduleOnFor(assistantId, entry)
        ? []
        : (entry.shared?.part.contributions ?? []).filter((c) => c.key.id === key.id).map((c) => c.value as T)
    )
  }

  // -- Restarts ------------------------------------------------------------------------------------------------------

  /** Restarts asked for and not yet started (one per instance, or per module for its generation). */
  const pendingRestarts = new Set<Instance | Entry>()

  const keepOld = (entry: Entry, message: string): HostResult => {
    entry.kept = { title: `${entry.def.name} could not be started again`, message }
    notify(entry)
    return failure("module_start_failed", message, { moduleId: entry.def.id })
  }

  /** Start `rec` again with the settings it runs with; publish it and retire the old one, or keep the old one and say why. */
  const restartInstance = (entry: Entry, rec: Instance, generation: number, reason: string): Effect.Effect<HostResult> =>
    Effect.gen(function*() {
      const old = rec.running
      if (old === undefined || old.generation !== generation || entry.instances.get(rec.key) !== rec) return OK
      yield* Effect.logInfo(`Module ${entry.def.id} is being started again: ${reason}`)
      return yield* transaction((restore, candidates) =>
        Effect.gen(function*() {
          const result = yield* startCandidate(entry, rec, old.settings, entry.shared, restore, candidates)
          if (!result.ok) return keepOld(entry, result.message)
          if (entry.instances.get(rec.key) !== rec || rec.running !== old) return OK
          const clash = commit(entry, { adds: [[rec, result.running]] })
          if (clash !== undefined) return keepOld(entry, clash)
          rec.status = result.status
          entry.kept = undefined
          notify(entry)
          yield* retire(entry, [old])
          return OK
        })
      )
    })

  /** Start a new generation with the settings the current one runs with (`requestRestart` from `shared`). */
  const restartGeneration = (entry: Entry, run: SharedRun, reason: string): Effect.Effect<HostResult> =>
    Effect.gen(function*() {
      if (entry.shared !== run) return OK
      yield* Effect.logInfo(`Module ${entry.def.id} is being started again (a new generation): ${reason}`)
      const items: Array<GenerationItem> = [...entry.instances.values()].flatMap((rec): Array<GenerationItem> => {
        if (rec.running !== undefined) return [{ key: rec.key, ownKeys: rec.ownKeys, users: rec.users, settings: rec.running.settings, required: true }]
        const group = groupsOf(entry).find((g) => g.key === rec.key)
        if (group === undefined) return []
        return [{ key: rec.key, ownKeys: rec.ownKeys, users: rec.users, settings: group.resolved.value, required: false, ...(group.resolved.value === undefined ? { invalid: invalidMessage(group.resolved.form.errors) } : {}) }]
      })
      const outcome = yield* replaceGeneration(entry, { spec: run.spec, items })
      if (!outcome.ok) return keepOld(entry, outcome.message)
      notify(entry)
      return OK
    })

  /** Wait (up to 10 s) for the module's other operation to end, then restart. */
  const restartWhenFree = (entry: Entry, run: (e: Entry) => Effect.Effect<HostResult>, attempt: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!entry.busy) return Effect.asVoid(exclusive(entry.def.id, run))
      if (attempt >= 40) return Effect.logWarning(`Module ${entry.def.id} asked to be started again, but it stayed busy; not restarted`)
      return Effect.andThen(Effect.sleep(250), restartWhenFree(entry, run, attempt + 1))
    })

  /** `requestRestart` of one instance (from its `start`), or of the generation (from `shared`). Outside any turn. */
  const requestRestart = (entry: Entry, target: { readonly rec: Instance; readonly generation: number } | "all", reason: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      let key: Instance | Entry
      let run: (e: Entry) => Effect.Effect<HostResult>
      if (target === "all") {
        const current = entry.shared
        if (current === undefined) return Effect.void
        key = entry
        run = (e) => restartGeneration(e, current, reason)
      } else {
        if (target.rec.running?.generation !== target.generation) return Effect.void
        key = target.rec
        run = (e) => restartInstance(e, target.rec, target.generation, reason)
      }
      if (pendingRestarts.has(key)) return Effect.void
      pendingRestarts.add(key)
      const work = restartWhenFree(entry, run, 0).pipe(Effect.ensuring(Effect.sync(() => {
        pendingRestarts.delete(key)
      })))
      // The caller's turn (a tool asked) must not reach the new start, nor fibers it forks.
      return Effect.asVoid(Effect.forkIn(outsideTurns(work), hostScope))
    })

  /** `reportMissingProgram`: a required program failed to start; the app marks it missing, then every module is judged again. */
  const reportMissingProgram = (entry: Entry, tool: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const required = (entry.def.requires ?? []).some((r) => "tool" in r && r.tool === tool)
      if (!required || options.programMissing === undefined) return Effect.void
      options.programMissing(tool)
      return Effect.asVoid(Effect.forkIn(Effect.andThen(Effect.logWarning(`Module ${entry.def.id}: ${tool} could not be run; judging the modules again`), recheck), hostScope))
    })

  /**
   * The context members of a version 2 module, in `shared` (`target` "all") and in `start` (one instance). A later PR
   * adds its member here, one line, and its field in `ModuleServicesV2`.
   */
  function servicesFor(entry: Entry, target: { readonly rec: Instance; readonly generation: number } | "all"): ModuleServicesV2 {
    return {
      host: {
        view,
        service,
        contributions,
        actions,
        requestRestart: (reason) => requestRestart(entry, target, reason),
        reportMissingProgram: (tool) => reportMissingProgram(entry, tool)
      }
    }
  }

  for (const entry of entries) {
    entry.announced = demandKeyOf(entry)
  }
  refreshIssues()
  if (entries.some((e) => e.unavailable !== undefined)) rebuild()

  const settingOptions = (id: string): Readonly<Record<string, ReadonlyArray<ChoiceOption>>> | undefined => {
    const entry = byId.get(id)
    const instance = entry === undefined ? undefined : mainOf(entry)?.running?.instance
    if (instance?.settingOptions === undefined) return undefined
    try {
      return instance.settingOptions()
    } catch {
      return undefined
    }
  }

  return {
    issues,
    evaluate,
    recheck,
    checkHealth,
    actions,
    view,
    service,
    contributions,
    gateway,
    fieldAction,
    settingOptions,
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
