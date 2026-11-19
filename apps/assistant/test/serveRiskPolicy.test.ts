// P8 on the server's real parts: the risk policy saved on the admin page (settings.update of the `risk` section) is read
// by the gateway at the next call and the next tool list, without a restart, on the cached registry of the running
// modules; money cannot be opened through the admin API; a press on a presentation is decided too and answered with
// the policy's sentence in the household's language; a personal result is withheld where the asking device may not
// reveal it.
import { CurrentTurn, defineModule, makeTool, type ModulePresent } from "@pva/core"
import { PRESENT_KIND_VERSIONS, type ServerMessage } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(10)
  }
}

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

let present: ModulePresent | undefined
const ran: Array<string> = []
const switches = defineModule({
  apiVersion: 2,
  id: "switches",
  name: "Switches",
  description: "A lamp.",
  shared: (ctx) =>
    Effect.gen(function*() {
      present = ctx.present
      yield* ctx.present.handle("lamp", { run: () => Effect.sync(() => (ran.push("press"), { say: "Lamp on." })) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () =>
    Effect.succeed({
      tools: [
        makeTool({ name: "lamp", description: "Switch the lamp on.", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.sync(() => (ran.push("lamp"), "on")) }),
        makeTool({ name: "diary", description: "Read a diary.", parameters: Schema.Struct({}), speculative: true, sensitivity: "personal", execute: () => Effect.succeed("Dear diary") })
      ]
    })
})

const SCREEN = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, present: { kinds: { ...PRESENT_KIND_VERSIONS } }, speaker: { media: ["speech"] } }

const start = async () => {
  ran.length = 0
  server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, switches] })
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  await admin.admin(TEST_ADMIN_PASSWORD)
  await until(() => present !== undefined)
  let n = 0
  const save = async (sectionId: string, values: Record<string, unknown>) => {
    const requestId = `s${++n}`
    admin.send({ type: "settings.update", requestId, sectionId, patch: { values: values as never, secrets: {} } })
    return admin.waitFor("result", (m) => m.requestId === requestId, { from: 0 })
  }
  return { admin, save }
}
const page = async (deviceId: string) => {
  const c = await ScriptedClient.connect({ url: server!.url, deviceId, player: { enabled: false } })
  clients.push(c)
  await c.hello({ device: { ...c.device, capabilities: SCREEN as never } })
  return c
}

describe("the risk policy in serve mode", () => {
  it("a saved change applies to the next call and the next tool list, without a restart; money stays refused", async () => {
    const { save } = await start()
    const a = await page("risk-kitchen-0001")
    await sleep(200)
    const registry = server!.handle.host.snapshot().registry
    const assistantId = Object.keys(server!.handle.store.settings().assistants.byId)[0]!
    const turn = { turnId: 1, conversationId: "c", source: "text" as const, assistantId, deviceId: a.device.id }
    const call = (name: string) => run(registry.run({ id: name, name, input: {} }).pipe(Effect.provideService(CurrentTurn, turn)))
    expect(registry.specs.map((s) => s.name)).toContain("lamp")
    expect((await call("lamp")).content).toBe("on")
    expect((await save("risk", { RISK_CHANGE: "deny" })).ok).toBe(true)
    // The same registry object (the running modules did not change): its list and its calls follow the saved policy.
    expect(server!.handle.host.snapshot().registry).toBe(registry)
    expect(registry.specs.map((s) => s.name)).not.toContain("lamp")
    expect((await call("lamp")).content).toBe("Not run: it would change something in the house, which this household does not allow.")
    // Dutch household: the refusal in Dutch, at the next call.
    expect((await save("home", { HOME_LANGUAGE: "nl-NL" })).ok).toBe(true)
    expect((await call("lamp")).content).toBe("Niet uitgevoerd: het zou iets in huis veranderen, en dat staat dit huishouden niet toe.")
    // Money cannot be opened through the admin API.
    const money = await save("risk", { RISK_MONEY: "allow" })
    expect(money.ok).toBe(false)
    expect(JSON.stringify(money)).toContain("Fixed at Refuse")
    expect(ran).toEqual(["lamp"])
    // A personal result with no known owner is someone else's: withheld from the model on this device.
    expect((await call("diary")).content).toMatch(/^Achtergehouden: /)
  })

  it("a press on a presentation is decided on the saved policy and answered with its sentence in the household's language", async () => {
    const { save } = await start()
    await save("home", { HOME_LANGUAGE: "nl-NL" })
    const a = await page("risk-kitchen-0002")
    await sleep(200)
    const h = await run(present!.show({ device: a.device.id }, { kind: "card", title: "Lamp", text: "Press", spoken: "A lamp.", handler: "lamp", buttons: [{ id: "on", label: "On" }] }, { lifetime: "pinned" }))
    const holds = () => a.messages.some((m: ServerMessage) => m.type === "present.show" && m.presentation.id === h.id)
    await until(holds)
    const press = async (id: string) => {
      a.send({ type: "present.action", requestId: id, id: h.id, action: "on" })
      return a.waitFor("result", (m) => m.requestId === id, { from: 0 })
    }
    expect(await press("p1")).toMatchObject({ ok: true, say: "Lamp on." })
    expect((await save("risk", { RISK_CHANGE: "confirm" })).ok).toBe(true)
    expect(await press("p2")).toMatchObject({ ok: false, say: "Dat kan ik niet doen: dit huishouden wil dat de eigenaar wijzigingen eerst bevestigt, en daar kan ik nog niet om vragen." })
    expect(ran).toEqual(["press"])
  })
})
