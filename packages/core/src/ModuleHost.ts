import {
  type AssistantTemplate,
  type ChoiceOption,
  type ErrorInfo,
  type FieldError,
  HealthIssue,
  MAX_COMBO_OPTIONS,
  MAX_OPTIONS_JSON,
  MAX_ROUTE_DESCRIPTION,
  MODULE_ROUTES_PREFIX,
  type ModuleInfo,
  type ModuleInstanceInfo,
  type ModuleRouteInfo,
  type ModuleState,
  ModuleUnavailable,
  type SettingField,
  type SettingsForm,
  type SettingsPatch,
  type SettingValue,
  type StatusLine
} from "@pva/protocol"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, Schema, Scope, Semaphore, Stream } from "effect"
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
import { ToolError } from "./Errors.ts"
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
  type ProvidedContribution,
  type RequirementCheck,
  requirementKey,
  type RequirementStatus,
  type ServiceKey,
  type SharedPart
} from "./ModuleApi.ts"
import type { FieldActionHandler, FieldActionResult } from "./ModuleContributions.ts"
import { type FieldActionOwner, makeFieldActionOwner } from "./FieldActionOwner.ts"
import { type ModuleRoute, type PublishedRoute, RouteTokenError, routeInfo, routeProblem, type RouteTokens, type RouteTokenStore } from "./ModuleRoutes.ts"
import { makePageBoundary } from "./PageBoundary.ts"
import { makeStragglers, stragglerIssues } from "./Stragglers.ts"
import { type ModuleDefinition, type ModuleInstance, ModuleStartError } from "./ModuleDefinition.ts"
import {
  type Failure,
  type InstanceTarget,
  type ModuleCurrent,
  type ModulePlan,
  type ModuleTarget,
  planModule,
  reachedBy,
  type SharedTarget,
  usesOrder
} from "./ModulePlanner.ts"
import type { PartHandle, PartState, Registrar, RegisterResult, Registration, StartedPart } from "./ModuleRegistrations.ts"
import {
  applicableOwnValues,
  applySettingsPatch,
  checkOwnValues,
  isEditableSetting,
  overridableKeys,
  type ResolvedSettings,
  resolveSettings,
  type SettingsSpec
} from "./Settings.ts"
import { CurrentJob, CurrentPrincipal, CurrentTurn, type Principal } from "./TurnContext.ts"
import { makeToolRegistry, type ToolRegistry } from "./ToolRegistry.ts"

/**
 * The module host (docs/UI-AND-MODULES.md §1.4, docs/ASSISTANTS.md §2.6, docs/ARCHITECTURE.md "Module host"): owns
 * every module of the catalog for the life of the process and publishes an immutable snapshot (tool registry +
 * instructions) that each turn reads once at its start. Persistence is injected, so the host has no Node dependency.
 *
 * **It reconciles; it does not interleave.** Every trigger (configure, enable, disable, a change of the assistants,
 * the vault, Check again, `requestRestart`, refresh, startup, shutdown) only writes the **desired state** and then
 * waits for a reconciliation that began after its write. One reconciler fiber runs **passes**, never two at once: a
 * pass copies the desired state, asks the pure planner (`ModulePlanner.ts`) what to do for each module, starts what is
 * missing (independent modules concurrently, a module only after the shared parts it `uses` have started or failed
 * in this pass), then makes **one synchronous switch** that publishes the whole new picture (snapshot, services,
 * contributions and every other registration, `ModuleRegistrations.ts`) or, for a module whose new start failed,
 * keeps what it had and records why for Health; then it retires what was replaced (instances before their shared
 * part, consumers before their providers, after the grace period). Nothing else starts or stops module code.
 *
 * A module runs as **instances**. Without `demand` (the CLI modes, agents and decision providers) a module has at
 * most one, following its saved switch. With `demand` (serve mode's capabilities), a module runs while at least one
 * assistant wants it, one instance per distinct set of effective settings (the assistant's own values of
 * `overridable` fields over the shared ones over the linked defaults): assistants with equal settings share one. A
 * version 2 module's `shared` part and its instances are a **generation**: a new generation is published only if its
 * shared part and every one of its instances started.
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
  | { readonly ok: false; readonly code: "unknown_module" | "unknown_action" | "not_running" | "busy"; readonly message: string }

export type { PublishedRoute } from "./ModuleRoutes.ts"

/** Time a field action's handler has (`ModuleHostOptions.fieldActionTimeoutMs`). Below the page's 10 s request limit. */
export const FIELD_ACTION_TIMEOUT_MS = 8_000
/**
 * Time a stopped field action's interruption (its finalizers) may take in the background before the host logs it
 * (`ModuleHostOptions.fieldActionCleanupMs`). The press was answered at its deadline already; its button stays busy
 * until it has really ended (`FieldActionOwner`).
 */
export const FIELD_ACTION_CLEANUP_MS = 10_000
/** Presses of one module that did not stop within the cleanup limit before its buttons are refused (`Stragglers`). */
export const MAX_PRESS_STRAGGLERS = 4

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
  /**
   * Switch it on (saved), and wait for a reconciliation that began after the switch: the result is how it then
   * stands (its start error, or `invalid_settings`). Refused `not_allowed` for a module with demand (the assistants
   * switch it on and off). An interrupted caller stops waiting; the switch stays.
   */
  readonly enable: (id: string) => Effect.Effect<HostResult>
  /** Switch it off (saved); see `enable`. */
  readonly disable: (id: string) => Effect.Effect<HostResult>
  /**
   * Change the shared settings. `includeHidden`: also save fields hidden by `visibleWhen` (moving values out of
   * `.env`). The new settings are proposed to the reconciler: only the instances whose effective settings change are
   * restarted (all of them when a secret changes; a changed shared setting starts a new generation). If what runs
   * now would be replaced and a start fails, nothing changes, nothing is saved and Health says why; otherwise they
   * are saved once switched to. `busy` while an earlier configure of the same module is still being applied.
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
   * instance; the host owns the press), else the published main instance's (its instance with the shared settings;
   * that instance's part owns the press), else the generated `test` of an agent or decision provider
   * (docs/AGENTS-AND-INTENTS.md §1.6). `values`: the page's draft, used only for an `action` field with
   * `requiresSaved: false` (applied over the saved settings; secrets stay the saved ones; a draft value the field
   * refuses is reported as the result). One press per field and owner at a time (`busy`), 8 s each; afterwards the
   * module is announced again, so changed `info` values reach the page. Refused `not_running` once the host closes.
   */
  readonly fieldAction: (id: string, key: string, values?: Readonly<Record<string, unknown>>) => Effect.Effect<FieldActionHostResult>
  /**
   * P3: the routes of every published shared part, live: one registration kind ("route") of the part, published and
   * withdrawn in the reconciler's switch (a module that stops or is replaced takes its routes with it at that switch).
   */
  readonly routes: () => ReadonlyArray<PublishedRoute>
  /**
   * P3: the page boundary (`PageBoundary`) for module-produced text the app shows itself (route descriptions and the
   * route call log): every secret the module was given since the host started, and every one known now, replaced by
   * `[secret]`, then clipped to `max` characters.
   */
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
  /**
   * P3: a route as an admin page shows it (`ModuleInfo.routes`, the admin route view): what the module declared
   * passes the boundary (a path that holds a secret shown redacted, such a token name left out, the description
   * redacted and clipped). The live route is unchanged.
   */
  readonly routeView: (moduleId: string, route: ModuleRoute) => ModuleRouteInfo
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
  /** The values contributed under a key, for the calling fiber's assistant (`ModuleHostApi.contributions`). */
  readonly contributions: ModuleHostApi["contributions"]
  /** The same for an assistant named explicitly, `undefined` for every provider (`ModuleHostApi.contributionsFor`). */
  readonly contributionsFor: ModuleHostApi["contributionsFor"]
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
  /** Time closing the host may take (the shutdown reconciliation and pending saves). Default 30 s. */
  readonly closeTimeoutMs?: number
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
  /**
   * More kinds of registration (`ModuleRegistrations.ts`), after the host's own: for a kind the app keeps itself, and
   * for tests. A kind the core keeps (P3's routes, P6's job handlers) goes in the host's `registrars` list instead.
   */
  readonly registrars?: ReadonlyArray<Registrar>
  /** P3: where route tokens are kept (serve mode: the key vault). Absent: `host.routeTokens` fails `unavailable`. */
  readonly routeTokens?: RouteTokenStore
  /** P3: time a field action may take. Default `FIELD_ACTION_TIMEOUT_MS`. */
  readonly fieldActionTimeoutMs?: number
  /** P3: time a stopped field action's cleanup may take before it is logged (it is still waited for). Default `FIELD_ACTION_CLEANUP_MS`. */
  readonly fieldActionCleanupMs?: number
}

// ---------------------------------------------------------------------------------------------------------------------
// Internal state

/** The settings a module plans with: committed (saved) ones, or a configure's proposal. */
interface Sources {
  readonly stored: Readonly<Record<string, unknown>>
  readonly secrets: Readonly<Record<string, string>>
  /** Counts configured secret changes: a new one restarts every part (a vault lock or unlock does not count). */
  readonly secretEpoch: number
}

/** A configure waiting for the reconciler: tried in the next pass, then saved or dropped. */
interface Proposal extends Sources {
  readonly token: object
  /** The vault epoch it was made at: a vault report since wins over its secrets when it is saved. */
  readonly vaultEpoch: number
}

/** One start of a module's code (a shared part or an instance): its scope, registrations and place in its life. */
interface Part {
  readonly id: number
  readonly entry: Entry
  readonly kind: "shared" | "instance"
  /** The instance key ("" for a shared part). */
  readonly key: string
  readonly fingerprint: string
  readonly scope: Scope.Closeable
  /** When its start began (Clock ms): a restart asked for later is not satisfied by it. */
  readonly startedAt: number
  state: PartState
  closing: Deferred.Deferred<void> | undefined
  closed: boolean
  /** Its registrations: staged while it starts, live while it is, withdrawn after. */
  readonly registrations: Array<Registration>
  /** `requestRestart` called during its own start: applied once it is published, dropped if it is discarded. */
  stagedRestart: string | undefined
  readonly handle: PartHandle
  /**
   * P3: an instance part's field-action presses (its handlers, a generated Test). Made with the part, stopped by
   * `closePart` before the part's scope closes (so a press has ended, its cleanup run, before the instance's
   * resources and then its shared part's are released); refuses new presses from then on.
   */
  readonly presses: FieldActionOwner | undefined
}

interface Running {
  readonly part: Part
  readonly instance: ModuleInstance
  /** The instance's tools plus the generated action tools (guarded: refused once the part is closed). */
  readonly tools: ReadonlyArray<Tool>
  readonly actions: ReadonlyArray<RegisteredAction>
  /** The settings it was started with: a restart reuses them (a vault locked since cannot stop it). */
  readonly settings: unknown
  readonly secretEpoch: number
}

/** A module's started shared part (version 2), with the settings and sources it started with. */
interface SharedRun {
  readonly part: Part
  readonly key: string
  readonly value: SharedPart<unknown>
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
  readonly defaults: Readonly<Record<string, unknown>> | undefined
  readonly secretEpoch: number
}

/** One instance as the module's info shows it: running, starting, or in error. */
interface Instance {
  readonly key: string
  ownKeys: ReadonlyArray<string>
  users: ReadonlyArray<string>
  state: "starting" | "running" | "error"
  error: string | undefined
  /** Field errors of settings that are not valid (`invalid_settings`). */
  fieldErrors: ReadonlyArray<FieldError> | undefined
  status: StatusLine | undefined
  running: Running | undefined
}

interface Entry {
  readonly def: ModuleDefinition<any>
  /** Position in `uses` order (providers first). */
  rank: number
  // -- desired state ----------------------------------------------------------------------------------------------
  /** The saved switch (read only for a module without demand). */
  enabled: boolean
  /** The owner has chosen on or off (saved); before that, `enabledByDefault` / `enabledWhenSet` decide. */
  chosen: boolean
  committed: Sources
  /** The secrets the vault reports (and configure changes). */
  secrets: Readonly<Record<string, string>>
  vaultEpoch: number
  proposal: Proposal | undefined
  /** Who wants it, as last read; `undefined`: no demand (it follows its switch). */
  demand: ReadonlyArray<ModuleDemand> | undefined
  /** Its linked defaults, as last read. */
  defaults: Readonly<Record<string, unknown>> | undefined
  /** Why it cannot run here (`unavailable`), judged at creation and on `recheck`. */
  unavailable: ModuleUnavailable | undefined
  statuses: ReadonlyArray<RequirementStatus>
  /** The catalogue itself is wrong for it (its `uses` form a cycle): an error, never started. */
  readonly catalogError: string | undefined
  restartShared: number
  readonly restartInstances: Map<string, number>
  /** A failed start is tried again only after this changes. */
  retry: number
  restartTimes: Array<number>
  restartLater: boolean
  // -- current state ----------------------------------------------------------------------------------------------
  /** The published shared part. */
  shared: SharedRun | undefined
  /** By key: the published instances, and those in error or starting. */
  instances: Map<string, Instance>
  /** A first generation is starting (shown as `starting` while it has no instances). */
  starting: boolean
  failedGeneration: Failure | undefined
  readonly failedInstances: Map<string, Failure>
  /** A new generation or a restart that failed while the old one kept serving (title and why). */
  kept: { readonly title: string; readonly message: string } | undefined
  /** Why its generation could not start while none runs (the module is in `error`). */
  generationError: string | undefined
  generationFieldErrors: ReadonlyArray<FieldError> | undefined
  // -- announcements ----------------------------------------------------------------------------------------------
  revision: number
  announced: string
}

/** The instance targets the host plans with: the planner's, plus the settings to start with. */
interface HostInstanceTarget extends InstanceTarget {
  readonly resolved: ResolvedSettings<unknown>
  readonly secretEpoch: number
}

interface HostSharedTarget extends SharedTarget {
  readonly spec: SharedSpec
}

interface HostTarget extends ModuleTarget {
  readonly shared: HostSharedTarget | undefined
  readonly instances: ReadonlyArray<HostInstanceTarget>
}

type StartResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string; readonly part?: Part }

/** What one pass started for one module. */
interface ModuleStarts {
  shared: StartResult<SharedRun> | undefined
  readonly instances: Map<string, StartResult<Running & { readonly status: StatusLine | undefined }>>
}

/** One module in a pass: what it planned with, and what it decided. */
interface PassItem {
  readonly entry: Entry
  readonly target: HostTarget
  readonly plan: ModulePlan
  readonly retry: number
  readonly proposal: Proposal | undefined
  /** Something of it was published when the pass began. */
  readonly live: boolean
}

const failure = (code: ErrorInfo["code"], message: string, extra: Partial<ErrorInfo> = {}): HostResult => ({
  ok: false,
  error: { code, message, ...extra }
})

const OK: HostResult = { ok: true }

/**
 * The instructions line of a module an assistant has on that cannot run here (module-definition §C.4, option a): the
 * assistant says it is not set up in one sentence instead of improvising, and no tool round is spent on it.
 */
export const unavailableInstruction = (name: string, reason: string): string =>
  `${name} is not set up on this server (${reason.replace(/[.!?]+$/, "")}). If you are asked for anything it does, say so in one sentence; the owner can fix it in the admin page under Diagnostics › Health.`

/** What an unavailable module's declared action answers on the intent path (§C.4): one spoken sentence. */
export const unavailableLine = (name: string, reason: string): string => `${name} is not set up on this server (${reason.replace(/[.!?]+$/, "")}).`

/**
 * Module code started by the host runs outside any turn, job or principal, whoever asked for the start (a tool's
 * restart): a `start`, a `shared`, a field action, a route handler (the app's router uses it too).
 */
export const outsideTurns = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(CurrentTurn, undefined), Effect.provideService(CurrentJob, undefined), Effect.provideService(CurrentPrincipal, undefined))

const isWireIssue = Schema.is(HealthIssue)

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** An unavailable reason made safe for the wire's `ModuleUnavailable` (reason ≤ 500, the fix's label ≤ 200, value ≤ 1000). */
const wireUnavailable = (u: ModuleUnavailable): ModuleUnavailable => {
  const reason = clip(String(u.reason ?? ""), 500)
  const out: ModuleUnavailable = {
    reason,
    ...(u.fix !== undefined ? { fix: { kind: u.fix.kind, label: clip(String(u.fix.label ?? ""), 200), ...(u.fix.value !== undefined ? { value: clip(String(u.fix.value), 1000) } : {}) } } : {})
  }
  // A fix the wire does not know (its kind) is left out rather than breaking the module's info.
  return isWireUnavailable(out) ? out : { reason }
}
const isWireUnavailable = Schema.is(ModuleUnavailable)

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
      if (component.length > 1 || (edges.get(v) ?? []).includes(v)) {
        const cycle = [...component].reverse()
        for (const id of component) out.set(id, cycle)
      }
    }
  }
  for (const d of catalog) if (!index.has(d.id)) visit(d.id)
  return out
}

/** Restarts a module may ask for in `RESTART_WINDOW_MS` before later ones wait (a module that restarts itself in a loop). */
const RESTART_BUDGET = 5
const RESTART_WINDOW_MS = 30_000

export const makeModuleHost = Effect.fnUntraced(function*(options: ModuleHostOptions) {
  const hostScope = yield* Effect.scope
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const graceMs = options.graceMs ?? 10_000
  const contextTimeoutMs = options.contextTimeoutMs ?? 50
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const closeTimeoutMs = options.closeTimeoutMs ?? 30_000
  const local = options.localPrincipal ?? options.access === undefined
  const gateway = makeExecutionGateway({
    ...(options.access !== undefined ? { access: options.access } : {}),
    ...options.gatewayHooks,
    withoutPrincipal: local ? "local" : "refuse"
  })
  const issues = options.issues ?? makeIssueRegistry()
  const listeners = new Set<(info: ModuleInfo) => void>()

  // -- The catalogue --------------------------------------------------------------------------------------------------

  const ids = new Set<string>()
  const cycles = usesCycles(options.catalog)
  const entries: Array<Entry> = options.catalog.map((def) => {
    if (ids.has(def.id)) throw new Error(`Two modules have the id "${def.id}"`)
    ids.add(def.id)
    const record = options.persistence.initial.modules[def.id]
    const cycle = cycles.get(def.id)
    const secrets = options.persistence.initial.secrets[def.id] ?? {}
    return {
      def,
      rank: 0,
      enabled: record?.enabled ?? def.enabledByDefault,
      chosen: record?.enabled !== undefined,
      committed: { stored: record?.settings ?? {}, secrets, secretEpoch: 0 },
      secrets,
      vaultEpoch: 0,
      proposal: undefined,
      demand: undefined,
      defaults: options.defaults?.(def.id),
      unavailable: undefined,
      statuses: [],
      catalogError: cycle === undefined ? undefined : `Its "uses" form a cycle (${[...cycle, cycle[0]].join(" → ")}), so it cannot start. Fix the module catalogue.`,
      restartShared: 0,
      restartInstances: new Map(),
      retry: 0,
      restartTimes: [],
      restartLater: false,
      shared: undefined,
      instances: new Map(),
      starting: false,
      failedGeneration: undefined,
      failedInstances: new Map(),
      kept: undefined,
      generationError: undefined,
      generationFieldErrors: undefined,
      revision: 0,
      announced: ""
    }
  })
  const byId = new Map(entries.map((e) => [e.def.id, e]))
  const order = usesOrder(entries.map((e) => ({ id: e.def.id, uses: e.def.uses ?? [] })), new Set(cycles.keys()))
  order.forEach((id, i) => {
    byId.get(id)!.rank = i
  })
  /** Entries in `uses` order: providers before the modules that use them. */
  const ordered = [...entries].sort((a, b) => a.rank - b.rank)
  const envOrigin = {
    ...(options.envOrigin !== undefined ? { envOrigin: options.envOrigin } : {}),
    ...(options.envLocation !== undefined ? { envLocation: options.envLocation } : {})
  }

  /** The module's settings from `src` (with the linked defaults given, else its current ones). */
  const resolveFrom = (entry: Entry, src: Pick<Sources, "stored" | "secrets">, own?: Readonly<Record<string, unknown>>, defaults = entry.defaults) =>
    resolveSettings(entry.def.settings, {
      stored: src.stored,
      secrets: src.secrets,
      env: options.env,
      ...envOrigin,
      ...(defaults !== undefined ? { defaults } : {}),
      ...(own !== undefined ? { own } : {})
    })
  /** The committed settings (what the form shows), with the vault's secrets. */
  const committedSources = (entry: Entry): Sources => ({ ...entry.committed, secrets: entry.secrets })
  const resolve = (entry: Entry) => resolveFrom(entry, committedSources(entry))
  /** What the reconciler plans with: a configure's proposal, else the committed settings. */
  const planning = (entry: Entry): Sources => entry.proposal ?? committedSources(entry)

  const invalidMessage = (errors: ReadonlyArray<FieldError>) => `The settings are not valid: ${errors.map((e) => e.message).join("; ")}`

  // -- P3: what reaches the admin page; field-action presses ----------------------------------------------------------

  /** The secret fields of a module. */
  const secretKeys = (entry: Entry) => Object.entries(entry.def.settings as SettingsSpec).flatMap(([key, setting]) => (setting.secret ? [key] : []))
  /**
   * THE boundary for module-produced text on its way to a page (`PageBoundary`): it redacts every secret the module
   * was given (`given`) and every one known now (saved, environment), before anything is clipped.
   */
  const boundary = makePageBoundary({
    current: (moduleId) => {
      const entry = byId.get(moduleId)
      if (entry === undefined) return []
      return secretKeys(entry).flatMap((key) => {
        const env = entry.def.settings[key]!.env
        const proposed = entry.proposal?.secrets[key]
        return [entry.secrets[key] ?? "", entry.committed.secrets[key] ?? "", proposed ?? "", env === undefined ? "" : options.env[env] ?? ""]
      })
    }
  })
  /**
   * Module code is about to get `settings`: the boundary keeps their secret values for as long as `holders` live (the
   * part that receives them, a press until it has ended and been answered, a health check), whatever the vault does
   * meanwhile.
   */
  const given = <T>(entry: Entry, holders: ReadonlyArray<object>, settings: T): T => {
    if (typeof settings === "object" && settings !== null) {
      const record = settings as Readonly<Record<string, unknown>>
      const values = secretKeys(entry).map((key) => (Object.hasOwn(record, key) ? record[key] : undefined))
      for (const holder of holders) boundary.remember(entry.def.id, holder, values)
    }
    return settings
  }
  const fieldActionTimeoutMs = options.fieldActionTimeoutMs ?? FIELD_ACTION_TIMEOUT_MS
  const fieldActionCleanupMs = options.fieldActionCleanupMs ?? FIELD_ACTION_CLEANUP_MS
  /**
   * Presses of each module that did not stop when asked (across all its owners, so restarts cannot pile them up): at
   * `MAX_PRESS_STRAGGLERS` its buttons are refused until some end, and Health says so.
   */
  const pressStragglers = makeStragglers({
    cap: MAX_PRESS_STRAGGLERS,
    cleanupMs: fieldActionCleanupMs,
    changed: (moduleId, count) => {
      const entry = byId.get(moduleId)
      if (entry !== undefined) issues.set(`presses:${moduleId}`, stragglerIssues(moduleId, entry.def.name, "presses", count, MAX_PRESS_STRAGGLERS))
    }
  })
  /** An owner of field-action presses (`FieldActionOwner`): an instance part's (keys are field keys), or the host's (`<module>/<key>`). */
  const pressOwner = (label: (key: string) => string, released: (key: string) => void, moduleOf: (key: string) => string) =>
    makeFieldActionOwner({ label, cleanupMs: fieldActionCleanupMs, released, stragglers: pressStragglers, moduleOf })
  /**
   * The host's own presses (a definition's `fieldActions`, which run without an instance), keyed `<module>/<key>`:
   * made once with the host, stopped first when it closes (before anything else stops), refusing presses from then on.
   */
  const moduleOfKey = (key: string) => key.slice(0, key.indexOf("/"))
  const hostPresses = pressOwner((key) => `field action ${key.replace("/", ".")}`, (key) => {
    const entry = byId.get(moduleOfKey(key))
    // `info` values may have changed with the press.
    if (entry !== undefined) announce(entry)
  }, moduleOfKey)

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
      const { arch, os } = def.platforms
      if (os !== undefined && os.length > 0 && !os.includes(platform.os)) {
        return { unavailable: wireUnavailable({ reason: `Runs on ${os.join(" or ")}; this server runs ${platform.os}.` }), statuses: [] }
      }
      if (arch !== undefined && arch.length > 0 && !arch.includes(platform.arch)) {
        return { unavailable: wireUnavailable({ reason: `Runs on ${arch.join(" or ")} processors; this server has ${platform.arch}.` }), statuses: [] }
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
      // What reaches the wire is clipped here, once: a probe's long error cannot break the module or admin messages.
      unavailable: missing === undefined ? undefined : wireUnavailable({ reason: missing.detail, ...(missing.fix !== undefined ? { fix: missing.fix } : {}) }),
      statuses
    }
  }
  const judgeAll = (): Array<Entry> => {
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
    return changed
  }
  judgeAll()

  // -- Desired state: who wants what ----------------------------------------------------------------------------------

  const isLive = (entry: Entry) => entry.shared !== undefined || [...entry.instances.values()].some((r) => r.running !== undefined)

  /**
   * Its own switch: the owner's choice; before one, on by default, or on while the `enabledWhenSet` key is set
   * (environment, saved or the vault). A module switched on by its key that runs keeps running when the vault locks.
   */
  const switchOn = (entry: Entry): boolean => {
    if (entry.chosen) return entry.enabled
    const key = entry.def.enabledWhenSet
    if (entry.def.enabledByDefault || key === undefined) return entry.def.enabledByDefault
    if (resolveFrom(entry, planning(entry)).form.secrets[key]?.set === true) return true
    return isLive(entry)
  }

  /** Someone wants the module now (its switch, or an assistant has it on). */
  const wanted = (entry: Entry) => (entry.demand === undefined ? switchOn(entry) : entry.demand.length > 0)

  /** The modules demand reaches (directly or through `uses`), able to run or not. */
  const reached = (): Set<Entry> => {
    const ids = reachedBy(entries.map((e) => ({
      id: e.def.id,
      wanted: e.catalogError === undefined && wanted(e),
      blocked: e.unavailable !== undefined || e.catalogError !== undefined,
      uses: e.catalogError === undefined ? e.def.uses ?? [] : []
    })))
    return new Set(entries.filter((e) => ids.has(e.def.id)))
  }

  /** The modules `entry` names in `uses` that are in the catalogue. */
  const providersOf = (entry: Entry): ReadonlyArray<Entry> =>
    entry.catalogError !== undefined ? [] : (entry.def.uses ?? []).flatMap((id) => {
      const used = byId.get(id)
      return used === undefined ? [] : [used]
    })

  /** The shared settings: everything resolved except the fields an assistant may own; the key is their non-secret values. */
  const sharedSpecOf = (entry: Entry, src: Sources): SharedSpec => {
    const resolved = resolveFrom(entry, src)
    const owned = new Set(overridableKeys(entry.def.settings))
    const without = (record: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(record).filter(([k]) => !owned.has(k)))
    // Only the fields the shared part receives are judged here: an assistant-owned field's invalid shared default
    // does not stop it (each instance validates its own effective settings in full).
    const errors = resolved.form.errors.filter((e) => e.key === null || !owned.has(e.key))
    const values = without(resolved.form.values)
    const raw = without(resolved.value ?? (resolvedRaw(entry, src) as Record<string, unknown>))
    return {
      key: JSON.stringify(values),
      settings: errors.length === 0 ? raw : undefined,
      errors,
      stored: src.stored,
      secrets: src.secrets,
      defaults: entry.defaults,
      secretEpoch: src.secretEpoch
    }
  }

  /** The resolved values even where some field is invalid (an overridable field's): secrets included. */
  const resolvedRaw = (entry: Entry, src: Sources) => {
    const form = resolveFrom(entry, src).form
    const out: Record<string, unknown> = { ...form.values }
    for (const [key, setting] of Object.entries(entry.def.settings as SettingsSpec)) {
      if (!setting.secret) continue
      const fromEnv = setting.env !== undefined && (options.env[setting.env] ?? "") !== "" ? options.env[setting.env] : undefined
      const saved = src.secrets[key]
      out[key] = fromEnv ?? (saved !== undefined && saved.length > 0 ? saved : undefined)
    }
    return out
  }

  /** What the desired state asks of a module (`ModulePlanner.ModuleTarget`), with the settings to start with. */
  const targetOf = (entry: Entry, demanded: ReadonlySet<Entry>, runAtAll: boolean): HostTarget => {
    const id = entry.def.id
    const runs = runAtAll && demanded.has(entry) && entry.unavailable === undefined && entry.catalogError === undefined
    if (!runs) return { id, runs: false, shared: undefined, instances: [] }
    const src = planning(entry)
    let shared: HostSharedTarget | undefined
    if (entry.def.shared !== undefined) {
      const spec = sharedSpecOf(entry, src)
      // Equal non-secret values and no configured secret since: it starts with what the live one runs with (a
      // vault locked since does not make it invalid).
      const retained = entry.shared !== undefined && entry.shared.key === spec.key && entry.shared.spec.secretEpoch === src.secretEpoch
      shared = {
        key: spec.key,
        invalid: spec.settings === undefined && !retained ? invalidMessage(spec.errors) : undefined,
        fingerprint: JSON.stringify([spec.key, src.secretEpoch, entry.restartShared]),
        spec
      }
    }
    const generation = shared?.fingerprint ?? ""
    const groups = new Map<string, { users: Array<string>; ownKeys: Array<string>; resolved: ResolvedSettings<unknown> }>()
    const add = (assistantId: string | undefined, own: Readonly<Record<string, unknown>> | undefined) => {
      const resolved = resolveFrom(entry, src, own)
      const key = JSON.stringify(resolved.form.values)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { users: assistantId === undefined ? [] : [assistantId], ownKeys: Object.keys(own ?? {}), resolved })
      else {
        if (assistantId !== undefined) group.users.push(assistantId)
        for (const k of Object.keys(own ?? {})) if (!group.ownKeys.includes(k)) group.ownKeys.push(k)
      }
    }
    if (entry.demand === undefined) add(undefined, undefined)
    else for (const d of entry.demand) add(d.assistantId, applicableOwnValues(entry.def.settings, d.own))
    const instances = [...groups].map(([key, g]): HostInstanceTarget => ({
      key,
      users: g.users,
      ownKeys: g.ownKeys,
      invalid: g.resolved.value === undefined && !retainedInstance(entry, key, src.secretEpoch) ? invalidMessage(g.resolved.form.errors) : undefined,
      fingerprint: JSON.stringify([generation, key, src.secretEpoch, entry.restartInstances.get(key) ?? 0]),
      resolved: g.resolved,
      secretEpoch: src.secretEpoch
    }))
    return { id, runs: true, shared, instances }
  }

  /** A live instance of this key started with the same configured secrets: a restart reuses its settings. */
  const retainedInstance = (entry: Entry, key: string, secretEpoch: number) => {
    const live = entry.instances.get(key)?.running
    return live !== undefined && live.secretEpoch === secretEpoch
  }

  /** What the planner needs of what is published. */
  const currentOf = (entry: Entry): ModuleCurrent => ({
    generation: entry.shared?.part.fingerprint,
    instances: new Map([...entry.instances].flatMap(([key, r]) => (r.running === undefined ? [] : [[key, { fingerprint: r.running.part.fingerprint, users: r.users }] as const]))),
    failedGeneration: entry.failedGeneration,
    failedInstances: entry.failedInstances,
    retry: entry.retry
  })

  // -- What the module's info shows -----------------------------------------------------------------------------------

  /** Running instances, in key order. */
  const runningOf = (entry: Entry): Array<Instance> => [...entry.instances.values()].filter((r) => r.running !== undefined)

  /** The instance with the shared settings when it runs, else the first running one. */
  const mainOf = (entry: Entry): Instance | undefined => {
    const running = runningOf(entry)
    return running.find((r) => r.ownKeys.length === 0) ?? running[0]
  }

  /** The published instance an assistant uses. */
  const instanceFor = (entry: Entry, assistantId: string): Instance | undefined => {
    for (const r of entry.instances.values()) if (r.running !== undefined && r.users.includes(assistantId)) return r
    return undefined
  }

  /** Parts of the module retired and not yet closed (in their grace period). */
  const retiringOf = (entry: Entry) => [...openParts].some((p) => p.entry === entry && p.state === "retired")

  /**
   * The module's state from its instances and its shared part: `error` when one fails, `starting` while one starts,
   * `running` while one runs or (no instance: demanded only through `uses`) while its shared part runs.
   */
  const stateOf = (entry: Entry): { readonly state: ModuleState; readonly error?: string } => {
    if (entry.catalogError !== undefined) return { state: "error", error: entry.catalogError }
    if (entry.unavailable !== undefined) return { state: "unavailable" }
    const all = [...entry.instances.values()]
    if (all.some((r) => r.state === "starting") || (entry.starting && entry.shared === undefined)) return { state: "starting" }
    if (entry.generationError !== undefined && entry.shared === undefined) return { state: "error", error: entry.generationError }
    if (all.length === 0) {
      if (entry.shared !== undefined) return { state: "running" }
      return { state: retiringOf(entry) ? "stopping" : "disabled" }
    }
    const failed = all.find((r) => r.state === "error")
    if (failed === undefined) return { state: "running" }
    const message = failed.error ?? "The module could not start"
    return { state: "error", error: all.length === 1 || failed.users.length === 0 ? message : `${message} (for ${failed.users.join(", ")})` }
  }

  /** It runs in some form: an instance, or its shared part (`health()`'s `running`). */
  const isRunning = (entry: Entry) => mainOf(entry) !== undefined || entry.shared !== undefined

  /** An instance as the page sees it: its start error and status line through the boundary. */
  const instanceInfo = (entry: Entry, r: Instance, moving: ReadonlySet<string>): ModuleInstanceInfo => {
    const status = r.running === undefined ? undefined : boundary.status(entry.def.id, r.status)
    return {
      // An assistant whose own instance is starting is shown there (it is served here until that one is published).
      assistants: r.running === undefined ? [...r.users] : r.users.filter((u) => !moving.has(u)),
      own: [...r.ownKeys],
      state: r.state,
      ...(r.error !== undefined ? { error: boundary.text(entry.def.id, r.error, 2000) } : {}),
      ...(status !== undefined ? { status } : {})
    }
  }

  const movingOf = (entry: Entry): ReadonlySet<string> =>
    new Set([...entry.instances.values()].flatMap((r) => (r.state === "starting" && r.running === undefined ? r.users : [])))

  /**
   * The module as the page sees it. Everything in it the module produced at run time passes the boundary: its start
   * error, status line, tools, form decorations (`decorateForm`, from the published main instance) and its live
   * routes (the route table the switch fills).
   */
  const info = (entry: Entry): ModuleInfo => {
    const id = entry.def.id
    const { error, state } = stateOf(entry)
    const main = mainOf(entry)
    const status = boundary.status(id, main?.status)
    const routes = routeTable.get(id)?.routes ?? []
    const tools = new Map<string, Tool>()
    for (const r of [...(main === undefined ? [] : [main]), ...runningOf(entry)]) {
      for (const t of r.running?.tools ?? []) if (!tools.has(t.name)) tools.set(t.name, t)
    }
    return {
      id: entry.def.id,
      name: entry.def.name,
      description: entry.def.description,
      enabled: wanted(entry),
      state,
      ...(error !== undefined ? { error: boundary.text(id, error, 2000) } : {}),
      ...(status !== undefined ? { status } : {}),
      tools: [...tools.values()].map((t) => {
        const { risk, ...meta } = toolMetadata(t)
        return {
          name: boundary.redact(id, t.name),
          description: boundary.redact(id, t.description),
          speculative: t.speculative === true,
          ...(risk !== undefined ? { risk } : {}),
          ...meta,
          risks: [...meta.risks]
        }
      }),
      settings: decorateForm(entry, resolve(entry).form),
      revision: entry.revision,
      ...(entry.def.kind !== undefined ? { kind: entry.def.kind } : {}),
      ...(entry.demand !== undefined ? { instances: [...entry.instances.values()].map((r) => instanceInfo(entry, r, movingOf(entry))) } : {}),
      ...(entry.unavailable !== undefined ? { unavailable: entry.unavailable } : {}),
      ...(entry.def.version !== undefined ? { version: entry.def.version } : {}),
      ...(entry.def.apiVersion !== undefined ? { apiVersion: entry.def.apiVersion } : {}),
      ...(entry.def.templates !== undefined && entry.def.templates.length > 0 ? { templates: templatesOf(entry) } : {}),
      ...(routes.length > 0 ? { routes: routes.map((r) => routeView(id, r)) } : {})
    }
  }

  /**
   * A live route as the page sees it: what the module declared (its path, token name, description) through the
   * boundary. The live routing identity is unchanged; only the view is: a path that holds a secret is shown redacted,
   * a token name that does is left out.
   */
  const routeView = (moduleId: string, route: ModuleRoute): ModuleRouteInfo => {
    const { description, token, ...view } = routeInfo(moduleId, route)
    const prefix = `${MODULE_ROUTES_PREFIX}${moduleId}`
    return {
      ...view,
      path: route.path === "" ? prefix : `${prefix}/${boundary.redact(moduleId, route.path)}`,
      ...(token !== undefined && !boundary.holds(moduleId, token) ? { token } : {}),
      ...(description !== undefined ? { description: boundary.text(moduleId, description, MAX_ROUTE_DESCRIPTION) } : {})
    }
  }

  /**
   * The form as the page sees it (P3): `info` values and `combo` options from the published main instance
   * (`info()`, `settingOptions()`; a throwing one gives nothing), and the generated `test` button of an agent or
   * decision provider. Never part of an instance's settings key.
   */
  const decorateForm = (entry: Entry, form: SettingsForm): SettingsForm => {
    const instance = mainOf(entry)?.running?.instance
    // Called on the instance (a method may use `this`); a throwing one gives nothing.
    const read = <T>(f: () => T): T | undefined => {
      try {
        return f()
      } catch {
        return undefined
      }
    }
    const infos = instance?.info === undefined ? undefined : read(() => instance.info!())
    const options = instance?.settingOptions === undefined ? undefined : read(() => instance.settingOptions!())
    const own = <T>(dict: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
      typeof dict === "object" && dict !== null && Object.hasOwn(dict, key) ? dict[key] : undefined
    const generated = generatesTest(entry)
    // Messages may come from a field's own check (module code): through the boundary, like everything it writes.
    const errors = form.errors.map((e) => ({ ...e, message: boundary.text(entry.def.id, e.message, 2000) }))
    const warnings = form.warnings?.map((e) => ({ ...e, message: boundary.text(entry.def.id, e.message, 2000) }))
    const checked = { ...form, errors, ...(warnings !== undefined ? { warnings } : {}) }
    if (infos === undefined && options === undefined && !generated && !form.fields.some((f) => f.type === "combo")) return checked
    const values: Record<string, SettingValue> = { ...form.values }
    const fields = form.fields.map((field): SettingField => {
      const info = own(infos, field.key)
      // Through the boundary: an info value never carries one of the module's secrets to the page.
      if (field.type === "info" && typeof info === "string") values[field.key] = boundary.text(entry.def.id, info, 1000)
      if (field.type !== "combo") return field
      // A closed combo accepts only its static options (`Setting.combo`), so only an open one shows the instance's.
      if (!field.allowCustom) return field
      // Through the boundary too: display texts redacted, an option whose value holds a secret dropped.
      const list = boundary.options(entry.def.id, own(options, field.key))
      const known = new Set(field.options.map((o) => o.value))
      const added = (list ?? []).filter((o) => !known.has(o.value) && (known.add(o.value), true))
      // Within the wire's bounds: at most MAX_COMBO_OPTIONS in all and MAX_OPTIONS_JSON as JSON (the last go).
      const all = withinOptionBounds([...field.options, ...added], field.options.length)
      const note = instance === undefined ? "Not running: type a name" : list !== undefined ? `${all.length} suggestions from ${entry.def.name}` : undefined
      return { ...field, options: all, ...(note !== undefined && field.optionsNote === undefined ? { optionsNote: note } : {}) }
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
    return { ...checked, fields, values }
  }

  /** An agent or decision provider without a `test` field of its own gets the generated Test button. */
  const generatesTest = (entry: Entry) => (entry.def.kind === "agent" || entry.def.kind === "decider") && !Object.hasOwn(entry.def.settings, "test")

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

  /** The module's own issues (source `module:<id>`): requirements, unavailable, a failed start or restart. */
  const moduleIssues = (entry: Entry, demandedNow: ReadonlySet<Entry>): ReadonlyArray<Issue> => {
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
    const { error, state } = stateOf(entry)
    if (state === "error" && entry.catalogError === undefined) {
      // The start error may be the module's own words: through the boundary (the host's words around it are not).
      out.push({ id: `${id}.start`, module: id, severity: "error", title: `${name} could not start`, detail: boundary.redact(id, error ?? ""), fix: page })
    }
    if (entry.kept !== undefined) {
      out.push({ id: `${id}.restart`, module: id, severity: "warning", title: entry.kept.title, detail: `It keeps running as it was. ${boundary.redact(id, entry.kept.message)}`, fix: page })
    }
    // Host-made issues: the module's words in them (a start error) passed the boundary above; the rest is the host's.
    return normaliseIssues(entry.def.id, entry.def.name, out, (value, max) => boundary.text(entry.def.id, value, max), true)
  }

  /** Every module's issues again (a change of demand changes the severity of the modules it reaches too). */
  const refreshIssues = () => {
    const demandedNow = reached()
    for (const entry of entries) issues.set(`module:${entry.def.id}`, moduleIssues(entry, demandedNow))
  }

  /** Tell the listeners about a module whose info changed (and only then), with a higher revision. */
  const announce = (entry: Entry) => {
    const current = info(entry)
    const { revision: _, ...rest } = current
    const key = JSON.stringify(rest)
    if (key === entry.announced) return
    entry.announced = key
    entry.revision++
    const next = { ...current, revision: entry.revision }
    for (const listener of listeners) {
      try {
        listener(next)
      } catch {
        // A listener must not break the host.
      }
    }
  }
  const announceAll = () => {
    refreshIssues()
    for (const entry of entries) announce(entry)
  }

  // Status lines are coalesced: many updates in one tick produce one notification.
  const pendingStatus = new Set<Entry>()
  const scheduleStatus = (entry: Entry) => {
    if (pendingStatus.size === 0) {
      queueMicrotask(() => {
        const due = [...pendingStatus]
        pendingStatus.clear()
        due.forEach(announce)
      })
    }
    pendingStatus.add(entry)
  }

  // -- The snapshot ---------------------------------------------------------------------------------------------------

  const wrapProvider = (moduleId: string, part: Part, provider: ContextProvider): ContextProvider => ({
    name: provider.name,
    get: Effect.suspend(() => (part.closed ? Effect.succeed("") : provider.get)).pipe(
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
          context: (running.instance.context ?? []).map((p) => wrapProvider(entry.def.id, running.part, p)),
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
  /** What the snapshot is made of: rebuilt only when this changes (the registry's identity is a cache key). */
  let snapshotShape = ""
  const shapeOf = () =>
    JSON.stringify(entries.map((e) => [
      e.unavailable === undefined ? null : [e.unavailable.reason, e.demand === undefined ? switchOn(e) : e.demand.map((d) => d.assistantId)],
      [...e.instances.values()].map((r) => [r.running?.part.id ?? null, r.users, r.ownKeys.length])
    ]))
  /** The snapshot of the published instances. Throws on a tool name clash (the switch has refused those already). */
  const buildSnapshot = (): ModuleSnapshot => {
    const mains = entries.flatMap((e) => {
      if (e.unavailable !== undefined) return []
      const r = mainOf(e)?.running
      return r === undefined ? [] : [{ e, r }]
    })
    /** The main parts in catalog order: the running ones, and an unavailable one wherever it is wanted (no demand). */
    const mainParts = entries.flatMap((e) => {
      if (e.unavailable !== undefined) return e.demand === undefined && switchOn(e) ? [unavailablePartOf(e, e.unavailable)] : []
      const r = mainOf(e)?.running
      return r === undefined ? [] : [partOf(e, r)]
    })
    const toolModules = new Map<string, string>()
    for (const e of entries) for (const r of runningOf(e)) for (const t of r.running!.tools) toolModules.set(t.name, e.def.id)
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
              const wants = x.demand === undefined ? switchOn(x) : x.demand.some((w) => w.assistantId === d.assistantId)
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
  const rebuildSnapshot = () => {
    const shape = shapeOf()
    if (shape === snapshotShape) return
    try {
      snapshot = buildSnapshot()
      snapshotShape = shape
    } catch (error) {
      // Cannot happen (the switch refuses clashing tool names); kept so a host bug never leaves turns without tools.
      Effect.runSync(Effect.logError("The module snapshot could not be rebuilt; the previous one stays", error))
    }
  }

  // -- Registrations --------------------------------------------------------------------------------------------------

  /** Live claims by kind: claim → the module that holds it. */
  const claims = new Map<string, Map<string, Entry>>()
  /** Live services by key id. */
  const liveServices = new Map<string, { readonly entry: Entry; readonly part: Part; readonly service: unknown }>()
  /** Live contributions by module. */
  const liveContributions = new Map<Entry, { readonly part: Part; readonly list: ReadonlyArray<ProvidedContribution> }>()
  /** P3: live module routes by module id: the published shared part's (`host.routes()`, `ModuleInfo.routes`). */
  const routeTable = new Map<string, { readonly routes: ReadonlyArray<ModuleRoute>; readonly scope: Scope.Scope; readonly handle: PartHandle }>()

  /**
   * The kinds declared by what a part returns (`ModuleRegistrations.ts`). A later PR adds its kind here, one entry
   * (P3: `routes`, from `SharedPart.routes`).
   */
  const registrars: ReadonlyArray<Registrar> = [
    // Services of a shared part: one provider per key, looked up live (`host.service`).
    ({ handle, shared }) =>
      (shared?.services ?? []).length === 0 ? [] : [{
        kind: "service",
        claims: shared!.services!.map((p) => p.key.id),
        clash: (claim, owner) => `The service "${claim}" is already provided by module ${owner}`,
        publish: () => {
          const part = partById.get(handle.id)!
          for (const p of shared!.services!) liveServices.set(p.key.id, { entry: part.entry, part, service: p.service })
        },
        withdraw: () => {
          for (const p of shared!.services!) if (liveServices.get(p.key.id)?.part.id === handle.id) liveServices.delete(p.key.id)
        }
      }],
    // Contributions of a shared part (`host.contributions`).
    ({ handle, shared }) =>
      (shared?.contributions ?? []).length === 0 ? [] : [{
        kind: "contribution",
        publish: () => {
          const part = partById.get(handle.id)!
          liveContributions.set(part.entry, { part, list: [...shared!.contributions!] })
        },
        withdraw: () => {
          const part = partById.get(handle.id)!
          if (liveContributions.get(part.entry)?.part === part) liveContributions.delete(part.entry)
        }
      }],
    // An instance's tool names, unique across modules (its tools and actions reach turns through the snapshot,
    // rebuilt at the end of every switch from the published instances).
    ({ handle, instance }) => {
      const running = instance === undefined ? undefined : runningByPart.get(handle.id)
      if (running === undefined || running.tools.length === 0) return []
      return [{
        kind: "tool",
        claims: running.tools.map((t) => t.name),
        clash: (claim, owner) => `Tool name "${claim}" is already used by module ${owner}`,
        publish: () => {},
        withdraw: () => {}
      }]
    },
    // P3: a shared part's HTTP routes (`SharedPart.routes`), one entry per module in the route table. Checked before
    // the switch (a bad declaration refuses the part, and so its generation); live from the switch that publishes
    // the part until the one that withdraws it, so a request is only ever routed to the published generation.
    ({ handle, shared }) => {
      const declared = shared?.routes
      if (declared === undefined || declared.length === 0) return []
      const routes = [...declared]
      return [{
        kind: "route",
        // The full paths: unique across modules by construction (each module has its own prefix).
        claims: routes.map((r) => `${r.method} ${routeInfo(handle.moduleId, r).path}`),
        validate: () => routeProblem(routes),
        publish: () => void routeTable.set(handle.moduleId, { routes, scope: handle.scope, handle }),
        withdraw: () => {
          if (routeTable.get(handle.moduleId)?.handle.id === handle.id) routeTable.delete(handle.moduleId)
        }
      }]
    },
    ...(options.registrars ?? [])
  ]

  const safely = (what: string, f: () => void) => {
    try {
      f()
    } catch (error) {
      Effect.runSync(Effect.logError(`A module registration failed to ${what}`, error))
    }
  }

  /** Why `regs` of module `entry` cannot go live now (a claim another module holds, or their own check), else `undefined`. */
  const refusalOf = (entry: Entry, regs: ReadonlyArray<Registration>): string | undefined => {
    for (const r of regs) {
      const table = claims.get(r.kind)
      for (const claim of r.claims ?? []) {
        const owner = table?.get(claim)
        if (owner !== undefined && owner !== entry) return r.clash?.(claim, owner.def.name) ?? `"${claim}" is already taken by module ${owner.def.name}`
      }
      let problem: string | undefined
      try {
        problem = r.validate?.()
      } catch (error) {
        problem = `Its ${r.kind} could not be checked: ${error instanceof Error ? error.message : String(error)}`
      }
      if (problem !== undefined) return problem
    }
    return undefined
  }

  const publishRegistration = (entry: Entry, r: Registration) => {
    let table = claims.get(r.kind)
    if (table === undefined) claims.set(r.kind, table = new Map())
    for (const claim of r.claims ?? []) table.set(claim, entry)
    safely("publish", r.publish)
  }

  const withdrawRegistration = (entry: Entry, r: Registration) => {
    const table = claims.get(r.kind)
    for (const claim of r.claims ?? []) if (table?.get(claim) === entry) table.delete(claim)
    safely("withdraw", r.withdraw)
  }

  /** Publish a part (inside the switch). */
  const publishPart = (part: Part) => {
    part.state = "live"
    for (const r of part.registrations) publishRegistration(part.entry, r)
  }

  /** Withdraw a live part (inside the switch); its scope closes after the grace period. */
  const withdrawPart = (part: Part) => {
    if (part.state !== "live") return
    part.state = "retired"
    for (const r of part.registrations) withdrawRegistration(part.entry, r)
    // Another part of the same module may hold the same claims (a replaced instance): give them back.
    for (const other of livePartsOf(part.entry)) for (const r of other.registrations) {
      let table = claims.get(r.kind)
      if (table === undefined) claims.set(r.kind, table = new Map())
      for (const claim of r.claims ?? []) if (!table.has(claim)) table.set(claim, part.entry)
    }
  }

  const livePartsOf = (entry: Entry): Array<Part> => [
    ...(entry.shared !== undefined && entry.shared.part.state === "live" ? [entry.shared.part] : []),
    ...runningOf(entry).flatMap((r) => (r.running!.part.state === "live" ? [r.running!.part] : []))
  ]

  // -- Parts: scopes, closing in order --------------------------------------------------------------------------------

  let nextPart = 0
  /** Every part whose scope is not closed yet (published, in its grace period, a candidate): closing the host closes them. */
  const openParts = new Set<Part>()
  const partById = new Map<number, Part>()
  const runningByPart = new Map<number, Running>()

  const newPart = (entry: Entry, kind: "shared" | "instance", key: string, fingerprint: string) =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const startedAt = yield* Clock.currentTimeMillis
      const id = ++nextPart
      const registrations: Array<Registration> = []
      const handle: PartHandle = {
        moduleId: entry.def.id,
        moduleName: entry.def.name,
        kind,
        id,
        state: () => part.state,
        scope,
        register: (registration) => register(part, registration)
      }
      // `info` values may have changed with a press: announced when it ends (only while the part is published).
      const presses = kind === "instance" ? pressOwner((key) => `field action ${entry.def.id}.${key}`, () => announce(entry), () => entry.def.id) : undefined
      const part: Part = {
        id,
        entry,
        kind,
        key,
        fingerprint,
        scope,
        startedAt,
        state: "starting",
        closing: undefined,
        closed: false,
        registrations,
        stagedRestart: undefined,
        handle,
        presses
      }
      openParts.add(part)
      partById.set(id, part)
      return part
    })

  /** `PartHandle.register`: staged while starting, published at once while live (checked first), refused after. */
  const register = (part: Part, registration: Registration): RegisterResult => {
    if (part.state === "starting" || part.state === "candidate") {
      part.registrations.push(registration)
      return { ok: true }
    }
    if (part.state !== "live") return { ok: false, reason: `${part.entry.def.name}'s ${part.kind} part is no longer published` }
    const refused = refusalOf(part.entry, [registration])
    if (refused !== undefined) return { ok: false, reason: refused }
    part.registrations.push(registration)
    publishRegistration(part.entry, registration)
    return { ok: true }
  }

  /** Close one part's scope, exactly once (a second call waits for the first). */
  const closePart = (part: Part): Effect.Effect<void> =>
    Effect.uninterruptible(Effect.suspend(() => {
      if (part.closed) return Effect.void
      if (part.closing !== undefined) return Deferred.await(part.closing)
      const done = Deferred.makeUnsafe<void>()
      part.closing = done
      if (part.state !== "retired") part.state = "discarded"
      // Its presses first (each has ended, its cleanup run), then its scope: what a press uses is still open for it.
      return Effect.andThen(part.presses?.stop ?? Effect.void, Scope.close(part.scope, Exit.void)).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`Module ${part.entry.def.id}: closing its ${part.kind} part failed`, cause)),
        Effect.ensuring(Effect.sync(() => {
          part.closed = true
          openParts.delete(part)
          partById.delete(part.id)
          runningByPart.delete(part.id)
          shareds.delete(part.id)
          // Its code has ended: the secrets only it was given are no longer looked for.
          boundary.release(part)
          Deferred.doneUnsafe(done, Effect.void)
          announce(part.entry)
        }))
      )
    }))

  /**
   * Parts in the order they may be closed: a consumer before the providers it uses (higher `uses` rank first), an
   * instance before its shared part, an older start before a newer.
   */
  const closingOrder = (list: Iterable<Part>): Array<Part> =>
    [...list].sort((a, b) => b.entry.rank - a.entry.rank || (a.kind === b.kind ? 0 : a.kind === "instance" ? -1 : 1) || a.id - b.id)

  /** Close parts one after another, in dependency order (a part closes after the parts that may still use it). */
  const closeInOrder = (list: Iterable<Part>): Effect.Effect<void> => Effect.forEach(closingOrder(list), closePart, { discard: true })

  /** Grace timers of retired parts; interrupted at shutdown (the parts stay tracked in `openParts` until closed). */
  const timers = new Set<Fiber.Fiber<void>>()

  /** Retire parts withdrawn at a switch: closed in order after the grace period (calls in flight finish first). */
  const retireLater = (list: ReadonlyArray<Part>): Effect.Effect<void> =>
    list.length === 0 ? Effect.void : Effect.gen(function*() {
      const fiber = yield* Effect.forkIn(outsideTurns(Effect.andThen(Effect.sleep(graceMs), closeInOrder(list))), hostScope)
      timers.add(fiber)
      fiber.addObserver(() => timers.delete(fiber))
    })

  const describeStartFailure = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.findErrorOption(cause)
    if (error._tag === "Some" && error.value instanceof ModuleStartError) return error.value.message
    return `The module crashed while starting: ${Cause.pretty(cause).split("\n")[0]}`
  }

  /** A tool or action of a part whose scope has closed (a turn that held an old snapshot past the grace period). */
  const gone = (part: Part) => `${part.entry.def.name} was replaced or stopped since this turn began; ask again.`

  /** An instance's actions (guarded), registered under the module id, and its tools plus one generated tool per offered action. */
  const contributionsOf = (part: Part, instance: ModuleInstance) => {
    const guardedActions = (instance.actions ?? []).map((a) => ({
      ...a,
      run: (values: any) => Effect.suspend(() => (part.closed ? Effect.fail(new ActionError({ message: gone(part) })) : a.run(values)))
    }))
    const actions = registerActions(part.entry.def.id, guardedActions)
    const generated = actions.filter((a) => a.definition.offerAsTool !== false).map(actionTool)
    const own = (instance.tools ?? []).map((t): Tool => ({
      ...t,
      execute: (input) => Effect.suspend(() => (part.closed ? Effect.fail(new ToolError({ message: gone(part) })) : t.execute(input)))
    }))
    return { actions, tools: [...own, ...generated] }
  }

  // -- Starting parts (the reconciler only) ---------------------------------------------------------------------------

  /** `ctx.settingsFor` of a shared part: its own shared values, the overridable ones as the desired state has them now. */
  const settingsForOf = (entry: Entry, spec: SharedSpec) => (assistantId: string | undefined): unknown => {
    const owned = new Set(overridableKeys(entry.def.settings))
    const pick = (record: Readonly<Record<string, unknown>> | undefined, keep: (k: string) => boolean) =>
      Object.fromEntries(Object.entries(record ?? {}).filter(([k]) => keep(k)))
    const now = committedSources(entry)
    const stored = { ...pick(spec.stored, (k) => !owned.has(k)), ...pick(now.stored, (k) => owned.has(k)) }
    const defaults = { ...pick(spec.defaults, (k) => !owned.has(k)), ...pick(entry.defaults, (k) => owned.has(k)) }
    const own = assistantId === undefined ? undefined : entry.demand?.find((d) => d.assistantId === assistantId)?.own
    return resolveFrom(entry, { stored, secrets: spec.secrets }, own === undefined ? undefined : applicableOwnValues(entry.def.settings, own), defaults).value
  }

  /** Run module code for a part: outside any turn, in its scope, within the start limit. Fails only with an interruption. */
  const runStart = <A>(part: Part, label: string, start: () => Effect.Effect<A, ModuleStartError, Scope.Scope>): Effect.Effect<Exit.Exit<A, ModuleStartError>> =>
    outsideTurns(
      Effect.suspend(start).pipe(
        Scope.provide(part.scope),
        Effect.timeoutOrElse({
          duration: startTimeoutMs,
          orElse: () => Effect.fail(new ModuleStartError({ message: `${label} within ${Math.round(startTimeoutMs / 1000)} s` }))
        })
      )
    ).pipe(
      Effect.exit,
      Effect.flatMap((exit) => (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? Effect.failCause(exit.cause as Cause.Cause<never>) : Effect.succeed(exit)))
    )

  /** Start a shared part (a new generation's). The settings it runs with are kept for a restart that changes nothing else. */
  const startShared = (entry: Entry, target: HostSharedTarget, pass: PassContext): Effect.Effect<StartResult<SharedRun>> =>
    Effect.gen(function*() {
      const live = entry.shared
      // A restart that changes no setting starts with what the generation runs with (the vault may be locked since).
      const spec = live !== undefined && live.key === target.key && live.spec.secretEpoch === target.spec.secretEpoch ? live.spec : target.spec
      if (spec.settings === undefined) return { ok: false, message: invalidMessage(spec.errors) }
      const part = yield* newPart(entry, "shared", "", target.fingerprint)
      pass.parts.push(part)
      let run: SharedRun | undefined
      // The boundary remembers what module code is given (a vault locked since cannot make it showable).
      given(entry, [part], spec.settings)
      // `settingsFor` resolves with these too (the environment's are current values anyway).
      boundary.remember(entry.def.id, part, Object.values(spec.secrets))
      const context = { settings: spec.settings as never, settingsFor: settingsForOf(entry, spec) as never, ...servicesFor(entry, part.handle) }
      const exit = yield* runStart(part, "Its shared part did not start", () => entry.def.shared!(context))
      if (Exit.isFailure(exit)) return { ok: false, message: describeStartFailure(exit.cause), part }
      const ids = (exit.value.services ?? []).map((p) => p.key.id)
      const twice = ids.find((id, i) => ids.indexOf(id) !== i)
      if (twice !== undefined) return { ok: false, message: `The module provides the service "${twice}" twice`, part }
      run = { part, key: spec.key, value: exit.value, spec }
      shareds.set(part.id, run)
      part.state = "candidate"
      part.registrations.unshift(...registrationsOf({ handle: part.handle, shared: exit.value }))
      return { ok: true, value: run }
    })

  /** Start one instance. A restart that changes no setting starts with the settings the running one has. */
  const startInstance = (
    entry: Entry,
    target: HostInstanceTarget,
    shared: SharedRun | undefined,
    pass: PassContext
  ): Effect.Effect<StartResult<Running & { readonly status: StatusLine | undefined }>> =>
    Effect.gen(function*() {
      const live = entry.instances.get(target.key)?.running
      const settings = live !== undefined && live.secretEpoch === target.secretEpoch ? live.settings : target.resolved.value
      const part = yield* newPart(entry, "instance", target.key, target.fingerprint)
      pass.parts.push(part)
      let startStatus: StatusLine | undefined
      // Bound to this part: a status from an older or discarded start never reaches the published one.
      const setStatus = (status: StatusLine | undefined) => {
        if (part.state === "starting" || part.state === "candidate") {
          startStatus = status
          return
        }
        if (part.state !== "live") return
        const rec = entry.instances.get(target.key)
        if (rec?.running?.part !== part) return
        rec.status = status
        scheduleStatus(entry)
      }
      // P3: the form shows the published instance's `info()` and options again; a part not (or no longer) published
      // has nothing on the page to refresh.
      const refreshForm = () => {
        if (part.state === "live") scheduleStatus(entry)
      }
      given(entry, [part], settings)
      // Version 1 modules get exactly the context they always had; version 2 modules also get the host's services and
      // what their `shared` part returned.
      const context = (entry.def.apiVersion ?? 1) >= 2
        ? { settings: settings as never, setStatus, refreshForm, shared: shared?.value.value, ...servicesFor(entry, part.handle) }
        : { settings: settings as never, setStatus }
      const exit = yield* runStart(part, "Did not start", () => entry.def.start(context))
      const fail = (message: string) => ({ ok: false as const, message, part })
      if (Exit.isFailure(exit)) return fail(describeStartFailure(exit.cause))
      const instance = exit.value
      let contributed: ReturnType<typeof contributionsOf>
      try {
        contributed = contributionsOf(part, instance)
      } catch (error) {
        return fail(`The module's actions could not be offered as tools: ${String(error)}`)
      }
      const actionIds = contributed.actions.map((a) => a.id)
      const duplicateAction = actionIds.find((n, i) => actionIds.indexOf(n) !== i)
      if (duplicateAction !== undefined) return fail(`The module declares the action "${duplicateAction}" twice`)
      const names = contributed.tools.map((t) => t.name)
      const duplicate = names.find((n, i) => names.indexOf(n) !== i)
      if (duplicate !== undefined) return fail(`The module declares the tool "${duplicate}" twice`)
      const metadata = [...(instance.tools ?? []).map((t) => metadataProblem(`Tool "${t.name}"`, t)), ...contributed.actions.map((a) => metadataProblem(`Action "${a.definition.id}"`, a.definition))]
        .find((p) => p !== undefined)
      if (metadata !== undefined) return fail(metadata)
      try {
        // Its own tools on their own: a schema the registry cannot describe fails this start, not a later switch.
        makeToolRegistry([{ name: entry.def.id, tools: contributed.tools }])
      } catch (error) {
        return fail(`The module's tools could not be offered: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Core always words a confirmation question itself (after the final review): a module's own text is ignored.
      for (const a of contributed.actions) {
        if (typeof a.definition.confirm === "function") {
          yield* Effect.logWarning(
            `Module ${entry.def.id}, action "${a.definition.id}": its own confirmation text is ignored; the assistant asks its own question from the action's label and values`
          )
        }
      }
      const running: Running = { part, instance, settings, secretEpoch: target.secretEpoch, ...contributed }
      runningByPart.set(part.id, running)
      part.state = "candidate"
      part.registrations.unshift(...registrationsOf({ handle: part.handle, instance }))
      return { ok: true, value: { ...running, status: startStatus } }
    })

  const registrationsOf = (started: StartedPart): Array<Registration> => registrars.flatMap((r) => [...r(started)])

  // -- The desired state's writers, and waiting for a reconciliation --------------------------------------------------

  // Nothing runs before the first trigger: passes run only after a write (`evaluate` never writes).
  let desiredVersion = 0
  let startedVersion = 0
  let completedVersion = 0
  let shuttingDown = false
  let stopped = false
  let wake = Deferred.makeUnsafe<void>()
  const shutdownSignal = Deferred.makeUnsafe<void>()
  const waiters: Array<{ readonly version: number; readonly done: Deferred.Deferred<void> }> = []

  /** Read who wants what (`demand`) and the linked defaults again. */
  const readDemand = () => {
    if (options.demand === undefined) return
    const demand = options.demand()
    for (const entry of entries) entry.demand = demand.get(entry.def.id)
  }
  const readDefaults = () => {
    for (const entry of entries) entry.defaults = options.defaults?.(entry.def.id)
  }

  /**
   * Change the desired state (synchronously) and wake the reconciler; returns the version a pass must have begun
   * at to satisfy the writer. The linked defaults are read with every write.
   */
  const write = (mutate: () => void): number => {
    readDefaults()
    mutate()
    desiredVersion++
    Deferred.doneUnsafe(wake, Effect.void)
    return desiredVersion
  }

  /** Wait until a pass that began at `version` or later has finished (or the host has closed). */
  const settled = (version: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (completedVersion >= version || stopped) return Effect.void
      const done = Deferred.makeUnsafe<void>()
      waiters.push({ version, done })
      return Deferred.await(done)
    })

  const release = (version: number) => {
    completedVersion = Math.max(completedVersion, version)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!
      if (stopped || w.version <= completedVersion) {
        waiters.splice(i, 1)
        Deferred.doneUnsafe(w.done, Effect.void)
      }
    }
  }

  // -- The reconciler -------------------------------------------------------------------------------------------------

  /** A pass: what it planned, and the parts it started (every one is published or closed by the pass). */
  interface PassContext {
    readonly items: ReadonlyArray<PassItem>
    readonly parts: Array<Part>
  }

  /** Outcomes of configures, by proposal token (read by the configure that wrote it). */
  const proposalOutcomes = new Map<object, { readonly result: HostResult; readonly saved: Fiber.Fiber<void> | undefined }>()

  const capture = (): PassContext => {
    const demanded = reached()
    const items = ordered.map((entry): PassItem => {
      const target = targetOf(entry, demanded, !shuttingDown)
      return { entry, target, plan: planModule(target, currentOf(entry)), retry: entry.retry, proposal: entry.proposal, live: isLive(entry) }
    })
    return { items, parts: [] }
  }

  /** An owner's configure of a module that runs: its instance changes are all or nothing. */
  const atomic = (item: PassItem) => item.proposal !== undefined && item.live

  /** Show what a pass starts (synchronously, before it starts): new instances and first generations are `starting`. */
  const markStarting = (pass: PassContext) => {
    for (const { entry, plan } of pass.items) {
      const first = plan.generation !== undefined && entry.shared === undefined
      if (first) entry.starting = true
      if (plan.generation !== undefined && !first) continue
      for (const target of plan.start) {
        const rec = entry.instances.get(target.key)
        if (rec?.running !== undefined) continue
        entry.instances.set(target.key, {
          key: target.key,
          users: rec?.users ?? target.users,
          ownKeys: rec?.ownKeys ?? target.ownKeys,
          state: "starting",
          error: undefined,
          fieldErrors: undefined,
          status: undefined,
          running: undefined
        })
      }
    }
    announceAll()
  }

  /**
   * Start everything the pass planned: each module after the shared parts its `uses` start in this pass have started
   * or failed; a generation's instances after its shared part; independent modules concurrently.
   */
  const startAll = (pass: PassContext): Effect.Effect<Map<Entry, ModuleStarts>> =>
    Effect.suspend(() => {
      const results = new Map<Entry, ModuleStarts>()
      const sharedDone = new Map(pass.items.map((item) => [item.entry, Deferred.makeUnsafe<void>()]))
      const doneOf = (entry: Entry) => Effect.sync(() => Deferred.doneUnsafe(sharedDone.get(entry)!, Effect.void))
      const one = ({ entry, plan }: PassItem): Effect.Effect<void> =>
        Effect.gen(function*() {
          if (plan.generation === undefined && plan.start.length === 0) return
          const starts: ModuleStarts = { shared: undefined, instances: new Map() }
          results.set(entry, starts)
          yield* Effect.forEach(providersOf(entry), (p) => Deferred.await(sharedDone.get(p)!), { discard: true })
          let shared = entry.shared
          if (plan.generation !== undefined) {
            // A generation with an instance whose settings are not valid fails as a whole, before anything starts.
            const invalid = (plan.start as ReadonlyArray<HostInstanceTarget>).find((i) => i.invalid !== undefined)
            if (invalid !== undefined) {
              starts.shared = { ok: false, message: invalid.invalid! }
              return
            }
            const started = yield* startShared(entry, plan.generation as HostSharedTarget, pass)
            starts.shared = started
            yield* doneOf(entry)
            if (!started.ok) return
            shared = started.value
          } else yield* doneOf(entry)
          const valid = (plan.start as ReadonlyArray<HostInstanceTarget>).filter((i) => i.invalid === undefined)
          yield* Effect.forEach(valid, (target) => Effect.map(startInstance(entry, target, shared, pass), (r) => void starts.instances.set(target.key, r)), {
            concurrency: "unbounded",
            discard: true
          })
        }).pipe(Effect.ensuring(doneOf(entry)))
      return Effect.as(Effect.forEach(pass.items, one, { concurrency: "unbounded", discard: true }), results)
    })

  const errorRecord = (target: InstanceTarget, message: string, fieldErrors?: ReadonlyArray<FieldError>): Instance => ({
    key: target.key,
    users: target.users,
    ownKeys: target.ownKeys,
    state: "error",
    error: message,
    fieldErrors,
    status: undefined,
    running: undefined
  })

  const runningRecord = (target: { readonly key: string; readonly users: ReadonlyArray<string>; readonly ownKeys: ReadonlyArray<string> }, running: Running, status: StatusLine | undefined): Instance => ({
    key: target.key,
    users: target.users,
    ownKeys: target.ownKeys,
    state: "running",
    error: undefined,
    fieldErrors: undefined,
    status,
    running
  })

  /**
   * THE switch: synchronous, so no fiber ever sees a half-switched picture. Definite withdrawals first (modules that
   * stop, instances no longer wanted), then, in `uses` order, every module's starts: a generation all or nothing, an
   * instance on its own; every registration checked against what is live at that moment. Then the snapshot once.
   * Returns what to close now (discarded candidates) and what to retire (withdrawn parts).
   */
  const switchTo = (pass: PassContext, results: Map<Entry, ModuleStarts>) => {
    const retired: Array<Part> = []
    const outcomes: Array<{ readonly item: PassItem; readonly rejected: string | undefined }> = []
    const withdraw = (part: Part | undefined) => {
      if (part === undefined || part.state !== "live") return
      withdrawPart(part)
      retired.push(part)
    }
    // 1. Definite withdrawals.
    for (const item of pass.items) {
      const { entry, plan, target } = item
      if (!target.runs) {
        for (const r of entry.instances.values()) withdraw(r.running?.part)
        withdraw(entry.shared?.part)
        entry.shared = undefined
        entry.instances = new Map()
        entry.generationError = undefined
        entry.generationFieldErrors = undefined
        // Nothing of it runs any more: an old failed restart is no longer news, and a failed start is tried again
        // when it is wanted again (its error would otherwise be gone while the start stays skipped).
        entry.kept = undefined
        entry.failedGeneration = undefined
        entry.failedInstances.clear()
        continue
      }
      if (plan.generation !== undefined || atomic(item)) continue
      for (const key of plan.retire) {
        withdraw(entry.instances.get(key)?.running?.part)
        entry.instances.delete(key)
      }
    }
    // 2. Starts, providers first.
    for (const item of pass.items) {
      const { entry, plan, target } = item
      entry.starting = false
      if (!target.runs) {
        outcomes.push({ item, rejected: undefined })
        continue
      }
      const starts = results.get(entry)
      if (plan.generation !== undefined) {
        const s = starts?.shared
        const instanceTargets = plan.start as ReadonlyArray<HostInstanceTarget>
        let problem: string | undefined = s === undefined ? "It was not started" : s.ok ? undefined : s.message
        let fieldErrors: ReadonlyArray<FieldError> | undefined = instanceTargets.find((i) => i.invalid !== undefined)?.resolved.form.errors
        if (problem === undefined) {
          for (const t of instanceTargets) {
            const r = starts!.instances.get(t.key)
            if (r === undefined || !r.ok) {
              problem = r === undefined ? "It was not started" : r.message
              break
            }
          }
        }
        const newParts = problem === undefined
          ? [(s as Extract<typeof s, { ok: true }>).value.part, ...instanceTargets.map((t) => (starts!.instances.get(t.key) as Extract<StartResult<Running>, { ok: true }>).value.part)]
          : []
        if (problem === undefined) problem = refusalOf(entry, newParts.flatMap((p) => p.registrations))
        if (problem !== undefined) {
          entry.failedGeneration = { fingerprint: plan.generation.fingerprint, retry: item.retry, message: problem }
          if (entry.shared !== undefined) {
            const restartOnly = entry.shared.key === plan.generation.key && entry.shared.spec.secretEpoch === (plan.generation as HostSharedTarget).spec.secretEpoch
            entry.kept = { title: restartOnly ? `${entry.def.name} could not be started again` : `${entry.def.name} could not apply its new settings`, message: problem }
            // Placeholders of this pass go; the published generation's instances stay as they are.
            for (const [key, r] of entry.instances) if (r.running === undefined) entry.instances.delete(key)
            outcomes.push({ item, rejected: problem })
          } else {
            entry.generationError = problem
            entry.generationFieldErrors = fieldErrors
            entry.instances = new Map(instanceTargets.map((t) => [t.key, errorRecord(t, problem!, t.invalid !== undefined ? t.resolved.form.errors : undefined)]))
            outcomes.push({ item, rejected: undefined })
          }
          continue
        }
        fieldErrors = undefined
        // Accepted: the old generation is withdrawn and the new one published, in this same synchronous step.
        for (const r of entry.instances.values()) withdraw(r.running?.part)
        withdraw(entry.shared?.part)
        const run = (s as Extract<typeof s, { ok: true }>).value
        entry.shared = run
        entry.instances = new Map(instanceTargets.map((t) => {
          const r = (starts!.instances.get(t.key) as Extract<StartResult<Running & { status: StatusLine | undefined }>, { ok: true }>).value
          return [t.key, runningRecord(t, runningByPart.get(r.part.id)!, r.status)]
        }))
        for (const p of newParts) publishPart(p)
        entry.failedGeneration = undefined
        entry.failedInstances.clear()
        entry.kept = undefined
        entry.generationError = undefined
        entry.generationFieldErrors = undefined
        outcomes.push({ item, rejected: undefined })
        continue
      }
      // Within the published generation (or a module without a shared part): each instance on its own; for an owner's
      // configure of a module that runs, all of them or nothing (what runs keeps running and nothing is saved).
      let rejected: string | undefined
      if (atomic(item)) {
        for (const t of plan.start as ReadonlyArray<HostInstanceTarget>) {
          const r = starts?.instances.get(t.key)
          const problem = t.invalid ?? (r === undefined ? "It was not started" : r.ok ? refusalOf(entry, r.value.part.registrations) : r.message)
          if (problem !== undefined) {
            rejected = problem
            break
          }
        }
        if (rejected !== undefined) {
          for (const [key, r] of entry.instances) if (r.running === undefined && r.state === "starting") entry.instances.delete(key)
          outcomes.push({ item, rejected })
          continue
        }
        for (const key of plan.retire) {
          withdraw(entry.instances.get(key)?.running?.part)
          entry.instances.delete(key)
        }
        // The owner's change is in effect: an earlier failed restart is no longer news.
        entry.kept = undefined
      }
      for (const t of plan.start as ReadonlyArray<HostInstanceTarget>) {
        const live = entry.instances.get(t.key)
        const replacing = live?.running !== undefined
        const r = starts?.instances.get(t.key)
        let problem = t.invalid ?? (r === undefined ? "It was not started" : r.ok ? undefined : r.message)
        if (problem === undefined) problem = refusalOf(entry, (r as Extract<typeof r, { ok: true }>).value.part.registrations)
        if (problem !== undefined) {
          entry.failedInstances.set(t.key, { fingerprint: t.fingerprint, retry: item.retry, message: problem })
          if (replacing) {
            entry.kept = { title: `${entry.def.name} could not be started again`, message: problem }
            live!.users = t.users
            live!.ownKeys = t.ownKeys
            rejected ??= problem
          } else {
            entry.instances.set(t.key, errorRecord(t, problem, t.invalid !== undefined ? t.resolved.form.errors : undefined))
          }
          continue
        }
        const started = (r as Extract<typeof r, { ok: true }>).value
        if (replacing) withdraw(live!.running!.part)
        entry.instances.set(t.key, runningRecord(t, runningByPart.get(started.part.id)!, started.status))
        publishPart(started.part)
        entry.failedInstances.delete(t.key)
        if (replacing) entry.kept = undefined
      }
      for (const k of plan.keep) {
        const rec = entry.instances.get(k.key)
        if (rec === undefined) continue
        rec.users = k.users
        if (!plan.kept) rec.ownKeys = k.ownKeys
      }
      if (!plan.kept) {
        const wantedKeys = new Set(target.instances.map((i) => i.key))
        for (const [key, rec] of entry.instances) if (!wantedKeys.has(key) && rec.running === undefined) entry.instances.delete(key)
      }
      outcomes.push({ item, rejected })
    }
    // 3. Every part this pass started that was not published is discarded (closed below, in order).
    const discarded = pass.parts.filter((p) => p.state === "starting" || p.state === "candidate")
    for (const p of discarded) p.state = "discarded"
    rebuildSnapshot()
    return { retired, discarded, outcomes }
  }

  /** After the switch: a configure's proposal is saved if it was switched to (or nothing ran to protect), else dropped. */
  const resolveProposals = (outcomes: ReadonlyArray<{ readonly item: PassItem; readonly rejected: string | undefined }>) =>
    Effect.gen(function*() {
      for (const { item, rejected } of outcomes) {
        const { entry, proposal } = item
        if (proposal === undefined || entry.proposal !== proposal) continue
        entry.proposal = undefined
        if (rejected !== undefined) {
          entry.kept = { title: `${entry.def.name} could not apply its new settings`, message: rejected }
          proposalOutcomes.set(proposal.token, { result: failure("module_start_failed", rejected, { moduleId: entry.def.id }), saved: undefined })
          continue
        }
        // A vault report since the configure wins over its secrets (it was locked or unlocked meanwhile).
        const secrets = entry.vaultEpoch === proposal.vaultEpoch ? proposal.secrets : entry.secrets
        entry.committed = { stored: proposal.stored, secrets, secretEpoch: proposal.secretEpoch }
        entry.secrets = secrets
        const saved = yield* forkSave(entry)
        proposalOutcomes.set(proposal.token, { result: resultOf(entry, item.target.runs), saved })
      }
    })

  /** Apply restarts asked for by parts during their own start, now that they are published. */
  const applyStagedRestarts = (pass: PassContext) =>
    Effect.forEach(pass.parts, (part) => {
      const reason = part.stagedRestart
      part.stagedRestart = undefined
      return reason !== undefined && part.state === "live" ? requestRestartFrom(part, reason) : Effect.void
    }, { discard: true })

  /** One pass: copy, plan, start, switch, retire. */
  const runPass = Effect.gen(function*() {
    const pass = capture()
    // Nothing to start: the switch alone (withdrawals, users moving, announcements).
    if (pass.items.some(({ plan }) => plan.generation !== undefined || plan.start.length > 0)) markStarting(pass)
    const started = yield* Effect.raceFirst(
      Effect.map(startAll(pass), Option.some),
      Effect.as(Deferred.await(shutdownSignal), Option.none<Map<Entry, ModuleStarts>>())
    )
    // Shutting down: what this pass started is closed by the shutdown, with everything else.
    if (Option.isNone(started)) return
    const { discarded, outcomes, retired } = switchTo(pass, started.value)
    yield* resolveProposals(outcomes)
    announceAll()
    yield* closeInOrder(discarded)
    yield* retireLater(retired)
    yield* applyStagedRestarts(pass)
  })

  /** Shutdown is a desired state too: nothing runs. Everything is withdrawn, then every open scope closed in order. */
  const shutdownPass = Effect.gen(function*() {
    for (const entry of entries) {
      for (const p of livePartsOf(entry)) withdrawPart(p)
      entry.shared = undefined
      entry.instances = new Map()
    }
    rebuildSnapshot()
    yield* Effect.forEach([...timers], Fiber.interrupt, { discard: true })
    yield* closeInOrder(openParts)
  })

  const loop = Effect.gen(function*() {
    while (!shuttingDown) {
      if (desiredVersion <= startedVersion) {
        const signal = wake
        yield* Effect.raceFirst(Deferred.await(signal), Deferred.await(shutdownSignal))
        if (signal === wake) wake = Deferred.makeUnsafe<void>()
        continue
      }
      const version = desiredVersion
      startedVersion = version
      yield* runPass.pipe(Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logError("A module reconciliation failed", cause)
      ))
      if (!shuttingDown) release(version)
    }
  })

  const reconciler = yield* Effect.forkIn(outsideTurns(loop), hostScope)

  // -- Saving ---------------------------------------------------------------------------------------------------------

  /** Saves are made one at a time, each with the module's state as it is when it runs (the latest wins). */
  const saveLock = Semaphore.makeUnsafe(1)
  const saveScope = yield* Scope.make()
  const saves = new Set<Fiber.Fiber<void>>()
  const forkSave = (entry: Entry): Effect.Effect<Fiber.Fiber<void>> =>
    Effect.gen(function*() {
      const save = Semaphore.withPermits(saveLock, 1)(Effect.suspend(() =>
        options.persistence.save(entry.def.id, {
          // An owner who never chose: what its default makes it (on while its key is set), as before.
          enabled: entry.chosen ? entry.enabled : switchOn(entry),
          settings: entry.committed.stored as Record<string, SettingValue>,
          secrets: entry.secrets
        })
      )).pipe(Effect.catchCause((cause) => Effect.logError(`Could not save the settings of module ${entry.def.id}`, cause)))
      const fiber = yield* Effect.forkIn(save, saveScope)
      saves.add(fiber)
      fiber.addObserver(() => saves.delete(fiber))
      return fiber
    })

  // Closing the host: the reconciler retires everything (in order, scopes in their grace period too), pending saves
  // finish; bounded by `closeTimeoutMs`. Registered after the reconciler's fork, so it runs before that is interrupted.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      shuttingDown = true
      // The host's own presses stop first (refused from now on; each in flight has ended), before anything closes.
      yield* Effect.timeoutOption(hostPresses.stop, closeTimeoutMs)
      Deferred.doneUnsafe(shutdownSignal, Effect.void)
      Deferred.doneUnsafe(wake, Effect.void)
      const finished = yield* Effect.timeoutOption(Fiber.await(reconciler), closeTimeoutMs)
      if (Option.isNone(finished)) yield* Effect.logWarning(`The module host did not stop within ${Math.round(closeTimeoutMs / 1000)} s`)
      yield* Effect.timeoutOption(shutdownPass, closeTimeoutMs)
      yield* Effect.timeoutOption(Effect.forEach([...saves], Fiber.await, { discard: true }), closeTimeoutMs)
      yield* Scope.close(saveScope, Exit.void)
      stopped = true
      release(desiredVersion)
    })
  )

  // -- Triggers: each writes the desired state, then waits for a pass that began after the write ----------------------

  /** How a module stands, as a trigger's result: its start error (or `invalid_settings`), else ok. */
  const resultOf = (entry: Entry, demanded: boolean): HostResult => {
    if (!demanded) return OK
    const { error, state } = stateOf(entry)
    if (state !== "error") return OK
    const fieldErrors = entry.generationFieldErrors ?? [...entry.instances.values()].find((r) => r.state === "error" && r.fieldErrors !== undefined)?.fieldErrors
    if (fieldErrors !== undefined) return failure("invalid_settings", error ?? "The settings are not valid", { moduleId: entry.def.id, fieldErrors })
    const message = entry.generationError ?? [...entry.instances.values()].find((r) => r.state === "error")?.error ?? error ?? "The module could not start"
    return failure("module_start_failed", message, { moduleId: entry.def.id })
  }

  const unknown = (id: string): HostResult => failure("unknown_module", `There is no module "${id}"`, {})

  /** A result for the page: its message and field messages through the boundary (a start error may quote a key). */
  const pageResult = (entry: Entry, result: HostResult): HostResult =>
    result.ok
      ? result
      : {
        ok: false,
        error: {
          ...result.error,
          message: boundary.text(entry.def.id, result.error.message, 2000),
          ...(result.error.fieldErrors !== undefined
            ? { fieldErrors: result.error.fieldErrors.map((e) => ({ ...e, message: boundary.text(entry.def.id, e.message, 2000) })) }
            : {})
        }
      }

  const notAllowed = (entry: Entry): HostResult =>
    failure("not_allowed", `${entry.def.name} is switched on and off per assistant (the assistant's Modules tab).`, { moduleId: entry.def.id })

  /** Its own switch: saved, then reconciled (everything it uses follows). */
  const setSwitch = (id: string, on: boolean): Effect.Effect<HostResult> =>
    Effect.suspend(() => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed(unknown(id))
      if (entry.demand !== undefined) return Effect.succeed(notAllowed(entry))
      const version = write(() => {
        entry.enabled = on
        entry.chosen = true
        entry.retry++
      })
      return Effect.gen(function*() {
        const saved = yield* forkSave(entry)
        yield* settled(version)
        yield* Fiber.await(saved)
        return on ? pageResult(entry, resultOf(entry, reached().has(entry))) : OK
      })
    })

  const configure = (id: string, patch: SettingsPatch, configureOptions: { readonly includeHidden?: boolean } = {}): Effect.Effect<HostResult> =>
    Effect.suspend(() => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed(unknown(id))
      // The result reaches the page (a save's error): a module's start error or check message in it passes the boundary.
      return Effect.map(configureEntry(entry, patch, configureOptions), (result) => pageResult(entry, result))
    })

  const configureEntry = (entry: Entry, patch: SettingsPatch, configureOptions: { readonly includeHidden?: boolean }): Effect.Effect<HostResult> =>
    Effect.suspend(() => {
      const id = entry.def.id
      if (entry.proposal !== undefined) {
        return Effect.succeed(failure("busy", `${entry.def.name} is still applying the previous change; try again in a moment`, { moduleId: id }))
      }
      readDefaults()
      const base = committedSources(entry)
      const patched = applySettingsPatch(
        entry.def.settings,
        { stored: base.stored, secrets: base.secrets, env: options.env, ...envOrigin, ...(entry.defaults !== undefined ? { defaults: entry.defaults } : {}) },
        patch,
        configureOptions
      )
      if (!patched.ok) return Effect.succeed(failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: patched.errors }))
      const proposal: Proposal = {
        token: {},
        stored: patched.stored,
        secrets: patched.secrets,
        secretEpoch: base.secretEpoch + (Object.keys(patch.secrets).length > 0 ? 1 : 0),
        vaultEpoch: entry.vaultEpoch
      }
      // While something runs that the change would replace, settings that cannot start are refused at once.
      if (isLive(entry)) {
        const demanded = reached()
        const probe = { ...entry, proposal } as Entry
        const target = targetOf(probe, new Set([...demanded].map((e) => (e === entry ? probe : e))), true)
        const invalid = target.instances.find((i) => i.invalid !== undefined)
        if (invalid !== undefined) return Effect.succeed(failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: invalid.resolved.form.errors }))
        if (target.shared?.invalid !== undefined) {
          return Effect.succeed(failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: target.shared.spec.errors }))
        }
      }
      const version = write(() => {
        entry.proposal = proposal
        entry.retry++
      })
      return Effect.gen(function*() {
        yield* settled(version)
        const outcome = proposalOutcomes.get(proposal.token)
        proposalOutcomes.delete(proposal.token)
        if (outcome === undefined) return failure("module_start_failed", `${entry.def.name}: the change was not applied (the assistant is stopping)`, { moduleId: id })
        if (outcome.saved !== undefined) yield* Fiber.await(outcome.saved)
        return outcome.result
      })
    })

  const setSecrets = (all: Readonly<Record<string, Readonly<Record<string, string>>>>): Effect.Effect<void> =>
    Effect.suspend(() => {
      const version = write(() => {
        for (const entry of entries) {
          const next = all[entry.def.id] ?? {}
          if (JSON.stringify(next) !== JSON.stringify(entry.secrets)) {
            entry.secrets = next
            entry.vaultEpoch++
          }
          // Starts that failed (for lack of a key) are tried again.
          const failed = entry.failedGeneration !== undefined || entry.failedInstances.size > 0 || [...entry.instances.values()].some((r) => r.state === "error")
          if (failed) entry.retry++
        }
      })
      return settled(version)
    })

  // Evaluated when run: a module switched on by `setSecrets` before this runs is included (and started once).
  const startEnabled = Effect.suspend(() => {
    const version = write(() => {
      readDemand()
      for (const entry of entries) entry.retry++
    })
    return settled(version)
  })

  const refresh = Effect.suspend(() => settled(write(readDemand)))

  const evaluate = Effect.sync(() => {
    readDemand()
    readDefaults()
    refreshIssues()
  })

  const recheck = Effect.suspend(() => {
    const changed = judgeAll()
    // Nothing changed: nothing to reconcile (and a host no trigger has started yet starts nothing).
    if (changed.length === 0) return Effect.void
    // A module that became available is started if it is wanted, one that became unavailable is retired.
    return settled(write(() => {
      for (const entry of changed) entry.retry++
    }))
  })

  const checkOwn = (id: string, own: Readonly<Record<string, unknown>>): ReadonlyArray<FieldError> => {
    const entry = byId.get(id)
    if (entry === undefined) return [{ key: null, message: `There is no module "${id}"` }]
    // A field's own check is module code: its messages pass the boundary.
    return checkOwnValues(entry.def.settings, own).map((e) => ({ ...e, message: boundary.text(id, e.message, 2000) }))
  }

  // -- Restarts -------------------------------------------------------------------------------------------------------

  /** Count a restart of `part`'s own generation (shared) or instance: the next pass starts it again. */
  const bumpRestart = (part: Part) => {
    const entry = part.entry
    write(() => {
      if (part.kind === "shared") entry.restartShared++
      else entry.restartInstances.set(part.key, (entry.restartInstances.get(part.key) ?? 0) + 1)
    })
  }

  /**
   * `requestRestart` of a part, routed by its identity: from a live part, counted (a restart already in progress
   * then starts again afterwards, so a change it did not see is not lost); from a part still starting, staged until
   * it is published; from a retired or discarded part, ignored. At most `RESTART_BUDGET` per `RESTART_WINDOW_MS` per
   * module; a request over budget is applied when the window allows, to whatever is published then if it began
   * before the request.
   */
  const requestRestartFrom = (part: Part, reason: string): Effect.Effect<void> =>
    Effect.gen(function*() {
      if (part.state === "starting" || part.state === "candidate") {
        part.stagedRestart = reason
        return
      }
      if (part.state !== "live") {
        yield* Effect.logInfo(`Module ${part.entry.def.id}: a restart asked for by a replaced ${part.kind} part is ignored (${reason})`)
        return
      }
      const entry = part.entry
      const now = yield* Clock.currentTimeMillis
      entry.restartTimes = entry.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
      if (entry.restartTimes.length < RESTART_BUDGET) {
        entry.restartTimes.push(now)
        yield* Effect.logInfo(`Module ${entry.def.id} is being started again${part.kind === "shared" ? " (a new generation)" : ""}: ${reason}`)
        bumpRestart(part)
        return
      }
      if (entry.restartLater) return
      entry.restartLater = true
      const wait = RESTART_WINDOW_MS - (now - entry.restartTimes[0]!)
      yield* Effect.logWarning(`Module ${entry.def.id} asks to be started again too often; the next restart waits ${Math.ceil(wait / 1000)} s`)
      const later = Effect.gen(function*() {
        yield* Effect.sleep(wait)
        entry.restartLater = false
        // What is published now, if it began before the request (a later start has seen the change already).
        const current = part.kind === "shared" ? entry.shared?.part : entry.instances.get(part.key)?.running?.part
        if (current === undefined || current.state !== "live" || current.startedAt > now) return
        entry.restartTimes.push(yield* Clock.currentTimeMillis)
        bumpRestart(current)
      })
      yield* Effect.forkIn(outsideTurns(later), hostScope)
    })

  /** `reportMissingProgram`: a required program failed to start; the app marks it missing, then every module is judged again. */
  const reportMissingProgram = (entry: Entry, tool: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const required = (entry.def.requires ?? []).some((r) => "tool" in r && r.tool === tool)
      if (!required || options.programMissing === undefined) return Effect.void
      options.programMissing(tool)
      return Effect.asVoid(Effect.forkIn(Effect.andThen(Effect.logWarning(`Module ${entry.def.id}: ${tool} could not be run; judging the modules again`), recheck), hostScope))
    })

  // -- Health ---------------------------------------------------------------------------------------------------------

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
        // The check holds what it is given until its issues are published.
        const holder = {}
        const settings = given(entry, [holder], resolve(entry).value)
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
          Effect.flatMap((list) =>
            Effect.sync(() =>
              issues.set(source, normaliseIssues(entry.def.id, entry.def.name, Array.isArray(list) ? list : [], (value, max) => boundary.text(entry.def.id, value, max)))
            )
          ),
          Effect.ensuring(Effect.sync(() => boundary.release(holder)))
        )
      }),
    { concurrency: "unbounded", discard: true }
  ))

  // -- The action catalogue, services, contributions ------------------------------------------------------------------

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
    (entry.demand === undefined ? switchOn(entry) : assistantId === undefined ? entry.demand.length > 0 : entry.demand.some((d) => d.assistantId === assistantId))

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

  /** The assistant a principal acts for: a turn's, a job's; `undefined` for the local and notification principals. */
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

  /** The live service under `key`. */
  const service = <T>(key: ServiceKey<T>): T | undefined => liveServices.get(key.id)?.service as T | undefined

  /**
   * A part's own lookup: a part still starting in a pass first sees the shared parts that pass started successfully
   * (its providers started before it), so a consumer starting with a new provider finds the new one; every other
   * lookup is the live one.
   */
  const serviceFor = (part: Part) => <T>(key: ServiceKey<T>): T | undefined => {
    if (part.state === "starting" || part.state === "candidate") {
      for (const other of openParts) {
        if (other.kind !== "shared" || other.state !== "candidate" || other === part) continue
        const found = shareds.get(other.id)?.value.services?.find((p) => p.key.id === key.id)
        if (found !== undefined) return found.service as T
      }
    }
    return service(key)
  }
  /** Started shared parts by part id (for a candidate's lookups). */
  const shareds = new Map<number, SharedRun>()

  const contributionsFor = <T>(key: ContributionKey<T>, assistantId: string | undefined): ReadonlyArray<T> =>
    entries.flatMap((entry) =>
      assistantId !== undefined && !moduleOnFor(assistantId, entry)
        ? []
        : (liveContributions.get(entry)?.list ?? []).filter((c) => c.key.id === key.id).map((c) => c.value as T)
    )

  /**
   * The contributions under `key` for the calling fiber's principal (read from its own context, which every `yield*`
   * keeps): a turn's or a job's assistant sees those of the modules it has on; anyone else every provider's.
   */
  const contributions = <T>(key: ContributionKey<T>): Effect.Effect<ReadonlyArray<T>> =>
    Effect.map(gateway.principal, (principal) =>
      // Serve mode: a caller with no complete principal gets none (deliberately all: `contributionsFor(key, undefined)`).
      "refused" in principal ? (options.access === undefined ? contributionsFor(key, undefined) : []) : contributionsFor(key, assistantOf(principal)))

  /**
   * The context members of a version 2 module, in `shared` and in `start`, bound to the part they are made for. A
   * later PR adds its member here, one line, and its field in `ModuleServicesV2`; a member that registers something
   * passes `part` on and registers through it (`PartHandle.register`).
   */
  function servicesFor(entry: Entry, part: PartHandle): ModuleServicesV2 {
    const own = partById.get(part.id)!
    return {
      host: {
        routeTokens: routeTokensFor(entry.def.id, own),
        view,
        service: serviceFor(own),
        contributions,
        contributionsFor,
        actions,
        requestRestart: (reason) => requestRestartFrom(own, reason),
        reportMissingProgram: (tool) => reportMissingProgram(entry, tool)
      }
    }
  }

  // -- Field actions and setting options ------------------------------------------------------------------------------

  const fieldAction = (id: string, key: string, values?: Readonly<Record<string, unknown>>): Effect.Effect<FieldActionHostResult> =>
    Effect.suspend((): Effect.Effect<FieldActionHostResult> => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed({ ok: false, code: "unknown_module", message: `There is no module "${id}"` } as const)
      if (shuttingDown) return Effect.succeed({ ok: false, code: "not_running", message: "The assistant is stopping" } as const)
      const declared = Object.hasOwn(entry.def.settings, key) ? entry.def.settings[key]! : undefined
      // Only a button of the form runs: a declared action field, or the generated Test of an agent or decision
      // provider. A handler without a field is not a button (whatever `fieldActions` holds).
      const generated = key === "test" && generatesTest(entry)
      if (declared === undefined ? !generated : declared.value !== "none") {
        return Effect.succeed({ ok: false, code: "unknown_action", message: declared === undefined ? `${entry.def.name} has no action "${key}"` : `${entry.def.name}: "${key}" is not a button` } as const)
      }
      // The published main instance (what the form shows): its part owns its presses.
      const running = mainOf(entry)?.running
      const instance = running?.instance
      // The object's own keys or its class's methods, never what every object inherits (`constructor`, `toString`);
      // each called on its object (`this` is kept).
      const handlerOf = (actions: Readonly<Record<string, FieldActionHandler<any>>> | undefined): FieldActionHandler | undefined =>
        actions !== undefined && declaresMember(actions, key) && typeof actions[key] === "function"
          ? (input) => actions[key]!(input)
          : undefined
      // The press's owner: the host for a definition's handler (it needs no instance), else the instance part that
      // runs it (its handler, or the generated Test of its agent or decision provider), which stops it before it closes.
      const definition = declared === undefined ? undefined : handlerOf(entry.def.fieldActions)
      const test = generated && instance !== undefined ? generatedTest(instance, (text) => boundary.redact(id, text)) : undefined
      const handler = definition ?? (declared === undefined ? undefined : handlerOf(instance?.fieldActions)) ?? (test === undefined ? undefined : () => test())
      const owner = definition !== undefined ? hostPresses : running?.part.presses
      const ownerKey = definition !== undefined ? `${id}/${key}` : key
      if (handler === undefined || owner === undefined) {
        return Effect.succeed(
          instance === undefined
            ? { ok: false, code: "not_running", message: `${entry.def.name} is not running` } as const
            : { ok: false, code: "unknown_action", message: `${entry.def.name} has no action "${key}"` } as const
        )
      }
      // What leaves the host passes the boundary: no secret the module was given, then at most 500 characters, a
      // known tone.
      const answer = (result: FieldActionResult): FieldActionHostResult => {
        const tone = result.tone === "neutral" || result.tone === "ok" || result.tone === "warning" || result.tone === "error" ? result.tone : undefined
        return { ok: true, result: { ok: result.ok === true, text: boundary.text(id, result.text, 500), ...(tone !== undefined ? { tone } : {}) } }
      }
      // The settings it sees: the saved shared ones, or (requiresSaved: false) the page's draft over them. Settings
      // that do not resolve (a required key not set, a saved value no longer valid) are the result: it does not run.
      const useDraft = values !== undefined && declared !== undefined && (declared.describe(key) as { readonly requiresSaved?: boolean }).requiresSaved === false
      const prepared = useDraft ? draftSettings(entry, values) : savedSettings(entry)
      if (!prepared.ok) return Effect.succeed(answer({ ok: false, text: prepared.message, tone: "error" }))
      const label = `field action ${id}.${key}`
      // The secrets the press is given are kept by the boundary until the press has ended AND been answered (the
      // first of the two releases nothing); an instance's press gives them to its instance, which keeps them as long
      // as it lives.
      const holder = {}
      let holds = 2
      const releaseOne = Effect.sync(() => {
        if (--holds === 0) boundary.release(holder)
      })
      const holders = definition !== undefined || running === undefined ? [holder] : [holder, running.part]
      // Suspended: a handler that throws is reported like one that fails. Outside any turn.
      const press = outsideTurns(Effect.suspend(() => handler({ settings: given(entry, holders, prepared.settings), draft: useDraft }))).pipe(Effect.ensuring(releaseOne))
      return Effect.gen(function*() {
        const outcome = yield* owner.start(ownerKey, press, fieldActionTimeoutMs)
        switch (outcome._tag) {
          case "busy":
            boundary.release(holder)
            return { ok: false, code: "busy", message: "That button is still running" } as const
          case "stuck":
            boundary.release(holder)
            return { ok: false, code: "busy", message: `Earlier presses of ${entry.def.name}'s buttons have not stopped yet; try again later (Health has more)` } as const
          case "stopped":
            boundary.release(holder)
            return { ok: false, code: "not_running", message: `${entry.def.name} is not running` } as const
          case "timeout":
            return answer({ ok: false, text: `Did not finish within ${Math.round(fieldActionTimeoutMs / 1000)} s`, tone: "error" })
        }
        if (Exit.isSuccess(outcome.exit)) return answer(outcome.exit.value)
        // The details may hold anything the handler had (a key in an error message): the server's log only.
        yield* Effect.logWarning(`${label} failed`, outcome.exit.cause)
        return answer({ ok: false, text: "It failed; the server's log says why.", tone: "error" })
      }).pipe(Effect.ensuring(releaseOne))
    })

  /** The module's saved shared settings (environment > saved > linked default, with secrets), or why they are not usable. */
  const savedSettings = (entry: Entry):
    | { readonly ok: true; readonly settings: Readonly<Record<string, unknown>> }
    | { readonly ok: false; readonly message: string } => {
    const resolved = resolve(entry)
    if (resolved.value === undefined) return { ok: false, message: `Not run: ${problemsText(entry, resolved.form.errors)}` }
    return { ok: true, settings: resolved.value as Readonly<Record<string, unknown>> }
  }

  const problemsText = (entry: Entry, errors: ReadonlyArray<{ readonly key: string | null; readonly message: string }>) =>
    errors.map((e) => (e.key === null || !Object.hasOwn(entry.def.settings, e.key) ? e.message : `${entry.def.settings[e.key]!.describe(e.key).label}: ${e.message}`)).join("; ")

  /** The shared settings with a page's draft applied (non-secret, editable, known fields only), or why not. */
  const draftSettings = (entry: Entry, values: Readonly<Record<string, unknown>>):
    | { readonly ok: true; readonly settings: Readonly<Record<string, unknown>> }
    | { readonly ok: false; readonly message: string } => {
    const spec = entry.def.settings
    const patchValues: Record<string, SettingValue> = Object.create(null)
    for (const [k, v] of Object.entries(values)) {
      const setting = Object.hasOwn(spec, k) ? spec[k]! : undefined
      if (setting === undefined || setting.secret || !isEditableSetting(setting) || setting.env !== undefined && (options.env[setting.env] ?? "") !== "") continue
      patchValues[k] = v as SettingValue
    }
    const base = committedSources(entry)
    const patched = applySettingsPatch(
      spec,
      { stored: base.stored, secrets: base.secrets, env: options.env, ...envOrigin, ...(entry.defaults !== undefined ? { defaults: entry.defaults } : {}) },
      { values: patchValues, secrets: {} }
    )
    if (!patched.ok) return { ok: false, message: `Not run: ${problemsText(entry, patched.errors)}` }
    // Secrets are always the saved ones (a draft cannot name one: it is skipped above).
    const resolved = resolveFrom(entry, { stored: patched.stored, secrets: base.secrets })
    if (resolved.value === undefined) return { ok: false, message: `Not run: ${problemsText(entry, resolved.form.errors)}` }
    return { ok: true, settings: resolved.value as Readonly<Record<string, unknown>> }
  }

  const settingOptions = (id: string): Readonly<Record<string, ReadonlyArray<ChoiceOption>>> | undefined => {
    const entry = byId.get(id)
    const instance = entry === undefined ? undefined : mainOf(entry)?.running?.instance
    if (entry === undefined || instance?.settingOptions === undefined) return undefined
    let raw: unknown
    try {
      raw = instance.settingOptions()
    } catch {
      return undefined
    }
    if (typeof raw !== "object" || raw === null) return undefined
    // Through the boundary, like the form's options (the model pickers show them).
    const out: Record<string, ReadonlyArray<ChoiceOption>> = Object.create(null)
    for (const [key, list] of Object.entries(raw).slice(0, 50)) {
      const options = boundary.options(entry.def.id, list)
      if (options !== undefined) out[key] = withinOptionBounds(options, 0)
    }
    return out
  }

  /**
   * P3: `host.routeTokens` of one part. A token it mints is a secret its code holds: the boundary keeps it for as
   * long as that part lives (it is never shown again otherwise; the store keeps only its hash).
   */
  function routeTokensFor(moduleId: string, part: Part): RouteTokens {
    if (options.routeTokens === undefined) {
      const none = new RouteTokenError({ reason: "unavailable", message: "Route tokens are kept by the server (serve mode) only" })
      return { mint: () => Effect.fail(none), list: Effect.fail(none), revoke: () => Effect.fail(none) }
    }
    const store = options.routeTokens.forModule(moduleId)
    return {
      list: store.list,
      revoke: store.revoke,
      mint: (name, label) => Effect.tap(store.mint(name, label), (minted) => Effect.sync(() => boundary.remember(moduleId, part, [minted.secret])))
    }
  }

  /** P3: the live routes, from the route table the switch fills. */
  const routes = (): ReadonlyArray<PublishedRoute> =>
    [...routeTable].flatMap(([moduleId, live]) => live.routes.map((route) => ({ moduleId, route, scope: live.scope })))

  /** The boundary for the app's own views of module-produced text (the route call log and token labels). */
  const pageText = (moduleId: string, text: unknown, max: number): string => boundary.text(moduleId, text, max)

  // Before any trigger: the unavailable modules' lines, and every module's issues.
  rebuildSnapshot()
  for (const entry of entries) {
    const { revision: _, ...rest } = info(entry)
    entry.announced = JSON.stringify(rest)
  }
  refreshIssues()

  return {
    issues,
    evaluate,
    recheck,
    checkHealth,
    actions,
    view,
    service,
    contributions,
    contributionsFor,
    gateway,
    fieldAction,
    routes,
    routeView,
    pageText,
    settingOptions,
    setSecrets,
    snapshot: () => snapshot,
    modules: () => entries.map(info),
    startEnabled,
    enable: (id: string) => setSwitch(id, true),
    disable: (id: string) => setSwitch(id, false),
    configure,
    refresh,
    checkOwn,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } satisfies ModuleHost as ModuleHost
})

/**
 * Module issues made safe for the wire: the module's id as prefix and `module`, every bounded text within its limit
 * (the fix's label and value too), at most 50. An issue that still does not fit the wire's `HealthIssue` is replaced
 * by one that says so, so one malformed issue cannot break the health message or the admin snapshot.
 */
function normaliseIssues(
  id: string,
  name: string,
  list: ReadonlyArray<Issue>,
  /** The page boundary (P3): a start error or a `health()` result never carries a secret the module was given. */
  page: (value: unknown, max: number) => string,
  /** Made by the host (`moduleIssues`, the module's words in it redacted already): only clipped. */
  hostMade = false
): ReadonlyArray<Issue> {
  const own = (value: unknown, max: number) => (hostMade ? clip(String(value ?? ""), max) : page(value, max))
  return list.slice(0, 50).map((issue, i): Issue => {
    const fix = issue.fix === undefined ? undefined : {
      kind: issue.fix.kind,
      label: own(issue.fix.label, 200),
      ...(issue.fix.value !== undefined ? { value: own(issue.fix.value, 1000) } : {})
    }
    // A module's id is a key, not text: one that holds a secret is replaced whole rather than redacted.
    const rawId = String(issue.id ?? "")
    const fullId = rawId.startsWith(`${id}.`) ? rawId : `${id}.${rawId}`
    const out: Issue = {
      id: hostMade || page(fullId, Number.MAX_SAFE_INTEGER) === fullId ? clip(fullId, 200) : `${id}.issue-${i}`,
      module: id,
      ...(issue.device !== undefined ? { device: own(issue.device, 200) } : {}),
      severity: issue.severity,
      title: own(issue.title, 200),
      detail: own(issue.detail, 2000),
      ...(fix !== undefined ? { fix } : {})
    }
    if (isWireIssue(out)) return out
    return { id: `${id}.malformed-issue-${i}`, module: id, severity: "warning", title: `${name} reported an issue that cannot be shown`, detail: "Its severity or fix kind is not one the page knows." }
  })
}
// ---------------------------------------------------------------------------
// Generated "Test" buttons

const TEST_TIMEOUT_MS = 30_000

const quote = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s)

/** Options within the wire's bounds (`MAX_COMBO_OPTIONS`, `MAX_OPTIONS_JSON`): the last go first, the first `keep` stay. */
const withinOptionBounds = (options: ReadonlyArray<ChoiceOption>, keep: number): Array<ChoiceOption> => {
  const out = options.slice(0, Math.max(keep, MAX_COMBO_OPTIONS))
  let size = JSON.stringify(out).length
  while (out.length > keep && size > MAX_OPTIONS_JSON) size -= JSON.stringify(out.pop()).length + 1
  return out
}

/**
 * Does `object` declare `key` itself or through a class of its own (not `Object.prototype`, and never
 * `constructor`)? A module's handlers may be a plain object or a class instance's methods.
 */
const declaresMember = (object: object, key: string): boolean => {
  if (key === "constructor" || key === "__proto__") return false
  for (let o: object | null = object; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    if (Object.hasOwn(o, key)) return true
  }
  return false
}

/** The generated `test` field action of an agent or decision-provider instance, if it is one. */
const generatedTest = (instance: ModuleInstance, redact: (text: string) => string): (() => Effect.Effect<FieldActionResult>) | undefined => {
  const agent = instance.agents?.[0]
  if (agent !== undefined) return () => testAgent(agent, redact)
  const decider = instance.deciders?.[0]
  if (decider !== undefined) return () => testDecider(decider)
  return undefined
}

/** What a generated Test says when the provider failed: the details go to the server's log only. */
const testFailed = (ms: number, label: string, cause: Cause.Cause<unknown>): Effect.Effect<FieldActionResult> =>
  Effect.as(Effect.logWarning(`${label} test failed after ${ms} ms`, cause), { ok: false, text: `Failed after ${ms} ms; the server's log says why.`, tone: "error" as const })

/**
 * One turn outside the conversation: "Say hello in five words.", no history, no tools, already committed. Host code:
 * it never puts a provider's diagnostics or credentials in what it returns (a failure is logged and answered with a
 * generic sentence), and `redact` (the host's page boundary) sees the answer exactly as the provider sent it, every
 * delta joined as is, before anything trims or shortens it. The host clips the whole text after redacting it again.
 */
export const testAgent = (agent: Agent, redact: (text: string) => string = (text) => text): Effect.Effect<FieldActionResult> =>
  Effect.gen(function*() {
    const start = yield* Clock.currentTimeMillis
    let first: number | undefined
    // Every delta as the provider sent it: nothing is trimmed, dropped or joined differently before the boundary
    // has looked at the whole answer (a secret split over deltas, or with spaces around it, is still found).
    let raw = ""
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
            if (event._tag !== "TextDelta") return
            raw += event.text
            // Only the first visible text counts for the timing.
            if (event.text.trim().length > 0) first ??= now
          }))
      ),
      Effect.timeoutOrElse({ duration: TEST_TIMEOUT_MS, orElse: () => Effect.fail(new Error(`no answer within ${TEST_TIMEOUT_MS / 1000} s`)) }),
      Effect.exit
    )
    const end = yield* Clock.currentTimeMillis
    if (Exit.isFailure(exit)) return yield* testFailed(end - start, `Agent ${agent.id}`, exit.cause)
    if (first === undefined) return { ok: false, text: `Done after ${end - start} ms without saying anything.`, tone: "warning" }
    // Redacted first, on exactly what was said; only then trimmed and quoted short.
    return { ok: true, text: `First text after ${first - start} ms, done after ${end - start} ms: '${quote(redact(raw).trim())}'`, tone: "ok" }
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
    if (Exit.isFailure(exit)) return yield* testFailed(ms, `Decision provider ${decider.id}`, exit.cause)
    const action = exit.value.answers["action"]
    const room = exit.value.answers["test.lights_on/room"]
    const describe = (a: typeof action) =>
      a === undefined ? "no answer" : a.type === "choice" ? `${a.choice} (${Math.round((a.probabilities[a.choice] ?? 0) * 100)} %)` : `${Math.round(a.value * 100)} %`
    return { ok: true, text: `Answered in ${ms} ms: action ${describe(action)}, room ${describe(room)}.`, tone: "ok" }
  })
