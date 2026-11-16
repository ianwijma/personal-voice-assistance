// Protocol 7: every message of a turn that can create it on a page that joined mid-turn names the turn's assistant,
// so the page files the turn under its own assistant and never under whoever has the turn later (docs/ASSISTANTS.md §5.3).
import type { ServerMessage } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { makePublisher } from "../src/serve/Publisher.ts"

describe("the publisher tags a turn's messages with its assistant", () => {
  it("turn.start, tool.start and tool.end carry the assistantId of the conversation the turn comes from", () => {
    const sent: Array<ServerMessage> = []
    const publisher = makePublisher({ broadcast: (m) => sent.push(m), moduleOfTool: () => null, voice: () => "" })
    publisher.onEvent({ _tag: "TurnStarted", turnId: 4, source: "voice", text: "look it up", speculative: false, spoken: false }, "t3")
    publisher.onEvent({ _tag: "ToolStarted", turnId: 4, call: { id: "c1", name: "search", input: { q: "x" } } }, "t3")
    publisher.onEvent({ _tag: "ToolFinished", turnId: 4, result: { id: "c1", name: "search", content: "ok", isError: false }, ms: 5 }, "t3")
    const byType = (type: string) => sent.find((m) => m.type === type) as { assistantId?: string } | undefined
    expect(byType("turn.start")?.assistantId).toBe("t3")
    expect(byType("tool.start")?.assistantId).toBe("t3")
    expect(byType("tool.end")?.assistantId).toBe("t3")
  })

  it("a conversation without an assistant (an older single-conversation setup) tags nothing", () => {
    const sent: Array<ServerMessage> = []
    const publisher = makePublisher({ broadcast: (m) => sent.push(m), moduleOfTool: () => null, voice: () => "" })
    publisher.onEvent({ _tag: "TurnStarted", turnId: 1, source: "text", text: "hi", speculative: false, spoken: false })
    publisher.onEvent({ _tag: "ToolStarted", turnId: 1, call: { id: "c1", name: "search", input: null } })
    expect(sent.map((m) => "assistantId" in m)).toEqual([false, false])
  })
})
