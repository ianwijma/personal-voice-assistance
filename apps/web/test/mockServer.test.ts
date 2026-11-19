// @vitest-environment node
// P5 review round 2, decision 7: the mock server does what the server does for what the admin UI and the voice page
// test against. The real mock runs (tsx mock/server.ts, on a free port) and is driven through its WebSocket, so these
// go through its handlers: Members validation (the protocol's shared checks), the end of a device's session on a
// boundary change, no reply audio where the effective capabilities have no speech, and the one-line device name.
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"
import { type ClientMessage, CloseCode, decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, type ServerMessage, type ServerMessageOf } from "@pva/protocol"
import { WebSocket } from "ws"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const webDir = join(__dirname, "..")
let mock: ChildProcess | undefined
let url = ""

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

beforeAll(async () => {
  const port = await freePort()
  url = `ws://127.0.0.1:${port}/ws`
  mock = spawn(join(webDir, "node_modules", ".bin", "tsx"), ["mock/server.ts"], {
    cwd: webDir,
    env: { ...process.env, MOCK_PORT: String(port), MOCK_HOST: "127.0.0.1", MOCK_SCENARIO: "devices", MOCK_QUIET: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the mock did not start")), 30_000)
    mock!.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("assistant mock on")) {
        clearTimeout(timer)
        resolve()
      }
    })
    mock!.once("exit", (code) => reject(new Error(`the mock exited (${code})`)))
  })
}, 40_000)

afterAll(() => {
  mock?.kill("SIGTERM")
})

class Peer {
  readonly messages: Array<ServerMessage> = []
  readonly closed: Promise<number>
  private waiters: Array<() => void> = []
  private seq = 0
  readonly ws: WebSocket
  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on("message", (data, binary) => {
      if (binary) return
      const d = decodeServerMessage(data.toString())
      if (d._tag === "Ok") this.messages.push(d.message)
      for (const w of this.waiters.splice(0)) w()
    })
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)))
  }
  static async open(hello: Partial<Extract<ClientMessage, { type: "hello" }>>): Promise<Peer> {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    const peer = new Peer(ws)
    peer.send({ type: "hello", protocol: PROTOCOL_VERSION, clientId: `c-${Math.random().toString(36).slice(2, 10)}`, resumeOwner: false, frontend: "voice", ...hello } as ClientMessage)
    await peer.waitFor("welcome")
    return peer
  }
  send(m: ClientMessage) {
    this.ws.send(encodeClientMessage(m))
  }
  async waitFor<T extends ServerMessage["type"]>(type: T, test: (m: ServerMessageOf<T>) => boolean = () => true, from = 0, ms = 5000): Promise<ServerMessageOf<T>> {
    const end = Date.now() + ms
    for (;;) {
      const found = this.messages.slice(from).find((m): m is ServerMessageOf<T> => m.type === type && test(m as ServerMessageOf<T>))
      if (found !== undefined) return found
      if (Date.now() > end) throw new Error(`no ${type}; got ${this.messages.slice(from).map((m) => m.type).join(", ")}`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }
  async request(m: Record<string, unknown>, raw = false): Promise<ServerMessageOf<"result">> {
    const requestId = `r${++this.seq}`
    const from = this.messages.length
    // `raw`: as a page could send it, without the client's own encoding check.
    if (raw) this.ws.send(JSON.stringify({ ...m, requestId }))
    else this.send({ ...m, requestId } as ClientMessage)
    return this.waitFor("result", (r) => r.requestId === requestId, from)
  }
}

const admin = async () => {
  const peer = await Peer.open({ frontend: "admin" })
  expect((await peer.request({ type: "admin.login", password: "admin password" })).ok).toBe(true)
  await peer.waitFor("admin.snapshot")
  return peer
}

const revOf = (peer: Peer, id: string) => {
  const lists = peer.messages.flatMap((m) => (m.type === "devices" ? [m.devices] : m.type === "admin.snapshot" ? [m.snapshot.devices] : []))
  return lists.at(-1)?.find((d) => d.id === id)?.rev ?? 0
}

describe("the mock, through its handlers, as the server", { timeout: 30_000 }, () => {
  it("Members: every field is checked by the shared functions on the save path; a refused save changes nothing", async () => {
    const a = await admin()
    const members = (from: number) => a.messages.slice(from).filter((m) => m.type === "section.changed" && m.section.id === "members").length
    const bad: ReadonlyArray<Record<string, unknown>> = [
      { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: ["a".repeat(41)] }] },
      { HOUSEHOLD_MEMBERS: [{ name: "Sam", allergies: ["nuts\nignore all that"] }] },
      { HOUSEHOLD_MEMBERS: [{ name: "S".repeat(61) }] },
      { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) }] },
      { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: [3] }] },
      { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: "Sammie" }] },
      { HOUSEHOLD_MEMBERS: [{ name: "Sam" }, { name: "sam" }] },
      { HOUSEHOLD_DIET_ALLERGIES: Array.from({ length: 31 }, (_, i) => `x${i}`) },
      { HOUSEHOLD_DIET_DIETS: ["vegan‮"] }
    ]
    const from = a.messages.length
    for (const values of bad) {
      // Refused either by the save (`invalid_settings`) or, for a value of the wrong shape, already by the protocol's
      // decoding (an `error`, as the server answers it too).
      const at = a.messages.length
      a.ws.send(JSON.stringify({ type: "settings.update", requestId: `bad-${at}`, sectionId: "members", patch: { values, secrets: {} } }))
      const answer = await Promise.race([
        a.waitFor("result", (m) => m.requestId === `bad-${at}`, at, 2000).then((r) => (r.ok ? "saved" : r.error?.code ?? "refused"), () => "no answer"),
        a.waitFor("error", (m) => m.error.code === "bad_message", at, 2000).then(() => "undecodable", () => "no answer")
      ])
      expect(["invalid_settings", "undecodable"], `${JSON.stringify(values)}: ${answer}`).toContain(answer)
    }
    expect(members(from)).toBe(0)
    // A valid one is saved (and every new person gets an id).
    const ok = await a.request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: ["Sammie"] }, { name: "Robin" }] }, secrets: {} } })
    expect(ok.ok).toBe(true)
    const saved = await a.waitFor("section.changed", (m) => m.section.id === "members", from)
    const people = saved.section.form.values.HOUSEHOLD_MEMBERS as unknown as ReadonlyArray<{ id: string; name: string }>
    expect(people.map((p) => p.name)).toEqual(["Sam", "Robin"])
    for (const p of people) expect(p.id).toMatch(/^p-/)
    a.ws.close()
  })

  it("a change of privacy ends the device's session (settingsChanged); a room alone does not; a member leaving ends every one", async () => {
    const a = await admin()
    const id = "d-mock-boundary1"
    const page = await Peer.open({ device: { id, kind: "web-voice", name: "Test" } })
    await a.waitFor("devices", (m) => m.devices.some((d) => d.id === id))
    const place = { room: "Kitchen", privacy: "shared", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: null }
    // The room only: the page stays.
    expect((await a.request({ type: "device.save", target: { kind: "device", id }, rev: revOf(a, id), settings: { place } })).ok).toBe(true)
    const stays = await Promise.race([page.closed, new Promise<number>((r) => setTimeout(() => r(-1), 300))])
    expect(stays).toBe(-1)
    // Public: closed with settingsChanged.
    await a.waitFor("devices", (m) => m.devices.some((d) => d.id === id && d.rev > 0))
    expect((await a.request({ type: "device.save", target: { kind: "device", id }, rev: revOf(a, id), settings: { place: { ...place, privacy: "public" } } })).ok).toBe(true)
    expect(await page.closed).toBe(CloseCode.settingsChanged)
    // A member leaving: every voice page.
    const one = await Peer.open({ device: { id, kind: "web-voice", name: "Test" } })
    const two = await Peer.open({ device: { id: "d-mock-boundary2", kind: "web-voice", name: "Other" } })
    const snapshot = a.messages.filter((m): m is ServerMessageOf<"section.changed"> => m.type === "section.changed" && m.section.id === "members").at(-1)
    const now = (snapshot?.section.form.values.HOUSEHOLD_MEMBERS ?? []) as unknown as ReadonlyArray<Record<string, unknown>>
    const list = now.length > 0 ? now : [{ name: "Sam" }, { name: "Robin" }]
    if (now.length === 0) expect((await a.request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: list }, secrets: {} } })).ok).toBe(true)
    const latest = (a.messages.filter((m): m is ServerMessageOf<"section.changed"> => m.type === "section.changed" && m.section.id === "members").at(-1)!.section.form.values.HOUSEHOLD_MEMBERS) as unknown as ReadonlyArray<Record<string, unknown>>
    expect((await a.request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: latest.slice(0, 1) }, secrets: {} } })).ok).toBe(true)
    expect(await one.closed).toBe(CloseCode.settingsChanged)
    expect(await two.closed).toBe(CloseCode.settingsChanged)
    a.ws.close()
  })

  // Review round 3 (p5-r3b finding 6): a dropped session's delayed work never reaches its successor on the device.
  it("P9 notifications as the server: a ring reaches its device and again after a hello; stop resolves it everywhere; an action whose handler is down answers I can't do that right now", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const one = await Peer.open({ device: { id: "d-mock-notify01", kind: "web-voice", name: "One" } })
    const two = await Peer.open({ device: { id: "d-mock-notify02", kind: "web-voice", name: "Two" } })
    const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ id?: string }>)
    const mine = await post("/mock/notify", { title: "Pasta", ring: true, deviceId: "d-mock-notify01", actions: [{ id: "snooze", label: "Snooze" }], handlerDown: true })
    const all = await post("/mock/notify", { title: "Everyone", ring: true })
    await one.waitFor("notification.ring", (m) => m.notification.id === mine.id)
    await two.waitFor("notification.ring", (m) => m.notification.id === all.id)
    expect(two.messages.some((m) => m.type === "notification.ring" && m.notification.id === mine.id)).toBe(false)
    // A page that says hello while they are open gets them again.
    const again = await Peer.open({ device: { id: "d-mock-notify01", kind: "web-voice", name: "One" } })
    await again.waitFor("notification.ring", (m) => m.notification.id === mine.id)
    await again.waitFor("notification.ring", (m) => m.notification.id === all.id)
    // The handler is down: changed nothing; from another device: refused; stop always works, everywhere it rang.
    const down = await one.request({ type: "notification.action", id: mine.id, actionId: "snooze" })
    expect([down.ok, down.error?.code, down.say]).toEqual([false, "not_running", "I can't do that right now."])
    expect((await two.request({ type: "notification.action", id: mine.id, actionId: "stop" })).ok).toBe(false)
    const from = two.messages.length
    const stop = await one.request({ type: "notification.action", id: all.id, actionId: "stop" })
    expect([stop.ok, stop.say]).toEqual([true, "Done."])
    await two.waitFor("notification.resolved", (m) => m.id === all.id, from)
    await again.waitFor("notification.resolved", (m) => m.id === all.id)
    // An admin page cannot press.
    const a = await admin()
    expect((await a.request({ type: "notification.action", id: mine.id, actionId: "stop" })).error?.code).toBe("bad_message")
    for (const p of [one, two, again, a]) p.ws.close()
  })

  it("P10 presentations as the server: shown where the shared decision allows (a page that declares the kinds), again after a hello; a transient replaces a transient; a tick from the holder updates every page; refused elsewhere and while the handler is down", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const screen = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, present: { kinds: { card: 1, list: 1, timer: 1, image: 1, weather: 1 } } }
    const one = await Peer.open({ device: { id: "d-mock-present1", kind: "web-voice", name: "One", capabilities: screen } as never })
    const old = await Peer.open({ device: { id: "d-mock-present2", kind: "web-voice", name: "Old", capabilities: { v: 1, display: screen.display } } as never })
    const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ id?: string }>)
    const card = (title: string, extra: Record<string, unknown> = {}) => ({ kind: "card", title, spoken: `${title}.`, ...extra })
    const list = await post("/mock/present", { options: { lifetime: "pinned" }, presentation: { kind: "list", title: "Shopping", style: "checklist", items: [{ id: "milk", text: "Milk" }], spoken: "Milk.", handler: "h", buttons: [{ id: "clear", label: "Clear" }] } })
    const shown = await one.waitFor("present.show", (m) => m.presentation.id === list.id)
    expect(shown.presentation.interactive).toBe(true)
    expect(shown.presentation.texts.region).toBe("On screen")
    await new Promise((r) => setTimeout(r, 200))
    expect(old.messages.some((m) => m.type.startsWith("present."))).toBe(false)
    // A transient one, then another: one at a time.
    const t1 = await post("/mock/present", { presentation: card("First") })
    await one.waitFor("present.show", (m) => m.presentation.id === t1.id)
    const t2 = await post("/mock/present", { presentation: card("Second") })
    await one.waitFor("present.dismiss", (m) => m.id === t1.id)
    await one.waitFor("present.show", (m) => m.presentation.id === t2.id)
    // A page that says hello gets the pinned one and the live transient again.
    const again = await Peer.open({ device: { id: "d-mock-present1", kind: "web-voice", name: "One", capabilities: screen } as never })
    await again.waitFor("present.show", (m) => m.presentation.id === list.id)
    await again.waitFor("present.show", (m) => m.presentation.id === t2.id)
    // A tick from a holder: every page of the device gets the update. From a page that does not hold it: refused.
    const ticked = await one.request({ type: "present.action", id: list.id, action: "tick", item: "milk", done: true })
    expect([ticked.ok, ticked.say]).toEqual([true, "Done."])
    await again.waitFor("present.update", (m) => m.presentation.id === list.id && m.presentation.content.kind === "list" && m.presentation.content.items[0]!.done)
    expect((await old.request({ type: "present.action", id: list.id, action: "clear" })).ok).toBe(false)
    const down = await post("/mock/present", { options: { lifetime: "pinned" }, presentation: card("Down", { buttons: [{ id: "go", label: "Go" }], handler: "h" }), handlerDown: true })
    await one.waitFor("present.show", (m) => m.presentation.id === down.id)
    const refused = await one.request({ type: "present.action", id: down.id, action: "go" })
    expect([refused.ok, refused.error?.code, refused.say]).toEqual([false, "not_running", "I can't do that right now."])
    await post("/mock/present/dismiss", { id: list.id })
    await one.waitFor("present.dismiss", (m) => m.id === list.id)
    await post("/mock/present/dismiss", { id: down.id })
    await post("/mock/present/dismiss", { id: t2.id })
    for (const p of [one, old, again]) p.ws.close()
  })

  it("P10 review round 1: the mock checks before it commits (b10), ends presentations at their end (b12), derives lifetimes with the shared helper (b13), reconciles after a saved settings change (b14), sends each tab only its own kinds (G11) and serves images by a page's own address (b11)", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const screen = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, present: { kinds: { card: 1, list: 1, timer: 1, image: 1, weather: 1 } } }
    const page = await Peer.open({ device: { id: "d-mock-round1a", kind: "web-voice", name: "Page", capabilities: screen } as never })
    const oldTab = await Peer.open({ device: { id: "d-mock-round1a", kind: "web-voice", name: "Page", capabilities: { v: 1, display: screen.display } } as never })
    const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as { id?: string; lifetime?: string; expiresAt?: number; error?: string } }))
    const card = (title: string) => ({ kind: "card", title, spoken: `${title}.` })
    // b10: a refused presentation changes nothing, and the next valid one is shown.
    expect((await post("/mock/present", { options: { lifetime: "pinned" }, presentation: card("T".repeat(61)) })).status).toBe(400)
    expect((await post("/mock/present", { presentation: { ...card("x"), buttons: [1, 2, 3, 4] } })).status).toBe(400)
    expect((await post("/mock/present", { presentation: card("x"), options: { expiresInMs: 25 * 3_600_000, lifetime: "pinned" } })).status).toBe(400)
    const valid = await post("/mock/present", { options: { lifetime: "pinned", expiresInMs: 3_000 }, presentation: card("Valid") })
    expect(valid.status).toBe(200)
    await page.waitFor("present.show", (m) => m.presentation.id === valid.body.id)
    // b13: a timer is pinned by default and lasts until ten minutes after it ends.
    const endsAt = Date.now() + 60_000
    const timer = await post("/mock/present", { presentation: { kind: "timer", label: "Tea", endsAt, spoken: "Tea." } })
    expect(timer.body.lifetime).toBe("pinned")
    expect(timer.body.expiresAt).toBe(endsAt + 10 * 60_000)
    // b12: eight pins with a three-second life end and free their places.
    const ids: Array<string> = [valid.body.id!, timer.body.id!]
    for (let i = 0; i < 6; i++) ids.push((await post("/mock/present", { options: { lifetime: "pinned", expiresInMs: 3_000 }, presentation: card(`P${i}`) })).body.id!)
    expect((await post("/mock/present", { options: { lifetime: "pinned" }, presentation: card("Full") })).body.error).toBe("limit")
    // No dismissal: their end alone frees their places.
    await page.waitFor("present.dismiss", (m) => m.id === valid.body.id, 0, 6_000)
    const fits = await post("/mock/present", { options: { lifetime: "pinned" }, presentation: card("Fits") })
    expect(fits.status).toBe(200)
    // G11: the older tab of the same device got nothing.
    expect(oldTab.messages.some((m) => m.type.startsWith("present."))).toBe(false)
    // b11: an image through the page's own address, with the server's headers; nothing for another address.
    const image = await post("/mock/present", { presentation: { kind: "image", url: "https://example.org/a.png", alt: "A", credit: "C", spoken: "A." } })
    const shown = await page.waitFor("present.show", (m) => m.presentation.id === image.body.id)
    const img = shown.presentation.content.kind === "image" && shown.presentation.content.image.state === "ready" ? shown.presentation.content.image.token : ""
    const got = await fetch(`${http}/media/${img}`)
    expect(got.status).toBe(200)
    expect(got.headers.get("content-type")).toBe("image/png")
    expect(got.headers.get("cache-control")).toBe("private, no-store")
    expect((await fetch(`${http}/media/${"x".repeat(32)}`)).status).toBe(404)
    await post("/mock/present/dismiss", { id: image.body.id })
    await page.waitFor("present.dismiss", (m) => m.id === image.body.id)
    expect((await fetch(`${http}/media/${img}`)).status).toBe(404)
    // b14: a saved language change reaches the held presentations at once.
    const a = await admin()
    const from = page.messages.length
    expect((await a.request({ type: "settings.update", sectionId: "home", patch: { values: { HOME_LANGUAGE: "nl-NL" }, secrets: {} } })).ok).toBe(true)
    await page.waitFor("present.update", (m) => m.presentation.texts.region === "Op het scherm", from)
    expect((await a.request({ type: "settings.update", sectionId: "home", patch: { values: { HOME_LANGUAGE: "en-GB" }, secrets: {} } })).ok).toBe(true)
    await post("/mock/present/dismiss", { id: timer.body.id })
    await post("/mock/present/dismiss", { id: fits.body.id })
    for (const p of [page, oldTab, a]) p.ws.close()
  })

  it("P10 review round 2 (R7): the mock checks the whole request before it changes anything, refuses what it does not model (personal content, a key), and admits with the server's live bounds", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const screen = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, present: { kinds: { card: 1, list: 1, timer: 1, image: 1, weather: 1 } } }
    const pages = await Promise.all(["d-mock-round2a", "d-mock-round2b", "d-mock-round2c"].map((id) => Peer.open({ device: { id, kind: "web-voice", name: id, capabilities: screen } as never })))
    const [a, b, c] = pages as [typeof pages[0], typeof pages[0], typeof pages[0]]
    const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as { id?: string; error?: string } }))
    const card = (title: string, extra: Record<string, unknown> = {}) => ({ kind: "card", title, spoken: `${title}.`, ...extra })
    const pinned = { lifetime: "pinned" }
    const shown: Array<string> = []
    const pin = async (deviceId: string, title: string, options: Record<string, unknown> = pinned) => {
      const r = await post("/mock/present", { deviceId, options, presentation: card(title) })
      if (r.status === 200) shown.push(r.body.id!)
      return r
    }
    const first = await pin("d-mock-round2a", "First")
    expect(first.status).toBe(200)
    await a.waitFor("present.show", (m) => m.presentation.id === first.body.id)
    // Finding 5: a malformed, empty or overlong id, an unknown field, an unknown device: 400 each, nothing consumed or
    // changed; the next valid request is shown and the page still holds what it held.
    for (const body of [
      { id: "not a protocol id!", options: pinned, presentation: card("Bad") },
      { id: "", options: pinned, presentation: card("Bad") },
      { id: "x".repeat(65), options: pinned, presentation: card("Bad") },
      { id: 7, options: pinned, presentation: card("Bad") },
      { surprise: true, options: pinned, presentation: card("Bad") },
      { deviceId: "d-mock-nowhere", options: pinned, presentation: card("Bad") }
    ]) {
      const r = await post("/mock/present", body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    const after = await pin("d-mock-round2a", "After")
    expect(after.status).toBe(200)
    await a.waitFor("present.show", (m) => m.presentation.id === after.body.id)
    expect(a.messages.filter((m) => m.type === "present.show").map((m) => (m as { presentation: { id: string } }).presentation.id)).toEqual([first.body.id, after.body.id])
    // Finding 4 and 6: what the mock does not model is refused with a sentence that says so.
    const personal = await post("/mock/present", { deviceId: "d-mock-round2a", presentation: card("Dentist", { sensitivity: { personal: "p-sam" } }) })
    expect([personal.status, personal.body.error]).toEqual([400, "the mock shows household presentations only (it has no privacy model): leave sensitivity out or say household"])
    expect((await post("/mock/present", { deviceId: "d-mock-round2a", presentation: card("Bins", { sensitivity: "household" }) })).status).toBe(200)
    shown.push(...a.messages.filter((m) => m.type === "present.show").map((m) => (m as { presentation: { id: string } }).presentation.id).filter((id) => !shown.includes(id)))
    const keyed = await post("/mock/present", { deviceId: "d-mock-round2a", options: { lifetime: "pinned", key: "same" }, presentation: card("Keyed") })
    expect([keyed.status, keyed.body.error]).toEqual([400, "the mock does not replace by key: leave options.key out (dismiss and show again)"])
    // Finding 7: the server's per-module bound (8 live; the mock is one module) across devices, not only per device.
    // Three live now (two pins and a transient on a); five more pins on b make eight.
    const onB: Array<string> = []
    for (let i = 0; i < 5; i++) {
      const r = await pin("d-mock-round2b", `B${i}`)
      expect(r.status).toBe(200)
      onB.push(r.body.id!)
    }
    expect((await pin("d-mock-round2c", "One too many")).body.error).toBe("limit")
    // A transient that replaces the live transient of its device does not count again (as the server).
    const replacing = await post("/mock/present", { deviceId: "d-mock-round2a", presentation: card("Replacing") })
    expect(replacing.status).toBe(200)
    shown.push(replacing.body.id!)
    // A dismissal gives its place back; an end does too.
    expect((await post("/mock/present/dismiss", { id: onB[0] })).body).toEqual({ dismissed: true })
    const short = await pin("d-mock-round2c", "Short", { lifetime: "pinned", expiresInMs: 3_000 })
    expect(short.status).toBe(200)
    expect((await pin("d-mock-round2c", "Full again")).body.error).toBe("limit")
    await c.waitFor("present.dismiss", (m) => m.id === short.body.id, 0, 6_000)
    expect((await pin("d-mock-round2c", "Fits again")).status).toBe(200)
    for (const id of shown) await post("/mock/present/dismiss", { id })
    void b
    for (const p of pages) p.ws.close()
  })

  it("P7: the reply volume as the server keeps it: output.volume to the device's voice pages, again after a welcome, with the server's step and bounds", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const post = (body: unknown) => fetch(`${http}/mock/volume`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as unknown }))
    const one = await Peer.open({ device: { id: "d-mock-volume01", kind: "web-voice", name: "One" } })
    const other = await Peer.open({ device: { id: "d-mock-volume02", kind: "web-voice", name: "Other" } })
    // At the default nothing is sent at a welcome; louder at the top is the limit, nothing sent.
    expect(one.messages.some((m) => m.type === "output.volume")).toBe(false)
    expect((await post({ deviceId: "d-mock-volume01", direction: "louder" })).body).toEqual({ level: 1, atLimit: true })
    expect((await post({ deviceId: "d-mock-volume01", direction: "quieter" })).body).toEqual({ level: 0.8, atLimit: false })
    expect((await one.waitFor("output.volume")).volume).toBe(0.8)
    // A second page of the device says hello: told the level after its welcome; the other device was told nothing.
    const again = await Peer.open({ device: { id: "d-mock-volume01", kind: "web-voice", name: "One" } })
    expect((await again.waitFor("output.volume")).volume).toBe(0.8)
    expect(other.messages.some((m) => m.type === "output.volume")).toBe(false)
    // A level is moved to the nearest step within the bounds.
    expect((await post({ deviceId: "d-mock-volume01", to: 0.05 })).body).toMatchObject({ level: 0.2 })
    expect((await post({ deviceId: "d-mock-volume01" })).status).toBe(400)
    // b9: an absolute setting that is the level already changes nothing (as the server: atLimit).
    expect((await post({ deviceId: "d-mock-volume01", to: 0.2 })).body).toEqual({ level: 0.2, atLimit: true })
    // b9 + b8: past the cap the oldest level is dropped and its pages are set back to the default, as the server does.
    for (let i = 0; i < 256; i++) await post({ deviceId: `d-cap-${String(i).padStart(4, "0")}`, direction: "quieter" })
    expect((await one.waitFor("output.volume", (m) => m.volume === 1)).volume).toBe(1)
    expect((await post({ deviceId: "d-mock-volume01", direction: "louder" })).body).toEqual({ level: 1, atLimit: true })
    for (const p of [one, other, again]) p.ws.close()
  })

  it("b13/b14: the mock decides delivery per device with the real decision function (also on hello), and never reuses an id", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) })
    const display = { v: 1 as const, display: { class: "standard" as const, widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse" as const, colour: true } }
    const nothing = await Peer.open({ device: { id: "d-mock-notify10", kind: "web-voice", name: "Nothing", capabilities: { v: 1 } } })
    const screenOnly = await Peer.open({ device: { id: "d-mock-notify11", kind: "web-voice", name: "Screen", capabilities: display } })
    const first = (await (await post("/mock/notify", { title: "First", ring: true })).json()) as { id: string }
    await screenOnly.waitFor("notification.ring", (m) => m.notification.id === first.id)
    // A display without a speaker: the card, silent. No outputs at all: nothing (as `decideDelivery` says).
    expect(screenOnly.messages.find((m) => m.type === "notification.ring")).toMatchObject({ notification: { show: true, sound: false } })
    await new Promise((r) => setTimeout(r, 150))
    expect(nothing.messages.some((m) => m.type === "notification.ring")).toBe(false)
    // The same on a hello.
    const again = await Peer.open({ device: { id: "d-mock-notify10", kind: "web-voice", name: "Nothing", capabilities: { v: 1 } } })
    await new Promise((r) => setTimeout(r, 150))
    expect(again.messages.some((m) => m.type === "notification.ring")).toBe(false)
    // Ids: create, create, resolve the first, create: three different ids; an explicit id in use is refused.
    const second = (await (await post("/mock/notify", { title: "Second" })).json()) as { id: string }
    await post("/mock/notify/resolve", { id: first.id })
    const third = (await (await post("/mock/notify", { title: "Third" })).json()) as { id: string }
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect((await post("/mock/notify", { id: second.id, title: "Clash" })).status).toBe(409)
    await post("/mock/notify/resolve", { id: second.id })
    await post("/mock/notify/resolve", { id: third.id })
    for (const p of [nothing, screenOnly, again]) p.ws.close()
  })

  it("b4/b5/b7/b8 (round 2): another tab's declaration withdraws the old tab's card and its stale press fails; ids never collide; Dutch texts follow the saved language; closed connections leave no bookkeeping", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    const post = (path: string, body: unknown) => fetch(`${http}${path}`, { method: "POST", body: JSON.stringify(body) })
    const both = { v: 1 as const, display: { class: "standard" as const, widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse" as const, colour: true }, speaker: { media: ["speech" as const] } }
    // b4: tab A shows a sounding ring; tab B of the same device declares no outputs: A's card is withdrawn, and A's
    // Stop with the id it learned is refused.
    const tabA = await Peer.open({ device: { id: "d-mock-round2-01", kind: "web-voice", name: "Round two", capabilities: both } })
    const ring = (await (await post("/mock/notify", { title: "Ring", ring: true, deviceId: "d-mock-round2-01" })).json()) as { id: string }
    await tabA.waitFor("notification.ring", (m) => m.notification.id === ring.id && m.notification.sound)
    const tabB = await Peer.open({ device: { id: "d-mock-round2-01", kind: "web-voice", name: "Round two", capabilities: { v: 1 } } })
    await tabA.waitFor("notification.resolved", (m) => m.id === ring.id && m.outcome === "withdrawn")
    expect(tabB.messages.some((m) => m.type === "notification.ring")).toBe(false)
    const stale = await tabA.request({ type: "notification.action", id: ring.id, actionId: "stop" })
    expect([stale.ok, stale.say]).toEqual([false, "I can't do that right now."])
    await post("/mock/notify/resolve", { id: ring.id })
    // b5: generated ids skip every id issued or named; a named id is never reused, also after it was resolved.
    const probe = (await (await post("/mock/notify", { title: "Probe" })).json()) as { id: string }
    const n = Number(probe.id.replace("n-mock-", ""))
    const named = [`n-mock-${n + 1}`, `n-mock-${n + 2}`]
    for (const id of named) expect((await post("/mock/notify", { id, title: "Named" })).status).toBe(200)
    const generated = (await (await post("/mock/notify", { title: "Generated" })).json()) as { id: string }
    expect([probe.id, ...named]).not.toContain(generated.id)
    await post("/mock/notify/resolve", { id: named[0] })
    expect((await post("/mock/notify", { id: named[0], title: "Again" })).status).toBe(409)
    for (const id of [probe.id, named[1], generated.id]) await post("/mock/notify/resolve", { id })
    // b7: a Dutch household: the card's texts and the answers are Dutch (the service's words).
    const a = await admin()
    expect((await a.request({ type: "settings.update", sectionId: "home", patch: { values: { HOME_LANGUAGE: "nl-NL" }, secrets: {} } })).ok).toBe(true)
    try {
      const dutch = (await (await post("/mock/notify", { title: "Het water kookt", ring: true, deviceId: "d-mock-round2-02", actions: [{ id: "later", label: "Later" }], handlerDown: true })).json()) as { id: string }
      const tabC = await Peer.open({ device: { id: "d-mock-round2-02", kind: "web-voice", name: "Dutch", capabilities: both } })
      const card = await tabC.waitFor("notification.ring", (m) => m.notification.id === dutch.id)
      expect(card.notification.texts).toEqual({ region: "Meldingen", startAudio: "Zet het geluid aan om het te horen." })
      expect((await tabC.request({ type: "notification.action", id: dutch.id, actionId: "later" })).say).toBe("Dat kan ik nu niet doen.")
      expect((await tabC.request({ type: "notification.action", id: dutch.id, actionId: "stop" })).say).toBe("Klaar.")
      tabC.ws.close()
      await tabC.closed
    } finally {
      expect((await a.request({ type: "settings.update", sectionId: "home", patch: { values: { HOME_LANGUAGE: "en-GB" }, secrets: {} } })).ok).toBe(true)
    }
    // b8: what a closed connection held is not kept.
    for (const p of [tabA, tabB, a]) p.ws.close()
    await Promise.all([tabA.closed, tabB.closed, a.closed])
    await new Promise((r) => setTimeout(r, 100))
    const book = (await (await post("/mock/notify/held", {})).json()) as { held: number; voiceConnections: number }
    expect(book.held).toBeLessThanOrEqual(book.voiceConnections)
  })

  it("a privacy change while the scripted turn is being heard: the reconnected page gets nothing of the old session", async () => {
    const a = await admin()
    const id = "d-mock-pending01"
    const page = await Peer.open({ device: { id, kind: "web-voice", name: "Pending" } })
    await a.waitFor("devices", (m) => m.devices.some((d) => d.id === id))
    page.send({ type: "audio.claim", audio: { contextSampleRate: 48_000, outputPath: "direct", outputLatencyMs: 10 } })
    await page.waitFor("session", (m) => m.role === "owner")
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    await fetch(`${http}/mock/turn`, { method: "POST", body: JSON.stringify({ deviceId: id }) })
    await page.waitFor("transcript", (m) => m.text !== "")
    const place = { room: "", privacy: "public", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: null }
    expect((await a.request({ type: "device.save", target: { kind: "device", id }, rev: revOf(a, id), settings: { place } })).ok).toBe(true)
    expect(await page.closed).toBe(CloseCode.settingsChanged)
    const next = await Peer.open({ device: { id, kind: "web-voice", name: "Pending" } })
    const from = next.messages.length
    // Longer than the rest of the scripted sentence and its reply would take.
    await new Promise((r) => setTimeout(r, 4000))
    const old = next.messages.slice(from).filter((m) => ["transcript", "turn.start", "turn.end", "assistant.text", "reply.start", "wake", "error", "tool.start"].includes(m.type))
    expect(old.map((m) => m.type)).toEqual([])
    next.ws.close()
    a.ws.close()
  })

  // Review round 3 (p5-r3b finding 7): speech is checked again where delayed reply audio would leave.
  it("a declaration without speech during a spoken reply stops it (reply.stop); with speech, the same reply plays to its end", async () => {
    const speaks = { v: 1, display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 1, touch: "coarse", colour: true }, speaker: { media: ["speech", "audio"] } } as const
    const run = async (id: string, revoke: boolean) => {
      const page = await Peer.open({ device: { id, kind: "web-voice", name: "Speaker", capabilities: speaks } })
      page.send({ type: "audio.claim", audio: { contextSampleRate: 48_000, outputPath: "direct", outputLatencyMs: 10 } })
      await page.waitFor("session", (m) => m.role === "owner")
      const from = page.messages.length
      expect((await page.request({ type: "text.send", text: "tell me a long story", speak: true })).ok).toBe(true)
      const start = await page.waitFor("turn.start", () => true, from)
      expect(start.spoken).toBe(true)
      await page.waitFor("reply.start", () => true, from)
      const at = page.messages.length
      if (revoke) {
        const { speaker: _, ...mute } = speaks
        page.send({ type: "device.caps", capabilities: mute } as ClientMessage)
        // At once (well before the mock's 2 s stall watch, which a page that never reports playback would meet).
        await page.waitFor("reply.stop", () => true, at, 1000)
      }
      await page.waitFor("turn.end", () => true, from, 15_000)
      const after = page.messages.slice(at)
      page.ws.close()
      return after
    }
    const control = await run("d-mock-speaks01", false)
    // (This page never reports playback, so the mock's stall watch may stop it later; every clause was sent first.)
    expect(control.some((m) => m.type === "reply.end")).toBe(true)
    const revoked = await run("d-mock-revoke01", true)
    expect(revoked.some((m) => m.type === "reply.end")).toBe(false)
    expect(revoked.find((m): m is ServerMessageOf<"turn.end"> => m.type === "turn.end")?.outcome).toBe("interrupted")
  })

  it("no reply audio where the declaration has no speech, and the setup says so; a newline in a device name is refused", async () => {
    const a = await admin()
    const id = "d-mock-nospeech1"
    const page = await Peer.open({ device: { id, kind: "web-voice", name: "Quiet", capabilities: { v: 1, display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 1, touch: "coarse", colour: true }, speaker: { media: ["audio"] } } } })
    const welcome = page.messages.find((m): m is ServerMessageOf<"welcome"> => m.type === "welcome")!
    expect(welcome.snapshot.setup!.audio.speakAloud).toBe(false)
    expect(welcome.snapshot.setup!.captions.speakTyped).toBe(false)
    page.send({ type: "audio.claim", audio: { contextSampleRate: 48_000, outputPath: "direct", outputLatencyMs: 10 } })
    await page.waitFor("session", (m) => m.role === "owner")
    const from = page.messages.length
    expect((await page.request({ type: "text.send", text: "tell me a story", speak: true })).ok).toBe(true)
    const start = await page.waitFor("turn.start", () => true, from)
    expect(start.spoken).toBe(false)
    await page.waitFor("turn.end", () => true, from, 15_000)
    expect(page.messages.slice(from).some((m) => m.type === "reply.start")).toBe(false)
    // A name with a line break never decodes (the protocol's `SavedDeviceName`): refused, the name unchanged.
    await a.waitFor("devices", (m) => m.devices.some((d) => d.id === id))
    const before = a.messages.length
    a.ws.send(JSON.stringify({ type: "device.save", requestId: "raw-1", target: { kind: "device", id }, rev: revOf(a, id), name: "Kitchen\n‮desk", settings: {} }))
    await a.waitFor("error", (m) => m.error.code === "bad_message", before)
    expect(a.messages.slice(before).some((m) => m.type === "result" && m.requestId === "raw-1" && m.ok)).toBe(false)
    page.ws.close()
    a.ws.close()
  })

  // Review round 4 (p5-r4b finding 3): the mock issues person ids as the server does.
  it("Members: an id is kept only when it is a committed member's and not retired; the retired ids go with a reset", async () => {
    const http = url.replace(/^ws/, "http").replace(/\/ws$/, "")
    await fetch(`${http}/mock/reset`, { method: "POST", body: "{}" })
    let a = await admin()
    const membersNow = () =>
      (a.messages.filter((m) => m.type === "section.changed" && m.section.id === "members").map((m) => (m as ServerMessageOf<"section.changed">).section.form.values.HOUSEHOLD_MEMBERS).at(-1) ??
        (a.messages.find((m) => m.type === "admin.snapshot") as ServerMessageOf<"admin.snapshot">).snapshot.sections.find((x) => x.id === "members")!.form.values.HOUSEHOLD_MEMBERS) as unknown as ReadonlyArray<Record<string, unknown>>
    const save = async (list: ReadonlyArray<Record<string, unknown>>) => {
      const from = a.messages.length
      expect((await a.request({ type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: list }, secrets: {} } })).ok).toBe(true)
      await a.waitFor("section.changed", (m) => m.section.id === "members", from)
      return membersNow()
    }
    const seeded = membersNow()
    const sam = seeded.find((m) => m.name === "Sam")!
    const robin = seeded.find((m) => m.name === "Robin")!
    expect(typeof sam.id).toBe("string")
    // Sam is removed; then a stale tab saves Sam's row under another name, and a row with an id nobody had.
    await save([robin])
    const stale = await save([robin, { ...sam, name: "Kim" }, { name: "Jo", id: "p-madeup01" }])
    expect(stale.map((m) => m.name)).toEqual(["Robin", "Kim", "Jo"])
    expect(stale[0]!.id).toBe(robin.id)
    expect(stale[1]!.id).not.toBe(sam.id)
    expect(stale[2]!.id).not.toBe("p-madeup01")
    expect(new Set(stale.map((m) => m.id)).size).toBe(3)
    for (const m of stale) expect(m.id).toMatch(/^p-/)
    // A save of what is shown keeps every id.
    expect((await save(stale)).map((m) => m.id)).toEqual(stale.map((m) => m.id))
    // A reset starts the scenario again: Sam is a member with the seeded id, which a save keeps.
    a.ws.close()
    await fetch(`${http}/mock/reset`, { method: "POST", body: "{}" })
    a = await admin()
    const again = await save(membersNow())
    expect(again.find((m) => m.name === "Sam")!.id).toBe(sam.id)
    a.ws.close()
  })
})
