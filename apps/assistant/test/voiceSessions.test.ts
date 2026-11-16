// VoiceSessions without sessions: the conversation ids reserved per device and assistant stay bounded.
import { MAX_ASSIGNMENTS } from "@pva/protocol"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeVoiceSessions } from "../src/serve/VoiceSessions.ts"

const noSessions = () =>
  makeVoiceSessions({
    make: () => Effect.die("no session is opened in these tests"),
    max: () => 4,
    discardMs: () => 60_000,
    runSync: (effect) => Effect.runSync(effect),
    run: (effect) => void Effect.runFork(effect),
    onChange: () => {},
    onDiscard: () => {},
    announce: () => {}
  })

describe("reserved conversation ids", () => {
  it("a device keeps one per assistant it has (its list and the device's own), forgetting the least recently used past that", () => {
    const sessions = noSessions()
    const kept = MAX_ASSIGNMENTS + 1
    const ids = new Map<string, string>()
    for (let i = 0; i < kept + 20; i++) ids.set(`a${i}`, sessions.conversation("device", `a${i}`).id)
    // The most recent ones are still there; reading them keeps them recent.
    for (let i = 20; i < kept + 20; i++) expect(sessions.conversation("device", `a${i}`).id).toBe(ids.get(`a${i}`))
    // The oldest was forgotten: it gets a new id now.
    expect(sessions.conversation("device", "a0").id).not.toBe(ids.get("a0"))
  })

  it("conversation.new without a session counts towards the same bound", () => {
    const sessions = noSessions()
    const kept = MAX_ASSIGNMENTS + 1
    const first = sessions.conversation("device", "first").id
    for (let i = 0; i < kept; i++) Effect.runSync(sessions.newConversation("device", `n${i}`))
    expect(sessions.conversation("device", "first").id).not.toBe(first)
    // Another device's reservations are its own.
    const other = sessions.conversation("other", "first").id
    for (let i = 0; i < kept - 1; i++) Effect.runSync(sessions.newConversation("device", `m${i}`))
    expect(sessions.conversation("other", "first").id).toBe(other)
  })
})
