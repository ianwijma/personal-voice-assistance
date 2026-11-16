// SessionHub request limits: requests that do work (settings, modules, reload) are bounded per connection and overall.
import { encodeClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import { Deferred, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeAccessPolicy } from "../src/serve/access.ts"
import { makeAdminSessions } from "../src/serve/AdminSessions.ts"
import { type HubConnection, makeSessionHub } from "../src/serve/SessionHub.ts"

const ADMIN_PASSWORD = "hub admin password"

/** No key vault; an admin password (each tab of these tests logs in, since every change is admin only). */
const noVault = () => ({
  keys: { state: () => "none", info: () => ({ state: "none", admin: true, location: "" }), subscribe: () => () => {} } as never,
  access: makeAccessPolicy({ catalog: [], sections: () => [], vaultState: () => "none" }),
  admin: makeAdminSessions({ password: ADMIN_PASSWORD }),
  assistants: {
    setupFor: () => ({ assistants: [], withoutPhrase: { mode: "nobody" }, canPick: false, canAuto: false, interruptMode: "confirm", audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, speakAloud: true, outputPath: "direct", prebufferMs: 60 }, captions: { captions: true, speakTyped: true } }),
    infos: () => [],
    deviceTypes: () => [],
    devices: () => []
  } as never,
  devices: {
    devices: () => [],
    seen: () => Effect.void,
    left: () => {}
  } as never
})

/** Voice sessions: `send` is what each session's conversation answers a typed input with. */
const fakeSessions = (send: (input: unknown) => string = () => "accepted") => {
  const sessions = new Map<string, unknown>()
  const make = (key: string) => ({
    key,
    deviceId: undefined,
    name: () => "tab",
    web: { setOwner: () => {}, setMicLive: () => {}, micFrame: () => {}, report: () => {} },
    tracker: { current: () => ({ state: "idle" }) },
    publisher: { committedTurn: () => undefined },
    // Typed text goes to the session's routed conversations (`sendText`, an Effect since WP-4b); Stop is `stop`.
    conversation: {
      sendText: (text: string, speak: boolean) => Effect.sync(() => send({ _tag: "TextInput", text, speak })),
      stop: () => send({ _tag: "Interrupt" }),
      history: () => Effect.succeed([]),
      conversation: () => ({ id: "c1", startedAt: 0 })
    },
    syncProfile: () => {},
    ownerChanged: () => {},
    touch: () => {}
  })
  return {
    get: (key: string) => sessions.get(key),
    open: (key: string) => {
      if (!sessions.has(key)) sessions.set(key, make(key))
      return sessions.get(key)
    },
    connections: () => {},
    conversation: () => ({ id: "c1", startedAt: 0 }),
    list: () => [],
    all: () => [...sessions.values()],
    size: () => sessions.size,
    mostRecent: () => undefined,
    traces: () => []
  } as never
}

const setup = () => {
  const gate = Effect.runSync(Deferred.make<void>())
  let started = 0
  let finished = 0
  const work = <A>(value: A) =>
    Effect.suspend(() => {
      started++
      return Deferred.await(gate).pipe(Effect.as(value), Effect.ensuring(Effect.sync(() => finished++)))
    })
  const hub = makeSessionHub({
    engine: {
      status: () => ({ state: "ready", problems: [], reloadPending: false, reloadPendingFor: [], engines: [], voices: [] }),
      reload: work({ ok: true })
    } as never,
    host: { modules: () => [], enable: () => work({ ok: true }), disable: () => work({ ok: true }), configure: () => work({ ok: true }) } as never,
    sections: { list: () => [], update: () => work({ result: { ok: true }, reload: false }) } as never,
    sessions: fakeSessions(),
    run: (effect) => void Effect.runFork(effect),
    onSectionSaved: () => {},
    server: { name: "test", version: "0" },
    ...noVault()
  })
  const connect = (id: string) => {
    const received: Array<ServerMessage> = []
    const connection: HubConnection = {
      id,
      sendText: (t) => received.push(JSON.parse(t)),
      sendBinary: () => {},
      close: () => {},
      bufferedAmount: () => 0
    }
    const handlers = hub.accept(connection)!
    handlers.onText(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: `client-${id}-0000`, resumeOwner: false, frontend: "admin" }))
    handlers.onText(encodeClientMessage({ type: "admin.login", requestId: `login-${id}`, password: ADMIN_PASSWORD }))
    // Only the results of the requests under test.
    const results = () => received.filter((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result" && !m.requestId.startsWith("login-"))
    return { handlers, results }
  }
  return { hub, connect, release: () => Effect.runSync(Deferred.succeed(gate, undefined)), started: () => started, finished: () => finished }
}

const settingsUpdate = (n: number) =>
  encodeClientMessage({ type: "settings.update", requestId: `s${n}`, sectionId: "listening", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 500 + n }, secrets: {} } })

describe("SessionHub: request limits", () => {
  it("a flood of settings.update from one tab starts a bounded number of operations; the rest are answered busy", async () => {
    const t = setup()
    const a = t.connect("a")
    for (let i = 0; i < 1_000; i++) a.handlers.onText(settingsUpdate(i))
    await new Promise((r) => setTimeout(r, 20))
    expect(t.started()).toBeLessThanOrEqual(4)
    const busy = a.results().filter((r) => !r.ok && r.error?.code === "busy")
    expect(busy.length).toBe(1_000 - t.started())
    t.release()
    await new Promise((r) => setTimeout(r, 20))
    expect(t.finished()).toBe(t.started())
    expect(a.results().filter((r) => r.ok).length).toBe(t.started())
    // The slots are free again.
    a.handlers.onText(settingsUpdate(2_000))
    await new Promise((r) => setTimeout(r, 20))
    expect(a.results().at(-1)).toEqual({ type: "result", requestId: "s2000", ok: true })
  })

  it("the bound holds across connections (and across request kinds)", async () => {
    const t = setup()
    const tabs = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => t.connect(id))
    for (const [i, tab] of tabs.entries()) {
      for (let j = 0; j < 50; j++) {
        tab.handlers.onText(settingsUpdate(i * 100 + j))
        tab.handlers.onText(encodeClientMessage({ type: "module.configure", requestId: `m${i}-${j}`, moduleId: "greeter", patch: { values: {}, secrets: {} } }))
        tab.handlers.onText(encodeClientMessage({ type: "engine.reload", requestId: `r${i}-${j}` }))
      }
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(t.started()).toBeLessThanOrEqual(16)
    const answered = tabs.reduce((n, tab) => n + tab.results().length, 0)
    expect(answered).toBe(8 * 150 - t.started())
    t.release()
  })
})

describe("SessionHub: typed input", () => {
  const hubWith = (send: () => string, state = "ready") => {
    const sent: Array<unknown> = []
    const hub = makeSessionHub({
      engine: {
        status: () => ({ state, problems: [], reloadPending: false, reloadPendingFor: [], engines: [], voices: [] })
      } as never,
      host: { modules: () => [] } as never,
      sections: { list: () => [] } as never,
      sessions: fakeSessions((input: unknown) => {
        sent.push(input)
        return send()
      }),
      run: (effect) => void Effect.runFork(effect),
      onSectionSaved: () => {},
      server: { name: "test", version: "0" },
      ...noVault()
    })
    const received: Array<ServerMessage> = []
    const handlers = hub.accept({ id: "a", sendText: (t) => received.push(JSON.parse(t)), sendBinary: () => {}, close: () => {}, bufferedAmount: () => 0 })!
    handlers.onText(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "client-a-0000", resumeOwner: false, frontend: "voice" }))
    const say = (n: number) => handlers.onText(encodeClientMessage({ type: "text.send", requestId: `t${n}`, text: `hi ${n}`, speak: false }))
    const results = () => received.filter((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result")
    return { say, results, sent }
  }

  it("text.send is acknowledged ok only when the session accepted it; refused input is answered busy", () => {
    let n = 0
    const t = hubWith(() => (n++ < 4 ? "accepted" : "busy"))
    for (let i = 0; i < 10; i++) t.say(i)
    expect(t.results().map((r) => (r.ok ? "ok" : r.error?.code))).toEqual(["ok", "ok", "ok", "ok", "busy", "busy", "busy", "busy", "busy", "busy"])
  })

  it("while the engines are not running, text.send is answered engine_failed and nothing is queued", () => {
    const t = hubWith(() => "accepted", "reloading")
    t.say(1)
    expect(t.results()[0]?.error?.code).toBe("engine_failed")
    expect(t.sent).toEqual([])
  })
})
