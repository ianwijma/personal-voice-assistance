// VoiceSessions without sessions: a device keeps a reserved conversation id only for the assistants assigned to it
// now, so its reservations never outnumber its assignments, and an assistant that stays assigned keeps its id.
import type { ConversationInfo } from "@pva/protocol"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { VoiceSession } from "../src/serve/VoiceSession.ts"
import { makeVoiceSessions } from "../src/serve/VoiceSessions.ts"

/** The sessions, and what the device's session was handed when `open` made it (its reservations). */
const noSessions = () => {
  const handed: { reserved: ReadonlyMap<string, ConversationInfo> | undefined } = { reserved: undefined }
  const announced: Array<{ readonly id: string; readonly assistant: string | undefined }> = []
  const sessions = makeVoiceSessions({
    make: (_key, _device, reserved) => {
      handed.reserved = reserved
      // `open` only starts it; nothing else of the session is used here.
      return Effect.succeed({ conversation: { start: () => {} } } as unknown as VoiceSession)
    },
    max: () => 4,
    discardMs: () => 60_000,
    runSync: (effect) => Effect.runSync(effect),
    run: (effect) => void Effect.runFork(effect),
    onChange: () => {},
    onDiscard: () => {},
    announce: (_key, info, assistant) => void announced.push({ id: info.id, assistant })
  })
  /** Opens the device's session and returns the reservations it took over (assistant → id). */
  const open = (key: string): Record<string, string> => {
    sessions.open(key, undefined)
    return Object.fromEntries([...(handed.reserved ?? new Map<string, ConversationInfo>())].map(([a, info]) => [a, info.id]))
  }
  return { sessions, announced, open }
}

describe("reserved conversation ids", () => {
  it("an assistant that stays assigned keeps its id while other assistants come and go (the review's churn)", () => {
    const { sessions, open } = noSessions()
    const others = ["b", "c", "d", "e", "f", "g", "h", "i", "j"]
    const a = sessions.conversation("device", "a", ["a", "b"]).id
    // `a` stays assigned; the second place goes to each of the others in turn, the previous one leaving.
    for (const other of others) sessions.conversation("device", other, ["a", other])
    expect(sessions.conversation("device", "a", ["a", "j"]).id).toBe(a)
    // The session takes over only the reservations of the two assistants assigned now, `a`'s unchanged.
    const taken = open("device")
    expect(Object.keys(taken).sort()).toEqual(["a", "j"])
    expect(taken.a).toBe(a)
  })

  it("an assistant taken off the device loses its reservation; put back on, it gets a new id", () => {
    const { sessions } = noSessions()
    const a = sessions.conversation("device", "a", ["a", "b"]).id
    const b = sessions.conversation("device", "b", ["a", "b"]).id
    expect(sessions.conversation("device", "b", ["a", "b"]).id).toBe(b)
    // `b` is removed from the device: the next read drops its reservation (`a` keeps its own).
    expect(sessions.conversation("device", "a", ["a"]).id).toBe(a)
    // Added again it is a new assignment, so it starts a new conversation: a new id, kept from then on.
    const bAgain = sessions.conversation("device", "b", ["a", "b"]).id
    expect(bAgain).not.toBe(b)
    expect(sessions.conversation("device", "b", ["a", "b"]).id).toBe(bAgain)
    expect(sessions.conversation("device", "a", ["a", "b"]).id).toBe(a)
  })

  it("a device never holds more reservations than it has assignments; an unassigned assistant's id is not kept", () => {
    const { sessions, open } = noSessions()
    // While the device has no assistant, its own reservation is `""`.
    const none = sessions.conversation("device", undefined, []).id
    expect(sessions.conversation("device", undefined, []).id).toBe(none)
    const assigned = ["a", "b", "c"]
    const ids = Object.fromEntries(assigned.map((x) => [x, sessions.conversation("device", x, assigned).id]))
    // Ids asked for 30 assistants that are not on the device are new each time and not kept.
    for (let i = 0; i < 30; i++) {
      const ghost = `ghost${i}`
      expect(sessions.conversation("device", ghost, assigned).id).not.toBe(sessions.conversation("device", ghost, assigned).id)
    }
    for (const x of assigned) expect(sessions.conversation("device", x, assigned).id).toBe(ids[x])
    expect(open("device")).toEqual(ids)
  })

  it("conversation.new without a session renews only the named assistant's id, drops unassigned ones, and says whose it is", () => {
    const { sessions, announced, open } = noSessions()
    const a = sessions.conversation("device", "a", ["a", "b", "old"]).id
    const b = sessions.conversation("device", "b", ["a", "b", "old"]).id
    sessions.conversation("device", "old", ["a", "b", "old"])
    const other = sessions.conversation("other", "a", ["a"]).id
    // `old` has left the device by the time `b` gets a new conversation.
    const bNew = Effect.runSync(sessions.newConversation("device", "b", ["a", "b"])).id
    expect(bNew).not.toBe(b)
    expect(announced).toEqual([{ id: bNew, assistant: "b" }])
    expect(sessions.conversation("device", "b", ["a", "b"]).id).toBe(bNew)
    expect(sessions.conversation("device", "a", ["a", "b"]).id).toBe(a)
    // Another device's reservations are its own.
    expect(sessions.conversation("other", "a", ["a"]).id).toBe(other)
    expect(open("device")).toEqual({ a, b: bNew })
  })
})

describe("P5 round 2: endDevice", () => {
  it("synchronously marks the session ended (its sends are fenced), removes it with its reservations, and stops it in the background", async () => {
    const fences: Array<() => boolean> = []
    let stopped = 0
    let discarded = 0
    const sessions = makeVoiceSessions({
      make: (_key, _device, _reserved, ended) => {
        fences.push(ended)
        return Effect.succeed({
          key: "device",
          conversation: { start: () => {}, end: Effect.sync(() => void stopped++) }
        } as unknown as VoiceSession)
      },
      max: () => 4,
      discardMs: () => 60_000,
      runSync: (effect) => Effect.runSync(effect),
      run: (effect) => void Effect.runFork(effect),
      onChange: () => {},
      onDiscard: () => void discarded++,
      announce: () => {}
    })
    const first = sessions.open("device", undefined)
    const reserved = sessions.conversation("other", "a", ["a"]).id
    expect(fences[0]!()).toBe(false)
    sessions.endDevice("device")
    // In the same step: fenced, gone, its ownership forgotten.
    expect(fences[0]!()).toBe(true)
    expect(sessions.get("device")).toBeUndefined()
    expect(discarded).toBe(1)
    // A new session of the same device is a new one, with its own fence.
    const second = sessions.open("device", undefined)
    expect(second).not.toBe(first)
    expect(fences[1]!()).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toBe(1)
    // A device without a session: its reservations go (its next id is new).
    sessions.endDevice("other")
    expect(sessions.conversation("other", "a", ["a"]).id).not.toBe(reserved)
  })
})
