import {
  type AssistantTemplate,
  type ChoiceOption,
  type ErrorInfo,
  type FieldError,
  MAX_COMBO_OPTIONS,
  MAX_FIELD_LABEL,
  MAX_MODULE_TEMPLATES,
  MAX_OPTIONS_JSON,
  MAX_ROUTE_DESCRIPTION,
  MAX_ROUTE_PATH,
  MODULE_ROUTES_PREFIX,
  type ModuleInfo,
  type ModuleInstanceInfo,
  type ModuleRouteInfo,
  type ModuleState,
  ModuleUnavailable,
  SettingField,
  type SettingsForm,
  type SettingsPatch,
  type SettingValue,
  type StatusLine
} from "@pva/protocol"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, Result, Schema, Scope, Stream } from "effect"
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
import { sealAction, sealTool } from "./GatewayPrivate.ts"
import { boundIssues, makeIssueRegistry, type IssueRegistry, wireSafeIssue } from "./Issues.ts"
import { type AssistantModule, type ContextProvider, metadataProblem, type Tool, toolMetadata } from "./Module.ts"
import {
  type ActionCatalogue,
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
  ModuleStopped,
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
import { makeModuleSlots, MAX_PRESS_SLOTS, slotIssues } from "./ModuleSlots.ts"
import { type ModuleDefinition, type ModuleInstance, ModuleStartError } from "./ModuleDefinition.ts"
import { type InstanceTarget, type ModuleTarget, planModule, reachedBy, usesOrder } from "./ModulePlanner.ts"
import type { PartHandle, PartState, Registrar, Registration } from "./ModuleRegistrations.ts"
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
 * **One worker, one module at a time, stop before start.** Every trigger (configure, enable, disable, a change of the
 * assistants, the vault, Check again, `requestRestart`, refresh, startup) only writes the **desired state** and then
 * waits for a pass of the worker that began after its write. The worker is one fiber and the only thing that starts
 * or stops module code. A pass captures the desired state once, asks the pure planner (`ModulePlanner.ts`) what each
 * module should run, then walks the modules one after another: first stopping, consumers before the providers they
 * `use`, then starting, providers first. Stopping a module withdraws everything it published in one synchronous step,
 * gives its calls in flight the grace period, then closes its instances and its shared part. Starting runs its shared
 * part, then its instances, and publishes them all in one synchronous step if every one started, or closes what did
 * and leaves the module down with its error on the Health page. Every call into module code runs in its own fiber
 * with a time limit; one that does not return in time is abandoned and reported, and the worker moves on.
 *
 * A module runs as **instances**. Without `demand` (the CLI modes, agents and decision providers) a module has at most
 * one, following its saved switch. With `demand` (serve mode's capabilities), it runs while at least one assistant
 * wants it, one instance per distinct set of valid effective settings (the assistant's own values of `overridable`
 * fields over the shared ones over the linked defaults): assistants with equal settings share one.
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
  /** Increases whenever what runs changes. */
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
   * actions (they answer with its "not set up" line). Sealed: only the execution gateway runs them.
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
  /** `name` is the module id. Its tools and actions are sealed: only the execution gateway runs them. */
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
 * What one module's settings form may take on the wire (UTF-8 bytes of its fields as JSON, with what the running
 * instance adds: `combo` suggestions and `info` values). Every module's form travels in the one `admin.snapshot`
 * frame (1 MiB, `MAX_TEXT_FRAME_BYTES`) beside the Health issues (256 KiB) and the templates (128 KiB): 40 modules at
 * this budget take 320 KiB, leaving about 300 KiB for everything else. A module whose described form does not encode
 * or is larger does not start (its error names the field); what the instance adds is trimmed to what is left, with
 * "and N more" shown.
 */
export const MODULE_FORM_BUDGET_BYTES = 8 * 1024

export type HostResult = { readonly ok: true } | { readonly ok: false; readonly error: ErrorInfo }

export interface ModuleHost {
  /** The current snapshot (a reference read). */
  readonly snapshot: () => ModuleSnapshot
  /** Every module, in catalog order. */
  readonly modules: () => ReadonlyArray<ModuleInfo>
  /**
   * Open the host: until it is called the worker starts nothing (writes are kept and applied by the first pass), so
   * the app calls it once everything the modules depend on is built. Reads `demand`, then starts every module that
   * should run (its intent is on, or an assistant wants it), one after another; completes when the pass has finished.
   */
  readonly startEnabled: Effect.Effect<void>
  /**
   * Switch it on (saved), and wait for a pass that began after the switch: the result is how it then stands (its
   * start error, or `invalid_settings`). Refused `not_allowed` for a module with demand (the assistants switch it on
   * and off). An interrupted caller stops waiting; the switch and its save stay.
   */
  readonly enable: (id: string) => Effect.Effect<HostResult>
  /** Switch it off (saved); see `enable`. */
  readonly disable: (id: string) => Effect.Effect<HostResult>
  /**
   * Change the shared settings (saved at once). `includeHidden`: also save fields hidden by `visibleWhen` (moving
   * values out of `.env`). While the module runs, settings it could not start with are refused at once. Otherwise
   * the module is stopped and started again with them if what it runs changes; a start that fails leaves it down,
   * with its error on the Health page, and is the result.
   */
  readonly configure: (id: string, patch: SettingsPatch, options?: { readonly includeHidden?: boolean }) => Effect.Effect<HostResult>
  /**
   * Replace every module's secrets without saving them (the app's key vault was unlocked or locked; a module missing
   * from `secrets` has none). What runs keeps running with what it started with; a module that failed to start is
   * tried again. Completes when the pass has finished.
   */
  readonly setSecrets: (secrets: Readonly<Record<string, Readonly<Record<string, string>>>>) => Effect.Effect<void>
  /**
   * Read `demand` and `defaults` again and bring the modules in line (docs/ASSISTANTS.md §2.6). A module whose
   * instances do not change is left alone (assistants moving between equal instances only change who uses which);
   * any other change stops it and starts it again. Completes when the pass has finished.
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
   * P3: the routes of every published module's shared part, live: one registration kind ("route"), published and
   * withdrawn with the module (a module that stops takes its routes with it; while it restarts they are absent).
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
   * plus what the app adds. Module issues are kept current by the host; `checkHealth` refreshes the rest.
   */
  readonly issues: IssueRegistry
  /**
   * Read `demand` and bring the issues in line with it (an unused module missing a program is a warning, a used one
   * an error, through `uses` too), starting and stopping nothing: `pnpm start doctor`, which judges and never starts.
   */
  readonly evaluate: Effect.Effect<void>
  /**
   * "Check again": judge every module's availability again (after the app probed again) and try again every module
   * that is down after a failed start, whether or not a probe result changed. Completes when the pass has finished.
   */
  readonly recheck: Effect.Effect<void>
  /**
   * Run every available module's `health()` (5 s each, concurrently; never on a turn) with its shared settings and
   * put what they return in `issues`. A health check that fails or times out is a warning of its own.
   */
  readonly checkHealth: Effect.Effect<void>
  /** The turn's action catalogue (`ModuleHostApi.actions`), for the app and tests. */
  readonly actions: ActionCatalogue
  /** The read-only view modules get (`ModuleHostApi.view`). */
  readonly view: () => HostView
  /** A service of a demanded module's `shared` part (`ModuleHostApi.service`). */
  readonly service: <T>(key: ServiceKey<T>) => T | undefined
  /** The values contributed under a key, for the calling fiber's assistant (`ModuleHostApi.contributions`). */
  readonly contributions: <T>(key: ContributionKey<T>) => Effect.Effect<ReadonlyArray<T>>
  /** The same for an assistant named explicitly, `undefined` for every provider (`ModuleHostApi.contributionsFor`). */
  readonly contributionsFor: <T>(key: ContributionKey<T>, assistantId: string | undefined) => ReadonlyArray<T>
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
  /** Time a module's `shared` or `start` may take. Default 10 s. */
  readonly startTimeoutMs?: number
  /** Time closing one part's scope (its finalizers) may take before it is abandoned and reported. Default 5 s. */
  readonly stopTimeoutMs?: number
  /** Time a stopped module's calls in flight may take to finish before they are interrupted. Default 10 s. */
  readonly graceMs?: number
  /** Time closing the host may take in all (stopping every module, pending saves). Default 30 s. */
  readonly closeTimeoutMs?: number
  /** Time a context provider may take per turn. Default 50 ms. */
  readonly contextTimeoutMs?: number
  /**
   * Linked defaults of a module's fields (docs/ASSISTANTS.md §2.6, computed from Home): used instead of the field's
   * own default when nothing is saved and the environment does not set it. Read with every write of the desired
   * state; `refresh` restarts the modules whose settings they changed.
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
   * Which modules and tools each assistant has on (serve mode: its module choices and `offTools`), and whether a
   * principal's parts belong together: the execution gateway's first checks, and the turn's action catalogue.
   * Absent: no access checks (the CLI modes).
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
}

// ---------------------------------------------------------------------------------------------------------------------
// Internal state

/**
 * What one module should be, as triggers write it. Never mutated: a write replaces the object, so a pass captures
 * the whole desired state by keeping the objects it read at its start.
 */
interface Desired {
  /** The saved switch (read only for a module without demand). */
  readonly enabled: boolean
  /** The owner has chosen on or off (saved); before that, `enabledByDefault` / `enabledWhenSet` decide. */
  readonly chosen: boolean
  readonly stored: Readonly<Record<string, unknown>>
  /** The secrets the vault reports (and configure changes). */
  readonly secrets: Readonly<Record<string, string>>
  /** Counts configured secret changes: a new one restarts the module (a vault lock or unlock does not count). */
  readonly secretEpoch: number
  /** Counts changes of its secrets by the vault (a failed start is tried again after one). */
  readonly vaultEpoch: number
  /** Who wants it; `undefined`: no demand (it follows its switch). */
  readonly demand: ReadonlyArray<ModuleDemand> | undefined
  readonly defaults: Readonly<Record<string, unknown>> | undefined
  /** Why it cannot run here (`unavailable`), judged at creation and on `recheck`. */
  readonly unavailable: ModuleUnavailable | undefined
  readonly statuses: ReadonlyArray<RequirementStatus>
  /** Restarts applied (`requestRestart`, throttled): a change starts it again. */
  readonly restarts: number
  /** A failed start is tried again only after this (or something else in its attempt) changes. */
  readonly retry: number
}

/** One part of a run (its shared part or an instance): its scope and where it is in its life. */
interface Part {
  readonly id: number
  readonly entry: Entry
  readonly kind: "shared" | "instance"
  readonly scope: Scope.Closeable
  state: PartState
  /** Its own `shared` / `start` has not returned yet: `PartHandle.register` is open only until then. */
  registering: boolean
  /** Registrations it made during its start (`PartHandle.register`): published with the module. */
  readonly staged: Array<Registration>
  readonly handle: PartHandle
  /**
   * P3: an instance part's field-action presses (its handlers, a generated Test). Made with the part, stopped by
   * `closePart` before the part's scope closes (so a press has ended, its cleanup run, before the instance's
   * resources and then its shared part's are released); refuses new presses from then on.
   */
  readonly presses: FieldActionOwner | undefined
}

interface InstanceRun {
  readonly part: Part
  readonly key: string
  users: ReadonlyArray<string>
  ownKeys: ReadonlyArray<string>
  readonly instance: ModuleInstance
  /** Its tools plus the generated action tools, sealed (only the gateway runs them). */
  readonly tools: ReadonlyArray<Tool>
  readonly actions: ReadonlyArray<RegisteredAction>
  status: StatusLine | undefined
}

/** One start of a module: its shared part and its instances, published together and stopped together. */
interface Run {
  readonly id: number
  readonly entry: Entry
  readonly target: HostTarget
  /**
   * The desired state it runs for now: its start's, then that of every later pass that kept it (assistants moving
   * between equal instances, a changed default of an overridable field). `settingsFor` answers from it.
   */
  accepted: Desired
  state: "starting" | "live" | "withdrawn" | "closed"
  shared: { readonly part: Part; readonly value: SharedPart<unknown> } | undefined
  readonly instances: Map<string, InstanceRun>
  /** What it published (withdrawn in reverse when it stops). */
  registrations: ReadonlyArray<Registration>
  /** Calls of its tools, actions and context providers in flight. */
  inflight: number
  idle: Deferred.Deferred<void> | undefined
  /** Completed when its grace period is over: the calls still in flight are interrupted. */
  readonly killed: Deferred.Deferred<void>
}

interface Entry {
  readonly def: ModuleDefinition<any>
  /** Position in `uses` order (providers first). */
  rank: number
  /** The catalogue itself is wrong for it (its `uses` form a cycle): an error, never started. */
  readonly catalogError: string | undefined
  /** The desired state now. */
  want: Desired
  /** The desired state the last pass published it with (its availability and who wants it, as the snapshot shows). */
  shown: Desired
  /** The published run. */
  run: Run | undefined
  /** The worker is starting or stopping it now. */
  phase: "idle" | "starting" | "stopping"
  /** While it starts: what it starts (its instances are shown as starting). */
  starting: HostTarget | undefined
  /** Its last start failed (or its settings are not valid): down until its attempt key changes. */
  failure: { readonly attempt: string; readonly message: string; readonly fieldErrors?: ReadonlyArray<FieldError>; readonly instances: ReadonlyArray<InstanceTarget> } | undefined
  /** Instances of the last pass whose settings are not valid (shown as errors for their assistants, never started). */
  invalid: ReadonlyArray<HostInstanceTarget>
  /** Module code that hung or a registration that threw: reported until "Check again". */
  problems: Array<{ readonly title: string; readonly detail: string }>
  restartRequests: number
  lastRestartAt: number
  restartTimer: boolean
  saveRequested: number
  saveDone: number
  revision: number
  announced: string
}

interface HostInstanceTarget extends InstanceTarget {
  readonly resolved: ResolvedSettings<unknown>
}

interface HostTarget extends ModuleTarget {
  readonly shared: { readonly key: string; readonly settings: Readonly<Record<string, unknown>> | undefined; readonly errors: ReadonlyArray<FieldError> } | undefined
  readonly instances: ReadonlyArray<HostInstanceTarget>
  readonly fieldErrors: ReadonlyArray<FieldError> | undefined
  /** The secrets it starts with (a restart while the vault is locked reuses what runs). */
  readonly secrets: Readonly<Record<string, string>>
  /** The desired state it was planned from (`settingsFor` answers from it). */
  readonly desired: Desired
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

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** An unavailable reason made safe for the wire's `ModuleUnavailable` (reason ≤ 500, the fix's label ≤ 200, value ≤ 1000). */
const wireUnavailable = (u: ModuleUnavailable): ModuleUnavailable => {
  const safe = wireSafeIssue({ id: "u", severity: "warning", title: "", detail: String(u.reason ?? ""), ...(u.fix !== undefined ? { fix: u.fix } : {}) }, "u", 0)
  const reason = clip(safe.detail.replace(/\s+/g, " "), 500)
  const out: ModuleUnavailable = { reason, ...(safe.fix !== undefined && u.fix !== undefined ? { fix: safe.fix } : {}) }
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

/**
 * A module's restart requests are taken up at most once per this interval (the requests in between are merged into
 * the next one): a module cannot restart itself in a tight loop. Not a minimum distance between two restarts.
 */
const RESTART_INTERVAL_MS = 5_000

/** The template text all modules together may send (UTF-8 bytes), so the admin snapshot stays under the frame limit. */
const TEMPLATE_BUDGET_BYTES = 128 * 1024

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a bounded call into module code came to. */
type Bounded<A> = { readonly _tag: "done"; readonly exit: Exit.Exit<A, unknown> } | { readonly _tag: "hung" }

export const makeModuleHost = Effect.fnUntraced(function*(options: ModuleHostOptions) {
  const hostScope = yield* Effect.scope
  const startTimeoutMs = options.startTimeoutMs ?? 10_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000
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
    const want: Desired = {
      enabled: record?.enabled ?? def.enabledByDefault,
      chosen: record?.enabled !== undefined,
      stored: record?.settings ?? {},
      secrets: options.persistence.initial.secrets[def.id] ?? {},
      secretEpoch: 0,
      vaultEpoch: 0,
      demand: undefined,
      defaults: options.defaults?.(def.id),
      unavailable: undefined,
      statuses: [],
      restarts: 0,
      retry: 0
    }
    return {
      def,
      rank: 0,
      catalogError: cycle === undefined
        ? formProblem(def, (def.kind === "agent" || def.kind === "decider") && !Object.hasOwn(def.settings, "test"))
        : `Its "uses" form a cycle (${[...cycle, cycle[0]].join(" → ")}), so it cannot start. Fix the module catalogue.`,
      want,
      shown: want,
      run: undefined,
      phase: "idle",
      starting: undefined,
      failure: undefined,
      invalid: [],
      problems: [],
      restartRequests: 0,
      lastRestartAt: -Infinity,
      restartTimer: false,
      saveRequested: 0,
      saveDone: 0,
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

  // -- P3: what reaches the admin page; field-action presses ----------------------------------------------------------

  /** The secret fields of a module. */
  const secretKeys = (entry: Entry) => Object.entries(entry.def.settings as SettingsSpec).flatMap(([key, setting]) => (setting.secret ? [key] : []))
  /**
   * THE boundary for module-produced text on its way to a page (`PageBoundary`): it redacts every secret the module
   * was given (`given`) and every one known now (desired, the run's, the start's, environment), before anything is
   * clipped.
   */
  const boundary = makePageBoundary({
    current: (moduleId) => {
      const entry = byId.get(moduleId)
      if (entry === undefined) return []
      return secretKeys(entry).flatMap((key) => {
        const env = entry.def.settings[key]!.env
        return [
          entry.want.secrets[key] ?? "",
          entry.shown.secrets[key] ?? "",
          entry.run?.target.secrets[key] ?? "",
          entry.starting?.secrets[key] ?? "",
          env === undefined ? "" : options.env[env] ?? ""
        ]
      })
    }
  })
  /**
   * A plain function the module supplies (a field's `check` or decoder) run where the host calls it: one that throws
   * becomes that module's error (`fallback` with a bounded message), never the host's (docs/MODULES-PLAN.md §3.5).
   */
  const moduleCode = <A>(entry: Entry, f: () => A, fallback: (message: string) => A): A => {
    try {
      return f()
    } catch (error) {
      // What it threw passes the page boundary (matched whole) before it is shortened.
      return fallback(`${entry.def.name}: its settings could not be read (${clip(boundary.redact(entry.def.id, describe(error)).replace(/\s+/g, " "), 200)})`)
    }
  }

  /** The module's settings from these sources (a check or decoder that throws: not valid, with that error). */
  const resolveFrom = (
    entry: Entry,
    src: { readonly stored: Readonly<Record<string, unknown>>; readonly secrets: Readonly<Record<string, string>> },
    own: Readonly<Record<string, unknown>> | undefined,
    defaults: Readonly<Record<string, unknown>> | undefined
  ): ResolvedSettings<any> =>
    moduleCode(
      entry,
      () =>
        resolveSettings(entry.def.settings, {
          stored: src.stored,
          secrets: src.secrets,
          env: options.env,
          ...envOrigin,
          ...(defaults !== undefined ? { defaults } : {}),
          ...(own !== undefined ? { own } : {})
        }),
      (message) => ({ value: undefined, form: { fields: [], values: {}, secrets: {}, errors: [{ key: null, message }] } })
    )
  /** The settings as saved now (what the form shows). */
  const resolve = (entry: Entry) => resolveFrom(entry, entry.want, undefined, entry.want.defaults)

  const invalidMessage = (errors: ReadonlyArray<FieldError>) => `The settings are not valid: ${errors.map((e) => e.message).join("; ")}`

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
  /**
   * The first line of a cause as the page may show it: the whole text is matched by the boundary first, then cut, so
   * a secret that spans lines (or that the cut would split) is replaced whole. Every place the host shortens a
   * module's text goes through the boundary before it is shortened.
   */
  const firstLine = (moduleId: string, cause: Cause.Cause<unknown>) => boundary.redact(moduleId, Cause.pretty(cause)).split("\n")[0] || "unknown"
  const fieldActionTimeoutMs = options.fieldActionTimeoutMs ?? FIELD_ACTION_TIMEOUT_MS
  /**
   * The press slots of each module (`ModuleSlots`), across all its owners, so restarts cannot pile presses up: at
   * `MAX_PRESS_SLOTS` a further press is refused `busy`, and Health says so (`presses:<id>`) until a slot is free.
   */
  const pressSlots = makeModuleSlots({
    cap: MAX_PRESS_SLOTS,
    report: (moduleId, full) => {
      const entry = byId.get(moduleId)
      if (entry !== undefined) issues.set(`presses:${moduleId}`, full ? slotIssues(moduleId, entry.def.name, "presses", MAX_PRESS_SLOTS) : [])
    }
  })
  /** An owner of field-action presses (`FieldActionOwner`): an instance part's (keys are field keys), or the host's (`<module>/<key>`). */
  const pressOwner = (released: (key: string) => void, moduleOf: (key: string) => string) => makeFieldActionOwner({ released, slots: pressSlots, moduleOf })
  /**
   * The host's own presses (a definition's `fieldActions`, which run without an instance), keyed `<module>/<key>`:
   * made once with the host, stopped first when it closes (before anything else stops), refusing presses from then on.
   */
  const moduleOfKey = (key: string) => key.slice(0, key.indexOf("/"))
  const hostPresses = pressOwner((key) => {
    const entry = byId.get(moduleOfKey(key))
    // `info` values may have changed with the press.
    if (entry !== undefined) announce(entry)
  }, moduleOfKey)

  /**
   * Whether the module can run on this server (module API v2): a supported `apiVersion`, a listed platform, and every
   * required requirement met (as the app's probes last judged them). Synchronous; never probes.
   */
  const judge = (entry: Entry): Pick<Desired, "unavailable" | "statuses"> => {
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
      unavailable: missing === undefined ? undefined : wireUnavailable({ reason: missing.detail, ...(missing.fix !== undefined ? { fix: missing.fix } : {}) }),
      statuses
    }
  }
  /** Judge every module again (inside a write): its availability and requirement statuses become desired state. */
  const judgeAll = () => {
    const key = (d: Pick<Desired, "unavailable" | "statuses">) => JSON.stringify([d.unavailable ?? null, d.statuses.map((st) => [st.state, st.detail, st.fix ?? null])])
    for (const entry of entries) {
      const judged = judge(entry)
      if (key(judged) !== key(entry.want)) entry.want = { ...entry.want, ...judged }
    }
  }
  judgeAll()
  for (const entry of entries) entry.shown = entry.want

  // -- Desired state: who wants what ----------------------------------------------------------------------------------

  /**
   * Its own switch: the owner's choice; before one, on by default, or on while the `enabledWhenSet` key is set
   * (environment, saved or the vault). A module switched on by its key that runs keeps running when the vault locks.
   */
  const switchOn = (entry: Entry, d: Desired): boolean => {
    if (d.chosen) return d.enabled
    const key = entry.def.enabledWhenSet
    if (entry.def.enabledByDefault || key === undefined) return entry.def.enabledByDefault
    if (resolveFrom(entry, d, undefined, d.defaults).form.secrets[key]?.set === true) return true
    return entry.run !== undefined
  }

  /** Someone wants the module (its switch, or an assistant has it on). */
  const wantedBy = (entry: Entry, d: Desired) => (d.demand === undefined ? switchOn(entry, d) : d.demand.length > 0)

  /** The modules demand reaches (directly or through `uses`), able to run or not, in this picture of the desired state. */
  const demandedIn = (desired: (entry: Entry) => Desired): Set<Entry> => {
    const reached = reachedBy(entries.map((e) => {
      const d = desired(e)
      return {
        id: e.def.id,
        wanted: e.catalogError === undefined && wantedBy(e, d),
        blocked: d.unavailable !== undefined || e.catalogError !== undefined,
        uses: e.catalogError === undefined ? e.def.uses ?? [] : []
      }
    }))
    return new Set(entries.filter((e) => reached.has(e.def.id)))
  }

  /** The shared settings: everything resolved except the fields an assistant may own; the key is their non-secret values. */
  const sharedOf = (entry: Entry, src: { readonly stored: Readonly<Record<string, unknown>>; readonly secrets: Readonly<Record<string, string>> }, defaults: Desired["defaults"]) => {
    const resolved = resolveFrom(entry, src, undefined, defaults)
    const owned = new Set(overridableKeys(entry.def.settings))
    const without = (record: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(record).filter(([k]) => !owned.has(k)))
    // Only the fields the shared part receives are judged here: an assistant-owned field's invalid shared default
    // does not stop it (each instance validates its own effective settings in full).
    const errors = resolved.form.errors.filter((e) => e.key === null || !owned.has(e.key))
    const raw: Record<string, unknown> = { ...resolved.form.values }
    for (const [key, setting] of Object.entries(entry.def.settings as SettingsSpec)) {
      if (!setting.secret) continue
      const fromEnv = setting.env !== undefined && (options.env[setting.env] ?? "") !== "" ? options.env[setting.env] : undefined
      const saved = src.secrets[key]
      raw[key] = fromEnv ?? (saved !== undefined && saved.length > 0 ? saved : undefined)
    }
    return {
      key: JSON.stringify(without(resolved.form.values)),
      settings: errors.length === 0 ? without(resolved.value ?? raw) : undefined,
      errors
    }
  }

  /** What the desired state `d` asks of a module (`ModulePlanner.ModuleTarget`), with the settings to start with. */
  const targetOf = (entry: Entry, d: Desired, demanded: ReadonlySet<Entry>): HostTarget => {
    const id = entry.def.id
    const none: HostTarget = { id, runs: false, invalid: undefined, instances: [], fingerprint: "", attempt: "", shared: undefined, fieldErrors: undefined, secrets: {}, desired: d }
    if (closing || !demanded.has(entry) || d.unavailable !== undefined || entry.catalogError !== undefined) return none
    // A restart with the same configured secrets starts with what runs had (the vault may be locked since).
    const live = entry.run
    const secrets = live !== undefined && live.target.desired.secretEpoch === d.secretEpoch ? { ...live.target.secrets, ...d.secrets } : d.secrets
    const src = { stored: d.stored, secrets }
    const shared = entry.def.shared !== undefined ? sharedOf(entry, src, d.defaults) : undefined
    const groups = new Map<string, { users: Array<string>; ownKeys: Array<string>; resolved: ResolvedSettings<unknown> }>()
    const invalid: Array<HostInstanceTarget> = []
    const add = (assistantId: string | undefined, own: Readonly<Record<string, unknown>> | undefined) => {
      const resolved = resolveFrom(entry, src, own, d.defaults)
      const ownKeys = Object.keys(own ?? {})
      if (resolved.value === undefined) {
        // Never grouped with a valid assistant (its fallback values could equal theirs): its own error, for it alone.
        invalid.push({ key: `invalid:${assistantId ?? ""}`, users: assistantId === undefined ? [] : [assistantId], ownKeys, invalid: invalidMessage(resolved.form.errors), resolved })
        return
      }
      const key = JSON.stringify(resolved.form.values)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { users: assistantId === undefined ? [] : [assistantId], ownKeys: [...ownKeys], resolved })
      else {
        if (assistantId !== undefined) group.users.push(assistantId)
        for (const k of ownKeys) if (!group.ownKeys.includes(k)) group.ownKeys.push(k)
      }
    }
    if (d.demand === undefined) add(undefined, undefined)
    else for (const dm of d.demand) add(dm.assistantId, applicableOwnValues(entry.def.settings, dm.own))
    const valid = [...groups].map(([key, g]): HostInstanceTarget => ({ key, users: g.users, ownKeys: g.ownKeys, invalid: undefined, resolved: g.resolved }))
    // Demanded only through `uses` and without a shared part: nothing to run.
    if (shared === undefined && valid.length === 0 && invalid.length === 0) return none
    const fieldErrors = shared !== undefined && shared.settings === undefined ? shared.errors : shared === undefined && valid.length === 0 ? invalid[0]?.resolved.form.errors : undefined
    const why = shared !== undefined && shared.settings === undefined ? invalidMessage(shared.errors) : shared === undefined && valid.length === 0 ? invalid[0]!.invalid : undefined
    const fingerprint = JSON.stringify([shared?.key ?? null, valid.map((i) => i.key).sort(), d.secretEpoch, d.restarts])
    return {
      id,
      runs: true,
      invalid: why,
      instances: [...valid, ...invalid],
      fingerprint,
      attempt: JSON.stringify([fingerprint, d.vaultEpoch, d.statuses.map((st) => [st.state, st.detail]), d.retry]),
      shared,
      fieldErrors,
      secrets,
      desired: d
    }
  }

  // -- What the module's info shows -----------------------------------------------------------------------------------

  /** The instance with the shared settings when it runs, else the first one. */
  const mainOf = (entry: Entry): InstanceRun | undefined => {
    const running = [...(entry.run?.instances.values() ?? [])]
    return running.find((r) => r.ownKeys.length === 0) ?? running[0]
  }

  /** The published instance an assistant uses. */
  const instanceFor = (entry: Entry, assistantId: string): InstanceRun | undefined => {
    for (const r of entry.run?.instances.values() ?? []) if (r.users.includes(assistantId)) return r
    return undefined
  }

  /** The module's state: what the worker is doing with it, what runs, or why nothing does. */
  const stateOf = (entry: Entry): { readonly state: ModuleState; readonly error?: string } => {
    if (entry.catalogError !== undefined) return { state: "error", error: entry.catalogError }
    if (entry.shown.unavailable !== undefined) return { state: "unavailable" }
    if (entry.phase === "starting") return { state: "starting" }
    if (entry.phase === "stopping") return { state: "stopping" }
    if (entry.run !== undefined) {
      const bad = entry.invalid[0]
      if (bad === undefined) return { state: "running" }
      return { state: "error", error: `${bad.invalid} (for ${entry.invalid.flatMap((i) => i.users).join(", ")})` }
    }
    if (entry.failure !== undefined) return { state: "error", error: entry.failure.message }
    return { state: "disabled" }
  }

  /** The instances as the page sees them: their errors and status lines through the boundary. */
  const instanceInfos = (entry: Entry): Array<ModuleInstanceInfo> => {
    const id = entry.def.id
    const out: Array<ModuleInstanceInfo> = []
    for (const r of entry.run?.instances.values() ?? []) {
      const status = boundary.status(id, r.status)
      out.push({ assistants: [...r.users], own: [...r.ownKeys], state: "running", ...(status !== undefined ? { status } : {}) })
    }
    if (entry.phase === "starting" && entry.starting !== undefined) {
      for (const t of entry.starting.instances) if (t.invalid === undefined) out.push({ assistants: [...t.users], own: [...t.ownKeys], state: "starting" })
    } else if (entry.run === undefined && entry.failure !== undefined) {
      for (const t of entry.failure.instances) out.push({ assistants: [...t.users], own: [...t.ownKeys], state: "error", error: boundary.text(id, entry.failure.message, 2000) })
    }
    for (const t of entry.invalid) {
      if (entry.failure?.instances.includes(t) === true && entry.run === undefined) continue
      out.push({ assistants: [...t.users], own: [...t.ownKeys], state: "error", error: boundary.text(id, t.invalid!, 2000) })
    }
    return out
  }

  const templateBudget = new Map<Entry, { readonly list: Array<AssistantTemplate>; readonly left: number }>()
  {
    const encoder = new TextEncoder()
    let used = 0
    for (const entry of entries) {
      const all = (entry.def.templates ?? []).map((t): AssistantTemplate => ({
        id: `${entry.def.id}.${t.id}`,
        name: t.name,
        prompt: t.prompt,
        ...(t.purpose !== undefined ? { purpose: t.purpose } : {}),
        ...(t.handles !== undefined ? { handles: t.handles } : {}),
        modules: [...(t.modules ?? [entry.def.id])],
        ...(t.suggestedPhrases !== undefined ? { suggestedPhrases: [...t.suggestedPhrases] } : {})
      }))
      const list: Array<AssistantTemplate> = []
      for (const t of all) {
        const size = encoder.encode(JSON.stringify(t)).length
        if (list.length === MAX_MODULE_TEMPLATES || used + size > TEMPLATE_BUDGET_BYTES) break
        used += size
        list.push(t)
      }
      if (all.length > 0) templateBudget.set(entry, { list, left: all.length - list.length })
    }
  }

  /**
   * The module as the page sees it. Everything in it the module produced at run time passes the boundary: its start
   * error, status line, tools, form decorations (`decorateForm`, from the published main instance) and its live
   * routes (the route table publication fills).
   */
  const info = (entry: Entry): ModuleInfo => {
    const id = entry.def.id
    const { error, state } = stateOf(entry)
    const main = mainOf(entry)
    const status = boundary.status(id, main?.status)
    const routes = routeTable.get(id)?.routes ?? []
    const tools = new Map<string, Tool>()
    for (const r of [...(main === undefined ? [] : [main]), ...(entry.run?.instances.values() ?? [])]) {
      for (const t of r.tools) if (!tools.has(t.name)) tools.set(t.name, t)
    }
    const templates = templateBudget.get(entry)?.list ?? []
    return {
      id: entry.def.id,
      name: entry.def.name,
      description: entry.def.description,
      enabled: wantedBy(entry, entry.want),
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
      // A form that cannot be sent (the module does not start, `formProblem`) is not sent either.
      settings: entry.catalogError !== undefined && !cycles.has(id) ? EMPTY_FORM : decorateForm(entry, resolve(entry).form),
      revision: entry.revision,
      ...(entry.def.kind !== undefined ? { kind: entry.def.kind } : {}),
      ...(entry.want.demand !== undefined ? { instances: instanceInfos(entry) } : {}),
      ...(entry.shown.unavailable !== undefined ? { unavailable: entry.shown.unavailable } : {}),
      ...(entry.def.version !== undefined ? { version: entry.def.version } : {}),
      ...(entry.def.apiVersion !== undefined ? { apiVersion: entry.def.apiVersion } : {}),
      ...(templates.length > 0 ? { templates } : {}),
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
      // Matched whole, then bounded to the wire's length (a short secret repeated in a long path expands it).
      path: route.path === "" ? prefix : clip(`${prefix}/${boundary.redact(moduleId, route.path)}`, MAX_ROUTE_PATH + 100),
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
    const instance = mainOf(entry)?.instance
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
    const base = generated ? [...form.fields, GENERATED_TEST_FIELD] : form.fields
    // What the instance adds fits in what the described form leaves of the module's budget (`MODULE_FORM_BUDGET_BYTES`).
    let room = MODULE_FORM_BUDGET_BYTES - formBytes(base)
    const fields = base.map((field): SettingField => {
      const info = own(infos, field.key)
      // Through the boundary: an info value never carries one of the module's secrets to the page.
      if (field.type === "info" && typeof info === "string") {
        const shown = withinBytes(boundary.text(entry.def.id, info, 1000), room)
        values[field.key] = shown
        room -= jsonBytes(shown)
      }
      if (field.type !== "combo") return field
      // A closed combo accepts only its static options (`Setting.combo`), so only an open one shows the instance's.
      if (!field.allowCustom) return field
      // Through the boundary too: display texts redacted, an option whose value holds a secret dropped.
      const list = boundary.options(entry.def.id, own(options, field.key))
      const known = new Set(field.options.map((o) => o.value))
      const added = (list ?? []).filter((o) => !known.has(o.value) && (known.add(o.value), true))
      // Within the wire's bounds: at most MAX_COMBO_OPTIONS in all and MAX_OPTIONS_JSON as JSON (the last go), and
      // within the module's budget.
      const bounded = withinOptionBounds([...field.options, ...added], field.options.length)
      const all = [...field.options]
      for (const option of bounded.slice(field.options.length)) {
        const cost = jsonBytes(option) + 1
        if (cost > room) break
        room -= cost
        all.push(option)
      }
      const more = field.options.length + added.length - all.length
      const counted = more > 0 ? `${all.length} suggestions from ${entry.def.name} and ${more} more` : `${all.length} suggestions from ${entry.def.name}`
      const note = instance === undefined ? "Not running: type a name" : list !== undefined ? counted : undefined
      // "and N more" is always visible, also beside the field's own note.
      const shownNote = more > 0 && field.optionsNote !== undefined ? `${field.optionsNote} (and ${more} more)` : field.optionsNote ?? note
      return { ...field, options: all, ...(shownNote !== undefined ? { optionsNote: clip(shownNote, MAX_FIELD_LABEL) } : {}) }
    })
    return { ...checked, fields, values }
  }

  /** An agent or decision provider without a `test` field of its own gets the generated Test button. */
  const generatesTest = (entry: Entry) => (entry.def.kind === "agent" || entry.def.kind === "decider") && !Object.hasOwn(entry.def.settings, "test")

  /** The module's own issues (source `module:<id>`): requirements, unavailable, a failed start, what hung. */
  const moduleIssues = (entry: Entry, demandedNow: ReadonlySet<Entry>): ReadonlyArray<Issue> => {
    const id = entry.def.id
    const name = entry.def.name
    const out: Array<Issue> = []
    // An error only for a module that would run (someone wants it, directly or through `uses`): an unused module
    // missing a program does not fail `doctor`.
    const severity = demandedNow.has(entry) ? "error" : "warning"
    const unused = severity === "warning" && entry.want.demand !== undefined ? " (No assistant has it on.)" : ""
    const page = { kind: "link", label: `Open ${name}`, value: `#settings/shared/modules/${id}` } as const
    if (entry.catalogError !== undefined) {
      out.push({ id: cycles.has(id) ? `${id}.uses` : `${id}.form`, module: id, severity: "error", title: `${name} cannot start`, detail: entry.catalogError })
    }
    for (const st of entry.want.statuses) {
      if (st.state !== "missing") continue
      const r = st.requirement
      const why = r.why
      const optional = isOptionalRequirement(r)
      out.push({
        id: `${id}.requires.${requirementKey(r)}`,
        module: id,
        severity: optional ? "warning" : severity,
        title: st.detail,
        detail: `${name} ${optional ? "can use it" : "needs it"}${why === undefined ? "." : `: ${why}${/[.!?]$/.test(why) ? "" : "."}`}${optional ? "" : unused}`,
        ...(st.fix !== undefined ? { fix: st.fix } : {})
      })
    }
    if (entry.want.unavailable !== undefined && out.length === 0) {
      out.push({
        id: `${id}.unavailable`,
        module: id,
        severity,
        title: `${name} cannot run on this server`,
        detail: `${entry.want.unavailable.reason}${unused}`,
        ...(entry.want.unavailable.fix !== undefined ? { fix: entry.want.unavailable.fix } : {})
      })
    }
    const { error, state } = stateOf(entry)
    if (state === "error" && entry.catalogError === undefined) {
      // The start error may be the module's own words: through the boundary (the host's words around it are not).
      out.push({ id: `${id}.start`, module: id, severity: "error", title: `${name} could not start`, detail: boundary.redact(id, error ?? ""), fix: page })
    }
    // What hung or threw: a registration's or a module's error may be in the detail, so it passes the boundary too.
    entry.problems.forEach((p, i) => out.push({ id: `${id}.problem.${i}`, module: id, severity: "warning", title: p.title, detail: boundary.redact(id, p.detail) }))
    const templates = templateBudget.get(entry)
    if (templates !== undefined && templates.left > 0) {
      out.push({
        id: `${id}.templates`,
        module: id,
        severity: "warning",
        title: `${name}: ${templates.left} of its suggested assistants are not offered`,
        detail: `A module offers at most ${MAX_MODULE_TEMPLATES}, and all modules' suggested assistants together must fit the admin page.`
      })
    }
    // Host-made issues: the module's words in them (a start error, a problem's detail) passed the boundary above.
    return normaliseIssues(entry.def.id, entry.def.name, out, (value, max) => boundary.text(entry.def.id, value, max), true)
  }

  /** Every module's issues again (a change of demand changes the severity of the modules it reaches too). */
  const refreshIssues = () => {
    const demandedNow = demandedIn((e) => e.want)
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

  // -- Calls into a published run ---------------------------------------------------------------------------------------

  /** A tool or action of a run that was withdrawn (a turn that held an old snapshot). */
  const gone = (entry: Entry) => `${entry.def.name} was stopped or started again since this turn began; ask again.`

  /**
   * A call into a run's code (a tool, an action, a context provider): refused once the run is withdrawn; counted while
   * in flight, so a stop gives it the grace period; interrupted when the grace period is over. The waiting happens in
   * the caller's fiber, never in the worker's.
   */
  const guarded = <A, E>(run: Run, body: () => Effect.Effect<A, E>, refused: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      if (run.state !== "live") return refused()
      run.inflight++
      return Effect.raceFirst(Effect.suspend(body), Effect.flatMap(Deferred.await(run.killed), refused)).pipe(
        Effect.ensuring(Effect.sync(() => {
          run.inflight--
          if (run.inflight === 0 && run.idle !== undefined) Deferred.doneUnsafe(run.idle, Effect.void)
        }))
      )
    })

  const wrapProvider = (entry: Entry, run: Run, provider: ContextProvider): ContextProvider => ({
    name: provider.name,
    get: guarded(run, () => provider.get, () => Effect.succeed("")).pipe(
      Effect.timeoutOrElse({
        duration: contextTimeoutMs,
        orElse: () =>
          Effect.as(
            Effect.logWarning(`Context provider "${provider.name}" (module ${entry.def.id}) took over ${contextTimeoutMs} ms; left out of this turn`),
            ""
          )
      }),
      Effect.catchCause((cause) => Effect.as(Effect.logWarning(`Context provider "${provider.name}" failed`, cause), ""))
    )
  })

  /** An instance's actions and tools, sealed: only the gateway reaches them, through the run's in-flight tracking. */
  const contributionsOf = (run: Run, instance: ModuleInstance) => {
    const entry = run.entry
    const actions = registerActions(entry.def.id, instance.actions ?? []).map((a) =>
      sealAction(a, (values) => guarded(run, () => a.definition.run(values as never), () => Effect.fail(new ActionError({ message: gone(entry) }))))
    )
    const generated = actions.filter((a) => a.definition.offerAsTool !== false).map(actionTool)
    const own = (instance.tools ?? []).map((t) =>
      sealTool(t, (input) => guarded(run, () => t.execute(input), () => Effect.fail(new ToolError({ message: gone(entry) }))))
    )
    return { actions, tools: [...own, ...generated] }
  }

  // -- The snapshot ---------------------------------------------------------------------------------------------------

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
      ).map((a) => sealAction(a, (values) => a.definition.run(values as never)))
      part = { moduleId: entry.def.id, module: { name: entry.def.id, tools: [], context: [], intentActions: standIns }, instructions: line, unavailable: true }
      unavailableParts.set(entry, part)
    }
    return part
  }

  /** One part per running instance, made once (so every snapshot and every assistant shares the same object). */
  const parts = new WeakMap<InstanceRun, ModulePart>()
  const partOf = (entry: Entry, run: Run, inst: InstanceRun): ModulePart => {
    let part = parts.get(inst)
    if (part === undefined) {
      const intentOnly = inst.actions.filter((a) => a.definition.offerAsTool === false)
      part = {
        moduleId: entry.def.id,
        module: {
          name: entry.def.id,
          tools: inst.tools,
          context: (inst.instance.context ?? []).map((p) => wrapProvider(entry, run, p)),
          ...(intentOnly.length > 0 ? { intentActions: intentOnly } : {})
        },
        instructions: inst.instance.instructions?.trim() ?? ""
      }
      parts.set(inst, part)
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
      e.shown.unavailable === undefined ? null : [e.shown.unavailable.reason, e.shown.demand === undefined ? switchOn(e, e.shown) : e.shown.demand.map((d) => d.assistantId)],
      e.run?.id ?? null,
      [...(e.run?.instances.values() ?? [])].map((r) => [r.key, r.users, r.ownKeys.length]),
      // Who wants it, running or not: `assistantParts` has an entry per assistant named anywhere.
      e.shown.demand?.map((d) => d.assistantId) ?? null
    ]))
  /** The snapshot of what is published, from the runs and the picture each module was published with. */
  const buildSnapshot = (): ModuleSnapshot => {
    const mains = entries.flatMap((e) => {
      const r = e.shown.unavailable === undefined && e.run !== undefined ? mainOf(e) : undefined
      return r === undefined ? [] : [{ e, run: e.run!, r }]
    })
    /** The main parts in catalog order: the running ones, and an unavailable one wherever it is wanted (no demand). */
    const mainParts = entries.flatMap((e) => {
      if (e.shown.unavailable !== undefined) return e.shown.demand === undefined && switchOn(e, e.shown) ? [unavailablePartOf(e, e.shown.unavailable)] : []
      const r = e.run === undefined ? undefined : mainOf(e)
      return r === undefined ? [] : [partOf(e, e.run!, r)]
    })
    const toolModules = new Map<string, string>()
    for (const e of entries) for (const r of e.run?.instances.values() ?? []) for (const t of r.tools) toolModules.set(t.name, e.def.id)
    const agents = new Map<string, Agent>()
    const deciders = new Map<string, DecisionProvider>()
    for (const { r } of mains) {
      for (const agent of r.instance.agents ?? []) if (!agents.has(agent.id)) agents.set(agent.id, agent)
      for (const decider of r.instance.deciders ?? []) if (!deciders.has(decider.id)) deciders.set(decider.id, decider)
    }
    const assistantParts = new Map<string, ReadonlyArray<ModulePart>>()
    for (const e of entries) {
      for (const d of e.shown.demand ?? []) {
        if (assistantParts.has(d.assistantId)) continue
        assistantParts.set(
          d.assistantId,
          entries.flatMap((x) => {
            if (x.shown.unavailable !== undefined) {
              const wants = x.shown.demand === undefined ? switchOn(x, x.shown) : x.shown.demand.some((w) => w.assistantId === d.assistantId)
              return wants ? [unavailablePartOf(x, x.shown.unavailable)] : []
            }
            if (x.run === undefined) return []
            const r = x.shown.demand === undefined ? mainOf(x) : instanceFor(x, d.assistantId)
            return r === undefined ? [] : [partOf(x, x.run, r)]
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
      // Cannot happen (a start refuses clashing tool names); kept so a host bug never leaves turns without tools.
      Effect.runSync(Effect.logError("The module snapshot could not be rebuilt; the previous one stays", error))
    }
  }

  // -- Registrations --------------------------------------------------------------------------------------------------

  /** Published claims by kind: claim → the module that holds it. */
  const claims = new Map<string, Map<string, Entry>>()
  /** Published services by key id. */
  const liveServices = new Map<string, { readonly entry: Entry; readonly service: unknown }>()
  /** Published contributions by module. */
  const liveContributions = new Map<Entry, ReadonlyArray<ProvidedContribution>>()
  /** Instances by part id, while they are open (the tool registrar reads their names). */
  const instanceByPart = new Map<number, InstanceRun>()
  /** P3: published module routes by module id: the published shared part's (`host.routes()`, `ModuleInfo.routes`). */
  const routeTable = new Map<string, { readonly routes: ReadonlyArray<ModuleRoute>; readonly scope: Scope.Scope; readonly stopped: Effect.Effect<void> }>()

  /**
   * The kinds declared by what a part returns (`ModuleRegistrations.ts`). A later PR adds its kind here, one entry
   * (P3: `routes`, from `SharedPart.routes`).
   */
  const registrars: ReadonlyArray<Registrar> = [
    // Services of a shared part: one provider per key, looked up live (`host.service`).
    ({ handle, shared }) => {
      const services = shared?.services ?? []
      if (services.length === 0) return []
      const entry = byId.get(handle.moduleId)!
      return [{
        kind: "service",
        claims: services.map((p) => p.key.id),
        clash: (claim, owner) => `The service "${claim}" is already provided by module ${owner}`,
        publish: () => {
          for (const p of services) liveServices.set(p.key.id, { entry, service: p.service })
        },
        withdraw: () => {
          for (const p of services) if (liveServices.get(p.key.id)?.entry === entry) liveServices.delete(p.key.id)
        }
      }]
    },
    // Contributions of a shared part (`host.contributions`).
    ({ handle, shared }) => {
      const list = shared?.contributions ?? []
      if (list.length === 0) return []
      const entry = byId.get(handle.moduleId)!
      return [{
        kind: "contribution",
        publish: () => void liveContributions.set(entry, [...list]),
        withdraw: () => void liveContributions.delete(entry)
      }]
    },
    // An instance's tool names, unique across modules (its tools reach turns through the snapshot, rebuilt from the
    // published runs right after they are published).
    ({ handle, instance }) => {
      const inst = instance === undefined ? undefined : instanceByPart.get(handle.id)
      if (inst === undefined || inst.tools.length === 0) return []
      return [{
        kind: "tool",
        claims: inst.tools.map((t) => t.name),
        clash: (claim, owner) => `Tool name "${claim}" is already used by module ${owner}`,
        publish: () => {},
        withdraw: () => {}
      }]
    },
    // P3: a shared part's HTTP routes (`SharedPart.routes`), one entry per module in the route table. Checked before
    // the module is published (a bad declaration fails its start); live from its publication until it is withdrawn
    // (only one start of a module is ever published), so a request is only ever routed to the published part.
    ({ handle, shared }) => {
      const declared = shared?.routes
      if (declared === undefined || declared.length === 0) return []
      const routes = [...declared]
      // A handler runs as a call in flight of its module's published run (`guarded`): refused once the module is
      // withdrawn, given the grace period when it stops, interrupted after it (the router answers 503).
      const live = routes.map((route): ModuleRoute =>
        typeof route === "object" && route !== null && typeof route.handler === "function"
          ? {
            ...route,
            handler: (request) =>
              Effect.suspend(() => {
                const run = byId.get(handle.moduleId)?.run
                if (run === undefined || run.shared?.part.id !== handle.id) return Effect.interrupt
                return guarded(run, () => route.handler(request), () => Effect.interrupt)
              })
          }
          : route
      )
      // The host's stop signal for this part's handlers: its run's grace period is over (`run.killed`); at once when
      // the part is no longer the published one (its handler is refused then too).
      const stopped = Effect.suspend(() => {
        const run = byId.get(handle.moduleId)?.run
        return run !== undefined && run.shared?.part.id === handle.id ? Deferred.await(run.killed) : Effect.void
      })
      return [{
        kind: "route",
        // The full paths: unique across modules by construction (each module has its own prefix).
        claims: routes.map((r) => `${r.method} ${routeInfo(handle.moduleId, r).path}`),
        validate: () => routeProblem(routes),
        publish: () => void routeTable.set(handle.moduleId, { routes: live, scope: handle.scope, stopped }),
        withdraw: () => void routeTable.delete(handle.moduleId)
      }]
    },
    ...(options.registrars ?? [])
  ]

  /** Why `regs` of module `entry` cannot be published now (a claim another module holds, their own check), else `undefined`. */
  const refusalOf = (entry: Entry, regs: ReadonlyArray<Registration>): string | undefined => {
    const mine = new Map<string, Set<string>>()
    for (const r of regs) {
      const table = claims.get(r.kind)
      const own = mine.get(r.kind) ?? new Set<string>()
      mine.set(r.kind, own)
      for (const claim of r.claims ?? []) {
        const owner = table?.get(claim)
        if (owner !== undefined && owner !== entry) {
          try {
            return r.clash?.(claim, owner.def.name) ?? `"${claim}" is already taken by module ${owner.def.name}`
          } catch {
            return `"${claim}" is already taken by module ${owner.def.name}`
          }
        }
        own.add(claim)
      }
      let problem: string | undefined
      try {
        problem = r.validate?.()
      } catch (error) {
        problem = `Its ${r.kind} could not be checked: ${describe(error)}`
      }
      if (problem !== undefined) return String(problem)
    }
    return undefined
  }

  const claim = (entry: Entry, r: Registration) => {
    let table = claims.get(r.kind)
    if (table === undefined) claims.set(r.kind, table = new Map())
    for (const c of r.claims ?? []) table.set(c, entry)
  }
  const unclaim = (entry: Entry, r: Registration) => {
    const table = claims.get(r.kind)
    for (const c of r.claims ?? []) if (table?.get(c) === entry) table.delete(c)
  }

  /** Publish every registration of a run, in one synchronous step: all, or (one throws) none. */
  const publishAll = (entry: Entry, regs: ReadonlyArray<Registration>): string | undefined => {
    const done: Array<Registration> = []
    for (const r of regs) {
      try {
        r.publish()
        claim(entry, r)
        done.push(r)
      } catch (error) {
        withdrawAll(entry, done)
        return `Its ${r.kind} could not be published: ${describe(error)}`
      }
    }
    return undefined
  }

  /** Withdraw registrations, last first, in one synchronous step; a throw is reported and the rest are withdrawn. */
  const withdrawAll = (entry: Entry, regs: ReadonlyArray<Registration>) => {
    for (const r of [...regs].reverse()) {
      unclaim(entry, r)
      try {
        r.withdraw()
      } catch (error) {
        entry.problems.push({ title: `${entry.def.name}: its ${r.kind} could not be withdrawn`, detail: describe(error) })
      }
    }
  }

  // -- Module code, bounded ---------------------------------------------------------------------------------------------

  let closing = false
  /** P3: shutdown has begun: no field action is admitted from now on. */
  let pressesClosed = false
  const closingSignal = Deferred.makeUnsafe<void>()

  /**
   * Run `work` (module code) in a fiber of its own, at most `ms`: the worker waits for its result, never longer; one
   * that does not finish in time (or, for a start, when the host closes) is interrupted without waiting and abandoned.
   * An interruption, failure or defect inside it is its result, never the worker's.
   */
  const bounded = <A>(work: Effect.Effect<A, unknown>, ms: number, abandonOnClose: boolean): Effect.Effect<Bounded<A>> =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkDetach(outsideTurns(work))
      const waited = Effect.map(Fiber.await(fiber), Option.some)
      const exit = yield* (abandonOnClose ? Effect.raceFirst(waited, Effect.as(Deferred.await(closingSignal), Option.none())) : waited).pipe(
        Effect.timeoutOption(ms),
        Effect.map(Option.flatten)
      )
      if (Option.isSome(exit)) return { _tag: "done", exit: exit.value } as const
      fiber.interruptUnsafe()
      return { _tag: "hung" } as const
    })

  const describeStartFailure = (moduleId: string, cause: Cause.Cause<unknown>): string => {
    const error = Cause.findErrorOption(cause)
    if (error._tag === "Some" && error.value instanceof ModuleStartError) return error.value.message
    if (Cause.hasInterruptsOnly(cause)) return "It was interrupted while starting"
    return `The module crashed while starting: ${firstLine(moduleId, cause)}`
  }

  let nextId = 0
  const openParts = new Set<Part>()

  const newPart = (entry: Entry, kind: "shared" | "instance") =>
    Effect.map(Scope.make(), (scope): Part => {
      const id = ++nextId
      const staged: Array<Registration> = []
      const part: Part = {
        id,
        entry,
        kind,
        scope,
        state: "starting",
        registering: true,
        staged,
        handle: {
          moduleId: entry.def.id,
          moduleName: entry.def.name,
          kind,
          id,
          state: () => part.state,
          scope,
          register: (registration) => {
            if (part.state !== "starting" || !part.registering) return { ok: false, reason: `${entry.def.name}: registrations are made while the part itself starts` }
            staged.push(registration)
            return { ok: true }
          }
        },
        // P3: an instance's presses; `info` values may have changed with one: announced when it ends.
        presses: kind === "instance" ? pressOwner(() => announce(entry), () => entry.def.id) : undefined
      }
      openParts.add(part)
      return part
    })

  /**
   * Close one part: its presses (P3: each interrupted and ended, its cleanup run), then its scope (its finalizers), at
   * most `stopTimeoutMs` in all; past that it is abandoned and reported. A press never outlives what it may use.
   */
  const closePart = (part: Part): Effect.Effect<void> =>
    Effect.gen(function*() {
      if (part.state === "closed" || part.state === "abandoned") return
      part.state = "withdrawn"
      const entry = part.entry
      const outcome = yield* bounded(Effect.andThen(part.presses?.stop ?? Effect.void, Scope.close(part.scope, Exit.void)), stopTimeoutMs, false)
      instanceByPart.delete(part.id)
      openParts.delete(part)
      if (outcome._tag === "hung") {
        part.state = "abandoned"
        entry.problems.push({
          title: `${entry.def.name} did not finish stopping`,
          detail: `Its ${part.kind === "shared" ? "shared part" : "instance"} was still closing after ${Math.round(stopTimeoutMs / 1000)} s and was left to finish on its own. Restart the assistant if it still holds something open.`
        })
        yield* Effect.logWarning(`Module ${entry.def.id}: closing its ${part.kind} part did not finish within ${stopTimeoutMs} ms; abandoned`)
        return
      }
      part.state = "closed"
      // Its code has ended: the secrets only it was given are no longer looked for (an abandoned part keeps them).
      boundary.release(part)
      if (Exit.isFailure(outcome.exit)) yield* Effect.logWarning(`Module ${entry.def.id}: closing its ${part.kind} part failed`, outcome.exit.cause)
    })

  /** Run a part's `shared` or `start`: in its scope, outside any turn, within the start limit. */
  const runCode = <A>(part: Part, label: string, start: () => Effect.Effect<A, ModuleStartError, Scope.Scope>) =>
    Effect.map(
      bounded(Effect.suspend(start).pipe(Scope.provide(part.scope)), startTimeoutMs, true),
      (outcome): { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string } => {
        // Its start has returned (or was abandoned): what it did not register by now it never will.
        part.registering = false
        if (outcome._tag === "hung") return { ok: false, message: closing ? "The assistant is stopping" : `${label} within ${Math.round(startTimeoutMs / 1000)} s` }
        return Exit.isSuccess(outcome.exit) ? { ok: true, value: outcome.exit.value } : { ok: false, message: describeStartFailure(part.entry.def.id, outcome.exit.cause) }
      }
    )

  /** Check what an instance returned and seal its tools and actions. */
  const instanceOf = (run: Run, instance: ModuleInstance): { readonly ok: true; readonly tools: ReadonlyArray<Tool>; readonly actions: ReadonlyArray<RegisteredAction> } | { readonly ok: false; readonly message: string } => {
    let contributed: ReturnType<typeof contributionsOf>
    try {
      contributed = contributionsOf(run, instance)
    } catch (error) {
      return { ok: false, message: `The module's actions could not be offered as tools: ${describe(error)}` }
    }
    const actionIds = contributed.actions.map((a) => a.id)
    const duplicateAction = actionIds.find((n, i) => actionIds.indexOf(n) !== i)
    if (duplicateAction !== undefined) return { ok: false, message: `The module declares the action "${duplicateAction}" twice` }
    const names = contributed.tools.map((t) => t.name)
    const duplicate = names.find((n, i) => names.indexOf(n) !== i)
    if (duplicate !== undefined) return { ok: false, message: `The module declares the tool "${duplicate}" twice` }
    const metadata = [...(instance.tools ?? []).map((t) => metadataProblem(`Tool "${t.name}"`, t)), ...contributed.actions.map((a) => metadataProblem(`Action "${a.definition.id}"`, a.definition))]
      .find((p) => p !== undefined)
    if (metadata !== undefined) return { ok: false, message: metadata }
    try {
      // Its own tools on their own: a schema the registry cannot describe fails this start, not a later snapshot.
      makeToolRegistry([{ name: run.entry.def.id, tools: contributed.tools }])
    } catch (error) {
      return { ok: false, message: `The module's tools could not be offered: ${describe(error)}` }
    }
    return { ok: true, ...contributed }
  }

  // -- Start and stop (the worker only) ---------------------------------------------------------------------------------

  /**
   * Start a module: its shared part, then its instances one after another; then its registrations are checked and
   * published in one synchronous step. If anything fails, what did start is closed (instances first) and the module
   * is down with the reason.
   */
  const startModule = (entry: Entry, target: HostTarget): Effect.Effect<void> =>
    Effect.gen(function*() {
      entry.phase = "starting"
      entry.starting = target
      announceAll()
      const run: Run = {
        id: ++nextId,
        entry,
        target,
        accepted: target.desired,
        state: "starting",
        shared: undefined,
        instances: new Map(),
        registrations: [],
        inflight: 0,
        idle: undefined,
        killed: Deferred.makeUnsafe<void>()
      }
      const opened: Array<Part> = []
      const valid = target.instances.filter((i) => i.invalid === undefined)
      const giveUp = (message: string) =>
        Effect.gen(function*() {
          run.state = "closed"
          for (const part of [...opened].reverse()) yield* closePart(part)
          entry.failure = { attempt: target.attempt, message, instances: valid }
        })
      if (entry.def.shared !== undefined) {
        const part = yield* newPart(entry, "shared")
        opened.push(part)
        // The boundary remembers what module code is given (a vault locked since cannot make it showable); `settingsFor`
        // resolves with the start's secrets too.
        given(entry, [part], target.shared!.settings)
        boundary.remember(entry.def.id, part, Object.values(target.secrets))
        const context = { settings: target.shared!.settings as never, settingsFor: settingsForOf(entry, part, run) as never, ...servicesFor(entry, part) }
        const started = yield* runCode(part, "Its shared part did not start", () => entry.def.shared!(context))
        if (!started.ok) return yield* giveUp(started.message)
        const keys = (started.value.services ?? []).map((p) => p.key.id)
        const twice = keys.find((id, i) => keys.indexOf(id) !== i)
        if (twice !== undefined) return yield* giveUp(`The module provides the service "${twice}" twice`)
        run.shared = { part, value: started.value }
      }
      for (const t of valid) {
        if (closing) return yield* giveUp("The assistant is stopping")
        const part = yield* newPart(entry, "instance")
        opened.push(part)
        let status: StatusLine | undefined
        // Bound to this part: a status from an older start never reaches what runs now.
        const setStatus = (next: StatusLine | undefined) => {
          const inst = instanceByPart.get(part.id)
          if (part.state === "starting") {
            status = next
            if (inst !== undefined) inst.status = next
          } else if (part.state === "live" && inst !== undefined) {
            inst.status = next
            scheduleStatus(entry)
          }
        }
        // Version 1 modules get exactly the context they always had; version 2 modules also get the host's services and
        // what their `shared` part returned.
        // P3: the form shows the published instance's `info()` and options again; a part not (or no longer) published
        // has nothing on the page to refresh.
        const refreshForm = () => {
          if (part.state === "live") scheduleStatus(entry)
        }
        const settings = given(entry, [part], t.resolved.value)
        const context = (entry.def.apiVersion ?? 1) >= 2
          ? { settings: settings as never, setStatus, refreshForm, shared: run.shared?.value.value, ...servicesFor(entry, part) }
          : { settings: settings as never, setStatus }
        const started = yield* runCode(part, "Did not start", () => entry.def.start(context))
        if (!started.ok) return yield* giveUp(started.message)
        const checked = instanceOf(run, started.value)
        if (!checked.ok) return yield* giveUp(checked.message)
        // Core always words a confirmation question itself (after the final review): a module's own text is ignored.
        for (const a of checked.actions) {
          if (typeof a.definition.confirm === "function") {
            yield* Effect.logWarning(
              `Module ${entry.def.id}, action "${a.definition.id}": its own confirmation text is ignored; the assistant asks its own question from the action's label and values`
            )
          }
        }
        const inst: InstanceRun = { part, key: t.key, users: t.users, ownKeys: t.ownKeys, instance: started.value, tools: checked.tools, actions: checked.actions, status }
        instanceByPart.set(part.id, inst)
        run.instances.set(t.key, inst)
      }
      // What the registrars find in the started parts, then what the parts registered while they started.
      let regs: Array<Registration>
      try {
        regs = opened.flatMap((part) => [
          ...registrars.flatMap((r) => [...r({ handle: part.handle, ...(part.kind === "shared" ? { shared: run.shared!.value } : { instance: instanceByPart.get(part.id)!.instance }) })]),
          ...part.staged
        ])
      } catch (error) {
        return yield* giveUp(`Its registrations could not be read: ${describe(error)}`)
      }
      // Nothing is published once the host has begun to close (it withdrew everything in one step).
      if (closing) return yield* giveUp("The assistant is stopping")
      const refused = refusalOf(entry, regs)
      if (refused !== undefined) return yield* giveUp(refused)
      // Published in one synchronous step: no other fiber sees part of it.
      const problem = publishAll(entry, regs)
      if (problem !== undefined) return yield* giveUp(problem)
      run.registrations = regs
      run.state = "live"
      for (const part of opened) part.state = "live"
      entry.run = run
      entry.failure = undefined
      entry.phase = "idle"
      entry.starting = undefined
      rebuildSnapshot()
      announceAll()
    }).pipe(Effect.ensuring(Effect.sync(() => {
      entry.phase = "idle"
      entry.starting = undefined
    })))

  /**
   * Stop a module: withdraw everything it published (one synchronous step), give its calls in flight the grace period
   * (none while the host closes), interrupt what remains, then close its instances and then its shared part.
   */
  const stopModule = (entry: Entry, grace: number): Effect.Effect<void> =>
    Effect.gen(function*() {
      const run = entry.run
      if (run === undefined) return
      entry.phase = "stopping"
      withdrawRun(entry, run)
      rebuildSnapshot()
      announceAll()
      yield* closeRun(run, grace)
    }).pipe(Effect.ensuring(Effect.sync(() => {
      entry.phase = "idle"
    })))

  /** Take a published run out (synchronous): its calls are refused from now on, its registrations are withdrawn. */
  const withdrawRun = (entry: Entry, run: Run) => {
    run.state = "withdrawn"
    if (entry.run === run) entry.run = undefined
    for (const inst of run.instances.values()) inst.part.state = "withdrawn"
    if (run.shared !== undefined) run.shared.part.state = "withdrawn"
    withdrawAll(entry, run.registrations)
  }

  /** Close a withdrawn run: the grace period for its calls in flight (none while the host closes), then its parts. */
  const closeRun = (run: Run, grace: number): Effect.Effect<void> =>
    Effect.gen(function*() {
      // P3: field-action presses of its instances get the same grace period as its calls (no new one reaches a
      // withdrawn module); `closePart` interrupts what remains.
      const presses = [...run.instances.values()].flatMap((inst) => (inst.part.presses === undefined ? [] : [inst.part.presses]))
      const pressing = presses.some((owner) => owner.inFlight().length > 0)
      if ((run.inflight > 0 || pressing) && grace > 0 && !closing) {
        const idle = Deferred.makeUnsafe<void>()
        run.idle = idle
        const calls = run.inflight > 0 ? Deferred.await(idle) : Effect.void
        const ended = Effect.forEach(presses, (owner) => owner.settled, { concurrency: "unbounded", discard: true })
        yield* Effect.raceFirst(Effect.all([calls, ended], { concurrency: "unbounded", discard: true }), Deferred.await(closingSignal)).pipe(Effect.timeoutOption(grace))
      }
      // The grace period is over: every press of every instance is answered `stopped` and asked to stop in this one
      // step, before any part's cleanup is awaited (no press's answer waits for another instance's finalizers).
      for (const owner of presses) owner.signal()
      Deferred.doneUnsafe(run.killed, Effect.void)
      for (const inst of run.instances.values()) yield* closePart(inst.part)
      if (run.shared !== undefined) yield* closePart(run.shared.part)
      run.state = "closed"
    })

  /** Runs the host withdrew when it began to close (`revokeAll`), consumers first: the shutdown walk closes them. */
  const revoked: Array<Run> = []

  /**
   * The host begins to close: every published run is withdrawn in one synchronous step, before any part is closed, so
   * nothing of any module stays callable or published however long (or not at all) the closing then takes. Its calls
   * in flight are interrupted at once.
   */
  const revokeAll = () => {
    for (const entry of [...ordered].reverse()) {
      const run = entry.run
      if (run === undefined) continue
      withdrawRun(entry, run)
      Deferred.doneUnsafe(run.killed, Effect.void)
      for (const inst of run.instances.values()) inst.part.presses?.signal()
      revoked.push(run)
    }
    rebuildSnapshot()
  }

  /** One module's step in a pass: whatever goes wrong in the host's own handling marks it down and the walk goes on. */
  const contained = (entry: Entry, attempt: string, step: Effect.Effect<void>): Effect.Effect<void> =>
    step.pipe(Effect.catchCause((cause) =>
      Effect.gen(function*() {
        yield* Effect.logError(`Module ${entry.def.id}: the module host could not handle it`, cause)
        entry.failure = { attempt, message: `The module host could not handle it: ${firstLine(entry.def.id, cause)}`, instances: [] }
      })
    ))

  // -- The worker -----------------------------------------------------------------------------------------------------

  // With `demand` (serve mode), nothing runs before `startEnabled` opens the host (the app calls it once everything
  // the modules depend on is built and who wants what can be read): writes are kept and applied by its first pass.
  let isOpen = options.demand === undefined
  let desiredVersion = 0
  let startedVersion = 0
  let completedVersion = 0
  let stopped = false
  let wake = Deferred.makeUnsafe<void>()
  let passDone = Deferred.makeUnsafe<void>()

  /** One pass: capture the desired state once, plan every module, stop (consumers first), then start (providers first). */
  const runPass = Effect.gen(function*() {
    const picture = new Map(entries.map((e) => [e, e.want] as const))
    const demanded = demandedIn((e) => picture.get(e)!)
    const items = ordered.map((entry) => {
      const d = picture.get(entry)!
      try {
        const target = targetOf(entry, d, demanded)
        return { entry, target, plan: planModule(target, { running: entry.run?.target.fingerprint, failed: entry.failure?.attempt }), unplanned: undefined }
      } catch (error) {
        // It could not be planned (something of the module's threw): stopped and down with that error, never taken
        // as converged; the next pass plans it again.
        const message = `${entry.def.name} could not be planned: ${clip(describe(error).replace(/\s+/g, " "), 200)}`
        const target: HostTarget = { id: entry.def.id, runs: false, invalid: message, instances: [], fingerprint: "", attempt: `unplanned:${desiredVersion}`, shared: undefined, fieldErrors: undefined, secrets: {}, desired: d }
        return { entry, target, plan: { id: entry.def.id, stop: entry.run !== undefined, start: false, keep: false, forget: false }, unplanned: message }
      }
    })
    for (const { entry, plan, target } of [...items].reverse()) {
      if (plan.stop) yield* contained(entry, target.attempt, stopModule(entry, graceMs))
    }
    for (const { entry, plan, target, unplanned } of items) {
      if (closing) break
      entry.shown = target.desired
      entry.invalid = target.instances.filter((i) => i.invalid !== undefined)
      if (unplanned !== undefined) entry.failure = { attempt: target.attempt, message: unplanned, instances: [] }
      else if (plan.forget) entry.failure = undefined
      else if (target.invalid !== undefined) {
        entry.failure = { attempt: target.attempt, message: target.invalid, ...(target.fieldErrors !== undefined ? { fieldErrors: target.fieldErrors } : {}), instances: [] }
      } else if (!plan.start && entry.run === undefined && entry.failure !== undefined && entry.failure.attempt === target.attempt) {
        // Down for the same attempt: its error is shown for the assistants that want it now.
        entry.failure = { ...entry.failure, instances: target.instances.filter((i) => i.invalid === undefined) }
      }
      if (plan.keep && entry.run !== undefined) {
        entry.run.accepted = target.desired
        for (const t of target.instances) {
          const inst = entry.run.instances.get(t.key)
          if (inst === undefined) continue
          inst.users = t.users
          inst.ownKeys = t.ownKeys
        }
      }
      if (plan.start) yield* contained(entry, target.attempt, startModule(entry, target))
    }
    rebuildSnapshot()
    announceAll()
  })

  /** Closing the host: close what `revokeAll` withdrew (and anything published since), consumers first, without grace. */
  const shutdownWalk = Effect.gen(function*() {
    for (const run of revoked.splice(0)) yield* contained(run.entry, "", closeRun(run, 0))
    for (const entry of [...ordered].reverse()) {
      if (entry.run !== undefined) yield* contained(entry, "", stopModule(entry, 0))
    }
    rebuildSnapshot()
  })

  const release = (version: number) => {
    completedVersion = Math.max(completedVersion, version)
    const done = passDone
    passDone = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(done, Effect.void)
  }

  const loop = Effect.gen(function*() {
    for (;;) {
      if (closing) {
        yield* shutdownWalk
        return
      }
      if (!isOpen || desiredVersion <= startedVersion) {
        const signal = wake
        yield* Deferred.await(signal)
        if (signal === wake) wake = Deferred.makeUnsafe<void>()
        continue
      }
      const version = desiredVersion
      startedVersion = version
      // A pass never ends the worker: each module's step is contained, and so is anything else that goes wrong.
      yield* runPass.pipe(Effect.catchCause((cause) => Effect.logError("A module pass failed", cause)))
      release(version)
    }
  })

  const worker = yield* Effect.forkIn(outsideTurns(loop), hostScope)

  // -- Saving ---------------------------------------------------------------------------------------------------------

  /**
   * Modules whose desired state changed since their last save, with the switch to save (decided when the save was
   * asked for, never from what happens to run when the saver gets to it); one saver saves them one at a time, the
   * latest state.
   */
  const saveQueue = new Map<Entry, boolean>()
  let saveWake = Deferred.makeUnsafe<void>()
  let saveDone = Deferred.makeUnsafe<void>()
  let saving = false
  /** Ask for a save of `entry` (synchronously, inside the write): returns the number its caller waits for. */
  const requestSave = (entry: Entry): number => {
    entry.saveRequested++
    // An owner who never chose: what its default makes it (on while its key is set, or while it runs by it).
    saveQueue.set(entry, entry.want.chosen ? entry.want.enabled : switchOn(entry, entry.want))
    Deferred.doneUnsafe(saveWake, Effect.void)
    return entry.saveRequested
  }
  const saver = Effect.gen(function*() {
    for (;;) {
      if (saveQueue.size === 0) {
        const signal = saveWake
        yield* Deferred.await(signal)
        if (signal === saveWake) saveWake = Deferred.makeUnsafe<void>()
        continue
      }
      const [entry, enabled] = [...saveQueue][0]!
      saveQueue.delete(entry)
      const seq = entry.saveRequested
      const d = entry.want
      saving = true
      yield* Effect.suspend(() =>
        options.persistence.save(entry.def.id, {
          enabled,
          settings: d.stored as Record<string, SettingValue>,
          secrets: d.secrets
        })
      ).pipe(Effect.catchCause((cause) => Effect.logError(`Could not save the settings of module ${entry.def.id}`, cause)))
      saving = false
      entry.saveDone = Math.max(entry.saveDone, seq)
      const done = saveDone
      saveDone = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(done, Effect.void)
    }
  })
  const saverFiber = yield* Effect.forkIn(outsideTurns(saver), hostScope)

  /** Wait until the save numbered `seq` of `entry` (or a later one) has been made. */
  const savedAt = (entry: Entry, seq: number): Effect.Effect<void> =>
    Effect.suspend(() => (entry.saveDone >= seq || stopped ? Effect.void : Effect.andThen(Deferred.await(saveDone), savedAt(entry, seq))))

  // Closing the host: the worker stops every module (consumers first), then pending saves finish; bounded by
  // `closeTimeoutMs` in all. Registered after the forks, so it runs before they are interrupted.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      // P3: the host's own presses stop first (refused from now on; each in flight has ended), before anything closes.
      pressesClosed = true
      yield* Effect.timeoutOption(hostPresses.stop, closeTimeoutMs)
      closing = true
      revokeAll()
      Deferred.doneUnsafe(closingSignal, Effect.void)
      Deferred.doneUnsafe(wake, Effect.void)
      const deadline = (yield* Clock.currentTimeMillis) + closeTimeoutMs
      const finished = yield* Effect.timeoutOption(Fiber.await(worker), closeTimeoutMs)
      if (Option.isNone(finished)) {
        worker.interruptUnsafe()
        const left = entries.filter((e) => e.run !== undefined || e.phase !== "idle").map((e) => e.def.id)
        yield* Effect.logWarning(`The module host did not stop within ${Math.round(closeTimeoutMs / 1000)} s; left to finish on their own: ${left.join(", ") || "(none)"}`)
      }
      const idle: Effect.Effect<void> = Effect.suspend(() => (saveQueue.size === 0 && !saving ? Effect.void : Effect.andThen(Deferred.await(saveDone), idle)))
      const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
      if (Option.isNone(yield* Effect.timeoutOption(idle, left))) yield* Effect.logWarning("The module host did not finish saving in time")
      saverFiber.interruptUnsafe()
      stopped = true
      release(desiredVersion)
    })
  )

  // -- Triggers: each writes the desired state, then waits for a pass that began after the write ----------------------

  /** Read who wants what (`demand`) into the desired state. */
  const readDemand = () => {
    if (options.demand === undefined) return
    const demand = options.demand()
    for (const entry of entries) {
      const next = demand.get(entry.def.id)
      if (JSON.stringify(next ?? null) !== JSON.stringify(entry.want.demand ?? null)) entry.want = { ...entry.want, demand: next }
    }
  }
  const readDefaults = () => {
    for (const entry of entries) {
      const next = options.defaults?.(entry.def.id)
      if (JSON.stringify(next ?? null) !== JSON.stringify(entry.want.defaults ?? null)) entry.want = { ...entry.want, defaults: next }
    }
  }

  /**
   * Change the desired state (synchronously, with the linked defaults read again) and wake the worker; returns the
   * version a pass must have begun at to satisfy the writer.
   */
  const write = (mutate: () => void): number => {
    readDefaults()
    mutate()
    desiredVersion++
    Deferred.doneUnsafe(wake, Effect.void)
    return desiredVersion
  }

  /**
   * Wait until a pass that began at `version` or later has finished (or the host is not open yet, or has closed). An
   * interrupted caller just stops waiting: nothing is kept for it.
   */
  const settled = (version: number): Effect.Effect<void> =>
    Effect.suspend(() => (!isOpen || stopped || completedVersion >= version ? Effect.void : Effect.andThen(Deferred.await(passDone), settled(version))))

  /** How a module stands, as a trigger's result: its start error (or `invalid_settings`), else ok. */
  const resultOf = (entry: Entry): HostResult => {
    if (!demandedIn((e) => e.want).has(entry)) return OK
    const f = entry.failure
    if (f !== undefined) {
      if (f.fieldErrors !== undefined) return failure("invalid_settings", f.message, { moduleId: entry.def.id, fieldErrors: f.fieldErrors })
      return failure("module_start_failed", f.message, { moduleId: entry.def.id })
    }
    const bad = entry.invalid[0]
    if (bad !== undefined) return failure("invalid_settings", bad.invalid!, { moduleId: entry.def.id, fieldErrors: bad.resolved.form.errors })
    return OK
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
      if (entry.want.demand !== undefined) return Effect.succeed(notAllowed(entry))
      let seq = 0
      const version = write(() => {
        entry.want = { ...entry.want, enabled: on, chosen: true, retry: entry.want.retry + 1 }
        seq = requestSave(entry)
      })
      return Effect.gen(function*() {
        yield* settled(version)
        yield* savedAt(entry, seq)
        return on ? pageResult(entry, resultOf(entry)) : OK
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
      readDefaults()
      const base = entry.want
      const patched = moduleCode(
        entry,
        () =>
          applySettingsPatch(
            entry.def.settings,
            { stored: base.stored, secrets: base.secrets, env: options.env, ...envOrigin, ...(base.defaults !== undefined ? { defaults: base.defaults } : {}) },
            patch,
            configureOptions
          ),
        (message): ReturnType<typeof applySettingsPatch> => ({ ok: false, errors: [{ key: null, message }] })
      )
      if (!patched.ok) return Effect.succeed(failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: patched.errors }))
      // While it runs, settings it could not start with are refused at once (what runs keeps running).
      if (entry.run !== undefined) {
        const src = { stored: patched.stored, secrets: patched.secrets }
        const errors = entry.def.shared !== undefined
          ? sharedOf(entry, src, base.defaults).errors
          : base.demand === undefined
          ? resolveFrom(entry, src, undefined, base.defaults).form.errors
          : []
        if (errors.length > 0) return Effect.succeed(failure("invalid_settings", "Some settings are not valid", { moduleId: id, fieldErrors: errors }))
      }
      let seq = 0
      const version = write(() => {
        entry.want = {
          ...entry.want,
          stored: patched.stored,
          secrets: patched.secrets,
          // Only a real change of a secret starts it again (the same token saved again changes nothing).
          secretEpoch: entry.want.secretEpoch + (sameRecord(patched.secrets, base.secrets) ? 0 : 1),
          retry: entry.want.retry + 1
        }
        seq = requestSave(entry)
      })
      return Effect.gen(function*() {
        yield* settled(version)
        yield* savedAt(entry, seq)
        return resultOf(entry)
      })
    })

  const setSecrets = (all: Readonly<Record<string, Readonly<Record<string, string>>>>): Effect.Effect<void> =>
    Effect.suspend(() =>
      settled(write(() => {
        for (const entry of entries) {
          const next = all[entry.def.id] ?? {}
          if (!sameRecord(next, entry.want.secrets)) entry.want = { ...entry.want, secrets: next, vaultEpoch: entry.want.vaultEpoch + 1 }
        }
      }))
    )

  // Evaluated when run: a module switched on by `setSecrets` before this runs is included (and started once).
  const startEnabled = Effect.suspend(() => {
    isOpen = true
    return settled(write(() => {
      readDemand()
      for (const entry of entries) entry.want = { ...entry.want, retry: entry.want.retry + 1 }
    }))
  })

  const refresh = Effect.suspend(() => settled(write(readDemand)))

  const evaluate = Effect.sync(() => {
    readDemand()
    readDefaults()
    refreshIssues()
  })

  const recheck = Effect.suspend(() =>
    settled(write(() => {
      judgeAll()
      // Check again starts a fresh attempt for every module that is not live (down after a failed start, or with a
      // start under way whose failure is not recorded yet), whatever the probes say now, and clears what was reported
      // of code that hung (it is reported again if it hangs again).
      for (const entry of entries) {
        if (entry.run === undefined) entry.want = { ...entry.want, retry: entry.want.retry + 1 }
        entry.problems = []
      }
    }))
  )

  /** After `reportMissingProgram`: judge again (the app marked the program missing), without retrying anything. */
  const rejudge = Effect.suspend(() => settled(write(judgeAll)))

  const checkOwn = (id: string, own: Readonly<Record<string, unknown>>): ReadonlyArray<FieldError> => {
    const entry = byId.get(id)
    if (entry === undefined) return [{ key: null, message: `There is no module "${id}"` }]
    // A field's own check is module code: one that throws is that module's error; its messages pass the boundary.
    return moduleCode(entry, () => checkOwnValues(entry.def.settings, own), (message) => [{ key: null, message }])
      .map((e) => ({ ...e, message: boundary.text(id, e.message, 2000) }))
  }

  // -- Restarts -------------------------------------------------------------------------------------------------------

  /** A module's recorded restart requests become desired state (the worker restarts it in a later pass). */
  const applyRestart = (entry: Entry, at: number) => {
    entry.lastRestartAt = at
    write(() => {
      entry.want = { ...entry.want, restarts: entry.restartRequests }
    })
  }

  /** Wakes the restart timer: a module's request was held back by the interval. */
  let restartWake = Deferred.makeUnsafe<void>()

  /**
   * A restart of the module, recorded in one synchronous step (an interrupted caller either made it whole or not at
   * all): counted, then either written to the desired state at once or, within `RESTART_INTERVAL_MS` of the last one
   * taken up, held for the restart timer, which takes up every held request when the interval is over (all of a
   * module's requests in between merged into one). A request made after the last one was taken up always leads to
   * another restart. The interval only keeps a module from restarting itself in a tight loop: it is not a minimum
   * distance between two restarts (a pass that is busy elsewhere can bring two closer together).
   */
  const requestRestart = (entry: Entry, reason: string): Effect.Effect<void> =>
    Clock.clockWith((clock) =>
      Effect.sync(() => {
        entry.restartRequests++
        if (entry.restartTimer) return
        const now = clock.currentTimeMillisUnsafe()
        if (now - entry.lastRestartAt >= RESTART_INTERVAL_MS) return applyRestart(entry, now)
        entry.restartTimer = true
        Deferred.doneUnsafe(restartWake, Effect.void)
      })
    ).pipe(Effect.andThen(Effect.logInfo(`Module ${entry.def.id} is to be started again: ${reason}`)))

  /** The restart timer: one fiber of the host's, which takes up the held requests once their interval is over. */
  const restartTimer = Effect.gen(function*() {
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      let next = Infinity
      for (const entry of entries) {
        if (!entry.restartTimer) continue
        const due = entry.lastRestartAt + RESTART_INTERVAL_MS
        if (due <= now) {
          entry.restartTimer = false
          applyRestart(entry, now)
        } else next = Math.min(next, due - now)
      }
      const signal = restartWake
      yield* next === Infinity ? Deferred.await(signal) : Effect.raceFirst(Deferred.await(signal), Effect.sleep(next))
      if (signal === restartWake && Deferred.isDoneUnsafe(signal)) restartWake = Deferred.makeUnsafe<void>()
    }
  })
  yield* Effect.forkIn(outsideTurns(restartTimer), hostScope)

  /** `reportMissingProgram`: a required program failed to start; the app marks it missing, then every module is judged again. */
  const reportMissingProgram = (entry: Entry, tool: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const required = (entry.def.requires ?? []).some((r) => "tool" in r && r.tool === tool)
      if (!required || options.programMissing === undefined) return Effect.void
      options.programMissing(tool)
      return Effect.asVoid(Effect.forkIn(outsideTurns(Effect.andThen(Effect.logWarning(`Module ${entry.def.id}: ${tool} could not be run; judging the modules again`), rejudge)), hostScope))
    })

  // -- Health ---------------------------------------------------------------------------------------------------------

  const checkHealth = outsideTurns(Effect.forEach(
    entries,
    (entry) =>
      Effect.suspend(() => {
        const health = entry.def.health
        const source = `health:${entry.def.id}`
        if (health === undefined) return Effect.void
        if (entry.want.unavailable !== undefined || entry.catalogError !== undefined) {
          issues.set(source, [])
          return Effect.void
        }
        // The check holds what it is given until its issues are published.
        const holder = {}
        const settings = given(entry, [holder], resolve(entry).value)
        const own = (title: string, detail: string): ReadonlyArray<Issue> => [{ id: `${entry.def.id}.health`, module: entry.def.id, severity: "warning", title, detail }]
        // In a fiber of its own, awaited as its Exit: one that throws, fails or interrupts itself is that module's
        // issue, never the whole check's; one that does not finish in time is left (interrupted, not waited for).
        return Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(Effect.suspend(() => health({ settings, running: entry.run !== undefined })))
          const exit = yield* Effect.timeoutOption(Fiber.await(fiber), healthTimeoutMs)
          if (Option.isNone(exit)) {
            fiber.interruptUnsafe()
            return own(`${entry.def.name}'s health check did not finish`, `It took longer than ${Math.round(healthTimeoutMs / 1000)} s.`)
          }
          if (Exit.isFailure(exit.value)) {
            const cause = exit.value.cause
            return own(`${entry.def.name}'s health check failed`, Cause.hasInterruptsOnly(cause) ? "It was interrupted." : firstLine(entry.def.id, cause))
          }
          return exit.value.value
        }).pipe(
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
  const instanceUsedBy = (entry: Entry, assistantId: string | undefined): InstanceRun | undefined => {
    if (entry.shown.unavailable !== undefined) return undefined
    return assistantId !== undefined && entry.shown.demand !== undefined ? instanceFor(entry, assistantId) : mainOf(entry)
  }

  /**
   * The assistant may use this module (the gateway's own first check, so the catalogue lists what would run). Without
   * `access`: the assistant wants it directly (`demand`; a module without demand is everyone's).
   */
  const moduleOnFor = (assistantId: string | undefined, entry: Entry) =>
    assistantId === undefined ||
    (options.access === undefined
      ? entry.shown.demand === undefined || entry.shown.demand.some((d) => d.assistantId === assistantId)
      : options.access.moduleOn(assistantId, entry.def.id))

  /** The assistant may use this action (the gateway's first two checks). */
  const offered = (assistantId: string | undefined, entry: Entry, actionId: string) =>
    moduleOnFor(assistantId, entry) &&
    (assistantId === undefined || options.access === undefined || !options.access.toolOff(assistantId, entry.def.id, actionToolName(entry.def.id, actionId)))

  /** An unavailable module the caller has on (an assistant's choice, or its saved switch without demand). */
  const unavailableFor = (entry: Entry, assistantId: string | undefined) => {
    const d = entry.shown
    return d.unavailable !== undefined &&
      (d.demand === undefined ? switchOn(entry, d) : assistantId === undefined ? d.demand.length > 0 : d.demand.some((x) => x.assistantId === assistantId))
  }

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
        const standIns = unavailablePartOf(entry, entry.shown.unavailable!).module.intentActions ?? []
        return standIns.filter((a) => offered(assistantId, entry, a.definition.id)).map((action) => ({ entry, action }))
      }
      const running = instanceUsedBy(entry, assistantId)
      if (running === undefined) return []
      return running.actions.filter((a) => offered(assistantId, entry, a.definition.id)).map((action) => ({ entry, action }))
    })

  const actions: ActionCatalogue = {
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
          return refuse("unavailable", unavailableLine(entry.def.name, entry.shown.unavailable!.reason))
        }
        const running = instanceUsedBy(entry, assistantId)
        if (running === undefined) {
          return assistantId !== undefined && mainOf(entry) !== undefined
            ? refuse("refused", `Not run: the ${entry.def.id} module is not on for this assistant.`)
            : refuse("not_running", `${entry.def.name} is not running`)
        }
        const action = running.actions.find((a) => a.definition.id === request.actionId)
        if (action === undefined) return refuse("unknown_action", `${entry.def.name} has no action "${request.actionId}"`)
        const def = action.definition
        let values: Record<string, unknown>
        try {
          // Resolved once: the gateway admits these values and the action runs with exactly them.
          values = checkedActionValues(action, request.params)
        } catch (error) {
          return refuse("invalid_params", describe(error))
        }
        // Through the gateway, which refuses an action that needs confirmation (confirmation is off on this path).
        return yield* gateway.action(action, values, { principal }).pipe(
          Effect.timeoutOrElse({
            duration: ACTION_TIMEOUT_MS,
            orElse: () => Effect.fail(new ActionError({ message: `${def.label} did not finish within ${ACTION_TIMEOUT_MS / 1000} s` }))
          }),
          Effect.map((outcome): ActionRunResult => {
            const say = (outcome as ActionOutcome | undefined)?.say
            return say !== undefined ? { ok: true, say } : { ok: true }
          }),
          Effect.catch((error) =>
            Effect.succeed(
              def.confirm !== undefined && def.confirm !== false && isGatewayRefusal(error)
                ? refuse("needs_confirmation", `${def.label} needs the owner's spoken confirmation, which only a conversation can ask for`)
                : refuse(isGatewayRefusal(error) ? "refused" : "failed", error.message)
            )
          ),
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
      ...(e.shown.unavailable !== undefined ? { unavailable: e.shown.unavailable.reason } : {})
    })),
    vaultLocked: options.view?.vaultLocked?.(),
    engine: options.view?.engine?.(),
    devices: options.view?.devices?.() ?? [],
    home: options.view?.home?.() ?? {}
  })

  /** The published service under `key` (a module starting sees the providers published before it, in `uses` order). */
  const service = <T>(key: ServiceKey<T>): T | undefined => liveServices.get(key.id)?.service as T | undefined

  const contributionsFor = <T>(key: ContributionKey<T>, assistantId: string | undefined): ReadonlyArray<T> =>
    entries.flatMap((entry) =>
      assistantId !== undefined && !moduleOnFor(assistantId, entry)
        ? []
        : (liveContributions.get(entry) ?? []).filter((c) => c.key.id === key.id).map((c) => c.value as T)
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
   * `ctx.settingsFor` of a shared part: from the desired state its run runs for now (`Run.accepted`: who has it on,
   * the saved values and defaults), with the secrets it was started with.
   */
  const settingsForOf = (entry: Entry, part: Part, run: Run) => (assistantId: string | undefined): unknown => {
    if (closing || part.state === "closed" || part.state === "abandoned") throw stoppedError(entry)
    const d = run.accepted
    const own = assistantId === undefined ? undefined : d.demand?.find((x) => x.assistantId === assistantId)?.own
    return resolveFrom(entry, { stored: d.stored, secrets: run.target.secrets }, own === undefined ? undefined : applicableOwnValues(entry.def.settings, own), d.defaults).value
  }

  const stoppedError = (entry: Entry) => new ModuleStopped({ message: `${entry.def.name} has stopped; this host object no longer answers.` })

  /**
   * The context members of a version 2 module, in `shared` and in `start`, bound to the part they are made for. A
   * later PR adds its member here, one line, and its field in `ModuleServicesV2`; a member that registers something
   * passes `part` on and registers through it during the start (`PartHandle.register`). Once the part's scope has
   * closed, every member answers with `ModuleStopped`.
   */
  function servicesFor(entry: Entry, part: Part): ModuleServicesV2 {
    // Once the host has begun to close, every module's context answers with ModuleStopped (`revokeAll`).
    const isStopped = () => closing || part.state === "closed" || part.state === "abandoned"
    const now = <A>(f: () => A): A => {
      if (isStopped()) throw stoppedError(entry)
      return f()
    }
    const effect = <A, E = never>(f: () => Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.suspend(() => (isStopped() ? Effect.die(stoppedError(entry)) : f()))
    const tokens = routeTokensFor(entry.def.id, part)
    let refusedRestart = false
    return {
      host: {
        routeTokens: {
          list: effect(() => tokens.list),
          revoke: (id) => effect(() => tokens.revoke(id)),
          mint: (name, label) => effect(() => tokens.mint(name, label))
        },
        view: () => now(view),
        service: (key) => now(() => service(key)),
        contributions: (key) => effect(() => contributions(key)),
        contributionsFor: (key, assistantId) => now(() => contributionsFor(key, assistantId)),
        actions: { list: effect(() => actions.list), run: (request) => effect(() => actions.run(request)) },
        requestRestart: (reason) =>
          effect(() => {
            // Only a live part asks: one that is starting, was never published or is being closed (a "restart on
            // disconnect" finalizer) is refused, so a failed start cannot restart itself.
            if (part.state !== "live") {
              if (refusedRestart) return Effect.void
              refusedRestart = true
              return Effect.logDebug(`Module ${entry.def.id}: a restart asked for by its ${part.kind} part while it is ${part.state} is ignored: ${reason}`)
            }
            return requestRestart(entry, reason)
          }),
        reportMissingProgram: (tool) => effect(() => reportMissingProgram(entry, tool))
      } satisfies ModuleHostApi
    }
  }

  // -- Field actions and setting options ------------------------------------------------------------------------------

  const fieldAction = (id: string, key: string, values?: Readonly<Record<string, unknown>>): Effect.Effect<FieldActionHostResult> =>
    Effect.suspend((): Effect.Effect<FieldActionHostResult> => {
      const entry = byId.get(id)
      if (entry === undefined) return Effect.succeed({ ok: false, code: "unknown_module", message: `There is no module "${id}"` } as const)
      if (pressesClosed) return Effect.succeed({ ok: false, code: "not_running", message: "The assistant is stopping" } as const)
      const declared = Object.hasOwn(entry.def.settings, key) ? entry.def.settings[key]! : undefined
      // Only a button of the form runs: a declared action field, or the generated Test of an agent or decision
      // provider. A handler without a field is not a button (whatever `fieldActions` holds).
      const generated = key === "test" && generatesTest(entry)
      if (declared === undefined ? !generated : declared.value !== "none") {
        return Effect.succeed({ ok: false, code: "unknown_action", message: declared === undefined ? `${entry.def.name} has no action "${key}"` : `${entry.def.name}: "${key}" is not a button` } as const)
      }
      // The published main instance (what the form shows): its part owns its presses.
      const running = mainOf(entry)
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
      const owner = definition !== undefined ? hostPresses : running?.part.state === "live" ? running.part.presses : undefined
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
      // The secrets the press is given are kept by the boundary until the press's fiber has ended (its observer, so
      // also when it is interrupted before it began) AND it has been answered (the first of the two releases
      // nothing); an instance's press gives them to its instance, which keeps them as long as it lives.
      const holder = {}
      let holds = 1
      const releaseHold = () => {
        if (--holds === 0) boundary.release(holder)
      }
      const releaseOne = Effect.sync(releaseHold)
      const holders = definition !== undefined || running === undefined ? [holder] : [holder, running.part]
      // Suspended: a handler that throws is reported like one that fails. Outside any turn.
      const press = outsideTurns(Effect.suspend(() => handler({ settings: given(entry, holders, prepared.settings), draft: useDraft })))
      const started = (fiber: Fiber.Fiber<FieldActionResult, unknown>) => {
        holds++
        fiber.addObserver(releaseHold)
      }
      return Effect.gen(function*() {
        const outcome = yield* owner.start(ownerKey, press, fieldActionTimeoutMs, started)
        switch (outcome._tag) {
          case "busy":
            return { ok: false, code: "busy", message: "That button is still running" } as const
          case "full":
            return { ok: false, code: "busy", message: `${entry.def.name} has ${MAX_PRESS_SLOTS} button presses running already; try again when one has ended (Health has more)` } as const
          case "stopped":
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
    // The saved state (the desired state: a configure's settings are saved even when the module could not start).
    const base = entry.want
    const patched = applySettingsPatch(
      spec,
      { stored: base.stored, secrets: base.secrets, env: options.env, ...envOrigin, ...(base.defaults !== undefined ? { defaults: base.defaults } : {}) },
      { values: patchValues, secrets: {} }
    )
    if (!patched.ok) return { ok: false, message: `Not run: ${problemsText(entry, patched.errors)}` }
    // Secrets are always the saved ones (a draft cannot name one: it is skipped above).
    const resolved = resolveFrom(entry, { stored: patched.stored, secrets: base.secrets }, undefined, base.defaults)
    if (resolved.value === undefined) return { ok: false, message: `Not run: ${problemsText(entry, resolved.form.errors)}` }
    return { ok: true, settings: resolved.value as Readonly<Record<string, unknown>> }
  }

  const settingOptions = (id: string): Readonly<Record<string, ReadonlyArray<ChoiceOption>>> | undefined => {
    const entry = byId.get(id)
    const instance = entry === undefined ? undefined : mainOf(entry)?.instance
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

  /** P3: the live routes, from the route table publication fills. */
  const routes = (): ReadonlyArray<PublishedRoute> =>
    [...routeTable].flatMap(([moduleId, live]) => live.routes.map((route) => ({ moduleId, route, scope: live.scope, stopped: live.stopped })))

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
 * Module issues made safe for the wire and a terminal (`wireSafeIssue`), with the module's id as prefix and `module`;
 * at most 20 per module, the rest said in one more ("and 12 more"). P3: every text in them passes the page boundary
 * first (`page`), before anything is clipped, so a start error or a `health()` result never carries a secret the
 * module was given; host-made issues (`hostMade`: the module's words in them redacted already) are only made safe.
 */
function normaliseIssues(
  id: string,
  name: string,
  list: ReadonlyArray<Issue>,
  page: (value: unknown, max: number) => string,
  hostMade = false
): ReadonlyArray<Issue> {
  // Redacted in full; `wireSafeIssue` clips afterwards.
  const own = (value: unknown) => (hostMade || value === undefined ? value : page(value, Number.MAX_SAFE_INTEGER))
  const redacted = list.map((issue, i): Issue => {
    const rawId = String(issue.id ?? "")
    const fullId = rawId.startsWith(`${id}.`) ? rawId : `${id}.${rawId}`
    const fix = issue.fix
    return {
      ...issue,
      // A module's id is a key, not text: one that holds a secret is replaced whole rather than redacted.
      id: hostMade || page(fullId, Number.MAX_SAFE_INTEGER) === fullId ? fullId : `${id}.issue-${i}`,
      module: id,
      ...(issue.device !== undefined ? { device: own(issue.device) as string } : {}),
      title: own(issue.title) as string,
      detail: own(issue.detail) as string,
      ...(typeof fix === "object" && fix !== null
        ? { fix: { ...fix, label: own(fix.label) as string, ...(fix.value !== undefined ? { value: own(fix.value) as string } : {}) } }
        : {})
    }
  })
  return boundIssues(redacted, 20, (more) => ({ id: `${id}.more`, module: id, severity: "warning", title: `${name} reported ${more} more issues`, detail: "Only the first ones are shown." }))
    .map((issue, i) => {
      const safe = wireSafeIssue(issue, id, i)
      return safe.module === undefined ? { ...safe, module: id } : safe
    })
}

// ---------------------------------------------------------------------------
// The form's budget (`MODULE_FORM_BUDGET_BYTES`)

const utf8 = new TextEncoder()
const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value)).length
/** Room kept per field for what the host adds at run time beside the instance's values: a combo's note, a cut marker. */
const NOTE_RESERVE_BYTES = 256
/** The described fields' size, with the room their run-time notes need. */
const formBytes = (fields: ReadonlyArray<SettingField>): number =>
  jsonBytes(fields) + fields.filter((f) => f.type === "combo" || f.type === "info").length * NOTE_RESERVE_BYTES

/** `text` cut to `room` bytes as JSON, saying how much was left out. */
const withinBytes = (text: string, room: number): string => {
  if (jsonBytes(text) <= room) return text
  let keep = Math.max(0, Math.min(text.length, room - 64))
  while (keep > 0 && jsonBytes(text.slice(0, keep)) > room - 64) keep = Math.floor(keep * 0.9)
  return `${text.slice(0, keep)}… (and ${text.length - keep} more characters)`
}

const encodeField = Schema.encodeUnknownResult(SettingField)

/** The generated Test button of an agent or decision provider without a `test` field of its own. */
const GENERATED_TEST_FIELD: SettingField = {
  type: "action",
  key: "test",
  label: "Test",
  description: "Sends one short message and reports the first answer and how long it took.",
  apply: "live",
  buttonLabel: "Test",
  requiresSaved: true,
  source: "default"
}

/** The form sent for a module whose own form cannot be sent. */
const EMPTY_FORM: SettingsForm = { fields: [], values: {}, secrets: {}, errors: [] }

/**
 * Why a module's described form cannot be sent, naming the field, or `undefined`: checked once, when the host is made,
 * against the wire's own schema (`SettingField`, every nested record item and option included) and the module's budget
 * (`MODULE_FORM_BUDGET_BYTES`). Such a module does not start.
 */
const formProblem = (def: ModuleDefinition<any>, generatedTest = false): string | undefined => {
  let fields: ReadonlyArray<SettingField>
  try {
    fields = resolveSettings(def.settings, { stored: {}, secrets: {}, env: {} }).form.fields
  } catch (error) {
    return `Its settings form could not be described: ${describe(error)}`
  }
  const all = generatedTest ? [...fields, GENERATED_TEST_FIELD] : fields
  let used = 0
  for (const field of all) {
    const encoded = encodeField(field)
    if (Result.isFailure(encoded)) {
      return `Its settings field "${field.key}" cannot be sent to the admin page: ${clip(encoded.failure.message.replace(/\s+/g, " "), 300)}. Fix the module.`
    }
    used += formBytes([encoded.success as SettingField]) - 2
    if (used > MODULE_FORM_BUDGET_BYTES) {
      return `Its settings form is larger than the ${MODULE_FORM_BUDGET_BYTES} bytes a module's form may take, from the field "${field.key}" on. Fix the module.`
    }
  }
  return undefined
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
