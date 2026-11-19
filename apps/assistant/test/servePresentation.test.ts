// P10 on the server's real parts (docs/PRESENTING.md): the Presenter wired to the hub, the gateway and the module host.
// A page that declares the kinds is shown what applies to it, two tabs both, a reconnect gets its pinned ones again; a
// tick from the page that holds it reaches the module's handler through the hub's bounded admission, from another device
// it is refused; an override that takes the display away ends the session and the page that comes back is shown
// nothing; a tool's { forModel, present } reaches the page off the turn's path; /media serves only what a page holds;
// an older page (no kinds declared) is sent nothing and keeps working.
import { defineModule, makeTool, type ModulePresent, type Presentation } from "@pva/core"
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
const presses: Array<string> = []
let handlerWait = 0
let toolResult: unknown = "nothing"
const board = defineModule({
  apiVersion: 2,
  id: "board",
  name: "Board",
  description: "Shows things.",
  shared: (ctx) =>
    Effect.gen(function*() {
      present = ctx.present
      yield* ctx.present.handle("answer", {
        run: (p) => Effect.andThen(Effect.sleep(handlerWait), Effect.sync(() => (presses.push(`${p.action}:${p.item ?? ""}`), { say: "Ticked." })))
      }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () => Effect.succeed({ tools: [makeTool({ name: "board_show", description: "Show the board.", parameters: Schema.Struct({}), execute: () => Effect.sync(() => toolResult) })] })
})

const SCREEN = {
  v: 1,
  display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true },
  present: { kinds: { ...PRESENT_KIND_VERSIONS } },
  speaker: { media: ["speech"] }
}
const checklist: Presentation = {
  kind: "list",
  title: "Shopping",
  style: "checklist",
  items: [{ id: "milk", text: "Milk" }, { id: "eggs", text: "Eggs" }],
  spoken: "Milk and eggs.",
  handler: "answer"
}

const start = async (home?: Record<string, string>) => {
  presses.length = 0
  handlerWait = 0
  const stt = controlledStt()
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, board] })
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  await admin.admin(TEST_ADMIN_PASSWORD)
  if (home !== undefined) {
    admin.send({ type: "settings.update", requestId: "home", sectionId: "home", patch: { values: home, secrets: {} } })
    await admin.waitFor("result", (m) => m.requestId === "home", { from: 0 })
  }
  await until(() => present !== undefined)
  return { admin }
}
const page = async (deviceId: string, capabilities: unknown = SCREEN) => {
  const c = await ScriptedClient.connect({ url: server!.url, deviceId, player: { enabled: false } })
  clients.push(c)
  await c.hello(capabilities !== undefined ? { device: { ...c.device, capabilities: capabilities as never } } : {})
  return c
}
/** What a page holds now, replayed from what it was sent. */
const holds = (c: ScriptedClient) => {
  const m = new Map<string, Extract<ServerMessage, { type: "present.show" }>["presentation"]>()
  for (const msg of c.messages) {
    if (msg.type === "present.show" || msg.type === "present.update") m.set(msg.presentation.id, msg.presentation)
    if (msg.type === "present.dismiss") m.delete(msg.id)
  }
  return m
}
let seq = 0
const tick = (c: ScriptedClient, id: string, item = "milk") => {
  const requestId = `t-${++seq}`
  c.send({ type: "present.action", requestId, id, action: "tick", item, done: true })
  return c.waitFor("result", (m) => m.requestId === requestId, { from: 0 })
}

describe("presentation through the hub", () => {
  it("a page that declares the kinds is shown it; two tabs both; a reconnect gets the pinned one again; an older page is sent nothing", async () => {
    await start()
    const a = await page("present-kitchen-01")
    const b = await page("present-kitchen-01")
    const old = await page("present-old-0001", { v: 1, display: SCREEN.display })
    await sleep(300)
    const h = await run(present!.show({ device: a.device.id }, checklist, { lifetime: "pinned" }))
    expect(h.outcome.note).toMatch(/^Shown on "/)
    await until(() => holds(a).has(h.id) && holds(b).has(h.id))
    expect(holds(a).get(h.id)?.interactive).toBe(true)
    const older = await run(present!.show({ device: old.device.id }, checklist))
    expect(older.outcome.devices).toEqual([{ deviceId: old.device.id, shown: false, why: "cannot-show-kind" }])
    await sleep(200)
    expect(old.messages.some((m) => m.type.startsWith("present."))).toBe(false)
    // The tab goes; a new one of the same device gets the pinned one again.
    a.close()
    const again = await page("present-kitchen-01")
    await until(() => holds(again).has(h.id))
    await run(h.dismiss)
    await until(() => !holds(again).has(h.id) && !holds(b).has(h.id))
  })

  it("a tick from the page that holds it reaches the handler (through the hub's admission); from another device it is refused; over the bound, the household's sentence", async () => {
    await start({ HOME_LANGUAGE: "nl-NL" })
    const a = await page("present-kitchen-02")
    const other = await page("present-hall-0002")
    await sleep(300)
    const h = await run(present!.show({ device: a.device.id }, checklist, { lifetime: "pinned" }))
    await until(() => holds(a).has(h.id))
    expect(await tick(a, h.id)).toMatchObject({ ok: true, say: "Ticked." })
    expect(presses).toEqual(["tick:milk"])
    const refused = await tick(other, h.id)
    expect(refused).toMatchObject({ ok: false, say: "Dat kan ik nu niet doen." })
    expect(presses).toEqual(["tick:milk"])
    // Over the hub's bound (4 pending per connection): refused with the Presenter's sentence in Dutch.
    handlerWait = 300
    const many = await Promise.all(Array.from({ length: 8 }, () => tick(a, h.id, "eggs")))
    const busy = many.filter((r) => !r.ok && r.error?.code === "busy")
    expect(busy.length).toBeGreaterThan(0)
    for (const r of busy) expect(["Te veel tegelijk; probeer het zo opnieuw.", "Daar wordt al aan gewerkt."]).toContain(r.say)
  })

  it("an override that takes the display away ends the session; the page that comes back is shown nothing", async () => {
    const { admin } = await start()
    const a = await page("present-kitchen-03")
    await sleep(300)
    const h = await run(present!.show({ device: a.device.id }, checklist, { lifetime: "pinned" }))
    await until(() => holds(a).has(h.id))
    const rec = server!.handle.store.settings().devices[a.device.id]!
    admin.send({ type: "device.save", requestId: "s", target: { kind: "device", id: a.device.id }, rev: rec.rev, settings: { capabilities: { noDisplay: true, noSpeaker: false, excludeKinds: [] } } })
    expect((await admin.waitFor("result", (m) => m.requestId === "s", { from: 0 })).ok).toBe(true)
    await a.closed
    const back = await page("present-kitchen-03")
    await sleep(400)
    expect(holds(back).size).toBe(0)
  })

  it("a tool's { forModel, present } gives the model forModel and the note, and the page the presentation; /media serves only what a page holds", async () => {
    await start()
    const a = await page("present-kitchen-04")
    await sleep(300)
    toolResult = { forModel: "Two things.", present: checklist }
    const registry = server!.handle.host.snapshot().registry
    const { CurrentTurn } = await import("@pva/core")
    const assistantId = Object.keys(server!.handle.store.settings().assistants.byId)[0]!
    // Serve mode admits only a complete principal: the turn names its assistant and device, the way a session's turn does.
    const result = await run(registry.run({ id: "c1", name: "board_show", input: {} }).pipe(
      Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "text", assistantId, deviceId: a.device.id })
    ))
    expect(result.content).toBe("Two things.\n[Screen: Shown on \"" + (server!.handle.store.settings().devices[a.device.id]?.name ?? "") + "\".]")
    await until(() => [...holds(a).values()].some((p) => p.content.kind === "list"))
    const res = await fetch(`${server!.url.replace(/^ws/, "http").replace(/\/ws$/, "")}/media/${"c".repeat(64)}`)
    expect(res.status).toBe(404)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })
})
