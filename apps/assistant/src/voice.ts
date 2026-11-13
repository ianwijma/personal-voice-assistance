import {
  type AudioError,
  AudioInput,
  Conversation,
  formatTrace,
  type Message,
  Stt,
  stripVoiceMarkers,
  ToolRegistry,
  type Trace
} from "@pva/core"
import { Config, Effect, Layer, Stream } from "effect"
import { AppConfig } from "./config.ts"
import { startCliModules, withModuleInstructions } from "./modules.ts"
import { AudioLayer, LlmLayer, SttLayer } from "./providers.ts"
import { buildProviders, observedTurnTraceLayer, StartupError } from "./startup.ts"
import { loadVoiceSettings, voiceStages, withVoicePrompt, withVoiceRouter } from "./voices.ts"

/** The assistant's words in `messages` (one turn's worth of history), without voice markers. */
export const assistantText = (messages: ReadonlyArray<Message>): string => {
  const said = messages.flatMap((m) => {
    const text = m.role === "assistant" ? stripVoiceMarkers(m.content).trim() : ""
    return text.length > 0 ? [text] : []
  })
  const interrupted = messages.some((m) => m.role === "assistant" && m.interrupted === true)
  return said.join(" ") + (interrupted ? " [interrupted]" : "")
}

/**
 * Microphone → STT → Conversation → TTS → speaker until interrupted (Ctrl+C)
 * or, with the file backend, until the input file has been played.
 * Prints `you:` on each end of turn, then `assistant:` and the latency line
 * when the turn is over.
 */
export const voiceMode = Effect.scoped(Effect.gen(function*() {
  const settings = yield* AppConfig
  const voices = yield* loadVoiceSettings
  const llmProvider = yield* Config.String("LLM_PROVIDER").pipe(Config.withDefault("fake"))
  const backend = yield* Config.String("AUDIO_BACKEND").pipe(Config.withDefault("pipewire"))

  // Ordered so the connections that take longest to open start first: the TTS
  // socket opens and the LLM warm-up request starts while the rest is built.
  const built = yield* buildProviders([
    ...voiceStages(voices),
    { stage: "language model (LLM_PROVIDER)", layer: LlmLayer },
    { stage: "speech-to-text (STT_PROVIDER)", layer: SttLayer },
    { stage: "audio (AUDIO_BACKEND)", layer: AudioLayer }
  ])
  const providers = withVoiceRouter(built, voices)
  if (llmProvider === "fake") {
    yield* Effect.logWarning("LLM_PROVIDER=fake: replies are canned echoes. Set LLM_PROVIDER=anthropic for real answers.")
  }

  // The latency line is printed from the trace hook, which runs right after the
  // turn's history was committed, so the reply can be printed with it.
  let history: Effect.Effect<ReadonlyArray<Message>> = Effect.succeed([])
  let printed = 0
  const onFinish = (trace: Trace) =>
    Effect.gen(function*() {
      if (trace.outcome !== "discarded") {
        const all = yield* history
        const reply = assistantText(all.slice(printed))
        printed = all.length
        yield* Effect.sync(() => console.log(`assistant: ${reply.length > 0 ? reply : "(nothing)"}`))
      }
      yield* Effect.logInfo(formatTrace(trace))
    })

  const services = Layer.succeedContext(providers)
  const modules = yield* startCliModules()
  const systemPrompt = withVoicePrompt(withModuleInstructions(settings.systemPrompt, modules.instructions), voices)
  const ConversationLive = Conversation.layer({ ...settings, systemPrompt }).pipe(
    Layer.provide(Layer.mergeAll(services, Layer.succeed(ToolRegistry, modules.registry), observedTurnTraceLayer(onFinish)))
  )

  yield* Effect.gen(function*() {
    const conversation = yield* Conversation
    const input = yield* AudioInput
    const stt = yield* Stt
    history = conversation.history

    let micError: AudioError | undefined
    const mic = input.stream.pipe(Stream.tapError((e) => Effect.sync(() => {
      micError = e
    })))
    const events = stt.transcribe(mic).pipe(
      Stream.tap((event) => event._tag === "EndOfTurn" && event.text !== "" ? Effect.sync(() => console.log(`you: ${event.text}`)) : Effect.void)
    )
    yield* Effect.logInfo(`Listening (audio: ${backend}, LLM: ${llmProvider}, voices: ${voices.enabled.map((v) => v.name).join(", ")}). Press Ctrl+C to quit.`)
    yield* conversation.voice(events).pipe(
      Effect.catch((error) =>
        new StartupError({
          message: micError !== undefined
            ? `Microphone failed (AUDIO_BACKEND=${backend}): ${micError.message}` +
              (backend === "pipewire"
                ? "\nCheck that PipeWire is running and a capture device exists (pw-cli ls Node), or set AUDIO_BACKEND=file."
                : "")
            : `Speech-to-text failed: ${error.message}\nCheck the STT provider's API key and the network.`
        })
      )
    )
    yield* Effect.logInfo("Audio input ended.")
  }).pipe(
    Effect.provide(Layer.merge(ConversationLive, services)),
    Effect.onInterrupt(() => Effect.logInfo("Stopping: closing connections and audio processes."))
  )
}))
