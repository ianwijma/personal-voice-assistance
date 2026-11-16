// Per-assistant voices through the real server with the scripted client (docs/ASSISTANTS.md §3.2, WP-10): each
// assistant's conversation speaks with the voice of its own `voice` settings (the trace's `voices`, the reply's rate),
// equal voices share one instance, a changed voice applies at that assistant's next turn without a reload and without
// interrupting a turn speaking elsewhere, unused voices go after the grace period, and a failing voice is a failed
// resource that fails that assistant's turns only.
import { Llm, type LlmEvent, Tts, type TtsAudio } from "@pva/core"
import type { Assistant, ServerMessage, ServerMessageOf, TraceInfo } from "@pva/protocol"
import { Deferred, Effect, Exit, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type LlmBuilder, ResourceBuildError, type TtsBuilder, ttsKeyOf } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const PIPER = "sherpa:en_US-lessac-medium"
const KOKORO = "sherpa:kokoro-af_heart"
const DUTCH = "sherpa:nl_NL-pim-medium"

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const echoLlm: LlmBuilder = () =>
  Effect.succeed(Llm.of({
    stream: (request) => {
      const last = request.messages.at(-1)
      const text = last?.role === "user" ? last.content : ""
      return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: `You said ${text}. `}, { _tag: "Done", stopReason: "end" }])
    }
  }))

/**
 * Voices that speak 200 ms of silence per clause at their engine's rate (Kokoro 24 kHz, the others 22.05 kHz). A voice
 * in `holds` waits for its gate before its first audio (a turn in progress); a voice in `buildHolds` is still being
 * built until its gate opens; a voice in `failing` cannot be built.
 */
const fakeVoices = () => {
  const builds: Array<string> = []
  const released: Array<string> = []
  const holds = new Map<string, Deferred.Deferred<void>>()
  const buildHolds = new Map<string, Deferred.Deferred<void>>()
  const failing = new Set<string>()
  const build: TtsBuilder = (spec) =>
    Effect.gen(function*() {
      const key = ttsKeyOf(spec)
      if (failing.has(key)) return yield* new ResourceBuildError({ message: `The voice ${spec.voice.voiceId} could not start.` })
      builds.push(key)
      const building = buildHolds.get(key)
      if (building !== undefined) yield* Deferred.await(building)
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push(key)))
      const sampleRate = spec.voice.voiceId.startsWith("kokoro") ? 24_000 : 22_050
      return Tts.of({
        sampleRate,
        synthesize: (clauses) =>
          clauses.pipe(
            Stream.zipWithIndex,
            Stream.mapEffect(([, clause]) =>
              Effect.gen(function*() {
                const hold = holds.get(key)
                if (hold !== undefined) yield* Deferred.await(hold)
                return { audio: new Uint8Array(Math.round(sampleRate * 0.2) * 2), clause } satisfies TtsAudio
              })
            )
          )
      })
    })
  return { build, builds, released, holds, buildHolds, failing }
}

/** A data directory with Alpha (voice `alpha`) and Bravo (voice `bravo`) on the browser defaults; Bravo off with `bravoOff`. */
const withVoices = async (voices: { alpha: string; bravo: string }, bravoOff = false): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-voices-pool-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  const base = file.assistants.byId[file.assistants.order[0]]
  const voice = (key: string) => ({ provider: key.slice(0, key.indexOf(":")), voiceId: key.slice(key.indexOf(":") + 1) })
  const make = (id: "alpha" | "bravo", name: string) => ({ ...base, id, rev: 0, name, prompt: `You are ${name}.`, voice: voice(voices[id]) })
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha: make("alpha", "Alpha"), bravo: { ...make("bravo", "Bravo"), ...(bravoOff ? { on: false } : {}) } } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" }
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (dataDir: string, voices: ReturnType<typeof fakeVoices>) => {
  server = await startTestServer({
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "the build's model").llm }),
    buildLlm: echoLlm,
    buildTts: voices.build,
    resourceGraceMs: 100,
    dataDir
  })
}

const connect = async (deviceId?: string) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...(deviceId !== undefined ? { deviceId } : {}) })
  clients.push(client)
  return client
}

/** A device that owns the audio of its page, to hear spoken replies. */
const owner = async (deviceId: string) => {
  const client = await connect(deviceId)
  await client.hello()
  await client.claim()
  return client
}

interface Spoken {
  readonly end: ServerMessageOf<"turn.end">
  readonly turnId: number
  /** The voice key of each clause (`assistant.text.voice`) and the reply's sample rate. */
  readonly voices: ReadonlyArray<string>
  readonly sampleRate: number | undefined
  readonly errors: ReadonlyArray<string>
}

/** `text` spoken to `assistantId` on `client`'s device; resolves when the turn has ended. */
const spoken = (client: ScriptedClient, assistantId: string, text: string, id: string): Promise<Spoken> => {
  const from = client.messages.length
  client.send({ type: "text.send", requestId: id, text, speak: true, assistantId })
  return (async () => {
    expect((await client.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
    const start = await client.waitFor("turn.start", (m) => m.assistantId === assistantId, { from, timeoutMs: 10_000 })
    const end = await client.waitFor("turn.end", (m) => m.turnId === start.turnId, { from, timeoutMs: 15_000 })
    const mine = client.messages.slice(from)
    return {
      end,
      turnId: start.turnId,
      voices: [...new Set(mine.flatMap((m: ServerMessage) => (m.type === "assistant.text" && m.turnId === end.turnId && m.voice !== undefined ? [m.voice] : [])))],
      sampleRate: mine.find((m): m is ServerMessageOf<"reply.start"> => m.type === "reply.start" && m.turnId === end.turnId)?.sampleRate,
      errors: mine.flatMap((m: ServerMessage) => (m.type === "error" ? [m.error.code] : []))
    }
  })()
}

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

const assistantOf = (id: string): Assistant => server!.handle.store.assistants().find((a) => a.id === id)!
const saveVoice = (id: string, key: string) => {
  const a = assistantOf(id)
  return Effect.runPromise(server!.handle.store.saveAssistantRecord({ ...a, voice: { provider: key.slice(0, key.indexOf(":")), voiceId: key.slice(key.indexOf(":") + 1) } }))
}
const ttsStatus = () => server!.handle.resources.status().filter((r) => r.kind === "tts")

/** The traces an admin connection receives, by turn id. */
const traces = (admin: ScriptedClient): Map<number, TraceInfo> =>
  new Map(admin.messages.flatMap((m: ServerMessage) => (m.type === "trace" ? [[m.trace.turnId, m.trace] as const] : [])))

describe("serve: voices from the resource pool (WP-10)", () => {
  it("two assistants with different voices speak in turn on one device, each with its own; the trace names the voice; the status lists both", async () => {
    const voices = fakeVoices()
    await start(await withVoices({ alpha: PIPER, bravo: KOKORO }), voices)
    expect(voices.builds.sort()).toEqual([PIPER, KOKORO]) // built before the first turn
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    expect((welcome.snapshot.engine.resources ?? []).filter((r) => r.kind === "tts").map((r) => [r.key, r.state, r.usedBy]).sort()).toEqual([
      [PIPER, "ready", ["alpha"]],
      [KOKORO, "ready", ["bravo"]]
    ])
    const device = await owner("device-a")
    const a = await spoken(device, "alpha", "hello alpha", "t1")
    const b = await spoken(device, "bravo", "hello bravo", "t2")
    const a2 = await spoken(device, "alpha", "alpha again", "t3")
    expect([a.end.outcome, b.end.outcome, a2.end.outcome]).toEqual(["completed", "completed", "completed"])
    expect([a.voices, b.voices, a2.voices]).toEqual([[PIPER], [KOKORO], [PIPER]])
    expect([a.sampleRate, b.sampleRate, a2.sampleRate]).toEqual([22_050, 24_000, 22_050]) // no resampling: each at its own rate
    await until("traces", () => traces(admin).size === 3)
    expect([a, b, a2].map((t) => traces(admin).get(t.turnId)?.voices)).toEqual([[PIPER], [KOKORO], [PIPER]])
    expect([a, b, a2].map((t) => traces(admin).get(t.turnId)?.marks.ttsFirstAudio !== undefined)).toEqual([true, true, true])
    // The engine's tts rows (the Models page marks them in use) and voices follow the pool.
    const engine = server!.handle.engine.status()
    expect(engine.engines.filter((e) => e.stage === "tts").map((e) => e.detail).sort()).toEqual(["en_US-lessac-medium", "kokoro-af_heart"])
    expect(engine.voices.map((v) => v.name).sort()).toEqual([PIPER, KOKORO])
  })

  it("assistants with the same voice share one instance; the voice nobody uses any more goes after the grace period", async () => {
    const voices = fakeVoices()
    await start(await withVoices({ alpha: PIPER, bravo: KOKORO }), voices)
    const device = await owner("device-a")
    await saveVoice("bravo", PIPER)
    await until("bravo on the shared voice", () => server!.handle.resources.ttsKeyFor("bravo") === PIPER)
    expect(server!.handle.resources.ttsFor("bravo")).toBe(server!.handle.resources.ttsFor("alpha"))
    expect(voices.builds).toHaveLength(2) // nothing new built
    expect((await spoken(device, "bravo", "same voice", "t1")).voices).toEqual([PIPER])
    await until("kokoro released", () => voices.released.includes(KOKORO))
    expect(ttsStatus()).toHaveLength(1)
    expect(ttsStatus()[0]).toMatchObject({ key: PIPER, state: "ready", usedBy: ["alpha", "bravo"] })
  })

  it("a voice change applies at that assistant's next turn without a reload and without interrupting a turn speaking on another device", async () => {
    const voices = fakeVoices()
    await start(await withVoices({ alpha: PIPER, bravo: KOKORO }), voices)
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const deviceA = await owner("device-a")
    const deviceB = await owner("device-b")

    // Bravo on device B is held mid-turn (its voice has not produced audio); Alpha on device A is held too.
    const bravoGate = Deferred.makeUnsafe<void>()
    const alphaGate = Deferred.makeUnsafe<void>()
    voices.holds.set(KOKORO, bravoGate)
    voices.holds.set(PIPER, alphaGate)
    const bravoTurn = spoken(deviceB, "bravo", "long story", "b1")
    const alphaTurn = spoken(deviceA, "alpha", "old question", "a1")
    await deviceB.waitFor("turn.start", () => true, { timeoutMs: 10_000 })
    await deviceA.waitFor("turn.start", () => true, { timeoutMs: 10_000 })

    const from = admin.messages.length
    await saveVoice("alpha", DUTCH)
    await until("the new voice ready and bound", () => server!.handle.resources.ttsKeyFor("alpha") === DUTCH)
    expect(voices.builds).toContain(DUTCH)

    // Both turns still run, on the voices they started with.
    Deferred.doneUnsafe(bravoGate, Exit.void)
    Deferred.doneUnsafe(alphaGate, Exit.void)
    const b = await bravoTurn
    const a = await alphaTurn
    expect([a.end.outcome, a.voices, a.sampleRate]).toEqual(["completed", [PIPER], 22_050])
    expect([b.end.outcome, b.voices, b.sampleRate]).toEqual(["completed", [KOKORO], 24_000])

    // Alpha's next turn, on either device, uses the new voice; Bravo is unchanged.
    expect((await spoken(deviceA, "alpha", "new question", "a2")).voices).toEqual([DUTCH])
    expect((await spoken(deviceB, "alpha", "from b", "a3")).voices).toEqual([DUTCH])
    expect((await spoken(deviceB, "bravo", "still kokoro", "b2")).voices).toEqual([KOKORO])
    expect(voices.builds.filter((k) => k === KOKORO)).toHaveLength(1)

    // No reload, and the old voice goes after the grace period.
    expect(admin.messages.slice(from).flatMap((m: ServerMessage) => (m.type === "engine" ? [m.engine.state] : [])).every((s) => s === "ready")).toBe(true)
    await until("the old voice released", () => voices.released.includes(PIPER))
    expect(server!.handle.engine.status().state).toBe("ready")
  })

  it("a voice that cannot start is a failed resource; that assistant's turn fails; the other assistant speaks; a new voice fixes it", async () => {
    const voices = fakeVoices()
    voices.failing.add(KOKORO)
    await start(await withVoices({ alpha: PIPER, bravo: KOKORO }), voices)
    const admin = await connect()
    const welcome = await admin.admin(TEST_ADMIN_PASSWORD)
    expect(welcome.snapshot.engine.state).toBe("ready")
    expect((welcome.snapshot.engine.resources ?? []).find((r) => r.kind === "tts" && r.usedBy.includes("bravo"))).toMatchObject({
      state: "failed",
      problem: "The voice kokoro-af_heart could not start."
    })
    const device = await owner("device-a")
    const failed = await spoken(device, "bravo", "hello", "t1")
    expect(failed.end.outcome).toBe("failed")
    expect(failed.errors).toContain("turn_failed")
    const fine = await spoken(device, "alpha", "hello", "t2")
    expect([fine.end.outcome, fine.voices]).toEqual(["completed", [PIPER]])
    // The engine list shows only voices that work.
    expect(server!.handle.engine.status().engines.filter((e) => e.stage === "tts").map((e) => e.detail)).toEqual(["en_US-lessac-medium"])

    voices.failing.clear()
    await saveVoice("bravo", DUTCH)
    await until("bravo's voice ready", () => ttsStatus().some((r) => r.usedBy.includes("bravo") && r.state === "ready"))
    expect((await spoken(device, "bravo", "again", "t3")).voices).toEqual([DUTCH])
    // The failed instance is gone at once (it held nothing a turn needs).
    expect(ttsStatus().some((r) => r.state === "failed")).toBe(false)
  })

  it("an assistant that just came into use answers Stop and typed text while its voice is still being built, and speaks at its rate once it is ready", async () => {
    const voices = fakeVoices()
    const building = Deferred.makeUnsafe<void>()
    voices.buildHolds.set(KOKORO, building)
    await start(await withVoices({ alpha: PIPER, bravo: KOKORO }, true), voices)
    const device = await owner("device-a")
    await Effect.runPromise(server!.handle.store.saveAssistantRecord({ ...assistantOf("bravo"), on: true }))
    await until("bravo bound to its voice being built", () => server!.handle.resources.ttsKeyFor("bravo") === KOKORO)
    expect(ttsStatus().find((r) => r.key === KOKORO)?.state).toBe("starting")

    // A spoken turn starts at once (it waits for the voice itself, before it plays), and Stop ends it.
    const from = device.messages.length
    device.send({ type: "text.send", requestId: "b1", text: "hello", speak: true, assistantId: "bravo" })
    const first = await device.waitFor("turn.start", (m) => m.assistantId === "bravo", { from, timeoutMs: 5_000 })
    device.send({ type: "interrupt", turnId: first.turnId })
    expect((await device.waitFor("turn.end", (m) => m.turnId === first.turnId, { from, timeoutMs: 5_000 })).outcome).toBe("interrupted")

    // A typed reply that is not spoken does not wait for the voice either.
    const typedFrom = device.messages.length
    device.send({ type: "text.send", requestId: "b2", text: "typed", speak: false, assistantId: "bravo" })
    const typed = await device.waitFor("turn.start", (m) => m.assistantId === "bravo", { from: typedFrom, timeoutMs: 5_000 })
    expect((await device.waitFor("turn.end", (m) => m.turnId === typed.turnId, { from: typedFrom, timeoutMs: 5_000 })).outcome).toBe("completed")
    expect(ttsStatus().find((r) => r.key === KOKORO)?.state).toBe("starting")

    // A spoken turn that waits plays once the voice is built, at its own rate.
    const later = spoken(device, "bravo", "now", "b3")
    await sleep(100)
    Deferred.doneUnsafe(building, Exit.void)
    const b = await later
    expect([b.end.outcome, b.voices, b.sampleRate]).toEqual(["completed", [KOKORO], 24_000])
  })
})
