import { Stt } from "@pva/core"
import { Effect, Stream, Logger, References } from "effect"
import { layer } from "../src/SherpaStt.ts"
import { pacedAudio, timeline } from "../test/fixtures.ts"
const model = (process.argv[2] ?? "parakeet-v2") as any
const { pcm } = timeline([800, "0.wav", 1500, "1.wav", 1500, "nl0.wav", 1500])
const t0 = performance.now()
Effect.runPromise(Effect.gen(function*() {
  const stt = yield* Stt
  yield* stt.transcribe(pacedAudio(pcm, { speed: Number(process.argv[3] ?? 2) })).pipe(Stream.runForEach((e) => Effect.sync(() => console.log(((performance.now() - t0)/1000).toFixed(2), e._tag, "text" in e ? e.text : ""))))
}).pipe(Effect.provide(layer({ model, maxBacklogMs: 5000 })), Effect.provideService(References.MinimumLogLevel, "Debug"))).catch((e) => { console.error(e); process.exit(1) })
