// The resource pool's recognisers (docs/ASSISTANTS.md §3.2, §3.5, WP-11): one instance per `SttKey` shared by every
// hearing place whose hearer uses it, per-stream options (timing, VAD, gain) outside the key, a changed key built
// first while the place keeps its old one, release after the grace period, failures per resource (a build that
// fails, a worker that dies later), and the default builder on stt-sherpa's stand-in worker (one worker per key).
import { type Stt, SttError, type SttEvent } from "@pva/core"
import type { AssistantHearing } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { ConfigProvider, Deferred, Effect, Exit, Scope, Stream } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  defaultSttBuilder,
  makeResourcePool,
  type Recogniser,
  ResourceBuildError,
  type ResourcePool,
  type SttBuilder,
  type SttSpec,
  sttKeyOf,
  sttSpecOf,
  type SttStreamSpec
} from "../src/serve/Resources.ts"
import { sleep } from "./support/scriptedClient.ts"

const hearing = (model: string, extra: Partial<AssistantHearing> = {}): AssistantHearing => ({
  engine: "sherpa",
  model,
  language: "auto",
  eagerSilenceMs: 250,
  finalSilenceMs: 600,
  minSpeechMs: 100,
  agc: true,
  agcMaxGainDb: 30,
  vadThreshold: 0.5,
  deepgram: { eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 5000 },
  ...extra
})

/**
 * Recognisers whose streams answer one `EndOfTurn` naming the instance and the stream's final silence, then end.
 * `failing` models cannot be built; a model in `holds` is built only once its gate opens; `kill(model)` makes a
 * built instance die (as a crashed worker).
 */
const fakeRecognisers = () => {
  const builds: Array<string> = []
  const released: Array<string> = []
  const streams: Array<{ instance: string; stream: SttStreamSpec }> = []
  const failing = new Set<string>()
  const holds = new Map<string, Deferred.Deferred<void>>()
  const killers = new Map<string, (problem: string) => void>()
  const build: SttBuilder = (spec) =>
    Effect.gen(function*() {
      const hold = holds.get(spec.model)
      if (hold !== undefined) yield* Deferred.await(hold)
      if (failing.has(spec.model)) return yield* new ResourceBuildError({ message: `The speech model ${spec.model} could not load.` })
      builds.push(spec.model)
      const name = `${spec.model}#${builds.length}`
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push(name)))
      let dead: string | undefined
      return {
        forStream: (stream): Stt["Service"] => ({
          transcribe: () =>
            Stream.suspend(() => {
              streams.push({ instance: name, stream })
              if (dead !== undefined) return Stream.fail(new SttError({ message: dead }))
              return Stream.fromIterable<SttEvent>([{ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: `${name} after ${stream.finalSilenceMs} ms` }])
            })
        }),
        onFailure: (listener) => {
          killers.set(spec.model, (problem) => {
            dead = problem
            listener(problem)
          })
        }
      } satisfies Recogniser
    })
  return { build, builds, released, streams, failing, holds, kill: (model: string, problem = "worker died") => killers.get(model)?.(problem) }
}

let scope: Scope.Closeable | undefined
afterEach(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void))
  scope = undefined
})
const makePool = async (buildStt: SttBuilder, graceMs = 60, onRebind?: () => void): Promise<ResourcePool> => {
  scope = Effect.runSync(Scope.make())
  return Effect.runPromise(Scope.provide(
    makeResourcePool({
      buildLlm: () => Effect.fail(new ResourceBuildError({ message: "no language models here" })),
      buildStt,
      graceMs,
      ...(onRebind !== undefined ? { onRebind } : {})
    }),
    scope
  ))
}
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
type Places = Record<string, { hearer: string; hearing: AssistantHearing }>
const places = (entries: Places) =>
  new Map(Object.entries(entries).map(([place, { hearer, hearing: h }]) => [place, { spec: sttSpecOf(h), hearer }]))
const reconcile = (pool: ResourcePool, entries: Places, options: { rebuild?: boolean; retryFailed?: boolean } = {}) =>
  run(pool.reconcile(new Map(), { ...options, recognisers: places(entries) }))
/** What `place` hears: the instance and the final silence its stream got. */
const hear = (pool: ResourcePool, place: string) =>
  run(Stream.runCollect(pool.sttFor(place)!.stt.transcribe(Stream.empty)).pipe(
    Effect.map((events) => {
      const last = events.at(-1)
      return last?._tag === "EndOfTurn" ? last.text : last?._tag
    })
  ))
const sttStatus = (pool: ResourcePool) => pool.status().filter((r) => r.kind === "stt")
const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

describe("resource pool: recognisers (WP-11)", () => {
  it("two hearers on one model with different end pauses share one instance; each place's stream has its own options", async () => {
    const fake = fakeRecognisers()
    const pool = await makePool(fake.build)
    await reconcile(pool, {
      "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2", { finalSilenceMs: 400 }) },
      "device:b": { hearer: "t3", hearing: hearing("parakeet-v2", { finalSilenceMs: 900, vadThreshold: 0.7, agc: false }) }
    })
    expect(fake.builds).toEqual(["parakeet-v2"])
    expect(pool.sttFor("device:a")!.key).toBe(pool.sttFor("device:b")!.key)
    expect(pool.sttFor("device:a")!.id).not.toBe(pool.sttFor("device:b")!.id)
    expect(await hear(pool, "device:a")).toBe("parakeet-v2#1 after 400 ms")
    expect(await hear(pool, "device:b")).toBe("parakeet-v2#1 after 900 ms")
    expect(fake.streams.map((s) => [s.stream.vadThreshold, s.stream.agc])).toEqual([[0.5, true], [0.7, false]])
    // The status lists one recogniser, used by both hearers, with the measured memory of the model (WP-0).
    expect(sttStatus(pool)).toEqual([
      expect.objectContaining({ kind: "stt", state: "ready", usedBy: ["jeff", "t3"], location: "local", ramMb: SherpaStt.presets["parakeet-v2"].ramMb })
    ])
  })

  it("two places with different models each hear with their own instance", async () => {
    const fake = fakeRecognisers()
    const pool = await makePool(fake.build)
    await reconcile(pool, {
      "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2") },
      "device:b": { hearer: "t3", hearing: hearing("nemotron-560") }
    })
    expect(fake.builds.sort()).toEqual(["nemotron-560", "parakeet-v2"])
    expect(await hear(pool, "device:a")).toMatch(/^parakeet-v2#\d after 600 ms$/)
    expect(await hear(pool, "device:b")).toMatch(/^nemotron-560#\d after 600 ms$/)
    expect(sttStatus(pool).map((r) => [r.key.split("|")[1], r.usedBy]).sort()).toEqual([["nemotron-560", ["t3"]], ["parakeet-v2", ["jeff"]]])
  })

  it("a changed model is built first: the place keeps its old instance until then; the old one goes after the grace", async () => {
    const fake = fakeRecognisers()
    let rebinds = 0
    const pool = await makePool(fake.build, 60, () => rebinds++)
    await reconcile(pool, { "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2") } })
    const before = pool.sttFor("device:a")!
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set("nemotron-560", gate)
    const switching = reconcile(pool, { "device:a": { hearer: "jeff", hearing: hearing("nemotron-560") } })
    await sleep(30)
    // Still building: the device goes on hearing with the old instance (same binding).
    expect(pool.sttFor("device:a")!.id).toBe(before.id)
    expect(await hear(pool, "device:a")).toBe("parakeet-v2#1 after 600 ms")
    const counted = rebinds
    Deferred.doneUnsafe(gate, Exit.void)
    await switching
    expect(pool.sttFor("device:a")!.id).not.toBe(before.id)
    expect(rebinds).toBeGreaterThan(counted)
    expect(await hear(pool, "device:a")).toBe("nemotron-560#2 after 600 ms")
    // parakeet is unused now, and released after the grace period (not before).
    expect(fake.released).toEqual([])
    expect(sttStatus(pool).find((r) => r.key.includes("parakeet"))?.state).toBe("unused")
    await until("parakeet released", () => fake.released.includes("parakeet-v2#1"))
    expect(sttStatus(pool).map((r) => r.key.split("|")[1])).toEqual(["nemotron-560"])
  })

  it("changed stream options rebind at once, with no new instance (no model load)", async () => {
    const fake = fakeRecognisers()
    const pool = await makePool(fake.build)
    await reconcile(pool, { "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2") } })
    const before = pool.sttFor("device:a")!
    await reconcile(pool, { "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2", { finalSilenceMs: 1200 }) } })
    expect(pool.sttFor("device:a")!.key).toBe(before.key)
    expect(pool.sttFor("device:a")!.id).not.toBe(before.id)
    expect(await hear(pool, "device:a")).toBe("parakeet-v2#1 after 1200 ms")
    expect(fake.builds).toEqual(["parakeet-v2"])
  })

  it("wanted again within the grace period: kept, not built again; a place with no hearer has no recogniser", async () => {
    const fake = fakeRecognisers()
    const pool = await makePool(fake.build, 200)
    await reconcile(pool, { "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2") } })
    await reconcile(pool, {})
    expect(pool.sttFor("device:a")).toBeUndefined()
    await sleep(50)
    await reconcile(pool, { "device:b": { hearer: "t3", hearing: hearing("parakeet-v2") } })
    await sleep(250)
    expect(fake.builds).toEqual(["parakeet-v2"])
    expect(fake.released).toEqual([])
    expect(await hear(pool, "device:b")).toBe("parakeet-v2#1 after 600 ms")
  })

  it("a model that fails to load is that resource's problem only: its place's streams fail with it, the other place hears; a retry builds it again", async () => {
    const fake = fakeRecognisers()
    fake.failing.add("whisper-turbo")
    const pool = await makePool(fake.build)
    const entries: Places = {
      "device:a": { hearer: "jeff", hearing: hearing("whisper-turbo") },
      "device:b": { hearer: "t3", hearing: hearing("parakeet-v2") }
    }
    await reconcile(pool, entries)
    expect(pool.sttFor("device:a")!.state).toBe("failed")
    expect(pool.sttFor("device:a")!.problem).toContain("could not load")
    const failed = await run(Effect.exit(Stream.runDrain(pool.sttFor("device:a")!.stt.transcribe(Stream.empty))))
    expect(failed._tag).toBe("Failure")
    expect(await hear(pool, "device:b")).toBe("parakeet-v2#1 after 600 ms")
    expect(sttStatus(pool).find((r) => r.key.includes("whisper"))).toMatchObject({ state: "failed", usedBy: ["jeff"], problem: expect.stringContaining("could not load") })
    // Fixed (the model downloaded), then a retry (vault unlock, the owner's reload).
    fake.failing.delete("whisper-turbo")
    await reconcile(pool, entries, { retryFailed: true })
    expect(pool.sttFor("device:a")!.state).toBe("ready")
    expect(await hear(pool, "device:a")).toMatch(/^whisper-turbo#\d after 600 ms$/)
  })

  it("an instance whose worker dies is marked failed (its streams fail), and a retry builds a new one", async () => {
    const fake = fakeRecognisers()
    let rebinds = 0
    const pool = await makePool(fake.build, 60, () => rebinds++)
    const entries: Places = { "device:a": { hearer: "jeff", hearing: hearing("parakeet-v2") } }
    await reconcile(pool, entries)
    const counted = rebinds
    fake.kill("parakeet-v2", "Speech worker exited with code 3")
    expect(rebinds).toBeGreaterThan(counted)
    expect(pool.sttFor("device:a")).toMatchObject({ state: "failed", problem: "Speech worker exited with code 3" })
    expect(sttStatus(pool)[0]).toMatchObject({ state: "failed" })
    await reconcile(pool, entries, { retryFailed: true })
    expect(pool.sttFor("device:a")!.state).toBe("ready")
    expect(await hear(pool, "device:a")).toBe("parakeet-v2#2 after 600 ms")
  })

  it("keys: the language counts only for a model that takes one; Deepgram is keyed by its shared model and address", () => {
    const key = (h: AssistantHearing) => sttKeyOf(sttSpecOf(h))
    expect(key(hearing("parakeet-v2", { language: "nl" }))).toBe(key(hearing("parakeet-v2", { language: "en" })))
    expect(key(hearing("whisper-turbo", { language: "nl" }))).not.toBe(key(hearing("whisper-turbo", { language: "en" })))
    expect(key(hearing("nemotron-3.5"))).toBe(key(hearing(SherpaStt.resolvePresetName("nemotron-3.5")!)))
    const dg = (h: AssistantHearing, model?: string): SttSpec => sttSpecOf(h, { deepgram: { model, credential: "x" } })
    expect(sttKeyOf(dg(hearing("parakeet-v2", { engine: "deepgram" })))).toBe("deepgram|flux-general-en|wss://api.deepgram.com/v2/listen")
    expect(sttKeyOf(dg(hearing("whisper-turbo", { engine: "deepgram", finalSilenceMs: 900 })))).toBe(sttKeyOf(dg(hearing("parakeet-v2", { engine: "deepgram" }))))
    expect(sttKeyOf(dg(hearing("parakeet-v2", { engine: "deepgram" }), "flux-general-nl"))).toContain("flux-general-nl")
  })
})

/** A model directory with empty stand-ins for every file the preset needs (stt-sherpa's stand-in worker reads none). */
const fakeModelDir = (preset: SherpaStt.PresetName) => {
  const dir = mkdtempSync(join(tmpdir(), "pva-fake-models-"))
  const needed = modelFilesOf(preset, dir)
  for (const file of needed) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "")
  }
  return dir
}
const modelFilesOf = (preset: SherpaStt.PresetName, dir: string): Array<string> => {
  const p = SherpaStt.presets[preset]
  const models = p.kind === "hybrid" ? [p.streaming, p.offline] : [p.model]
  const out = [join(dir, "silero_vad.onnx")]
  for (const m of models) {
    const fields = ["encoder", "decoder", "joiner", "tokens"] as const
    for (const f of fields) {
      const name = (m as unknown as Record<string, string | undefined>)[f]
      if (name !== undefined) out.push(join(dir, m.archive.dir, name))
    }
  }
  return out
}

describe("resource pool: the default recogniser builder on stt-sherpa (stand-in worker)", () => {
  const fakeWorker = new URL("../../../packages/stt-sherpa/test/fake-worker.mjs", import.meta.url)

  it("two places on one model share one worker, each with its own timing; a second model is a second worker; both stop with their last user", async () => {
    const dir = fakeModelDir("parakeet-v2")
    const before = SherpaStt.workers()
    const builder = defaultSttBuilder(() => ConfigProvider.fromEnvRecord({}), { url: fakeWorker, data: { wordsOfAudio: true, decodeMs: 5 } })
    const pool = await makePool(builder)
    const h = (extra: Partial<AssistantHearing>) => ({ ...hearing("parakeet-v2", { agc: false, ...extra }) })
    const spec = (place: string, finalSilenceMs: number) => [place, { spec: { ...sttSpecOf(h({ finalSilenceMs, eagerSilenceMs: 150 })), modelDir: dir }, hearer: place }] as const
    await run(pool.reconcile(new Map(), { recognisers: new Map([spec("device:a", 300), spec("device:b", 900)]) }))
    expect(SherpaStt.workers() - before).toBe(1)
    const audio = () => {
      const chunks: Array<Uint8Array> = []
      for (const [amplitude, ms] of [[8, 300], [0, 500], [6, 300], [0, 1_200]] as const) {
        for (let t = 0; t < ms; t += 20) chunks.push(new Uint8Array(new Int16Array(320).fill(amplitude * 1000).buffer))
      }
      return Stream.fromIterable(chunks)
    }
    const turnsOf = (place: string) =>
      run(Stream.runCollect(pool.sttFor(place)!.stt.transcribe(audio())).pipe(
        Effect.map((events) => [...events].flatMap((e) => (e._tag === "EndOfTurn" ? [e.text] : [])))
      ))
    const [a, b] = await Promise.all([turnsOf("device:a"), turnsOf("device:b")])
    expect(a).toEqual(["w8", "w6"])
    expect(b).toEqual(["w8 w6"])

    // Device b moves to another model: a second worker; the first stays for device a.
    const other = fakeModelDir("parakeet-v2")
    await run(pool.reconcile(new Map(), {
      recognisers: new Map([spec("device:a", 300), ["device:b", { spec: { ...sttSpecOf(h({})), modelDir: other }, hearer: "device:b" }] as const])
    }))
    expect(SherpaStt.workers() - before).toBe(2)
    await run(pool.reconcile(new Map(), { recognisers: new Map() }))
    await until("both workers stopped", () => SherpaStt.workers() === before)
  })
})
