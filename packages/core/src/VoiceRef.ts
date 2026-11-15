import { Effect, Stream } from "effect"
import { chunkClauses } from "./ClauseChunker.ts"
import type { TtsError } from "./Errors.ts"
import type { Tts } from "./Services.ts"
import { CurrentTurnTrace } from "./TurnTrace.ts"

/**
 * A voice (docs/VOICE-PROVIDERS.md §7.1): one concrete voice of one provider. A small value type, so whatever
 * chooses a voice (the assistant today, each agent later) holds one of these and nothing provider-specific.
 *
 * Its string form, the **voice key**, is `provider:voiceId` (split at the first `:`), used where one string is
 * needed: a setting, a URL path, a favourite.
 */
export interface VoiceRef {
  /** The provider id: `sherpa`, `cartesia`, `elevenlabs`, … */
  readonly provider: string
  /** The provider's own id of the voice (a preset name, a voice UUID). */
  readonly voiceId: string
}

/** A provider id: lower case letters, digits and dashes, starting with a letter. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
/** A provider voice id: letters, digits, `.`, `_`, `-`; at most 128 characters. */
export const VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const isVoiceRef = (ref: VoiceRef): boolean => PROVIDER_ID_PATTERN.test(ref.provider) && VOICE_ID_PATTERN.test(ref.voiceId)

export const voiceKey = (ref: VoiceRef): string => `${ref.provider}:${ref.voiceId}`

/** The reference a voice key names, or undefined when it is not well formed. */
export const parseVoiceKey = (key: string): VoiceRef | undefined => {
  const at = key.indexOf(":")
  if (at < 0) return undefined
  const ref = { provider: key.slice(0, at), voiceId: key.slice(at + 1) }
  return isVoiceRef(ref) ? ref : undefined
}

export const sameVoice = (a: VoiceRef, b: VoiceRef): boolean => a.provider === b.provider && a.voiceId === b.voiceId

/** A voice as a provider lists it (docs/VOICE-PROVIDERS.md §4.1). */
export interface VoiceDescription {
  /** The provider's voice id. */
  readonly id: string
  readonly name: string
  readonly description?: string
  /** BCP 47, as the provider gives it (`en`, `en-US`). */
  readonly language?: string
  readonly gender?: "female" | "male" | "neutral"
  readonly tags: ReadonlyArray<string>
  /** Voices on this machine: whether its model is downloaded, and how big it is. */
  readonly local?: { readonly installed: boolean; readonly sizeMb: number; readonly diskMb: number }
}

export interface VoiceList {
  readonly voices: ReadonlyArray<VoiceDescription>
  /** The provider has more voices than were fetched (`MAX_LISTED_VOICES`). */
  readonly truncated: boolean
}

/** At most this many voices are kept per provider. */
export const MAX_LISTED_VOICES = 1000

/** A preview: raw PCM s16le mono at `sampleRate`. */
export interface PreviewAudio {
  readonly sampleRate: number
  readonly pcm: Uint8Array
}

/**
 * The tag for the voice that speaks a turn: `Trace.voices` gets `name` at the first synthesis of each turn
 * (the latency line's `voices: …`). The `Tts` is otherwise unchanged.
 */
export const withTraceVoice = (tts: Tts["Service"], name: string): Tts["Service"] => ({
  sampleRate: tts.sampleRate,
  synthesize: (clauses) =>
    Stream.unwrap(Effect.gen(function*() {
      const trace = yield* CurrentTurnTrace
      if (trace !== undefined && !trace.voices.includes(name)) trace.voices.push(name)
      return tts.synthesize(clauses)
    }))
})

/**
 * Speak `text` with `tts` and collect the audio, at most `maxSamples` samples (the rest is not synthesised: the
 * stream is interrupted). The text is cut into clauses as a reply would be, so an engine that works clause by
 * clause can be interrupted between them.
 */
export const synthesizeText = (tts: Tts["Service"], text: string, maxSamples: number): Effect.Effect<PreviewAudio, TtsError> =>
  Effect.gen(function*() {
    const chunks: Array<Uint8Array> = []
    let bytes = 0
    const limit = Math.max(0, Math.floor(maxSamples)) * 2
    yield* tts.synthesize(Stream.make(text).pipe(chunkClauses())).pipe(
      Stream.takeUntil(() => bytes >= limit),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          const room = limit - bytes
          if (room <= 0) return
          const part = chunk.audio.length > room ? chunk.audio.subarray(0, room - (room % 2)) : chunk.audio
          chunks.push(part)
          bytes += part.length
        })
      )
    )
    const pcm = new Uint8Array(bytes)
    let at = 0
    for (const c of chunks) {
      pcm.set(c, at)
      at += c.length
    }
    return { sampleRate: tts.sampleRate, pcm }
  })
