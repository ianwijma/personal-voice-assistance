// Serve mode's per-device recogniser (docs/ASSISTANTS.md §2.6 "The device's recogniser", §3.2, §3.5, WP-11) against
// the real server with the scripted client: each device hears with its hearer's model (the assistant that answers
// without a phrase, else the first in its list) and stream options; a hearer change builds the new recogniser
// first and switches at the next silence; a device without assistants runs none; a model that fails is that
// recogniser's problem only.
import type { SttEvent } from "@pva/core"
import { sttContractKeeper } from "@pva/core/testing"
import type { Assistant, AssistantHearing, DeviceOwn, ServerMessageOf } from "@pva/protocol"
import { Deferred, Effect, Exit, Queue, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Recogniser, ResourceBuildError, type SttBuilder, type SttStreamSpec } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

interface OpenStream {
  readonly model: string
  readonly instance: string
  readonly stream: SttStreamSpec
  readonly queue: Queue.Queue<SttEvent>
  readonly keep: ReturnType<typeof sttContractKeeper>
  closed: boolean
}

/**
 * Recognisers by model ("model-a#1"): every `transcribe` is a stream the test drives (`emit`), recorded with its
 * model and stream options. A model in `holds` is built only once its gate opens; one in `failing` cannot be built.
 */
const fakeRecognisers = () => {
  const builds: Array<string> = []
  const streams: Array<OpenStream> = []
  const holds = new Map<string, Deferred.Deferred<void>>()
  const failing = new Set<string>()
  const build: SttBuilder = (spec) =>
    Effect.gen(function*() {
      const hold = holds.get(spec.model)
      if (hold !== undefined) yield* Deferred.await(hold)
      if (failing.has(spec.model)) return yield* new ResourceBuildError({ message: `The speech model ${spec.model} could not load.` })
      builds.push(spec.model)
      const instance = `${spec.model}#${builds.length}`
      return {
        forStream: (stream) => ({
          transcribe: (audio) =>
            Stream.suspend(() => {
              const entry: OpenStream = { model: spec.model, instance, stream, queue: Effect.runSync(Queue.unbounded<SttEvent>()), keep: sttContractKeeper(), closed: false }
              streams.push(entry)
              return Stream.merge(audio.pipe(Stream.drain, Stream.orDie), Stream.fromQueue(entry.queue)).pipe(
                Stream.ensuring(Effect.sync(() => {
                  entry.closed = true
                }))
              )
            })
        })
      } satisfies Recogniser
    })
  const open = () => streams.filter((s) => !s.closed)
  const emit = (entry: OpenStream, ...events: Array<SttEvent>) => (entry.keep(events) as Array<SttEvent>).forEach((e) => Queue.offerUnsafe(entry.queue, e))
  return { build, builds, streams, open, holds, failing, emit }
}

const baseHearing = (model: string, extra: Partial<AssistantHearing> = {}): AssistantHearing => ({
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

/** Alpha (hears with model-a) and Bravo (model-b) on the browser defaults: Alpha first, nobody without a phrase. */
const twoHearers = async (withoutPhrase: Record<string, unknown> = { mode: "nobody" }): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-recognisers-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  const base = file.assistants.byId[file.assistants.order[0]]
  const make = (id: string, name: string, model: string) => ({ ...base, id, rev: 0, name, prompt: `You are ${name}.`, hearing: baseHearing(model) })
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha: make("alpha", "Alpha", "model-a"), bravo: make("bravo", "Bravo", "model-b") } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (
  fake: ReturnType<typeof fakeRecognisers>,
  { withoutPhrase, ...extra }: { hearerSwitchWaitMs?: number; freeMemoryBytes?: () => number; env?: Record<string, string>; withoutPhrase?: Record<string, unknown> } = {}
) => {
  server = await startTestServer({
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm((t) => `Heard ${t}`).llm }),
    buildStt: fake.build,
    resourceGraceMs: 100,
    dataDir: await twoHearers(withoutPhrase),
    ...extra
  })
}

/** A fake TypeSafe (`/v1/systemone`) that picks Alpha after `delayMs`, and the `start` options that route by it. */
const slowTypeSafe = async (delayMs: number) => {
  const jev = Http.createServer((req, res) => {
    req.resume()
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ model: "jev-1", answers: { assistant: { type: "choice", choice: "alpha", confidence: 0.9, probabilities: { alpha: 0.9, bravo: 0.1 } }, fits: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }))
    }, delayMs))
  })
  await new Promise<void>((resolve) => jev.listen(0, "127.0.0.1", resolve))
  return {
    options: {
      env: { TYPESAFE_ROUTING: "true", TYPESAFE_API_KEY: "ts-test-key", TYPESAFE_BASE_URL: `http://127.0.0.1:${(jev.address() as AddressInfo).port}` },
      withoutPhrase: { mode: "typesafe", fallback: "alpha", giveUpMs: 2_000 }
    },
    close: () => {
      jev.closeAllConnections()
      jev.close()
    }
  }
}

const connect = async (deviceId?: string) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...(deviceId !== undefined ? { deviceId } : {}) })
  clients.push(client)
  return client
}
/** A device with a live microphone (its session exists and its recogniser stream runs). */
const device = async (id: string) => {
  const client = await connect(id)
  await client.hello()
  await client.claim()
  return client
}

const until = async (what: string, check: () => boolean, ms = 3_000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

const assistantOf = (id: string): Assistant => server!.handle.store.assistants().find((a) => a.id === id)!
const saveHearing = (id: string, hearing: Partial<AssistantHearing>) => {
  const a = assistantOf(id)
  return Effect.runPromise(server!.handle.store.saveAssistantRecord({ ...a, hearing: { ...a.hearing, ...hearing } }))
}
const saveOwn = async (deviceId: string, own: DeviceOwn) => {
  // The device is recorded at its hello, in the background.
  await until(`device ${deviceId} recorded`, () => server!.handle.store.settings().devices[deviceId] !== undefined)
  const record = server!.handle.store.settings().devices[deviceId]!
  await Effect.runPromise(server!.handle.store.saveDevice(deviceId, record.rev, { own: { ...record.own, ...own } }))
  // As the hub does after a `device.save`: the session's route configuration follows.
  server!.handle.sessions.all().find((s) => s.deviceId === deviceId)?.syncProfile()
}
const sessionOf = (deviceId: string) => server!.handle.sessions.all().find((s) => s.deviceId === deviceId)!
/** The open stream of `deviceId`'s session (its recogniser's key names the model). */
const streamOf = (fake: ReturnType<typeof fakeRecognisers>, deviceId: string) => {
  const key = sessionOf(deviceId).hearingKey()
  return key === undefined ? undefined : fake.open().find((s) => key.includes(`|${s.model}|`))
}

describe("serve: one recogniser per device, from its hearer (WP-11)", () => {
  it("devices with different hearers hear with their own model; hearers on one model share one instance with their own end pauses", async () => {
    const fake = fakeRecognisers()
    await start(fake)
    // Built before anyone connects: the browser defaults' hearer (Alpha: model-a).
    expect(fake.builds).toEqual(["model-a"])
    const a = await device("device-a")
    const b = await device("device-b")
    // Device B answers with Bravo without a phrase: Bravo hears there (§2.6).
    await saveOwn("device-b", { withoutPhrase: { mode: "assistant", assistant: "bravo" } })
    await until("device-b on model-b", () => streamOf(fake, "device-b")?.model === "model-b")
    expect(fake.builds.sort()).toEqual(["model-a", "model-b"])
    expect(sessionOf("device-a").hearingKey()).toContain("|model-a|")
    expect(fake.open().map((s) => s.model).sort()).toEqual(["model-a", "model-b"])

    // Each device's words reach its own conversation through its own recogniser.
    fake.emit(streamOf(fake, "device-b")!, { _tag: "EndOfTurn", text: "hello from b" })
    const endB = await b.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    expect(b.messages.find((m): m is ServerMessageOf<"turn.start"> => m.type === "turn.start" && m.turnId === endB.turnId)?.assistantId).toBe("bravo")
    fake.emit(streamOf(fake, "device-a")!, { _tag: "EndOfTurn", text: "hey alpha, hello from a" })
    await a.waitFor("turn.end", () => true, { timeoutMs: 10_000 })

    // Bravo moves to Alpha's model with a longer end pause: device B joins the model-a instance (nothing is built,
    // model-b is released after the grace period), its stream with Bravo's own timing.
    await saveHearing("bravo", { model: "model-a", finalSilenceMs: 900 })
    await until("device-b on model-a", () => fake.open().some((s) => s.model === "model-a" && s.stream.finalSilenceMs === 900))
    expect(fake.builds.sort()).toEqual(["model-a", "model-b"])
    expect(sessionOf("device-b").hearingKey()).toBe(sessionOf("device-a").hearingKey())
    // Two streams on one instance, each with its own end pause.
    expect(fake.open().map((s) => [s.instance, s.stream.finalSilenceMs]).sort()).toEqual([["model-a#1", 600], ["model-a#1", 900]])
    await until("model-b released", () => !server!.handle.resources.status().some((r) => r.kind === "stt" && r.key.includes("|model-b|")))
    const stt = server!.handle.resources.status().filter((r) => r.kind === "stt")
    expect(stt).toEqual([expect.objectContaining({ state: "ready", usedBy: ["alpha", "bravo"] })])
    // No engine reload.
    expect(server!.handle.engine.status().state).toBe("ready")
  })

  it("a hearer switch builds the new model first and waits for silence: never mid-utterance", async () => {
    const fake = fakeRecognisers()
    await start(fake)
    await device("device-a")
    await until("device-a hearing", () => streamOf(fake, "device-a") !== undefined)
    const old = streamOf(fake, "device-a")!
    // The owner starts talking.
    fake.emit(old, { _tag: "SpeechStarted" }, { _tag: "Interim", text: "hey alpha what" })
    const gate = Deferred.makeUnsafe<void>()
    fake.holds.set("model-c", gate)
    await saveHearing("alpha", { model: "model-c" })
    await sleep(150)
    // 1. The new model is still loading: the device keeps hearing with the old one.
    expect(old.closed).toBe(false)
    expect(sessionOf("device-a").hearingKey()).toContain("|model-a|")
    Deferred.doneUnsafe(gate, Exit.void)
    await until("model-c ready", () => server!.handle.resources.status().some((r) => r.key.includes("|model-c|") && r.state === "ready"))
    await sleep(150)
    // 2. Loaded, but an utterance is open: still the old stream.
    expect(old.closed).toBe(false)
    // 3. The utterance ends: the stream is replaced at once.
    fake.emit(old, { _tag: "EndOfTurn", text: "hey alpha what time is it" })
    await until("switched to model-c", () => streamOf(fake, "device-a")?.model === "model-c")
    expect(old.closed).toBe(true)
    // The utterance that was open was not cut: it reached Alpha's conversation whole.
    const client = clients.at(-1)!
    await client.waitFor("turn.end", () => true, { from: 0, timeoutMs: 10_000 })
    expect(client.messages.some((m) => m.type === "assistant.text" && m.text.includes("what time is it"))).toBe(true)
  })

  it("an utterance that does not end within the wait is closed (it starts nothing) and the switch happens", async () => {
    const fake = fakeRecognisers()
    await start(fake, { hearerSwitchWaitMs: 300 })
    await device("device-a")
    await until("device-a hearing", () => streamOf(fake, "device-a") !== undefined)
    const old = streamOf(fake, "device-a")!
    fake.emit(old, { _tag: "SpeechStarted" })
    await saveHearing("alpha", { model: "model-c" })
    await until("model-c ready", () => server!.handle.resources.status().some((r) => r.key.includes("|model-c|") && r.state === "ready"))
    await sleep(100)
    expect(old.closed).toBe(false)
    await until("switched to model-c", () => streamOf(fake, "device-a")?.model === "model-c", 3_000)
    expect(old.closed).toBe(true)
  })

  it("an utterance closed by the switch takes its times with it: the next utterance's time line starts when it was heard", async () => {
    const fake = fakeRecognisers()
    await start(fake, { hearerSwitchWaitMs: 300 })
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const client = await device("device-a")
    await until("device-a hearing", () => streamOf(fake, "device-a") !== undefined)
    const old = streamOf(fake, "device-a")!
    fake.emit(old, { _tag: "SpeechStarted" }, { _tag: "Interim", text: "hey alpha what" })
    await saveHearing("alpha", { model: "model-c" })
    await until("switched to model-c", () => streamOf(fake, "device-a")?.model === "model-c", 3_000)
    await sleep(1_500)
    const from = client.messages.length
    const adminFrom = admin.messages.length
    fake.emit(streamOf(fake, "device-a")!, { _tag: "SpeechStarted" })
    await sleep(100)
    fake.emit(streamOf(fake, "device-a")!, { _tag: "Interim", text: "hey alpha what time" }, { _tag: "EndOfTurn", text: "hey alpha what time is it" })
    const begun = await client.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
    const line = trace.timeline!
    const startedAt = line.find((x) => x.name === "speechStarted")!.at
    const firstInterimAt = line.find((x) => x.name === "firstInterim")!.at
    // This utterance's own start (~100 ms before its end), not the closed one's (more than 1.5 s before, by the sleep):
    // a margin only a reused start can cross.
    expect(startedAt).toBeGreaterThan(-1_000)
    expect(startedAt).toBeLessThan(0)
    expect(firstInterimAt).toBeGreaterThan(startedAt)
  })

  it("a start the old stream stamped but never delivered (dispatch busy with a routing call) gives the next stream's utterance no times", async () => {
    // TypeSafe answers after 400 ms: the final below keeps the session's dispatch busy while the next start comes in.
    const jev = await slowTypeSafe(400)
    try {
      const fake = fakeRecognisers()
      await start(fake, { hearerSwitchWaitMs: 300, ...jev.options })
      const admin = await connect()
      await admin.admin(TEST_ADMIN_PASSWORD)
      const client = await device("device-a")
      await until("device-a hearing", () => streamOf(fake, "device-a") !== undefined)
      const old = streamOf(fake, "device-a")!
      fake.emit(old, { _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "what is the weather" })
      await sleep(50)
      // Stamped on arrival, still queued behind the routing call; then the switch replaces the stream.
      fake.emit(old, { _tag: "SpeechStarted" }, { _tag: "Interim", text: "and tomorrow" })
      await sleep(20)
      await saveHearing("alpha", { model: "model-c" })
      await until("switched to model-c", () => streamOf(fake, "device-a")?.model === "model-c", 3_000)
      await sleep(1_500)
      const from = client.messages.length
      const adminFrom = admin.messages.length
      fake.emit(streamOf(fake, "device-a")!, { _tag: "SpeechStarted" })
      await sleep(100)
      fake.emit(streamOf(fake, "device-a")!, { _tag: "Interim", text: "what time" }, { _tag: "EndOfTurn", text: "what time is it" })
      const begun = await client.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
      const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
      const line = trace.timeline!
      const startedAt = line.find((x) => x.name === "speechStarted")!.at
      const firstInterimAt = line.find((x) => x.name === "firstInterim")!.at
      // Its own start, ~100 ms before its end plus the routing call (400 ms); the dropped start was more than 1.5 s
      // before this one (the sleep): a margin only a reused start can cross.
      expect(startedAt).toBeGreaterThan(-1_300)
      expect(firstInterimAt).toBeGreaterThan(startedAt)
    } finally {
      jev.close()
    }
  })

  it("an engine reload while a final awaits TypeSafe closes that utterance: the next one (by its phrase) gets its own start", async () => {
    const jev = await slowTypeSafe(600)
    try {
      const fake = fakeRecognisers()
      await start(fake, jev.options)
      const admin = await connect()
      await admin.admin(TEST_ADMIN_PASSWORD)
      const client = await device("device-a")
      await until("device-a hearing", () => streamOf(fake, "device-a") !== undefined)
      const old = streamOf(fake, "device-a")!
      fake.emit(old, { _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "what is the weather" })
      await sleep(50)
      // While the routing call is pending: nobody answers without a phrase now, and the engines reload.
      await saveOwn("device-a", { withoutPhrase: { mode: "nobody" } })
      expect((await Effect.runPromise(server!.handle.engine.reload)).ok).toBe(true)
      await until("a new stream", () => streamOf(fake, "device-a") !== undefined && streamOf(fake, "device-a") !== old, 5_000)
      await sleep(1_500)
      const from = client.messages.length
      const adminFrom = admin.messages.length
      const now = streamOf(fake, "device-a")!
      fake.emit(now, { _tag: "SpeechStarted" })
      await sleep(100)
      fake.emit(now, { _tag: "Interim", text: "hey alpha what time" }, { _tag: "EndOfTurn", text: "hey alpha what time is it" })
      const begun = await client.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
      expect(begun).toMatchObject({ assistantId: "alpha" })
      const trace = (await admin.waitFor("trace", (m) => m.trace.turnId === begun.turnId, { from: adminFrom, timeoutMs: 10_000 })).trace
      expect(trace.route).toMatchObject({ by: "phrase" })
      const line = trace.timeline!
      const startedAt = line.find((x) => x.name === "speechStarted")!.at
      // Its own start (~100 ms before its end), not the reloaded-away utterance's (more than 1.5 s before, by the
      // sleep): a margin only a reused start can cross.
      expect(startedAt).toBeGreaterThan(-1_000)
      expect(line.find((x) => x.name === "firstInterim")!.at).toBeGreaterThan(startedAt)
    } finally {
      jev.close()
    }
  })

  it("an utterance closed by the switch holds the turn no longer: its assistant is not reported while the hearing tail lasts", async () => {
    const fake = fakeRecognisers()
    await start(fake, { hearerSwitchWaitMs: 300 })
    await device("device-a")
    await until("device-a hearing", () => streamOf(fake, "device-a") !== undefined)
    const old = streamOf(fake, "device-a")!
    // "hey alpha what…" is heard as Alpha's (no window opens before its end).
    fake.emit(old, { _tag: "SpeechStarted" }, { _tag: "Interim", text: "hey alpha what" })
    await until("heard as Alpha's", () => sessionOf("device-a").holder() === "alpha")
    await saveHearing("alpha", { model: "model-c" })
    await until("switched to model-c", () => streamOf(fake, "device-a")?.model === "model-c", 3_000)
    // Closed without its end (it starts nothing): nobody has the turn, at once, not when the 2 s tail runs out.
    expect(sessionOf("device-a").holder()).toBeNull()
  })

  it("a device with no assistants runs no recogniser; one assigned later starts it", async () => {
    const fake = fakeRecognisers()
    await start(fake)
    const client = await connect("device-empty")
    await client.hello()
    await saveOwn("device-empty", { assistants: [], withoutPhrase: { mode: "nobody" } })
    const before = fake.streams.length
    await client.claim()
    await sleep(200)
    expect(sessionOf("device-empty").hearingKey()).toBeUndefined()
    expect(fake.streams.length).toBe(before)
    await saveOwn("device-empty", { assistants: [{ assistant: "bravo", phrases: [] }], withoutPhrase: { mode: "assistant", assistant: "bravo" } })
    await until("device-empty on model-b", () => streamOf(fake, "device-empty")?.model === "model-b")
  })

  it("a model that fails to load: that device hears nothing and is told once, typed text still works, the other device hears; admin sees the failed resource and the hearer's problem", async () => {
    const fake = fakeRecognisers()
    fake.failing.add("model-bad")
    await start(fake)
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const a = await device("device-a")
    const b = await device("device-b")
    await saveOwn("device-b", { withoutPhrase: { mode: "assistant", assistant: "bravo" } })
    await saveHearing("bravo", { model: "model-bad" })
    const error = await b.waitFor("error", (m) => m.error.code === "engine_failed", { from: 0, timeoutMs: 5_000 })
    expect(error.error.message).toContain("model-bad could not load")
    expect(sessionOf("device-b").hearingKey()).toBeUndefined()
    // Typed text is answered on device B.
    b.send({ type: "text.send", requestId: "t1", text: "typed", speak: false, assistantId: "bravo" })
    expect((await b.waitFor("turn.end", () => true, { timeoutMs: 10_000 })).outcome).toBe("completed")
    // Device A still hears.
    fake.emit(streamOf(fake, "device-a")!, { _tag: "EndOfTurn", text: "hey alpha, still here" })
    await a.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    // Admin: the failed recogniser with its problem; Bravo's problems name it.
    const failed = server!.handle.resources.status().find((r) => r.kind === "stt" && r.key.includes("model-bad"))
    expect(failed).toMatchObject({ state: "failed", usedBy: ["bravo"] })
    // A save (any) pushes `assistants`: Bravo's problems name its recogniser.
    const from = admin.messages.length
    admin.send({ type: "assistant.save", requestId: "s1", assistant: assistantOf("alpha") })
    expect((await admin.waitFor("result", (m) => m.requestId === "s1", { from })).ok).toBe(true)
    const pushed = await admin.waitFor("assistants", () => true, { from })
    expect(pushed.assistants.find((x) => x.id === "bravo")!.problems).toContainEqual(expect.stringMatching(/^Hearing \(Speech model model-bad\): .*could not load/))
    expect(pushed.assistants.find((x) => x.id === "alpha")!.problems.some((p) => p.startsWith("Hearing"))).toBe(false)
    // Back on a working model: device B hears again.
    await saveHearing("bravo", { model: "model-b" })
    await until("device-b on model-b", () => streamOf(fake, "device-b")?.model === "model-b")
  })

  it("a change that would load a model needing more than 75 % of the free memory asks for Save anyway", async () => {
    const fake = fakeRecognisers()
    // 1 GB free: parakeet-v2 (about 1050 MB, WP-0) needs more than 75 % of it.
    await start(fake, { freeMemoryBytes: () => 1e9 })
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const alpha = assistantOf("alpha")
    admin.send({ type: "assistant.save", requestId: "s1", assistant: { ...alpha, hearing: { ...alpha.hearing, model: "parakeet-v2" } } })
    const refused = await admin.waitFor("result", (m) => m.requestId === "s1")
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("invalid_settings")
    expect(refused.error?.message).toMatch(/about 1050 MB more memory and 1\.6 s to load, more than 75 % of the 1000 MB free/)
    expect(refused.error?.warnings?.[0]?.key).toBe("hearing.model")
    admin.send({ type: "assistant.save", requestId: "s2", assistant: { ...alpha, hearing: { ...alpha.hearing, model: "parakeet-v2" } }, saveAnyway: true })
    expect((await admin.waitFor("result", (m) => m.requestId === "s2")).ok).toBe(true)
    await until("parakeet built", () => fake.builds.includes("parakeet-v2"))
    // A model already loaded costs nothing more: no warning.
    const bravo = assistantOf("bravo")
    admin.send({ type: "assistant.save", requestId: "s3", assistant: { ...bravo, hearing: { ...bravo.hearing, model: "parakeet-v2" } } })
    expect((await admin.waitFor("result", (m) => m.requestId === "s3")).ok).toBe(true)
  })

  it("new type defaults are checked against the devices that inherit them: a device whose hearer changes warns too", async () => {
    const fake = fakeRecognisers()
    await start(fake, { freeMemoryBytes: () => 1e9 })
    const store = server!.handle.store
    // The browser defaults answer without a phrase with Alpha (model-a, loaded).
    const stored = store.settings().deviceTypes["web-voice"]!
    await Effect.runPromise(store.saveDeviceType("web-voice", stored.rev, { ...stored, withoutPhrase: { mode: "assistant", assistant: "alpha" } }))
    // Device X lists Bravo first but inherits that answerer: it hears with Alpha. Bravo's parakeet-v2 is not loaded.
    await device("device-x")
    await saveOwn("device-x", { assistants: [{ assistant: "bravo", phrases: ["hey bravo"] }, { assistant: "alpha", phrases: ["hey alpha"] }] })
    await saveHearing("bravo", { model: "parakeet-v2" })
    expect(fake.builds).not.toContain("parakeet-v2")
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    // Nobody without a phrase: the defaults still hear with Alpha, but device X now hears with Bravo (parakeet-v2).
    const rev = store.settings().deviceTypes["web-voice"]!.rev
    admin.send({ type: "device.save", requestId: "t1", target: { kind: "type", type: "web-voice" }, rev, settings: { withoutPhrase: { mode: "nobody" } } })
    const refused = await admin.waitFor("result", (m) => m.requestId === "t1")
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("invalid_settings")
    expect(refused.error?.message).toMatch(/about 1050 MB more memory/)
  })
})
