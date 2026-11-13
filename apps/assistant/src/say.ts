/**
 * `say [--voice NAME] [--out FILE] <text>`: try a voice without a conversation.
 * The text goes through the same clause chunker and voice router the
 * conversation uses, then to the speaker (AUDIO_BACKEND) or a WAV file, and
 * the engine timings are printed per voice.
 */
import { encodeWav } from "@pva/audio-file"
import { AudioOutput, chunkClauses, type VoiceSegmentStats } from "@pva/core"
import { Context, Effect, Stream } from "effect"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { userCwd } from "./env.ts"
import { AudioOutputLayer } from "./providers.ts"
import { buildProviders, StartupError } from "./startup.ts"
import { enableVoice, loadVoiceSettings, voiceRouter, voiceStages } from "./voices.ts"

const usage = "Usage: say [--voice NAME] [--out FILE] <text>"

export interface SayArgs {
  readonly voice?: string | undefined
  readonly out?: string | undefined
  readonly text: string
}

export const parseSayArgs = (args: ReadonlyArray<string>): SayArgs | string => {
  let voice: string | undefined
  let out: string | undefined
  const words: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--voice" || arg === "--out") {
      const value = args[++i]
      if (value === undefined) return `${arg} needs a value. ${usage}`
      if (arg === "--voice") voice = value.toLowerCase()
      else out = value
    } else words.push(arg)
  }
  const text = words.join(" ").trim()
  if (text.length === 0) return usage
  return { voice, out, text }
}

const ms = (n: number) => `${Math.round(n)} ms`

/** One line per voice: time to first audio (of its first segment), synthesis time, audio length, real-time factor. */
export const formatSayReport = (stats: ReadonlyArray<VoiceSegmentStats>): string => {
  const voices = [...new Set(stats.map((s) => s.voice))]
  const lines = voices.map((voice) => {
    const own = stats.filter((s) => s.voice === voice)
    const first = own[0]!
    const synthesis = own.reduce((n, s) => n + (s.endedAt - s.startedAt), 0)
    const audio = own.reduce((n, s) => n + s.audioSeconds, 0)
    const ttfa = first.firstAudioAt === undefined ? "-" : ms(first.firstAudioAt - first.startedAt)
    const rtf = audio > 0 ? (synthesis / 1000 / audio).toFixed(2) : "-"
    return `${voice}: first audio ${ttfa}, synthesis ${ms(synthesis)}, audio ${audio.toFixed(2)} s, ` +
      `real-time factor ${rtf} (${own.reduce((n, s) => n + s.clauses, 0)} clauses)`
  })
  return lines.length > 0 ? lines.join("\n") : "no audio was produced"
}

export const sayCommand = (args: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function*() {
    const parsed = parseSayArgs(args)
    if (typeof parsed === "string") return yield* new StartupError({ message: parsed })
    let voices = yield* loadVoiceSettings
    if (parsed.voice !== undefined) {
      const enabled = enableVoice(voices, parsed.voice)
      if (typeof enabled === "string") return yield* new StartupError({ message: enabled.replace(/^VOICES/, "--voice") })
      // The chosen voice is the default for this run, so it plays at its own sample rate
      // (other enabled voices are still reachable with markers).
      voices = { ...enabled, defaultVoice: parsed.voice }
    }
    const providers = yield* buildProviders([
      ...voiceStages(voices),
      ...(parsed.out === undefined ? [{ stage: "audio (AUDIO_BACKEND)", layer: AudioOutputLayer }] : [])
    ])

    const stats: Array<VoiceSegmentStats> = []
    const router = voiceRouter(providers, voices, (s) => stats.push(s))
    const audio = router.synthesize(Stream.make(parsed.text).pipe(chunkClauses())).pipe(Stream.map((chunk) => chunk.audio))

    if (parsed.out !== undefined) {
      const path = resolve(userCwd, parsed.out)
      const chunks = yield* Stream.runCollect(audio)
      yield* Effect.try({
        try: () => writeFileSync(path, encodeWav({ sampleRate: router.sampleRate, channels: 1, data: Buffer.concat(chunks) })),
        catch: (e) => new StartupError({ message: `cannot write ${path}: ${e instanceof Error ? e.message : String(e)}` })
      })
      console.log(`wrote ${path} (${router.sampleRate} Hz)`)
    } else {
      yield* Context.get(providers, AudioOutput).play(audio, router.sampleRate)
    }
    console.log(formatSayReport(stats))
  }))
