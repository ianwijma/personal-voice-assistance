import { assert, describe, it } from "@effect/vitest"
import { formatTrace, makeTurnTrace, type Trace, traceMarks } from "../src/TurnTrace.ts"

const base = () => {
  let t = 1000
  const tt = makeTurnTrace({ now: () => t })
  const trace = tt.begin("voice")
  return { tt, trace, at: (n: number) => (t = n) }
}

describe("formatTrace: the assistant and its route (docs/ASSISTANTS.md §3.7)", () => {
  it("names the assistant, and who chose it when the route is known", () => {
    const { trace: plain } = base()
    const trace: Trace = { ...plain, assistant: { id: "jarvis", name: "Jarvis" } }
    assert.strictEqual(formatTrace(trace), "turn #1 voice running assistant=jarvis")
    trace.route = { by: "default" }
    assert.strictEqual(formatTrace(trace), "turn #1 voice running assistant=jarvis(default)")
  })

  it("a phrase or armed route shows the phrase; other routes do not", () => {
    const { trace: plain } = base()
    const trace: Trace = { ...plain, assistant: { id: "jarvis", name: "Jarvis" } }
    trace.route = { by: "phrase", phrase: "hey jarvis" }
    assert.include(formatTrace(trace), `assistant=jarvis(phrase "hey jarvis")`)
    trace.route = { by: "armed", phrase: "hey jarvis" }
    assert.include(formatTrace(trace), `assistant=jarvis(armed "hey jarvis")`)
    trace.route = { by: "typesafe", outcome: "chosen", ms: 90, fallback: false }
    assert.include(formatTrace(trace), "assistant=jarvis(typesafe)")
    trace.route = { by: "follow-up" }
    assert.include(formatTrace(trace), "assistant=jarvis(follow-up)")
  })

  it("a route without an assistant prints nothing (the line is as before)", () => {
    const { trace } = base()
    trace.route = { by: "typed" }
    assert.strictEqual(formatTrace(trace), "turn #1 voice running")
  })

  it("the assistant comes after the session tag and before the agent", () => {
    const { trace: plain } = base()
    const trace: Trace = { ...plain, assistant: { id: "a", name: "A" } }
    trace.agent = { id: "ag", routedBy: "phrase" } as never
    const line = formatTrace(trace)
    assert.isTrue(line.startsWith("turn #1 voice running assistant=a agent=ag("), line)
    const withSession = formatTrace({ ...trace, session: "kitchen" })
    assert.isTrue(withSession.startsWith("[kitchen] turn #1"), withSession)
  })

  it("routeSent and routeReceived are trace marks, printed in order as deltas from endOfTurn", () => {
    const { tt, trace, at } = base()
    assert.include(traceMarks, "routeSent")
    assert.include(traceMarks, "routeReceived")
    assert.isTrue(traceMarks.indexOf("routeSent") < traceMarks.indexOf("routeReceived"))
    at(1100)
    tt.mark(trace, "endOfTurn")
    at(1110)
    tt.mark(trace, "routeSent")
    at(1200)
    tt.mark(trace, "routeReceived")
    const line = formatTrace(trace)
    assert.include(line, "routeSent=10ms routeReceived=100ms (+90ms)")
  })
})
