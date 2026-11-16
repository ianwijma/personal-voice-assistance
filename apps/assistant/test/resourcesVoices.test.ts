// The resource pool's voices (docs/ASSISTANTS.md §3.2, WP-10): keyed by voice, shared when equal, switched at the next
// turn start after a change, released after the grace period, failures per resource; and the default builder's
// engine sharing (every voice of one Kokoro engine runs on one engine, counted, stopped with the last).
import { CurrentTurnTrace, type Tts, TtsError, type TtsAudio, type VoiceRef, voiceKey } from "@pva/core"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import * as SherpaTts from "@pva/tts-sherpa"
import { ConfigProvider, Deferred, Effect, Exit, Scope, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  defaultTtsBuilder,
  makeResourcePool,
  ResourceBuildError,
  type ResourcePool,
  type TtsBuilder,
  type TtsSpec,
  ttsKeyOf,
  ttsSpecOf
} from "../src/serve/Resources.ts"
import { sleep } from "./support/scriptedClient.ts"

const piper: VoiceRef = { provider: "sherpa", voiceId: "en_US-lessac-medium" }
const dutch: VoiceRef = { provider: "sherpa", voiceId: "nl_NL-pim-medium" }
const kokoro: VoiceRef = { provider: "sherpa", voiceId: "kokoro-af_heart" }
const sarah: VoiceRef = { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL" }

const noLlm: LlmBuilder = () => Effect.fail(new ResourceBuildError({ message: "no language models here" }))

/** Voices that speak "<voice>#<n>" as one chunk per clause; `fail` voices cannot be built; a `hold` keeps a stream open. */
const fakeVoices = () => {
  const builds: Array<string> = []
  const released: Array<string> = []
  const failing = new Set<string>()
  const holds = new Map<string, Deferred.Deferred<void>>()
  const build: TtsBuilder = (spec) =>
    Effect.gen(function*() {
      const key = ttsKeyOf(spec)
      if (failing.has(key)) return yield* new ResourceBuildError({ message: `${key} could not start.` })
      builds.push(key)
      const name = `${key}#${builds.length}`
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push(name)))
      return {
        sampleRate: spec.voice.voiceId.startsWith("kokoro") ? 24_000 : 22_050,
        synthesize: (clauses: Stream.Stream<string>) =>
          clauses.pipe(
            Stream.zipWithIndex,
            Stream.flatMap(([text, clause]) =>
              Stream.fromEffect(Effect.gen(function*() {
                const hold = holds.get(key)
                if (hold !== undefined) yield* Deferred.await(hold)
                return { audio: new TextEncoder().encode(`${name}: ${text}`), clause } satisfies TtsAudio
              }))
            )
          )
      } satisfies Tts["Service"]
    })
  return { build, builds, released, failing, holds }
}

let scope: Scope.Closeable | undefined
afterEach(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void))
  scope = undefined
})
const makePool = async (buildTts: TtsBuilder, graceMs = 60): Promise<ResourcePool> => {
  scope = Effect.runSync(Scope.make())
  return Effect.runPromise(Scope.provide(makeResourcePool({ buildLlm: noLlm, buildTts, graceMs }), scope))
}
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const voices = (entries: Record<string, VoiceRef>, credentials?: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, v]): [string, TtsSpec] => [id, ttsSpecOf(v, credentials === undefined ? {} : { credentials })]))
const reconcile = (pool: ResourcePool, entries: Record<string, VoiceRef>, options: { rebuild?: boolean; retryFailed?: boolean } = {}) =>
  run(pool.reconcile(new Map(), { ...options, voices: voices(entries) }))
/** What `assistant` speaks for "hi" (the voice instance's name), and the trace's voices. */
const speak = (pool: ResourcePool, assistant: string) => {
  const trace = { voices: [] as Array<string> }
  return run(
    Stream.runCollect(pool.ttsFor(assistant)!.synthesize(Stream.make("hi"))).pipe(
      Effect.provideService(CurrentTurnTrace, trace as never),
      Effect.map((chunks) => ({ said: new TextDecoder().decode(chunks[0]!.audio), voices: trace.voices }))
    )
  )
}

describe("resource pool: voices", () => {
  it("keys a voice by voiceKey; two assistants with the same voice share one instance; the trace names the voice", async () => {
    const fake = fakeVoices()
    const pool = await makePool(fake.build)
    await reconcile(pool, { a: piper, b: kokoro, c: piper })
    expect(fake.builds.sort()).toEqual(["sherpa:en_US-lessac-medium", "sherpa:kokoro-af_heart"])
    expect(pool.ttsKeyFor("a")).toBe(voiceKey(piper))
    expect(pool.ttsFor("c")).toBe(pool.ttsFor("a"))
    expect(pool.ttsFor("b")).not.toBe(pool.ttsFor("a"))
    expect(pool.tts(voiceKey(piper))).toBe(pool.ttsFor("a"))
    expect(await speak(pool, "a")).toMatchObject({ said: expect.stringContaining("lessac-medium#"), voices: ["sherpa:en_US-lessac-medium"] })
    expect(await speak(pool, "b")).toMatchObject({ said: expect.stringContaining("kokoro-af_heart#"), voices: ["sherpa:kokoro-af_heart"] })
    expect(pool.ttsFor("a")!.sampleRate).toBe(22_050)
    expect(pool.ttsFor("b")!.sampleRate).toBe(24_000)
    const status = pool.status().filter((r) => r.kind === "tts")
    expect(status).toHaveLength(2)
    expect(status.find((r) => r.key === voiceKey(piper))).toMatchObject({ state: "ready", usedBy: ["a", "c"], location: "local", label: "Voice Piper en_US-lessac-medium" })
    // The same wants again build nothing.
    await reconcile(pool, { a: piper, b: kokoro, c: piper })
    expect(fake.builds).toHaveLength(2)
  })

  it("a changed voice is built first; the assistant keeps the old one until it is ready; a stream in flight finishes on the old one; the old one is released after the grace period", async () => {
    const fake = fakeVoices()
    const pool = await makePool(fake.build, 80)
    await reconcile(pool, { a: piper, b: kokoro })
    const old = pool.ttsFor("a")!
    // A turn is speaking with the old voice while the voice changes.
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set(voiceKey(piper), gate)
    const inFlight = run(Stream.runCollect(old.synthesize(Stream.make("long")))).then((c) => new TextDecoder().decode(c[0]!.audio))
    await sleep(10)
    const slow = Deferred.makeUnsafe<void>()
    fake.holds.set("never", slow)
    await reconcile(pool, { a: dutch, b: kokoro })
    expect(pool.ttsKeyFor("a")).toBe(voiceKey(dutch))
    expect(pool.ttsFor("a")).not.toBe(old)
    expect((await speak(pool, "a")).said).toContain("nl_NL-pim-medium#")
    // The other assistant was not touched.
    expect(pool.ttsKeyFor("b")).toBe(voiceKey(kokoro))
    expect(fake.builds.filter((k) => k === voiceKey(kokoro))).toHaveLength(1)
    // Past the grace period the old instance is still kept: a stream runs on it.
    await sleep(160)
    expect(fake.released.some((r) => r.includes("lessac"))).toBe(false)
    expect(pool.status().some((r) => r.kind === "tts" && r.key === voiceKey(piper) && r.state === "unused")).toBe(true)
    Deferred.doneUnsafe(gate, Exit.void)
    expect(await inFlight).toContain("lessac-medium#1: long")
    await sleep(30)
    expect(fake.released.some((r) => r.includes("lessac"))).toBe(true)
    expect(pool.status().some((r) => r.key === voiceKey(piper))).toBe(false)
  })

  it("ttsReady waits for the voice bound when it is called, even once the assistant is rebound to a ready voice", async () => {
    const fake = fakeVoices()
    const building = Deferred.makeUnsafe<void>()
    const build: TtsBuilder = (spec) =>
      ttsKeyOf(spec) === voiceKey(kokoro) ? Effect.andThen(Deferred.await(building), fake.build(spec)) : fake.build(spec)
    const pool = await makePool(build)
    await reconcile(pool, { c: piper })
    // a and b come into use on Kokoro, still being built: a turn of a captures that voice and its readiness.
    const wanting = reconcile(pool, { a: kokoro, b: kokoro, c: piper })
    await sleep(10)
    const voice = pool.ttsFor("a")!
    const ready = pool.ttsReady("a")
    expect(voice.sampleRate).toBe(22_050)
    // Before the turn waits, a switches to Piper (ready, so bound at once); b keeps Kokoro alive.
    await reconcile(pool, { a: piper, b: kokoro, c: piper })
    expect(pool.ttsKeyFor("a")).toBe(voiceKey(piper))
    let done = false
    const waiting = run(ready).then(() => {
      done = true
    })
    await sleep(30)
    // Still waiting for Kokoro: the turn must not read the placeholder rate of the voice it speaks with.
    expect(done).toBe(false)
    Deferred.doneUnsafe(building, Exit.void)
    await waiting
    await wanting
    expect(voice.sampleRate).toBe(24_000)
  })

  it("a voice nobody wants any more is released after the grace period, and kept when wanted again within it", async () => {
    const fake = fakeVoices()
    const pool = await makePool(fake.build, 80)
    await reconcile(pool, { a: piper, b: kokoro })
    await reconcile(pool, { a: piper })
    expect(pool.status().find((r) => r.key === voiceKey(kokoro))).toMatchObject({ state: "unused", usedBy: [] })
    await reconcile(pool, { a: piper, b: kokoro })
    await sleep(160)
    expect(fake.released).toEqual([])
    await reconcile(pool, { a: piper })
    await sleep(160)
    expect(fake.released).toEqual(["sherpa:kokoro-af_heart#2"])
    expect(pool.status().map((r) => r.key)).toEqual([voiceKey(piper)])
  })

  it("a voice that cannot start is a failed resource with its problem; its synthesis fails with it; the others speak; a retry builds it again", async () => {
    const fake = fakeVoices()
    fake.failing.add(voiceKey(sarah))
    const pool = await makePool(fake.build)
    await reconcile(pool, { a: piper, b: sarah })
    expect(pool.status().find((r) => r.usedBy.includes("b"))).toMatchObject({ kind: "tts", state: "failed", problem: "elevenlabs:EXAVITQu4vr4xnSDxMaL could not start.", location: "hosted" })
    await expect(speak(pool, "b")).rejects.toBeInstanceOf(TtsError)
    await expect(speak(pool, "b")).rejects.toMatchObject({ message: "elevenlabs:EXAVITQu4vr4xnSDxMaL could not start." })
    expect((await speak(pool, "a")).said).toContain("lessac")
    // A failed voice stays failed without a retry, and builds again with one.
    fake.failing.clear()
    await reconcile(pool, { a: piper, b: sarah })
    expect(pool.status().find((r) => r.usedBy.includes("b"))?.state).toBe("failed")
    await reconcile(pool, { a: piper, b: sarah }, { retryFailed: true })
    expect(pool.status().find((r) => r.usedBy.includes("b"))?.state).toBe("ready")
    expect((await speak(pool, "b")).said).toContain("elevenlabs")
  })

  it("a new provider key makes a new instance; the full rebuild builds every voice in use again", async () => {
    const fake = fakeVoices()
    const pool = await makePool(fake.build, 40)
    await run(pool.reconcile(new Map(), { voices: voices({ a: sarah }, { elevenlabs: "k1" }) }))
    await run(pool.reconcile(new Map(), { voices: voices({ a: sarah }, { elevenlabs: "k2" }) }))
    expect(fake.builds).toHaveLength(2)
    await sleep(100)
    expect(pool.status().filter((r) => r.kind === "tts")).toHaveLength(1)
    await run(pool.reconcile(new Map(), { rebuild: true, voices: voices({ a: sarah }, { elevenlabs: "k2" }) }))
    expect(fake.builds).toHaveLength(3)
  })
})

describe("the default voice builder", () => {
  /** Engines that are counted: the engine of a Kokoro preset speaks its other speakers; a Piper preset only itself. */
  const fakeEngines = () => {
    const started: Array<string> = []
    const closed: Array<string> = []
    const make = (options: SherpaTts.SherpaTtsOptions): Effect.Effect<SherpaTts.SharedEngine, TtsError, Scope.Scope> =>
      Effect.gen(function*() {
        const preset = SherpaTts.presets[options.preset!]!
        const name = `${options.preset}#${started.length + 1}`
        started.push(name)
        yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(name)))
        yield* Effect.sleep(20)
        const tts = (speaker: number): Tts["Service"] => ({
          sampleRate: 22_050,
          synthesize: (clauses) => clauses.pipe(Stream.zipWithIndex, Stream.map(([text, clause]) => ({ audio: new TextEncoder().encode(`${name}/${speaker}: ${text}`), clause })))
        })
        return SherpaTts.shareEngine(preset, { tts: tts(preset.speaker), forSpeaker: tts })
      })
    return { make, started, closed }
  }
  const heart = kokoro
  const bella: VoiceRef = { provider: "sherpa", voiceId: "kokoro-af_bella" }

  it("every Kokoro speaker of one set-up shares one engine, a Piper voice has its own; the engine stops with its last voice", async () => {
    expect(SherpaTts.presets["kokoro-af_bella"]).toBeDefined()
    const engines = fakeEngines()
    const pool = await makePool(defaultTtsBuilder(() => ConfigProvider.fromEnvRecord({}), engines.make), 40)
    await reconcile(pool, { a: heart, b: bella, c: piper })
    expect(engines.started).toHaveLength(2) // one Kokoro engine for both speakers, one Piper engine
    const said = async (assistant: string) => new TextDecoder().decode((await run(Stream.runCollect(pool.ttsFor(assistant)!.synthesize(Stream.make("hi")))))[0]!.audio)
    const speakerOf = async (assistant: string) => (await said(assistant)).split(": ")[0]!
    const a = await speakerOf("a")
    const b = await speakerOf("b")
    expect(a.split("/")[0]).toBe(b.split("/")[0]) // the same engine …
    expect(a).not.toBe(b) // … with another speaker
    expect((await speakerOf("c")).startsWith("en_US-lessac-medium#")).toBe(true)
    // One Kokoro voice goes: its engine stays for the other.
    await reconcile(pool, { b: bella, c: piper })
    await sleep(120)
    expect(engines.closed).toEqual([])
    // The last one goes: the engine stops.
    await reconcile(pool, { c: piper })
    await sleep(120)
    expect(engines.closed).toHaveLength(1)
    expect(engines.closed[0]).toMatch(/^kokoro-af_heart#/)
    expect(pool.status().map((r) => r.key)).toEqual([voiceKey(piper)])
  })

  it("an engine that cannot start fails every voice waiting on it, and the next try starts a new one", async () => {
    let tries = 0
    const make = (): Effect.Effect<SherpaTts.SharedEngine, TtsError, Scope.Scope> =>
      Effect.suspend(() => (++tries === 1 ? Effect.sleep(20).pipe(Effect.andThen(Effect.fail(new TtsError({ message: "the model is damaged" })))) : fakeEngines().make({ preset: "kokoro-af_heart" })))
    const pool = await makePool(defaultTtsBuilder(() => ConfigProvider.fromEnvRecord({}), make), 20)
    await reconcile(pool, { a: heart, b: { provider: "sherpa", voiceId: "kokoro-af_bella" } })
    expect(pool.status().filter((r) => r.state === "failed")).toHaveLength(2)
    expect(pool.status()[0]!.problem).toContain("the model is damaged")
    await reconcile(pool, { a: heart, b: { provider: "sherpa", voiceId: "kokoro-af_bella" } }, { retryFailed: true })
    expect(pool.status().filter((r) => r.state === "ready")).toHaveLength(2)
    expect(tries).toBe(2)
  })

  it("an unknown provider or voice is a problem of that resource", async () => {
    const pool = await makePool(defaultTtsBuilder(() => ConfigProvider.fromEnvRecord({}), fakeEngines().make), 20)
    await reconcile(pool, { a: { provider: "polly", voiceId: "x" }, b: { provider: "sherpa", voiceId: "no-such" } })
    expect(pool.status().find((r) => r.usedBy.includes("a"))?.problem).toBe('There is no voice provider "polly".')
    expect(pool.status().find((r) => r.usedBy.includes("b"))?.problem).toBe('There is no voice "no-such" on this machine.')
  })
})
