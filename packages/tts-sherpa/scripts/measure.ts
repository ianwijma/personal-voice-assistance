// Reproduces the README numbers and writes sample WAVs.
// Usage: pnpm --filter @pva/tts-sherpa measure [preset ...]   (default: every downloaded preset)
// Env: RUNS (default 10). WAVs go to packages/tts-sherpa/bench-out/ (git-ignored).
import type { Tts, TtsAudio } from "@pva/core"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { defaultModelDir, makeWithEngine, presets } from "../src/index.ts"
import { silentRuns, wav } from "../src/Pcm.ts"
import { presetFiles } from "../src/Presets.ts"

const RUNS = Number(process.env.RUNS ?? 10)
const outDir = fileURLToPath(new URL("../bench-out", import.meta.url))

const english = {
  short: "Sure, I can do that.", // 5 words
  medium: "The meeting has been moved to three thirty tomorrow afternoon, I think.", // 12 words
  long:
    "Your calendar shows two meetings tomorrow, and the first one starts at nine, so you should leave the house a little earlier than usual.", // 25 words
  reply: [
    "Sure, I can help with that.",
    "Your first meeting tomorrow is at nine,",
    "and the second one starts at half past two.",
    "Do you want me to set a reminder?"
  ]
}
const dutch = {
  short: "Ja, dat kan ik doen.",
  medium: "De vergadering is verplaatst naar morgenmiddag half vier, geloof ik.",
  long:
    "Je agenda toont morgen twee afspraken, en de eerste begint om negen uur, dus je moet iets eerder van huis vertrekken dan normaal.",
  reply: [
    "Natuurlijk, ik help je graag.",
    "Je eerste afspraak morgen is om negen uur,",
    "en de tweede begint om half drie.",
    "Zal ik een herinnering instellen?"
  ]
}

const stats = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return `median ${s[Math.floor(s.length / 2)]!.toFixed(0)} ms, worst ${s.at(-1)!.toFixed(0)} ms`
}

/** Time from handing over the clauses to the first audio chunk, and all chunks. */
const timeTurn = (tts: Tts["Service"], clauses: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const start = performance.now()
    let first = -1
    const chunks: Array<TtsAudio> = []
    yield* tts.synthesize(Stream.fromIterable(clauses)).pipe(Stream.runForEach((c) =>
      Effect.sync(() => {
        if (first < 0) first = performance.now() - start
        chunks.push(c)
      })
    ))
    return { first, chunks }
  })

/** Starts a long turn, interrupts it as soon as `when` says, then times a short clause. */
const afterInterrupt = (tts: Tts["Service"], text: { long: string; short: string }, when: "firstAudio" | "immediately") =>
  Effect.gen(function*() {
    const gotFirst = yield* Deferred.make<void>()
    const turn = yield* tts.synthesize(Stream.make(text.long, text.long, text.long)).pipe(
      Stream.runForEach(() => Deferred.succeed(gotFirst, undefined)),
      Effect.forkChild
    )
    if (when === "firstAudio") yield* Deferred.await(gotFirst) // clause 1 has just gone in flight
    else yield* Effect.sleep("5 millis") // speculative turn discarded before any audio: clause 0 in flight
    const t0 = performance.now()
    yield* Fiber.interrupt(turn)
    const interruptMs = performance.now() - t0
    const { first } = yield* timeTurn(tts, [text.short])
    return { interruptMs, first }
  })

const rssMb = (pid: number | undefined) => {
  if (pid === undefined) return "?"
  const status = readFileSync(`/proc/${pid}/status`, "utf8")
  const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? 0)
  return `RSS ${(kb("VmRSS") / 1024).toFixed(0)} MB (peak ${(kb("VmHWM") / 1024).toFixed(0)} MB)`
}

const measure = (name: string) =>
  Effect.gen(function*() {
    const text = name.startsWith("nl_") ? dutch : english
    const t0 = performance.now()
    const { tts, engine } = yield* makeWithEngine({ preset: name })
    console.log(`\n## ${name}  (${tts.sampleRate} Hz, model load ${(performance.now() - t0).toFixed(0)} ms)`)

    yield* timeTurn(tts, [text.short, text.medium]) // warm-up
    const loop = monitorEventLoopDelay({ resolution: 1 })
    loop.enable()
    for (const size of ["short", "medium", "long"] as const) {
      const firsts: Array<number> = []
      let seconds = 0
      for (let i = 0; i < RUNS; i++) {
        const r = yield* timeTurn(tts, [text[size]])
        firsts.push(r.first)
        seconds = r.chunks.reduce((n, c) => n + c.audio.length, 0) / 2 / tts.sampleRate
      }
      console.log(`first audio, ${size} clause (${text[size].split(" ").length} words, ${seconds.toFixed(2)} s audio): ${stats(firsts)}`)
    }
    loop.disable()
    console.log(
      `main event-loop delay during synthesis: p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms, max ${(loop.max / 1e6).toFixed(1)} ms`
    )

    for (const when of ["firstAudio", "immediately"] as const) {
      const firsts: Array<number> = []
      const interrupts: Array<number> = []
      for (let i = 0; i < RUNS; i++) {
        const r = yield* afterInterrupt(tts, text, when)
        firsts.push(r.first)
        interrupts.push(r.interruptMs)
      }
      const label = when === "firstAudio" ? "interrupted after first audio" : "discarded before any audio"
      console.log(`short clause right after a turn ${label}: first audio ${stats(firsts)}; interrupt took ${stats(interrupts)}`)
    }
    console.log(`engine process: ${rssMb(engine.pid)}`)

    // Sample reply, joined and raw, plus the silences at the joins.
    mkdirSync(outDir, { recursive: true })
    const { chunks } = yield* timeTurn(tts, text.reply)
    const pcm = Buffer.concat(chunks.map((c) => c.audio))
    const file = join(outDir, `${name}.wav`)
    writeFileSync(file, wav(pcm, tts.sampleRate))
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
    const lead = silentRuns(samples, tts.sampleRate, 0.01, 0)[0]
    const joins = silentRuns(samples, tts.sampleRate, 0.01, 100).map((r) => `${r.ms.toFixed(0)}`)
    console.log(`reply: ${(samples.length / tts.sampleRate).toFixed(2)} s, leading silence ${lead?.atMs === 0 ? lead.ms.toFixed(0) : 0} ms, silences ≥100 ms: [${joins.join(", ")}] ms → ${file}`)
  }).pipe(Effect.scoped)

const raw = (name: string) =>
  Effect.gen(function*() {
    const text = name.startsWith("nl_") ? dutch : english
    const { tts } = yield* makeWithEngine({ preset: name, join: { trim: false } })
    const { chunks } = yield* timeTurn(tts, text.reply)
    const pcm = Buffer.concat(chunks.map((c) => c.audio))
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
    const lead = silentRuns(samples, tts.sampleRate, 0.01, 0)[0]
    const joins = silentRuns(samples, tts.sampleRate, 0.01, 100).map((r) => `${r.ms.toFixed(0)}`)
    const file = join(outDir, `${name}.untrimmed.wav`)
    writeFileSync(file, wav(pcm, tts.sampleRate))
    console.log(`untrimmed reply (for comparison): ${(samples.length / tts.sampleRate).toFixed(2)} s, leading silence ${lead?.atMs === 0 ? lead.ms.toFixed(0) : 0} ms, silences ≥100 ms: [${joins.join(", ")}] ms → ${file}`)
  }).pipe(Effect.scoped)

const wanted = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(presets)
console.log(`runs per measurement: ${RUNS}`)
for (const name of wanted) {
  const preset = presets[name]
  if (preset === undefined || !Object.values(presetFiles(preset, defaultModelDir)).every(existsSync)) {
    console.log(`\n## ${name}: not downloaded, skipped`)
    continue
  }
  await Effect.runPromise(Effect.andThen(measure(name), raw(name)))
}
