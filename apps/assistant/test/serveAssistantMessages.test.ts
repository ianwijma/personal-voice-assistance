// Protocol 7 messages on the server (docs/ASSISTANTS.md §5.2 to §5.4, WP-5): assistant and device saves, `device.pick`,
// `conversation.read`, the pushes and who gets them. Scripted clients against the real server with injected providers.
import { defineModule, type ModuleDefinition } from "@pva/core"
import { endOfTurn, speechStarted } from "@pva/core/testing"
import type { ClientMessage, ServerMessage, ServerMessageOf, ServerMessageType } from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

/** A decision provider that is running: "TypeSafe is set up" (`canAuto`). */
const deciderModule: ModuleDefinition<any> = defineModule({
  id: "decider-x",
  name: "Decider",
  description: "A decision provider.",
  kind: "decider",
  start: () => Effect.succeed({})
})

/** Two assistants (Alpha with the greeter, Bravo) on the browser defaults: "hey alpha" / "hey bravo", nobody without a phrase. */
const twoAssistantsDataDir = async (edit: (file: Json) => void = () => {}): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-assistant-messages-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", purpose: "Everything", prompt: "You are Alpha.", followUpSeconds: 8, modules: { greeter: { on: true, offTools: [] } } }
  const bravo = { ...base, id: "bravo", rev: 0, name: "Bravo", purpose: "Jokes", prompt: "You are Bravo.", followUpSeconds: 8, modules: {} }
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha, bravo } }
  file.modules = { ...file.modules, greeter: { ...(file.modules?.greeter ?? {}), enabled: true, settings: { greeting: "hello" } } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" },
    interruptMode: "instant"
  }
  edit(file)
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (edit?: (file: Json) => void, catalog: Array<ModuleDefinition<any>> = [greeterModule]) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `Reply to ${t}.`)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), dataDir: await twoAssistantsDataDir(edit), catalog })
  return { stt, llm }
}

const connect = async () => {
  const client = await ScriptedClient.connect({ url: server!.url })
  clients.push(client)
  return client
}
const admin = async () => {
  const client = await connect()
  await client.admin(TEST_ADMIN_PASSWORD)
  return client
}
const voice = async () => {
  const client = await connect()
  const welcome = await client.hello()
  return { client, welcome }
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

const latest = <T extends ServerMessageType>(client: ScriptedClient, type: T): ServerMessageOf<T> | undefined =>
  [...client.messages].reverse().find((m): m is ServerMessageOf<T> => m.type === type)

/** What an admin page holds: the lists of its snapshot, replaced by each later push. */
const view = (a: ScriptedClient) => {
  let assistants: ReadonlyArray<any> = []
  let types: ReadonlyArray<any> = []
  let devices: ReadonlyArray<any> = []
  for (const m of a.messages) {
    if (m.type === "admin.snapshot") {
      assistants = m.snapshot.assistants ?? []
      types = m.snapshot.deviceTypes ?? []
      devices = m.snapshot.devices
    } else if (m.type === "assistants") assistants = m.assistants
    else if (m.type === "device.types") types = m.types
    else if (m.type === "devices") devices = m.devices
  }
  return { assistants, types, devices }
}
const assistantsOf = (a: ScriptedClient) => view(a).assistants
const typeOf = (a: ScriptedClient) => view(a).types.find((t) => t.kind === "web-voice")!
const deviceOf = (a: ScriptedClient, id: string) => view(a).devices.find((d) => d.id === id)!

/** Wait until admin's device list has this device (its record was saved). */
const deviceKnown = async (a: ScriptedClient, id: string) => {
  for (let i = 0; i < 300 && !view(a).devices.some((d) => d.id === id); i++) await sleep(10)
  expect(view(a).devices.some((d) => d.id === id)).toBe(true)
}

const untilOpen = async (stt: ReturnType<typeof controlledStt>, n: number) => {
  for (let i = 0; i < 200 && stt.open() < n; i++) await sleep(10)
  expect(stt.open()).toBe(n)
}

/** Say `text` as one utterance; the turn it starts (and its end, after the reply has played). */
const utterance = async (page: ScriptedClient, stt: ReturnType<typeof controlledStt>, text: string) => {
  const from = page.messages.length
  stt.emit(speechStarted, endOfTurn(text))
  const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
  await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
  await page.waitFor("state", (m) => m.state !== "speaking" && m.state !== "thinking", { from, timeoutMs: 5_000 })
  return begun
}
/** Say `text`; nothing may answer it. */
const unheard = async (page: ScriptedClient, stt: ReturnType<typeof controlledStt>, text: string) => {
  const from = page.messages.length
  stt.emit(speechStarted, endOfTurn(text))
  await sleep(200)
  expect(page.types(from)).not.toContain("turn.start")
}

const typed = async (page: ScriptedClient, text: string, assistantId?: string) => {
  const from = page.messages.length
  page.send({ type: "text.send", requestId: `t-${from}`, text, speak: false, ...(assistantId !== undefined ? { assistantId } : {}) })
  const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
  await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
  return begun
}

const body = (name: string, extra: Json = {}) => {
  const { id: _i, rev: _r, usedOn: _u, resources: _s, problems: _p, ...rest } = latestAssistants()[0]!
  return { ...rest, name, ...extra } as any
}
let known: ReadonlyArray<any> = []
const latestAssistants = () => known
const refresh = async (a: ScriptedClient) => {
  known = assistantsOf(a)
}

describe("access", () => {
  it("assistant and device changes are admin only: a voice page and an admin page not logged in are refused", async () => {
    await start()
    const page = (await voice()).client
    const loggedOut = await connect()
    await loggedOut.hello({ frontend: "admin" })
    const a = await admin()
    await refresh(a)
    const messages: Array<RequestInput> = [
      { type: "assistant.create", assistant: body("Charlie") },
      { type: "assistant.save", assistant: assistantsOf(a)[0]! as any },
      { type: "assistant.delete", id: "bravo", rev: 0 },
      { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: 0, settings: {} }
    ]
    for (const message of messages) {
      for (const client of [page, loggedOut]) {
        expect(await request(client, message), message.type).toMatchObject({ ok: false, error: { code: "admin_required" } })
      }
    }
    expect(assistantsOf(a).map((x) => x.id)).toEqual(["alpha", "bravo"])
  })

  it("device.pick and conversation.read are voice messages: an admin connection is refused bad_message", async () => {
    await start()
    const a = await admin()
    expect(await request(a, { type: "device.pick", withoutPhrase: "alpha" })).toMatchObject({ ok: false, error: { code: "bad_message" } })
    expect(await request(a, { type: "conversation.read", assistantId: "alpha" })).toMatchObject({ ok: false, error: { code: "bad_message" } })
  })
})

describe("assistant.create", () => {
  it("creates an assistant: the id from the name, a result with it, the new list pushed to admin; placements land on the type and a device", async () => {
    await start()
    const { client: page } = await voice()
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    const result = await request(a, {
      type: "assistant.create",
      assistant: body("Keuken Hulp", { prompt: "You are the kitchen." }),
      copyOf: "alpha",
      placements: [
        { target: { kind: "type", type: "web-voice" }, phrase: "hey kitchen" },
        { target: { kind: "device", id: page.device.id }, phrase: "hey chef" }
      ]
    })
    expect(result).toMatchObject({ ok: true, assistantId: "keuken-hulp" })
    const list = assistantsOf(a)
    expect(list.map((x) => x.id)).toEqual(["alpha", "bravo", "keuken-hulp"])
    expect(list[2]).toMatchObject({ rev: 0, prompt: "You are the kitchen." })
    expect(typeOf(a).settings.assistants.map((x: any) => x.assistant)).toEqual(["alpha", "bravo", "keuken-hulp"])
    expect(typeOf(a).settings.assistants[2]!.phrases).toEqual(["hey kitchen"])
    expect(deviceOf(a, page.device.id).own.assistants!.map((x: any) => [x.assistant, x.phrases])).toEqual([
      ["alpha", ["hey alpha"]],
      ["bravo", ["hey bravo"]],
      ["keuken-hulp", ["hey kitchen", "hey chef"]]
    ])
    expect(list[2]!.usedOn.map((u: any) => u.target)).toEqual(expect.arrayContaining([{ kind: "type", type: "web-voice" }, { kind: "device", id: page.device.id }]))
    // The voice page's setup follows (its device's list only).
    const setup = await page.waitFor("device.setup", (m) => m.assistants.some((x) => x.id === "keuken-hulp"), { from: 0 })
    expect(setup.assistants.map((x) => x.id)).toEqual(["alpha", "bravo", "keuken-hulp"])
  })

  it("refusals: a blank or taken name, a bad hearing pause, an unknown 'start from', a taken phrase or unknown device in the placements (nothing is created), the limit", async () => {
    await start()
    const a = await admin()
    await refresh(a)
    const create = (assistant: Json, extra: Json = {}) => request(a, { type: "assistant.create", assistant: assistant as any, ...extra } as RequestInput)
    expect(await create(body("  "))).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "name" }] } })
    expect(await create(body("alpha"))).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "name", message: expect.stringContaining("already") }] } })
    const hearing = { ...known[0]!.hearing, eagerSilenceMs: 900, finalSilenceMs: 400 }
    expect(await create(body("Charlie", { hearing }))).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "hearing.finalSilenceMs" }] } })
    expect(await create(body("Charlie"), { copyOf: "nobody-here" })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    expect(await create(body("Charlie"), { placements: [{ target: { kind: "type", type: "web-voice" }, phrase: "Hey, Alpha!" }] })).toMatchObject({
      ok: false,
      error: { code: "duplicate_phrase" }
    })
    expect(await create(body("Charlie"), { placements: [{ target: { kind: "device", id: "nope-device" } }] })).toMatchObject({ ok: false, error: { code: "unknown_device" } })
    expect(assistantsOf(a).map((x) => x.id)).toEqual(["alpha", "bravo"])
    for (let i = 0; i < 14; i++) expect(await create(body(`Extra ${i}`))).toMatchObject({ ok: true })
    expect(await create(body("One too many"))).toMatchObject({ ok: false, error: { code: "limit_reached" } })
    expect(assistantsOf(a)).toHaveLength(16)
  })
})

describe("assistant.save", () => {
  it("saves the whole assistant (rev + 1) and pushes it; a wrong rev is stale; invalid values and unknown ids are refused", async () => {
    await start()
    const a = await admin()
    await refresh(a)
    const alpha = assistantsOf(a).find((x) => x.id === "alpha")!
    const { usedOn: _u, resources: _r, problems: _p, ...stored } = alpha
    expect(await request(a, { type: "assistant.save", assistant: { ...stored, purpose: "Anything at all" } })).toEqual(expect.objectContaining({ ok: true }))
    expect(assistantsOf(a).find((x) => x.id === "alpha")).toMatchObject({ rev: 1, purpose: "Anything at all" })
    // The same rev again: someone else saved meanwhile.
    expect(await request(a, { type: "assistant.save", assistant: { ...stored, purpose: "Another" } })).toMatchObject({ ok: false, error: { code: "stale" } })
    expect(assistantsOf(a).find((x) => x.id === "alpha")!.purpose).toBe("Anything at all")
    const fresh = { ...stored, rev: 1 }
    expect(await request(a, { type: "assistant.save", assistant: { ...fresh, name: "Bravo" } })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", fieldErrors: [{ key: "name" }] }
    })
    expect(await request(a, { type: "assistant.save", assistant: { ...fresh, llm: { ...fresh.llm, account: "anthropic", model: "" } } })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", fieldErrors: [{ key: "llm.model" }] }
    })
    expect(await request(a, { type: "assistant.save", assistant: { ...fresh, modules: { greeter: { on: true, offTools: ["nope"] } } } })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", fieldErrors: [{ key: "modules.greeter.offTools" }] }
    })
    expect(await request(a, { type: "assistant.save", assistant: { ...fresh, modules: { greeter: { on: true, offTools: [], own: { greeting: "x" } } } } })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", fieldErrors: [{ key: "modules.greeter.own.greeting" }] }
    })
    expect(await request(a, { type: "assistant.save", assistant: { ...fresh, id: "ghost" } })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    expect(assistantsOf(a).find((x) => x.id === "alpha")!.rev).toBe(1)
  })

  it("switching an assistant off drops its phrase on a live session (no other assistant answers it); switching it on again brings it back", async () => {
    const { stt } = await start()
    const { client: page } = await voice()
    await page.claim()
    await untilOpen(stt, 1)
    const a = await admin()
    await refresh(a)
    expect(await utterance(page, stt, "hey alpha hi")).toMatchObject({ assistantId: "alpha" })
    const alpha = assistantsOf(a).find((x) => x.id === "alpha")!
    const { usedOn: _u, resources: _r, problems: _p, ...stored } = alpha
    expect(await request(a, { type: "assistant.save", assistant: { ...stored, on: false } })).toMatchObject({ ok: true })
    // The setup shows it switched off; no reload happened.
    await page.waitFor("device.setup", (m) => m.assistants.find((x) => x.id === "alpha")?.on === false, { from: 0 })
    await unheard(page, stt, "hey alpha are you there")
    expect(await utterance(page, stt, "hey bravo hi")).toMatchObject({ assistantId: "bravo" })
    expect(await request(a, { type: "assistant.save", assistant: { ...stored, rev: 1, on: true } })).toMatchObject({ ok: true })
    await page.waitFor("device.setup", (m) => m.assistants.find((x) => x.id === "alpha")?.on === true, { from: 0 })
    expect(await utterance(page, stt, "hey alpha back again")).toMatchObject({ assistantId: "alpha" })
    expect(stt.opened()).toBe(1)
  })
})

describe("assistant.delete", () => {
  it("removes the assistant from every list (type and device), withoutPhrase becomes nobody, its conversations end; stale and unknown are refused", async () => {
    const { stt } = await start((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "bravo" }
    })
    const { client: page } = await voice()
    await page.claim()
    await untilOpen(stt, 1)
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    // The device has its own list naming Bravo and its own TypeSafe-free withoutPhrase naming Bravo.
    expect(await request(a, {
      type: "device.save",
      target: { kind: "device", id: page.device.id },
      rev: deviceOf(a, page.device.id).rev,
      settings: { assistants: [{ assistant: "bravo", phrases: ["hey bravo"] }, { assistant: "alpha", phrases: ["hey alpha"] }], withoutPhrase: { mode: "assistant", assistant: "bravo" } }
    })).toMatchObject({ ok: true })
    // Bravo has a conversation on the device.
    expect(await utterance(page, stt, "hello there")).toMatchObject({ assistantId: "bravo" })

    expect(await request(a, { type: "assistant.delete", id: "bravo", rev: 5 })).toMatchObject({ ok: false, error: { code: "stale" } })
    expect(await request(a, { type: "assistant.delete", id: "ghost", rev: 0 })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    expect(assistantsOf(a).map((x) => x.id)).toEqual(["alpha", "bravo"])

    const from = page.messages.length
    expect(await request(a, { type: "assistant.delete", id: "bravo", rev: 0 })).toMatchObject({ ok: true })
    expect(assistantsOf(a).map((x) => x.id)).toEqual(["alpha"])
    expect(typeOf(a).settings.assistants.map((x: any) => x.assistant)).toEqual(["alpha"])
    expect(typeOf(a).settings.withoutPhrase).toEqual({ mode: "nobody" })
    expect(deviceOf(a, page.device.id).own.assistants!.map((x: any) => x.assistant)).toEqual(["alpha"])
    expect(deviceOf(a, page.device.id).own.withoutPhrase).toEqual({ mode: "nobody" })
    // Its conversation on the device ended (a new, empty one is announced for it), and the setup lost it.
    await page.waitFor("conversation", (m) => m.assistantId === "bravo" && m.reason === "new", { from, timeoutMs: 5_000 })
    const setup = await page.waitFor("device.setup", (m) => !m.assistants.some((x) => x.id === "bravo"), { from })
    expect(setup.withoutPhrase).toEqual({ mode: "nobody" })
    // "hey bravo" is nobody's phrase now.
    await unheard(page, stt, "hey bravo anyone")
    expect(await utterance(page, stt, "hey alpha hi")).toMatchObject({ assistantId: "alpha" })
  })

  it("deleting the last assistant is allowed; nobody answers then", async () => {
    await start()
    const a = await admin()
    await refresh(a)
    expect(await request(a, { type: "assistant.delete", id: "alpha", rev: 0 })).toMatchObject({ ok: true })
    expect(await request(a, { type: "assistant.delete", id: "bravo", rev: 0 })).toMatchObject({ ok: true })
    expect(assistantsOf(a)).toEqual([])
    expect(typeOf(a).settings.assistants).toEqual([])
  })

  it("a TypeSafe fallback naming the deleted assistant becomes the first remaining one", async () => {
    await start((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "typesafe", fallback: "alpha", giveUpMs: 400 }
    })
    const a = await admin()
    await refresh(a)
    expect(await request(a, { type: "assistant.delete", id: "alpha", rev: 0 })).toMatchObject({ ok: true })
    expect(typeOf(a).settings.withoutPhrase).toEqual({ mode: "typesafe", fallback: "bravo", giveUpMs: 400 })
  })
})

describe("device.save", () => {
  it("a type's defaults: saved with rev + 1 and pushed as device.types; stale, duplicate_phrase, unknown_assistant, limit_reached, null and unknown keys are refused", async () => {
    await start()
    const a = await admin()
    await refresh(a)
    const rev = typeOf(a).rev
    const save = (settings: Json, r = typeOf(a).rev, extra: Json = {}) =>
      request(a, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: r, settings: settings as any, ...extra } as RequestInput)
    expect(await save({ interruptMode: "manual" })).toMatchObject({ ok: true })
    expect(typeOf(a)).toMatchObject({ rev: rev + 1, settings: { interruptMode: "manual" } })
    expect(await save({ interruptMode: "instant" }, rev)).toMatchObject({ ok: false, error: { code: "stale" } })
    const twice = [{ assistant: "alpha", phrases: ["hey go"] }, { assistant: "bravo", phrases: ["Hey, GO!"] }]
    expect(await save({ assistants: twice })).toMatchObject({ ok: false, error: { code: "duplicate_phrase" } })
    expect(await save({ assistants: [{ assistant: "ghost", phrases: ["hey ghost"] }] })).toMatchObject({ ok: false, error: { code: "unknown_assistant", fieldErrors: [{ key: "assistants.0" }] } })
    // Three assistants with 12 + 12 + 9 phrases: one more than a device may have.
    expect(await request(a, { type: "assistant.create", assistant: body("Charlie") })).toMatchObject({ ok: true })
    const phrases = (from: number, n: number) => Array.from({ length: n }, (_, i) => `hey word${from + i}`)
    const lots = [{ assistant: "alpha", phrases: phrases(0, 12) }, { assistant: "bravo", phrases: phrases(12, 12) }, { assistant: "charlie", phrases: phrases(24, 9) }]
    expect(await save({ assistants: lots })).toMatchObject({ ok: false, error: { code: "limit_reached" } })
    expect(await save({ assistants: [lots[0]!, lots[1]!, { assistant: "charlie", phrases: phrases(24, 8) }] })).toMatchObject({ ok: true })
    expect(await save({ withoutPhrase: { mode: "assistant", assistant: "ghost" } })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    expect(await save({ captions: null })).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "captions" }] } })
    expect(typeOf(a).settings.interruptMode).toBe("manual")
    expect(await request(a, { type: "device.save", target: { kind: "type", type: "voice-node" }, rev: 0, settings: {} })).toMatchObject({ ok: false, error: { code: "unknown_device" } })
  })

  it("an assistant that cannot be reached asks for 'save anyway'; a device is unknown, renamed, reset with null", async () => {
    await start()
    const { client: page } = await voice()
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    const target = { kind: "device", id: page.device.id } as const
    const save = (settings: Json, extra: Json = {}) =>
      request(a, { type: "device.save", target, rev: deviceOf(a, page.device.id).rev, settings: settings as any, ...extra } as RequestInput)
    const noPhrase = { assistants: [{ assistant: "alpha", phrases: [] }] }
    const refused = await save(noPhrase)
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "assistants.alpha" }] } })
    expect(deviceOf(a, page.device.id).own).toEqual({})
    expect(await save(noPhrase, { saveAnyway: true })).toMatchObject({ ok: true })
    expect(deviceOf(a, page.device.id).own.assistants).toEqual(noPhrase.assistants)
    // Saving another section does not ask again about the same problem.
    expect(await save({ captions: { captions: false, speakTyped: true } })).toMatchObject({ ok: true })
    expect(await save({ assistants: null }, { name: "Kitchen iPad" })).toMatchObject({ ok: true })
    expect(deviceOf(a, page.device.id)).toMatchObject({ name: "Kitchen iPad", own: { captions: { captions: false, speakTyped: true } } })
    expect(deviceOf(a, page.device.id).own.assistants).toBeUndefined()
    expect(deviceOf(a, page.device.id).settings.assistants.map((x: any) => x.assistant)).toEqual(["alpha", "bravo"])
    expect(await request(a, { type: "device.save", target: { kind: "device", id: "nope-device" }, rev: 0, settings: {} })).toMatchObject({ ok: false, error: { code: "unknown_device" } })
    expect(await request(a, { type: "device.save", target, rev: 0, settings: { interruptMode: "manual" } })).toMatchObject({ ok: false, error: { code: "stale" } })
  })

  it("an accepted save answers with the revision it made (a type and a device); a refused one has none", async () => {
    await start()
    const { client: page } = await voice()
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    const typeRev = typeOf(a).rev
    const typeSaved = await request(a, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: typeRev, settings: { interruptMode: "manual" } })
    expect(typeSaved).toMatchObject({ ok: true, rev: typeRev + 1 })
    const deviceRev = deviceOf(a, page.device.id).rev
    const deviceSaved = await request(a, { type: "device.save", target: { kind: "device", id: page.device.id }, rev: deviceRev, settings: { interruptMode: "instant" } })
    expect(deviceSaved).toMatchObject({ ok: true, rev: deviceRev + 1 })
    const stale = await request(a, { type: "device.save", target: { kind: "device", id: page.device.id }, rev: deviceRev, settings: { interruptMode: "manual" } })
    expect(stale).toMatchObject({ ok: false, error: { code: "stale" } })
    expect("rev" in stale).toBe(false)
  })

  it("saving a device's assistants and phrases changes routing on a live session, without a reload; so does a type default", async () => {
    const { stt } = await start()
    const { client: page } = await voice()
    await page.claim()
    await untilOpen(stt, 1)
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    expect(await utterance(page, stt, "hey alpha first")).toMatchObject({ assistantId: "alpha" })

    // The device's own list: Bravo answers to "hey zed" and nobody else is on the device.
    expect(await request(a, {
      type: "device.save",
      target: { kind: "device", id: page.device.id },
      rev: deviceOf(a, page.device.id).rev,
      settings: { assistants: [{ assistant: "bravo", phrases: ["hey zed"] }] }
    })).toMatchObject({ ok: true })
    const setup = await page.waitFor("device.setup", (m) => m.assistants.length === 1, { from: 0 })
    expect(setup).toMatchObject({ deviceId: page.device.id, assistants: [{ id: "bravo", phrases: ["hey zed"] }] })
    // Let the follow-up window of the first turn pass its reconfiguration, then:
    await unheard(page, stt, "hey alpha second")
    expect(await utterance(page, stt, "hey zed third")).toMatchObject({ userText: "third", assistantId: "bravo" })

    // The type's defaults reach a device that follows them.
    const other = await voice()
    await other.client.claim()
    await untilOpen(stt, 2)
    await deviceKnown(a, other.client.device.id)
    expect(await request(a, {
      type: "device.save",
      target: { kind: "type", type: "web-voice" },
      rev: typeOf(a).rev,
      settings: { assistants: [{ assistant: "alpha", phrases: ["hey omega"] }, { assistant: "bravo", phrases: [] }], withoutPhrase: { mode: "assistant", assistant: "bravo" } }
    })).toMatchObject({ ok: true })
    await other.client.waitFor("device.setup", (m) => m.assistants[0]?.phrases[0] === "hey omega", { from: 0 })
    stt.emitTo(1, speechStarted, endOfTurn("hey omega ping"))
    expect(await other.client.waitFor("turn.start", () => true, { timeoutMs: 10_000 })).toMatchObject({ assistantId: "alpha", userText: "ping" })
    // The first device keeps its own list: "hey zed" still works there.
    expect(await utterance(page, stt, "hey zed fourth")).toMatchObject({ assistantId: "bravo" })
    expect(stt.opened()).toBe(2)
  })
})

describe("what a voice connection receives", () => {
  const ALLOWED: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
    "welcome", "session", "state", "transcript", "turn.start", "assistant.text", "assistant.playing", "tool.start", "tool.end",
    "turn.end", "reply.start", "reply.end", "reply.stop", "result", "error", "engine.summary", "admin.state", "device.profile",
    "wake", "pong", "device.setup", "conversation", "conversation.history"
  ])

  it("none of the admin pushes of §5.4, whatever admin changes; the setup carries no prompt, model or key", async () => {
    const { stt } = await start()
    const { client: page, welcome } = await voice()
    await page.claim()
    await untilOpen(stt, 1)
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    const alpha = assistantsOf(a).find((x) => x.id === "alpha")!
    const { usedOn: _u, resources: _r, problems: _p, ...stored } = alpha
    expect((await request(a, { type: "assistant.create", assistant: body("Charlie", { prompt: "Secret prompt Charlie." }), placements: [{ target: { kind: "type", type: "web-voice" }, phrase: "hey charlie" }] })).ok).toBe(true)
    expect((await request(a, { type: "assistant.save", assistant: { ...stored, prompt: "Secret prompt Alpha." } })).ok).toBe(true)
    expect((await request(a, { type: "device.save", target: { kind: "device", id: page.device.id }, rev: deviceOf(a, page.device.id).rev, name: "Kitchen", settings: { interruptMode: "manual" } })).ok).toBe(true)
    expect((await request(a, { type: "assistant.delete", id: "bravo", rev: 0 })).ok).toBe(true)
    expect(await utterance(page, stt, "hey alpha hello")).toMatchObject({ assistantId: "alpha" })
    // A voice page that is not allowed to change anything gets only refusals.
    expect(await request(page, { type: "assistant.delete", id: "alpha", rev: 1 })).toMatchObject({ ok: false, error: { code: "admin_required" } })

    for (const m of page.messages) expect(ALLOWED.has(m.type), m.type).toBe(true)
    for (const type of ["assistants", "device.types", "devices", "admin.snapshot"] as const) expect(page.types(), type).not.toContain(type)
    const raw = JSON.stringify(page.messages)
    for (const word of ["Secret prompt", "You are Alpha", "You are Bravo", "claude-", "Kitchen", "usedOn", "handles", "rev\":"]) expect(raw, word).not.toContain(word)
    // Only its own device's setup.
    for (const m of page.messages) if (m.type === "device.setup") expect(m.deviceId).toBe(page.device.id)
    expect(welcome.snapshot.setup).toMatchObject({ deviceId: page.device.id, assistants: [{ id: "alpha" }, { id: "bravo" }], canPick: false })
    expect(Object.keys(welcome.snapshot.setup!.assistants[0]!).sort()).toEqual(["id", "name", "on", "phrases", "purpose"])
  })

  it("the admin page gets the lists; a second device's pushes never reach the first voice page", async () => {
    await start()
    const one = await voice()
    const two = await voice()
    const a = await admin()
    await deviceKnown(a, one.client.device.id)
    await deviceKnown(a, two.client.device.id)
    await refresh(a)
    expect(await request(a, {
      type: "device.save",
      target: { kind: "device", id: two.client.device.id },
      rev: deviceOf(a, two.client.device.id).rev,
      settings: { assistants: [{ assistant: "bravo", phrases: ["hey two"] }] }
    })).toMatchObject({ ok: true })
    await two.client.waitFor("device.setup", (m) => m.assistants.length === 1, { from: 0 })
    await sleep(100)
    expect(one.client.messages.filter((m) => m.type === "device.setup")).toHaveLength(0)
    expect(latest(a, "devices")!.devices.find((d) => d.id === two.client.device.id)!.hearer).toBe("bravo")
  })
})

describe("device.pick", () => {
  const withPick = (file: Json) => {
    file.deviceTypes["web-voice"].voicePage = { pick: true }
  }

  it("is refused not_allowed unless the device's settings allow picking, and for 'typesafe' unless TypeSafe is set up", async () => {
    await start()
    const { client: page } = await voice()
    expect(await request(page, { type: "device.pick", withoutPhrase: "alpha" })).toMatchObject({ ok: false, error: { code: "not_allowed" } })
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await refresh(a)
    expect(await request(a, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: typeOf(a).rev, settings: { voicePage: { pick: true } } })).toMatchObject({ ok: true })
    const setup = await page.waitFor("device.setup", (m) => m.canPick, { from: 0 })
    expect(setup.canAuto).toBe(false)
    expect(await request(page, { type: "device.pick", withoutPhrase: "typesafe" })).toMatchObject({ ok: false, error: { code: "not_allowed" } })
    expect(await request(page, { type: "device.pick", withoutPhrase: "ghost" })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    // A device with one assistant has nothing to pick between.
    expect(await request(a, { type: "device.save", target: { kind: "device", id: page.device.id }, rev: deviceOf(a, page.device.id).rev, settings: { assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }] } })).toMatchObject({ ok: true })
    expect(await request(page, { type: "device.pick", withoutPhrase: "alpha" })).toMatchObject({ ok: false, error: { code: "not_allowed" } })
  })

  it("changes who answers without a phrase on the live session, is pushed to admin connections and to the device's setup", async () => {
    const { stt, llm } = await start(withPick)
    const { client: page, welcome } = await voice()
    expect(welcome.snapshot.setup).toMatchObject({ canPick: true, withoutPhrase: { mode: "nobody" } })
    await page.claim()
    await untilOpen(stt, 1)
    const a = await admin()
    await deviceKnown(a, page.device.id)
    await unheard(page, stt, "no phrase at all")

    expect(await request(page, { type: "device.pick", withoutPhrase: "bravo" })).toMatchObject({ ok: true })
    expect(await page.waitFor("device.setup", (m) => m.withoutPhrase.mode === "assistant", { from: 0 })).toMatchObject({ withoutPhrase: { mode: "assistant", assistant: "bravo" } })
    // Admin: the device now has an own withoutPhrase and bravo hears (devices push); the assistants' usage follows.
    await a.waitFor("devices", (m) => m.devices.find((d) => d.id === page.device.id)?.own.withoutPhrase !== undefined, { from: 0 })
    expect(deviceOf(a, page.device.id)).toMatchObject({ own: { withoutPhrase: { mode: "assistant", assistant: "bravo" } }, hearer: "bravo" })
    expect(deviceOf(a, page.device.id).own.assistants).toBeUndefined()
    await sleep(50)
    expect(assistantsOf(a).find((x) => x.id === "bravo")!.usedOn).toContainEqual({ target: { kind: "device", id: page.device.id }, hears: true, reach: "without-phrase" })
    // Without a phrase: Bravo answers.
    expect(await utterance(page, stt, "tell me something")).toMatchObject({ assistantId: "bravo", userText: "tell me something" })
    expect(llm.requests.at(-1)!.system).toContain("You are Bravo.")

    // Nobody again.
    expect(await request(page, { type: "device.pick", withoutPhrase: "" })).toMatchObject({ ok: true })
    await page.waitFor("device.setup", (m) => m.withoutPhrase.mode === "nobody", { from: 0 })
    // (the follow-up window of Bravo's reply may still be open: wait it out by using a phrase for Alpha)
    expect(await utterance(page, stt, "hey alpha hello")).toMatchObject({ assistantId: "alpha" })
  })

  it("'typesafe' needs a running decision provider and keeps the effective fallback and give-up time", async () => {
    await start((file) => {
      withPick(file)
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "typesafe", fallback: "bravo", giveUpMs: 700 }
    }, [greeterModule, deciderModule])
    const { client: page, welcome } = await voice()
    expect(welcome.snapshot.setup).toMatchObject({ canPick: true, canAuto: true, withoutPhrase: { mode: "typesafe", fallback: "bravo" } })
    const a = await admin()
    await deviceKnown(a, page.device.id)
    expect(await request(page, { type: "device.pick", withoutPhrase: "alpha" })).toMatchObject({ ok: true })
    expect(deviceOf(a, page.device.id) ?? (await a.waitFor("devices", () => true, { from: 0 }))).toBeDefined()
    await page.waitFor("device.setup", (m) => m.withoutPhrase.mode === "assistant", { from: 0 })
    expect(await request(page, { type: "device.pick", withoutPhrase: "typesafe" })).toMatchObject({ ok: true })
    // The own value is a fresh typesafe one (the effective one was alpha now): first assignment as fallback, default give-up.
    await page.waitFor("device.setup", (m) => m.withoutPhrase.mode === "typesafe", { from: 0 })
    await sleep(50)
    expect(deviceOf(a, page.device.id).own.withoutPhrase).toEqual({ mode: "typesafe", fallback: "alpha", giveUpMs: 400 })
  })
})

describe("conversation.read", () => {
  it("answers with the other assistant's history and id, to the requester only, without changing who answers", async () => {
    await start((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "bravo" }
    })
    const { client: page } = await voice()
    const watcher = await voice()
    const a = await admin()
    expect((await typed(page, "hello to bravo")).assistantId).toBe("bravo")
    expect((await typed(page, "hello to alpha", "alpha")).assistantId).toBe("alpha")
    const from = page.messages.length
    const watcherFrom = watcher.client.messages.length
    page.send({ type: "conversation.read", requestId: "read-1", assistantId: "alpha" })
    const history = await page.waitFor("conversation.history", () => true, { from })
    expect(history).toMatchObject({ requestId: "read-1", assistantId: "alpha" })
    expect(history.history.map((h) => [h.role, h.text])).toEqual([["user", "hello to alpha"], ["assistant", "Reply to hello to alpha."]])
    expect(history.id).toMatch(/^[0-9a-f-]{36}$/)
    // Bravo's, too, and the snapshot of a new tab lists both conversations; the answering assistant is unchanged.
    page.send({ type: "conversation.read", requestId: "read-2", assistantId: "bravo" })
    const bravo = await page.waitFor("conversation.history", (m) => m.requestId === "read-2", { from })
    expect(bravo.history.map((h) => h.text)).toEqual(["hello to bravo", "Reply to hello to bravo."])
    expect(bravo.id).not.toBe(history.id)
    expect(page.messages.slice(from).some((m) => m.type === "device.setup")).toBe(false)
    await sleep(50)
    expect(watcher.client.messages.slice(watcherFrom).some((m) => m.type === "conversation.history")).toBe(false)
    expect(a.messages.some((m) => m.type === "conversation.history")).toBe(false)
    const again = await connect()
    const joined = await again.hello({ device: page.device })
    expect(joined.snapshot.history.map((h) => h.text)).toEqual(["hello to bravo", "Reply to hello to bravo."])
    expect(joined.snapshot.conversations!.map((c) => [c.assistantId, c.turns])).toEqual([["alpha", 1], ["bravo", 1]])
    expect(joined.snapshot.conversations!.find((c) => c.assistantId === "alpha")!.id).toBe(history.id)
    // Admin sees both conversations of the device's session.
    const session = (await a.waitFor("sessions", (m) => m.sessions.some((s) => (s.conversations?.length ?? 0) === 2), { from: 0, timeoutMs: 5_000 })).sessions[0]!
    expect(session).toMatchObject({ answering: "bravo" })
  })

  it("refuses an assistant that is not on the device (unknown_assistant); a device without a session yet answers with an empty history", async () => {
    await start()
    const { client: page } = await voice()
    expect(await request(page, { type: "conversation.read", assistantId: "ghost" })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    page.send({ type: "conversation.read", requestId: "read-empty", assistantId: "bravo" })
    expect(await page.waitFor("conversation.history", () => true)).toMatchObject({ requestId: "read-empty", assistantId: "bravo", history: [] })
  })
})

// A scripted client may also be a voice connection without a device: it has a setup of the browser defaults.
describe("voice connection without a device", () => {
  it("gets the browser defaults as its setup and cannot pick", async () => {
    await start()
    const client = await connect()
    const welcome = await client.hello({ device: false })
    expect(welcome.snapshot.setup).toMatchObject({ canPick: false })
    expect(welcome.snapshot.setup!.deviceId).toBeUndefined()
    expect(await request(client, { type: "device.pick", withoutPhrase: "alpha" })).toMatchObject({ ok: false, error: { code: "bad_message" } })
  })
})

describe("changes that must hold together", () => {
  it("a type's defaults are refused when a device that follows them would no longer hold together", async () => {
    await start()
    const { client: page } = await voice()
    const a = await admin()
    await deviceKnown(a, page.device.id)
    const device = { kind: "device", id: page.device.id } as const
    const type = { kind: "type", type: "web-voice" } as const
    // The device answers as Bravo without a phrase (its own section) and follows the type's list (Alpha and Bravo).
    expect(await request(a, { type: "device.save", target: device, rev: deviceOf(a, page.device.id).rev, settings: { withoutPhrase: { mode: "assistant", assistant: "bravo" } } }))
      .toMatchObject({ ok: true })
    const rev = typeOf(a).rev
    const onlyAlpha = { assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }] }
    expect(await request(a, { type: "device.save", target: type, rev, settings: onlyAlpha })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", message: expect.stringContaining("bravo") }
    })
    expect(typeOf(a).rev).toBe(rev)
    expect(deviceOf(a, page.device.id).settings.assistants.map((x: any) => x.assistant)).toEqual(["alpha", "bravo"])
    // Once the device follows the type's withoutPhrase again, the same defaults are saved.
    expect(await request(a, { type: "device.save", target: device, rev: deviceOf(a, page.device.id).rev, settings: { withoutPhrase: null } })).toMatchObject({ ok: true })
    expect(await request(a, { type: "device.save", target: type, rev, settings: onlyAlpha })).toMatchObject({ ok: true })
  })

  it("two creates with the same name at once: one is created, the other is refused as a taken name", async () => {
    await start()
    const a = await admin()
    await refresh(a)
    const results = await Promise.all([
      request(a, { type: "assistant.create", assistant: body("Desk") }),
      request(a, { type: "assistant.create", assistant: body("Desk") })
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "invalid_settings", fieldErrors: [{ key: "name" }] } })
    const pushed = await a.waitFor("assistants", (m) => m.assistants.some((x) => x.name === "Desk"), { from: 0 })
    expect(pushed.assistants.filter((x) => x.name === "Desk")).toHaveLength(1)
  })

  it("before its session exists, a device gives each assistant its own conversation id, and the session keeps them", async () => {
    await start()
    const { client: page } = await voice()
    const read = async (assistantId: string) => {
      const requestId = `read-${++seq}`
      const from = page.messages.length
      page.send({ type: "conversation.read", requestId, assistantId })
      return (await page.waitFor("conversation.history", (m) => m.requestId === requestId, { from })).id
    }
    const alpha = await read("alpha")
    const bravo = await read("bravo")
    expect(bravo).not.toBe(alpha)
    expect(await read("bravo")).toBe(bravo)
    expect(await read("alpha")).toBe(alpha)
    // The session opens; both assistants start in the ids read before.
    await typed(page, "hello to alpha", "alpha")
    await typed(page, "hello to bravo", "bravo")
    expect(await read("alpha")).toBe(alpha)
    expect(await read("bravo")).toBe(bravo)
  })

  /** Alpha answers without a phrase and the page may pick; `read` is `conversation.read` of one assistant's id. */
  const alphaAnswersWithPick = async () => {
    await start((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "alpha" }
      file.deviceTypes["web-voice"].voicePage = { pick: true }
    })
    const { client: page, welcome } = await voice()
    const read = async (assistantId: string) => {
      const requestId = `read-${++seq}`
      const from = page.messages.length
      page.send({ type: "conversation.read", requestId, assistantId })
      return (await page.waitFor("conversation.history", (m) => m.requestId === requestId, { from })).id
    }
    return { page, welcome, read }
  }

  it("before its session exists, each assistant keeps its own conversation id when the page picks who answers", async () => {
    const { page, welcome, read } = await alphaAnswersWithPick()
    const alpha = await read("alpha")
    const bravo = await read("bravo")
    expect(bravo).not.toBe(alpha)
    // The device's own id (the welcome's) is the answering assistant's.
    expect(welcome.snapshot.conversation.id).toBe(alpha)
    expect(await request(page, { type: "device.pick", withoutPhrase: "bravo" })).toMatchObject({ ok: true })
    await page.waitFor("device.setup", (m) => m.withoutPhrase.mode === "assistant" && m.withoutPhrase.assistant === "bravo", { from: 0 })
    expect(await read("bravo")).toBe(bravo)
    expect(await read("alpha")).toBe(alpha)
    // The session opens with Bravo answering; neither id moves to the other assistant.
    await typed(page, "hello to alpha", "alpha")
    await typed(page, "hello to bravo", "bravo")
    expect(await read("alpha")).toBe(alpha)
    expect(await read("bravo")).toBe(bravo)
  })

  it("before its session exists, conversation.new replaces only the named assistant's id and says whose it is", async () => {
    const { page, read } = await alphaAnswersWithPick()
    const alpha = await read("alpha")
    const bravo = await read("bravo")
    let from = page.messages.length
    expect(await request(page, { type: "conversation.new", assistantId: "bravo" })).toMatchObject({ ok: true })
    const bravoNew = await page.waitFor("conversation", (m) => m.reason === "new", { from })
    expect(bravoNew).toMatchObject({ assistantId: "bravo" })
    expect(bravoNew.id).not.toBe(bravo)
    expect(await read("bravo")).toBe(bravoNew.id)
    expect(await read("alpha")).toBe(alpha)
    // Without an assistant: the one that will answer (Alpha).
    from = page.messages.length
    expect(await request(page, { type: "conversation.new" })).toMatchObject({ ok: true })
    const alphaNew = await page.waitFor("conversation", (m) => m.reason === "new", { from })
    expect(alphaNew).toMatchObject({ assistantId: "alpha" })
    expect(alphaNew.id).not.toBe(alpha)
    expect(await read("alpha")).toBe(alphaNew.id)
    expect(await read("bravo")).toBe(bravoNew.id)
    // The session starts both in those ids.
    await typed(page, "hello to alpha", "alpha")
    await typed(page, "hello to bravo", "bravo")
    expect(await read("alpha")).toBe(alphaNew.id)
    expect(await read("bravo")).toBe(bravoNew.id)
  })
  it("conversation.new refuses an assistant that is not on the device (unknown_assistant), with or without a session, and nothing is reserved for it", async () => {
    const { page, read } = await alphaAnswersWithPick()
    const alpha = await read("alpha")
    const from = page.messages.length
    for (const ghost of ["ghost-one", "ghost-two"]) {
      expect(await request(page, { type: "conversation.new", assistantId: ghost })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    }
    expect(page.types(from)).not.toContain("conversation")
    expect(await read("alpha")).toBe(alpha)
    // With a session too.
    await typed(page, "hello to alpha", "alpha")
    expect(await request(page, { type: "conversation.new", assistantId: "ghost-three" })).toMatchObject({ ok: false, error: { code: "unknown_assistant" } })
    expect(await read("alpha")).toBe(alpha)
  })

  it("before its session exists, an assistant that stays on the device keeps its id while others come and go; one put back gets a new id", async () => {
    const others = ["charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]
    await start((file) => {
      for (const id of others) {
        file.assistants.order.push(id)
        file.assistants.byId[id] = { ...file.assistants.byId.bravo, id, name: `${id[0]!.toUpperCase()}${id.slice(1)}`, prompt: `You are ${id}.` }
      }
    })
    const { client: page } = await voice()
    const a = await admin()
    const read = async (assistantId: string) => {
      const requestId = `read-${++seq}`
      const from = page.messages.length
      page.send({ type: "conversation.read", requestId, assistantId })
      return (await page.waitFor("conversation.history", (m) => m.requestId === requestId, { from })).id
    }
    /** The type's defaults (which the device follows): Alpha, answering as the first, and `second`. */
    const withSecond = async (second: string) => {
      const rev = typeOf(a).rev
      const assistants = [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: second, phrases: [`hey ${second}`] }]
      expect(await request(a, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev, settings: { assistants } })).toMatchObject({ ok: true })
      await a.waitFor("device.types", (m) => m.types.some((t) => t.kind === "web-voice" && t.rev === rev + 1), { from: 0 })
    }
    const alpha = await read("alpha")
    const bravo = await read("bravo")
    // Ten assistants get a reservation in turn, but only two are ever on the device: Alpha's is never dropped.
    for (const second of others) {
      await withSecond(second)
      await read(second)
    }
    expect(await read("alpha")).toBe(alpha)
    // Bravo was taken off the device, and its reservation with it. Put back, it starts a new conversation: a new id.
    await withSecond("bravo")
    const bravoAgain = await read("bravo")
    expect(bravoAgain).not.toBe(bravo)
    expect(await read("alpha")).toBe(alpha)
    // The session opens; both start in the ids reserved for them.
    await typed(page, "hello to alpha", "alpha")
    await typed(page, "hello to bravo", "bravo")
    expect(await read("alpha")).toBe(alpha)
    expect(await read("bravo")).toBe(bravoAgain)
  })

  it("before its session exists, a TypeSafe fallback that will answer has the device's id, and keeps it", async () => {
    await start((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "typesafe", fallback: "bravo", giveUpMs: 700 }
    }, [greeterModule, deciderModule])
    const { client: page, welcome } = await voice()
    const read = async (assistantId: string) => {
      const requestId = `read-${++seq}`
      const from = page.messages.length
      page.send({ type: "conversation.read", requestId, assistantId })
      return (await page.waitFor("conversation.history", (m) => m.requestId === requestId, { from })).id
    }
    const bravo = await read("bravo")
    expect(welcome.snapshot.conversation.id).toBe(bravo)
    expect(await read("alpha")).not.toBe(bravo)
    await typed(page, "hello to bravo", "bravo")
    expect(await read("bravo")).toBe(bravo)
  })

  it("assistant.create: placements that add up to more than 12 phrases for the assistant on one device are refused before anything is created", async () => {
    await start()
    const a = await admin()
    await refresh(a)
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"]
    const placements = (n: number) => words.slice(0, n).map((w) => ({ target: { kind: "type", type: "web-voice" } as const, phrase: `hey charlie ${w}` }))
    const rev = typeOf(a).rev
    expect(await request(a, { type: "assistant.create", assistant: body("Charlie"), placements: placements(13) })).toMatchObject({
      ok: false,
      error: { code: "limit_reached", fieldErrors: [{ key: "assistants.2.phrases" }] }
    })
    expect(assistantsOf(a).map((x) => x.id)).toEqual(["alpha", "bravo"])
    expect(typeOf(a).rev).toBe(rev)
    // Twelve fit, and the defaults still encode and push.
    expect(await request(a, { type: "assistant.create", assistant: body("Charlie"), placements: placements(12) })).toMatchObject({ ok: true, assistantId: "charlie" })
    const pushed = await a.waitFor("device.types", (m) => m.types.some((t) => t.settings.assistants.some((x) => x.assistant === "charlie")), { from: 0 })
    expect(pushed.types.find((t) => t.kind === "web-voice")!.settings.assistants[2]!.phrases).toHaveLength(12)
  })
})
