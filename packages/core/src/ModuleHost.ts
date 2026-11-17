import type {
  AssistantTemplate,
  ChoiceOption,
  ErrorInfo,
  FieldError,
  ModuleInfo,
  ModuleInstanceInfo,
  ModuleState,
  ModuleUnavailable,
  SettingField,
  SettingsForm,
  SettingsPatch,
  SettingValue,
  StatusLine
} from "@pva/protocol"
import { Cause, Clock, Effect, Exit, Scope, Stream } from "effect"
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
import { type AssistantModule, type ContextProvider, type Tool, toolMetadata } from "./Module.ts"
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
import type { FieldActionHandler, FieldActionResult } from "./ModuleContributions.ts"
import { type ModuleRoute, RouteTokenError, type RouteTokens, routeInfo, routeProblem, type RouteTokenStore } from "./ModuleRoutes.ts"
import { type ModuleDefinition, type ModuleInstance, ModuleStartError } from "./ModuleDefinition.ts"
import {
  applicableOwnValues,
  applySettingsPatch,
  checkOwnValues,
  isEditableSetting,
  overridableKeys,
  type ResolvedSettings,
  resolveSettings
} from "./Settings.ts"
import { CurrentTurn } from "./TurnContext.ts"
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
  /**
   * The module cannot run on this server (module API v2): the part has no tools and its `instructions` are the one
   * line that says so (`unavailableInstruction`).
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
  | { readonly ok: false; readonly code: "unknown_module" | "unknown_action" | "not_running" | "busy"; readonly message: string }

/** Time a field action's handler has (`ModuleHostOptions.fieldActionTimeoutMs`). Below the page's 10 s request limit. */
export const FIELD_ACTION_TIMEOUT_MS = 8_000

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
   * Press an `action` field (docs/UI-AND-MODULES.md §1.7): the definition's `fieldActions[key]` (runs without an
   * instance), else the running instance's (its instance with the shared settings), else the generated `test` of an
   * agent or decision provider (docs/AGENTS-AND-INTENTS.md §1.6). `values`: the page's draft, used only for an
   * `action` field with `requiresSaved: false` (applied over the saved settings; secrets stay the saved ones; a draft
   * value the field refuses is reported as the result). One press per field at a time (`busy`), 8 s each; afterwards
   * the module is announced again, so changed `info` values reach the page.
   */
  readonly fieldAction: (id: string, key: string, values?: Readonly<Record<string, unknown>>) => Effect.Effect<FieldActionHostResult>
  /** P3: the routes of every published shared part, live (a module that stops takes its routes with it). */
  readonly routes: () => ReadonlyArray<{ readonly moduleId: string; readonly route: ModuleRoute }>
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
  /** The gateway's later checks (P8: the risk policy and confirmation). */
  readonly gatewayHooks?: Pick<GatewayOptions, "risk" | "confirmation">
  /** The issue registry to keep the module issues in (the app adds its own). Default: a new one. */
  readonly issues?: IssueRegistry
  /** Time a module's `health()` may take. Default 5 s. */
  readonly healthTimeoutMs?: number
  /** P3: where route tokens are kept (serve mode: the key vault). Absent: `host.routeTokens` fails `unavailable`. */
  readonly routeTokens?: RouteTokenStore
  /** P3: time a field action may take. Default `FIELD_ACTION_TIMEOUT_MS`. */
  readonly fieldActionTimeoutMs?: number
}

interface Running {
  readonly scope: Scope.Closeable
  readonly instance: ModuleInstance
  readonly generation: number
  /** The instance's tools plus the generated action tools. */
  readonly tools: ReadonlyArray<Tool>
  readonly actions: ReadonlyArray<RegisteredAction>
}

/** A module's `shared` part while it runs: the shared settings it started with, its scope and what it returned. */
interface SharedRun {
  readonly key: string
  readonly scope: Scope.Closeable
  readonly part: SharedPart<unknown>
}

type SharedPrepared = { readonly ok: true; readonly run: SharedRun | undefined; readonly fresh: boolean } | { readonly ok: false; readonly message: string }

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
  /** Why it cannot run here (`unavailable`), judged at creation and on `recheck`; `undefined`: it can. */
  unavailable: ModuleUnavailable | undefined
  /** Its requirements as last judged. */
  statuses: ReadonlyArray<RequirementStatus>
  /** The last `requestRestart` that failed to start (the old instance kept serving); cleared by a successful start. */
  restartError: string | undefined
  /** The published `shared` part (version 2), while the module is demanded. */
  shared: SharedRun | undefined
  /** Why the `shared` part could not start (the module is then in `error`). */
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
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const gateway = makeExecutionGateway({ ...(options.access !== undefined ? { access: options.access } : {}), ...options.gatewayHooks })
  const issues = options.issues ?? makeIssueRegistry()
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
      generation: 0,
      unavailable: undefined,
      statuses: [],
      restartError: undefined,
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

  /** The module's own issues (source `module:<id>`): requirements, unavailable, a failed start or restart. */
  const moduleIssues = (entry: Entry): ReadonlyArray<Issue> => {
    const id = entry.def.id
    const name = entry.def.name
    const out: Array<Issue> = []
    // An error only for a module someone wants: an unused module missing a program does not fail `doctor`.
    const severity = wanted(entry) ? "error" : "warning"
    const page = { kind: "link", label: `Open ${name}`, value: `#settings/shared/modules/${id}` } as const
    for (const st of entry.statuses) {
      if (st.state !== "missing") continue
      const r = st.requirement
      const why = "why" in r && r.why !== undefined ? r.why : undefined
      out.push({
        id: `${id}.requires.${requirementKey(r)}`,
        module: id,
        severity: isOptionalRequirement(r) ? "warning" : severity,
        title: st.detail,
        detail: `${name} ${isOptionalRequirement(r) ? "can use it" : "needs it"}${why === undefined ? "." : `: ${why}${/[.!?]$/.test(why) ? "" : "."}`}`,
        ...(st.fix !== undefined ? { fix: st.fix } : {})
      })
    }
    if (entry.unavailable !== undefined && out.length === 0) {
      out.push({
        id: `${id}.unavailable`,
        module: id,
        severity,
        title: `${name} cannot run on this server`,
        detail: entry.unavailable.reason,
        ...(entry.unavailable.fix !== undefined ? { fix: entry.unavailable.fix } : {})
      })
    }
    const { state, error } = stateOf(entry)
    if (state === "error") {
      out.push({ id: `${id}.start`, module: id, severity: "error", title: `${name} could not start`, detail: error ?? "", fix: page })
    }
    if (entry.restartError !== undefined) {
      out.push({ id: `${id}.restart`, module: id, severity: "warning", title: `${name} could not be started again`, detail: `It keeps running as it was. ${entry.restartError}`, fix: page })
    }
    return out
  }

  /** The groups of effective settings the module should run with now (or with `stored`/`secrets`, a change being made). */
  const groupsOf = (entry: Entry, stored = entry.stored, secrets = entry.secrets): Array<Group> => {
    // A module that cannot run here is never started (it is `unavailable`, not `error`).
    if (entry.unavailable !== undefined) return []
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
    departing: [],
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
    for (const r of entry.instances.values()) if (r.running !== undefined && r.departing.includes(assistantId)) return r
    return undefined
  }

  /** The module's state from its instances: `error` when one fails, `starting` while one starts. */
  const stateOf = (entry: Entry): { readonly state: ModuleState; readonly error?: string } => {
    if (entry.unavailable !== undefined) return { state: "unavailable" }
    const all = [...entry.instances.values()]
    if (all.length === 0 && entry.sharedError !== undefined) return { state: "error", error: entry.sharedError }
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
      tools: [...tools.values()].map((t) => {
        const { risk, ...meta } = toolMetadata(t)
        return { name: t.name, description: t.description, speculative: t.speculative === true, ...(risk !== undefined ? { risk } : {}), ...meta }
      }),
      settings: decorateForm(entry, resolve(entry).form),
      revision: entry.revision,
      ...(entry.def.kind !== undefined ? { kind: entry.def.kind } : {}),
      ...(entry.demand !== undefined ? { instances: [...entry.instances.values()].map(instanceInfo) } : {}),
      ...(entry.unavailable !== undefined ? { unavailable: entry.unavailable } : {}),
      ...(entry.def.version !== undefined ? { version: entry.def.version } : {}),
      ...(entry.def.apiVersion !== undefined ? { apiVersion: entry.def.apiVersion } : {}),
      ...(entry.def.templates !== undefined && entry.def.templates.length > 0 ? { templates: templatesOf(entry) } : {}),
      ...((entry.shared?.part.routes?.length ?? 0) > 0 ? { routes: entry.shared!.part.routes!.map((r) => routeInfo(entry.def.id, r)) } : {})
    }
  }

  /**
   * The form as the page sees it (P3): `info` values and `combo` options from the running instance with the shared
   * settings (`info()`, `settingOptions()`; a throwing one gives nothing), and the generated `test` button of an
   * agent or decision provider. Never part of an instance's settings key.
   */
  const decorateForm = (entry: Entry, form: SettingsForm): SettingsForm => {
    const instance = mainOf(entry)?.running?.instance
    const read = <T>(f: (() => T) | undefined): T | undefined => {
      try {
        return f?.()
      } catch {
        return undefined
      }
    }
    const infos = read(instance?.info)
    const options = read(instance?.settingOptions)
    const generated = (entry.def.kind === "agent" || entry.def.kind === "decider") && !Object.hasOwn(entry.def.settings, "test")
    if (infos === undefined && options === undefined && !generated && !form.fields.some((f) => f.type === "combo")) return form
    const values: Record<string, SettingValue> = { ...form.values }
    const fields = form.fields.map((field): SettingField => {
      if (field.type === "info" && typeof infos?.[field.key] === "string") values[field.key] = infos[field.key]!.slice(0, 1000)
      if (field.type !== "combo") return field
      const extra = options?.[field.key]
      const known = new Set(field.options.map((o) => o.value))
      const added = (extra ?? []).filter((o) => !known.has(o.value) && (known.add(o.value), true))
      const note = instance === undefined ? "Not running: type a name" : extra !== undefined ? `${added.length + field.options.length} suggestions from ${entry.def.name}` : undefined
      return { ...field, options: [...field.options, ...added], ...(note !== undefined && field.optionsNote === undefined ? { optionsNote: note } : {}) }
    })
    if (generated) {
      fields.push({
        type: "action",
        key: "test",
        label: "Test",
        description: "Sends one short message and reports the first answer and how long it took.",
        apply: "live",
        buttonLabel: "Test",
        requiresSaved: true,
        source: "default"
      })
    }
    return { ...form, fields, values }
  }

  /** Field presses in progress (module id, key): a second press of the same button waits for the first. */
  const pressing = new Set<string>()

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
   * The part of a module that cannot run here but is wanted (C.4 option a): no tools, and one instructions line so the
   * assistant says it is not set up instead of improvising. Made once per reason, so the cached prompt prefix changes
   * only when availability changes.
   */
  const unavailableParts = new Map<Entry, ModulePart>()
  const unavailablePartOf = (entry: Entry, unavailable: ModuleUnavailable): ModulePart => {
    const line = unavailableInstruction(entry.def.name, unavailable.reason)
    let part = unavailableParts.get(entry)
    if (part === undefined || part.instructions !== line) {
      part = { moduleId: entry.def.id, module: { name: entry.def.id, tools: [], context: [] }, instructions: line, unavailable: true }
      unavailableParts.set(entry, part)
    }
    return part
  }

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
      const departed = [...entry.instances.values()].filter((r) => r.departing.length > 0)
      for (const r of departed) r.departing = []
      if (entry.leaving.size === 0) {
        if (departed.length > 0) rebuild()
        return Effect.void
      }
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
  const startInstance = <A>(entry: Entry, rec: Instance, settings: unknown, shared: SharedRun | undefined, adopt: (result: Started) => Effect.Effect<A>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Scope.make(), (scope) =>
        restore(startIn(entry, rec, settings, scope, shared)).pipe(
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
    shared: SharedRun | undefined,
    adopt: (results: ReadonlyArray<Started>) => Effect.Effect<A>
  ) =>
    Effect.uninterruptibleMask((restore) => {
      const opened: Array<Scope.Closeable> = []
      return Effect.forEach(items, ({ rec, settings }) =>
        Effect.flatMap(Scope.make(), (scope) =>
          restore(startIn(entry, rec, settings, scope, shared)).pipe(
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

  const startIn = (entry: Entry, rec: Instance, settings: unknown, scope: Scope.Closeable, shared: SharedRun | undefined) =>
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
      // Version 1 modules get exactly the context they always had; version 2 modules also get the host's services and
      // what their `shared` part returned.
      const refreshForm = () => {
        if (rec.running?.generation === generation) scheduleStatus(entry)
      }
      const context = (entry.def.apiVersion ?? 1) >= 2
        ? { settings: settings as never, setStatus, refreshForm, shared: shared?.part.value, ...servicesFor(entry, { rec, generation }) }
        : { settings: settings as never, setStatus }
      const exit = yield* Effect.suspend(() => entry.def.start(context)).pipe(
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
  const startOne = (entry: Entry, group: Group, rec: Instance, isNew: boolean, shared: SharedRun | undefined): Effect.Effect<HostResult> =>
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
        // The first instance of a new `shared` part publishes it (its services and contributions) with itself.
        return Effect.flatMap(shared === undefined ? Effect.succeed(undefined) : publishShared(entry, shared), (sharedClash) => {
          if (sharedClash !== undefined) return Effect.as(Scope.close(result.running.scope, Exit.void), startFailed(sharedClash))
          const clash = publish(entry, [[rec, result.running]])
          if (clash !== undefined) return Effect.as(Scope.close(result.running.scope, Exit.void), startFailed(clash))
          rec.status = result.status
          rec.state = "running"
          notify(entry)
          return Effect.succeed(OK)
        })
      }
      return yield* startInstance(entry, rec, resolved.value, shared, adopt).pipe(
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
  const reconcile = (
    entry: Entry,
    retry: boolean,
    sharedOptions: { readonly force?: boolean } = {}
  ): Effect.Effect<{ readonly result: HostResult; readonly changed: boolean }> =>
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
      if (changed) rebuild()
      return Effect.gen(function*() {
        // Version 2: the `shared` part runs while the module is demanded, before its instances (each gets its value).
        const demanded = isDemanded(entry)
        let run: SharedRun | undefined
        let fresh = false
        if (entry.def.shared !== undefined && demanded) {
          const prepared = yield* prepareShared(entry, sharedOptions)
          if (!prepared.ok) {
            entry.sharedError = prepared.message
            for (const { rec } of starts) {
              rec.state = "error"
              rec.error = prepared.message
            }
            notify(entry)
            yield* finishLeaving(entry)
            return { result: failure("module_start_failed", prepared.message, { moduleId: entry.def.id }), changed: true }
          }
          run = prepared.run
          fresh = prepared.fresh
          // Demanded through `uses` only (no instance to publish it with), or a new shared part with nothing to start.
          if (fresh && starts.length === 0 && run !== undefined) {
            const clash = yield* publishShared(entry, run)
            if (clash !== undefined) {
              yield* closeShared(run)
              entry.sharedError = clash
              notify(entry)
              return { result: failure("module_start_failed", clash, { moduleId: entry.def.id }), changed: true }
            }
            changed = true
            notify(entry)
          }
        }
        const results = yield* Effect.forEach(starts, ({ group, isNew, rec }) => startOne(entry, group, rec, isNew, run), { concurrency: starts.length > 1 ? "unbounded" : 1 }).pipe(
          Effect.ensuring(finishLeaving(entry))
        )
        // A new shared part that no instance adopted (every start failed) is not kept.
        if (fresh && run !== undefined && entry.shared !== run) yield* closeShared(run)
        // Demand ended: the shared part goes too, after the grace period (calls in flight finish).
        if (!demanded && entry.shared !== undefined) {
          const old = entry.shared
          entry.shared = undefined
          entry.sharedError = undefined
          yield* retireShared(entry, old)
          changed = true
        }
        if (!demanded) entry.sharedError = undefined
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

  /** The modules `entry` uses (transitively): their demand follows `entry`'s. */
  const usedBy = (entry: Entry): Array<Entry> => {
    const out: Array<Entry> = []
    const visit = (e: Entry) => {
      for (const id of e.def.uses ?? []) {
        const used = byId.get(id)
        if (used === undefined || used === entry || out.includes(used)) continue
        out.push(used)
        visit(used)
      }
    }
    visit(entry)
    return out
  }
  /** After `entry`'s own switch changed: bring the modules it uses in line (their shared parts follow the demand). */
  const refreshUsed = (entry: Entry) => Effect.forEach(usedBy(entry), refreshEntry, { discard: true })

  const enable = (id: string) =>
    Effect.tap(exclusiveEnable(id), () => Effect.suspend(() => (byId.get(id) === undefined ? Effect.void : refreshUsed(byId.get(id)!))))

  const disable = (id: string) =>
    Effect.tap(exclusiveDisable(id), () => Effect.suspend(() => (byId.get(id) === undefined ? Effect.void : refreshUsed(byId.get(id)!))))

  const exclusiveEnable = (id: string) =>
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

  const exclusiveDisable = (id: string) =>
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
          const force = Object.keys(patch.secrets).length > 0
          if ([...entry.instances.values()].some((r) => r.state === "error")) return (yield* reconcile(entry, true, { force })).result
          // A module demanded only through `uses`: its shared part follows the new settings.
          if (entry.def.shared !== undefined && isDemanded(entry)) return (yield* reconcile(entry, false, { force })).result
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
        // A changed shared part (its settings or a secret) is started first, and every instance again with its value.
        const sharedChanged = entry.def.shared !== undefined && isDemanded(entry) &&
          (secretsChanged || sharedSettingsOf(entry, patched.stored, patched.secrets).key !== entry.shared?.key)
        let sharedRun = entry.shared
        let sharedFresh = false
        if (sharedChanged) {
          const prepared = yield* prepareShared(entry, { stored: patched.stored, secrets: patched.secrets, force: true })
          if (!prepared.ok) return failure("module_start_failed", prepared.message, { moduleId: id })
          sharedRun = prepared.run
          sharedFresh = prepared.fresh
        }
        const dropShared = sharedFresh && sharedRun !== undefined ? closeShared(sharedRun) : Effect.void
        const next = new Map<string, Instance>()
        const fresh: Array<{ readonly rec: Instance; readonly settings: unknown; readonly group: Group }> = []
        for (const group of groups) {
          const existing = entry.instances.get(group.key)
          if (existing?.running !== undefined && !secretsChanged && !sharedChanged) {
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
        const adopted = yield* startMany(entry, fresh, sharedRun, (results): Effect.Effect<HostResult | undefined> => Effect.gen(function*() {
          const failed = results.find((r): r is Extract<Started, { ok: false }> => !r.ok)
          if (failed !== undefined) return yield* Effect.as(Effect.andThen(closeStarted(results), dropShared), failure("module_start_failed", failed.message, { moduleId: id }))
          // The new shared part's services and contributions are published with the instances, the old one retired.
          if (sharedFresh && sharedRun !== undefined) {
            const sharedClash = yield* publishShared(entry, sharedRun)
            if (sharedClash !== undefined) return yield* Effect.as(Effect.andThen(closeStarted(results), dropShared), failure("module_start_failed", sharedClash, { moduleId: id }))
          }
          const adds = results.map((r, i) => [fresh[i]!.rec, (r as Extract<Started, { ok: true }>).running] as const)
          const clash = publish(entry, adds, next)
          if (clash !== undefined) return yield* Effect.as(closeStarted(results), failure("module_start_failed", clash, { moduleId: id }))
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
          return yield* Effect.as(
            Effect.forEach(replaced, (r) => (r.running === undefined ? Effect.void : retire(entry, r.running)), { discard: true }),
            undefined
          )
        })).pipe(Effect.onInterrupt(() => dropShared))
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
      [
        ...entries.flatMap((e) => runningOf(e).map((r) => r.running!.scope)),
        ...entries.flatMap((e) => (e.shared === undefined ? [] : [e.shared.scope])),
        ...pendingShared,
        ...retired
      ],
      (scope) => Scope.close(scope, Exit.void),
      { concurrency: "unbounded", discard: true }
    )
  )

  const fieldAction = (id: string, key: string, values?: Readonly<Record<string, unknown>>): Effect.Effect<FieldActionHostResult> =>
    Effect.suspend((): Effect.Effect<FieldActionHostResult> => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed({ ok: false, code: "unknown_module", message: `There is no module "${id}"` } as const)
      const declared = Object.hasOwn(entry.def.settings, key) ? entry.def.settings[key]! : undefined
      if (declared !== undefined && declared.value !== "none") {
        return Effect.succeed({ ok: false, code: "unknown_action", message: `${entry.def.name}: "${key}" is not a button` } as const)
      }
      const instance = mainOf(entry)?.running?.instance
      const fromDefinition = entry.def.fieldActions?.[key] as FieldActionHandler | undefined
      const handler = fromDefinition ?? instance?.fieldActions?.[key] ?? (key === "test" && instance !== undefined ? generatedTest(instance) : undefined)
      if (handler === undefined) {
        const known = declared !== undefined || (key === "test" && (entry.def.kind === "agent" || entry.def.kind === "decider"))
        return Effect.succeed(
          known && instance === undefined
            ? { ok: false, code: "not_running", message: `${entry.def.name} is not running` } as const
            : { ok: false, code: "unknown_action", message: `${entry.def.name} has no action "${key}"` } as const
        )
      }
      const pressKey = `${id}\u0000${key}`
      if (pressing.has(pressKey)) return Effect.succeed({ ok: false, code: "busy", message: "That button is still running" } as const)
      // The settings it sees: the saved shared ones, or (requiresSaved: false) the page's draft over them.
      const useDraft = values !== undefined && declared !== undefined && (declared.describe(key) as { readonly requiresSaved?: boolean }).requiresSaved === false
      const prepared = useDraft ? draftSettings(entry, values) : { ok: true as const, settings: resolve(entry).value as Readonly<Record<string, unknown>> | undefined }
      if (!prepared.ok) return Effect.succeed({ ok: true, result: { ok: false, text: prepared.message.slice(0, 500), tone: "error" } } as const)
      pressing.add(pressKey)
      // Suspended: a handler that throws is reported like one that fails.
      return Effect.suspend(() => handler({ settings: prepared.settings ?? {}, draft: useDraft })).pipe(
        Effect.timeoutOrElse({
          duration: options.fieldActionTimeoutMs ?? FIELD_ACTION_TIMEOUT_MS,
          orElse: () => Effect.succeed<FieldActionResult>({ ok: false, text: `Did not finish within ${Math.round((options.fieldActionTimeoutMs ?? FIELD_ACTION_TIMEOUT_MS) / 1000)} s`, tone: "error" })
        }),
        Effect.catchCause((cause) => Effect.succeed<FieldActionResult>({ ok: false, text: `Failed: ${Cause.pretty(cause).split("\n")[0]}`.slice(0, 500), tone: "error" })),
        Effect.map((result) => ({ ok: true, result: { ...result, text: String(result.text).slice(0, 500) } }) as const),
        Effect.ensuring(Effect.sync(() => {
          pressing.delete(pressKey)
          // `info` values may have changed with the press.
          notify(entry)
        }))
      )
    })

  /** The shared settings with a page's draft applied (non-secret, editable, known fields only), or why not. */
  const draftSettings = (entry: Entry, values: Readonly<Record<string, unknown>>):
    | { readonly ok: true; readonly settings: Readonly<Record<string, unknown>> }
    | { readonly ok: false; readonly message: string } => {
    const spec = entry.def.settings
    const patchValues: Record<string, SettingValue> = {}
    for (const [k, v] of Object.entries(values)) {
      const setting = Object.hasOwn(spec, k) ? spec[k]! : undefined
      if (setting === undefined || setting.secret || !isEditableSetting(setting) || setting.env !== undefined && (options.env[setting.env] ?? "") !== "") continue
      patchValues[k] = v as SettingValue
    }
    const patched = applySettingsPatch(spec, { stored: entry.stored, secrets: entry.secrets, env: options.env, ...linked(entry) }, { values: patchValues, secrets: {} })
    if (!patched.ok) return { ok: false, message: `Not tested: ${patched.errors.map((e) => (e.key === null ? e.message : `${spec[e.key]?.describe(e.key).label ?? e.key}: ${e.message}`)).join("; ")}` }
    const resolved = resolve(entry, patched.stored, patched.secrets)
    if (resolved.value === undefined) return { ok: false, message: `Not tested: ${resolved.form.errors.map((e) => e.message).join("; ")}` }
    return { ok: true, settings: resolved.value as Readonly<Record<string, unknown>> }
  }

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
        entries.filter((e) => !e.busy && (switchedOn.has(e) || e.sharedError !== undefined || [...e.instances.values()].some((r) => r.state === "error"))),
        (entry) => exclusive(entry.def.id, (e) => Effect.map(reconcile(e, true), ({ result }) => result)),
        { concurrency: "unbounded", discard: true }
      )
    })

  const checkOwn = (id: string, own: Readonly<Record<string, unknown>>): ReadonlyArray<FieldError> => {
    const entry = byId.get(id)
    if (entry === undefined) return [{ key: null, message: `There is no module "${id}"` }]
    return checkOwnValues(entry.def.settings, own)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Module API v2: availability, health, the action catalogue, services, restarts

  const recheck = Effect.suspend(() => {
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
    // The instructions lines and the tools change from the next turn on; then start or retire the instances.
    rebuild()
    for (const entry of changed) notify(entry)
    return Effect.forEach(changed, refreshEntry, { concurrency: "unbounded", discard: true })
  })

  const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

  /** A module's own issues, made safe for the wire: its id as prefix and `module`, texts within their limits. */
  const normaliseIssues = (entry: Entry, list: ReadonlyArray<Issue>): ReadonlyArray<Issue> => {
    const id = entry.def.id
    return list.slice(0, 50).map((issue) => ({
      ...issue,
      id: clip(issue.id.startsWith(`${id}.`) ? issue.id : `${id}.${issue.id}`, 200),
      module: id,
      title: clip(issue.title, 200),
      detail: clip(issue.detail, 2000)
    }))
  }

  const checkHealth = Effect.forEach(
    entries,
    (entry) =>
      Effect.suspend(() => {
        const health = entry.def.health
        const source = `health:${entry.def.id}`
        if (health === undefined) return Effect.void
        if (entry.unavailable !== undefined) {
          issues.set(source, [])
          return Effect.void
        }
        const settings = resolve(entry).value
        const own = (title: string, detail: string): ReadonlyArray<Issue> => [{ id: `${entry.def.id}.health`, module: entry.def.id, severity: "warning", title, detail }]
        // Suspended: a health check that throws is reported like one that fails.
        return Effect.suspend(() => health({ settings, running: mainOf(entry) !== undefined })).pipe(
          Effect.timeoutOrElse({
            duration: healthTimeoutMs,
            orElse: () => Effect.succeed(own(`${entry.def.name}'s health check did not finish`, `It took longer than ${Math.round(healthTimeoutMs / 1000)} s.`))
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.succeed(own(`${entry.def.name}'s health check failed`, Cause.pretty(cause).split("\n")[0] ?? ""))
          ),
          Effect.flatMap((list) => Effect.sync(() => issues.set(source, normaliseIssues(entry, list))))
        )
      }),
    { concurrency: "unbounded", discard: true }
  )

  /** The instance an action lookup uses: the assistant's own one, or the main one. */
  const instanceUsedBy = (entry: Entry, assistantId: string | undefined): Instance | undefined => {
    if (entry.unavailable !== undefined) return undefined
    return assistantId !== undefined && entry.demand !== undefined ? instanceFor(entry, assistantId) : mainOf(entry)
  }

  /** The assistant may use this action (the gateway's own first two checks, so the catalogue lists what would run). */
  const offered = (assistantId: string | undefined, entry: Entry, action: RegisteredAction) => {
    const access = options.access
    if (assistantId === undefined || access === undefined) return true
    return access.moduleOn(assistantId, entry.def.id) && !access.toolOff(assistantId, entry.def.id, actionToolName(entry.def.id, action.definition.id))
  }

  const catalogEntry = (entry: Entry, action: RegisteredAction): CatalogAction => {
    const d = action.definition
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
      ...toolMetadata(d)
    }
  }

  /** The turn's catalogue: each module's actions from the instance the turn's assistant uses, as the gateway would admit them. */
  const catalogOf = (assistantId: string | undefined) =>
    entries.flatMap((entry) => {
      const running = instanceUsedBy(entry, assistantId)?.running
      if (running === undefined) return []
      return running.actions.filter((a) => offered(assistantId, entry, a)).map((action) => ({ entry, action }))
    })

  const actions: ModuleHostApi["actions"] = {
    list: Effect.gen(function*() {
      const turn = yield* CurrentTurn
      return catalogOf(turn?.assistantId).map(({ action, entry }) => catalogEntry(entry, action))
    }),
    run: (request: ActionRunRequest) =>
      Effect.gen(function*() {
        const refuse = (code: Extract<ActionRunResult, { ok: false }>["code"], message: string): ActionRunResult => ({ ok: false, code, message })
        const entry = byId.get(request.moduleId)
        if (entry === undefined) return refuse("unknown_module", `There is no module "${request.moduleId}"`)
        const turn = yield* CurrentTurn
        const running = instanceUsedBy(entry, turn?.assistantId)?.running
        if (running === undefined) {
          return turn?.assistantId !== undefined && mainOf(entry) !== undefined && entry.unavailable === undefined
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
          values = checkedActionValues(action, request.params)
        } catch (error) {
          return refuse("invalid_params", error instanceof Error ? error.message : String(error))
        }
        // Through the execution gateway, like every other way of running an action.
        return yield* gateway.action(action, values).pipe(
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

  // -- The shared part (version 2): once per module while it is demanded --------------------------------------------

  /** Scopes of shared parts started and not yet published or closed (closed at shutdown). */
  const pendingShared = new Set<Scope.Closeable>()

  /**
   * Demanded: wanted (its switch, or an assistant has it on), or named in `uses` by a demanded module (transitively).
   * A module that cannot run here is never demanded.
   */
  const isDemanded = (target: Entry): boolean => {
    if (target.unavailable !== undefined) return false
    const reached = new Set<Entry>()
    const stack = entries.filter((e) => e.unavailable === undefined && wanted(e))
    while (stack.length > 0) {
      const e = stack.pop()!
      if (reached.has(e)) continue
      reached.add(e)
      if (e === target) return true
      for (const id of e.def.uses ?? []) {
        const used = byId.get(id)
        if (used !== undefined && used.unavailable === undefined && !reached.has(used)) stack.push(used)
      }
    }
    return false
  }

  /** The shared settings: everything resolved except the fields an assistant may own; the key is their non-secret values. */
  const sharedSettingsOf = (entry: Entry, stored = entry.stored, secrets = entry.secrets) => {
    const resolved = resolve(entry, stored, secrets)
    const owned = new Set(overridableKeys(entry.def.settings))
    const without = (record: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(record).filter(([k]) => !owned.has(k)))
    return {
      key: JSON.stringify(without(resolved.form.values)),
      settings: resolved.value === undefined ? undefined : without(resolved.value as Record<string, unknown>),
      errors: resolved.form.errors
    }
  }

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

  const closeShared = (run: SharedRun): Effect.Effect<void> =>
    Effect.suspend(() => {
      pendingShared.delete(run.scope)
      return Scope.close(run.scope, Exit.void)
    })

  /** Close a replaced or no longer demanded shared part after the grace period (calls in flight finish). */
  const retireShared = (entry: Entry, run: SharedRun): Effect.Effect<void> =>
    Effect.suspend(() => {
      retired.add(run.scope)
      entry.retiring++
      return Effect.asVoid(Effect.forkIn(
        Effect.sleep(graceMs).pipe(
          Effect.andThen(Scope.close(run.scope, Exit.void)),
          Effect.ensuring(Effect.sync(() => {
            retired.delete(run.scope)
            entry.retiring--
            if (entry.instances.size === 0 && entry.retiring === 0 && entry.leaving.size === 0) notify(entry)
          }))
        ),
        hostScope
      ))
    })

  /**
   * Make `run` the module's published shared part (its services and contributions are looked up from now on) and
   * retire the one it replaces. Returns the clash, if another module provides one of its services by now.
   */
  const publishShared = (entry: Entry, run: SharedRun): Effect.Effect<string | undefined> =>
    Effect.suspend(() => {
      if (entry.shared === run) return Effect.succeed(undefined)
      const clash = serviceClash(entry, run.part)
      if (clash !== undefined) return Effect.succeed(clash)
      const old = entry.shared
      entry.shared = run
      entry.sharedError = undefined
      pendingShared.delete(run.scope)
      return Effect.as(old === undefined ? Effect.void : retireShared(entry, old), undefined)
    })

  /**
   * The shared part the module's instances should get: the published one while its shared settings are unchanged
   * (and not `force`d), else a new one, started (10 s) but not published: the caller publishes it with an instance,
   * or closes it. A start that fails, or a service another module provides already, is a start error.
   */
  const prepareShared = (
    entry: Entry,
    prepareOptions: { readonly stored?: Readonly<Record<string, unknown>>; readonly secrets?: Readonly<Record<string, string>>; readonly force?: boolean } = {}
  ): Effect.Effect<SharedPrepared> =>
    Effect.suspend((): Effect.Effect<SharedPrepared> => {
      const shared = entry.def.shared
      if (shared === undefined) return Effect.succeed({ ok: true, run: undefined, fresh: false })
      const { errors, key, settings } = sharedSettingsOf(entry, prepareOptions.stored, prepareOptions.secrets)
      if (prepareOptions.force !== true && entry.shared?.key === key) return Effect.succeed({ ok: true, run: entry.shared, fresh: false })
      if (settings === undefined) {
        return Effect.succeed({ ok: false, message: `The settings are not valid: ${errors.map((e) => e.message).join("; ")}` })
      }
      return Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(Scope.make(), (scope) => {
          pendingShared.add(scope)
          const context = { settings: settings as never, ...servicesFor(entry, "all") }
          return restore(
            Effect.suspend(() => shared(context)).pipe(
              Scope.provide(scope),
              Effect.timeoutOrElse({
                duration: startTimeoutMs,
                orElse: () => Effect.fail(new ModuleStartError({ message: `Its shared part did not start within ${Math.round(startTimeoutMs / 1000)} s` }))
              })
            )
          ).pipe(
            Effect.exit,
            Effect.flatMap((exit): Effect.Effect<SharedPrepared> => {
              if (Exit.isFailure(exit)) return Effect.as(closeShared({ key, scope, part: { value: undefined } }), { ok: false, message: describeStartFailure(exit.cause) })
              const clash = serviceClash(entry, exit.value) ?? routeProblem(exit.value.routes)
              if (clash !== undefined) return Effect.as(closeShared({ key, scope, part: exit.value }), { ok: false, message: clash })
              return Effect.succeed({ ok: true, run: { key, scope, part: exit.value }, fresh: true })
            })
          )
        })
      )
    })

  const service = <T>(key: ServiceKey<T>): T | undefined => {
    for (const entry of entries) {
      const found = entry.shared?.part.services?.find((p) => p.key.id === key.id)
      if (found !== undefined) return found.service as T
    }
    return undefined
  }

  const contributions = <T>(key: ContributionKey<T>): ReadonlyArray<T> =>
    entries.flatMap((entry) => (entry.shared?.part.contributions ?? []).filter((c) => c.key.id === key.id).map((c) => c.value as T))

  // -- Restarts ------------------------------------------------------------------------------------------------------

  /** Restarts asked for and not yet started (one per instance; repeated requests count once). */
  const pendingRestarts = new Set<Instance>()

  /** Start `rec` again with its settings; publish it and retire the old one, or keep the old one and say why. */
  const restartInstance = (entry: Entry, rec: Instance, generation: number, reason: string): Effect.Effect<HostResult> =>
    Effect.gen(function*() {
      const old = rec.running
      if (old === undefined || old.generation !== generation || entry.instances.get(rec.key) !== rec) return OK
      const group = groupsOf(entry).find((g) => g.key === rec.key)
      if (group === undefined || group.resolved.value === undefined) return OK
      yield* Effect.logInfo(`Module ${entry.def.id} is being started again: ${reason}`)
      const failed = (message: string): HostResult => {
        entry.restartError = message
        notify(entry)
        return failure("module_start_failed", message, { moduleId: entry.def.id })
      }
      return yield* startInstance(entry, rec, group.resolved.value, entry.shared, (result): Effect.Effect<HostResult> => {
        if (!result.ok) return Effect.succeed(failed(result.message))
        if (entry.instances.get(rec.key) !== rec || rec.running !== old) return Effect.as(Scope.close(result.running.scope, Exit.void), OK)
        const clash = publish(entry, [[rec, result.running]])
        if (clash !== undefined) return Effect.as(Scope.close(result.running.scope, Exit.void), failed(clash))
        rec.status = result.status
        entry.restartError = undefined
        notify(entry)
        return Effect.as(retire(entry, old), OK)
      })
    })

  /** Wait (up to 10 s) for the module's other operation to end, then restart. */
  const restartWhenFree = (entry: Entry, run: (e: Entry) => Effect.Effect<HostResult>, attempt: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!entry.busy) return Effect.asVoid(exclusive(entry.def.id, run))
      if (attempt >= 40) return Effect.logWarning(`Module ${entry.def.id} asked to be started again, but it stayed busy; not restarted`)
      return Effect.andThen(Effect.sleep(250), restartWhenFree(entry, run, attempt + 1))
    })

  /** `requestRestart` of one instance (from its `start`), or of every running instance (from `shared`). */
  const requestRestart = (entry: Entry, target: { readonly rec: Instance; readonly generation: number } | "all", reason: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const recs = target === "all"
        ? [...entry.instances.values()].filter((r) => r.running !== undefined).map((rec) => ({ rec, generation: rec.running!.generation }))
        : target.rec.running?.generation === target.generation ? [target] : []
      const todo = recs.filter(({ rec }) => !pendingRestarts.has(rec))
      if (todo.length === 0) return Effect.void
      for (const { rec } of todo) pendingRestarts.add(rec)
      const run = (e: Entry) =>
        Effect.map(Effect.forEach(todo, ({ generation, rec }) => restartInstance(e, rec, generation, reason)), (results) => results.find((r) => !r.ok) ?? OK)
      const work = restartWhenFree(entry, run, 0).pipe(Effect.ensuring(Effect.sync(() => {
        for (const { rec } of todo) pendingRestarts.delete(rec)
      })))
      return Effect.asVoid(Effect.forkIn(work, hostScope))
    })

  /**
   * The context members of a version 2 module, in `shared` (`target` "all") and in `start` (one instance). A later PR
   * adds its member here, one line, and its field in `ModuleServicesV2`.
   */
  function servicesFor(entry: Entry, target: { readonly rec: Instance; readonly generation: number } | "all"): ModuleServicesV2 {
    return {
      host: {
        routeTokens: routeTokensFor(entry.def.id),
        view,
        service,
        contributions,
        actions,
        requestRestart: (reason) => requestRestart(entry, target, reason)
      }
    }
  }

  for (const entry of entries) issues.set(`module:${entry.def.id}`, moduleIssues(entry))
  if (entries.some((e) => e.unavailable !== undefined)) rebuild()

  /** P3: `host.routeTokens` of one module. */
  function routeTokensFor(moduleId: string): RouteTokens {
    if (options.routeTokens !== undefined) return options.routeTokens.forModule(moduleId)
    const none = new RouteTokenError({ reason: "unavailable", message: "Route tokens are kept by the server (serve mode) only" })
    return { mint: () => Effect.fail(none), list: Effect.fail(none), revoke: () => Effect.fail(none) }
  }

  const routes = (): ReadonlyArray<{ readonly moduleId: string; readonly route: ModuleRoute }> =>
    entries.flatMap((entry) => (entry.shared?.part.routes ?? []).map((route) => ({ moduleId: entry.def.id, route })))

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
    recheck,
    checkHealth,
    actions,
    view,
    service,
    contributions,
    gateway,
    fieldAction,
    routes,
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
