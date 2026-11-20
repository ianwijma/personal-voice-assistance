// P8, review round 1, H7 (note 8): a personal result is decided once, when its tool finishes, and is not checked again
// at dispatch. In serve mode a committed boundary change (here the device made public while a sibling tool waits)
// fences the device's session: its page is closed, the turn is cancelled, and nothing personal is dispatched to the
// model afterwards.
import { defineModule, Llm, type LlmEvent, type LlmRequest, makeTool } from "@pva/core"
import { type ClientMessage, CloseCode, type DeviceListInfo, type ServerMessageOf } from "@pva/protocol"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 40_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

const owner = { current: "" }
let releaseSlow: (() => void) | undefined
let slowStarted = false
const diary = defineModule({
  id: "diary",
  name: "Diary",
  description: "",
  start: () =>
    Effect.succeed({
      tools: [
        makeTool({
          name: "peek",
          description: "Read the diary.",
          parameters: Schema.Struct({}),
          speculative: true,
          sensitivity: (r) => ({ kind: "personal", owner: (r as { owner: string }).owner }),
          execute: () => Effect.sync(() => ({ owner: owner.current, text: "PRIVATE-CONTENT" }))
        }),
        makeTool({
          name: "slow",
          description: "Takes a while.",
          parameters: Schema.Struct({}),
          speculative: true,
          execute: () =>
            Effect.as(
              Effect.promise(() =>
                new Promise<void>((resolve) => {
                  slowStarted = true
                  releaseSlow = resolve
                })
              ),
              "slow done"
            )
        })
      ]
    })
})

const requests: Array<LlmRequest> = []
const twoTools: LlmBuilder = () =>
  Effect.succeed(Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(request)
        const last = request.messages.at(-1)
        const events: Array<LlmEvent> = last?.role === "tool"
          ? [{ _tag: "TextDelta", text: "Done." }, { _tag: "Done", stopReason: "end" }]
          : [{ _tag: "ToolCall", id: "c1", name: "peek", input: {} }, { _tag: "ToolCall", id: "c2", name: "slow", input: {} }, { _tag: "Done", stopReason: "tool_use" }]
        return Stream.fromIterable(events)
      })
  }))

const dataDirWithDiary = async (): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-risk-wait-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", toolRounds: 3, llm: { ...base.llm, account: "anthropic", model: "model-a" }, modules: { diary: { on: true, offTools: [] } } }
  file.assistants = { order: ["alpha"], byId: { alpha } }
  file.deviceTypes["web-voice"] = { ...file.deviceTypes["web-voice"], assistants: [{ assistant: "alpha", phrases: [] }], withoutPhrase: { mode: "assistant", assistant: "alpha" }, interruptMode: "instant" }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

let counter = 0
type Request = Extract<ClientMessage, { requestId: string }>
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never
const request = async (client: ScriptedClient, message: WithoutId<Request>) => {
  const requestId = `r${++counter}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from, timeoutMs: 10_000 })
}
const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 800 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}
const lastDevices = (admin: ScriptedClient): ReadonlyArray<DeviceListInfo> => {
  const pushed = admin.messages.filter((m): m is ServerMessageOf<"devices"> => m.type === "devices").at(-1)
  return pushed?.devices ?? admin.messages.flatMap((m) => (m.type === "admin.snapshot" ? [m.snapshot.devices] : [])).at(-1) ?? []
}

describe("a personal result waiting for a sibling while the device's privacy changes (serve)", () => {
  it("the save fences the session: the turn is cancelled and nothing personal reaches the model", async () => {
    requests.length = 0
    slowStarted = false
    const dataDir = await dataDirWithDiary()
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), buildLlm: twoTools, dataDir, catalog: [diary] })
    const store = server.handle.store
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam" }] }, secrets: {} } })).ok).toBe(true)
    owner.current = (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>)[0]!.id as string

    let page = await ScriptedClient.connect({ url: server.url, deviceId: "risk-wait-tab-1" })
    clients.push(page)
    await page.hello()
    await until("the device record", () => lastDevices(admin).some((d) => d.id === "risk-wait-tab-1"))
    const rev = () => lastDevices(admin).find((d) => d.id === "risk-wait-tab-1")?.rev ?? 0
    const place = { room: "Study", privacy: "private" as const, alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: owner.current }
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "risk-wait-tab-1" }, rev: rev(), settings: { place } })).ok).toBe(true)
    // A boundary change ends the page's session; it reconnects (as the web client does).
    expect((await page.closed).code).toBe(CloseCode.settingsChanged)
    page = await ScriptedClient.connect({ url: server.url, deviceId: "risk-wait-tab-1", clientId: page.clientId })
    clients.push(page)
    await page.hello()

    // A typed turn: peek (Sam's, revealed on this private device) finishes; slow waits.
    page.send({ type: "text.send", requestId: `t${++counter}`, text: "read my diary", speak: false })
    await until("the sibling waiting", () => slowStarted)
    await sleep(50)
    expect(requests.length).toBe(1)
    // The device is made public while the sibling waits: a committed boundary change.
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "risk-wait-tab-1" }, rev: rev(), settings: { place: { ...place, privacy: "public" } } })).ok).toBe(true)
    expect((await page.closed).code).toBe(CloseCode.settingsChanged)
    releaseSlow?.()
    await sleep(500)
    // Nothing personal was dispatched after the change: the cancelled turn made no second request at all.
    expect(requests.length).toBe(1)
    for (const r of requests.slice(1)) expect(JSON.stringify(r.messages)).not.toContain("PRIVATE-CONTENT")
  })
})
