// P9 review round 1 on the server's real parts (docs/NOTIFICATIONS.md): the voice session's announcement path (b2: the
// voice is made ready first and the decision is the last check, an announcement never takes a reply's speaker; b4: an
// open utterance, addressed or not, is not quiet), the page's Stop reaching the announcement (b5), and the hub's
// notification cases: a withheld card cannot be pressed (b1), two pages pressing at once run the handler once (b3), a
// changed declaration reconciles what pages hold (b6), an undeclared page follows the owner's no-display override (b7),
// module actions are bounded (b11) while Stop is not, and the card's own words are Dutch in a Dutch household (b12).
import { defineModule, makeToolRegistry, makeTurnTrace, type ModuleNotify, type ModuleSpeech, type TurnSetup } from "@pva/core"
import { BUILT_IN_WEB_VOICE_SETTINGS, type ServerMessage } from "@pva/protocol"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeVoiceSession } from "../src/serve/VoiceSession.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer, toneTts } from "./support/serveHarness.ts"

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

/** A real voice session on the test server's engines, its page played by hand (reports after fixed delays). */
const directSession = async (o: { readonly withoutPhrase?: "assistant" | "nobody"; readonly ready?: Deferred.Deferred<void> }) => {
  const stt = controlledStt()
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "A real reply.").llm }) })
  const scope = Effect.runSync(Scope.make())
  const messages: Array<ServerMessage> = []
  const assistants = new Map(Object.entries(server.handle.store.settings().assistants.byId))
  const assistant = [...assistants.keys()][0]!
  let setups = 0
  const session = await run(makeVoiceSession({
    key: "direct-device",
    deviceId: "direct-device",
    name: () => "Direct",
    engine: server.handle.engine,
    deviceSettings: () => ({
      ...BUILT_IN_WEB_VOICE_SETTINGS,
      assistants: [{ assistant, phrases: ["hey jeff"] }],
      withoutPhrase: o.withoutPhrase === "nobody" ? { mode: "nobody" } : { mode: "assistant", assistant }
    }),
    assistants: () => assistants as never,
    conversationSetup: () => ({
      setup: Effect.sync((): TurnSetup => {
        setups++
        // The first setup is the announcement's (its voice still being built while `ready` is held).
        return { system: "Test", registry: makeToolRegistry([]), tts: toneTts({ millisPerClause: 600 }), llm: scriptedLlm(() => "A real reply.").llm, ...(setups === 1 && o.ready !== undefined ? { ttsReady: Deferred.await(o.ready) } : {}) }
      })
    }),
    turnTrace: makeTurnTrace(),
    moduleOfTool: () => null,
    send: (m) => void messages.push(m),
    wakeHeard: () => undefined,
    onChange: () => undefined,
    heard: { dir: mkdtempSync(join(tmpdir(), "pva-heard-")), enabled: () => false, maxFiles: () => 0, model: () => "", lostOnTheWay: () => 0 },
    log: () => undefined
  }).pipe(Scope.provide(scope)))
  const link = {
    sendMessage: (m: ServerMessage) => {
      messages.push(m)
      if (m.type === "reply.start") setTimeout(() => session.web.report({ type: "playback.started", turnId: m.turnId, outputLatencyMs: 0, startDelayMs: 0 }, link as never), 20)
      if (m.type === "reply.stop") session.web.report({ type: "playback.stopped", turnId: m.turnId, playedSamples: 0 }, link as never)
      if (m.type === "reply.end") setTimeout(() => session.web.report({ type: "playback.finished", turnId: m.turnId, playedSamples: 10_000_000 }, link as never), 300)
    },
    sendBinary: () => undefined
  }
  session.web.setOwner(link as never)
  session.ownerChanged(true, true)
  session.conversation.start()
  await sleep(100)
  const starts = () => messages.filter((m): m is Extract<ServerMessage, { type: "reply.start" }> => m.type === "reply.start")
  return { session, messages, stt, starts, close: () => run(Effect.andThen(session.conversation.end, Scope.close(scope, Exit.void))) }
}

describe("the voice session's announcements (the real port)", () => {
  it("b2: a reply that starts while the announcement's voice is being made ready plays to its end; the announcement waits for it", async () => {
    const ready = Effect.runSync(Deferred.make<void>())
    const d = await directSession({ ready })
    try {
      const announcing = Effect.runFork(d.session.announce.speak("An announcement.", { cue: false, gate: () => "go" }))
      await sleep(50)
      expect(await run(d.session.conversation.sendText("Hello", true))).toBe("accepted")
      await until(() => d.starts().length === 1)
      await run(Deferred.succeed(ready, undefined))
      await sleep(150)
      // The reply was neither stopped nor superseded, and nothing else started over it.
      expect(d.messages.some((m) => m.type === "reply.stop")).toBe(false)
      expect(d.starts().length).toBe(1)
      await until(() => d.messages.some((m) => m.type === "turn.end"))
      expect(d.messages.find((m) => m.type === "turn.end")).toMatchObject({ outcome: "completed" })
      // Once the reply has ended, the announcement plays.
      await until(() => d.starts().length === 2, 5_000)
      expect(await run(Fiber.join(announcing))).toBe("spoken")
    } finally {
      await d.close()
    }
  })

  it("b2: the delivery decision is the last check before audio starts: one that says no after the voice was made ready skips it", async () => {
    const ready = Effect.runSync(Deferred.make<void>())
    const d = await directSession({ ready })
    try {
      let answer = "go"
      const announcing = Effect.runFork(d.session.announce.speak("Under do not disturb.", { cue: false, gate: () => answer }))
      await sleep(50)
      answer = "dnd"
      await run(Deferred.succeed(ready, undefined))
      expect(await run(Fiber.join(announcing))).toEqual({ skipped: "dnd" })
      expect(d.starts()).toEqual([])
    } finally {
      await d.close()
    }
  })

  it("b4: an utterance open in the recogniser, without a wake phrase, is not quiet: the announcement waits for its end, also past the hearing window", async () => {
    const d = await directSession({ withoutPhrase: "nobody" })
    try {
      d.stt.emit({ _tag: "SpeechStarted" }, { _tag: "Interim", text: "hello everybody" })
      await sleep(50)
      const announcing = Effect.runFork(d.session.announce.speak("Not over the person.", { cue: false, gate: () => "go" }))
      // Longer than the tracker's hearing window (2 s) with no interim refresh: still not quiet.
      await sleep(2_600)
      expect(d.starts()).toEqual([])
      d.stt.emit({ _tag: "EndOfTurn", text: "hello everybody" })
      await until(() => d.starts().length === 1, 3_000)
      expect(await run(Fiber.join(announcing))).toBe("spoken")
    } finally {
      await d.close()
    }
  })
})

// ---- The hub

let notify: ModuleNotify | undefined
let speech: ModuleSpeech | undefined
const presses: Array<string> = []
let handlerWait = 0
const bell = defineModule({
  apiVersion: 2,
  id: "bell",
  name: "Bell",
  description: "Rings.",
  shared: (ctx) =>
    Effect.gen(function*() {
      notify = ctx.notify
      speech = ctx.speech
      yield* ctx.notify.handle("answer", { run: (p) => Effect.andThen(Effect.sleep(handlerWait), Effect.sync(() => (presses.push(p.actionId), { say: "Handled." }))) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})
const startBellServer = async (home?: Record<string, string>) => {
  presses.length = 0
  handlerWait = 0
  server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm, tts: toneTts({ millisPerClause: 3_000 }) }), catalog: [greeterModule, bell] })
  if (home !== undefined) {
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    admin.send({ type: "settings.update", requestId: "home", sectionId: "home", patch: { values: home, secrets: {} } })
    await admin.waitFor("result", (m) => m.requestId === "home", { from: 0 })
  }
}
const page = async (deviceId: string, o: { readonly player?: boolean; readonly capabilities?: unknown } = {}) => {
  const c = await ScriptedClient.connect({ url: server!.url, deviceId, ...(o.player === false ? { player: { enabled: false } } : {}) })
  clients.push(c)
  await c.hello(o.capabilities !== undefined ? { device: { ...c.device, capabilities: o.capabilities as never } } : {})
  return c
}
let seq = 0
const press = (c: ScriptedClient, id: string, actionId: string) => {
  const requestId = `p-${++seq}`
  c.send({ type: "notification.action", requestId, id, actionId })
  return c.waitFor("result", (m) => m.requestId === requestId, { from: 0 })
}
const holds = (c: ScriptedClient, id: string) => {
  let held = false
  for (const m of c.messages) {
    if (m.type === "notification.ring" && m.notification.id === id) held = true
    if (m.type === "notification.resolved" && m.id === id) held = false
  }
  return held
}

describe("notifications through the hub", () => {
  it("b5: the page's Stop stops the announcement at once; the next announcement plays", async () => {
    await startBellServer()
    const c = await page("stop-device-0001", { player: false })
    await c.claim()
    await sleep(300)
    const h = await run(speech!.say({ device: c.device.id }, "First announcement."))
    const start = await c.waitFor("reply.start")
    await sleep(50)
    const at = Date.now()
    c.send({ type: "interrupt", turnId: start.turnId })
    c.send({ type: "playback.stopped", turnId: start.turnId, playedSamples: 0, exact: true })
    expect(await run(h.done)).toEqual([{ deviceId: c.device.id, outcome: "stopped" }])
    expect(Date.now() - at).toBeLessThan(1_000)
    const next = await run(speech!.say({ device: c.device.id }, "Second announcement."))
    const second = await c.waitFor("reply.start", (m) => m.turnId !== start.turnId)
    expect(second.turnId).not.toBe(start.turnId)
    await run(next.stop)
  })

  it("b1: a card withheld from a device cannot be pressed there, also with an id learned before; b3: two pages pressing at once run the handler once", async () => {
    await startBellServer()
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    admin.send({ type: "settings.update", requestId: "m", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam" }] }, secrets: {} } })
    await admin.waitFor("result", (m) => m.requestId === "m", { from: 0 })
    const sam = (server!.handle.store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<{ readonly id: string }>)[0]!.id
    const a = await page("press-device-a1")
    const b = await page("press-device-b1")
    await sleep(300)
    // Sam's personal card: the shared devices without a default person are not told, and cannot press it.
    const personal = await run(notify!.send({ title: "Sam's", owner: sam, priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }))
    await sleep(200)
    expect(holds(a, personal.notification.id)).toBe(false)
    for (const action of ["snooze", "stop"]) expect((await press(a, personal.notification.id, action)).ok).toBe(false)
    expect(presses).toEqual([])
    // A household card both hold, pressed by both at once while the handler works: one run, the other told.
    handlerWait = 150
    const both = await run(notify!.send({ title: "Race", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }))
    await until(() => holds(a, both.notification.id) && holds(b, both.notification.id))
    const answers = await Promise.all([press(a, both.notification.id, "snooze"), press(b, both.notification.id, "snooze")])
    expect(answers.filter((r) => r.ok).length).toBe(1)
    expect(answers.find((r) => !r.ok)?.say).toBe("That is being handled already.")
    expect(presses).toEqual(["snooze"])
  })

  it("b11: module actions go through the hub's bounded admission; Stop is always admitted", async () => {
    await startBellServer()
    const a = await page("burst-device-1")
    await sleep(300)
    handlerWait = 300
    const ids: Array<string> = []
    for (let i = 0; i < 8; i++) ids.push((await run(notify!.send({ title: `N${i}`, target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }))).notification.id)
    await until(() => ids.every((id) => holds(a, id)))
    const answers = await Promise.all(ids.map((id) => press(a, id, "snooze")))
    expect(answers.filter((r) => !r.ok && r.error?.code === "busy").length).toBeGreaterThan(0)
    expect(presses.length).toBeLessThanOrEqual(4)
    // Stop is outside the bound, whatever else is pending.
    const ring = await run(notify!.send({ title: "Stop me", priority: "ring", target: "everywhere" }))
    await until(() => holds(a, ring.notification.id))
    const pending = ids.map((id) => press(a, id, "snooze"))
    expect((await press(a, ring.notification.id, "stop")).ok).toBe(true)
    await Promise.all(pending)
  })

  it("b6: a changed declaration reconciles what the device's pages hold: a speaker taken away silences the ring, a display taken away withdraws the card, both come back", async () => {
    await startBellServer()
    const display = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, speaker: { media: ["speech"] } }
    const a = await page("caps-device-01", { capabilities: display })
    await sleep(300)
    const ring = await run(notify!.send({ title: "Ring", priority: "ring", target: "everywhere" }))
    await a.waitFor("notification.ring", (m) => m.notification.id === ring.notification.id && m.notification.sound, { from: 0 })
    const { speaker: _speaker, ...screenOnly } = display
    a.send({ type: "device.caps", capabilities: screenOnly as never })
    await a.waitFor("notification.ring", (m) => m.notification.id === ring.notification.id && !m.notification.sound)
    a.send({ type: "device.caps", capabilities: { v: 1, speaker: { media: ["speech"] } } as never })
    await a.waitFor("notification.ring", (m) => m.notification.id === ring.notification.id && !m.notification.show && m.notification.sound)
    a.send({ type: "device.caps", capabilities: { v: 1 } as never })
    await a.waitFor("notification.resolved", (m) => m.id === ring.notification.id && m.outcome === "withdrawn")
    a.send({ type: "device.caps", capabilities: display as never })
    await a.waitFor("notification.ring", (m) => m.notification.id === ring.notification.id && m.notification.show && m.notification.sound)
  })

  it("b7: an undeclared page follows the owner's no-display override (its own, and its type's); an undeclared page without one gets the card", async () => {
    await startBellServer()
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const own = await page("legacy-device-1")
    await sleep(300)
    const rec = server!.handle.store.settings().devices["legacy-device-1"]!
    admin.send({ type: "device.save", requestId: "s", target: { kind: "device", id: "legacy-device-1" }, rev: rec.rev, settings: { capabilities: { noDisplay: true, noSpeaker: false, excludeKinds: [] } } })
    expect((await admin.waitFor("result", (m) => m.requestId === "s", { from: 0 })).ok).toBe(true)
    await own.closed
    const again = await page("legacy-device-1")
    const other = await page("legacy-device-2")
    await sleep(300)
    const n = await run(notify!.send({ title: "Must not show", target: "everywhere" }))
    await other.waitFor("notification.ring", (m) => m.notification.id === n.notification.id)
    await sleep(100)
    expect(holds(again, n.notification.id)).toBe(false)
    // The type's override: every undeclared page of the type follows it.
    const type = (server!.handle.store.settings() as unknown as { readonly deviceTypes: Record<string, { readonly rev: number }> }).deviceTypes["web-voice"]
    admin.send({ type: "device.save", requestId: "t", target: { kind: "type", type: "web-voice" }, rev: type?.rev ?? 0, settings: { capabilities: { noDisplay: true, noSpeaker: false, excludeKinds: [] } } } as never)
    expect((await admin.waitFor("result", (m) => m.requestId === "t", { from: 0 })).ok).toBe(true)
    await other.closed
    const other2 = await page("legacy-device-2")
    await sleep(300)
    const n2 = await run(notify!.send({ title: "Not here either", target: "everywhere" }))
    await sleep(300)
    expect(holds(other2, n2.notification.id)).toBe(false)
  })

  it("b12: in a Dutch household the card's own words (Stop, the note, the region) and the answers are Dutch", async () => {
    await startBellServer({ HOME_LANGUAGE: "nl-NL" })
    const a = await page("dutch-device-01")
    await sleep(300)
    const n = await run(notify!.send({ title: "Het water kookt", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Later" }], handler: "answer" }))
    const ring = await a.waitFor("notification.ring", (m) => m.notification.id === n.notification.id, { from: 0 })
    expect(ring.notification.actions[0]).toEqual({ id: "stop", label: "Stop" })
    expect(ring.notification.texts).toEqual({ region: "Meldingen", startAudio: "Zet het geluid aan om het te horen." })
    expect((await press(a, n.notification.id, "stop")).say).toBe("Klaar.")
  })
})
