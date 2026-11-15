/**
 * `say [--voice PROVIDER:VOICE] [--out FILE] <text>`: try a voice without a conversation.
 * The text goes through the same clause chunker the conversation uses, then to the speaker (AUDIO_BACKEND) or a
 * WAV file, and the engine timings are printed. Without `--voice`, the assistant's voice (`ASSISTANT_VOICE`).
 */
import { encodeWav } from "@pva/audio-file"
import { AudioOutput, chunkClauses, parseVoiceKey, Tts, type VoiceRef, voiceKey } from "@pva/core"
import { Context, Effect, Stream } from "effect"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { userCwd } from "./env.ts"
import { AudioOutputLayer, isTtsProvider } from "./providers.ts"
import { buildProviders, StartupError } from "./startup.ts"
import { assistantVoiceStage, ttsLayerFor, voiceStageName } from "./voiceSelection.ts"

const usage = "Usage: say [--voice PROVIDER:VOICE] [--out FILE] <text>"

export interface SayArgs {
  readonly voice?: VoiceRef | undefined
  readonly out?: string | undefined
  readonly text: string
}

export const parseSayArgs = (args: ReadonlyArray<string>): SayArgs | string => {
  let voice: VoiceRef | undefined
  let out: string | undefined
  const words: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--voice" || arg === "--out") {
      const value = args[++i]
      if (value === undefined) return `${arg} needs a value. ${usage}`
      if (arg === "--voice") {
        const ref = parseVoiceKey(value.trim())
        if (ref === undefined || !isTtsProvider(ref.provider)) {
          return `--voice "${value}" is not a voice (e.g. sherpa:en_US-lessac-medium, elevenlabs:<voice id>). ${usage}`
        }
        voice = ref
      } else out = value
    } else words.push(arg)
  }
  const text = words.join(" ").trim()
  if (text.length === 0) return usage
  return { voice, out, text }
}

/** Timings of one `say` run. */
export interface SayStats {
  readonly voice: string
  readonly startedAt: number
  readonly firstAudioAt: number | undefined
  readonly endedAt: number
  readonly audioSeconds: number
  readonly clauses: number
}

const ms = (n: number) => `${Math.round(n)} ms`

/** One line: time to first audio, synthesis time, audio length, real-time factor. */
export const formatSayReport = (stats: SayStats): string => {
  if (stats.audioSeconds === 0) return "no audio was produced"
  const synthesis = stats.endedAt - stats.startedAt
  const ttfa = stats.firstAudioAt === undefined ? "-" : ms(stats.firstAudioAt - stats.startedAt)
  return `${stats.voice}: first audio ${ttfa}, synthesis ${ms(synthesis)}, audio ${stats.audioSeconds.toFixed(2)} s, ` +
    `real-time factor ${(synthesis / 1000 / stats.audioSeconds).toFixed(2)} (${stats.clauses} clauses)`
}

export const sayCommand = (args: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function*() {
    const parsed = parseSayArgs(args)
    if (typeof parsed === "string") return yield* new StartupError({ message: parsed })
    const voice = parsed.voice !== undefined
      ? { ref: parsed.voice, stage: { stage: voiceStageName.replace("ASSISTANT_VOICE", "--voice"), layer: ttsLayerFor(parsed.voice) } }
      : yield* assistantVoiceStage
    const providers = yield* buildProviders([
      voice.stage,
      ...(parsed.out === undefined ? [{ stage: "audio (AUDIO_BACKEND)", layer: AudioOutputLayer }] : [])
    ])
    const tts = Context.get(providers as Context.Context<Tts>, Tts)

    const clauses = Stream.make(parsed.text).pipe(chunkClauses())
    const startedAt = performance.now()
    let firstAudioAt: number | undefined
    let samples = 0
    let count = 0
    const audio = tts.synthesize(clauses.pipe(Stream.tap(() => Effect.sync(() => count++)))).pipe(
      Stream.map((chunk) => {
        firstAudioAt ??= performance.now()
        samples += chunk.audio.length / 2
        return chunk.audio
      })
    )

    if (parsed.out !== undefined) {
      const path = resolve(userCwd, parsed.out)
      const chunks = yield* Stream.runCollect(audio)
      yield* Effect.try({
        try: () => writeFileSync(path, encodeWav({ sampleRate: tts.sampleRate, channels: 1, data: Buffer.concat(chunks) })),
        catch: (e) => new StartupError({ message: `cannot write ${path}: ${e instanceof Error ? e.message : String(e)}` })
      })
      console.log(`wrote ${path} (${tts.sampleRate} Hz)`)
    } else {
      yield* Context.get(providers, AudioOutput).play(audio, tts.sampleRate)
    }
    console.log(formatSayReport({
      voice: voiceKey(voice.ref),
      startedAt,
      firstAudioAt,
      endedAt: performance.now(),
      audioSeconds: samples / tts.sampleRate,
      clauses: count
    }))
  }))
