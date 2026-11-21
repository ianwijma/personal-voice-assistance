// `DevicePlayers` on the server's real parts (docs/modules/media.md §4.1, §4.2): the service wired to the hub, the module
// host and the device facts. A page that declares players is sent `media.command`, its `media.state` answers the module's
// `send`; a page that declares none, an admin page and a voice node are never a player; reports that do not fit are dropped
// and texts cleaned; a page that goes fails what waits for it; the owner's "no display" takes the players away.
import { DevicePlayers, type DevicePlayersService, defineModule } from "@pva/core"
import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import { Effect, Stream } from "effect"
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

let players: DevicePlayersService | undefined
const probe = defineModule({
  apiVersion: 2,
  id: "probe",
  name: "Probe",
  description: "Reaches the device players.",
  shared: (ctx) =>
    Effect.sync(() => {
      players = ctx.host.service(DevicePlayers)
      return { value: undefined }
    }),
  start: () => Effect.succeed({ tools: [] })
})

const SCREEN = { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true } as const
const caps = (media?: ReadonlyArray<string>) => ({
  v: 1 as const,
  display: SCREEN,
  speaker: { media: ["speech", "audio", "video"] as const },
  ...(media !== undefined ? { media: { players: media } } : {})
})

const start = async () => {
  players = undefined
  server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, probe] })
  await until(() => players !== undefined)
  return server
}
const page = async (deviceId: string, media?: ReadonlyArray<string>) => {
  const c = await ScriptedClient.connect({ url: server!.url, deviceId, player: { enabled: false } })
  clients.push(c)
  await c.hello({ device: { ...c.device, capabilities: caps(media) } })
  return c
}
const commands = (c: ScriptedClient) => c.messages.filter((m): m is Extract<ServerMessage, { type: "media.command" }> => m.type === "media.command")
const report = (c: ScriptedClient, message: Omit<Extract<ClientMessage, { type: "media.state" }>, "type">) => c.send({ type: "media.state", ...message })
const open = { type: "open", source: "spotify", ref: "spotify:track:1", autoplay: true, talk: { mode: "lower", level: 0.2 } } as const

describe("device players through the hub", () => {
  it("a page that declared players is sent the command; its media.state answers send; the state and the texts are what the page said, cleaned", async () => {
    await start()
    const a = await page("players-kitchen-1", ["spotify", "youtube"])
    await until(() => players !== undefined)
    const id = a.device.id
    const sending = Effect.runPromise(players!.send(id, open, { awaitStatus: ["playing"], timeoutMs: 5_000 }))
    await until(() => commands(a).length === 1)
    expect(commands(a)[0]).toEqual({ type: "media.command", seq: 1, command: open })
    // Acknowledged but still loading: the call keeps waiting for `playing`.
    report(a, { ack: 1, state: { players: [{ source: "spotify", ready: true, playerId: "dev1" }], current: { source: "spotify", status: "loading" } } })
    await sleep(100)
    report(a, { ack: 1, state: { players: [{ source: "spotify", ready: true, playerId: "dev1" }], current: { source: "spotify", status: "playing", title: "Feeling\nGood‮", artist: "Nina Simone", volume: 0.6 } } })
    const state = await sending
    expect(state.current).toMatchObject({ status: "playing", title: "Feeling Good", artist: "Nina Simone", volume: 0.6 })
    expect(state.players).toEqual([{ source: "spotify", ready: true, playerId: "dev1" }])
    expect(players!.isPlaying(id)).toBe(true)
    expect((await run(players!.state(id)))?.current?.title).toBe("Feeling Good")
    await sleep(50)
    expect(a.messages.some((m) => m.type === "error")).toBe(false)
  })

  it("a message that does not fit is dropped (the hub warns once, as for any bad message); a flood is limited; the connection stays open", async () => {
    await start()
    const a = await page("players-kitchen-2", ["spotify"])
    a.sendRaw(JSON.stringify({ type: "media.state", state: { players: [], current: { source: "spotify", status: "dancing" } } }))
    a.sendRaw(JSON.stringify({ type: "media.state", state: { players: [], current: { source: "spotify", status: "playing", title: "x".repeat(500) } } }))
    await sleep(100)
    expect((await run(players!.state(a.device.id)))?.current).toBeUndefined()
    for (let i = 0; i < 40; i++) report(a, { state: { players: [], current: { source: "spotify", status: "playing", title: `t${i}` } } })
    // The first ten are taken at once, the rest held; the latest is applied when the allowance is back.
    await sleep(600)
    expect((await run(players!.state(a.device.id)))?.current?.title).toBe("t39")
    // The hub's one warning per kind of bad message (a schema failure); nothing else was said, and the socket is open.
    expect(a.messages.filter((m) => m.type === "error").map((m) => (m as Extract<ServerMessage, { type: "error" }>).error.code)).toEqual(["bad_message"])
    a.send({ type: "ping", id: 7 })
    await a.waitFor("pong", (m) => m.id === 7, { from: 0 })
  })

  it("no players declared, an admin page, and a page of a device that did not declare: never a player", async () => {
    await start()
    const plain = await page("players-plain-001")
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    report(plain, { state: { players: [{ source: "spotify", ready: true }] } })
    report(admin, { state: { players: [{ source: "spotify", ready: true }] } })
    await sleep(150)
    expect(await run(players!.state(plain.device.id))).toBeUndefined()
    expect((await run(Effect.flip(players!.send(plain.device.id, open)))).reason).toBe("no_player")
    expect(commands(plain)).toEqual([])
    expect(commands(admin)).toEqual([])
    // An admin page's report did not make its (absent) device a player either.
    expect((await run(Effect.flip(players!.send("players-admin-001", open)))).reason).toBe("no_player")
  })

  it("two tabs of one device: the tab named is used; the other tab's report counts as the device's only when it has something open", async () => {
    await start()
    const first = await page("players-twotabs-1", ["spotify"])
    const second = await page("players-twotabs-1", ["spotify"])
    const id = first.device.id
    // Nothing open: the newest tab is the device's player.
    const sending = Effect.runPromise(players!.send(id, { type: "play" }, { timeoutMs: 5_000 }))
    await until(() => commands(second).length === 1)
    expect(commands(first)).toEqual([])
    report(second, { ack: 1, state: { players: [{ source: "spotify", ready: true }] } })
    expect((await sending).connection.id).toBe((await run(players!.state(id)))!.connection.id)
    // The first tab starts something (a touch): it is the device's player now.
    report(first, { state: { players: [{ source: "spotify", ready: true }], current: { source: "spotify", status: "playing" } } })
    await until(() => players!.isPlaying(id))
    const pausing = Effect.runPromise(players!.send(id, { type: "pause" }, { timeoutMs: 5_000 }))
    await until(() => commands(first).length === 1)
    expect(commands(second).length).toBe(1)
    report(first, { ack: 1, state: { players: [{ source: "spotify", ready: true }], current: { source: "spotify", status: "paused" } } })
    expect((await pausing).current?.status).toBe("paused")
  })

  it("a page that goes fails what waits for it as no_player, and followers of `changes` hear the player leave", async () => {
    await start()
    const a = await page("players-leaving-01", ["spotify"])
    const id = a.device.id
    const seen: Array<{ readonly deviceId: string; readonly gone: boolean }> = []
    const fiber = Effect.runFork(Stream.runForEach(players!.changes, (c) => Effect.sync(() => void seen.push({ deviceId: c.deviceId, gone: c.state === undefined }))))
    await sleep(100)
    const waiting = Effect.runPromise(Effect.flip(players!.send(id, open, { timeoutMs: 10_000 })))
    await until(() => commands(a).length === 1)
    a.close()
    expect((await waiting).reason).toBe("no_player")
    await until(() => seen.some((s) => s.deviceId === id && s.gone))
    expect(await run(players!.state(id))).toBeUndefined()
    fiber.interruptUnsafe()
  })
})

describe("voice nodes are never players", () => {
  it("a paired node that declares players and reports state has no player", async () => {
    await start()
    const created = await run(server!.handle.nodes.create({}))
    if (!created.ok) throw new Error(created.error.message)
    const answer = await run(server!.handle.nodes.redeem({
      code: created.pairing.code,
      hostname: "kitchen-pi",
      platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi" },
      version: "0.1.0+abcdef0123"
    }, "127.0.0.1"))
    const paired = answer.json as { deviceId: string; credential: string }
    const node = await ScriptedClient.connect({ url: server!.url })
    clients.push(node)
    node.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: node.clientId,
      resumeOwner: true,
      frontend: "voice",
      device: { id: paired.deviceId, kind: "voice-node", name: "box", capabilities: caps(["spotify"]) },
      node: { credential: paired.credential, version: "0.2.0+0123456789", platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi", model: "Raspberry Pi 5" } }
    })
    await node.waitFor("welcome")
    report(node, { state: { players: [{ source: "spotify", ready: true }], current: { source: "spotify", status: "playing" } } })
    await sleep(150)
    expect(await run(players!.state(paired.deviceId))).toBeUndefined()
    expect((await run(Effect.flip(players!.send(paired.deviceId, open)))).reason).toBe("no_player")
    expect(commands(node)).toEqual([])
  })
})
