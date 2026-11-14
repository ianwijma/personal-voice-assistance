import "./env.ts" // first: loads .env before anything reads the environment
import { NodeRuntime } from "@effect/platform-node"
import { Conversation, Llm, ToolRegistry, TurnTrace } from "@pva/core"
import { Cause, Config, Effect, Layer, Logger, Stream } from "effect"
import { resolve } from "node:path"
import * as readline from "node:readline"
import { collectWavs, parseLiveArgs, runLive } from "./bench/live.ts"
import { makeBenchWavs } from "./bench/makeWavs.ts"
import { runOffline, type SimulatedDelays, zeroDelays } from "./bench/offline.ts"
import { formatReport } from "./bench/report.ts"
import { AppConfig } from "./config.ts"
import { userCwd } from "./env.ts"
import { startCliModules, withModuleInstructions } from "./modules.ts"
import { FakeLlm } from "./FakeLlm.ts"
import { LlmLayer, SttLayer, TtsLayer } from "./providers.ts"
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
import { transcribeCommand } from "./transcribe.ts"
import { voiceMode } from "./voice.ts"
import { loadVoiceSettings, voiceStages, withVoicePrompt, withVoiceRouter } from "./voices.ts"

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

// Text mode uses the same system prompt as voice mode (including the voice
// instructions), so the model behaves the same; markers are stripped from the output.
// LLM_PROVIDER=claude-subscription: the claude-subscription agent module (switched on and opted in from the web UI,
// or with CLAUDE_SUBSCRIPTION_OPT_IN) answers; the offline stand-in answers, with a notice, when it is not running.
const ConversationLayer = Layer.unwrap(Effect.gen(function*() {
  const settings = yield* AppConfig
  const voices = yield* loadVoiceSettings
  const modules = yield* startCliModules()
  const systemPrompt = withVoicePrompt(withModuleInstructions(settings.systemPrompt, modules.instructions), voices)
  const llmProvider = yield* Config.String("LLM_PROVIDER").pipe(Config.withDefault("fake"))
  if (llmProvider === SUBSCRIPTION_PROVIDER) {
    const fallbackLlm = yield* Llm
    const toAgents = makeSubscriptionAgents({
      fallbackLlm,
      agents: () => modules.agents,
      module: () => modules.infos.find((m) => m.id === SUBSCRIPTION_AGENT_ID),
      promptFor: (agent, turn) =>
        agent.systemPrompt === undefined ? turn.system : withVoicePrompt(withModuleInstructions(agent.systemPrompt, modules.instructions), voices)
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

const offlineBench = Effect.gen(function*() {
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
    { name: `realistic, eager end-of-turn ON (EagerEndOfTurn ${d.eagerLeadMs} ms before EndOfTurn)`, delays: realistic, eager: true }
  ]
  for (const scenario of scenarios) {
    const rows = yield* runOffline(scenario, rounds)
    yield* Effect.sync(() => console.log(formatReport(scenario.name, rows)))
  }
  console.log("Times in ms relative to EndOfTurn; negative = done early by a promoted speculative turn.")
})

const bench = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const outputDir = resolve(userCwd, yield* Config.String("BENCH_OUTPUT_DIR").pipe(Config.withDefault("bench-out")))
    if (args[0] === "--make-wavs") {
      const directory = resolve(userCwd, args[1] ?? "bench-audio")
      const providers = yield* buildProviders([{ stage: "text-to-speech (TTS_PROVIDER)", layer: TtsLayer }])
      const files = yield* makeBenchWavs(directory).pipe(Effect.provide(providers))
      console.log(`Wrote ${files.length} files. Run: bench --live ${directory}`)
      return
    }
    if (args[0] === "--live") {
      const usage = "Usage: bench --live [--rounds N] <wav files or directories> (16 kHz mono)"
      const parsed = parseLiveArgs(args.slice(1))
      if (typeof parsed === "string") return yield* new StartupError({ message: `${parsed}. ${usage}` })
      const once = yield* collectWavs(parsed.paths.map((p) => resolve(userCwd, p)))
      if (once.length === 0) return yield* new StartupError({ message: usage })
      const files = Array.from({ length: parsed.rounds }, () => once).flat()
      const voices = yield* loadVoiceSettings
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
      const providers = yield* buildProviders([
        ...voiceStages(voices),
        { stage: "language model (LLM_PROVIDER)", layer: llm },
        { stage: "speech-to-text (STT_PROVIDER)", layer: SttLayer }
      ])
      const settings = yield* AppConfig
      const modules = yield* startCliModules()
      const conversation = { ...settings, systemPrompt: withVoicePrompt(withModuleInstructions(settings.systemPrompt, modules.instructions), voices) }
      const rows = yield* runLive({ files, outputDir, conversation, modules }).pipe(
        Effect.provide(withVoiceRouter(providers, voices))
      )
      console.log(formatReport(`live: ${files.length} turns, ${llmLabel}, replies in ${outputDir}`, rows, {
        traceColumns: false,
        headline: { key: "PLAY", label: "end of user audio -> playback start" }
      }))
      console.log(
        "Times in ms from the end of each file's audio: eager = EagerEndOfTurn, eot = EndOfTurn, then the LLM's first\n" +
          "token, the first clause sent to TTS, its first audio, and PLAY = first audio handed to the speaker."
      )
      return
    }
    if (args.length > 0) return yield* new StartupError({ message: `Unknown bench option "${args[0]}"` })
    yield* offlineBench
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
  : new StartupError({
    message: `Unknown mode "${mode}". Usage: assistant [text | voice | serve | bench [--live [--rounds N] <wavs> | --make-wavs [dir]] | ` +
      "say [--voice NAME] [--out FILE] <text> | transcribe <wav file> | compare-models [--models a,b] [--agc on|off|both] [--ref TEXT] <wavs>]"
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
      { env: process.env, dataDir, vaultPath, ...(interactive ? { prompt: askVaultPassword } : {}) }
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
