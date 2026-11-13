import { describe, expect, it } from "vitest"
import type { ServerMessage, ServerMessageType } from "@pva/protocol"
import { exampleSnapshot, exampleTrace, exampleWeatherModule, serverExamples } from "@pva/protocol/examples"
import { type Action, type ClientState, initialState, isOwner, lastLatency, MAX_TOASTS, modulesInOrder, reducer, speakingVoice, visualState } from "@/lib/state.ts"

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const welcome = serverExamples.welcome
const observerWelcome: ServerMessage = { ...welcome, snapshot: { ...exampleSnapshot, role: "observer", ownerPresent: false, state: "idle", history: [], traces: [] } }
const audioRunning: Action = { type: "local/audio", phase: "running" }

describe("reducer", () => {
  it("handles every server message type (examples from @pva/protocol)", () => {
    let s = run([welcome])
    for (const type of Object.keys(serverExamples) as Array<ServerMessageType>) {
      expect(() => {
        s = reducer(s, serverExamples[type])
      }).not.toThrow()
    }
    expect(s.connection.status).toBe("open")
  })

  it("welcome replaces the state from the snapshot and keeps the UI", () => {
    const before = run([{ type: "local/ui", patch: { chatOpen: true, optionsTab: "device" } }])
    const s = reducer(before, welcome)
    expect(s.connection).toMatchObject({ status: "open", attempt: 0, everConnected: true, connectionId: "conn-3", server: { name: "pva" } })
    expect(s.session).toMatchObject({ role: "owner", ownerPresent: true, serverState: "listening" })
    expect(modulesInOrder(s).map((m) => m.id)).toEqual(["weather", "home-assistant"])
    expect(s.sections.map((x) => x.id)).toEqual(["voices"])
    expect(s.ui.chatOpen).toBe(true)
    expect(s.ui.optionsTab).toBe("device")
    // History: 4 items → 2 turns; the second reply was interrupted (its text is what was heard).
    expect(s.turns).toHaveLength(2)
    expect(s.turns[0]).toMatchObject({ userText: "What's the weather like?", text: "Light rain in Amsterdam, 7 degrees.", outcome: "completed" })
    expect(s.turns[0]!.tools).toMatchObject([{ tool: "weather", status: "ok" }])
    expect(s.turns[1]).toMatchObject({ userText: "Tell me a long story", text: "Once upon a time,", outcome: "interrupted" })
    expect(s.traces).toEqual([exampleTrace])
  })

  it("follows a voice turn from the first interim transcript to the end (§2.5)", () => {
    const states: Array<string> = []
    let s = run([observerWelcome, audioRunning])
    const step = (a: Action) => {
      s = reducer(s, a)
      states.push(visualState(s))
    }
    expect(visualState(s)).toBe("not-started")
    step({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    step({ type: "state", state: "listening" })
    step({ type: "state", state: "hearing" })
    step({ type: "transcript", text: "what's the" })
    expect(s.liveTranscript).toBe("what's the")
    step({ type: "transcript", text: "what's the weather in Paris" })
    step({ type: "transcript", text: "" })
    step({ type: "turn.start", turnId: 12, source: "voice", userText: "What's the weather in Paris?", spoken: true })
    step({ type: "state", state: "thinking", turnId: 12 })
    step(serverExamples["tool.start"])
    step(serverExamples["tool.end"])
    step({ type: "assistant.text", turnId: 12, clause: 0, text: "It's sunny in Paris,", voice: "standard" })
    step({ type: "local/playing", turnId: 12 }) // the local player started
    step({ type: "state", state: "speaking", turnId: 12 })
    step({ type: "assistant.playing", turnId: 12, clause: 0 })
    step({ type: "assistant.text", turnId: 12, clause: 1, text: "eighteen degrees.", voice: "standard" })
    step({ type: "assistant.playing", turnId: 12, clause: 1 })
    step({ type: "local/playing", turnId: undefined }) // finished
    step({ type: "turn.end", turnId: 12, outcome: "completed", trace: exampleTrace })
    step({ type: "state", state: "listening" })

    const distinct = states.filter((v, i) => i === 0 || states[i - 1] !== v)
    // Claimed, then the server's states; never idle between speaking and listening.
    expect(distinct).toEqual(["idle", "listening", "hearing", "thinking", "speaking", "listening"])
    expect(s.liveTranscript).toBe("")
    const turn = s.turns.at(-1)!
    expect(turn).toMatchObject({ key: "t12", turnId: 12, userText: "What's the weather in Paris?", spoken: true, playedClause: 1, outcome: "completed" })
    expect(turn.clauses.map((c) => c.text)).toEqual(["It's sunny in Paris,", "eighteen degrees."])
    expect(turn.tools).toEqual([{ callId: "toolu_01", tool: "weather", input: { place: "Paris, France" }, status: "ok", ms: 241 }])
    expect(lastLatency(s)).toEqual({ ms: 31 + 21.3, label: "audible" })
    expect(s.ui.unread).toBe(1) // the chat was closed
  })

  it("an interrupted turn keeps every clause and the played position", () => {
    const s = run([
      welcome,
      { type: "turn.start", turnId: 13, source: "voice", userText: "Tell me a story", spoken: true },
      ...[0, 1, 2].map((i): Action => ({ type: "assistant.text", turnId: 13, clause: i, text: `Clause ${i}.` })),
      { type: "assistant.playing", turnId: 13, clause: 0 },
      { type: "turn.end", turnId: 13, outcome: "interrupted", trace: { ...exampleTrace, turnId: 13, outcome: "interrupted" } }
    ])
    expect(s.turns.at(-1)).toMatchObject({ outcome: "interrupted", playedClause: 0 })
    expect(s.turns.at(-1)!.clauses).toHaveLength(3)
  })

  it("a tab joining mid-turn creates the turn on the first event it sees", () => {
    const s = run([
      observerWelcome,
      { type: "assistant.text", turnId: 30, clause: 1, text: "second clause" },
      { type: "assistant.playing", turnId: 30, clause: 1 },
      { type: "tool.end", turnId: 30, callId: "x", ok: false, ms: 12, error: "boom" },
      { type: "state", state: "speaking", turnId: 30 }
    ])
    const t = s.turns.at(-1)!
    expect(t).toMatchObject({ key: "t30", turnId: 30, userText: "", spoken: true, playedClause: 1 })
    expect(t.clauses).toEqual([{ text: "" }, { text: "second clause" }])
    expect(t.tools).toMatchObject([{ callId: "x", status: "error", error: "boom" }])
    // An observer mirrors the server's speaking state (no local player).
    expect(isOwner(s)).toBe(false)
    expect(visualState({ ...s, session: { ...s.session, ownerPresent: true } })).toBe("speaking")
  })

  it("streams unspoken text deltas", () => {
    const s = run([
      welcome,
      { type: "turn.start", turnId: 40, source: "text", userText: "hi", spoken: false },
      { type: "assistant.text", turnId: 40, clause: null, text: "Hello" },
      { type: "assistant.text", turnId: 40, clause: null, text: " there." }
    ])
    expect(s.turns.at(-1)).toMatchObject({ source: "text", spoken: false, text: "Hello there." })
  })

  it("keeps the highest module and section revision", () => {
    const s0 = run([welcome])
    const newer = reducer(s0, { type: "module.changed", module: { ...exampleWeatherModule, revision: 9, enabled: false } })
    expect(newer.modules.byId.weather!.enabled).toBe(false)
    const stale = reducer(newer, { type: "module.changed", module: { ...exampleWeatherModule, revision: 4 } })
    expect(stale).toBe(newer)
    const added = reducer(newer, { type: "module.changed", module: { ...exampleWeatherModule, id: "notes", revision: 0 } })
    expect(added.modules.order).toEqual(["weather", "home-assistant", "notes"])
    const section = serverExamples["section.changed"].section
    expect(reducer(s0, { type: "section.changed", section: { ...section, revision: 0 } })).toBe(s0)
    expect(reducer(s0, { type: "section.changed", section: { ...section, revision: 2, title: "V" } }).sections[0]!.title).toBe("V")
  })

  it("tracks requests until their result", () => {
    let s = run([welcome, { type: "local/request", requestId: "r9", kind: "module.enable", target: "weather" }])
    expect(s.pending.r9).toEqual({ kind: "module.enable", target: "weather" })
    s = reducer(s, { type: "result", requestId: "r9", ok: true })
    expect(s.pending).toEqual({})
  })

  it("errors become toasts (at most 3) and attach to their turn", () => {
    let s = run([welcome, { type: "turn.start", turnId: 12, source: "voice", userText: "x", spoken: true }])
    s = reducer(s, serverExamples.error)
    expect(s.turns.at(-1)!.error).toBe("The language model did not answer in time.")
    for (let i = 0; i < 5; i++) s = reducer(s, { type: "local/toast", message: `m${i}`, tone: "info" })
    expect(s.toasts).toHaveLength(MAX_TOASTS)
    expect(s.toasts.at(-1)!.message).toBe("m4")
  })

  it("reconnect: losing the socket clears requests and playback; a new welcome replaces the snapshot", () => {
    let s = run([welcome, audioRunning, { type: "local/playing", turnId: 12 }, { type: "local/request", requestId: "r1", kind: "text.send" }, { type: "local/ui", patch: { chatOpen: true } }])
    s = reducer(s, { type: "local/socket-lost" })
    s = reducer(s, { type: "local/connection", status: "reconnecting", attempt: 2 })
    expect(s.pending).toEqual({})
    expect(s.audio.playing).toBeUndefined()
    expect(visualState(s)).toBe("disconnected")
    expect(s.connection.everConnected).toBe(true)
    s = reducer(s, { ...welcome, connectionId: "conn-4" })
    expect(s.connection).toMatchObject({ status: "open", attempt: 0, connectionId: "conn-4" })
    expect(s.audio.phase).toBe("running") // the audio graph belongs to the page
    expect(s.ui.chatOpen).toBe(true)
    expect(s.turns).toHaveLength(2)
  })

  it("visual states: owner muted, error, outdated", () => {
    const owner = run([welcome, audioRunning, { type: "local/mic", live: false }])
    expect(visualState(owner)).toBe("muted")
    expect(visualState(reducer(owner, { type: "state", state: "thinking" }))).toBe("thinking")
    expect(visualState(reducer(owner, { type: "local/audio", phase: "error", error: "denied" }))).toBe("error")
    expect(visualState(reducer(owner, { type: "local/connection", status: "outdated", attempt: 0 }))).toBe("error")
  })

  it("names the voice only when more than one is enabled", () => {
    const s = run([welcome, audioRunning, { type: "turn.start", turnId: 12, source: "voice", userText: "", spoken: true }, { type: "assistant.text", turnId: 12, clause: 0, text: "a", voice: "natural" }, { type: "local/playing", turnId: 12 }, { type: "assistant.playing", turnId: 12, clause: 0 }])
    expect(speakingVoice(s)).toBe("natural")
    const single = { ...s, engine: { ...s.engine, voices: s.engine.voices.slice(0, 1) } }
    expect(speakingVoice(single)).toBeUndefined()
  })

  it("opening the chat clears unread replies", () => {
    let s = run([welcome, { type: "turn.end", turnId: 12, outcome: "completed", trace: exampleTrace }])
    expect(s.ui.unread).toBe(1)
    s = reducer(s, { type: "local/ui", patch: { chatOpen: true } })
    expect(s.ui.unread).toBe(0)
  })
})
