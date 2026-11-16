import { describe, expect, it } from "vitest"
import type { DeviceSetup, ServerMessage } from "@pva/protocol"
import { exampleConversation, exampleDeviceSetup, serverExamples } from "@pva/protocol/examples"
import { type Action, type ClientState, initialState, profileOf, reducer } from "@/lib/state.ts"
import { stageOverlays } from "@/ui/voiceRegistry.ts"
import {
  answeringId,
  defaultAssistantId,
  exchangesOf,
  holderOf,
  nameOf,
  newConversationToast,
  needsRead,
  ownerKey,
  phrased,
  stripAssistantId,
  turnsOf
} from "@/lib/voiceSetup.ts"

/** Edges of the voice page's setup helpers that voiceSetup.test.ts does not reach. */

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)

const assistant = (id: string, phrases: ReadonlyArray<string> = []) => ({ id, name: id.toUpperCase(), purpose: "", on: true, phrases: [...phrases] })
const setup = (assistants: DeviceSetup["assistants"], withoutPhrase: DeviceSetup["withoutPhrase"]): DeviceSetup => ({ ...exampleDeviceSetup, assistants, withoutPhrase })
const conversationOf = (assistantId: string) => ({ assistantId, id: exampleConversation.id, startedAt: exampleConversation.startedAt, turns: 2 })
/** A welcome for this setup. By default the server lists only the answering assistant's conversation (the one `history` belongs to). */
const welcomeWith = (s: DeviceSetup): ServerMessage => {
  const answering = answeringId({ ...initialState, setup: s })
  const conversations = answering === undefined ? [] : [conversationOf(answering)]
  return { ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, setup: s, conversations } }
}
const setupMessage = (s: DeviceSetup): ServerMessage => ({ type: "device.setup", ...s })

const two = setup([assistant("jeff"), assistant("t3", ["hey t3"])], { mode: "assistant", assistant: "jeff" })
const three = setup([assistant("jeff"), assistant("t3", ["hey t3"]), assistant("k", ["hé k"])], { mode: "assistant", assistant: "jeff" })

describe("who answers without a phrase", () => {
  it("only a named assistant that is on the device counts", () => {
    expect(defaultAssistantId(two)).toBe("jeff")
    expect(defaultAssistantId(setup(two.assistants, { mode: "assistant", assistant: "gone" }))).toBeUndefined()
    expect(defaultAssistantId(setup(two.assistants, { mode: "nobody" }))).toBeUndefined()
    expect(defaultAssistantId(setup(two.assistants, { mode: "typesafe", fallback: "jeff" }))).toBeUndefined()
    expect(defaultAssistantId(undefined)).toBeUndefined()
  })

  it("phrased leaves out the one that answers without a phrase and those with no phrase on this device", () => {
    expect(phrased(three).map((a) => a.id)).toEqual(["t3", "k"])
    expect(phrased(setup(three.assistants, { mode: "nobody" })).map((a) => a.id)).toEqual(["t3", "k"])
    expect(phrased(setup([assistant("jeff"), assistant("t3")], { mode: "nobody" }))).toEqual([])
  })

  it("an Auto fallback that left the device falls through to the first assistant", () => {
    const s = run([welcomeWith(setup(two.assistants, { mode: "typesafe", fallback: "gone" }))])
    expect(answeringId(s)).toBe("jeff")
    expect(answeringId(run([welcomeWith(setup(two.assistants, { mode: "typesafe", fallback: null }))]))).toBe("jeff")
  })

  it("nobody is answering before the setup arrives, and with no assistants", () => {
    expect(answeringId(initialState)).toBeUndefined()
    expect(answeringId(run([welcomeWith(setup([], { mode: "nobody" }))]))).toBeUndefined()
  })
})

describe("names and keys", () => {
  it("nameOf falls back to the plain word before the setup or for an assistant that left", () => {
    expect(nameOf(initialState, "jeff")).toBe("Assistant")
    const s = run([welcomeWith(two)])
    expect(nameOf(s, "t3")).toBe("T3")
    expect(nameOf(s, "gone")).toBe("Assistant")
    expect(nameOf(s, undefined)).toBe("Assistant")
  })

  it("ownerKey takes the message's assistant, else the answering one, else the empty key", () => {
    const s = run([welcomeWith(two)])
    expect(ownerKey(s, "t3")).toBe("t3")
    expect(ownerKey(s, undefined)).toBe("jeff")
    expect(ownerKey(initialState, undefined)).toBe("")
  })

  it("a holder that is not on the device is no holder", () => {
    const s = run([welcomeWith(two), { type: "state", state: "listening" }, { type: "turn.start", turnId: 1, source: "voice", userText: "x", spoken: true, assistantId: "gone" }])
    expect(s.holder).toBe("gone")
    expect(holderOf(s)).toBeUndefined()
    expect(answeringId(s)).toBe("jeff")
  })
})

describe("the strip and the woke state", () => {
  it("a wake (armed) names its assistant in the strip even before a turn; the answering one is not named", () => {
    const base = run([welcomeWith(two), { type: "state", state: "listening" }])
    expect(stripAssistantId(run([{ type: "wake", phrase: "hey t3", armed: true, assistantId: "t3" }], base))).toBe("t3")
    expect(stripAssistantId(run([{ type: "wake", phrase: "hey jeff", armed: true, assistantId: "jeff" }], base))).toBeUndefined()
  })

  it("a wake with no assistant keeps the holder it had and records no assistant on woke", () => {
    const held = run([welcomeWith(two), { type: "state", state: "listening" }, { type: "turn.start", turnId: 1, source: "voice", userText: "x", spoken: true, assistantId: "t3" }])
    const s = run([{ type: "wake", phrase: "hey", armed: true }], held)
    expect(s.holder).toBe("t3")
    expect(s.woke).toEqual({ phrase: "hey" })
  })

  it("listening keeps the woke state; any other state drops it", () => {
    const woke = run([welcomeWith(two), { type: "wake", phrase: "hey t3", armed: true, assistantId: "t3" }])
    expect(run([{ type: "state", state: "listening" }], woke).woke).toBeDefined()
    expect(run([{ type: "state", state: "thinking" }], woke).woke).toBeUndefined()
  })

  it("the holder survives states other than asleep and idle", () => {
    const held = run([welcomeWith(two), { type: "turn.start", turnId: 1, source: "voice", userText: "x", spoken: true, assistantId: "t3" }])
    for (const state of ["listening", "thinking", "speaking"] as const) expect(run([{ type: "state", state }], held).holder).toBe("t3")
  })
})

describe("holder-clear", () => {
  it("returns the same state when there is nothing to clear", () => {
    const s = run([welcomeWith(two)])
    expect(reducer(s, { type: "local/holder-clear" })).toBe(s)
  })

  it("clears a woke state that has no holder behind it", () => {
    const s = { ...run([welcomeWith(two)]), woke: { phrase: "hey" } }
    expect(reducer(s, { type: "local/holder-clear" }).woke).toBeUndefined()
  })
})

describe("device.setup", () => {
  it("keeps the holder when the pick is the same and the holder is still on the device", () => {
    const held = run([welcomeWith(two), { type: "turn.start", turnId: 1, source: "voice", userText: "x", spoken: true, assistantId: "t3" }])
    expect(run([setupMessage({ ...two, canPick: !two.canPick })], held).holder).toBe("t3")
  })

  it("the first setup has no earlier pick: it counts as a change and leaves no holder", () => {
    const s = run([setupMessage(two)], { ...initialState, holder: "t3" })
    expect(s.holder).toBeUndefined()
    expect(s.setup?.assistants).toHaveLength(2)
  })

  it("a setup message does not carry its `type` into the stored setup", () => {
    expect("type" in (run([setupMessage(two)]).setup ?? {})).toBe(false)
  })

  it("changes the profile the page uses even when the server's device profile is unchanged", () => {
    const before = run([welcomeWith(two)])
    const after = run([setupMessage({ ...two, interruptMode: before.setup!.interruptMode === "manual" ? "instant" : "manual" })], before)
    expect(profileOf(after).interruptMode).not.toBe(profileOf(before).interruptMode)
  })
})

describe("welcome with only the answering assistant's conversation listed", () => {
  it("files the snapshot's history under the answering assistant, loaded, with the listed count", () => {
    const s = run([welcomeWith(two)])
    expect(Object.keys(s.conversations)).toEqual(["jeff"])
    expect(s.conversations.jeff).toMatchObject({ id: exampleConversation.id, loaded: true, turns: conversationOf("jeff").turns })
    expect(needsRead(s, "jeff")).toBe(false)
    expect(turnsOf(s, "jeff").every((t) => t.assistantId === "jeff")).toBe(true)
  })

  it("a reconnect that moves the answering assistant files the history under the new one", () => {
    let s = run([welcomeWith(two)])
    s = run([welcomeWith(setup(two.assistants, { mode: "assistant", assistant: "t3" }))], s)
    expect(Object.keys(s.conversations)).toEqual(["t3"])
    expect(turnsOf(s, "jeff")).toEqual([])
    expect(turnsOf(s, "t3").length).toBeGreaterThan(0)
  })
})

describe("conversation counts", () => {
  it("exchangesOf is 0 for a conversation the page has never heard of; needsRead is false for no assistant", () => {
    const s = run([welcomeWith(two)])
    expect(exchangesOf(s, "t3")).toBe(0)
    expect(needsRead(s, "t3")).toBe(true)
    expect(needsRead(s, undefined)).toBe(false)
  })

  it("a resumed message for a conversation not yet known creates it unloaded", () => {
    const s = run([welcomeWith(three), { type: "conversation", id: "c-k", reason: "resumed", startedAt: 5, assistantId: "k" }])
    expect(s.conversations.k).toEqual({ id: "c-k", startedAt: 5, turns: 0, loaded: false })
  })
})

describe("the toast after New conversation", () => {
  it("names the conversation and who keeps theirs", () => {
    const viewing = (s: DeviceSetup, id: string) => run([welcomeWith(s), { type: "local/ui", patch: { chatView: id } }])
    expect(newConversationToast(viewing(two, "t3"))).toBe("New conversation with T3. JEFF keeps its own.")
    expect(newConversationToast(viewing(three, "t3"))).toBe("New conversation with T3. JEFF and K keep their own.")
    expect(newConversationToast(run([welcomeWith(setup([assistant("jeff")], { mode: "nobody" }))]))).toBe("New conversation.")
    expect(newConversationToast(initialState)).toBe("New conversation.")
  })
})

describe("the 'asleep' hint on the stage", () => {
  const hint = stageOverlays.find((o) => o.id === "asleep-hint")!
  const asleepWith = (s: DeviceSetup): ClientState => {
    const base = run([welcomeWith(s), { type: "state", state: "asleep" }])
    return { ...base, audio: { ...base.audio, phase: "running" }, session: { ...base.session, role: "owner", ownerPresent: true } }
  }

  it("shows for an owner with audio running, asleep, and more than two phrases to choose from", () => {
    expect(hint.when(asleepWith(three))).toBe(false) // t3 and k only: two phrases
    const four = setup([...three.assistants, assistant("m", ["hey m"])], { mode: "assistant", assistant: "jeff" })
    expect(hint.when(asleepWith(four))).toBe(true)
  })

  it("is hidden after a wake phrase, when awake, or before the setup", () => {
    const four = setup([...three.assistants, assistant("m", ["hey m"])], { mode: "assistant", assistant: "jeff" })
    const s = asleepWith(four)
    expect(hint.when({ ...s, woke: { phrase: "hey t3" } })).toBe(false)
    expect(hint.when({ ...s, session: { ...s.session, serverState: "listening" } })).toBe(false)
    expect(hint.when({ ...s, setup: undefined })).toBe(false)
  })
})
