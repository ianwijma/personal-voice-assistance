// P10 on the server's real parts (docs/PRESENTING.md): the Presenter wired to the hub, the gateway and the module host.
// A page that declares the kinds is shown what applies to it, two tabs both, a reconnect gets its pinned ones again; a
// tick from the page that holds it reaches the module's handler through the hub's bounded admission, from another device
// it is refused; an override that takes the display away ends the session and the page that comes back is shown
// nothing; a tool's { forModel, present } reaches the page off the turn's path; /media serves only what a page holds;
// an older page (no kinds declared) is sent nothing and keeps working.
import { defineModule, makeTool, type ModulePresent, type Presentation } from "@pva/core"
import { PRESENT_KIND_VERSIONS, type ServerMessage } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
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
const boards = new Map<string, ModulePresent>()
const presses: Array<string> = []
let handlerWait = 0
/** While set, every handler waits for it (presses stay pending, holding their place in the hub's bound). */
let handlerGate: Promise<void> | undefined
let toolResult: unknown = "nothing"
const boardModule = (id: string) =>
  defineModule({
    apiVersion: 2,
    id,
    name: `Board ${id}`,
    description: "Shows things.",
    shared: (ctx) =>
      Effect.gen(function*() {
        if (id === "board") present = ctx.present
        boards.set(id, ctx.present)
        yield* ctx.present.handle("answer", {
          run: (p) =>
            Effect.andThen(
              Effect.andThen(Effect.sleep(handlerWait), Effect.promise(() => handlerGate ?? Promise.resolve())),
              Effect.sync(() => (presses.push(`${p.action}:${p.item ?? ""}`), { say: "Ticked." }))
            )
        }).pipe(Effect.orDie)
        return { value: undefined }
      }),
    start: () => Effect.succeed({ tools: id === "board" ? [makeTool({ name: "board_show", description: "Show the board.", parameters: Schema.Struct({}), execute: () => Effect.sync(() => toolResult) })] : [] })
  })
const board = boardModule("board")

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4])
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
  handlerGate = undefined
  const stt = controlledStt()
  server = await startTestServer({
    build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "Ok.").llm }),
    catalog: [greeterModule, board, boardModule("board2"), boardModule("board3")],
    mediaFetch: {
      resolver: async () => ["93.184.216.34"],
      connector: async () => ({ status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) }, body: (async function*() {
        yield PNG
      })() })
    }
  })
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
  c.send({ type: "present.action", requestId, id, revision: holds(c).get(id)?.revision ?? "missing", action: "tick", item, done: true })
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
    expect(h.outcome.note).toMatch(/^Showing on "/)
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
  })

  it("present.close from a tab that holds it dismisses it on every tab (through the hub's admission); from another device it is refused and stays", async () => {
    await start({ HOME_LANGUAGE: "nl-NL" })
    const a = await page("present-close-0001")
    const b = await page("present-close-0001")
    const other = await page("present-close-0002")
    await sleep(300)
    const h = await run(present!.show({ device: a.device.id }, { kind: "card", title: "Bins", spoken: "Bins." }, { lifetime: "pinned" }))
    await until(() => holds(a).has(h.id) && holds(b).has(h.id))
    expect(holds(a).get(h.id)).toMatchObject({ closable: true, interactive: false, texts: { close: "Sluiten" } })
    const revision = holds(a).get(h.id)!.revision
    other.send({ type: "present.close", requestId: "c-other", id: h.id, revision })
    expect(await other.waitFor("result", (m) => m.requestId === "c-other", { from: 0 })).toMatchObject({ ok: false, say: "Dat kan ik nu niet doen." })
    expect(holds(a).has(h.id)).toBe(true)
    a.send({ type: "present.close", requestId: "c-own", id: h.id, revision })
    expect(await a.waitFor("result", (m) => m.requestId === "c-own", { from: 0 })).toMatchObject({ ok: true })
    await until(() => !holds(a).has(h.id) && !holds(b).has(h.id))
    expect(await run(h.dismiss)).toBe(false)
  })

  it("b15: the hub's bound: four pending presses per connection on distinct presentations, the fifth refused with the Presenter's sentence; sixteen in all; slots given back", async () => {
    await start({ HOME_LANGUAGE: "nl-NL" })
    const pages = [] as Array<ScriptedClient>
    for (let i = 0; i < 5; i++) pages.push(await page(`present-bound-0${i}`))
    await sleep(300)
    // Four distinct pinned presentations on each of five devices, from three modules (each within its bound).
    const ids = new Map<ScriptedClient, Array<string>>()
    let n = 0
    for (const c of pages) {
      const mine: Array<string> = []
      for (let k = 0; k < 4; k++, n++) {
        const h = await run(boards.get(["board", "board2", "board3"][n % 3]!)!.show({ device: c.device.id }, checklist, { lifetime: "pinned" }))
        mine.push(h.id)
      }
      ids.set(c, mine)
    }
    const extra = await run(boards.get("board3")!.show({ device: pages[0]!.device.id }, checklist, { lifetime: "pinned" }))
    await until(() => pages.every((c) => ids.get(c)!.every((id) => holds(c).has(id))) && holds(pages[0]!).has(extra.id))
    let release: () => void = () => undefined
    handlerGate = new Promise((resolve) => (release = resolve))
    // One connection: four pending, the fifth (another presentation it holds) refused by the hub, not by a claim.
    const first = ids.get(pages[0]!)!.map((id) => tick(pages[0]!, id))
    await sleep(200)
    const fifth = await tick(pages[0]!, extra.id)
    expect(fifth).toMatchObject({ ok: false, error: { code: "busy" }, say: "Te veel tegelijk; probeer het zo opnieuw." })
    // In all: three more connections fill sixteen; the fifth connection's first press is refused.
    const more = pages.slice(1, 4).flatMap((c) => ids.get(c)!.map((id) => tick(c, id)))
    await sleep(200)
    const overall = await tick(pages[4]!, ids.get(pages[4]!)![0]!)
    expect(overall).toMatchObject({ ok: false, error: { code: "busy" }, say: "Te veel tegelijk; probeer het zo opnieuw." })
    release()
    const answers = await Promise.all([...first, ...more])
    expect(answers.every((r) => r.ok)).toBe(true)
    expect(presses).toHaveLength(16)
    // The slots were given back: the refused ones go through now.
    expect(await tick(pages[0]!, extra.id)).toMatchObject({ ok: true })
    expect(await tick(pages[4]!, ids.get(pages[4]!)![0]!)).toMatchObject({ ok: true })
  })

  it("b1: a crossed press from a delayed tab cannot run the replacement handler", async () => {
    await start()
    const delayed = await page("present-crossed-01")
    const other = await page("present-crossed-01")
    await sleep(300)
    const opts = { lifetime: "pinned", key: "drink" } as const
    const drink = (title: string): Presentation => ({ kind: "card", title, spoken: title, handler: "answer", buttons: [{ id: "choose", label: title }] })
    const h = await run(present!.show({ device: delayed.device.id }, drink("Tea"), opts))
    await until(() => holds(delayed).has(h.id) && holds(other).has(h.id))
    const tea = holds(delayed).get(h.id)!
    delayed.ws.pause()
    try {
      await run(present!.show({ device: delayed.device.id }, drink("Coffee"), opts))
      await until(() => holds(other).get(h.id)?.revision !== tea.revision)
      delayed.send({ type: "present.action", requestId: "crossed", id: tea.id, revision: tea.revision, action: "choose" })
      await sleep(100)
    } finally { delayed.ws.resume() }
    const answer = await delayed.waitFor("result", (m) => m.requestId === "crossed", { from: 0 })
    expect(answer.ok).toBe(false)
    expect(presses).toEqual([])
    const coffee = holds(other).get(h.id)!
    other.send({ type: "present.action", requestId: "fresh", id: coffee.id, revision: coffee.revision, action: "choose" })
    expect((await other.waitFor("result", (m) => m.requestId === "fresh", { from: 0 })).ok).toBe(true)
    expect(presses).toEqual(["choose:"])
  })

  it("b5: an unknown device kind is welcomed but cannot be targeted or sent presentations", async () => {
    await start()
    const c = await ScriptedClient.connect({ url: server!.url, deviceId: "future-screen-01", player: { enabled: false } })
    clients.push(c)
    await c.hello({ device: { ...c.device, kind: "future-screen", capabilities: SCREEN as never } })
    await sleep(100)
    await expect(run(present!.show({ device: c.device.id }, checklist))).rejects.toThrow(/there is no device/)
    expect(c.messages.some((m) => m.type === "present.show")).toBe(false)
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
    expect(result.content).toBe("Two things.\n[Screen: Showing on \"" + (server!.handle.store.settings().devices[a.device.id]?.name ?? "") + "\".]")
    await until(() => [...holds(a).values()].some((p) => p.content.kind === "list"))
  })

  it("b1: an image's address belongs to one page: served to it while it holds the image, never by its hash, not to another page, not after it lets go", async () => {
    await start()
    const a = await page("present-image-a1")
    const b = await page("present-image-b1")
    const sameDevice = await page("present-image-a1")
    await sleep(300)
    const http = server!.url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const h = await run(present!.show({ device: a.device.id }, { kind: "image", url: "https://img.example/a.png", alt: "A", credit: "C", spoken: "A." }, { lifetime: "pinned" }))
    const tokenOf = (c: ScriptedClient) => {
      const p = holds(c).get(h.id)
      return p?.content.kind === "image" && p.content.image.state === "ready" ? p.content.image.token : undefined
    }
    await until(() => tokenOf(a) !== undefined && tokenOf(sameDevice) !== undefined)
    const mine = tokenOf(a)!
    expect(tokenOf(sameDevice)).not.toBe(mine)
    expect(holds(b).has(h.id)).toBe(false)
    const ok = await fetch(`${http}/media/${mine}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("private, no-store")
    expect(ok.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG)
    // Its hash is not an address, nor is a made-up token.
    const hash = createHash("sha256").update(PNG).digest("hex")
    expect((await fetch(`${http}/media/${hash}`)).status).toBe(404)
    expect((await fetch(`${http}/media/${"x".repeat(32)}`)).status).toBe(404)
    // The page goes: its address stops working; the other tab's still works until it is withdrawn.
    a.close()
    await sleep(300)
    expect((await fetch(`${http}/media/${mine}`)).status).toBe(404)
    // The surviving tab's address, saved before the withdrawal, stops working with it.
    const other = tokenOf(sameDevice)!
    expect((await fetch(`${http}/media/${other}`)).status).toBe(200)
    await run(h.dismiss)
    await until(() => !holds(sameDevice).has(h.id))
    expect((await fetch(`${http}/media/${other}`)).status).toBe(404)
  })

  it("b3: an older tab beside a newer one of the same device is sent no presentation messages, in either order of connecting", async () => {
    await start()
    const oldFirst = await page("present-mixed-01", { v: 1, display: SCREEN.display })
    const modern = await page("present-mixed-01")
    const modernFirst = await page("present-mixed-02")
    const oldSecond = await page("present-mixed-02", { v: 1, display: SCREEN.display })
    await sleep(300)
    const one = await run(present!.show({ device: "present-mixed-01" }, checklist, { lifetime: "pinned" }))
    const two = await run(present!.show({ device: "present-mixed-02" }, checklist, { lifetime: "pinned" }))
    await until(() => holds(modern).has(one.id) && holds(modernFirst).has(two.id))
    await sleep(200)
    for (const c of [oldFirst, oldSecond]) expect(c.messages.some((m) => m.type.startsWith("present."))).toBe(false)
    // The old tab's page declares the kinds later (a reload into a newer build): it is sent them then.
    oldFirst.send({ type: "device.caps", capabilities: SCREEN as never })
    await until(() => holds(oldFirst).has(one.id))
  })
})
