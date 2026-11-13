/**
 * `transcribe <wav file>`: stream a 16 kHz mono WAV file at real-time pace
 * through the selected STT provider and print every event with its time since
 * the start and relative to the end of the speech audio (negative = before it).
 * After the file, silence is fed until an end of turn arrives (at most
 * `AUDIO_INPUT_TRAILING_SILENCE_MS`, default 3000 ms) so turn detection can fire.
 */
import { loadInputPcm, pacedFrames } from "@pva/audio-file"
import { type SttEvent, Stt } from "@pva/core"
import { Config, Context, Deferred, Effect, Stream } from "effect"
import { resolve } from "node:path"
import { userCwd } from "./env.ts"
import { SttLayer } from "./providers.ts"
import { buildProviders, StartupError } from "./startup.ts"

const fmt = (n: number) => `${n >= 0 ? "+" : "-"}${String(Math.round(Math.abs(n))).padStart(5)} ms`

export const formatSttEvent = (event: SttEvent, sinceStart: number, sinceAudioEnd: number): string => {
  const text = "text" in event ? ` "${event.text}"` : ""
  return `${fmt(sinceStart)}  audio end ${fmt(sinceAudioEnd)}  ${event._tag}${text}`
}

export const transcribeCommand = (args: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function*() {
    if (args.length !== 1) return yield* new StartupError({ message: "Usage: transcribe <wav file> (16 kHz mono)" })
    const path = resolve(userCwd, args[0]!)
    const pcm = yield* loadInputPcm(path).pipe(Effect.mapError((e) => new StartupError({ message: `transcribe: ${e.message}` })))
    const silenceMs = yield* Config.Int("AUDIO_INPUT_TRAILING_SILENCE_MS").pipe(Config.withDefault(3000))
    const providers = yield* buildProviders([{ stage: "speech-to-text (STT_PROVIDER)", layer: SttLayer }])
    const stt = Context.get(providers, Stt)

    // Speech audio ends at start + its duration (frames are paced against the start time).
    const audioMs = (pcm.length / 2 / 16_000) * 1000
    const turnEnded = yield* Deferred.make<void>()
    let start = 0
    const audio = Stream.fromEffectDrain(Effect.sync(() => {
      start = performance.now()
    })).pipe(
      Stream.concat(pacedFrames(pcm)),
      Stream.concat(pacedFrames(new Uint8Array(0), { trailingSilenceMs: silenceMs, noiseFloor: true }).pipe(
        Stream.interruptWhen(Deferred.await(turnEnded))
      ))
    )
    console.log(`${path}: ${(audioMs / 1000).toFixed(2)} s of audio, streamed in real time`)
    yield* stt.transcribe(audio).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function*() {
          const sinceStart = performance.now() - start
          console.log(formatSttEvent(event, sinceStart, sinceStart - audioMs))
          if (event._tag === "EndOfTurn" && sinceStart >= audioMs) yield* Deferred.succeed(turnEnded, undefined)
        })
      ),
      Effect.mapError((e) => new StartupError({ message: `Speech-to-text failed: ${e.message}` }))
    )
  }))
