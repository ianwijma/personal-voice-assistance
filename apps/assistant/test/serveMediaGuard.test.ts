// The media guard in serve mode (docs/modules/media.md §6, docs/PHRASES.md): while a device's own player page reports
// `playing`, that device needs the wake phrase for every request; `paused` lifts it; other devices are not affected.
// Driven by the scripted client against the real server with injected providers (a fake player page, as in
// serveDevicePlayers.test.ts).
import { endOfTurn, interim, speechStarted } from "@pva/core/testing"
import { type ClientMessage } from "@pva/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const caps = {
  v: 1 as const,
  display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true },
  speaker: { media: ["speech", "audio", "video"] },
  media: { players: ["spotify"] }
} as const

const report = (c: ScriptedClient, status: "playing" | "paused") =>
  c.send({
    type: "media.state",
    state: { players: [{ source: "spotify", ready: true, playerId: "dev1" }], current: { source: "spotify", status } }
  } as ClientMessage)

const setup = async () => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `You said: ${t}.`)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), kindDefaults: { interruptMode: "instant", activation: "wake-phrase", followUpSeconds: 30 } })
  const connect = async (deviceId: string) => {
    const c = await ScriptedClient.connect({ url: server!.url, deviceId, player: { enabled: false } })
    clients.push(c)
    await c.hello({ device: { ...c.device, capabilities: caps } })
    await c.claim()
    return c
  }
  // Stream 0 is the kitchen's (first to claim), stream 1 the hall's.
  const kitchen = await connect("guard-kitchen-1")
  await sleep(100)
  const hall = await connect("guard-hall-0001")
  await sleep(100)
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  await admin.admin(TEST_ADMIN_PASSWORD)
  admin.send({ type: "wake.test", requestId: "wt1", on: true } as ClientMessage)
  await admin.waitFor("result", (m) => m.requestId === "wt1")
  return { stt, llm, kitchen, hall, admin }
}
const say = (stt: ReturnType<typeof controlledStt>, i: number, text: string) => stt.emitTo(i, speechStarted, interim(text), endOfTurn(text))
const heardOf = (admin: ScriptedClient, text: string) => admin.waitFor("wake.heard", (m) => m.text === text, { from: 0 })

describe("media guard in serve mode", () => {
  it("playing: a follow-up window admits nothing; paused: admitted again; the other device and the phrase are not affected", async () => {
    const { stt, llm, kitchen, hall, admin } = await setup()

    // Not playing: a phrase request, then the follow-up window (30 s) admits talk without the phrase.
    say(stt, 0, "Hey Jeff, before the music")
    expect(await heardOf(admin, "Hey Jeff, before the music")).toMatchObject({ accepted: true })
    await kitchen.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    await sleep(100)
    say(stt, 0, "still no music")
    expect(await heardOf(admin, "still no music")).toMatchObject({ accepted: true })
    await kitchen.waitFor("turn.end", (m) => m.turnId > 1, { timeoutMs: 10_000 })
    await sleep(100)

    report(kitchen, "playing")
    await sleep(100)
    const requestsBefore = llm.requests.length
    say(stt, 0, "lyrics of the song")
    expect(await heardOf(admin, "lyrics of the song")).toMatchObject({ accepted: false })
    await sleep(150)
    expect(llm.requests.length).toBe(requestsBefore)
    expect(JSON.stringify(kitchen.messages)).not.toContain("lyrics")

    // The hall is another device: unaffected (it has no window of its own, so it needs the phrase as ever).
    say(stt, 1, "Hey Jeff, hall request")
    expect(await heardOf(admin, "Hey Jeff, hall request")).toMatchObject({ accepted: true })
    await hall.waitFor("turn.end", () => true, { timeoutMs: 10_000 })

    // With the wake phrase it works while playing.
    say(stt, 0, "Hey Jeff, what time is it")
    expect(await heardOf(admin, "Hey Jeff, what time is it")).toMatchObject({ accepted: true, matched: "hey jeff" })
    await kitchen.waitFor("turn.end", (_m) => true, { from: kitchen.messages.length - 1, timeoutMs: 10_000 }).catch(() => undefined)

    report(kitchen, "paused")
    await sleep(100)
    say(stt, 0, "quiet again")
    expect(await heardOf(admin, "quiet again")).toMatchObject({ accepted: true })
  })
})
