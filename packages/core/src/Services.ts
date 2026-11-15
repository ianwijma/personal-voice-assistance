import { Context } from "effect"
import type { Effect, Stream } from "effect"
import type { LlmEvent, LlmRequest, SttEvent } from "./Domain.ts"
import type { PlaybackObserver } from "./ConversationEvents.ts"
import type { AudioError, LlmError, SttError, TtsError, VoiceCatalogError } from "./Errors.ts"
import type { PreviewAudio, VoiceList } from "./VoiceRef.ts"

/**
 * Microphone. Raw PCM s16le mono 16 kHz in ~20 ms `Uint8Array` chunks.
 */
export class AudioInput extends Context.Service<AudioInput, {
  readonly stream: Stream.Stream<Uint8Array, AudioError>
}>()("@pva/core/AudioInput") {}

/**
 * Speaker. `play` returns when the audio has finished playing. Interrupting the
 * fiber must silence the speaker immediately (drop everything buffered).
 *
 * An output whose playback is not paced by pulling chunks (a browser that
 * buffers what it receives) sets `reportsPlayback: true` and reports through the
 * `observer` it is then given: `started` when the first sample reached the
 * device, `progress(samples)` as playback advances, with the final value
 * reported before `play` returns or its interruption completes. `Conversation`
 * then counts a clause as played from those reports instead of from pulls.
 */
export class AudioOutput extends Context.Service<AudioOutput, {
  readonly reportsPlayback?: boolean
  play<E>(audio: Stream.Stream<Uint8Array, E>, sampleRate: number, observer?: PlaybackObserver): Effect.Effect<void, E | AudioError>
}>()("@pva/core/AudioOutput") {}

/** Speech to text, including turn detection. */
export class Stt extends Context.Service<Stt, {
  transcribe(audio: Stream.Stream<Uint8Array, AudioError>): Stream.Stream<SttEvent, SttError>
}>()("@pva/core/Stt") {}

/** Language model. One request = one model call; the tool loop lives in `Conversation`. */
export class Llm extends Context.Service<Llm, {
  stream(request: LlmRequest): Stream.Stream<LlmEvent, LlmError>
}>()("@pva/core/Llm") {}

/** A chunk of synthesised audio and the index of the input clause it belongs to. */
export interface TtsAudio {
  /** Raw PCM s16le mono at `Tts.sampleRate`. */
  readonly audio: Uint8Array
  /** Index (0-based) of the item of the `clauses` stream this audio belongs to. Non-decreasing. */
  readonly clause: number
}

/**
 * Text to speech. One call per turn: clauses arrive incrementally (each must be
 * sent on as soon as it arrives, as one continuous synthesis for prosody) and
 * audio streams out tagged with its clause index.
 */
export class Tts extends Context.Service<Tts, {
  readonly sampleRate: number
  synthesize(clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError>
}>()("@pva/core/Tts") {}

/**
 * The voices of one text-to-speech provider (docs/VOICE-PROVIDERS.md §7.2): what it offers, and a preview of any of
 * them. Separate from `Tts` (which speaks with one chosen voice), so a picker can browse a provider that no voice is
 * built from. Interrupting either effect cancels the work (an HTTP request is aborted, a local engine stopped).
 */
export class TtsVoices extends Context.Service<TtsVoices, {
  readonly list: Effect.Effect<VoiceList, VoiceCatalogError>
  /** `voiceId` reads `text` (already limited by the caller). */
  readonly preview: (voiceId: string, text: string) => Effect.Effect<PreviewAudio, VoiceCatalogError>
}>()("@pva/core/TtsVoices") {}
