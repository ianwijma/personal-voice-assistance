import type {
  EngineSummary,
  HealthIssue,
  IssueFix,
  ModuleKind,
  ModuleState,
  SettingValue,
  ToolLatency,
  ToolRisk,
  ToolSensitivity
} from "@pva/protocol"
import { type Effect, Schema } from "effect"
import type { ActionParam } from "./Actions.ts"
import type { ModuleRoute, RouteTokens } from "./ModuleRoutes.ts"

/**
 * Module API version 2 (docs/MODULES-PLAN.md §4 P1; module-definition-config-and-dependencies.md §A.4, §C.3–C.5).
 *
 * Everything here is optional for a module: a module without `apiVersion` is version 1 and sees exactly what it saw
 * before (its `start` gets `{ settings, setStatus }`). A version 2 module has two lifetimes:
 *
 * - `shared(ctx)` (optional) runs **once per module** while the module is demanded (a switched-on assistant has it on,
 *   or a demanded module names it in `uses`), with the module's shared settings only. Sockets, caches, handlers,
 *   services (`ServiceKey`) and contributions (`ContributionKey`) belong there.
 * - `start(ctx)` runs once per distinct set of effective settings, as in version 1 (tools, actions, context,
 *   instructions), and receives what `shared` returned as `ctx.shared`.
 *
 * Both contexts carry the members of `ModuleServicesV2`: today `host`; later PRs add `store`, `events`, `scheduler`,
 * `speech`, `notify`, `present`, `connections`.
 *
 * **Adding a context member (later PRs).** One field in `ModuleServicesV2` (below) and one line in the module host's
 * `servicesFor` (`ModuleHost.ts`), which builds the members for both lifetimes. Nothing else changes: version 1
 * modules never get `servicesFor`'s result.
 */

/** The module API versions this host supports (`ModuleDefinition.apiVersion`). A module outside it is `unavailable`. */
export const MODULE_API = { current: 2, supports: [1, 2] } as const

/** The API versions a module can declare that this host runs. */
export type ModuleApiVersion = (typeof MODULE_API.supports)[number]

// ---------------------------------------------------------------------------------------------------------------------
// Requirements (§C.3)

/**
 * Something a module needs outside the process, declared on the manifest and judged before it starts (never on a
 * turn). A required (`optional` not true) requirement that is missing makes the module `unavailable`; a missing
 * optional one is a warning on the Health page. Two kinds, both on the server:
 *
 * - `tool`: a program, by its id in the app's program registry (`apps/assistant/src/requirements.ts`: how to probe it,
 *   which package installs it; the registry starts empty, and the PR of the first module that needs a program adds its
 *   entry). `version` is a semver range on the version the probe reads (`>=0.35`, `^6`, `>=5 <8`); a version that is
 *   not strict semver counts as unknown, and unknown does not satisfy a range. A program the registry does not know
 *   is missing.
 * - `network`: access to the LAN or the internet. Not probed in this version (shown as not checked).
 *
 * Requirements on a device, on memory, on disk or on a GPU are not part of this version.
 */
export type Requirement =
  | {
    readonly tool: string
    readonly version?: string
    readonly optional?: boolean
    /** Why the module needs it, one sentence: "Resolves stream URLs". */
    readonly why: string
  }
  | { readonly network: "lan" | "internet"; readonly optional?: boolean; readonly why?: string }

/** The operating systems and processor architectures a module runs on (`process.platform`, `process.arch` names). */
export interface Platforms {
  readonly os?: ReadonlyArray<string>
  readonly arch?: ReadonlyArray<string>
}

/** How one requirement stands on this server, from the app's probes (cached; judged at start and on "Check again"). */
export interface RequirementStatus {
  readonly requirement: Requirement
  /** `unchecked`: not judged here (a network); never makes a module unavailable. */
  readonly state: "met" | "missing" | "unchecked"
  /** One line: "ffmpeg 6.1.0", "yt-dlp is missing", "ffmpeg 4.4.0 is older than >=5". */
  readonly detail: string
  readonly fix?: IssueFix
}

/** The app's judgement of a module's requirements: synchronous, from the probe cache. */
export type RequirementCheck = (requirements: ReadonlyArray<Requirement>) => ReadonlyArray<RequirementStatus>

/** The requirement's subject in a few words: "ffmpeg", "internet access". */
export const describeRequirement = (r: Requirement): string =>
  "tool" in r ? r.tool : r.network === "internet" ? "internet access" : "access to the local network"

/** A short key for a requirement, used in issue ids ("yt-dlp", "network-internet"). */
export const requirementKey = (r: Requirement): string => ("tool" in r ? r.tool : `network-${r.network}`)

export const isOptionalRequirement = (r: Requirement): boolean => r.optional === true

// ---------------------------------------------------------------------------------------------------------------------
// Health (§C.5)

/**
 * What a module's `health()` receives: its shared settings (`undefined` when they are not valid) and whether it runs:
 * an instance runs, or its `shared` part runs (a module demanded only through another module's `uses`).
 */
export interface HealthContext<A> {
  readonly settings: A | undefined
  readonly running: boolean
}

/** One issue of the issue registry (the wire's `HealthIssue`, §C.5): id, module?, device?, severity, title, detail, fix?. */
export type Issue = HealthIssue
export type { IssueFix }

// ---------------------------------------------------------------------------------------------------------------------
// Templates (§A.1)

/**
 * A suggested assistant (plain data on the manifest). The new-assistant flow offers it; the owner instantiates it.
 * `id` is unique within the module (`/^[a-z][a-z0-9_-]{0,39}$/`); on the wire it is `<moduleId>.<id>`. `modules`
 * defaults to the module itself. Name, purpose, handles and prompt follow the assistant's own limits (32, 80, 240,
 * 4000 characters).
 */
export interface ModuleTemplate {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly purpose?: string
  readonly handles?: string
  readonly modules?: ReadonlyArray<string>
  readonly suggestedPhrases?: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------------------------------------------------
// Declared actions (§C.4)

/**
 * An action a module offers, declared on the manifest (`ModuleDefinition.declaredActions`) so it stays known while the
 * module is `unavailable` (never started): the intent agent can still recognise "play jazz" as the music module's,
 * and core answers with the module's "not set up" line instead of running some other action. Only what a decision
 * model needs to recognise it; the running module's own actions (from `start`) are what runs. `id` is the action's
 * id (`/^[a-z][a-z0-9_]{0,39}$/`).
 */
export interface DeclaredAction {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly examples?: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------------------------------------------------
// Services and contributions between modules

/**
 * A typed key under which a module's `shared` part provides a service to other modules (like a `Context` tag, but
 * looked up live, so a consumer gets `undefined` while the provider is not demanded):
 * `export const Lists = ServiceKey<ListsService>("lists")`, provided with `services: [Lists.of(impl)]`. Keys are
 * compared by `id`; one module may provide a key (a second provider is a start error for the second). The shared keys
 * live in `@pva/module-contracts` (P11).
 *
 * The grace period of a stop covers the calls admitted to the stopping module itself (its tools, actions, context
 * providers). A call another module makes into its service while it stops (or restarts) may fail: the consumer
 * handles that failure like any other (and finds the service absent at its next lookup).
 */
export interface ServiceKey<T> {
  readonly _tag: "ServiceKey"
  readonly id: string
  /** This key with its service, for `SharedPart.services`. */
  readonly of: (service: T) => ProvidedService
  /** Phantom: carries `T`. Never set. */
  readonly _T?: (t: T) => T
}

export interface ProvidedService {
  readonly key: ServiceKey<any>
  readonly service: unknown
}

export const ServiceKey = <T>(id: string): ServiceKey<T> => {
  const key: ServiceKey<T> = { _tag: "ServiceKey", id, of: (service) => ({ key, service }) }
  return key
}

/**
 * A typed key under which `shared` parts contribute values that another module collects (a briefing section, a
 * calendar provider): `export const BriefingSections = ContributionKey<BriefingSection>("briefing.sections")`,
 * contributed with `contributions: [BriefingSections.of(section)]`. Any number of modules may contribute; nothing
 * registers itself with another module, so start order and restarts cannot lose a contribution.
 */
export interface ContributionKey<T> {
  readonly _tag: "ContributionKey"
  readonly id: string
  readonly of: (value: T) => ProvidedContribution
  readonly _T?: (t: T) => T
}

export interface ProvidedContribution {
  readonly key: ContributionKey<any>
  readonly value: unknown
}

export const ContributionKey = <T>(id: string): ContributionKey<T> => {
  const key: ContributionKey<T> = { _tag: "ContributionKey", id, of: (value) => ({ key, value }) }
  return key
}

/** What a module's `shared` part returns: the value every instance gets (`ctx.shared`), its services and contributions. */
export interface SharedPart<X> {
  readonly value: X
  readonly services?: ReadonlyArray<ProvidedService>
  readonly contributions?: ReadonlyArray<ProvidedContribution>

  // -- P3: module HTTP routes (`ModuleRoutes.ts`) ----------------------------------------------------------------------
  /**
   * HTTP routes under `/api/modules/<moduleId>/…`, answered while this shared part is the published one (a stopped
   * module's paths answer 404). Checked when it starts (`routeProblem`): a bad route is a start error.
   */
  readonly routes?: ReadonlyArray<ModuleRoute>
}

// ---------------------------------------------------------------------------------------------------------------------
// The host, as a module sees it

/** One module in the host's read-only view. */
export interface HostModuleView {
  readonly id: string
  readonly name: string
  readonly kind: ModuleKind
  readonly state: ModuleState
  readonly version?: string
  /** Why it is `unavailable`. */
  readonly unavailable?: string
}

/** One known device in the host's read-only view (serve mode). */
export interface HostDeviceView {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** Open connections (tabs) now; 0 = not connected. */
  readonly connections: number
}

/** What a module may read about the assistant it runs in. Every read is a snapshot; nothing here changes anything. */
export interface HostView {
  readonly modules: ReadonlyArray<HostModuleView>
  /** The key vault is locked. `undefined`: not known (the CLI modes). */
  readonly vaultLocked: boolean | undefined
  /** Whether the speech and language engines run. `undefined` in the CLI modes. */
  readonly engine: EngineSummary | undefined
  /** Known devices, most recently seen first (empty in the CLI modes). */
  readonly devices: ReadonlyArray<HostDeviceView>
  /**
   * The Home section's values by key, read generically (`HOME_LOCATION`, `HOME_TIME_ZONE`, `HOME_LANGUAGE`,
   * `HOME_UNITS`, `HOME_DATE_FORMAT`, and whatever other keys the section has). Empty when unknown.
   */
  readonly home: Readonly<Record<string, SettingValue>>
}

/** Where the app's half of the view comes from (`ModuleHostOptions.view`). Each read is cheap: a reference read. */
export interface HostViewSource {
  readonly vaultLocked?: () => boolean | undefined
  readonly engine?: () => EngineSummary | undefined
  readonly devices?: () => ReadonlyArray<HostDeviceView>
  readonly home?: () => Readonly<Record<string, SettingValue>>
}

/** A parameter of a catalogued action, described (the values `actions.run` takes are its tool input form). */
export interface CatalogParam {
  readonly name: string
  readonly kind: ActionParam["kind"]
  readonly label: string
  readonly optional: boolean
}

/** An action of the turn's catalogue. */
export interface CatalogAction {
  readonly moduleId: string
  readonly actionId: string
  /** `<moduleId>.<actionId>`. */
  readonly id: string
  readonly label: string
  readonly description: string
  readonly examples: ReadonlyArray<string>
  readonly params: ReadonlyArray<CatalogParam>
  readonly speculative: boolean
  /** It needs the owner's spoken confirmation; `actions.run` refuses it (`needs_confirmation`). */
  readonly confirm: boolean
  /** The declared or inferred class; `undefined` when it depends on the values. */
  readonly risk: ToolRisk | undefined
  /** Every class a run can have (`[risk]`, or the declared list when it depends on the values). */
  readonly risks: ReadonlyArray<ToolRisk>
  readonly sensitivity: ToolSensitivity
  readonly latency: ToolLatency
}

export type ActionRunResult =
  | { readonly ok: true; readonly say?: string }
  | {
    readonly ok: false
    /**
     * `refused`: the execution gateway did not admit it (the module or the action is off for the assistant, no turn or
     * job to run for, or a later policy). `unavailable`: the module cannot run on this server; `message` is its
     * "not set up" line.
     */
    readonly code:
      | "unknown_module"
      | "not_running"
      | "unavailable"
      | "unknown_action"
      | "invalid_params"
      | "needs_confirmation"
      | "refused"
      | "failed"
    readonly message: string
  }

/** What `actions.run` is asked to do. */
export interface ActionRunRequest {
  readonly moduleId: string
  readonly actionId: string
  /**
   * The action's parameters in its tool input form (what the generated tool takes): a choice its value, a dynamic
   * parameter a name ("kitchen"), a number a number, a duration a phrase ("10 minutes"), a boolean a boolean, text a
   * string. Checked against the action before it runs.
   */
  readonly params: Readonly<Record<string, unknown>>
}

/**
 * A host object kept by module code after its part's scope closed: every member answers with this, as a defect (an
 * effect dies with it, a synchronous member throws it), so the members' types stay what they are while the module
 * runs. `isModuleStopped` recognises it.
 */
export class ModuleStopped extends Schema.TaggedError<ModuleStopped>()("ModuleStopped", { message: Schema.String }) {}

export const isModuleStopped = (u: unknown): u is ModuleStopped => u instanceof ModuleStopped

/** The turn's action catalogue (`ModuleHostApi.actions`). */
export interface ActionCatalogue {
  readonly list: Effect.Effect<ReadonlyArray<CatalogAction>>
  /**
   * Run one action of the turn's catalogue through the execution gateway (routines). Every refusal and failure is a
   * result. The action's 5 s limit applies; the caller's `CurrentTurn` is the action's. An action that needs
   * confirmation is refused (`needs_confirmation`): the gateway refuses it on every path while confirmation is off.
   */
  readonly run: (request: ActionRunRequest) => Effect.Effect<ActionRunResult>
}

/**
 * The host as a version 2 module sees it (`ModuleServicesV2.host`, in `shared` and in `start`). Every lookup is live.
 * Once the part's scope has closed (the module stopped), every member answers with `ModuleStopped`: an effect dies
 * with it, a synchronous member throws it.
 */
export interface ModuleHostApi {
  /** P3: this module's route tokens (`ModuleRoutes.ts`), in the key vault. Fails `unavailable` outside serve mode. */
  readonly routeTokens: RouteTokens
  /** A read-only snapshot of the assistant: module states, vault, engines, devices, Home values. */
  readonly view: () => HostView
  /**
   * The service under `key` from a demanded module's `shared` part, or `undefined` while none is published (a
   * provider starts and stops on its own; look it up at each use, never keep it). A call into it may fail while its
   * provider stops: the provider's grace period covers only calls admitted to the provider itself, so handle that
   * failure.
   */
  readonly service: <T>(key: ServiceKey<T>) => T | undefined
  /**
   * Every value contributed under `key` by the published shared parts now, in catalog order; for a caller acting for
   * an assistant (the calling fiber's `CurrentTurn`, or a job made for an assistant) only those of the modules that
   * assistant has on. Effectful, so the caller is read from the fiber's own context, which survives every `yield*`
   * (an `await` inside native code does not carry a fiber: capture the assistant first and use `contributionsFor`).
   */
  readonly contributions: <T>(key: ContributionKey<T>) => Effect.Effect<ReadonlyArray<T>>
  /**
   * The same for an assistant named explicitly; `undefined` asks deliberately for every provider's (shared code
   * acting for nobody in particular). Synchronous, for native callbacks.
   */
  readonly contributionsFor: <T>(key: ContributionKey<T>, assistantId: string | undefined) => ReadonlyArray<T>
  /**
   * The turn's action catalogue: the actions of the modules the calling assistant has on (`CurrentTurn`, or a job
   * made for an assistant), from the instance it uses, without those it switched off; an unavailable module's
   * declared actions are listed too (running one answers with its "not set up" line). The local principal of the
   * CLI modes sees every running module's actions; in serve mode a caller with no turn or job sees none.
   */
  readonly actions: ActionCatalogue
  /**
   * Ask the host to stop this module and start it again (a tool list that changed at run time, an MCP server's, then
   * applies from the next turn). Returns at once; the module's worker stops it (its tools are withdrawn, calls in
   * flight get the grace period) and starts it again. Requests are taken up at most once every 5 s, the ones in
   * between merged into the next: a module cannot restart itself in a tight loop (this is not a minimum distance
   * between two restarts). One made after the last one was taken up always leads to another. The request is
   * recorded in one step: a caller interrupted right after it has made it whole or not at all. Only a live part asks:
   * from `shared` or `start` while it starts, from a start that failed, or from a part being stopped (a finalizer),
   * it is ignored (logged at debug); from a part whose scope has closed it dies with `ModuleStopped`. The new start runs
   * outside any turn: it never sees the caller's `CurrentTurn`. Settings are the module's current ones; a vault
   * locked since does not stop it (it starts with the secrets it ran with).
   */
  readonly requestRestart: (reason: string) => Effect.Effect<void>
  /**
   * A program the module `requires` failed to start with ENOENT or EACCES (`isMissingProgramError`): the host marks
   * it missing at once and judges every module again (it becomes `unavailable` and Health says why), without probing
   * on the turn path. A program the module does not require is ignored. Returns at once.
   */
  readonly reportMissingProgram: (tool: string) => Effect.Effect<void>
}

/** Whether an error from spawning a program means it is not there or cannot be run (`ENOENT`, `EACCES`). */
export const isMissingProgramError = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined
  return code === "ENOENT" || code === "EACCES"
}

/**
 * The context members a version 2 module gets in `shared` and in `start`. Later PRs add one member each here
 * (`store`, `events`, `scheduler`, `speech`, `notify`, `present`, `connections`) and one line in the host's
 * `servicesFor`, which receives the part's `PartHandle` (`ModuleRegistrations.ts`): a member that registers something
 * (a job handler, a subscription) registers it through the handle during the part's start, so it is published and
 * withdrawn with the module. A version 1 module never gets them.
 */
export interface ModuleServicesV2 {
  readonly host: ModuleHostApi
}

/**
 * What `shared` receives: the module's shared settings (environment > saved > linked default; the fields an assistant
 * may own, `overridable`, are left out, so they are absent here) and the host's services.
 */
export interface SharedContext<A> extends ModuleServicesV2 {
  readonly settings: Partial<A>
  /**
   * The module's effective settings for an assistant: the assistant's own values of `overridable` fields over the
   * shared ones; with no assistant (or one that does not have the module on), the shared ones. It answers from the
   * latest accepted state of the run: who has the module on, their own values, the saved values and the defaults as
   * of the last change that kept the run, with the secrets the run started with. Changes that keep the run do not
   * restart the module: an assistant that joins or leaves an existing instance, assistants that swap between equal
   * instances, a changed default or saved value of an `overridable` field that no running instance uses (the module
   * runs only for `uses`, or every assistant that has it on has its own value). So ask
   * each time; do not cache what it answers on the assumption that every relevant change restarts the module.
   * Shared code that acts for a caller asks with the caller's assistant (`CurrentTurn`), so a weather briefing uses
   * the asking assistant's place. `undefined` when those values are not valid (a required field with no value for
   * that assistant). Throws `ModuleStopped` once the module has stopped.
   */
  readonly settingsFor: (assistantId: string | undefined) => A | undefined
}
