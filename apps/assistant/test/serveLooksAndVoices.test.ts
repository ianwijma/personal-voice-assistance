// Looks and voices on the server (docs/LOOKS-AND-VOICES.md): files written before the `look` and `voice` section keys
// load whole and behave as before; saves carry the look and the device voice (validated like a voice is); a device's
// own voice (or its type's) is what its conversations speak with, from the next turn; `device.setup` is sent again
// when a look that applies to the device changes; the turn's configuration snapshot says whose voice it was.
import { Llm, type LlmEvent, Tts, type TtsAudio } from "@pva/core"
import type { ClientMessage, Look, ServerMessage, ServerMessageOf, TraceInfo } from "@pva/protocol"
import { Effect, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
const buildTts: TtsBuilder = (spec) =>
  Effect.gen(function*() {
    const key = ttsKeyOf(spec)
    builds.push(key)
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
const saveAssistant = (a: ScriptedClient, assistant: Json) => request(a, { type: "assistant.save", assistant: assistant as any })

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
