import { describe, expect, it } from "vitest"
import type { ServerMessage } from "@pva/protocol"
import { exampleAdminSnapshot, exampleConversation, exampleSession, serverExamples } from "@pva/protocol/examples"
import { agoText, sessionsFullText, talkingSessions, turnsText } from "@/lib/sessions.ts"
import { type Action, type ClientState, initialState, reducer } from "@/lib/state.ts"

/** Protocol 6 in the page (docs/VOICE-SESSIONS.md §5): the device's conversation, the divider, admin's sessions. */

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const welcome = serverExamples.welcome
/** The one conversation of a device whose snapshot carries no setup (one chat, under the empty key). */
const only = (s: ClientState) => s.conversations[""]
const conversation = (reason: "new" | "idle" | "resumed", id = `conv-${reason}`): ServerMessage => ({ type: "conversation", id, reason, startedAt: 1_763_100_600_000 })
const turnStart = (turnId: number, userText = "Hello"): ServerMessage => ({ type: "turn.start", turnId, source: "text", userText, spoken: false })
const turnEnd = (turnId: number, outcome: "completed" | "interrupted" = "completed"): ServerMessage => ({
  type: "turn.end",
  turnId,
  outcome,
  trace: { turnId, mode: "text", speculative: false, outcome, marks: {}, tools: [], voices: [] }
})

describe("the device's conversation", () => {
  it("welcome takes snapshot.conversation and shows no divider on the first connect", () => {
    const s = run([welcome])
    expect(only(s)).toMatchObject({ id: exampleConversation.id, startedAt: exampleConversation.startedAt, loaded: true })
    expect(only(s)?.divider).toBeUndefined()
    expect(s.turns.length).toBeGreaterThan(0)
  })

  it("new: the chat empties and gets the divider; the conversation is the new one; unread goes", () => {
    let s = run([welcome, turnStart(30), turnEnd(30)])
    expect(s.ui.unread).toBe(1)
    s = run([{ type: "transcript", text: "and then" }, conversation("new")], s)
    expect(s.turns).toEqual([])
    expect(s.liveTranscript).toBe("")
    expect(only(s)?.divider).toBe("new")
    expect(only(s)).toMatchObject({ id: "conv-new", startedAt: 1_763_100_600_000 })
    expect(s.ui.unread).toBe(0)
  })

  it("idle: the same, with its own divider", () => {
    const s = run([welcome, conversation("idle")])
    expect(s.turns).toEqual([])
    expect(only(s)?.divider).toBe("idle")
  })

  it("resumed: the chat stays as it is, only the id changes", () => {
    const before = run([welcome, turnStart(30), turnEnd(30)])
    const s = reducer(before, conversation("resumed", "conv-later"))
    expect(s.turns).toBe(before.turns)
    expect(only(s)?.divider).toBeUndefined()
    expect(only(s)?.id).toBe("conv-later")
  })

  it("turns of the new conversation come after the divider", () => {
    const s = run([welcome, conversation("new"), turnStart(1, "Fresh start"), turnEnd(1)])
    expect(only(s)?.divider).toBe("new")
    expect(s.turns.map((t) => t.userText)).toEqual(["Fresh start"])
    expect(s.turns[0]!.outcome).toBe("completed")
  })

  it("late messages about the replaced conversation's turn do not come back into the new one", () => {
    let s = run([welcome, turnStart(30, "Tell me a long story"), { type: "assistant.text", turnId: 30, clause: null, text: "Once" }])
    s = run([conversation("new"), { type: "assistant.text", turnId: 30, clause: null, text: " upon" }, turnEnd(30, "interrupted")], s)
    expect(s.turns).toEqual([])
    expect(s.ui.unread).toBe(0)
    expect(s.traces.some((t) => t.turnId === 30)).toBe(false)
    // Turn ids start again in a new conversation: the same id is a new turn once it starts.
    s = run([turnStart(30, "Again"), turnEnd(30)], s)
    expect(s.turns.map((t) => t.userText)).toEqual(["Again"])
    expect(s.staleTurns).toEqual([])
  })

  it("an error about the replaced turn still says what went wrong, without a ghost turn", () => {
    const s = run([welcome, turnStart(30), conversation("new"), { type: "error", error: { code: "turn_failed", message: "It failed.", turnId: 30 } }])
    expect(s.turns).toEqual([])
    expect(s.toasts.at(-1)?.message).toBe("It failed.")
  })

  it("a reconnect keeps the divider while the conversation is the same one", () => {
    const s = run([welcome, conversation("new", exampleConversation.id), welcome])
    expect(only(s)?.divider).toBe("new")
  })

  it("a reconnect into an empty, different conversation (replaced while away) shows the divider", () => {
    const away = { ...welcome, snapshot: { ...welcome.snapshot, history: [], conversation: { id: "conv-other", startedAt: 1 } } }
    expect(run([welcome, away]).conversations[""]?.divider).toBe("new")
    // ... but not when that conversation already has turns: the chat shows them as they are.
    const full = { ...welcome, snapshot: { ...welcome.snapshot, conversation: { id: "conv-other", startedAt: 1 } } }
    expect(run([welcome, full]).conversations[""]?.divider).toBeUndefined()
  })

  it("sessions_full is not a toast: the client shows it where Start was", () => {
    const s = run([welcome, { type: "error", error: { code: "sessions_full", message: "The assistant is already talking on 4 devices." } }])
    expect(s.toasts).toEqual([])
  })
})

describe("admin: voice sessions", () => {
  it("admin.snapshot and sessions set the list; logging out empties it", () => {
    const loggedIn = { ...welcome, snapshot: { ...welcome.snapshot, admin: { enabled: true, loggedIn: true } } }
    let s = run([loggedIn, { type: "admin.snapshot", snapshot: exampleAdminSnapshot }])
    expect(s.sessions).toEqual(exampleAdminSnapshot.sessions)
    s = reducer(s, { type: "sessions", sessions: [exampleSession] })
    expect(s.sessions).toEqual([exampleSession])
    s = reducer(s, { type: "admin.state", admin: { enabled: true, loggedIn: false, endReason: "logout" } })
    expect(s.sessions).toEqual([])
  })

  it("a reconnect with a valid token keeps the list until the new admin.snapshot", () => {
    const loggedIn = { ...welcome, snapshot: { ...welcome.snapshot, admin: { enabled: true, loggedIn: true } } }
    const s = run([loggedIn, { type: "sessions", sessions: [exampleSession] }, loggedIn])
    expect(s.sessions).toEqual([exampleSession])
  })

  it("trace: each session's finished turn is appended live, with its device, even when turn ids repeat across sessions", () => {
    const loggedIn = { ...welcome, snapshot: { ...welcome.snapshot, admin: { enabled: true, loggedIn: true } } }
    let s = run([loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, traces: [] } }])
    const trace = (key: string, session: string, turnId: number): ServerMessage => ({
      type: "trace",
      key,
      trace: { turnId, mode: "voice", speculative: false, outcome: "completed", marks: { playbackStart: 30 }, tools: [], voices: [], session }
    })
    s = run([trace("d-kitchen-01", "Kitchen", 1), trace("d-desk-0001", "Desk", 1), trace("d-kitchen-01", "Kitchen", 2)], s)
    expect(s.traces.map((t) => [t.session, t.turnId])).toEqual([["Kitchen", 1], ["Desk", 1], ["Kitchen", 2]])
    // A trace makes no chat turn and no unread dot (admin has no chat).
    expect(s.ui.unread).toBe(0)
    // The example message decodes into the same shape the reducer takes.
    expect(run([serverExamples.trace], s).traces.at(-1)?.session).toBe(serverExamples.trace.trace.session)
  })

  it("talking sessions are the ones whose device has the audio", () => {
    expect(talkingSessions(exampleAdminSnapshot.sessions).map((x) => x.key)).toEqual(exampleAdminSnapshot.sessions.filter((x) => x.ownerPresent).map((x) => x.key))
  })
})

describe("words", () => {
  it("sessions_full in plain words, with the count from the server's message", () => {
    expect(sessionsFullText("The assistant is already talking on 4 devices.")).toBe("The assistant is already talking on 4 devices. Try again when one of them is done.")
    expect(sessionsFullText("The assistant is already talking on 1 device")).toBe("The assistant is already talking on another device. Try again when it is done.")
    expect(sessionsFullText("Too many sessions")).toMatch(/^The assistant is already talking on other devices\./)
    expect(sessionsFullText(undefined)).toMatch(/on other devices/)
  })

  it("turns and times", () => {
    expect(turnsText(0)).toBe("no turns yet")
    expect(turnsText(1)).toBe("1 turn")
    expect(turnsText(3)).toBe("3 turns")
    const now = 10 * 86_400_000
    expect(agoText(now - 10_000, now)).toBe("just now")
    expect(agoText(now - 5 * 60_000, now)).toBe("5 min ago")
    expect(agoText(now - 2 * 3_600_000, now)).toBe("2 h ago")
    expect(agoText(now - 3 * 86_400_000, now)).toBe("3 d ago")
  })
})
