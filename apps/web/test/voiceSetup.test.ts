import { describe, expect, it } from "vitest"
import type { DeviceSetup, ServerMessage } from "@pva/protocol"
import { exampleDeviceSetup, serverExamples } from "@pva/protocol/examples"
import { type Action, type ClientState, displayPhrase, initialState, profileOf, reducer } from "@/lib/state.ts"
import {
  answeringId,
  asleepText,
  conversationNote,
  exchangesOf,
  holderOf,
  needsRead,
  newConversationTip,
  reachText,
  stripAssistantId,
  topBarName,
  turnsOf,
  viewedId
} from "@/lib/voiceSetup.ts"

/** The voice page's view of its device (docs/ASSISTANTS.md §5.3, §7.2): setup, who has the turn, a conversation per assistant. */

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)

const setup = (patch: Partial<DeviceSetup> = {}): DeviceSetup => ({
  ...exampleDeviceSetup,
  assistants: [
    { id: "jeff", name: "Jeff", purpose: "Everyday questions.", on: true, phrases: [] },
    { id: "t3", name: "T3", purpose: "Coding work.", on: true, phrases: ["Hey T3", "Hey tee three"] }
  ],
  withoutPhrase: { mode: "assistant", assistant: "jeff" },
  canPick: true,
  canAuto: false,
  ...patch
})

const welcomeWith = (s: DeviceSetup, extra: Partial<typeof serverExamples.welcome.snapshot> = {}): ServerMessage => ({
  ...serverExamples.welcome,
  snapshot: {
    ...serverExamples.welcome.snapshot,
    setup: s,
    conversations: s.assistants.map((a, i) => ({ assistantId: a.id, id: `conv-${a.id}`, startedAt: 1_763_100_000_000 + i, turns: i === 0 ? 2 : 3 })),
    ...extra
  }
})
const setupMessage = (s: DeviceSetup): ServerMessage => ({ type: "device.setup", ...s })
const turnStart = (turnId: number, assistantId: string | undefined, userText = "Hello"): ServerMessage => ({
  type: "turn.start",
  turnId,
  source: "voice",
  userText,
  spoken: true,
  ...(assistantId === undefined ? {} : { assistantId })
})
const turnEnd = (turnId: number): ServerMessage => ({
  type: "turn.end",
  turnId,
  outcome: "completed",
  trace: { turnId, mode: "voice", speculative: false, outcome: "completed", marks: {}, tools: [], voices: [] }
})
const history = (id: string, ...texts: Array<string>): ServerMessage => ({
  type: "conversation.history",
  requestId: "r1",
  assistantId: id,
  id: `conv-${id}`,
  history: texts.flatMap((t) => [{ role: "user" as const, text: t }, { role: "assistant" as const, text: `re: ${t}`, interrupted: false, tools: [] }])
})
const conversation = (assistantId: string | undefined, reason: "new" | "idle" | "resumed" = "new", id = `conv-${assistantId}-${reason}`): ServerMessage => ({
  type: "conversation",
  id,
  reason,
  startedAt: 1_763_100_600_000,
  ...(assistantId === undefined ? {} : { assistantId })
})

describe("the setup", () => {
  it("welcome and device.setup set it; who answers without a phrase is the answering assistant", () => {
    let s = run([welcomeWith(setup())])
    expect(s.setup?.assistants.map((a) => a.id)).toEqual(["jeff", "t3"])
    expect(answeringId(s)).toBe("jeff")
    expect(topBarName(s)).toBe("Jeff")
    s = run([setupMessage(setup({ withoutPhrase: { mode: "assistant", assistant: "t3" } }))], s)
    expect(answeringId(s)).toBe("t3")
    expect(topBarName(s)).toBe("T3")
  })

  it("Auto is named Auto; with nobody the names are listed; with one assistant its name, whatever the mode", () => {
    expect(topBarName(run([welcomeWith(setup({ withoutPhrase: { mode: "typesafe", fallback: "jeff" }, canAuto: true }))]))).toBe("Auto")
    expect(topBarName(run([welcomeWith(setup({ withoutPhrase: { mode: "nobody" } }))]))).toBe("Jeff · T3")
    const three = setup({
      assistants: [...setup().assistants, { id: "keuken", name: "Keuken", purpose: "", on: true, phrases: ["hé keuken"] }],
      withoutPhrase: { mode: "nobody" }
    })
    expect(topBarName(run([welcomeWith(three)]))).toBe("3 assistants")
    const one = setup({ assistants: [setup().assistants[0]!], withoutPhrase: { mode: "nobody" }, canPick: false })
    expect(topBarName(run([welcomeWith(one)]))).toBe("Jeff")
    expect(topBarName(run([welcomeWith(setup({ assistants: [] }))]))).toBe("No assistant on this device")
  })

  it("the answering assistant of Auto is its fallback, and with nobody the first", () => {
    expect(answeringId(run([welcomeWith(setup({ withoutPhrase: { mode: "typesafe", fallback: "t3" } }))]))).toBe("t3")
    expect(answeringId(run([welcomeWith(setup({ withoutPhrase: { mode: "nobody" } }))]))).toBe("jeff")
  })

  it("the profile the page uses (microphone processing, interrupting, captions) comes from the setup", () => {
    const base = setup()
    const s = run([welcomeWith({ ...base, interruptMode: "manual", captions: { captions: false, speakTyped: true }, audio: { ...base.audio, echoCancellation: false, prebufferMs: 120 } })])
    expect(profileOf(s)).toMatchObject({ interruptMode: "manual", captions: false, speakReplies: true, echoCancellation: false, prebufferMs: 120 })
    // The same object while nothing it is made of changed.
    expect(profileOf(s)).toBe(profileOf({ ...s, turns: [] }))
  })
})

describe("who has the turn", () => {
  const base = () => run([welcomeWith(setup()), { type: "state", state: "listening" }])

  it("a turn names its assistant; the strip names it unless it is the one that answers anyway", () => {
    let s = run([turnStart(1, "t3")], base())
    expect(holderOf(s)).toBe("t3")
    expect(stripAssistantId(s)).toBe("t3")
    expect(answeringId(s)).toBe("t3")
    s = run([turnEnd(1), turnStart(2, "jeff")], s)
    expect(holderOf(s)).toBe("jeff")
    expect(stripAssistantId(s)).toBeUndefined() // Jeff answers without a phrase
  })

  it("the phrase alone (wake, armed) gives the turn to its assistant; a wake with the request in it waits for the turn", () => {
    expect(holderOf(run([{ type: "wake", phrase: "hey t3", armed: false, assistantId: "t3" }], base()))).toBeUndefined()
    const s = run([{ type: "wake", phrase: "hey t3", armed: true, assistantId: "t3" }], base())
    expect(s.woke).toEqual({ phrase: "hey t3", assistantId: "t3" })
    expect(stripAssistantId(s)).toBe("t3")
  })

  it("asleep or idle: nobody has the turn; a changed pick, or an assistant that left, drops it", () => {
    let s = run([turnStart(1, "t3")], base())
    expect(holderOf(run([{ type: "state", state: "asleep" }], s))).toBeUndefined()
    expect(holderOf(run([{ type: "state", state: "idle" }], s))).toBeUndefined()
    expect(holderOf(run([setupMessage(setup({ withoutPhrase: { mode: "nobody" } }))], s))).toBeUndefined()
    // The same setup again changes nothing.
    expect(holderOf(run([setupMessage(setup())], s))).toBe("t3")
    s = run([setupMessage(setup({ assistants: [setup().assistants[0]!] }))], s)
    expect(holderOf(s)).toBeUndefined()
  })

  it("one assistant on the device: nothing to tell apart, no name next to the state", () => {
    const one = setup({ assistants: [setup().assistants[0]!], withoutPhrase: { mode: "nobody" }, canPick: false })
    const s = run([welcomeWith(one), turnStart(1, "jeff")])
    expect(stripAssistantId(s)).toBeUndefined()
  })
})

describe("words", () => {
  const s0 = run([welcomeWith(setup())])

  it("how each assistant is reached", () => {
    expect(reachText(s0, "jeff", true, displayPhrase)).toBe("Answers without a phrase")
    expect(reachText(s0, "t3", true, displayPhrase)).toBe("Say “Hey T3” or “Hey tee three”")
    const phrases3 = setup({ assistants: [{ id: "jeff", name: "Jeff", purpose: "", on: true, phrases: [] }, { id: "t3", name: "T3", purpose: "", on: true, phrases: ["a b", "c d", "e f"] }] })
    expect(reachText(run([welcomeWith(phrases3)]), "t3", true, displayPhrase)).toBe("Say “A B” +2")
    const none = setup({ assistants: [{ id: "jeff", name: "Jeff", purpose: "", on: true, phrases: [] }, { id: "t3", name: "T3", purpose: "", on: true, phrases: [] }], withoutPhrase: { mode: "nobody" } })
    expect(reachText(run([welcomeWith(none)]), "t3", true, displayPhrase)).toBe("No phrase on this device")
    const auto = run([welcomeWith(setup({ withoutPhrase: { mode: "typesafe", fallback: "jeff" } }))])
    expect(reachText(auto, "jeff", true, displayPhrase)).toBe("No phrase on this device · answers if none fits")
    expect(reachText(run([turnStart(1, "t3")], s0), "t3", true, displayPhrase)).toContain("answering now")
    expect(reachText(run([turnStart(1, "t3")], s0), "t3", false, displayPhrase)).not.toContain("answering now")
  })

  it("the asleep label names the phrases that fit, else says where they are", () => {
    const names = (a: ReadonlyArray<[string, ReadonlyArray<string>]>) =>
      setup({ assistants: a.map(([id, phrases]) => ({ id, name: id, purpose: "", on: true, phrases: [...phrases] })), withoutPhrase: { mode: "nobody" } })
    expect(asleepText(names([["jeff", []]]), displayPhrase)).toBe("Waiting for the wake phrase")
    expect(asleepText(names([["jeff", ["hey jeff"]]]), displayPhrase)).toBe("Say “Hey Jeff”")
    expect(asleepText(names([["jeff", ["hey jeff"]], ["t3", ["hey t3"]]]), displayPhrase)).toBe("Say “Hey Jeff” or “Hey T3”")
    expect(asleepText(names([["jeff", ["hey jeff"]], ["t3", ["hey t3"]], ["k", ["hé k"]]]), displayPhrase)).toBe("Say a wake phrase")
    expect(asleepText(undefined, displayPhrase)).toBe("Waiting for the wake phrase")
  })

  it("phrases that already have capitals are shown as they are", () => {
    expect(displayPhrase("hey jeff")).toBe("Hey Jeff")
    expect(displayPhrase("Hey tee three")).toBe("Hey tee three")
  })
})

describe("one conversation per assistant", () => {
  it("welcome files the snapshot's history under the answering assistant; the others are not loaded", () => {
    const s = run([welcomeWith(setup())])
    expect(Object.keys(s.conversations)).toEqual(["jeff", "t3"])
    expect(s.conversations.jeff).toMatchObject({ id: "conv-jeff", loaded: true })
    expect(s.conversations.t3).toMatchObject({ id: "conv-t3", loaded: false, turns: 3 })
    expect(turnsOf(s, "jeff").length).toBeGreaterThan(0)
    expect(turnsOf(s, "t3")).toEqual([])
    expect(needsRead(s, "t3")).toBe(true)
    expect(needsRead(s, "jeff")).toBe(false)
    expect(exchangesOf(s, "t3")).toBe(3) // the server's count, until the page holds the history
  })

  it("conversation.history files another assistant's conversation, and keeps the others' turns", () => {
    let s = run([welcomeWith(setup())])
    const jeffTurns = turnsOf(s, "jeff").length
    s = run([history("t3", "How is the thread?", "Merge it")], s)
    expect(turnsOf(s, "t3").map((t) => t.userText)).toEqual(["How is the thread?", "Merge it"])
    expect(turnsOf(s, "t3")[0]!.assistantId).toBe("t3")
    expect(turnsOf(s, "jeff")).toHaveLength(jeffTurns)
    expect(s.conversations.t3).toMatchObject({ loaded: true, id: "conv-t3" })
    expect(exchangesOf(s, "t3")).toBe(2)
    // Read again: replaced, not added.
    s = run([history("t3", "Only this")], s)
    expect(turnsOf(s, "t3").map((t) => t.userText)).toEqual(["Only this"])
  })

  it("a turn is filed under its assistant, not the one the chat shows; a running turn survives a read", () => {
    let s = run([welcomeWith(setup()), turnStart(7, "t3", "Start a thread")])
    expect(turnsOf(s, "t3").map((t) => t.userText)).toEqual(["Start a thread"])
    expect(turnsOf(s, "jeff").map((t) => t.userText)).not.toContain("Start a thread")
    s = run([history("t3", "Earlier")], s)
    expect(turnsOf(s, "t3").map((t) => t.userText)).toEqual(["Earlier", "Start a thread"])
    // Once it is committed the server's history has it: no twin.
    s = run([history("t3", "Earlier", "Start a thread")], s)
    expect(turnsOf(s, "t3").map((t) => t.userText)).toEqual(["Earlier", "Start a thread"])
  })

  it("a history that ends with the message a running turn is answering does not show it twice", () => {
    const open: ServerMessage = {
      type: "conversation.history",
      requestId: "r2",
      assistantId: "t3",
      id: "conv-t3",
      history: [{ role: "user", text: "Earlier" }, { role: "assistant", text: "ok", interrupted: false, tools: [] }, { role: "user", text: "Start a thread" }]
    }
    const s = run([welcomeWith(setup()), turnStart(7, "t3", "Start a thread"), open])
    expect(turnsOf(s, "t3").map((t) => t.userText)).toEqual(["Earlier", "Start a thread"])
    expect(turnsOf(s, "t3")[1]!.turnId).toBe(7)
    // The turn's end finds it and completes it.
    expect(turnsOf(run([turnEnd(7)], s), "t3")[1]!.outcome).toBe("completed")
  })

  it("a pick accepted on this page clears who has the turn", () => {
    const s = run([welcomeWith(setup()), turnStart(1, "t3"), { type: "wake", phrase: "hey t3", armed: true, assistantId: "t3" }])
    expect(holderOf(s)).toBe("t3")
    const cleared = run([{ type: "local/holder-clear" }], s)
    expect(holderOf(cleared)).toBeUndefined()
    expect(cleared.woke).toBeUndefined()
  })

  it("a new conversation of one assistant clears only its chat and gives it the divider", () => {
    let s = run([welcomeWith(setup()), history("t3", "Earlier"), turnStart(7, "t3"), turnEnd(7)])
    const jeffTurns = turnsOf(s, "jeff")
    s = run([conversation("t3", "new")], s)
    expect(turnsOf(s, "t3")).toEqual([])
    expect(turnsOf(s, "jeff")).toHaveLength(jeffTurns.length)
    expect(s.conversations.t3).toMatchObject({ id: "conv-t3-new", divider: "new", loaded: true, turns: 0 })
    expect(s.conversations.jeff!.divider).toBeUndefined()
    // Late messages about the replaced turn do not come back.
    s = run([{ type: "assistant.text", turnId: 7, clause: null, text: "late", assistantId: "t3" }], s)
    expect(turnsOf(s, "t3")).toEqual([])
    // Resumed only changes the id.
    const resumed = run([conversation("t3", "resumed", "conv-later")], s)
    expect(resumed.conversations.t3).toMatchObject({ id: "conv-later", divider: "new" })
    expect(resumed.turns).toBe(s.turns)
  })

  it("a conversation message without an assistant is the answering assistant's (an older server)", () => {
    const s = run([welcomeWith(setup()), conversation(undefined, "idle")])
    expect(turnsOf(s, "jeff")).toEqual([])
    expect(s.conversations.jeff!.divider).toBe("idle")
  })

  it("a reconnect keeps what the page holds of a conversation that is the same", () => {
    let s = run([welcomeWith(setup()), conversation("jeff", "new", "conv-jeff")])
    s = run([welcomeWith(setup())], s)
    expect(s.conversations.jeff!.divider).toBe("new")
  })
})

describe("what the chat shows", () => {
  const s0 = run([welcomeWith(setup())])

  it("the answering assistant's conversation, or the one picked in its header; opening or closing goes back", () => {
    expect(viewedId(s0)).toBe("jeff")
    let s = run([{ type: "local/ui", patch: { chatOpen: true } }, { type: "local/ui", patch: { chatView: "t3" } }], s0)
    expect(viewedId(s)).toBe("t3")
    expect(answeringId(s)).toBe("jeff") // reading changes nobody's turn
    s = run([{ type: "local/ui", patch: { chatOpen: false } }], s)
    expect(viewedId(s)).toBe("jeff")
    // A pick of an assistant that is not on the device is ignored.
    expect(viewedId(run([{ type: "local/ui", patch: { chatView: "keuken" } }], s0))).toBe("jeff")
  })

  it("the notes under the header and on New conversation say where things go", () => {
    const viewing = run([{ type: "local/ui", patch: { chatView: "t3" } }], s0)
    expect(conversationNote(s0, true)).toBe("Each assistant keeps its own conversation on this device.")
    expect(conversationNote(viewing, true)).toBe("Typed messages go to T3. Speaking still reaches Jeff.")
    expect(newConversationTip(viewing)).toBe("New conversation with T3 (Jeff keeps its own)")
    const nobody = run([welcomeWith(setup({ withoutPhrase: { mode: "nobody" } })), { type: "local/ui", patch: { chatView: "t3" } }])
    expect(conversationNote(nobody, true)).toBe("Typed messages go to T3. Speaking still reaches the one you wake.")
    const one = run([welcomeWith(setup({ assistants: [setup().assistants[0]!], canPick: false }))])
    expect(newConversationTip(one)).toBe("New conversation")
  })
})
