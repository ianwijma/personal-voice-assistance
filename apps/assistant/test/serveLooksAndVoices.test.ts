// Looks and voices on the server (docs/LOOKS-AND-VOICES.md): files written before the `look` and `voice` section keys
// load whole and behave as before; saves carry the look and the device voice (validated like a voice is); a device's
// own voice (or its type's) is what its conversations speak with, from the next turn; `device.setup` is sent again
// when a look that applies to the device changes; the turn's configuration snapshot says whose voice it was.
import { Llm, type LlmEvent, Tts, type TtsAudio } from "@pva/core"
import type { ClientMessage, Look, ServerMessage, ServerMessageOf, TraceInfo } from "@pva/protocol"
import { Effect, Stream } from "effect"
import * as SherpaTts from "@pva/tts-sherpa"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type LlmBuilder, type TtsBuilder, ttsKeyOf } from "../src/serve/Resources.ts"
import { readStoredSettings } from "../src/serve/SettingsStore.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const PIPER = "sherpa:en_US-lessac-medium"
const KOKORO = "sherpa:kokoro-af_heart"
const CARTESIA = "cartesia:v-one"
const ELEVEN = "elevenlabs:v-two"
const voiceRef = (key: string) => ({ provider: key.slice(0, key.indexOf(":")), voiceId: key.slice(key.indexOf(":") + 1) })
const ownVoice = (key: string) => ({ from: "device", voice: voiceRef(key) })
const LOOK_A: Look = { character: "robot-eyes", options: { hue: 0.4 } }
const LOOK_B: Look = { character: "flame" }
const LOOK_DEVICE: Look = { character: "particle-sphere", version: "1" }

type Json = Record<string, any>

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
      return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: `You said ${text}. ` }, { _tag: "Done", stopReason: "end" }])
    }
  }))

const builds: Array<string> = []
const released: Array<string> = []
/** Voices whose build waits until its gate is opened (`gate(key)` closes one, the returned function opens it). */
const gates = new Map<string, Promise<void>>()
const gate = (key: string): (() => void) => {
  let open!: () => void
  gates.set(key, new Promise<void>((resolve) => { open = resolve }))
  return open
}
const buildTts: TtsBuilder = (spec) =>
  Effect.gen(function*() {
    const key = ttsKeyOf(spec)
    builds.push(key)
    const waiting = gates.get(key)
    if (waiting !== undefined) yield* Effect.promise(() => waiting)
    yield* Effect.addFinalizer(() => Effect.sync(() => released.push(key)))
    return Tts.of({
      sampleRate: 22_050,
      synthesize: (clauses) => clauses.pipe(Stream.zipWithIndex, Stream.map(([, clause]) => ({ audio: new Uint8Array(Math.round(22_050 * 0.2) * 2), clause }) satisfies TtsAudio))
    })
  })

/** A data directory with Alpha (voice PIPER, look A) and Bravo (voice KOKORO, no look) on the browser defaults. */
const dataDirWith = async (edit: (file: Json) => void = () => {}): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-looks-voices-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const make = (id: string, name: string, voice: string, look?: Look) => ({
    ...base,
    id,
    rev: 0,
    name,
    prompt: `You are ${name}.`,
    voice: voiceRef(voice),
    ...(look !== undefined ? { look } : {})
  })
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha: make("alpha", "Alpha", PIPER, LOOK_A), bravo: make("bravo", "Bravo", KOKORO) } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" }
  }
  edit(file)
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (dataDir: string, env: Record<string, string> = {}) => {
  builds.length = 0
  released.length = 0
  gates.clear()
  server = await startTestServer({
    build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "the build's model").llm }),
    buildLlm: echoLlm,
    buildTts,
    resourceGraceMs: 100,
    // No local voice is downloaded, whatever this machine has.
    env: { TTS_SHERPA_MODEL_DIR: join(dataDir, "no-voices"), ...env },
    dataDir
  })
}

const connect = async (deviceId?: string) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...(deviceId !== undefined ? { deviceId } : {}) })
  clients.push(client)
  return client
}
const admin = async () => {
  const client = await connect()
  await client.admin(TEST_ADMIN_PASSWORD)
  return client
}
const owner = async (deviceId: string) => {
  const client = await connect(deviceId)
  await client.hello()
  await client.claim()
  return client
}
const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

type WithoutId<M> = M extends unknown ? Omit<M, "requestId"> : never
type RequestInput = WithoutId<Extract<ClientMessage, { readonly requestId: string }>>
let seq = 0
const request = async (client: ScriptedClient, message: RequestInput) => {
  const requestId = `m${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

const settings = () => server!.handle.store.settings()
const assistantNamed = (id: string) => server!.handle.store.assistants().find((x) => x.id === id)!
const typeRev = () => settings().deviceTypes["web-voice"]?.rev ?? 0
const deviceRev = (id: string) => settings().devices[id]!.rev
const saveDevice = (a: ScriptedClient, id: string, patch: Json, extra: Json = {}) =>
  request(a, { type: "device.save", target: { kind: "device", id }, rev: deviceRev(id), settings: patch as any, ...extra } as RequestInput)
const saveType = (a: ScriptedClient, patch: Json, extra: Json = {}) =>
  request(a, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: typeRev(), settings: patch as any, ...extra } as RequestInput)
/** No local voice is downloaded here, so an assistant's unchanged voice warns on every save: these helpers are about the look, and say "Save anyway". */
const saveAssistant = (a: ScriptedClient, assistant: Json, extra: Json = { saveAnyway: true }) => request(a, { type: "assistant.save", assistant: assistant as any, ...extra } as RequestInput)

/** A voice page of `deviceId` that owns the audio and is known to the server (its record saved). */
const knownDevice = async (deviceId: string) => {
  const page = await owner(deviceId)
  await until("the device is known", () => settings().devices[deviceId] !== undefined)
  return page
}

interface Spoken {
  readonly device: string
  readonly outcome: string
  readonly turnId: number
  readonly voices: ReadonlyArray<string>
}
const spoken = async (client: ScriptedClient, assistantId: string, text: string, id: string): Promise<Spoken> => {
  const from = client.messages.length
  client.send({ type: "text.send", requestId: id, text, speak: true, assistantId })
  expect((await client.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
  const begun = await client.waitFor("turn.start", (m) => m.assistantId === assistantId, { from, timeoutMs: 10_000 })
  const end = await client.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 15_000 })
  const mine = client.messages.slice(from)
  return {
    device: client.device.id,
    outcome: end.outcome,
    turnId: begun.turnId,
    voices: [...new Set(mine.flatMap((m: ServerMessage) => (m.type === "assistant.text" && m.turnId === end.turnId && m.voice !== undefined ? [m.voice] : [])))]
  }
}
/** The traces an admin connection receives, by device and turn id (every device's turn ids start at 1). */
const traces = (a: ScriptedClient): Map<string, TraceInfo> =>
  new Map(a.messages.flatMap((m: ServerMessage) => (m.type === "trace" ? [[`${m.deviceId}:${m.trace.turnId}`, m.trace] as const] : [])))

describe("loading a file written before looks and voices", () => {
  const OLD_TYPE = {
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }],
    withoutPhrase: { mode: "nobody" },
    matching: "close",
    voicePage: { pick: false },
    interruptMode: "manual",
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, speakAloud: true, outputPath: "direct", prebufferMs: 60 },
    captions: { captions: false, speakTyped: true },
    rev: 3
  }
  const fileWith = (deviceTypes: Json, devices: Json = {}) => ({
    version: 4,
    modules: {},
    assistant: {},
    assistants: { order: [], byId: {} },
    deviceTypes,
    devices
  })

  it("a stored type entry without look and voice is kept whole: it follows the assistant", () => {
    const read = readStoredSettings(fileWith(
      { "web-voice": OLD_TYPE },
      { "dev-one-1": { kind: "web-voice", name: "Old browser", firstSeen: 1, lastSeen: 2, own: { interruptMode: "instant" }, rev: 2 } }
    ))
    expect(read?.problems).toEqual([])
    const file = (read!.file as any).file
    expect(file.deviceTypes["web-voice"]).toMatchObject({ ...OLD_TYPE, look: { from: "assistant" }, voice: { from: "assistant" } })
    expect(file.devices["dev-one-1"].own).toEqual({ interruptMode: "instant" })
  })

  it("a stored type entry with a look and voice keeps them", () => {
    const type = { ...OLD_TYPE, look: { from: "device", look: LOOK_B }, voice: ownVoice(PIPER) }
    const read = readStoredSettings(fileWith({ "web-voice": type }))
    expect(read?.problems).toEqual([])
    expect((read!.file as any).file.deviceTypes["web-voice"]).toMatchObject({ look: type.look, voice: type.voice })
  })

  it("the server starts on such a file and behaves as before: records kept, each assistant speaks with its own voice, no looks in the setup", async () => {
    const dataDir = await dataDirWith((file) => {
      delete file.assistants.byId.alpha.look
      delete file.deviceTypes["web-voice"].look
      delete file.deviceTypes["web-voice"].voice
      file.devices = { "dev-old-1": { kind: "web-voice", name: "Old", firstSeen: 1, lastSeen: 2, own: { captions: { captions: false, speakTyped: false } }, rev: 4 } }
    })
    await start(dataDir)
    expect(settings().deviceTypes["web-voice"]!.assistants.map((x) => x.assistant)).toEqual(["alpha", "bravo"]) // kept, not dropped
    expect(settings().deviceTypes["web-voice"]).toMatchObject({ look: { from: "assistant" }, voice: { from: "assistant" } })
    expect(settings().devices["dev-old-1"]).toMatchObject({ name: "Old", own: { captions: { captions: false, speakTyped: false } }, rev: 4 })
    expect("look" in assistantNamed("alpha")).toBe(false)
    const device = await owner("device-a")
    expect((await spoken(device, "alpha", "hi", "t1")).voices).toEqual([PIPER])
    expect((await spoken(device, "bravo", "hi", "t2")).voices).toEqual([KOKORO])
    const setup = device.messages.find((m): m is ServerMessageOf<"device.setup"> => m.type === "device.setup") ?? undefined
    expect(setup?.assistants.every((a) => a.look === undefined) ?? true).toBe(true)
    expect(setup?.look).toBeUndefined()
  })
})

describe("saving looks and voices", () => {
  it("assistant.save carries the look; an assistant without one stays without it", async () => {
    await start(await dataDirWith())
    const a = await admin()
    expect("look" in assistantNamed("bravo")).toBe(false)
    expect(await saveAssistant(a, { ...assistantNamed("bravo"), purpose: "Other" })).toMatchObject({ ok: true })
    expect("look" in assistantNamed("bravo")).toBe(false)
    expect(await saveAssistant(a, { ...assistantNamed("bravo"), look: LOOK_B })).toMatchObject({ ok: true })
    expect(assistantNamed("bravo").look).toEqual(LOOK_B)
    expect(JSON.parse(readFileSync(join(server!.dataDir, "settings.json"), "utf8")).assistants.byId.bravo.look).toEqual(LOOK_B)
    const listed = [...a.messages].reverse().find((m): m is ServerMessageOf<"assistants"> => m.type === "assistants")
    expect(listed?.assistants.find((x) => x.id === "bravo")?.look).toEqual(LOOK_B)
    expect(assistantNamed("alpha").look).toEqual(LOOK_A)
  })

  it("device.save takes look and voice for a type and a device; null resets a device; the admin lists carry them", async () => {
    await start(await dataDirWith())
    await knownDevice("device-a")
    const a = await admin()
    expect(await saveType(a, { look: { from: "device", look: LOOK_B }, voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect(settings().deviceTypes["web-voice"]).toMatchObject({ look: { from: "device", look: LOOK_B }, voice: ownVoice(CARTESIA) })
    expect(await saveDevice(a, "device-a", { look: { from: "device", look: LOOK_DEVICE }, voice: { from: "assistant" } })).toMatchObject({ ok: true })
    expect(settings().devices["device-a"]!.own).toMatchObject({ look: { from: "device", look: LOOK_DEVICE }, voice: { from: "assistant" } })
    const listed = () => [...a.messages].reverse().find((m): m is ServerMessageOf<"devices"> => m.type === "devices")?.devices.find((d) => d.id === "device-a")
    expect(listed()?.own.look).toEqual({ from: "device", look: LOOK_DEVICE })
    expect(listed()?.settings.voice).toEqual({ from: "assistant" })
    expect(listed()?.settings.look).toEqual({ from: "device", look: LOOK_DEVICE })
    // null: back to the type's defaults.
    expect(await saveDevice(a, "device-a", { look: null, voice: null })).toMatchObject({ ok: true })
    expect(settings().devices["device-a"]!.own.look).toBeUndefined()
    expect(settings().devices["device-a"]!.own.voice).toBeUndefined()
    expect(listed()?.settings.look).toEqual({ from: "device", look: LOOK_B })
    expect(listed()?.settings.voice).toEqual(ownVoice(CARTESIA))
    // A type's defaults cannot be reset.
    expect(await saveType(a, { look: null })).toMatchObject({ ok: false, error: { code: "invalid_settings" } })
  })

  it("a device voice is validated like a voice: a local voice not downloaded is refused, a hosted one without a key asks 'save anyway'", async () => {
    await start(await dataDirWith())
    await knownDevice("device-a")
    const a = await admin()
    const own = () => settings().devices["device-a"]!.own
    expect(await saveDevice(a, "device-a", { voice: ownVoice(PIPER) })).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "voice" }] } })
    expect(await saveDevice(a, "device-a", { voice: ownVoice(PIPER) }, { saveAnyway: true })).toMatchObject({ ok: false })
    expect(await saveDevice(a, "device-a", { voice: ownVoice("sherpa:no-such") })).toMatchObject({ ok: false })
    expect(await saveType(a, { voice: ownVoice(PIPER) })).toMatchObject({ ok: false, error: { fieldErrors: [{ key: "voice" }] } })
    expect(own().voice).toBeUndefined()
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", warnings: [{ key: "voice" }] }
    })
    expect(own().voice).toBeUndefined()
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect(own().voice).toEqual(ownVoice(CARTESIA))
    // Other sections, and following the assistant, need no voice check.
    expect(await saveDevice(a, "device-a", { captions: { captions: false, speakTyped: true } })).toMatchObject({ ok: true })
    expect(await saveDevice(a, "device-a", { voice: { from: "assistant" } })).toMatchObject({ ok: true })
  })

  it("a hosted voice with a key saves without a question", async () => {
    await start(await dataDirWith(), { CARTESIA_API_KEY: "key-for-tests" })
    await knownDevice("device-a")
    const a = await admin()
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) })).toMatchObject({ ok: true })
  })
})

describe("a device's voice at run time", () => {
  it("speaks with the device's own voice for every assistant, only on that device; the trace says whose voice it was", async () => {
    await start(await dataDirWith())
    const a = await admin()
    const deviceA = await knownDevice("device-a")
    const deviceB = await knownDevice("device-b")
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    await until("the device voice is built", () => builds.includes(CARTESIA))
    const onA1 = await spoken(deviceA, "alpha", "one", "a1")
    const onA2 = await spoken(deviceA, "bravo", "two", "a2")
    const onB1 = await spoken(deviceB, "alpha", "three", "b1")
    const onB2 = await spoken(deviceB, "bravo", "four", "b2")
    expect([onA1.voices, onA2.voices, onB1.voices, onB2.voices]).toEqual([[CARTESIA], [CARTESIA], [PIPER], [KOKORO]])
    await until("traces", () => traces(a).size === 4)
    const config = (t: Spoken) => traces(a).get(`${t.device}:${t.turnId}`)?.config
    expect([onA1, onA2, onB1, onB2].map((t) => [config(t)?.voice, config(t)?.voiceFrom])).toEqual([
      [CARTESIA, "device"],
      [CARTESIA, "device"],
      [PIPER, "assistant"],
      [KOKORO, "assistant"]
    ])
  })

  it("a change of the device's voice applies at the next turn; a reset goes back to the assistant's; unused voices are released", async () => {
    await start(await dataDirWith())
    const a = await admin()
    const device = await knownDevice("device-a")
    expect((await spoken(device, "alpha", "before", "t0")).voices).toEqual([PIPER])
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect((await spoken(device, "alpha", "own", "t1")).voices).toEqual([CARTESIA])
    expect(await saveDevice(a, "device-a", { voice: ownVoice(ELEVEN) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect((await spoken(device, "alpha", "changed", "t2")).voices).toEqual([ELEVEN])
    await until("the first device voice is released", () => released.includes(CARTESIA))
    expect(await saveDevice(a, "device-a", { voice: null })).toMatchObject({ ok: true })
    expect((await spoken(device, "alpha", "reset", "t3")).voices).toEqual([PIPER])
    await until("the second device voice is released", () => released.includes(ELEVEN))
    expect(released).not.toContain(PIPER)
  })

  it("flipping to the device's own voice, and back, keeps the old voice answering until the new one has loaded", async () => {
    // Alpha is on this device only (the type lists Bravo), so nothing else keeps Alpha's own voice alive.
    await start(await dataDirWith((file) => { file.deviceTypes["web-voice"].assistants = [{ assistant: "bravo", phrases: ["hey bravo"] }] }))
    const a = await admin()
    const device = await knownDevice("device-a")
    expect(await saveDevice(a, "device-a", { assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }] })).toMatchObject({ ok: true })
    const own = "alpha@device:device-a"
    const resources = () => server!.handle.resources
    expect((await spoken(device, "alpha", "before", "t0")).voices).toEqual([PIPER])
    // To its own voice, which is slow to load.
    const openCartesia = gate(CARTESIA)
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    await until("the device voice starts building", () => builds.includes(CARTESIA))
    expect((await spoken(device, "alpha", "loading", "t1")).voices).toEqual([PIPER])
    expect(resources().ttsKeyFor(own)).toBe(PIPER)
    openCartesia()
    await until("the device voice is bound", () => resources().ttsKeyFor(own) === CARTESIA)
    expect((await spoken(device, "alpha", "loaded", "t2")).voices).toEqual([CARTESIA])
    // Back to the assistant's: nothing else uses PIPER any more, so it is released and must be built again, slowly.
    await until("the assistant's voice is released", () => released.includes(PIPER))
    const openPiper = gate(PIPER)
    expect(await saveDevice(a, "device-a", { voice: null })).toMatchObject({ ok: true })
    await until("the assistant's voice builds again", () => builds.filter((k) => k === PIPER).length === 2)
    expect((await spoken(device, "alpha", "resetting", "t3")).voices).toEqual([CARTESIA])
    expect(resources().ttsKeyFor(own)).toBe(CARTESIA)
    openPiper()
    await until("the assistant's voice is bound", () => resources().ttsKeyFor(own) === PIPER)
    expect((await spoken(device, "alpha", "reset", "t4")).voices).toEqual([PIPER])
    await until("the own voice is released", () => released.includes(CARTESIA))
  })

  it("two devices reset while the assistant's voice loads each keep their own old voice until it is ready (PR #84 review, finding 3)", async () => {
    // Alpha is on two devices only, each with its own voice; nothing uses Alpha's own voice (PIPER) yet.
    await start(await dataDirWith((file) => { file.deviceTypes["web-voice"].assistants = [{ assistant: "bravo", phrases: ["hey bravo"] }] }))
    const a = await admin()
    const deviceA = await knownDevice("device-a")
    const deviceB = await knownDevice("device-b")
    const listing = [{ assistant: "alpha", phrases: ["hey alpha"] }]
    expect(await saveDevice(a, "device-a", { assistants: listing, voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect(await saveDevice(a, "device-b", { assistants: listing, voice: ownVoice(ELEVEN) }, { saveAnyway: true })).toMatchObject({ ok: true })
    const resources = () => server!.handle.resources
    const userA = "alpha@device:device-a"
    const userB = "alpha@device:device-b"
    await until("both device voices are bound", () => resources().ttsKeyFor(userA) === CARTESIA && resources().ttsKeyFor(userB) === ELEVEN)
    await until("Alpha's own voice is not loaded", () => !builds.includes(PIPER) || released.includes(PIPER))
    const piperBuilds = builds.filter((k) => k === PIPER).length
    // Alpha's own voice is slow to load. Reset A, then B while it is still loading.
    const openPiper = gate(PIPER)
    expect(await saveDevice(a, "device-a", { voice: null })).toMatchObject({ ok: true })
    await until("Alpha's own voice builds", () => builds.filter((k) => k === PIPER).length === piperBuilds + 1)
    expect((await spoken(deviceA, "alpha", "a loading", "a1")).voices).toEqual([CARTESIA])
    expect(await saveDevice(a, "device-b", { voice: null })).toMatchObject({ ok: true })
    expect((await spoken(deviceB, "alpha", "b loading", "b1")).voices).toEqual([ELEVEN])
    expect((await spoken(deviceA, "alpha", "a still loading", "a2")).voices).toEqual([CARTESIA])
    expect([resources().ttsKeyFor(userA), resources().ttsKeyFor(userB)]).toEqual([CARTESIA, ELEVEN])
    expect(builds.filter((k) => k === PIPER)).toHaveLength(piperBuilds + 1) // one instance for both places
    openPiper()
    await until("both places speak with Alpha's voice", () => resources().ttsKeyFor(userA) === PIPER && resources().ttsKeyFor(userB) === PIPER)
    expect((await spoken(deviceA, "alpha", "a reset", "a3")).voices).toEqual([PIPER])
    expect((await spoken(deviceB, "alpha", "b reset", "b2")).voices).toEqual([PIPER])
    expect(resources().ttsFor(userA)).toBe(resources().ttsFor(userB))
    await until("the old device voices are released", () => released.includes(CARTESIA) && released.includes(ELEVEN))
  })

  it("a type's voice defaults apply to its devices without their own; a device's own value wins", async () => {
    await start(await dataDirWith())
    const a = await admin()
    const deviceA = await knownDevice("device-a")
    const deviceB = await knownDevice("device-b")
    expect(await saveType(a, { voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect((await spoken(deviceA, "alpha", "one", "a1")).voices).toEqual([CARTESIA])
    expect((await spoken(deviceB, "bravo", "two", "b1")).voices).toEqual([CARTESIA])
    expect(await saveDevice(a, "device-b", { voice: { from: "assistant" } })).toMatchObject({ ok: true })
    expect((await spoken(deviceB, "bravo", "three", "b2")).voices).toEqual([KOKORO])
    expect((await spoken(deviceA, "bravo", "four", "a2")).voices).toEqual([CARTESIA])
    expect(await saveDevice(a, "device-a", { voice: ownVoice(ELEVEN) }, { saveAnyway: true })).toMatchObject({ ok: true })
    expect((await spoken(deviceA, "alpha", "five", "a3")).voices).toEqual([ELEVEN])
  })
})

describe("device.setup follows the looks", () => {
  const setupWith = (page: ScriptedClient, from: number, test: (m: ServerMessageOf<"device.setup">) => boolean) =>
    page.waitFor("device.setup", test, { from, timeoutMs: 5_000 })

  it("is sent again when an assistant's look, the type's look or the device's own look changes, and carries the resolved looks", async () => {
    await start(await dataDirWith())
    const page = await connect("device-a")
    const welcome = await page.hello()
    const first = (welcome as any).setup ?? (welcome as any).snapshot?.setup
    expect(first?.assistants.map((x: any) => [x.id, x.look])).toEqual([["alpha", LOOK_A], ["bravo", undefined]])
    expect(first?.look).toBeUndefined()
    await until("the device is known", () => settings().devices["device-a"] !== undefined)
    const a = await admin()

    let from = page.messages.length
    expect(await saveAssistant(a, { ...assistantNamed("alpha"), look: LOOK_B })).toMatchObject({ ok: true })
    const changed = await setupWith(page, from, (m) => m.assistants.find((x) => x.id === "alpha")?.look?.character === "flame")
    expect(changed.assistants.map((x) => x.look)).toEqual([LOOK_B, undefined])

    from = page.messages.length
    expect(await saveType(a, { look: { from: "device", look: LOOK_DEVICE } })).toMatchObject({ ok: true })
    const typed = await setupWith(page, from, (m) => m.look !== undefined)
    expect(typed.look).toEqual(LOOK_DEVICE)
    expect(typed.assistants.map((x) => x.look)).toEqual([LOOK_DEVICE, LOOK_DEVICE])

    from = page.messages.length
    expect(await saveDevice(a, "device-a", { look: { from: "device", look: LOOK_A } })).toMatchObject({ ok: true })
    const own = await setupWith(page, from, (m) => m.look?.character === "robot-eyes")
    expect(own.assistants.map((x) => x.look)).toEqual([LOOK_A, LOOK_A])

    from = page.messages.length
    expect(await saveDevice(a, "device-a", { look: { from: "assistant" } })).toMatchObject({ ok: true })
    const followed = await setupWith(page, from, (m) => m.look === undefined)
    expect(followed.assistants.map((x) => x.look)).toEqual([LOOK_B, undefined])
  })

  it("an assistant look change that the device's own look hides sends nothing", async () => {
    await start(await dataDirWith())
    const page = await connect("device-a")
    await page.hello()
    await until("the device is known", () => settings().devices["device-a"] !== undefined)
    const a = await admin()
    expect(await saveDevice(a, "device-a", { look: { from: "device", look: LOOK_DEVICE } })).toMatchObject({ ok: true })
    await setupWith(page, 0, (m) => m.look !== undefined)
    const from = page.messages.length
    expect(await saveAssistant(a, { ...assistantNamed("alpha"), look: LOOK_B })).toMatchObject({ ok: true })
    await sleep(150)
    expect(page.messages.slice(from).some((m) => m.type === "device.setup")).toBe(false)
  })
})

/** A model directory in which only `presets` (names such as "en_US-lessac-medium") count as downloaded. */
const voiceDirWith = (dataDir: string, presets: ReadonlyArray<string>): string => {
  const dir = join(dataDir, "some-voices")
  for (const name of presets) {
    for (const file of Object.values(SherpaTts.presetFiles(SherpaTts.presets[name]!, dir))) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, "x")
    }
  }
  return dir
}
const withoutIdentity = (a: Json): Json => {
  const { id: _id, rev: _rev, ...body } = a
  return body
}

describe("an assistant's own voice is checked like a device voice", () => {
  const created = (a: ScriptedClient, voice: string, name: string, extra: Json = {}) =>
    request(a, { type: "assistant.create", assistant: { ...withoutIdentity(assistantNamed("alpha")), name, voice: voiceRef(voice) } as any, ...extra } as RequestInput)

  it("assistant.create: a local voice that is not downloaded (or unknown) is refused, a hosted one without a key asks 'save anyway'", async () => {
    const dataDir = await dataDirWith()
    await start(dataDir, { TTS_SHERPA_MODEL_DIR: voiceDirWith(dataDir, ["en_US-lessac-medium"]) })
    const a = await admin()
    const count = () => server!.handle.store.assistants().length
    const before = count()
    expect(await created(a, KOKORO, "Charlie")).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "voice" }] } })
    expect(await created(a, KOKORO, "Charlie", { saveAnyway: true })).toMatchObject({ ok: false })
    expect(await created(a, "sherpa:no-such", "Charlie")).toMatchObject({ ok: false })
    expect(await created(a, CARTESIA, "Charlie")).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "voice" }] } })
    expect(count()).toBe(before)
    expect(await created(a, CARTESIA, "Charlie", { saveAnyway: true })).toMatchObject({ ok: true })
    expect(await created(a, PIPER, "Delta")).toMatchObject({ ok: true })
    expect(count()).toBe(before + 2)
  })

  it("assistant.save: a new or changed voice is checked; an unchanged voice that is fine is not affected; an unchanged one that became unavailable only warns", async () => {
    const dataDir = await dataDirWith()
    await start(dataDir, { TTS_SHERPA_MODEL_DIR: voiceDirWith(dataDir, ["en_US-lessac-medium"]) })
    const a = await admin()
    const alpha = () => assistantNamed("alpha")
    // Alpha's voice (PIPER) is downloaded: an ordinary save needs no question.
    expect(await saveAssistant(a, { ...alpha(), purpose: "Other" }, {})).toMatchObject({ ok: true })
    // A changed voice that is not downloaded is refused, and "Save anyway" does not override it.
    expect(await saveAssistant(a, { ...alpha(), voice: voiceRef(KOKORO) }, {})).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "voice" }] } })
    expect(await saveAssistant(a, { ...alpha(), voice: voiceRef(KOKORO) })).toMatchObject({ ok: false })
    expect(alpha().voice).toEqual(voiceRef(PIPER))
    // A hosted voice without a key asks; "Save anyway" keeps it.
    expect(await saveAssistant(a, { ...alpha(), voice: voiceRef(CARTESIA) }, {})).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "voice" }] } })
    expect(alpha().voice).toEqual(voiceRef(PIPER))
    expect(await saveAssistant(a, { ...alpha(), voice: voiceRef(CARTESIA) })).toMatchObject({ ok: true })
    // Unchanged hosted voice, still without a key: a warning, not an error; other edits ask once, then save.
    expect(await saveAssistant(a, { ...alpha(), purpose: "Again" }, {})).toMatchObject({ ok: false, error: { warnings: [{ key: "voice" }] } })
    expect(await saveAssistant(a, { ...alpha(), purpose: "Again" })).toMatchObject({ ok: true })
    // An unchanged local voice that is no longer downloaded (bravo's KOKORO): warned, never refused.
    const bravo = () => assistantNamed("bravo")
    expect(await saveAssistant(a, { ...bravo(), purpose: "Other" }, {})).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "voice" }] } })
    expect(await saveAssistant(a, { ...bravo(), purpose: "Other" })).toMatchObject({ ok: true })
    expect(bravo().purpose).toBe("Other")
  })
})

describe("devices as users of a voice", () => {
  const catalogue = async (dataDirToken: string) => {
    const response = await fetch(`${server!.url}/api/voices?provider=sherpa`, { headers: { Authorization: `Bearer ${dataDirToken}` } })
    const body = await response.json() as any
    return (key: string) => body.providers.flatMap((p: any) => p.voices).find((v: any) => v.key === key)
  }
  const login = async () => {
    const client = await connect()
    const { token, snapshot } = await client.admin(TEST_ADMIN_PASSWORD)
    return { client, token, snapshot }
  }
  const ttsResource = async (key: string) => {
    const { snapshot } = await login()
    return (snapshot.engine.resources ?? []).find((r) => r.kind === "tts" && r.key === key)
  }

  it("a device's own voice, the type's, and Reset: the catalogue lists them beside the assistants, from the effective settings", async () => {
    const dataDir = await dataDirWith()
    await start(dataDir, { TTS_SHERPA_MODEL_DIR: voiceDirWith(dataDir, ["en_US-lessac-medium", "kokoro-af_heart", "nl_NL-pim-medium"]) })
    await knownDevice("device-a")
    await knownDevice("device-b")
    const { client: a, token } = await login()
    const usersOf = async (key: string) => (await catalogue(token))(key)
    const PIM = "sherpa:nl_NL-pim-medium"
    // Nothing yet: the assistants only.
    expect(await usersOf(PIPER)).toMatchObject({ usedBy: ["alpha"], usedByDevices: [] })
    expect(await usersOf(PIM)).toMatchObject({ usedBy: [], usedByDevices: [] })
    // A device's own voice.
    expect(await saveDevice(a, "device-a", { voice: ownVoice(PIM) })).toMatchObject({ ok: true })
    expect(await usersOf(PIM)).toMatchObject({ usedBy: [], usedByDevices: [{ target: { kind: "device", id: "device-a" }, name: settings().devices["device-a"]!.name }] })
    // The assistants' voices are unchanged: a device voice is not an assistant's.
    expect(await usersOf(PIPER)).toMatchObject({ usedBy: ["alpha"], usedByDevices: [] })
    // The type's defaults: "Every browser" and every device that follows them (device-b), device-a keeps its own.
    expect(await saveType(a, { voice: ownVoice(KOKORO) })).toMatchObject({ ok: true })
    const kokoro = await usersOf(KOKORO)
    expect(kokoro.usedBy).toEqual(["bravo"])
    expect(kokoro.usedByDevices).toEqual(expect.arrayContaining([
      { target: { kind: "type", type: "web-voice" }, name: "Every browser" },
      { target: { kind: "device", id: "device-b" }, name: settings().devices["device-b"]!.name }
    ]))
    expect(kokoro.usedByDevices).toHaveLength(2)
    expect((await usersOf(PIM)).usedByDevices).toHaveLength(1)
    // Reset: device-a follows the type's voice (it is a user of that one), no longer of its own.
    expect(await saveDevice(a, "device-a", { voice: null })).toMatchObject({ ok: true })
    expect((await usersOf(PIM)).usedByDevices).toEqual([])
    expect((await usersOf(KOKORO)).usedByDevices).toHaveLength(3)
    // A device that follows its assistants again is gone from the list.
    expect(await saveDevice(a, "device-b", { voice: { from: "assistant" } })).toMatchObject({ ok: true })
    expect((await usersOf(KOKORO)).usedByDevices.map((u: any) => u.target)).toEqual(expect.not.arrayContaining([{ kind: "device", id: "device-b" }]))
  })

  it("resource status: pool users 'assistant@place' count as the assistant; the devices are named, never the raw key", async () => {
    const dataDir = await dataDirWith()
    await start(dataDir)
    await knownDevice("device-a")
    const { client: a } = await login()
    expect(await saveDevice(a, "device-a", { voice: ownVoice(CARTESIA) }, { saveAnyway: true })).toMatchObject({ ok: true })
    await until("the device voice is built", () => builds.includes(CARTESIA))
    await until("the device voice is ready", () => server!.handle.resources.status().some((r) => r.key === CARTESIA && r.state === "ready"))
    const resource = await ttsResource(CARTESIA)
    expect(resource).toMatchObject({
      usedBy: ["alpha", "bravo"],
      usedByDevices: [{ target: { kind: "device", id: "device-a" }, name: settings().devices["device-a"]!.name }]
    })
    expect(JSON.stringify(resource)).not.toContain("@")
    // The assistants' own voices have no devices.
    expect((await ttsResource(KOKORO))?.usedByDevices).toBeUndefined()
    // Reset: the device is gone from the list.
    expect(await saveDevice(a, "device-a", { voice: null })).toMatchObject({ ok: true })
    await until("the device voice is released", () => released.includes(CARTESIA))
    expect((await ttsResource(CARTESIA))?.usedByDevices ?? []).toEqual([])
  })
})
