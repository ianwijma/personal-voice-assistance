import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientMessage } from "@pva/protocol"
import { exampleDeviceSetup, serverExamples } from "@pva/protocol/examples"
import { createAssistantClient } from "../src/lib/client.ts"
import type { ResultMessage } from "../src/lib/connection.ts"
import { installFakeAudio } from "./fakeAudio.ts"

/** The voice page's assistant-aware requests (protocol 7): who typed text goes to, new conversation, pick, read. */

beforeEach(() => {
  installFakeAudio()
})

const ok = (requestId = "r1"): ResultMessage => ({ type: "result", requestId, ok: true })
const refused: ResultMessage = { type: "result", requestId: "r1", ok: false, error: { code: "not_allowed", message: "no" } }

/** A client whose connection records what it is asked to send; `answer` is what every request gets back. */
const client = (answer: ResultMessage = ok()) => {
  const c = createAssistantClient()
  const requests: Array<ClientMessage> = []
  const sent: Array<ClientMessage> = []
  vi.spyOn(c.connection, "request").mockImplementation(async (m) => {
    requests.push(m as ClientMessage)
    return answer
  })
  vi.spyOn(c.connection, "send").mockImplementation((m) => {
    sent.push(m as ClientMessage)
    return true
  })
  return { c, requests, sent }
}

describe("typed text goes to the assistant whose conversation the chat shows", () => {
  it("sendText names the assistant when given one, and leaves the field out otherwise", async () => {
    const { c, requests } = client()
    await c.sendText("hello", "t3")
    await c.sendText("hello again")
    expect(requests[0]).toMatchObject({ type: "text.send", text: "hello", assistantId: "t3" })
    expect(requests[1]).toMatchObject({ type: "text.send", text: "hello again" })
    expect("assistantId" in requests[1]!).toBe(false)
  })

  it("newConversation names the assistant when given one, and leaves the field out otherwise", async () => {
    const { c, requests } = client()
    await c.newConversation("t3")
    await c.newConversation()
    expect(requests[0]).toEqual({ type: "conversation.new", assistantId: "t3" })
    expect(requests[1]).toEqual({ type: "conversation.new" })
  })

  it("readConversation sends a conversation.read for that assistant, with a fresh request id each time", async () => {
    const { c, sent } = client()
    c.readConversation("t3")
    await new Promise((r) => setTimeout(r, 2))
    c.readConversation("jeff")
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: "conversation.read", assistantId: "t3" })
    expect(sent[1]).toMatchObject({ type: "conversation.read", assistantId: "jeff" })
    const ids = sent.map((m) => (m as { requestId: string }).requestId)
    expect(ids[0]).toMatch(/^read-t3-/)
    expect(ids[1]).toMatch(/^read-jeff-/)
    expect(new Set(ids).size).toBe(2)
  })
})

describe("pickAssistant (device.pick)", () => {
  const withTurnHeld = (c: ReturnType<typeof createAssistantClient>) => {
    c.store.dispatch({ ...serverExamples.welcome })
    c.store.dispatch({ type: "device.setup", ...exampleDeviceSetup })
    c.store.dispatch({ type: "wake", phrase: "hey t3", armed: true, assistantId: "t3" })
    expect(c.store.get().holder).toBe("t3")
  }

  it("sends the pick as given: an assistant id, \"typesafe\" or nobody (\"\")", async () => {
    const { c, requests } = client()
    for (const pick of ["t3", "typesafe", ""]) await c.pickAssistant(pick)
    expect(requests).toEqual([
      { type: "device.pick", withoutPhrase: "t3" },
      { type: "device.pick", withoutPhrase: "typesafe" },
      { type: "device.pick", withoutPhrase: "" }
    ])
  })

  it("an accepted pick clears who has the turn and the 'Listening…' state, and returns the result", async () => {
    const { c } = client(ok())
    withTurnHeld(c)
    const result = await c.pickAssistant("jeff")
    expect(result.ok).toBe(true)
    expect(c.store.get().holder).toBeUndefined()
    expect(c.store.get().woke).toBeUndefined()
  })

  it("a refused pick changes nothing and returns the refusal", async () => {
    const { c } = client(refused)
    withTurnHeld(c)
    const result = await c.pickAssistant("jeff")
    expect(result.ok).toBe(false)
    expect(c.store.get().holder).toBe("t3")
    expect(c.store.get().woke).toMatchObject({ assistantId: "t3" })
  })
})
