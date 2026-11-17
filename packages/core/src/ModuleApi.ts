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
import type { Effect } from "effect"
import type { ActionParam } from "./Actions.ts"

/**
 * Module API version 2 (docs/MODULES-PLAN.md §4 P1; module-definition-config-and-dependencies.md §A.4, §C.3–C.5).
 *
 * Everything here is optional for a module: a module without `apiVersion` is version 1 and sees exactly what it saw
 * before (its `start` gets `{ settings, setStatus }`). A version 2 module also gets the members of `ModuleServicesV2`
 * in its context: today `host`; later PRs add `store`, `events`, `scheduler`, `notify`, `present`, `connections`.
 *
 * **Adding a context member (later PRs).** One field in `ModuleServicesV2` (below) and one line in the module host's
 * `servicesFor` (`ModuleHost.ts`), which builds the members for one instance. Nothing else changes: version 1 modules
 * never get `servicesFor`'s result, and `ModuleContextV2` is `ModuleContext` plus `ModuleServicesV2`.
 */

/** The module API versions this host supports (`ModuleDefinition.apiVersion`). A module outside it is `unavailable`. */
export const MODULE_API = { current: 2, supports: [1, 2] } as const

/** The API versions a module can declare that this host runs. */
export type ModuleApiVersion = (typeof MODULE_API.supports)[number]

// ---------------------------------------------------------------------------------------------------------------------
// Requirements (§C.3)

/** Where a required program must run. Only `server` is judged in this version; the device places are not checked yet. */
export type RequirementPlace = "server" | "playback-device" | "listening-device"

/**
 * Something a module needs outside the process, declared on the manifest and judged before `start` (never on a turn).
 * A required (`optional` not true) requirement that is missing makes the module `unavailable`; a missing optional one
 * is a warning on the Health page.
 *
 * - `tool`: a program, by its id in the app's tool registry (`apps/assistant/src/requirements.ts`: how to probe it,
 *   which package installs it). `version` is a range on its reported version (`>=0.35`, `^6`, `>=5 <8`). An id the
 *   registry does not know is probed with `<id> --version`.
 * - `network`: access to the LAN or the internet. Not probed in this version (shown as not checked).
 * - `memoryMb` / `diskMb`: total memory, and free space in the data directory.
 * - `gpu`: a CUDA or Vulkan device (probed through `nvidia-smi` / `vulkaninfo`).
 */
export type Requirement =
  | {
    readonly tool: string
    /** Default `server`. */
    readonly where?: RequirementPlace
    readonly version?: string
    readonly optional?: boolean
    /** A managed copy the server could install (§C.6; not offered yet). */
    readonly managed?: string
    /** Why the module needs it, one sentence: "Resolves stream URLs". */
    readonly why: string
  }
  | { readonly network: "lan" | "internet"; readonly optional?: boolean; readonly why?: string }
  | { readonly memoryMb: number; readonly optional?: boolean; readonly why?: string }
  | { readonly diskMb: number; readonly optional?: boolean; readonly why?: string }
  | { readonly gpu: "cuda" | "vulkan"; readonly optional?: boolean; readonly why?: string }

/** The operating systems and processor architectures a module runs on (`process.platform`, `process.arch` names). */
export interface Platforms {
  readonly os?: ReadonlyArray<string>
  readonly arch?: ReadonlyArray<string>
}

/** How one requirement stands on this server, from the app's probes (cached; judged at start and on "Check again"). */
export interface RequirementStatus {
  readonly requirement: Requirement
  /** `unchecked`: not judged here (a network, a program on a device); never makes a module unavailable. */
  readonly state: "met" | "missing" | "unchecked"
  /** One line: "ffmpeg 6.1", "yt-dlp is missing", "ffmpeg 4.4 is older than >=5". */
  readonly detail: string
  readonly fix?: IssueFix
}

/** The app's judgement of a module's requirements: synchronous, from the probe cache. */
export type RequirementCheck = (requirements: ReadonlyArray<Requirement>) => ReadonlyArray<RequirementStatus>

/** The requirement's subject in a few words: "ffmpeg", "internet access", "4096 MB of memory". */
export const describeRequirement = (r: Requirement): string =>
  "tool" in r ? r.tool
  : "network" in r ? (r.network === "internet" ? "internet access" : "access to the local network")
  : "memoryMb" in r ? `${r.memoryMb} MB of memory`
  : "diskMb" in r ? `${r.diskMb} MB of free disk space`
  : r.gpu === "cuda" ? "a CUDA graphics card" : "a Vulkan graphics device"

/** A short key for a requirement, used in issue ids ("yt-dlp", "network-internet", "memory"). */
export const requirementKey = (r: Requirement): string =>
  "tool" in r ? r.tool : "network" in r ? `network-${r.network}` : "memoryMb" in r ? "memory" : "diskMb" in r ? "disk" : `gpu-${r.gpu}`

export const isOptionalRequirement = (r: Requirement): boolean => r.optional === true

// ---------------------------------------------------------------------------------------------------------------------
// Health (§C.5)

/** What a module's `health()` receives: its shared settings (`undefined` when they are not valid) and whether it runs. */
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
// Services between modules

/**
 * A typed key under which a module provides a service to other modules (like a `Context` tag, but looked up at run
 * time, so a consumer gets `undefined` when the provider is off): `export const Lists = ServiceKey<ListsService>("lists")`.
 * Keys are compared by `id`; give each a unique one (the shared ones live in `@pva/module-contracts`, P11).
 */
export interface ServiceKey<T> {
  readonly _tag: "ServiceKey"
  readonly id: string
  /** Phantom: carries `T`. Never set. */
  readonly _T?: (t: T) => T
}

export const ServiceKey = <T>(id: string): ServiceKey<T> => ({ _tag: "ServiceKey", id })

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
  /** The key vault is locked (or there is none while keys are kept unencrypted: false). `undefined`: not known (CLI). */
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

/** An action of a running module, as the action catalogue lists it. */
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
  readonly risk: ToolRisk
  readonly sensitivity: ToolSensitivity
  readonly latency: ToolLatency
}

export type ActionRunResult =
  | { readonly ok: true; readonly say?: string }
  | {
    readonly ok: false
    readonly code: "unknown_module" | "not_running" | "unknown_action" | "not_offered" | "invalid_params" | "needs_confirmation" | "failed"
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
  /** Run it as this assistant: refused (`not_offered`) when the assistant does not have the module or the action on. */
  readonly assistantId?: string
}

/**
 * The host as a version 2 module sees it (`ModuleContextV2.host`). Bound to the module instance it was given to:
 * `requestRestart` restarts that instance, and a service it `provide`s belongs to that instance.
 */
export interface ModuleHostApi {
  /** A read-only snapshot of the assistant: module states, vault, engines, devices, Home values. */
  readonly view: () => HostView
  readonly actions: {
    /**
     * The actions of the running modules, catalog order. With `assistantId`: those of the modules that assistant has
     * on, from the instance it uses, without the tools it has switched off.
     */
    readonly list: (options?: { readonly assistantId?: string }) => ReadonlyArray<CatalogAction>
    /**
     * Run one action of a running module (routines). Never fails: every refusal and failure is a result. The action's
     * 5 s limit applies; the caller's `CurrentTurn` is the action's. An action that needs confirmation is refused.
     */
    readonly run: (request: ActionRunRequest) => Effect.Effect<ActionRunResult>
  }
  /**
   * Ask the host to start this instance again with the same settings (its tool list changed at run time: an MCP
   * server's). The new instance is published once it has started, from the next turn on; the old one serves until
   * then and keeps its grace period. If the new start fails, the old instance keeps serving and the Health page says
   * why. Returns at once; repeated calls before the restart starts count once.
   */
  readonly requestRestart: (reason: string) => Effect.Effect<void>
  readonly services: {
    /**
     * Provide `service` under `key` for as long as this instance runs (callable during `start` and after). A later
     * call with the same key replaces it. Returns a function that withdraws it.
     */
    readonly provide: <T>(key: ServiceKey<T>, service: T) => () => void
    /**
     * The service under `key`, or `undefined` when no running module provides it. Without `assistantId`: the
     * providing module's instance with the shared settings (else its first running one), the same instance whose tools
     * are in the main registry. With `assistantId`: the instance that assistant uses, or `undefined` when it does not
     * use the providing module. Modules are searched in catalog order; the first that provides the key wins.
     */
    readonly get: <T>(key: ServiceKey<T>, options?: { readonly assistantId?: string }) => T | undefined
  }
}

/**
 * The context members a module written for API version 2 gets besides `settings` and `setStatus`. Later PRs add one
 * member each here (`store`, `events`, `scheduler`, `notify`, `present`, `connections`) and one line in the host's
 * `servicesFor`. A version 1 module never gets them.
 */
export interface ModuleServicesV2 {
  readonly host: ModuleHostApi
}
