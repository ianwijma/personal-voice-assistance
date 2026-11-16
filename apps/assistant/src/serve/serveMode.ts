import {
  type AgentTurnSetup,
  type HostResult,
  Llm,
  LlmError,
  makeModuleHost,
  makeToolRegistry,
  type ModuleDemand,
  makeTurnTrace,
  type ModuleDefinition,
  type ModuleHost,
  type ModuleSnapshot,
  parseVoiceKey,
  SttError,
  Tts,
  TtsError,
  type TurnSetup,
  type TurnTrace,
  type VoiceRef,
  voiceKey
} from "@pva/core"
import {
  type Assistant,
  DEFAULT_MAX_VOICE_SESSIONS,
  DEFAULT_SESSION_DISCARD_MINUTES,
  type DeviceSettings,
  deviceTypeOf,
  effectiveDeviceSettings,
  type EngineInfo,
  hearerOf,
  homeLineOf,
  linkedModuleDefaults,
  engineSummary,
  type VoiceInfo,
  type ServerMessage,
  type TraceConfig,
  WEB_VOICE_KIND
} from "@pva/protocol"
import { Cause, Config, ConfigProvider, Effect, Exit, Fiber, FiberSet, Option, type Scope, Stream } from "effect"
import { createHash } from "node:crypto"
import { freemem } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultSystemPrompt } from "../config.ts"
import { envView as processEnvView, userCwd } from "../env.ts"
import { type EnvView, makeEnvView } from "../envView.ts"
import { moduleCatalog, withModuleInstructions } from "../modules.ts"
import {
  makeSubscriptionAgents,
  SUBSCRIPTION_AGENT_ID,
  SUBSCRIPTION_DEFAULT_MODEL,
  SUBSCRIPTION_PROVIDER,
  type SubscriptionAssistant,
  subscriptionAssistantOf,
  subscriptionSessionLimit
} from "../subscription.ts"
import { makeAccessPolicy } from "./access.ts"
import { adminPasswordProblem, makeAdminSessions } from "./AdminSessions.ts"
import { acquireDataDirLock, type DataDirLockError } from "./DataDirLock.ts"
import {
  defaultProviderBuilder,
  type Engine,
  EngineBuildProblems,
  makeEngine,
  type ProviderBuilder
} from "./Engine.ts"
import {
  defaultLlmBuilder,
  defaultSttBuilder,
  defaultTtsBuilder,
  type LlmAccounts,
  type LlmBuilder,
  llmKeyOf,
  type LlmSpec,
  llmSpecOf,
  makeResourcePool,
  type ReconcileOptions,
  type ResourcePool,
  sherpaOptionsOf,
  type SttBuilder,
  type SttShared,
  type SttSpec,
  sttKeyOf,
  sttLoadMsOf,
  sttRamMbOf,
  sttSpecOf,
  type TtsAccounts,
  type TtsBuilder,
  type TtsSpec,
  ttsSpecOf
} from "./Resources.ts"
import { ttsProviderInfo } from "../providers.ts"
import { DEFAULT_ASSISTANT_VOICE, voiceEngineName, voiceLabel } from "../voiceSelection.ts"
import { type EnvMover, makeEnvMover } from "./envSettings.ts"
import { type HttpError, type HttpServer, startHttp, webDirExists } from "./http.ts"
import { deviceSettingsFrom, makeDeviceRegistry } from "./devices.ts"
import { type Jobs, makeJobs } from "./jobs.ts"
import { makeModels, type Models, type PresetDownloader, presetsInUse } from "./models.ts"
import { type Keys, makeKeys } from "./Keys.ts"
import { makeSections } from "./sections.ts"
import { makeAssistants } from "./assistants.ts"
import { makeSessionHub, type SessionHub } from "./SessionHub.ts"
import { DataDirConfig, KEYS_LOCKED_MESSAGE, loadSettingsStore, type SettingsStore, SettingsStoreError } from "./SettingsStore.ts"
import { makeApi } from "./api.ts"
import { makeAssistantVoice } from "./AssistantVoice.ts"
import { type Favourites, makeFavourites } from "./Favourites.ts"
import { makeVoiceCatalog, type VoiceCatalog, type VoiceCatalogOptions } from "./VoiceCatalog.ts"
import { makeModelCatalog } from "./ModelCatalog.ts"
import { makeModelFavourites } from "./ModelFavourites.ts"
import { type AssistantTraceConfig, type Hearing, makeVoiceSession } from "./VoiceSession.ts"
import { makeVoiceSessions, type VoiceSessions } from "./VoiceSessions.ts"
import { makeRoutingService, ROUTING_KEYS } from "./routing.ts"
import { type KdfParams, openVault, type Vault, VaultPathConfig } from "./Vault.ts"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import type { ToolId } from "@pva/protocol"

/**
 * `serve` mode (docs/UI-AND-MODULES.md §4): one process, one port. The browser
 * is the microphone, speaker and control surface; the module host, the
 * settings and the engines live here.
 *
 * Startup order: HTTP first (so the UI loads and shows "starting"), then the
 * module host and the engine build in parallel. Every voice device gets its own voice session (its own audio
 * pipeline and conversation, docs/VOICE-SESSIONS.md) at its first claim or typed message, on the shared engines;
 * a session's input is a noise floor while none of its device's tabs owns the audio.
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url))

/** How long a start after unblocking waits for a module (or the engines) busy with another operation. */
const IDLE_WAIT_MS = 30_000
const IDLE_POLL_MS = 25

export interface ServeOptions {
  readonly host: string
  readonly port: number
  readonly allowedOrigins: ReadonlyArray<string>
  /** Host names the server answers to besides IP literals and `localhost` (`SERVE_ALLOWED_HOSTS`). */
  readonly allowedHosts?: ReadonlyArray<string>
  readonly tls?: { readonly certFile: string; readonly keyFile: string } | undefined
  /** Cross-origin isolation headers on the page and its files (`SERVE_CROSS_ORIGIN_ISOLATION`). Default on. */
  readonly crossOriginIsolation?: boolean
  readonly webDir: string
  readonly dataDir: string
  /** The key vault file (`PVA_VAULT_PATH`; tests use a temporary directory). */
  readonly vaultPath: string
  /** For tests: cheaper scrypt parameters for a new vault, and the clock of the unlock rate limit. */
  readonly vaultKdf?: KdfParams
  readonly vaultNow?: () => number
  /**
   * The admin password (`PVA_ADMIN_PASSWORD`, read once by `serveMode`). Default: `env.PVA_ADMIN_PASSWORD`. Unset or
   * shorter than 8 characters: admin is disabled (nothing can be configured from a browser).
   */
  readonly adminPassword?: string
  /** Tests: admin sessions end after this long without an admin action (default 30 min) / at the latest (12 h). */
  readonly adminIdleMs?: number
  readonly adminMaxMs?: number
  /** Tests: the admin sessions' clock (epoch ms; the login back-off). Default `Date.now`. */
  readonly adminNow?: () => number
  /** Unlock the vault at start with this (`PVA_VAULT_PASSWORD`). Default: `env.PVA_VAULT_PASSWORD`. Never grants admin access. */
  readonly vaultPassword?: string
  readonly catalog?: ReadonlyArray<ModuleDefinition<any>>
  /** Engine providers (tests inject fakes). Default: the providers chosen by the settings. */
  readonly build?: ProviderBuilder
  /** Checks before a reload stops the running engines. Default: `checkModelsBeforeReload`'s check, or none. */
  readonly preflight?: Effect.Effect<void, EngineBuildProblems>
  /**
   * Before a reload: check that the model files of every local recogniser in use exist (a reload whose recogniser
   * would fail keeps the running engines). Default: with the default builder only.
   */
  readonly checkModelsBeforeReload?: boolean
  /**
   * Builds the resource pool's recognisers (docs/ASSISTANTS.md §3.2, WP-11; tests inject fakes). Default: stt-sherpa
   * and Deepgram (`defaultSttBuilder`); with an injected `build` and no `buildStt`, instances that hear with that
   * build's `stt`.
   */
  readonly buildStt?: SttBuilder
  /** Tests: the longest wait for silence before a hearer switch (default 5 s, §3.5). */
  readonly hearerSwitchWaitMs?: number
  /** Tests: the memory free on this machine (the save-time warning of docs/ASSISTANTS.md §9). Default `os.freemem`. */
  readonly freeMemoryBytes?: () => number
  /**
   * Builds the resource pool's language-model instances (docs/ASSISTANTS.md §3.2; tests inject fakes). Default: the
   * accounts' adapters (`defaultLlmBuilder`); with an injected `build` and no `buildLlm`, instances that answer with
   * that build's `llm`.
   */
  readonly buildLlm?: LlmBuilder
  /** TypeSafe routing's HTTP client (tests: a fake server's, or a stand-in). Default: the global `fetch`. */
  readonly routingFetch?: typeof globalThis.fetch
  /**
   * Builds the resource pool's voice instances (tests inject fakes). Default: the providers' adapters
   * (`defaultTtsBuilder`); with an injected `build` and no `buildTts`, instances that speak with that build's `tts`.
   */
  readonly buildTts?: TtsBuilder
  /** Tests: how long an unused language-model or voice instance is kept (default `RESOURCE_GRACE_MS`, 10 s). */
  readonly resourceGraceMs?: number
  /**
   * The environment with where each variable came from (`envView.ts`). Default: the process environment and the
   * `.env` files `env.ts` loaded; with `env`, that record (every variable from the process).
   */
  readonly envView?: EnvView
  /** Tests: a plain environment (every variable counts as exported by the process unless `envOrigin` says otherwise). */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly envOrigin?: (name: string) => "env-file" | "env-process"
  /** Tests: model downloads without the network, and the free disk space. */
  readonly modelDownloaders?: Readonly<Record<ToolId, PresetDownloader>>
  readonly freeBytes?: (dir: string) => Promise<number>
  /** Tests: the hosted providers' voice lists and previews (local mock servers), and the engine of local previews. */
  readonly hostedVoices?: VoiceCatalogOptions["hostedVoices"]
  readonly localPreviewEngine?: VoiceCatalogOptions["localEngine"]
  /** Tests: the model pickers' list time limit (default `LIST_TIMEOUT_MS`) and clock. */
  readonly modelListTimeoutMs?: number
  readonly modelCatalogNow?: () => number
  readonly turnTrace?: TurnTrace["Service"]
  /** Playback stall limit (tests shorten it). Default 2000 ms. */
  readonly stallMs?: number
  /** Tests: what one minute of `conversationIdleMinutes` and `SESSION_DISCARD_MINUTES` is (ms). Default 60 000. */
  readonly minuteMs?: number
  readonly helloTimeoutMs?: number
  readonly pingIntervalMs?: number
}

export interface ServeHandle {
  readonly http: HttpServer
  readonly hub: SessionHub
  readonly engine: Engine
  /** The voice sessions (one per device). */
  readonly sessions: VoiceSessions
  readonly host: ModuleHost
  readonly keys: Keys
  readonly vault: Vault
  readonly envView: EnvView
  readonly envMover: EnvMover
  readonly jobs: Jobs
  readonly models: Models
  readonly favourites: Favourites
  /** The resource pool (the language models, docs/ASSISTANTS.md §3.2). */
  readonly resources: ResourcePool
  /** The settings store (every save reconciles the resource pool). Tests save assistants through it until WP-5. */
  readonly store: SettingsStore
  /** Completes when the first engine build, module start and resource builds have settled. */
  readonly ready: Effect.Effect<void>
}

export const startServe = (options: ServeOptions): Effect.Effect<ServeHandle, HttpError | SettingsStoreError | DataDirLockError, Scope.Scope> =>
  Effect.gen(function*() {
    const envView = options.envView ?? (options.env === undefined ? processEnvView : makeEnvView({ processEnv: options.env }))
    const env = envView.record
    const catalog = options.catalog ?? moduleCatalog
    const vault = yield* Effect.tryPromise({
      try: () =>
        openVault({
          path: options.vaultPath,
          ...(options.vaultKdf !== undefined ? { kdf: options.vaultKdf } : {}),
          ...(options.vaultNow !== undefined ? { now: options.vaultNow } : {})
        }),
      catch: (cause) => new SettingsStoreError({ message: `Could not open the key vault at ${options.vaultPath}`, cause })
    })
    // Before anything in the data directory is read or recovered, and held until the server stops: the one writer.
    const lock = yield* acquireDataDirLock(options.dataDir)
    // The environment and the catalog: what a version-3 file's migration reads, and what locks the migrated assistant.
    // Every save may change which language models are wanted (assistants, devices, shared keys): the pool reconciles.
    let resourcesChanged = () => {}
    const store = notifyAfterSaves(
      yield* loadSettingsStore(options.dataDir, { lock, vault, assistants: { env, catalog } }),
      () => resourcesChanged()
    )
    for (const problem of store.problems) yield* Effect.logError(problem)
    /**
     * Settings and keys that may come from two saves (a damaged journal): nothing that uses them starts. Every page
     * sees why in the engine status (`failed`, problem stage "settings"), the bar at the top of the page; the
     * settings stay editable, and the first successful save starts the engines and the enabled modules.
     */
    const settingsProblem = () => {
      const why = store.blocked()
      return why === undefined ? undefined : { stage: "settings", message: why }
    }
    if (store.blocked() !== undefined) yield* Effect.logError(store.blocked()!)
    if (store.legacySecretCount() > 0) {
      yield* vault.state() === "none"
        ? Effect.logWarning(
          `API keys are stored unencrypted in ${options.dataDir}/secrets.json. Set a password in Settings → Keys & access to move them ` +
            `into an encrypted key vault outside the project (${vault.path}).`
        )
        : Effect.logWarning(`${options.dataDir}/secrets.json still holds keys; they move into the key vault at the next unlock.`)
    }
    // Where environment values came from (.env with its line, or the process), for the fields' source and lock.
    const envOrigin = options.envOrigin ?? envView.sourceOf
    const envLocation = envView.locationOf
    const sections = makeSections(store, env, { envOrigin, envLocation })
    /** The Home values the modules' linked defaults come from (docs/ASSISTANTS.md §2.6). */
    const homeDefaults = (moduleId: string) =>
      linkedModuleDefaults({
        location: String(sections.value("HOME_LOCATION") ?? ""),
        units: sections.value("HOME_UNITS") === "imperial" ? "imperial" : "metric",
        timeZone: String(sections.value("HOME_TIME_ZONE") ?? ""),
        dateFormat: String(sections.value("HOME_DATE_FORMAT") ?? "en-GB")
      })[moduleId]
    // Capabilities run for the assistants that switch them on (`moduleDemand`, below; read from startEnabled on).
    const host = yield* makeModuleHost({
      catalog,
      persistence: store.modulePersistence,
      env,
      envOrigin,
      envLocation,
      defaults: homeDefaults,
      demand: () => moduleDemand()
    })
    const keys = makeKeys({ vault, store, host })
    const access = makeAccessPolicy({ catalog, sections: sections.list, vaultState: keys.state })

    // Keys set in the environment win over the vault and are not protected by it: say so (names only).
    const secretFields = [
      ...sections.list().flatMap((x) => x.form.fields),
      ...host.modules().flatMap((m) => m.settings.fields)
    ].flatMap((f) => (f.type === "secret" && f.env !== undefined ? [f.env] : []))
    const inEnv = secretFields.filter((name) => (env[name] ?? "") !== "")
    if (inEnv.length > 0) {
      yield* Effect.logWarning(
        `${inEnv.join(", ")} ${inEnv.length === 1 ? "is" : "are"} set in the environment (.env): used as is and not protected by the key vault. ` +
          "Use Move to settings in Settings → Diagnostics → Settings from outside to put them in the vault."
      )
    }
    const vaultPassword = options.vaultPassword ?? env.PVA_VAULT_PASSWORD
    if (vaultPassword !== undefined && vaultPassword !== "") yield* keys.autoUnlock(vaultPassword)
    else if (vault.state() === "locked") yield* Effect.logWarning("The key vault is locked: unlock it in Settings → Keys & access so the engines and modules can use their keys.")
    const turnTrace = options.turnTrace ?? makeTurnTrace()
    const runFork = yield* FiberSet.makeRuntime<never, void, never>()
    const run = (effect: Effect.Effect<void>) => {
      runFork(effect.pipe(Effect.catchCause((cause) => Effect.logError("serve: request failed", cause))))
    }
    // Voice sessions are built synchronously (in a hub handler) with the server's services (logging, scheduler).
    const services = yield* Effect.context<never>()
    /**
     * Not `Effect.runSync`: its scheduler only runs while it runs, so the fibers a session forks (the noise floor of
     * its audio input) would never run again. A fork starts at once and these effects never wait, so it has
     * finished when `runFork` returns.
     */
    const runSync = <A>(effect: Effect.Effect<A>): A => {
      const exit = Effect.runForkWith(services)(effect).pollUnsafe()
      if (exit === undefined) throw new Error("serve: a voice session could not be created synchronously")
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      return exit.value
    }
    const minuteMs = options.minuteMs ?? 60_000

    // Late-bound: the hub needs the engine and the sessions, and their callbacks need the hub.
    let hub: SessionHub | undefined
    let lastSummary: string | undefined
    let engine: Engine | undefined
    let modelsRef: Models | undefined
    const broadcast = (message: ServerMessage) => hub?.broadcast(message)

    /** Base prompt + running modules' instructions. */
    const systemFor = (base: string, instructions: ReadonlyArray<string>) => withModuleInstructions(base, instructions)

    // LLM_PROVIDER=claude-subscription: an agent conversation whose agent is the running claude-subscription module.
    // Every session's conversation uses that one agent; it keeps one Claude Code session per conversation id.
    const subscriptionModule = () => host.modules().find((m) => m.id === SUBSCRIPTION_AGENT_ID)
    /** The engine row's detail: `model` is the assistant's (WP-13a: each assistant on the account has its own). */
    const subscriptionDetail = (assistantModel: string) => {
      const m = subscriptionModule()
      const model = assistantModel.trim() === "" ? SUBSCRIPTION_DEFAULT_MODEL : assistantModel.trim()
      if (m?.state === "running") return model
      return `${model} · module ${m === undefined || !m.enabled ? "off" : m.state}: the offline stand-in answers`
    }
    const secretNames = () =>
      sections.list().flatMap((x) => x.form.fields).flatMap((f) => (f.type === "secret" && f.env !== undefined ? [f.env] : []))

    // ---- Assistants and devices (docs/ASSISTANTS.md §2.6), read from the settings store (version 4)

    /** The assistants in effect (the environment applied to the migrated one), by id; recomputed after a save. */
    let assistantsCache: { readonly file: unknown; readonly byId: ReadonlyMap<string, Assistant> } | undefined
    const assistantsNow = (): ReadonlyMap<string, Assistant> => {
      const file = store.settings()
      if (assistantsCache?.file !== file) {
        assistantsCache = { file, byId: new Map(store.assistantsInEffect().map(({ assistant }) => [assistant.id, assistant])) }
      }
      return assistantsCache.byId
    }
    /** A device's effective settings: its own sections ← its type's defaults ← the built-in (no device: the browser defaults). */
    const deviceSettingsOf = (deviceId: string | undefined): DeviceSettings => deviceSettingsFrom(store.settings(), deviceId)
    /** Modules an assistant chooses (capabilities); agent and decision modules are not per assistant and always pass. */
    const isCapability = (moduleId: string) => {
      const def = catalog.find((d) => d.id === moduleId)
      return def === undefined || def.kind === undefined || def.kind === "capability"
    }
    /**
     * Who wants which capability (docs/ASSISTANTS.md §2.6): every switched-on assistant that has it on, with its own
     * values. Each capability has an entry (an empty list: nobody, so it does not run); agents and decision providers
     * have none and follow their own switch.
     */
    const moduleDemand = (): ReadonlyMap<string, ReadonlyArray<ModuleDemand>> => {
      const demand = new Map<string, Array<ModuleDemand>>(catalog.filter((d) => isCapability(d.id)).map((d) => [d.id, []]))
      for (const assistant of assistantsNow().values()) {
        if (!assistant.on) continue
        for (const [moduleId, choice] of Object.entries(assistant.modules)) {
          if (choice.on) demand.get(moduleId)?.push({ assistantId: assistant.id, ...(choice.own !== undefined ? { own: choice.own } : {}) })
        }
      }
      return demand
    }
    /** Bring the module instances in line with the assistants and Home (after every save; not while blocked). */
    const syncModules = (): Effect.Effect<void> => Effect.suspend(() => (store.blocked() !== undefined ? Effect.void : host.refresh))
    /**
     * The Home line of every assistant's stable prompt (location, time zone, language; docs/ASSISTANTS.md §2.4): the
     * `home` section, the machine's zone when it names none. The same string while Home does not change.
     */
    let homeCache: { readonly values: string; readonly line: string } | undefined
    const homeLine = (): string | undefined => {
      const home = {
        location: String(sections.value("HOME_LOCATION") ?? ""),
        timeZone: String(sections.value("HOME_TIME_ZONE") ?? ""),
        language: String(sections.value("HOME_LANGUAGE") ?? "")
      }
      const values = `${home.location}\n${home.timeZone}\n${home.language}`
      if (homeCache?.values !== values) {
        homeCache = { values, line: homeLineOf({ ...home, machineTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) }
      }
      return homeCache.line === "" ? undefined : homeCache.line
    }
    /**
     * An assistant's share of the running modules: the modules it has on (capabilities, each the instance of its
     * effective settings; the others always pass), the tools it has not switched off, and their instructions. The
     * whole snapshot when nothing is left out.
     */
    const modulesFor = (snapshot: ModuleSnapshot, assistant: Assistant) => {
      const own = snapshot.assistantParts.get(assistant.id) ?? snapshot.parts
      const parts = own.flatMap((part) => {
        if (!isCapability(part.moduleId)) return [part]
        const choice = assistant.modules[part.moduleId]
        if (choice === undefined || !choice.on) return []
        if (choice.offTools.length === 0) return [part]
        const off = new Set(choice.offTools)
        return [{ ...part, module: { ...part.module, tools: (part.module.tools ?? []).filter((t) => !off.has(t.name)) } }]
      })
      /** The modules it has on that run (capabilities; for the turn's configuration snapshot). */
      const modules = parts.reduce((n, p) => (isCapability(p.moduleId) ? n + 1 : n), 0)
      const same = parts.length === snapshot.parts.length && parts.every((p, i) => p === snapshot.parts[i])
      if (same) return { registry: snapshot.registry, instructions: snapshot.instructions, modules }
      return {
        registry: makeToolRegistry(parts.map((p) => p.module)),
        instructions: parts.flatMap((p) => (p.instructions.length > 0 ? [p.instructions] : [])),
        modules
      }
    }

    // ---- The resource pool: one language-model instance per distinct configuration (docs/ASSISTANTS.md §3.2, WP-9)

    /** A shared setting as the providers read it (environment > saved > vault), or `undefined` when unset. */
    const settingNow = (name: string): string | undefined => {
      const exit = Effect.runSyncExit(
        Effect.gen(function*() {
          return yield* Config.String(name)
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, sections.configProvider()))
      )
      return Exit.isSuccess(exit) && exit.value !== "" ? exit.value : undefined
    }
    /** A shared on/off setting as the providers read it, or `undefined` when unset or not a boolean. */
    const booleanSettingNow = (name: string): boolean | undefined => {
      if (settingNow(name) === undefined) return undefined
      const exit = Effect.runSyncExit(
        Effect.gen(function*() {
          return yield* Config.Boolean(name)
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, sections.configProvider()))
      )
      return Exit.isSuccess(exit) ? exit.value : undefined
    }
    /**
     * The accounts' shared settings an instance depends on: a changed address or key makes new instances, and so does
     * OpenRouter's "Prefer the fastest provider" (its adapter reads it once, when built).
     */
    const llmAccounts = (): LlmAccounts => {
      const stamp = (name: string) => {
        const key = settingNow(name)
        return key === undefined ? "" : createHash("sha256").update(key).digest("hex").slice(0, 16)
      }
      return {
        anthropic: { address: settingNow("ANTHROPIC_BASE_URL"), credential: stamp("ANTHROPIC_API_KEY") },
        openrouter: {
          address: settingNow("OPENROUTER_BASE_URL"),
          credential: stamp("OPENROUTER_API_KEY"),
          sortByLatency: booleanSettingNow("OPENROUTER_SORT_BY_LATENCY")
        },
        "home-model": { address: settingNow("HOME_MODEL_BASE_URL"), credential: stamp("HOME_MODEL_API_KEY") }
      }
    }
    /** The shared voice-provider settings an instance depends on: a new key makes new instances. */
    const ttsAccounts = (): TtsAccounts => {
      const credentials: Record<string, string> = {}
      for (const [provider, info] of Object.entries(ttsProviderInfo)) {
        if (info.keyEnv === undefined) continue
        const key = settingNow(info.keyEnv)
        credentials[provider] = key === undefined ? "" : createHash("sha256").update(key).digest("hex").slice(0, 16)
      }
      return { credentials }
    }
    /** The shared settings of the recognisers (§2.4 "Speech recognition models"): a change makes new instances. */
    const sttShared = (): SttShared => {
      const threads = Number(settingNow("STT_SHERPA_THREADS") ?? "")
      const key = settingNow("DEEPGRAM_API_KEY")
      return {
        modelDir: settingNow("STT_SHERPA_MODEL_DIR"),
        threads: Number.isInteger(threads) && threads > 0 ? threads : undefined,
        deepgram: {
          model: settingNow("DEEPGRAM_MODEL"),
          address: settingNow("DEEPGRAM_URL"),
          credential: key === undefined ? "" : createHash("sha256").update(key).digest("hex").slice(0, 16)
        }
      }
    }
    /** Where a device's recogniser is bound in the pool: the device's own place, or its type's (no record yet). */
    const placeOf = (deviceId: string | undefined): string =>
      deviceId !== undefined && store.settings().devices[deviceId] !== undefined ? `device:${deviceId}` : `type:${WEB_VOICE_KIND}`
    /**
     * Every hearing place (§3.2 "Wanted", stt: the hearer of every type defaults entry and of every known device) with
     * its effective settings. `override` replaces one place's settings (a save being checked); a type's new defaults
     * also apply to the devices of that type that inherit them.
     */
    const placesNow = (override?: { readonly place: string; readonly settings: DeviceSettings }): Map<string, DeviceSettings> => {
      const saved = store.settings()
      const typeKind = override?.place.startsWith("type:") === true ? override.place.slice("type:".length) : undefined
      const file = typeKind === undefined
        ? saved
        : { ...saved, deviceTypes: { ...saved.deviceTypes, [typeKind]: { ...override!.settings, rev: saved.deviceTypes[typeKind]?.rev ?? 0 } } }
      const places = new Map<string, DeviceSettings>()
      for (const kind of new Set([WEB_VOICE_KIND, ...Object.keys(file.deviceTypes)])) {
        const type = deviceTypeOf(kind)
        if (type === undefined) continue
        places.set(`type:${kind}`, effectiveDeviceSettings(type.builtIn, file.deviceTypes[kind], undefined))
      }
      for (const id of Object.keys(file.devices)) places.set(`device:${id}`, deviceSettingsFrom(file, id))
      if (override !== undefined) places.set(override.place, override.settings)
      return places
    }
    /**
     * The recogniser of every hearing place: its hearer's hearing (switched on or not, §2.6: switching an assistant
     * off does not change how a device hears). A place with no assistant has none.
     */
    const recognisersOf = (
      places: ReadonlyMap<string, DeviceSettings>,
      assistants: ReadonlyMap<string, Assistant>
    ): Map<string, { readonly spec: SttSpec; readonly hearer: string }> => {
      const shared = sttShared()
      const out = new Map<string, { readonly spec: SttSpec; readonly hearer: string }>()
      for (const [place, settings] of places) {
        const hearer = hearerOf(settings)
        const assistant = hearer === null ? undefined : assistants.get(hearer)
        if (assistant === undefined) continue
        out.set(place, { spec: sttSpecOf(assistant.hearing, shared), hearer: assistant.id })
      }
      return out
    }
    /**
     * What the pool must hold (§3.2 "Wanted"): the language model and the voice of every switched-on assistant that
     * is on at least one effective list (a type defaults entry counts, and every known device's own list), and the
     * recogniser of every hearing place.
     */
    const wantedResources = (): {
      readonly llms: Map<string, LlmSpec>
      readonly voices: Map<string, TtsSpec>
      readonly recognisers: Map<string, { readonly spec: SttSpec; readonly hearer: string }>
    } => {
      const file = store.settings()
      const listed = new Set<string>()
      for (const kind of new Set([WEB_VOICE_KIND, ...Object.keys(file.deviceTypes)])) {
        const type = deviceTypeOf(kind)
        if (type === undefined) continue
        for (const a of effectiveDeviceSettings(type.builtIn, file.deviceTypes[kind], undefined).assistants) listed.add(a.assistant)
      }
      for (const id of Object.keys(file.devices)) for (const a of deviceSettingsOf(id).assistants) listed.add(a.assistant)
      const accounts = llmAccounts()
      const voiceAccounts = ttsAccounts()
      const llms = new Map<string, LlmSpec>()
      const voices = new Map<string, TtsSpec>()
      for (const assistant of assistantsNow().values()) {
        if (!assistant.on || !listed.has(assistant.id)) continue
        const spec = llmSpecOf(assistant.llm, accounts)
        llms.set(assistant.id, spec)
        rememberLlmSpec(spec)
        voices.set(assistant.id, ttsSpecOf(assistant.voice, voiceAccounts))
      }
      return { llms, voices, recognisers: recognisersOf(placesNow(), assistantsNow()) }
    }
    /**
     * The spec of every language-model key asked for, so a turn's trace can say what the instance it is bound to was
     * built with (`ResourcePool.keyFor` names the key; the binding may still be the old instance during a change).
     * Bounded: entries whose key the pool no longer lists are dropped when it grows.
     */
    const llmSpecs = new Map<string, LlmSpec>()
    const rememberLlmSpec = (spec: LlmSpec) => {
      const key = llmKeyOf(spec)
      if (llmSpecs.get(key) === spec) return
      llmSpecs.set(key, spec)
      if (llmSpecs.size > 64) {
        const live = new Set(resources.status().map((r) => r.key))
        for (const k of llmSpecs.keys()) if (k !== key && !live.has(k)) llmSpecs.delete(k)
      }
    }
    const explainProblem = (message: string): string => explainProblems([{ stage: "", message }])[0]!.message
    // Tests that inject the shared build answer with its `llm`, through the pool (one instance per configuration still).
    const engineLlmBuilder: LlmBuilder = () =>
      Effect.succeed(Llm.of({
        stream: (request) =>
          Stream.suspend(() => {
            const llm = engine?.built()?.providers.llm
            return llm === undefined ? Stream.fail(new LlmError({ message: "The engines are not running." })) : llm.stream(request)
          })
      }))
    // Likewise for voices: one instance per distinct voice, speaking with the build's `tts`.
    const engineTtsBuilder: TtsBuilder = () =>
      Effect.succeed({
        get sampleRate() {
          return engine?.built()?.providers.tts?.sampleRate ?? 22_050
        },
        synthesize: (clauses) =>
          Stream.suspend(() => {
            const tts = engine?.built()?.providers.tts
            return tts === undefined ? Stream.fail(new TtsError({ message: "The engines are not running." })) : tts.synthesize(clauses)
          })
      } satisfies Tts["Service"])
    // Likewise for recognisers: every hearing place hears with the build's `stt`, each with its own stream.
    const engineSttBuilder: SttBuilder = () =>
      Effect.succeed({
        forStream: () => ({
          transcribe: (audio) =>
            Stream.suspend(() => {
              const stt = engine?.built()?.providers.stt
              return stt === undefined ? Stream.fail(new SttError({ message: "The engines are not running." })) : stt.transcribe(audio)
            })
        })
      })
    /** Late-bound: every voice session is told when what it hears with may have changed. */
    let sessionsRef: VoiceSessions | undefined
    /** The real providers (no injected build, or the real builder passed explicitly): the pool builds them all. */
    const realBuild = options.build === undefined || options.build === defaultProviderBuilder
    const resources = yield* makeResourcePool({
      buildStt: options.buildStt ?? (realBuild ? defaultSttBuilder(sections.configProvider) : engineSttBuilder),
      onRebind: () => {
        for (const session of sessionsRef?.all() ?? []) session.hearingChanged()
      },
      buildTts: options.buildTts ?? (realBuild ? defaultTtsBuilder(sections.configProvider) : engineTtsBuilder),
      buildLlm: options.buildLlm ?? (realBuild ? defaultLlmBuilder(sections.configProvider) : engineLlmBuilder),
      ...(options.resourceGraceMs !== undefined ? { graceMs: options.resourceGraceMs } : {}),
      onChange: () => {
        engine?.refreshStatus()
        // A published binding can switch an assistant between the subscription agents and one model (`agentSetup`).
        for (const session of sessionsRef?.all() ?? []) {
          for (const c of session.conversation.dispatcher.conversations().values()) c.conversation.bindingChanged()
        }
      },
      explainProblem,
      log: (line) => runFork(Effect.logInfo(line))
    })
    const syncResources = (reconcile: ReconcileOptions = {}): Effect.Effect<void> =>
      Effect.suspend(() =>
        store.blocked() !== undefined
          ? Effect.void
          : (({ llms, recognisers, voices }) => resources.reconcile(llms, { ...reconcile, voices, recognisers }))(wantedResources())
      )
    resourcesChanged = () => {
      run(syncResources())
      // The assistants' module choices and Home decide which module instances run.
      run(syncModules())
    }
    /** A turn of an assistant the pool does not hold (not in use: off, or on no list) is answered with this. */
    const notInUse = Llm.of({
      stream: () => Stream.fail(new LlmError({ message: "This assistant is not in use on any device, so it has no language model." }))
    })

    /** A turn of an assistant the pool holds no voice for (not in use) cannot be spoken. */
    const noVoice = Tts.of({
      sampleRate: 22_050,
      synthesize: () => Stream.fail(new TtsError({ message: "This assistant is not in use on any device, so it has no voice." }))
    })

    /** The Claude subscription account's bound on open sessions (§3.3), the same number while nothing it reads changes. */
    let limitOf: { readonly assistants: ReadonlyMap<string, Assistant>; readonly max: number; readonly limit: number } | undefined
    const subscriptionLimit = (): number => {
      const assistants = assistantsNow()
      const max = Number(sections.value("MAX_VOICE_SESSIONS") ?? DEFAULT_MAX_VOICE_SESSIONS)
      if (limitOf?.assistants !== assistants || limitOf.max !== max) limitOf = { assistants, max, limit: subscriptionSessionLimit(max, assistants.values()) }
      return limitOf.limit
    }
    /**
     * The assistant's part of a turn's configuration snapshot (protocol 7 `TraceConfig`, docs/ASSISTANTS.md §3.7): the
     * language model the turn is bound to (the pool's instance: its spec, which during a change is still the old one;
     * a binding on the Claude subscription: the options its agent is passed, from the assistant's own fields), the
     * voice it is bound to, the modules and tools it has, and its reply-early and tool-round settings.
     */
    const traceConfigOf = (assistant: Assistant, tools: number, modules: number): AssistantTraceConfig => {
      const key = resources.keyFor(assistant.id)
      // The account of the binding in use, as `agentSetup` reads it (during a change the old binding answers, the old
      // way), not the saved one. Not bound yet: the saved account.
      const account = key === undefined ? assistant.llm.account : key.split("|")[0]
      // On the subscription the agent answers with these options (`subscriptionAssistant`), not the pool's stand-in.
      const passed = account === SUBSCRIPTION_PROVIDER ? subscriptionAssistantOf(assistant, 1).options : undefined
      const spec = (key === undefined ? undefined : llmSpecs.get(key)) ?? llmSpecOf(assistant.llm)
      return {
        llm: passed !== undefined
          // No token limit is passed to Claude Code (`ClaudeConversationOptions` has none): the stand-in's, as `llmSpecOf` keeps it.
          ? { account: SUBSCRIPTION_PROVIDER, model: passed.model, effort: assistant.llm.effort, thinking: assistant.llm.thinking, maxTokens: 1024 }
          : { account: spec.account, model: spec.model, effort: spec.effort, thinking: spec.thinking, maxTokens: spec.maxTokens },
        voice: resources.ttsKeyFor(assistant.id) ?? voiceKey(assistant.voice),
        modules,
        tools: passed !== undefined && !passed.tools ? 0 : tools,
        replyEarly: assistant.replyEarly,
        toolRounds: assistant.toolRounds
      }
    }

    /**
     * One assistant's turn setup in one session (and its agent setup): its prompt, the Home line, the instructions
     * of its modules, a registry of its tools, and its language model (the pool's instance for its `llm` settings,
     * read here at the turn's start: a changed model applies from the next turn, once its instance is ready). Rebuilt
     * only when the module snapshot, the assistant or its instance changed (reference compares per turn).
     */
    const conversationSetup = (assistantId: string) => {
      let cached:
        | {
          snapshot: ModuleSnapshot
          assistant: Assistant | undefined
          home: string | undefined
          llm: Llm["Service"] | undefined
          tts: Tts["Service"] | undefined
          setup: TurnSetup
          instructions: ReadonlyArray<string>
          /** The turn's configuration snapshot (`TraceConfig` without the hearing, which is the device's). */
          config: AssistantTraceConfig | undefined
        }
        | undefined
      const llmNow = () => {
        const bound = resources.llmFor(assistantId)
        if (bound !== undefined) return bound
        // Not reconciled since the assistant came into use: reconcile now. `reconcile` binds (and starts what is
        // missing) synchronously before it waits for the builds, so with `startImmediately` the binding is there
        // when the fork returns; the turn then waits on the instance being built.
        runSync(Effect.asVoid(Effect.forkDetach(syncResources(), { startImmediately: true })))
        return resources.llmFor(assistantId)
      }
      /** Likewise the assistant's voice: the pool's instance for its `voice`, read at the turn's start. */
      const ttsNow = () => {
        const bound = resources.ttsFor(assistantId)
        if (bound !== undefined) return bound
        runSync(Effect.asVoid(Effect.forkDetach(syncResources(), { startImmediately: true })))
        return resources.ttsFor(assistantId)
      }
      const current = () => {
        const snapshot = host.snapshot()
        const assistant = assistantsNow().get(assistantId)
        const home = homeLine()
        const llm = llmNow()
        const tts = ttsNow()
        if (cached?.snapshot !== snapshot || cached.assistant !== assistant || cached.home !== home || cached.llm !== llm || cached.tts !== tts) {
          // An assistant that does not exist (any more) is never routed; should a turn still start, it gets no tools.
          const mine = assistant === undefined ? { registry: makeToolRegistry([]), instructions: [], modules: 0 } : modulesFor(snapshot, assistant)
          const base = assistant?.prompt ?? defaultSystemPrompt
          const instructions = home === undefined ? mine.instructions : [home, ...mine.instructions]
          // `TurnSetup.ttsReady`: completes once this `tts` (the instance bound now, not a later one) is built.
          const ttsReady = resources.ttsReady(assistantId)
          cached = {
            snapshot,
            assistant,
            home,
            llm,
            tts,
            setup: {
              system: systemFor(base, instructions),
              registry: mine.registry,
              llm: llm ?? notInUse,
              tts: tts ?? noVoice,
              ...(tts !== undefined ? { ttsReady } : {}),
              // The limit the turn runs with and the one its snapshot (`config`) reports: both from this `assistant`.
              ...(assistant !== undefined ? { maxToolRounds: assistant.toolRounds } : {})
            },
            instructions,
            config: assistant === undefined ? undefined : traceConfigOf(assistant, mine.registry.specs.length, mine.modules)
          }
        }
        return cached
      }
      // The setup never waits (the conversation's input loop reads it, so Stop and barge-in would wait too): a spoken
      // turn waits for a voice still being built (the assistant came into use just now) itself, before it plays.
      const setup = Effect.sync((): TurnSetup => current().setup)
      /**
       * The turn's configuration snapshot, read when its trace begins: the values `current()` resolved for the setup,
       * made again only when the module snapshot, the assistant or its bindings changed (reference compares, no
       * prompt or registry work). The object is never changed afterwards: a trace keeps the one its turn began with.
       */
      const config = (): AssistantTraceConfig | undefined => {
        const c = cached
        if (c !== undefined && c.snapshot === host.snapshot() && c.assistant === assistantsNow().get(assistantId) &&
          c.llm === resources.llmFor(assistantId) && c.tts === resources.ttsFor(assistantId)) return c.config
        return current().config
      }
      // WP-13a: a Claude subscription assistant's options for its conversations (the same object while unchanged).
      let subscriptionOf: { readonly assistant: Assistant; readonly limit: number; readonly value: SubscriptionAssistant } | undefined
      const subscriptionAssistant = (): SubscriptionAssistant | undefined => {
        const assistant = assistantsNow().get(assistantId)
        if (assistant === undefined) return undefined
        const limit = subscriptionLimit()
        if (subscriptionOf?.assistant !== assistant || subscriptionOf.limit !== limit) {
          subscriptionOf = { assistant, limit, value: subscriptionAssistantOf(assistant, limit) }
        }
        return subscriptionOf.value
      }
      // A Claude subscription assistant: the agent module answers with the assistant's model and options; the pool's
      // instance is the offline stand-in.
      let subscription: { readonly fallback: Llm["Service"]; readonly toAgents: (setup: TurnSetup) => AgentTurnSetup } | undefined
      const agentSetup = () => {
        // The account of the binding in use (a key starts with its account), not the saved one: while a changed
        // model is still being built the old binding answers, the old way. Not bound yet: the saved account.
        const key = resources.keyFor(assistantId)
        const account = key === undefined ? assistantsNow().get(assistantId)?.llm.account : key.split("|")[0]
        if (account !== SUBSCRIPTION_PROVIDER) return undefined
        return Effect.map(setup, (turn) => {
          const fallback = turn.llm ?? notInUse
          if (subscription?.fallback !== fallback) {
            subscription = {
              fallback,
              toAgents: makeSubscriptionAgents({
                fallbackLlm: fallback,
                agents: () => host.snapshot().agents,
                module: subscriptionModule,
                assistant: subscriptionAssistant,
                promptFor: (agent, t) => agent.systemPrompt === undefined ? t.system : systemFor(agent.systemPrompt, current().instructions)
              })
            }
          }
          return subscription.toAgents(turn)
        })
      }
      return { setup, agentSetup, config }
    }

    /** The engine list's `llm` row (pages before WP-6 read it): the first switched-on assistant's language model. */
    const llmRow = (): EngineInfo => {
      const all = [...assistantsNow().values()]
      const first = all.find((a) => a.on) ?? all[0]
      if (first === undefined) return { stage: "llm", provider: "fake", detail: "no assistant", location: "local" }
      const account = first.llm.account
      switch (account) {
        case "offline":
          return { stage: "llm", provider: "fake", detail: "offline stand-in", location: "local" }
        case "anthropic":
          return { stage: "llm", provider: "anthropic", detail: first.llm.model, location: "hosted" }
        case "claude-subscription":
          return { stage: "llm", provider: SUBSCRIPTION_PROVIDER, detail: subscriptionDetail(first.llm.model), location: "hosted" }
        default:
          return { stage: "llm", provider: account, detail: first.llm.model, location: "hosted" }
      }
    }
    /** The voices in use as engine rows (the Models page marks their presets in use) and as the status's `voices`. */
    const voicesInUse = () =>
      resources.status().flatMap((r) => {
        const ref = r.kind === "tts" && r.usedBy.length > 0 && r.state !== "failed" ? parseVoiceKey(r.key) : undefined
        return ref === undefined ? [] : [{ ref, location: r.location }]
      })
    const ttsRows = (): Array<EngineInfo> =>
      voicesInUse().map(({ ref, location }) => ({ stage: "tts", provider: ref.provider, detail: ref.voiceId, location }))
    const voiceInfos = (): Array<VoiceInfo> => {
      const first = voiceKey(assistantVoiceRef())
      return voicesInUse().map(({ ref, location }) => ({
        name: voiceKey(ref),
        description: voiceLabel(ref),
        enabled: true,
        isDefault: voiceKey(ref) === first,
        engine: voiceEngineName(ref),
        location
      }))
    }
    /** The first assistant's voice (a switched-on one if there is one). */
    const assistantVoiceRef = (): VoiceRef => {
      const all = [...assistantsNow().values()]
      return (all.find((a) => a.on) ?? all[0])?.voice ?? DEFAULT_ASSISTANT_VOICE
    }
    /** The recognisers in use as engine rows (the Models page marks their presets in use). */
    const sttRows = (): Array<EngineInfo> =>
      resources.status().flatMap((r) => {
        if (r.kind !== "stt" || r.usedBy.length === 0 || r.state === "failed") return []
        const [provider = "sherpa", detail = ""] = r.key.split("|")
        return [{ stage: "stt", provider, detail, location: r.location }]
      })
    /**
     * The reload's cheap check (docs/ASSISTANTS.md §3.2: a reload rebuilds every resource in use): the model files of
     * every local recogniser in use exist, else the running engines are kept.
     */
    const hearingPreflight: Effect.Effect<void, EngineBuildProblems> = Effect.suspend(() => {
      const problems: Array<{ stage: string; message: string }> = []
      const seen = new Set<string>()
      for (const { spec, hearer } of wantedResources().recognisers.values()) {
        if (spec.engine !== "sherpa" || seen.has(spec.model + (spec.modelDir ?? ""))) continue
        seen.add(spec.model + (spec.modelDir ?? ""))
        const checked = Effect.runSyncExit(SherpaStt.check(sherpaOptionsOf(spec, spec.stream)))
        if (Exit.isFailure(checked)) {
          const failure = Cause.squash(checked.cause)
          problems.push({ stage: `speech-to-text (hearing of ${assistantsNow().get(hearer)?.name ?? hearer})`, message: failure instanceof Error ? failure.message : String(failure) })
        }
      }
      return problems.length === 0 ? Effect.void : Effect.fail(new EngineBuildProblems({ problems }))
    })
    /**
     * What this device hears with (§2.6, §3.5): the pool's recogniser of its place, with its hearer's stream options.
     * No assistant on the device: none. Not bound yet: the pool reconciles at once.
     */
    const hearingOf = (deviceId: string | undefined) => {
      /** The hearing part of the turns' configuration snapshot: one object per binding and hearer. */
      let traced: { readonly id: string; readonly hearer: string; readonly value: TraceConfig["hearing"] } | undefined
      return (): Hearing => {
        const hearer = hearerOf(deviceSettingsOf(deviceId))
        if (hearer === null || !assistantsNow().has(hearer)) return { kind: "none" }
        const place = placeOf(deviceId)
        let binding = resources.sttFor(place)
        if (binding === undefined) {
          runSync(Effect.asVoid(Effect.forkDetach(syncResources(), { startImmediately: true })))
          binding = resources.sttFor(place)
        }
        if (binding === undefined) return { kind: "waiting" }
        if (traced?.id !== binding.id || traced.hearer !== hearer) traced = { id: binding.id, hearer, value: hearingTraceOf(hearer, binding.spec) }
        return {
          kind: "ready",
          id: binding.id,
          stt: binding.stt,
          key: binding.key,
          trace: traced.value,
          ...(binding.problem !== undefined ? { problem: binding.problem } : {})
        }
      }
    }
    /** The recogniser a device hears with, as a turn's configuration snapshot says it (`TraceConfig.hearing`). */
    const hearingTraceOf = (hearer: string, spec: SttSpec): TraceConfig["hearing"] =>
      spec.engine === "deepgram"
        ? { hearer, engine: spec.engine, model: spec.model, eotThreshold: spec.stream.eotThreshold }
        : {
          hearer,
          engine: spec.engine,
          model: spec.model,
          ...(spec.language !== "" ? { language: spec.language } : {}),
          eagerSilenceMs: spec.stream.eagerSilenceMs,
          finalSilenceMs: spec.stream.finalSilenceMs
        }
    /** What a session's recordings say they were heard with. */
    const hearingModelOf = (deviceId: string | undefined) => (): string => {
      const binding = resources.sttFor(placeOf(deviceId))
      return binding === undefined ? "none" : `${binding.spec.engine} ${binding.spec.model}`
    }
    /**
     * Per assistant, its hearing problems (`AssistantInfo.problems`): a recogniser that failed, and the memory of the
     * local speech models when more than one is loaded (WP-0's measured `ramMb`; docs/ASSISTANTS.md §3.2).
     */
    const llmProblems = (assistantId: string): Array<string> =>
      resources.status().filter((r) => r.kind === "llm" && r.state === "failed" && r.usedBy.includes(assistantId))
        .map((r) => `Language model (${r.label}): ${r.problem ?? "the language model could not start."}`)
    const hearingProblems = (assistantId: string): Array<string> => {
      const stt = resources.status().filter((r) => r.kind === "stt")
      const mine = stt.filter((r) => r.usedBy.includes(assistantId))
      const out = mine.flatMap((r) => (r.state === "failed" ? [`Hearing (${r.label}): ${r.problem ?? "the speech recogniser could not start."}`] : []))
      const local = stt.filter((r) => r.location === "local" && r.state !== "failed" && r.usedBy.length > 0)
      if (local.length > 1) {
        const total = local.reduce((sum, r) => sum + (r.ramMb ?? 0), 0)
        for (const r of mine.filter((m) => m.location === "local" && m.state !== "failed")) {
          out.push(`Hears with ${r.label} (about ${r.ramMb ?? "?"} MB of memory); ${local.length} local speech models are loaded together, about ${total} MB.`)
        }
      }
      return out
    }
    /**
     * §9 "warn above 75 % of free memory at save": the local speech models a change would load besides the ones
     * loaded now, when together they need more than 75 % of the memory free on this machine. `undefined`: no warning.
     */
    const speechMemoryWarning = (change: { readonly place?: { readonly place: string; readonly settings: DeviceSettings }; readonly assistant?: Assistant }): string | undefined => {
      const assistants = new Map(assistantsNow())
      if (change.assistant !== undefined) assistants.set(change.assistant.id, change.assistant)
      const loaded = new Set(resources.status().filter((r) => r.kind === "stt" && r.state !== "failed").map((r) => r.key))
      const added = new Map<string, SttSpec>()
      for (const { spec } of recognisersOf(placesNow(change.place), assistants).values()) {
        const key = sttKeyOf(spec)
        if (spec.engine === "sherpa" && !loaded.has(key)) added.set(key, spec)
      }
      const mb = [...added.values()].reduce((sum, spec) => sum + (sttRamMbOf(spec) ?? 0), 0)
      const freeMb = Math.round((options.freeMemoryBytes?.() ?? freemem()) / 1e6)
      if (mb === 0 || mb <= 0.75 * freeMb) return undefined
      const loadS = Math.max(...[...added.values()].map((spec) => sttLoadMsOf(spec) ?? 0)) / 1000
      return `This loads ${added.size === 1 ? "another speech model" : `${added.size} more speech models`}: about ${mb} MB more memory and ${loadS.toFixed(1)} s to load, ` +
        `more than 75 % of the ${freeMb} MB free on this machine.`
    }
    /** While the vault is locked, a key that "is not set" is really locked away. */
    const explainProblems = (problems: ReadonlyArray<{ readonly stage: string; readonly message: string }>) => {
      if (keys.state() !== "locked") return problems
      const names = secretNames()
      return problems.map((p) => {
        const missing = /^([A-Z][A-Z0-9_]*) is not set$/.exec(p.message)?.[1]
        // OpenRouter's key is required (WP-13b: `notSetUpMessage`); a home model's key is optional.
        if (/^OpenRouter is not set up: add its API key/.test(p.message)) return { ...p, message: KEYS_LOCKED_MESSAGE }
        return missing !== undefined && names.some((n) => missing.endsWith(n)) ? { ...p, message: KEYS_LOCKED_MESSAGE } : p
      })
    }

    engine = yield* makeEngine({
      build: options.build ?? defaultProviderBuilder,
      ...(options.preflight !== undefined
        ? { preflight: options.preflight }
        : options.checkModelsBeforeReload ?? options.build === undefined
        ? { preflight: hearingPreflight }
        : {}),
      configProvider: sections.configProvider,
      onStatus: (status) => {
        // `engine` goes to admin connections only (SessionHub.ADMIN_ONLY); the summary to everyone, when it changed.
        broadcast({ type: "engine", engine: status })
        const summary = JSON.stringify(engineSummary(status))
        if (summary !== lastSummary) {
          lastSummary = summary
          broadcast({ type: "engine.summary", engine: engineSummary(status) })
        }
        // Which models are in use follows the running engines.
        if (hub !== undefined) broadcast({ type: "models", models: modelsRef?.list() ?? [] })
      },
      // The language model is no longer the build's: its row comes from the assistants (and the pool's resources).
      describeEngines: (engines) => [
        llmRow(),
        ...(sttRows().length > 0 ? sttRows() : engines.filter((e) => e.stage === "stt")),
        ...engines.filter((e) => e.stage !== "llm" && e.stage !== "tts" && e.stage !== "stt"),
        ...(ttsRows().length > 0 ? ttsRows() : engines.filter((e) => e.stage === "tts"))
      ],
      resources: { status: resources.status, rebuild: syncResources({ rebuild: true }), voices: voiceInfos },
      explainProblems,
      blocked: settingsProblem
    })
    const theEngine = engine

    // Model downloads (jobs) and settings from outside the UI.
    const jobs = makeJobs({ onChange: (job) => broadcast({ type: "job", job }) })
    yield* Effect.addFinalizer(() => Effect.sync(() => jobs.cancelAll()))
    const models: Models = makeModels({
      jobs,
      dirs: sections.modelDirs,
      inUse: () => presetsInUse(theEngine.status().engines),
      onChange: () => {
        sections.announceAll()
        broadcast({ type: "models", models: models.list() })
      },
      ...(options.modelDownloaders !== undefined ? { downloaders: options.modelDownloaders } : {}),
      ...(options.freeBytes !== undefined ? { freeBytes: options.freeBytes } : {})
    })
    // Partial downloads of an earlier run (it was stopped mid-download) are removed before anything starts.
    for (const dir of new Set([sections.modelDirs().stt, sections.modelDirs().tts])) {
      const removed = yield* Effect.promise(() => SherpaStt.cleanPartials(dir))
      if (removed.length > 0) yield* Effect.logInfo(`Removed ${removed.length} partial download(s) in ${dir}`)
    }
    yield* Effect.promise(() => models.refresh())
    modelsRef = models
    const envMover = makeEnvMover({ view: envView, catalog, sections, host, store, vaultState: keys.state, onMoved: () => {} })

    const adminPassword = options.adminPassword ?? env.PVA_ADMIN_PASSWORD
    const adminProblem = adminPasswordProblem(adminPassword)
    if (adminProblem !== undefined) yield* Effect.logWarning(adminProblem)
    const admin = makeAdminSessions({
      password: adminPassword,
      ...(options.adminIdleMs !== undefined ? { idleMs: options.adminIdleMs } : {}),
      ...(options.adminMaxMs !== undefined ? { maxMs: options.adminMaxMs } : {}),
      ...(options.adminNow !== undefined ? { now: options.adminNow } : {})
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => admin.dispose()))
    const devices = makeDeviceRegistry({ store })

    // TypeSafe routing (docs/ASSISTANTS.md §3.6): the shared `routing` section, read at each decision (live).
    const routing = makeRoutingService(() => ({
      enabled: sections.value(ROUTING_KEYS.enabled) === true,
      apiKey: settingNow(ROUTING_KEYS.apiKey),
      model: settingNow(ROUTING_KEYS.model),
      baseUrl: settingNow(ROUTING_KEYS.baseUrl)
    }), options.routingFetch !== undefined ? { fetch: options.routingFetch } : {})

    // One voice session per device (docs/VOICE-SESSIONS.md §2), on the shared engines.
    const recordings = join(options.dataDir, "recordings")
    const sessions: VoiceSessions = makeVoiceSessions({
      make: (key, device, reserved) =>
        makeVoiceSession({
          key,
          ...(device !== undefined ? { deviceId: device.id } : {}),
          name: () => (device === undefined ? "Voice page without a device" : devices.nameOf(device.id) ?? device.name),
          engine: theEngine,
          deviceSettings: () => deviceSettingsOf(device?.id),
          hearing: hearingOf(device?.id),
          ...(options.hearerSwitchWaitMs !== undefined ? { hearerSwitchWaitMs: options.hearerSwitchWaitMs } : {}),
          assistants: assistantsNow,
          conversationSetup,
          voiceOf: resources.ttsKeyFor,
          moduleOfTool: (name) => host.snapshot().toolModules.get(name) ?? null,
          routing: () => routing,
          turnTrace,
          send: (message) => hub?.toSession(key, message),
          wakeHeard: (text, phrase, accepted) => hub?.wakeHeard(key, text, phrase, accepted),
          onChange: (minor) => hub?.sessionsChanged(minor),
          onTrace: (trace) => {
            sessions.addTrace(trace)
            // Admin's Diagnostics › Latency grows live (admin connections get no `turn.*`; ADMIN_ONLY).
            hub?.broadcast({ type: "trace", key, ...(device !== undefined ? { deviceId: device.id } : {}), trace })
          },
          minuteMs,
          ...(reserved !== undefined ? { reservedConversations: reserved } : {}),
          ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
          heard: {
            dir: recordings,
            enabled: () => sections.value("RECORD_HEARD_AUDIO") === true,
            maxFiles: () => Number(sections.value("RECORD_HEARD_AUDIO_MAX_FILES") ?? 50),
            model: hearingModelOf(device?.id),
            writable: () => lock.held(),
            begin: lock.begin,
            lostOnTheWay: () => hub?.micFramesLost(key) ?? 0,
            log: (line) => runFork(Effect.logInfo(line))
          },
          log: (line) => runFork(Effect.logWarning(line))
        }),
      max: () => Number(sections.value("MAX_VOICE_SESSIONS") ?? DEFAULT_MAX_VOICE_SESSIONS),
      discardMs: () => Number(sections.value("SESSION_DISCARD_MINUTES") ?? DEFAULT_SESSION_DISCARD_MINUTES) * minuteMs,
      runSync,
      run,
      onChange: (minor) => hub?.sessionsChanged(minor),
      onDiscard: (key) => hub?.sessionDiscarded(key),
      announce: (key, info, assistant) =>
        hub?.toSession(key, { type: "conversation", id: info.id, reason: "new", startedAt: info.startedAt, ...(assistant !== undefined ? { assistantId: assistant } : {}) })
    })
    sessionsRef = sessions
    // Before the lock is released and the engines close (finalizers run in reverse): every session's loop stops, and
    // no recording write or rotation happens after it.
    yield* Effect.addFinalizer(() => sessions.closeAll)

    const assistants = makeAssistants({
      store,
      sessions,
      modules: () => host.modules(),
      checkOwn: host.checkOwn,
      engineState: () => theEngine.status().state,
      hearingProblems,
      llmProblems,
      speechMemoryWarning,
      // TypeSafe is set up: the routing section is switched on, with a key and a valid address (WP-14).
      canAuto: routing.ready
    })
    hub = makeSessionHub({
      admin,
      devices,
      assistants,
      env: envMover,
      models,
      jobs,
      engine: theEngine,
      host,
      sections,
      sessions,
      run,
      server: { name: "personal-voice-assistance", version: "0.0.0" },
      keys,
      access,
      onSectionSaved: (sectionId, needsReload, path) => {
        if (needsReload) theEngine.setReloadPending(true, path)
        // Home moves the modules' linked defaults (read once the section's new values are in effect).
        if (sectionId === "home") run(syncModules())
        // `canAuto` (the voice pages' `device.setup`) follows the routing section (WP-14).
        if (sectionId === "routing") hubNow.refreshDevices()
      },
      ...(options.helloTimeoutMs !== undefined ? { helloTimeoutMs: options.helloTimeoutMs } : {})
    })
    const hubNow = hub
    host.subscribe((module) => {
      hubNow.broadcast({ type: "module.changed", module: access.module(module) })
      if (module.id === SUBSCRIPTION_AGENT_ID && theEngine.status().engines.some((e) => e.provider === SUBSCRIPTION_PROVIDER)) theEngine.refreshStatus()
    })
    sections.subscribe((section) => hubNow.broadcast({ type: "section.changed", section: access.section(section) }))
    keys.subscribe((state) => {
      hubNow.vaultChanged()
      sections.announceAll()
      // The TypeSafe key may have come or gone with the vault: `canAuto` follows (WP-14).
      hubNow.refreshDevices()
      // Engines that failed (a key was locked away) are rebuilt once the keys are there.
      if (state === "unlocked" && theEngine.status().state === "failed") {
        run(Effect.flatMap(theEngine.reload, (r) => (r.ok ? Effect.logInfo("Engines reloaded after the keys were unlocked.") : Effect.void)))
      }
      // Language models whose key was locked away (or changed) are built again; the others keep running.
      run(syncResources({ retryFailed: state === "unlocked" }))
    })

    // The voice picker's API (docs/VOICE-PROVIDERS.md §5): providers, voices, previews, downloads, favourites.
    const favourites = makeFavourites({ dataDir: options.dataDir, writable: () => lock.held(), log: (line) => runFork(Effect.logWarning(line)) })
    let catalogRef: VoiceCatalog | undefined
    const assistantVoice = makeAssistantVoice({
      assistants: () => [...assistantsNow().values()],
      catalog: () => catalogRef!,
      isRunning: (key) => resources.tts(key) !== undefined
    })
    const inTurn = new Set(["hearing", "thinking", "speaking"])
    const voiceCatalog = yield* makeVoiceCatalog({
      configProvider: sections.configProvider,
      vaultLocked: () => keys.state() === "locked",
      modelDir: () => sections.modelDirs().tts,
      live: (voice) => resources.tts(voiceKey(voice)),
      busy: () => sessions.list().some((s) => inTurn.has(s.state)),
      usedBy: assistantVoice.usedBy,
      isFavourite: favourites.has,
      // Every voice of a shared archive (Kokoro) reports the one job that downloads it.
      download: (preset) => jobs.running("tts-models", SherpaTts.archiveOwner(preset) ?? preset),
      ...(options.hostedVoices !== undefined ? { hostedVoices: options.hostedVoices } : {}),
      ...(options.localPreviewEngine !== undefined ? { localEngine: options.localPreviewEngine } : {})
    })
    catalogRef = voiceCatalog
    // The model pickers' API (docs/MODEL-PICKERS.md §4): language models per account, recogniser models, favourites.
    const modelFavourites = {
      llm: makeModelFavourites({ dataDir: options.dataDir, kind: "llm", writable: () => lock.held(), log: (line) => runFork(Effect.logWarning(line)) }),
      stt: makeModelFavourites({ dataDir: options.dataDir, kind: "stt", writable: () => lock.held(), log: (line) => runFork(Effect.logWarning(line)) })
    } as const
    const modelCatalog = makeModelCatalog({
      configProvider: sections.configProvider,
      vaultLocked: () => keys.state() === "locked",
      assistants: () => [...assistantsNow().values()],
      subscription: () => {
        const m = host.modules().find((x) => x.id === SUBSCRIPTION_AGENT_ID)
        const models = m?.state === "running" ? host.settingOptions(SUBSCRIPTION_AGENT_ID)?.model : undefined
        return { state: m?.state ?? "missing", enabled: m?.enabled ?? false, ...(models !== undefined ? { models } : {}) }
      },
      sttItems: () => models.list().find((set) => set.tool === "stt-models")?.items ?? [],
      sttDownload: (preset) => jobs.running("stt-models", preset),
      isFavourite: (kind, ref) => modelFavourites[kind].has(ref),
      ...(options.modelListTimeoutMs !== undefined ? { listTimeoutMs: options.modelListTimeoutMs } : {}),
      ...(options.modelCatalogNow !== undefined ? { now: options.modelCatalogNow } : {})
    })
    const api = makeApi({
      admin,
      catalog: voiceCatalog,
      favourites,
      jobs,
      models,
      assistantVoice,
      modelCatalog,
      modelFavourites,
      services,
      allowedOrigins: options.allowedOrigins,
      scheme: options.tls === undefined ? "http" : "https"
    })

    const http = yield* startHttp({
      host: options.host,
      port: options.port,
      webDir: options.webDir,
      allowedOrigins: options.allowedOrigins,
      allowedHosts: options.allowedHosts ?? [],
      tls: options.tls,
      crossOriginIsolation: options.crossOriginIsolation ?? true,
      hub: hubNow,
      api,
      ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {})
    })

    /**
     * Runs `operation` (a module or engine operation) until it is not refused as `busy`: another operation on the
     * same module (or an engine rebuild) is still running, and this one comes after it. Polled every
     * `IDLE_POLL_MS` while `wanted()` still holds, at most `IDLE_WAIT_MS`; any other failure is logged.
     */
    const whenIdle = (what: string, wanted: () => boolean, operation: Effect.Effect<HostResult>): Effect.Effect<void> =>
      Effect.gen(function*() {
        const deadline = Date.now() + IDLE_WAIT_MS
        while (wanted()) {
          const result = yield* operation
          if (result.ok) return
          if (result.error.code !== "busy") return yield* Effect.logWarning(`Could not start ${what}: ${result.error.message}`)
          if (Date.now() >= deadline) {
            return yield* Effect.logWarning(`Could not start ${what}: it was still busy after ${IDLE_WAIT_MS / 1000} s (${result.error.message})`)
          }
          yield* Effect.sleep(IDLE_POLL_MS)
        }
      })
    /** Brings the running modules in line with the enabled set: starts every enabled module that is not running. */
    const reconcileModules = Effect.suspend(() =>
      Effect.forEach(
        // Capabilities are started by the assistants' demand (`startEnabled`, `refresh`), not by their switch.
        host.modules().filter((m) => m.enabled && m.state === "disabled" && !isCapability(m.id)).map((m) => m.id),
        (id) => {
          // Still enabled and still not started (the owner may have disabled or started it meanwhile).
          const waiting = () => host.modules().some((m) => m.id === id && m.enabled && m.state === "disabled")
          return whenIdle(`module ${id}`, waiting, host.enable(id))
        },
        { concurrency: "unbounded", discard: true }
      )
    )

    // Modules and engines start in parallel; neither waits for the other. While the settings may come from two
    // saves, the engine start only reports why (see `settingsProblem`) and no module starts, until a save.
    const blockedAtStart = store.blocked() !== undefined
    // `startEnabled` skips a module another operation holds (a request from a page that connected first); the
    // reconcile after it starts that one once the operation has finished.
    const modulesStarted = yield* Effect.forkScoped(blockedAtStart ? Effect.void : Effect.andThen(host.startEnabled, reconcileModules))
    const engineStarted = yield* Effect.forkScoped(theEngine.start)
    // Every wanted language model is built (and warmed) alongside the engines, before the first turn (§3.2).
    const resourcesStarted = yield* Effect.forkScoped(syncResources())
    if (blockedAtStart) {
      // Called from inside the save, which may be a module operation that still holds that module's guard: the
      // module is started once that operation has finished (`whenIdle`), not refused as `busy` and forgotten.
      store.onUnblocked(() =>
        run(Effect.gen(function*() {
          yield* Effect.logInfo("The settings were saved: starting the engines and the enabled modules.")
          // Keys left in secrets.json were not moved into the vault while the settings were blocked.
          if (keys.state() === "unlocked" && store.legacySecretCount() > 0) {
            const moved = yield* Effect.result(store.importLegacySecrets())
            if (moved._tag === "Failure") yield* Effect.logError(moved.failure.message, moved.failure.cause)
            else {
              yield* Effect.logWarning(`Moved ${moved.success} key(s) from ${options.dataDir}/secrets.json into the key vault (${vault.path}) and deleted that file.`)
              yield* host.setSecrets(store.secrets().modules)
            }
          }
          yield* Effect.all([
            // `startIfStopped`: after waiting out a `busy` (a reload the owner sent meanwhile), the engines
            // that reload brought up must not be rebuilt.
            whenIdle("the engines", () => true, theEngine.startIfStopped),
            Effect.andThen(syncModules(), reconcileModules),
            syncResources()
          ], { concurrency: 3, discard: true })
        }))
      )
    }
    const ready = Effect.asVoid(Effect.all([Fiber.await(modulesStarted), Fiber.await(engineStarted), Fiber.await(resourcesStarted)]))

    return { http, hub: hubNow, engine: theEngine, sessions, host, keys, vault, envView, envMover, jobs, models, favourites, resources, store, ready }
  })

/**
 * `target` with every `save…`, `create…`, `delete…` and `import…` method followed, on success, by `after` (the
 * settings store: the resource pool reconciles after each save).
 */
const notifyAfterSaves = <S extends object>(target: S, after: () => void): S => {
  const out = { ...target } as Record<string, unknown>
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== "function" || !/^(save|create|delete|import)/.test(name)) continue
    const method = value as (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
    out[name] = (...args: Array<unknown>) => Effect.tap(method.apply(target, args), () => Effect.sync(after))
  }
  return out as unknown as S
}

const isLoopback = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.")

/** The serve-mode settings, read from the environment. */
export const ServeConfig = Config.all({
  host: Config.String("SERVE_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Int("SERVE_PORT").pipe(Config.withDefault(8787)),
  allowedOrigins: Config.String("SERVE_ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000,http://127.0.0.1:3000"),
    Config.map((s) => s.split(",").map((o) => o.trim()).filter((o) => o.length > 0))
  ),
  allowedHosts: Config.String("SERVE_ALLOWED_HOSTS").pipe(
    Config.withDefault(""),
    Config.map((s) => s.split(",").map((h) => h.trim()).filter((h) => h.length > 0))
  ),
  // Off only to rule it out when the page fails to load on some browser (see the README).
  crossOriginIsolation: Config.Boolean("SERVE_CROSS_ORIGIN_ISOLATION").pipe(Config.withDefault(true)),
  tlsCert: Config.option(Config.String("SERVE_TLS_CERT")),
  tlsKey: Config.option(Config.String("SERVE_TLS_KEY")),
  webDir: Config.String("PVA_WEB_DIR").pipe(
    Config.withDefault(join(repoRoot, "apps", "web", "out")),
    Config.map((p) => (isAbsolute(p) ? p : resolve(userCwd, p)))
  ),
  dataDir: DataDirConfig,
  vaultPath: VaultPathConfig
})

/** `pnpm start serve`: runs until Ctrl+C, then closes the sockets, the engines and the modules. */
export const serveMode = Effect.scoped(Effect.gen(function*() {
  const config = yield* ServeConfig
  const cert = Option.getOrUndefined(config.tlsCert)
  const key = Option.getOrUndefined(config.tlsKey)
  const tls = cert !== undefined && key !== undefined ? { certFile: resolve(userCwd, cert), keyFile: resolve(userCwd, key) } : undefined
  if ((cert === undefined) !== (key === undefined)) {
    yield* Effect.logWarning("Set both SERVE_TLS_CERT and SERVE_TLS_KEY for HTTPS; serving plain HTTP.")
  }
  // Read the vault password once and take it out of the environment, so the engine processes forked later
  // (and anything else that inherits process.env) never see it.
  const vaultPassword = process.env.PVA_VAULT_PASSWORD
  delete process.env.PVA_VAULT_PASSWORD
  processEnvView.redact("PVA_VAULT_PASSWORD")
  // The admin password likewise: read once, then gone from the environment and the env view.
  const adminPassword = process.env.PVA_ADMIN_PASSWORD
  delete process.env.PVA_ADMIN_PASSWORD
  processEnvView.redact("PVA_ADMIN_PASSWORD")
  // Tests only (the real-browser e2e): what one minute of conversationIdleMinutes / SESSION_DISCARD_MINUTES is, in ms.
  const testMinuteMs = Number(process.env.PVA_TEST_MINUTE_MS ?? "")
  const minuteMs = Number.isInteger(testMinuteMs) && testMinuteMs >= 100 ? testMinuteMs : undefined
  if (minuteMs !== undefined) yield* Effect.logWarning(`PVA_TEST_MINUTE_MS: a minute of the idle and discard settings is ${minuteMs} ms (tests only).`)
  const handle = yield* startServe({
    ...config,
    tls,
    ...(minuteMs !== undefined ? { minuteMs } : {}),
    ...(vaultPassword !== undefined && vaultPassword !== "" ? { vaultPassword } : {}),
    // Always passed (also when unset), so the env view's copy is never consulted.
    adminPassword: adminPassword ?? ""
  })
  yield* Effect.logInfo(`Assistant UI at ${handle.http.url}  (settings in ${config.dataDir}, keys in ${config.vaultPath})`)
  if (!webDirExists(config.webDir)) {
    yield* Effect.logWarning(`The web UI is not built (${config.webDir} is missing): run pnpm --filter @pva/web build`)
  }
  if (!isLoopback(config.host)) {
    yield* Effect.logWarning(
      `Listening on ${config.host}: anyone who can reach this port can talk to the assistant; changing anything needs the ` +
        "admin password (PVA_ADMIN_PASSWORD) on /admin/."
    )
  }
  if (tls === undefined && !isLoopback(config.host)) {
    yield* Effect.logWarning("Browsers only allow the microphone on https:// or localhost; use an SSH tunnel or SERVE_TLS_CERT/SERVE_TLS_KEY (see the README).")
  }
  yield* handle.ready
  const status = handle.engine.status()
  if (status.state === "ready") yield* Effect.logInfo("Engines ready. Open the page and press Start.")
  if (status.engines.some((e) => e.stage === "llm" && e.provider === "fake")) {
    yield* Effect.logWarning(
      "LLM_PROVIDER=fake: replies are canned echoes. For real answers open Settings → Language model → Provider and choose " +
        "Anthropic (with an API key) or Claude subscription (your own Claude login, behind an opt-in)."
    )
  }
  yield* Effect.never
}).pipe(Effect.onInterrupt(() => Effect.logInfo("Stopping: closing connections, engines and modules."))))
