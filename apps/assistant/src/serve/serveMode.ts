import { makeWebAudio, type WebAudio } from "@pva/audio-web"
import {
  type ConversationEvent,
  type HostResult,
  ECHO_TAIL_MS,
  makeEchoGate,
  makeModuleHost,
  makeTurnTrace,
  type ModuleDefinition,
  type ModuleHost,
  type SttEvent,
  type TurnSetup,
  type TurnTrace,
  voicePrompt
} from "@pva/core"
import type { ServerMessage } from "@pva/protocol"
import { Config, Effect, Fiber, FiberSet, Option, type Scope, Stream } from "effect"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultSystemPrompt } from "../config.ts"
import { envView as processEnvView, userCwd } from "../env.ts"
import { type EnvView, makeEnvView } from "../envView.ts"
import { moduleCatalog, withModuleInstructions } from "../modules.ts"
import { makeSubscriptionAgents, SUBSCRIPTION_AGENT_ID, SUBSCRIPTION_PROVIDER } from "../subscription.ts"
import { makeAccessPolicy } from "./access.ts"
import { acquireDataDirLock, type DataDirLockError } from "./DataDirLock.ts"
import { defaultPreflight, defaultProviderBuilder, type Engine, EngineBuildProblems, makeEngine, type ProviderBuilder } from "./Engine.ts"
import { type EnvMover, makeEnvMover } from "./envSettings.ts"
import { type HttpError, type HttpServer, startHttp, webDirExists } from "./http.ts"
import { type Jobs, makeJobs } from "./jobs.ts"
import { makeModels, type Models, type PresetDownloader, presetsInUse } from "./models.ts"
import { makeHeardAudio } from "./HeardAudio.ts"
import { type Keys, makeKeys } from "./Keys.ts"
import { makePublisher } from "./Publisher.ts"
import { makeSections } from "./sections.ts"
import { makeSessionHub, type SessionHub } from "./SessionHub.ts"
import { DataDirConfig, KEYS_LOCKED_MESSAGE, loadSettingsStore, SettingsStoreError } from "./SettingsStore.ts"
import { makeStateTracker } from "./StateTracker.ts"
import { type KdfParams, openVault, type Vault, VaultPathConfig } from "./Vault.ts"
import * as SherpaStt from "@pva/stt-sherpa"
import type { ToolId } from "@pva/protocol"

/**
 * `serve` mode (docs/UI-AND-MODULES.md §4): one process, one port. The browser
 * is the microphone, speaker and control surface; the module host, the
 * settings and the engines live here.
 *
 * Startup order: HTTP first (so the UI loads and shows "starting"), then the
 * module host and the engine build in parallel. The voice loop runs over the
 * web audio input; when nobody owns the audio, that input is a noise floor.
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
  /** Admin access ends after this long without an admin action. Default 15 minutes. */
  readonly adminIdleMs?: number
  /** Unlock the vault at start with this (`PVA_VAULT_PASSWORD`). Default: `env.PVA_VAULT_PASSWORD`. Never grants admin access. */
  readonly vaultPassword?: string
  readonly catalog?: ReadonlyArray<ModuleDefinition<any>>
  /** Engine providers (tests inject fakes). Default: the providers chosen by the settings. */
  readonly build?: ProviderBuilder
  /** Checks before a reload stops the running engines. Default: `defaultPreflight` with the default builder, none otherwise. */
  readonly preflight?: Effect.Effect<void, EngineBuildProblems>
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
  readonly turnTrace?: TurnTrace["Service"]
  /** Playback stall limit (tests shorten it). Default 2000 ms. */
  readonly stallMs?: number
  readonly helloTimeoutMs?: number
  readonly pingIntervalMs?: number
}

export interface ServeHandle {
  readonly http: HttpServer
  readonly hub: SessionHub
  readonly engine: Engine
  readonly host: ModuleHost
  readonly web: WebAudio
  readonly keys: Keys
  readonly vault: Vault
  readonly envView: EnvView
  readonly envMover: EnvMover
  readonly jobs: Jobs
  readonly models: Models
  /** Completes when the first engine build and module start have settled. */
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
    const store = yield* loadSettingsStore(options.dataDir, { lock, vault })
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
    const host = yield* makeModuleHost({ catalog, persistence: store.modulePersistence, env, envOrigin, envLocation })
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
    const now = () => performance.now()

    // Late-bound: the hub needs the engine and the engine's callbacks need the hub.
    let hub: SessionHub | undefined
    let engine: Engine | undefined
    let modelsRef: Models | undefined
    const broadcast = (message: ServerMessage) => hub?.broadcast(message)

    const gate = makeEchoGate("instant")
    const tracker = makeStateTracker({ onChange: (s) => broadcast({ type: "state", ...s }) })
    yield* Effect.addFinalizer(() => Effect.sync(() => tracker.dispose()))
    const publisher = makePublisher({
      broadcast,
      onCommitted: (turnId) => tracker.turnPromoted(turnId),
      moduleOfTool: (name) => host.snapshot().toolModules.get(name) ?? null,
      voices: () => {
        const v = engine?.voices()
        return { defaultVoice: v?.defaultVoice ?? String(sections.value("DEFAULT_VOICE")), names: new Set(v?.names.map((x) => x.name) ?? []) }
      }
    })

    // Manual interrupt mode: the microphone is replaced by silence while the assistant is audible (plus the reverb tail).
    let unsuppress: ReturnType<typeof setTimeout> | undefined
    const web: WebAudio = yield* makeWebAudio({
      ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      log: (line) => runFork(Effect.logWarning(line)),
      onPlayback: (event) => {
        if (event._tag === "started") {
          tracker.playbackStarted(event.turnId)
          gate.playbackStarted(now())
          if (unsuppress !== undefined) clearTimeout(unsuppress)
          if (hub?.ownerMode() === "manual") web.setSuppressed(true)
        } else {
          tracker.playbackEnded(event.turnId, event.reason)
          gate.playbackEnded(now())
          unsuppress = setTimeout(() => web.setSuppressed(false), ECHO_TAIL_MS)
          unsuppress.unref?.()
        }
      },
      onStall: (turnId) =>
        broadcast({
          type: "error",
          error: { code: "playback_timeout", message: "The browser stopped reporting playback, so the reply was stopped", turnId }
        })
    })

    // Clause texts per turn, so the echo gate knows the words that just played.
    const clauses = new Map<number, { texts: Array<string>; given: number }>()
    const onEvent = (event: ConversationEvent) => {
      publisher.onEvent(event)
      switch (event._tag) {
        case "TurnStarted":
          // Committed turns reach the tracker through the publisher's onCommitted, right after turn.start.
          if (event.speculative) tracker.turnStarted(event.turnId, true)
          return
        case "TurnEnded":
          clauses.delete(event.turnId)
          return tracker.turnEnded(event.turnId)
        case "ClauseQueued": {
          const entry = clauses.get(event.turnId) ?? { texts: [], given: 0 }
          entry.texts[event.index] = event.text
          clauses.set(event.turnId, entry)
          return
        }
        case "ClausePlaying": {
          const entry = clauses.get(event.turnId)
          if (entry === undefined) return
          for (; entry.given <= event.index; entry.given++) gate.clausePlayed(entry.texts[entry.given] ?? "", now())
          return
        }
        default:
          return
      }
    }

    // "What does the assistant hear" (RECORD_HEARD_AUDIO): taps the recogniser's input and events.
    let lastInput = web.inputStats()
    let lastLost = 0
    const heard = makeHeardAudio({
      dir: join(options.dataDir, "recordings"),
      enabled: () => sections.value("RECORD_HEARD_AUDIO") === true,
      maxFiles: () => Number(sections.value("RECORD_HEARD_AUDIO_MAX_FILES") ?? 50),
      model: () => {
        const stt = engine?.status().engines.find((e) => e.stage === "stt")
        return stt === undefined ? "unknown" : `${stt.provider} ${stt.detail}`
      },
      // Counters since the previous recording.
      transport: () => {
        const current = web.inputStats()
        const delta = {
          micFrames: current.micFrames - lastInput.micFrames,
          droppedFrames: current.droppedFrames - lastInput.droppedFrames,
          noiseFrames: current.noiseFrames - lastInput.noiseFrames,
          unroutedMicFrames: current.unroutedMicFrames - lastInput.unroutedMicFrames,
          lostOnTheWay: (hub?.micFramesLost() ?? 0) - lastLost,
          maxMicGapMs: current.maxMicGapMs
        }
        lastInput = current
        lastLost = hub?.micFramesLost() ?? 0
        return delta
      },
      log: (line) => runFork(Effect.logInfo(line)),
      writable: () => lock.held(),
      begin: lock.begin
    })
    // Before the lock is released (finalizers run in reverse): no recording write or rotation after it.
    yield* Effect.addFinalizer(() => Effect.promise(() => heard.close()))
    const input = { stream: web.input.stream.pipe(Stream.tap((chunk) => Effect.sync(() => heard.audio(chunk)))) }

    let lastTranscript = ""
    const transcript = (text: string) => {
      if (text === lastTranscript) return
      lastTranscript = text
      broadcast({ type: "transcript", text })
    }
    const gateStream = (events: Stream.Stream<SttEvent, unknown>) =>
      events.pipe(Stream.flatMap((event) => {
        heard.event(event)
        const result = gate.filter(event, now())
        for (const passed of result.events) {
          tracker.stt(passed)
          if (passed._tag === "Interim") transcript(passed.text)
          else if (passed._tag === "EndOfTurn") transcript("")
        }
        if (result.dropped) transcript("")
        return Stream.fromIterable(result.events)
      }))

    // The turn setup is rebuilt only when its inputs change (a string compare per turn).
    let cached: { key: string; setup: TurnSetup } | undefined
    const voiceBlock = () => {
      const voices = engine?.voices()
      return voices === undefined ? "" : voicePrompt(voices.names, voices.defaultVoice)
    }
    /** Base prompt + running modules' instructions + voice block. */
    const systemFor = (base: string, instructions: ReadonlyArray<string>, voices: string) => {
      const system = withModuleInstructions(base, instructions)
      return voices.length === 0 ? system : `${system}\n\n${voices}`
    }
    const setup = Effect.sync((): TurnSetup => {
      const snapshot = host.snapshot()
      const base = String(sections.value("SYSTEM_PROMPT") ?? defaultSystemPrompt)
      const voices = voiceBlock()
      const key = `${snapshot.version}\u0000${base}\u0000${voices}`
      if (cached?.key !== key) {
        cached = { key, setup: { system: systemFor(base, snapshot.instructions, voices), registry: snapshot.registry } }
      }
      return cached.setup
    })

    // LLM_PROVIDER=claude-subscription: an agent conversation whose agent is the running claude-subscription module.
    const subscriptionModule = () => host.modules().find((m) => m.id === SUBSCRIPTION_AGENT_ID)
    const subscriptionDetail = () => {
      const m = subscriptionModule()
      const model = String(m?.settings.values.model ?? "claude-haiku-5-5")
      if (m?.state === "running") return model
      return `${model} · module ${m === undefined || !m.enabled ? "off" : m.state}: the offline stand-in answers`
    }
    const secretNames = () =>
      sections.list().flatMap((x) => x.form.fields).flatMap((f) => (f.type === "secret" && f.env !== undefined ? [f.env] : []))

    engine = yield* makeEngine({
      build: options.build ?? defaultProviderBuilder,
      ...(options.preflight !== undefined
        ? { preflight: options.preflight }
        : options.build === undefined
        ? { preflight: defaultPreflight }
        : {}),
      configProvider: sections.configProvider,
      input,
      output: web.output,
      turnTrace,
      setup,
      onEvent,
      gate: gateStream,
      defaultVoice: () => String(sections.value("DEFAULT_VOICE")),
      onStatus: (status) => {
        broadcast({ type: "engine", engine: status })
        // Which models are in use follows the running engines.
        if (hub !== undefined) broadcast({ type: "models", models: modelsRef?.list() ?? [] })
      },
      agentSetup: (providers) => {
        if (providers.llmProvider !== SUBSCRIPTION_PROVIDER) return undefined
        const toAgents = makeSubscriptionAgents({
          fallbackLlm: providers.llm,
          agents: () => host.snapshot().agents,
          module: subscriptionModule,
          promptFor: (agent, turn) =>
            agent.systemPrompt === undefined ? turn.system : systemFor(agent.systemPrompt, host.snapshot().instructions, voiceBlock())
        })
        return Effect.map(setup, toAgents)
      },
      describeEngines: (engines) =>
        engines.map((e) => (e.stage === "llm" && e.provider === SUBSCRIPTION_PROVIDER ? { ...e, detail: subscriptionDetail(), location: "hosted" } : e)),
      // While the vault is locked, a key that "is not set" is really locked away.
      explainProblems: (problems) => {
        if (keys.state() !== "locked") return problems
        const names = secretNames()
        return problems.map((p) => {
          const missing = /^([A-Z][A-Z0-9_]*) is not set$/.exec(p.message)?.[1]
          return missing !== undefined && names.some((n) => missing.endsWith(n)) ? { ...p, message: KEYS_LOCKED_MESSAGE } : p
        })
      },
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

    hub = makeSessionHub({
      env: envMover,
      models,
      jobs,
      web,
      engine: theEngine,
      host,
      sections,
      publisher,
      tracker,
      gate,
      run,
      server: { name: "personal-voice-assistance", version: "0.0.0" },
      keys,
      access,
      ...(options.adminIdleMs !== undefined ? { adminIdleMs: options.adminIdleMs } : {}),
      onSectionSaved: (sectionId, needsReload, path) => {
        if (needsReload) theEngine.setReloadPending(true, path)
        if (sectionId === "voices") {
          const wanted = String(sections.value("DEFAULT_VOICE"))
          const running = theEngine.voices()
          if (running !== undefined && !running.names.some((v) => v.name === wanted)) theEngine.setReloadPending(true, path)
        }
      },
      ...(options.helloTimeoutMs !== undefined ? { helloTimeoutMs: options.helloTimeoutMs } : {})
    })
    const theHub = hub
    host.subscribe((module) => {
      theHub.broadcast({ type: "module.changed", module: access.module(module) })
      if (module.id === SUBSCRIPTION_AGENT_ID && theEngine.status().engines.some((e) => e.provider === SUBSCRIPTION_PROVIDER)) theEngine.refreshStatus()
    })
    sections.subscribe((section) => theHub.broadcast({ type: "section.changed", section: access.section(section) }))
    keys.subscribe((state) => {
      theHub.vaultChanged()
      sections.announceAll()
      // Engines that failed (a key was locked away) are rebuilt once the keys are there.
      if (state === "unlocked" && theEngine.status().state === "failed") {
        run(Effect.flatMap(theEngine.reload, (r) => (r.ok ? Effect.logInfo("Engines reloaded after the keys were unlocked.") : Effect.void)))
      }
    })

    const http = yield* startHttp({
      host: options.host,
      port: options.port,
      webDir: options.webDir,
      allowedOrigins: options.allowedOrigins,
      allowedHosts: options.allowedHosts ?? [],
      tls: options.tls,
      crossOriginIsolation: options.crossOriginIsolation ?? true,
      hub: theHub,
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
        host.modules().filter((m) => m.enabled && m.state === "disabled").map((m) => m.id),
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
            reconcileModules
          ], { concurrency: 2, discard: true })
        }))
      )
    }
    const ready = Effect.asVoid(Effect.all([Fiber.await(modulesStarted), Fiber.await(engineStarted)]))

    return { http, hub: theHub, engine: theEngine, host, web, keys, vault, envView, envMover, jobs, models, ready }
  })

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
  const handle = yield* startServe({ ...config, tls, ...(vaultPassword !== undefined && vaultPassword !== "" ? { vaultPassword } : {}) })
  yield* Effect.logInfo(`Assistant UI at ${handle.http.url}  (settings in ${config.dataDir}, keys in ${config.vaultPath})`)
  if (!webDirExists(config.webDir)) {
    yield* Effect.logWarning(`The web UI is not built (${config.webDir} is missing): run pnpm --filter @pva/web build`)
  }
  if (!isLoopback(config.host)) {
    yield* Effect.logWarning(
      `Listening on ${config.host}: anyone who can reach this port can use the assistant and change its open settings (there is no login; ` +
        "keys, providers and agents need the vault password once one is set)."
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
