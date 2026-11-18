// SessionHub request limits: requests that do work (settings, modules, reload) are bounded per connection and overall.
import { decodeServerMessage, encodeClientMessage, MAX_TEXT_FRAME_BYTES, type ModuleInfo, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import { exampleWeatherModule } from "@pva/protocol/examples"
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
    left: () => {},
    // P5: every message is numbered on arrival.
    arrival: (() => {
      let n = 0
      return () => ++n
    })()
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
    touch: () => {},
    holder: () => null,
    pickAccepted: () => {}
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

const setup = (modules: () => ReadonlyArray<ModuleInfo> = () => []) => {
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
    host: { modules, enable: () => work({ ok: true }), disable: () => work({ ok: true }), configure: () => work({ ok: true }) } as never,
    sections: { list: () => [], update: () => work({ result: { ok: true }, reload: false }) } as never,
    sessions: fakeSessions(),
    run: (effect) => void Effect.runFork(effect),
    onSectionSaved: () => {},
    server: { name: "test", version: "0" },
    ...noVault()
  })
  /** `buffered`: a page whose socket never drains (everything sent stays buffered), to check the send limit. */
  const connect = (id: string, buffered = false) => {
    const received: Array<ServerMessage> = []
    const texts: Array<string> = []
    let pending = 0
    let closed = false
    const connection: HubConnection = {
      id,
      sendText: (t) => {
        texts.push(t)
        received.push(JSON.parse(t))
        if (buffered) pending += new TextEncoder().encode(t).length
      },
      sendBinary: () => {},
      close: () => void (closed = true),
      bufferedAmount: () => pending
    }
    const handlers = hub.accept(connection)!
    handlers.onText(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: `client-${id}-0000`, resumeOwner: false, frontend: "admin" }))
    handlers.onText(encodeClientMessage({ type: "admin.login", requestId: `login-${id}`, password: ADMIN_PASSWORD }))
    // Only the results of the requests under test.
    const results = () => received.filter((m): m is Extract<ServerMessage, { type: "result" }> => m.type === "result" && !m.requestId.startsWith("login-"))
    return { handlers, results, texts, closed: () => closed }
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

// Review rounds 5 and 6 of PR 90 (5A-2, 6A-2): the modules together have a share of the admin snapshot's frame; a
// module that does not fit is a light entry there, and its complete projection follows at once in its own frame.
describe("SessionHub: the admin snapshot fits its frame", () => {
  /** After the login: the snapshot, then the frames that follow it, each decoded. */
  const adminSend = (texts: ReadonlyArray<string>) => {
    const at = texts.findLastIndex((x) => x.includes('"admin.snapshot"'))
    const decoded = texts.slice(at).map((text) => {
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_FRAME_BYTES)
      const result = decodeServerMessage(text)
      expect(result._tag).toBe("Ok")
      return result._tag === "Ok" ? result.message : undefined
    })
    const snapshot = decoded[0] as Extract<ServerMessage, { type: "admin.snapshot" }>
    const after = decoded.slice(1) as Array<ServerMessage>
    const light = snapshot.snapshot.modules.filter((m) => m.details === "follow")
    // Every light entry's complete projection follows at once, in order, before anything else.
    const follow = after.slice(0, light.length)
    expect(follow.map((m) => m.type)).toEqual(light.map(() => "module.changed"))
    expect(follow.map((m) => (m as Extract<ServerMessage, { type: "module.changed" }>).module.id)).toEqual(light.map((m) => m.id))
    const page = new Map(snapshot.snapshot.modules.map((m) => [m.id, m]))
    for (const m of follow) page.set((m as Extract<ServerMessage, { type: "module.changed" }>).module.id, (m as Extract<ServerMessage, { type: "module.changed" }>).module)
    return { light, page }
  }
  const big = (m: number): ModuleInfo => ({
    ...exampleWeatherModule,
    id: `m${m}`,
    name: `Module ${m}`,
    tools: [],
    settings: {
      fields: [{ type: "textList", key: "list", label: "List", apply: "live", default: [], maxItems: 200, itemMaxLength: 500, source: "saved" }],
      values: { list: Array.from({ length: 120 }, (_, i) => `${i} `.padEnd(380 - m, "x")) },
      secrets: {},
      errors: []
    }
  })

  it("forty modules with forms just under their limit: the snapshot decodes, those it has no room for follow it in their own frames, and none is withheld", () => {
    const modules = Array.from({ length: 40 }, (_, m) => big(m))
    const t = setup(() => modules)
    const a = t.connect("a")
    const { light, page } = adminSend(a.texts)
    expect(light.length).toBeGreaterThan(0)
    for (const m of light) expect([m.settings.fields, m.tools]).toEqual([[], []])
    // The page ends with every module's complete form.
    for (const m of modules) expect(page.get(m.id)?.settings).toEqual(m.settings)
  })

  it("Sol's forty modules with 32 long routes each: the snapshot and every frame after it decode, and the page ends with every module's routes", () => {
    const route = (i: number) => ({
      method: "GET" as const,
      path: `/api/modules/web/r${String(i).padStart(2, "0")}-${"p".repeat(60)}/${"q".repeat(64)}/${"r".repeat(64)}`,
      guards: ["admin" as const],
      public: false,
      bodyLimitBytes: 0,
      ratePerMinute: { perAddress: 60, total: 600 },
      description: "d".repeat(500)
    })
    const modules = Array.from({ length: 40 }, (_, m): ModuleInfo => ({ ...exampleWeatherModule, id: `web${m}`, name: `Web ${m}`, tools: [], routes: Array.from({ length: 32 }, (_, i) => route(i)) }))
    const t = setup(() => modules)
    const a = t.connect("a")
    const { light, page } = adminSend(a.texts)
    expect(light.length).toBeGreaterThan(0)
    for (const m of modules) expect(page.get(m.id)?.routes).toEqual(m.routes)
  })

  it("a page whose socket does not drain gets the snapshot and every frame that follows it: they are one answer to the send limit", () => {
    const modules = Array.from({ length: 40 }, (_, m) => big(m))
    const t = setup(() => modules)
    const a = t.connect("a", true)
    const { light, page } = adminSend(a.texts)
    expect(light.length).toBeGreaterThan(0)
    expect(a.closed()).toBe(false)
    for (const m of modules) expect(page.get(m.id)?.settings).toEqual(m.settings)
  })
})

describe("SessionHub: device.caps is bounded before the registry (P5, round-1 item 8)", () => {
  it("400 alternating declarations from one tab reach the registry a bounded number of times, each with its number of arrival", async () => {
    const declared: Array<{ readonly seq: number | undefined; readonly at: number }> = []
    let n = 0
    const registry = {
      devices: () => [],
      seen: () => Effect.void,
      left: () => {},
      known: () => true,
      nameOf: () => undefined,
      kindOfDevice: () => "web-voice",
      declaredOf: () => undefined,
      arrival: () => ++n,
      declare: (_id: string, _caps: unknown, seq?: number) => {
        declared.push({ seq, at: performance.now() })
        return true
      },
      persist: Effect.void
    }
    const hub = makeSessionHub({
      engine: { status: () => ({ state: "ready", problems: [], reloadPending: false, reloadPendingFor: [], engines: [], voices: [] }) } as never,
      host: { modules: () => [] } as never,
      sections: { list: () => [] } as never,
      sessions: fakeSessions(),
      run: (effect) => void Effect.runFork(effect),
      onSectionSaved: () => {},
      server: { name: "test", version: "0" },
      ...noVault(),
      devices: registry as never
    })
    const handlers = hub.accept({ id: "v1", sendText: () => {}, sendBinary: () => {}, close: () => {}, bufferedAmount: () => 0 })!
    handlers.onText(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "client-v1-0000", resumeOwner: false, frontend: "voice", device: { id: "flood-dev-01", kind: "web-voice", name: "Tab" } }))
    const tablet = { v: 1 as const, display: { class: "standard" as const, widthPx: 1024, heightPx: 768, dpr: 1, touch: "coarse" as const, colour: true } }
    const phone = { ...tablet, display: { ...tablet.display, class: "compact" as const, widthPx: 390 }, openUrl: true }
    const before = n
    for (let i = 0; i < 400; i++) handlers.onText(encodeClientMessage({ type: "device.caps", capabilities: i % 2 === 0 ? phone : tablet }))
    // Every message was numbered as it arrived…
    expect(n - before).toBe(400)
    await new Promise((r) => setTimeout(r, 700))
    // …but the registry saw the first at once and the latest after the interval, nothing in between.
    expect(declared.length).toBe(2)
    expect(declared[0]!.seq).toBe(before + 1)
    expect(declared[1]!.seq).toBe(before + 400)
    expect(declared[1]!.at - declared[0]!.at).toBeGreaterThanOrEqual(450)
    handlers.onClose()
  })
})
