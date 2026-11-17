import { describe, expect, it } from "vitest"
import { exampleAssistantInfo, exampleWeatherModule } from "@pva/protocol/examples"
import type { AssistantInfo, TraceInfo } from "@pva/protocol"
import { changedSince, chosenBy, factsOf, type LatencyContext, median } from "@/components/settings/latency.tsx"

const assistant: AssistantInfo = {
  ...exampleAssistantInfo,
  id: "jeff",
  name: "Jeff",
  llm: { ...exampleAssistantInfo.llm, account: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 },
  voice: { provider: "sherpa", voiceId: "en_US-lessac-medium" },
  modules: { clock: { on: true, offTools: [] } },
  replyEarly: true,
  toolRounds: 5
}
const ctx = (a: AssistantInfo = assistant, hearer: string | null = "jeff"): LatencyContext => ({
  assistants: [a],
  devices: [{ id: "d1", name: "Kitchen iPad", hearer }],
  modules: [{ ...exampleWeatherModule, id: "clock", name: "Clock", tools: [] }],
  hearingName: (p) => p,
  voiceName: () => undefined
})
const config = {
  llm: { account: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 },
  hearing: { hearer: "jeff", engine: "sherpa", model: assistant.hearing.model, language: assistant.hearing.language, eagerSilenceMs: assistant.hearing.eagerSilenceMs, finalSilenceMs: assistant.hearing.finalSilenceMs },
  voice: "sherpa:en_US-lessac-medium",
  modules: 1,
  tools: 0,
  replyEarly: true,
  toolRounds: 5
}
const trace = (extra: Partial<TraceInfo> = {}): TraceInfo => ({
  turnId: 1, mode: "voice", speculative: false, outcome: "completed", marks: {}, tools: [], voices: [], assistant: { id: "jeff", name: "Jeff" }, deviceId: "d1", device: "Kitchen iPad", config, ...extra
})

const noConfig = (): TraceInfo => {
  const { config: _config, ...rest } = trace()
  return rest
}

describe("latency page", () => {
  it("the median of an even count is the mean of the middle two", () => {
    expect(median([])).toBeUndefined()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })

  it("chosenBy words every route kind, and TypeSafe's outcome with where the turn went", () => {
    expect(chosenBy(trace())).toBe("Not recorded")
    expect(chosenBy(trace({ route: { by: "phrase", phrase: "hey jeff" } }))).toBe("“hey jeff”")
    expect(chosenBy(trace({ route: { by: "armed", phrase: "hey jeff" } }))).toBe("“hey jeff”, then what was said next")
    expect(chosenBy(trace({ route: { by: "follow-up" } }))).toBe("Follow-up")
    expect(chosenBy(trace({ route: { by: "default" } }))).toBe("Answers without a phrase")
    expect(chosenBy(trace({ route: { by: "typed" } }))).toBe("Typed text")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "chosen", probability: 0.91, fits: 0.97, ms: 138, fallback: false } }))).toBe("TypeSafe · 91% · 138 ms")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "chosen", fits: 0.8, ms: 120, fallback: false } }))).toBe("TypeSafe · fits 80% · 120 ms")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "none-fits", probability: 0.22, fits: 0.1, ms: 141, fallback: true } }))).toBe("TypeSafe · none fits (22%) · 141 ms → Jeff")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "timeout", ms: 400, fallback: true } }))).toBe("TypeSafe · no answer in time · 400 ms → Jeff")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "error", ms: 212, fallback: false } }))).toBe("TypeSafe · did not answer · 212 ms")
  })

  it("a turn without a snapshot says so and shows no change; with one it shows the facts", () => {
    expect(factsOf(noConfig(), ctx())).toEqual([["Configuration", "not recorded"], ["Chosen by", "Not recorded"]])
    expect(changedSince(noConfig(), ctx())).toEqual([])
    const facts = Object.fromEntries(factsOf(trace({ route: { by: "default" } }), ctx()))
    expect(facts["Language model"]).toBe("Anthropic API · claude-haiku-5-5 · effort low")
    expect(facts.Voice).toBe("Lessac · on this machine")
    expect(facts.Modules).toBe("1 module · 0 tools")
  })

  it("changed since: nothing for an equal snapshot; each difference named; the hearer now; an assistant that is gone", () => {
    expect(changedSince(trace(), ctx())).toEqual([])
    const now: AssistantInfo = { ...assistant, llm: { ...assistant.llm, model: "claude-opus-5-5" }, voice: { provider: "sherpa", voiceId: "kokoro-af_heart" }, replyEarly: false }
    expect(changedSince(trace(), ctx(now))).toEqual(["model claude-haiku-5-5 → claude-opus-5-5", "voice Lessac → Heart", "reply early on → off"])
    const slower: AssistantInfo = { ...assistant, hearing: { ...assistant.hearing, finalSilenceMs: assistant.hearing.finalSilenceMs + 200 } }
    expect(changedSince(trace(), ctx(slower))).toEqual([`end pause ${assistant.hearing.finalSilenceMs} → ${assistant.hearing.finalSilenceMs + 200}`])
    // The device now hears with another assistant.
    const other: AssistantInfo = { ...assistant, id: "keuken", name: "Keuken" }
    expect(changedSince(trace(), { ...ctx(), assistants: [assistant, other], devices: [{ id: "d1", name: "Kitchen iPad", hearer: "keuken" }] })).toEqual(["hearing Jeff's → Keuken's"])
    expect(changedSince(trace({ assistant: { id: "gone", name: "Gone" } }), ctx())).toEqual([])
  })
})
