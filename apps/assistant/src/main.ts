import "./env.ts" // first: loads .env before anything reads the environment
import { NodeRuntime } from "@effect/platform-node"
import {
  Conversation,
  Llm,
  type RouteConfig,
  routeConfigFromWake,
  Stt,
  SttError,
  ToolRegistry,
  TurnTrace,
  type WakeConfig,
  wakeConfigFromProfile
} from "@pva/core"
import { DEFAULT_DEVICE_PROFILE } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { Cause, Config, Effect, Layer, Logger, Stream } from "effect"
import { resolve } from "node:path"
import * as readline from "node:readline"
import { collectWavs, parseLiveArgs, runLiveSessions } from "./bench/live.ts"
import { makeBenchWavs } from "./bench/makeWavs.ts"
import { runOffline, runOfflineSessions, type SimulatedDelays, zeroDelays } from "./bench/offline.ts"
import { formatReport } from "./bench/report.ts"
import { formatLive, parseTypesafeLiveArgs, runTypesafeLive, typesafeScenarios } from "./bench/typesafe.ts"
import { AppConfig } from "./config.ts"
import { userCwd } from "./env.ts"
import { moduleCatalog, startCliModules, withModuleInstructions } from "./modules.ts"
import { FakeLlm } from "./FakeLlm.ts"
import { LlmLayer, SttLayer } from "./providers.ts"
import { sayCommand } from "./say.ts"
import { DataDirLockError } from "./serve/DataDirLock.ts"
import { serveMode } from "./serve/serveMode.ts"
import { DataDirConfig, SettingsStoreError } from "./serve/SettingsStore.ts"
import { VaultPathConfig } from "./serve/Vault.ts"
import { askVaultPassword, type CliSettings, CliSettingsRef, explainMissingKey, withCliSettings } from "./cliSettings.ts"
import { makeSubscriptionAgents, SUBSCRIPTION_AGENT_ID, SUBSCRIPTION_PROVIDER } from "./subscription.ts"
import { buildProviders, describeConfigError, StartupError } from "./startup.ts"
import { runTextTurns } from "./text.ts"
import { compareModelsCommand } from "./compareModels.ts"
import { doctorCommand } from "./doctor.ts"
import { transcribeCommand } from "./transcribe.ts"
import { voiceMode } from "./voice.ts"
import { assistantVoiceStage, withVoiceTrace } from "./voiceSelection.ts"

/** Whether stdout's last write did not end a line (so a log line must start a new one). */
let midLine = false
const writeOut = (text: string) => {
  process.stdout.write(text)
  midLine = !text.endsWith("\n")
}

/** Log lines (including the per-turn latency line) go to stderr as plain text, keeping stdout for replies. */
const StderrLogger = Logger.layer([
  Logger.make(({ cause, logLevel, message }) => {
    const text = Array.isArray(message) ? message.join(" ") : String(message)
    const prefix = midLine ? "\n" : ""
    const level = logLevel === "Warn" ? "warning: " : logLevel === "Error" ? "error: " : ""
    midLine = false
    process.stderr.write(`${prefix}${level}${text}${cause.reasons.length > 0 ? `\n${Cause.pretty(cause)}` : ""}\n`)
  })
])

// Text mode uses the same system prompt as voice mode, so the model behaves the same.
// LLM_PROVIDER=claude-subscription: the claude-subscription agent module (switched on and opted in from the web UI,
// or with CLAUDE_SUBSCRIPTION_OPT_IN) answers; the offline stand-in answers, with a notice, when it is not running.
const ConversationLayer = Layer.unwrap(Effect.gen(function*() {
  const settings = yield* AppConfig
  const modules = yield* startCliModules()
  const systemPrompt = withModuleInstructions(settings.systemPrompt, modules.instructions)
  const llmProvider = yield* Config.String("LLM_PROVIDER").pipe(Config.withDefault("fake"))
  if (llmProvider === SUBSCRIPTION_PROVIDER) {
    const fallbackLlm = yield* Llm
    const toAgents = makeSubscriptionAgents({
      fallbackLlm,
      agents: () => modules.agents,
      module: () => modules.infos.find((m) => m.id === SUBSCRIPTION_AGENT_ID),
      promptFor: (agent, turn) =>
        agent.systemPrompt === undefined ? turn.system : withModuleInstructions(agent.systemPrompt, modules.instructions)
    })
    return Conversation.layerWithAgents({ ...settings, setup: Effect.succeed(toAgents({ system: systemPrompt, registry: modules.registry })) })
  }
  return Conversation.layer({ ...settings, systemPrompt }).pipe(Layer.provide(Layer.succeed(ToolRegistry, modules.registry)))
})).pipe(
  Layer.provide(Layer.mergeAll(LlmLayer, TurnTrace.layer()))
)

/** stdin/stdout REPL over the Conversation's text path. */
const textMode = Effect.gen(function*() {
  const interactive = process.stdin.isTTY === true
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  const prompt = () => {
    if (interactive) writeOut("> ")
  }
  prompt()
  yield* runTextTurns(Stream.fromAsyncIterable(rl, (cause) => cause), writeOut, prompt).pipe(
    Effect.ensuring(Effect.sync(() => rl.close()))
  )
}).pipe(Effect.provide(ConversationLayer))

/** Simulated delays for the offline benchmark ("realistic": hosted providers). */
const RealisticDelays: Config.Config<SimulatedDelays> = Config.all({
  llmFirstTokenMs: Config.Int("BENCH_LLM_FIRST_TOKEN_MS").pipe(Config.withDefault(250)),
  llmTokensPerSecond: Config.Finite("BENCH_LLM_TOKENS_PER_S").pipe(Config.withDefault(60)),
  ttsFirstAudioMs: Config.Int("BENCH_TTS_FIRST_AUDIO_MS").pipe(Config.withDefault(150)),
  playbackMsPerClause: Config.Int("BENCH_PLAYBACK_MS_PER_CLAUSE").pipe(Config.withDefault(200)),
  eagerLeadMs: Config.Int("BENCH_EAGER_LEAD_MS").pipe(Config.withDefault(200))
})

/** Wake-phrase mode with the default phrases, for the offline benchmark. */
const benchWake: WakeConfig = { ...wakeConfigFromProfile(DEFAULT_DEVICE_PROFILE), activation: "wake-phrase" }
/** The route gate with three assistants, each with its own phrases; the bench's utterances pick the first. */
const benchJeff = routeConfigFromWake(benchWake, "jeff")
const benchRoute: RouteConfig = {
  ...benchJeff,
  phrases: [
    ...benchJeff.phrases,
    { phrase: "hey tee three", assistant: "t3" },
    { phrase: "hey keuken", assistant: "keuken" }
  ],
  followUpMs: { jeff: benchWake.followUpMs, t3: benchWake.followUpMs, keuken: benchWake.followUpMs }
}

const offlineBench = (sessions: number) => Effect.gen(function*() {
  const rounds = yield* Config.Int("BENCH_ROUNDS").pipe(Config.withDefault(3))
  const realistic = yield* RealisticDelays
  const d = realistic
  const scenarios = [
    { name: "orchestration overhead: all simulated delays 0, eager end-of-turn off", delays: zeroDelays, eager: false },
    {
      name: `realistic, eager end-of-turn OFF (LLM 1st token ${d.llmFirstTokenMs} ms + ${d.llmTokensPerSecond} tok/s, ` +
        `TTS 1st audio ${d.ttsFirstAudioMs} ms)`,
      delays: realistic,
      eager: false
    },
    { name: `realistic, eager end-of-turn ON (EagerEndOfTurn ${d.eagerLeadMs} ms before EndOfTurn)`, delays: realistic, eager: true },
    // The wake gate in wake-phrase mode: every utterance is "Hey Jeff, …" (the gate removes the phrase).
    { name: "realistic, eager OFF, wake phrase (\"Hey Jeff, …\")", delays: realistic, eager: false, wake: benchWake, wakePrefix: "Hey Jeff, " },
    { name: "realistic, eager ON, wake phrase (\"Hey Jeff, …\")", delays: realistic, eager: true, wake: benchWake, wakePrefix: "Hey Jeff, " },
    // The same through the route gate, with two more assistants' phrases on the device (docs/ASSISTANTS.md §3.4).
    { name: "realistic, eager OFF, route gate, 3 assistants (\"Hey Jeff, …\")", delays: realistic, eager: false, route: benchRoute, wakePrefix: "Hey Jeff, " },
    { name: "realistic, eager ON, route gate, 3 assistants (\"Hey Jeff, …\")", delays: realistic, eager: true, route: benchRoute, wakePrefix: "Hey Jeff, " },
    // Serve's session path since WP-4b: route gate → session dispatcher → inbox → output lease (docs/ASSISTANTS.md §3.3).
    { name: "orchestration overhead, session path (route gate, dispatcher, output lease): all delays 0, eager off", delays: zeroDelays, eager: false, dispatch: true },
    { name: "realistic, eager ON, session path, 3 assistants (\"Hey Jeff, …\")", delays: realistic, eager: true, route: benchRoute, wakePrefix: "Hey Jeff, ", dispatch: true }
  ]
  for (const scenario of scenarios) {
    if (sessions <= 1) {
      const rows = yield* runOffline(scenario, rounds)
      yield* Effect.sync(() => console.log(formatReport(scenario.name, rows)))
      continue
    }
    // Several voice sessions at once, turn ends simultaneous: one table per session.
    const perSession = yield* runOfflineSessions(scenario, rounds, sessions)
    for (const [i, rows] of perSession.entries()) {
      yield* Effect.sync(() => console.log(formatReport(`${scenario.name} — session ${i + 1} of ${sessions}`, rows)))
    }
  }
  console.log("Times in ms relative to EndOfTurn; negative = done early by a promoted speculative turn.")
})

const bench = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const outputDir = resolve(userCwd, yield* Config.String("BENCH_OUTPUT_DIR").pipe(Config.withDefault("bench-out")))
    if (args[0] === "--make-wavs") {
      const directory = resolve(userCwd, args[1] ?? "bench-audio")
      const voice = yield* assistantVoiceStage
      const providers = yield* buildProviders([voice.stage])
      const files = yield* makeBenchWavs(directory).pipe(Effect.provide(providers))
      console.log(`Wrote ${files.length} files. Run: bench --live ${directory}`)
      return
    }
    if (args[0] === "--live") {
      const usage = "Usage: bench --live [--rounds N] [--sessions N] [--stagger MS] [--llm-per-session] [--stt-models A,B] [--load-model X] [--ambient] " +
        "<wav files or directories> (16 kHz mono)"
      const parsed = parseLiveArgs(args.slice(1))
      if (typeof parsed === "string") return yield* new StartupError({ message: `${parsed}. ${usage}` })
      const once = yield* collectWavs(parsed.paths.map((p) => resolve(userCwd, p)))
      if (once.length === 0) return yield* new StartupError({ message: usage })
      const files = Array.from({ length: parsed.rounds }, () => once).flat()
      const voice = yield* assistantVoiceStage
      // The offline stand-in LLM gets the simulated delays of the offline benchmark,
      // so a fully local run can stand in for a hosted model.
      const llmProvider = yield* Config.String("LLM_PROVIDER").pipe(Config.withDefault("fake"))
      const delays = yield* RealisticDelays
      const llm = llmProvider === "fake"
        ? FakeLlm.layerTimed({ firstTokenMs: delays.llmFirstTokenMs, tokensPerSecond: delays.llmTokensPerSecond })
        : LlmLayer
      const llmLabel = llmProvider === "fake"
        ? `fake LLM: 1st token ${delays.llmFirstTokenMs} ms, ${delays.llmTokensPerSecond} tok/s`
        : `LLM ${llmProvider}`
      // `--stt-models`: each session its own local recogniser (the pool's sharing: equal models share a worker);
      // the environment's recogniser is then not loaded.
      const ownStt = parsed.sttModels.length > 0
      const providers = yield* buildProviders([
        voice.stage,
        { stage: "language model (LLM_PROVIDER)", layer: llm },
        ownStt
          ? { stage: "speech-to-text (--stt-models)", layer: Layer.succeed(Stt, Stt.of({ transcribe: () => Stream.fail(new SttError({ message: "unused" })) })) }
          : { stage: "speech-to-text (STT_PROVIDER)", layer: SttLayer }
      ])
      const sttOptions = yield* SherpaStt.optionsConfig
      const sessionStts: Array<Stt["Service"]> = []
      for (const model of parsed.sttModels) {
        const name = SherpaStt.resolvePresetName(model)
        if (name === undefined) return yield* new StartupError({ message: `--stt-models: unknown speech model "${model}"` })
        sessionStts.push(yield* SherpaStt.make({ ...sttOptions, model: name }).pipe(Effect.mapError((e) => new StartupError({ message: e.message }))))
      }
      if (parsed.loadModel !== undefined) {
        const name = SherpaStt.resolvePresetName(parsed.loadModel)
        if (name === undefined) return yield* new StartupError({ message: `--load-model: unknown speech model "${parsed.loadModel}"` })
        yield* SherpaStt.acquire({ ...sttOptions, model: name }).pipe(Effect.mapError((e) => new StartupError({ message: e.message })))
      }
      const settings = yield* AppConfig
      // `--ambient`: every turn's context also has the household's ambient facts (read-only, as serve mode would give
      // them with HOME_AMBIENT_FACTS=all), so llmFirstToken can be compared with and without (docs/STORING-DATA.md).
      const modules = yield* startCliModules({ ambient: parsed.ambient })
      const conversation = { ...settings, systemPrompt: withModuleInstructions(settings.systemPrompt, modules.instructions) }
      const { sessions, staggerMs, llmPerSession } = parsed
      // `--llm-per-session`: one language-model instance per session (serve mode's pool with two different settings).
      const ownLlm = llmPerSession ? { llmPerSession: llm } : {}
      const perStt = ownStt ? { sttPerSession: (i: number) => sessionStts[i % sessionStts.length]! } : {}
      const perSession = yield* runLiveSessions({ files, outputDir, conversation, modules, sessions, staggerMs, ...ownLlm, ...perStt }).pipe(
        Effect.provide(withVoiceTrace(providers, voice.ref))
      )
      const together = (sessions === 1 ? "" : `, ${sessions} sessions, user audio ends ${staggerMs === 0 ? "at the same moment" : `${staggerMs} ms apart`}`) +
        (llmPerSession ? ", one LLM instance per session" : "") +
        (parsed.ambient ? ", household ambient facts in every turn" : "") +
        (ownStt ? `, speech models per session ${parsed.sttModels.join(",")} (${SherpaStt.workers()} loaded)` : "") +
        (parsed.loadModel !== undefined ? `, ${parsed.loadModel} loaded idle` : "")
      for (const [i, rows] of perSession.entries()) {
        const which = sessions === 1 ? "" : ` — session ${i + 1} of ${sessions}`
        console.log(formatReport(`live: ${files.length} turns, ${llmLabel}${together}, replies in ${outputDir}${which}`, rows, {
          traceColumns: false,
          headline: { key: "PLAY", label: "end of user audio -> playback start" }
        }))
      }
      console.log(
        "Times in ms from the end of each file's audio: eager = EagerEndOfTurn, eot = EndOfTurn, then the LLM's first\n" +
          "token, the first clause sent to TTS, its first audio, and PLAY = first audio handed to the speaker."
      )
      return
    }
    if (args[0] === "--typesafe") {
      // WP-14: what a TypeSafe decision costs a turn, simulated (docs/ASSISTANTS.md §3.6).
      const rounds = yield* Config.Int("BENCH_ROUNDS").pipe(Config.withDefault(3))
      for (const scenario of typesafeScenarios(yield* RealisticDelays)) {
        const rows = yield* runOffline(scenario, rounds)
        yield* Effect.sync(() => console.log(formatReport(scenario.name, rows, { headline: { key: "EOT->PLAY", label: "recogniser EndOfTurn -> playback start" } })))
      }
      console.log("Trace columns are relative to the conversation's end of turn (after a decision held at the final); EOT->PLAY is from the recogniser's.")
      return
    }
    if (args[0] === "--typesafe-live") {
      // WP-14: real routing requests with the owner's key (environment or vault). Sends the utterances to TypeSafe.
      const parsed = parseTypesafeLiveArgs(args.slice(1))
      if (typeof parsed === "string") return yield* new StartupError({ message: `${parsed}. Usage: bench --typesafe-live [--count N] [--gap-ms MS] [--timeout-ms MS]` })
      const apiKey = yield* Config.String("TYPESAFE_API_KEY").pipe(Config.withDefault(""))
      if (apiKey.trim() === "") return yield* new StartupError({ message: "bench --typesafe-live needs TYPESAFE_API_KEY (in the environment, or saved in the vault with PVA_VAULT_PASSWORD)." })
      const baseUrl = yield* Config.String("TYPESAFE_BASE_URL").pipe(Config.withDefault(""))
      const model = yield* Config.String("TYPESAFE_MODEL").pipe(Config.withDefault(""))
      const rows = yield* runTypesafeLive({ apiKey, ...parsed, ...(baseUrl !== "" ? { baseUrl } : {}), ...(model !== "" ? { model } : {}) })
      console.log(formatLive(rows, `TypeSafe routing, live: ${rows.length} requests to ${baseUrl || "https://api.typesafe.ai"}, ${parsed.gapMs} ms apart, model ${model || "jev-1.14.0"}`))
      return
    }
    if (args[0] === "--sessions") {
      const n = Number(args[1])
      if (!Number.isInteger(n) || n < 1 || n > 16) return yield* new StartupError({ message: "Usage: bench --sessions N (1..16)" })
      return yield* offlineBench(n)
    }
    if (args.length > 0) return yield* new StartupError({ message: `Unknown bench option "${args[0]}"` })
    yield* offlineBench(1)
  }).pipe(Effect.scoped)

const [mode = "text", ...args] = process.argv.slice(2)

const program: Effect.Effect<void, unknown> = mode === "text"
  ? textMode
  : mode === "voice"
  ? voiceMode
  : mode === "bench"
  ? bench(args)
  : mode === "say"
  ? sayCommand(args)
  : mode === "transcribe"
  ? transcribeCommand(args)
  : mode === "compare-models"
  ? Effect.asVoid(compareModelsCommand(args))
  : mode === "serve"
  ? serveMode
  : mode === "doctor"
  ? doctorCommand
  : new StartupError({
    message: `Unknown mode "${mode}". Usage: assistant [text | voice | serve | doctor | bench [--sessions N | --typesafe | --typesafe-live [--count N] [--gap-ms MS] | --live [--rounds N] [--sessions N] [--stagger MS] [--llm-per-session] <wavs> | --make-wavs [dir]] | ` +
      "say [--voice PROVIDER:VOICE] [--out FILE] <text> | transcribe <wav file> | compare-models [--models a,b] [--agc on|off|both] [--ref TEXT] <wavs>]"
  })

/**
 * CLI modes read the saved settings and the key vault's keys behind the environment, like serve mode
 * (`cliSettings.ts`). The vault password comes from PVA_VAULT_PASSWORD, or is asked for on a terminal.
 */
let cliSettings: CliSettings | undefined
const withSavedSettings = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    const dataDir = yield* DataDirConfig.pipe(Effect.orDie)
    const vaultPath = yield* VaultPathConfig.pipe(Effect.orDie)
    const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true
    return yield* withCliSettings(
      Effect.flatMap(Effect.service(CliSettingsRef), (settings) => {
        cliSettings = settings
        return effect
      }),
      { env: process.env, dataDir, vaultPath, catalog: moduleCatalog, ...(interactive ? { prompt: askVaultPassword } : {}) }
    )
  })

NodeRuntime.runMain(
  (mode === "serve" ? program : withSavedSettings(program)).pipe(
    Effect.catch((e) => {
      const described = e instanceof StartupError
        ? e.message
        : e instanceof Config.ConfigError
        ? describeConfigError(e)
        : e instanceof DataDirLockError || e instanceof SettingsStoreError
        ? e.message // says what to do (another server on the data directory, an unfinished save that cannot be finished)
        : undefined
      const message = described === undefined ? undefined : explainMissingKey(described, cliSettings)
      if (message === undefined) return Effect.fail(e)
      return Effect.sync(() => {
        process.stderr.write(`${message}\n`)
        process.exitCode = 1
      })
    }),
    Effect.provide(StderrLogger)
  ),
  { disableErrorReporting: false }
)
