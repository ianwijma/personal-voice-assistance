// P9 review round 2 on the server's real parts (docs/NOTIFICATIONS.md "Speech"): an announcement belongs to the voice
// session it was started on and ends with it, so the device's queue moves on with the next session (b1); a
// declaration that takes speech away stops the announcement being spoken, through the service, and the page flushes it
// (b2, by `device.caps` and by another tab's hello); a press the hub's admission bound refuses answers in the
// household's language (b6).
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
/** A fiber's end within `ms`, or "still waiting". */
const within = <A, E>(fiber: Fiber.Fiber<A, E>, ms: number) =>
  run(Effect.exit(Fiber.join(fiber)).pipe(Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.succeed("still waiting" as const) })))
const failureOf = (exit: unknown) => (Exit.isExit(exit) && Exit.isFailure(exit) ? String((exit.cause.reasons[0] as { readonly error?: { readonly message?: string } })?.error?.message) : exit)

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

describe("b1: an announcement ends with its voice session (the real port)", () => {
  const directSession = async (ready?: Deferred.Deferred<void>) => {
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "A reply.").llm }) })
    const scope = Effect.runSync(Scope.make())
    const assistants = new Map(Object.entries(server.handle.store.settings().assistants.byId))
    const assistant = [...assistants.keys()][0]!
    const messages: Array<ServerMessage> = []
    const session = await run(makeVoiceSession({
      key: "ending-device",
      deviceId: "ending-device",
      name: () => "Ending",
      engine: server.handle.engine,
      deviceSettings: () => ({ ...BUILT_IN_WEB_VOICE_SETTINGS, assistants: [{ assistant, phrases: ["hey jeff"] }], withoutPhrase: { mode: "nobody" } }),
      assistants: () => assistants as never,
      conversationSetup: () => ({
        setup: Effect.sync((): TurnSetup => ({ system: "Test", registry: makeToolRegistry([]), tts: toneTts({ millisPerClause: 600 }), llm: scriptedLlm(() => "A reply.").llm, ...(ready !== undefined ? { ttsReady: Deferred.await(ready) } : {}) }))
      }),
      turnTrace: makeTurnTrace(),
      moduleOfTool: () => null,
      send: (m) => void messages.push(m),
      wakeHeard: () => undefined,
      onChange: () => undefined,
      heard: { dir: mkdtempSync(join(tmpdir(), "pva-heard-")), enabled: () => false, maxFiles: () => 0, model: () => "", lostOnTheWay: () => 0 },
      log: () => undefined
    }).pipe(Scope.provide(scope)))
    session.conversation.start()
    await sleep(100)
    return { session, stt, messages, end: () => run(Effect.andThen(session.conversation.end, Scope.close(scope, Exit.void))) }
  }

  it("ending the session while the announcement waits for an open utterance to end settles it (failed, the voice session ended)", async () => {
    const d = await directSession()
    d.stt.emit({ _tag: "SpeechStarted" }, { _tag: "Interim", text: "hello everybody" })
    await sleep(50)
    const announcing = Effect.runFork(d.session.announce.speak("Waiting for quiet.", { cue: false, gate: () => "go" }))
    await sleep(300)
    await d.end()
    expect(failureOf(await within(announcing, 1_000))).toBe("the voice session ended")
    // And one asked for after the end fails at once.
    expect(failureOf(await within(Effect.runFork(d.session.announce.speak("Later.", { cue: false, gate: () => "go" })), 500))).toBe("the voice session ended")
  })

  it("ending the session while the announcement's voice is being made ready settles it", async () => {
    const ready = Effect.runSync(Deferred.make<void>())
    const d = await directSession(ready)
    const announcing = Effect.runFork(d.session.announce.speak("Waiting for the voice.", { cue: false, gate: () => "go" }))
    await sleep(200)
    await d.end()
    expect(failureOf(await within(announcing, 1_000))).toBe("the voice session ended")
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
  const stt = controlledStt()
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "Ok.").llm, tts: toneTts({ millisPerClause: 3_000 }) }), catalog: [greeterModule, bell] })
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  await admin.admin(TEST_ADMIN_PASSWORD)
  if (home !== undefined) {
    admin.send({ type: "settings.update", requestId: "home", sectionId: "home", patch: { values: home, secrets: {} } })
    await admin.waitFor("result", (m) => m.requestId === "home", { from: 0 })
  }
  return { stt, admin }
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
const DISPLAY_AND_SPEAKER = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, speaker: { media: ["speech"] } }

describe("notifications through the hub, round 2", () => {
  it("b1: the device's session ends (its boundary changed) while an announcement waits for an open utterance: it settles, and the next plays on the new session", async () => {
    const { stt, admin } = await startBellServer()
    const c = await page("ending-device-01", { player: false })
    await c.claim()
    await sleep(300)
    stt.emit({ _tag: "SpeechStarted" }, { _tag: "Interim", text: "talking about something" })
    await sleep(100)
    const first = await run(speech!.say({ device: c.device.id }, "Waits for quiet."))
    const firstDone = Effect.runFork(first.done)
    await sleep(400)
    expect(c.messages.some((m) => m.type === "reply.start")).toBe(false)
    // An output override is a boundary change: the session ends with its connections.
    const rec = server!.handle.store.settings().devices[c.device.id]!
    admin.send({ type: "device.save", requestId: "s", target: { kind: "device", id: c.device.id }, rev: rec.rev, settings: { capabilities: { noDisplay: true, noSpeaker: false, excludeKinds: [] } } })
    expect((await admin.waitFor("result", (m) => m.requestId === "s", { from: 0 })).ok).toBe(true)
    await c.closed
    const done = await within(firstDone, 2_000)
    expect(Exit.isExit(done) && Exit.isSuccess(done) ? done.value : done).toEqual([{ deviceId: c.device.id, outcome: "failed", why: "the voice session ended" }])
    // A new page claims the device: the queue moves on with its session.
    const again = await page("ending-device-01", { player: false })
    await again.claim()
    await sleep(300)
    const second = await run(speech!.say({ device: again.device.id }, "On the new session."))
    await again.waitFor("reply.start")
    await run(second.stop)
  })

  for (const how of ["device.caps", "another tab's hello"] as const) {
    it(`b2: a declaration that takes the speaker away (${how}) stops the announcement being spoken, through the service: the page is told to stop and flush`, async () => {
      await startBellServer()
      const a = await page(`unspeak-${how === "device.caps" ? "caps" : "hello"}-01`, { player: false, capabilities: DISPLAY_AND_SPEAKER })
      await a.claim()
      await sleep(300)
      const h = await run(speech!.say({ device: a.device.id }, "A long announcement that is being played."))
      const start = await a.waitFor("reply.start")
      a.send({ type: "playback.started", turnId: start.turnId, outputLatencyMs: 0, startDelayMs: 0 })
      await sleep(200)
      const { speaker: _speaker, ...screenOnly } = DISPLAY_AND_SPEAKER
      if (how === "device.caps") a.send({ type: "device.caps", capabilities: screenOnly as never })
      else await page(a.device.id, { player: false, capabilities: screenOnly })
      await a.waitFor("reply.stop", (m) => m.turnId === start.turnId)
      a.send({ type: "playback.stopped", turnId: start.turnId, playedSamples: 0, exact: true })
      const done = await within(Effect.runFork(h.done), 2_000)
      expect(Exit.isExit(done) && Exit.isSuccess(done) ? done.value : done).toEqual([{ deviceId: a.device.id, outcome: "stopped" }])
    })
  }

  it("b6: a press the hub's admission bound refuses answers with the service's sentence in a Dutch household; Stop stays outside the bound", async () => {
    await startBellServer({ HOME_LANGUAGE: "nl-NL" })
    const a = await page("dutch-burst-01")
    await sleep(300)
    handlerWait = 300
    const ids: Array<string> = []
    for (let i = 0; i < 8; i++) ids.push((await run(notify!.send({ title: `N${i}`, target: "everywhere", actions: [{ id: "snooze", label: "Later" }], handler: "answer" }))).notification.id)
    await until(() => ids.every((id) => holds(a, id)))
    const answers = await Promise.all(ids.map((id) => press(a, id, "snooze")))
    const refused = answers.filter((r) => !r.ok && r.error?.code === "busy")
    expect(refused.length).toBeGreaterThan(0)
    for (const r of refused) {
      expect(r.say).toBe("Te veel tegelijk; probeer het zo opnieuw.")
      expect(r.error?.message).toBe("Te veel tegelijk; probeer het zo opnieuw.")
    }
    const ring = await run(notify!.send({ title: "Stop", priority: "ring", target: "everywhere" }))
    await until(() => holds(a, ring.notification.id))
    const pending = ids.map((id) => press(a, id, "snooze"))
    expect(await press(a, ring.notification.id, "stop")).toMatchObject({ ok: true, say: "Klaar." })
    await Promise.all(pending)
  })
})
