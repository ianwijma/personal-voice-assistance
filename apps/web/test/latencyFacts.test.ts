import { describe, expect, it } from "vitest"
import { exampleAssistantInfo, exampleWeatherModule } from "@pva/protocol/examples"
import type { AssistantInfo, TraceConfig, TraceInfo } from "@pva/protocol"
import { prettyVoice } from "@/lib/assistants.ts"
import { changedSince, chosenBy, factsOf, type LatencyContext, ROUTE_FILTERS, TRACE_COLUMNS, traceKeys, voiceLabel } from "@/components/settings/latency.tsx"

const assistant: AssistantInfo = {
  ...exampleAssistantInfo,
  id: "jeff",
  name: "Jeff",
  llm: { ...exampleAssistantInfo.llm, account: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 },
  hearing: { ...exampleAssistantInfo.hearing, engine: "sherpa", model: "small", language: "en", eagerSilenceMs: 300, finalSilenceMs: 800 },
  voice: { provider: "sherpa", voiceId: "en_US-lessac-medium" },
  modules: { weather: { on: true, offTools: [] } },
  replyEarly: true,
  toolRounds: 5
}
const ctx = (over: Partial<LatencyContext> = {}): LatencyContext => ({
  assistants: [assistant],
  devices: [{ id: "d1", name: "Kitchen iPad", hearer: "jeff" }],
  modules: [exampleWeatherModule],
  hearingName: (p) => `<${p}>`,
  voiceName: () => undefined,
  ...over
})
/** `undefined` removes a key (the snapshot did not record it). */
type Over<T> = { readonly [K in keyof T]?: T[K] | undefined }
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
const config = (over: Over<TraceConfig> = {}, hearing: Over<TraceConfig["hearing"]> = {}): TraceConfig => clean({
  llm: { account: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 },
  hearing: clean({ hearer: "jeff", engine: "sherpa", model: "small", language: "en", eagerSilenceMs: 300, finalSilenceMs: 800, ...hearing }),
  voice: "sherpa:en_US-lessac-medium",
  modules: 1,
  tools: 1,
  replyEarly: true,
  toolRounds: 5,
  ...over
}) as TraceConfig
const trace = (extra: Over<TraceInfo> = {}): TraceInfo => clean({
  turnId: 1, mode: "voice", speculative: false, outcome: "completed", marks: {}, tools: [], voices: [], assistant: { id: "jeff", name: "Jeff" }, deviceId: "d1", device: "Kitchen iPad", config: config(), ...extra
}) as TraceInfo
const facts = (t: TraceInfo, c: LatencyContext = ctx()) => Object.fromEntries(factsOf(t, c))

describe("latency page: voices and columns", () => {
  it("prettyVoice names a voice from its id: Kokoro's after the language, Piper's before the quality", () => {
    expect(prettyVoice("en_US-lessac-medium")).toBe("Lessac")
    expect(prettyVoice("kokoro-af_heart")).toBe("Heart")
    expect(prettyVoice("nl_NL-pim-medium")).toBe("Pim")
    // An id that follows no pattern is capitalised as it is.
    expect(prettyVoice("rachel")).toBe("Rachel")
  })

  it("voiceLabel prefers the catalog's name and falls back to the id's words, lower-cased", () => {
    expect(voiceLabel("sherpa:en_US-lessac-medium", ctx())).toBe("lessac")
    expect(voiceLabel("sherpa:en_US-lessac-medium", ctx({ voiceName: () => "Lessac (US)" }))).toBe("lessac (us)")
    // The catalog is asked with the parsed provider and voice id.
    const asked: Array<unknown> = []
    voiceLabel("elevenlabs:abc123", ctx({ voiceName: (v) => { asked.push(v); return undefined } }))
    expect(asked).toEqual([{ provider: "elevenlabs", voiceId: "abc123" }])
    // A key that is no voice key is shown as it is.
    expect(voiceLabel("Not A Key", ctx())).toBe("not a key")
  })

  it("every route filter but 'all' is a route kind chosenBy words; the table has a routing column", () => {
    expect(ROUTE_FILTERS[0]).toEqual({ value: "all", label: "All routes" })
    const kinds = ROUTE_FILTERS.slice(1).map((f) => f.value)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds).toEqual(["phrase", "armed", "follow-up", "default", "typed", "typesafe"])
    expect(TRACE_COLUMNS).toContain("routing")
    expect(TRACE_COLUMNS.indexOf("routing")).toBeLessThan(TRACE_COLUMNS.indexOf("1st token"))
  })

  it("chosenBy rounds TypeSafe's time, and the fallback is the fallback's name, or 'the fallback' without one", () => {
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "chosen", probability: 0.915, ms: 137.6, fallback: false } }))).toBe("TypeSafe · 92% · 138 ms")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "chosen", ms: 90, fallback: false } }))).toBe("TypeSafe · 90 ms")
    expect(chosenBy(trace({ assistant: undefined, route: { by: "typesafe", outcome: "none-fits", ms: 90, fallback: true } }))).toBe("TypeSafe · none fits · 90 ms → the fallback")
    expect(chosenBy(trace({ route: { by: "typesafe", outcome: "timeout", ms: 400, fallback: false } }))).toBe("TypeSafe · no answer in time · 400 ms")
  })
})

describe("latency page: facts of a turn", () => {
  it("words the language model, hearing, voice and counts of a turn", () => {
    const f = facts(trace({ route: { by: "phrase", phrase: "hey jeff" } }))
    expect(f["Language model"]).toBe("Anthropic API · claude-haiku-5-5 · effort low")
    expect(f.Hearing).toBe("<small> · English · end pause 800 ms")
    expect(f.Voice).toBe("Lessac · on this machine")
    expect(f.Modules).toBe("1 module · 1 tool")
    expect(f["Chosen by"]).toBe("“hey jeff”")
    expect(Object.keys(f)).toEqual(["Language model", "Hearing", "Voice", "Modules", "Chosen by"])
  })

  it("names the offline stand-in instead of its model, and an account the app does not know by its id", () => {
    expect(facts(trace({ config: config({ llm: { account: "offline", model: "echo", effort: "low", thinking: "off", maxTokens: 10 } }) }))["Language model"]).toBe("Offline stand-in · offline stand-in · effort low")
    expect(facts(trace({ config: config({ llm: { account: "mystery", model: "m1", effort: "high", thinking: "off", maxTokens: 10 } }) }))["Language model"]).toBe("mystery · m1 · effort high")
  })

  it("Deepgram is not a model preset; an unknown language code is shown as it is; no end pause leaves it out", () => {
    const f = facts(trace({ config: config({}, { engine: "deepgram", model: undefined, language: "sv", finalSilenceMs: undefined }) }))
    expect(f.Hearing).toBe("Deepgram · sv")
    expect(facts(trace({ config: config({}, { language: "auto" }) })).Hearing).toBe("<small> · Automatic · end pause 800 ms")
  })

  it("says whose hearing it was when the device hears with another assistant than the one that answered", () => {
    const other = config({}, { hearer: "keuken" })
    const keuken: AssistantInfo = { ...assistant, id: "keuken", name: "Keuken" }
    expect(facts(trace({ config: other }), ctx({ assistants: [assistant, keuken] })).Hearing).toBe("<small> · English · end pause 800 ms (Kitchen iPad hears with Keuken's)")
    // The hearing assistant is gone: its id stands in for its name; a turn without a device name says "this device".
    expect(facts(trace({ config: other, device: undefined })).Hearing).toBe("<small> · English · end pause 800 ms (this device hears with keuken's)")
  })

  it("shows a hosted voice with its provider, and an odd voice key as it is", () => {
    expect(facts(trace({ config: config({ voice: "elevenlabs:abc123" }) })).Voice).toBe("Abc123 · elevenlabs")
    expect(facts(trace({ config: config({ voice: "Not A Key" }) })).Voice).toBe("Not A Key")
    expect(facts(trace({ config: config({ voice: "sherpa:kokoro-af_heart" }) }), ctx({ voiceName: () => "Heart ♥" })).Voice).toBe("Heart ♥ · on this machine")
  })

  it("counts a single module and tool in the singular, none in the plural", () => {
    expect(facts(trace({ config: config({ modules: 0, tools: 0 }) })).Modules).toBe("0 modules · 0 tools")
    expect(facts(trace({ config: config({ modules: 2, tools: 1 }) })).Modules).toBe("2 modules · 1 tool")
  })
})

describe("latency page: what changed since a turn", () => {
  const now = (over: Partial<AssistantInfo>): AssistantInfo => ({ ...assistant, ...over })

  it("names a changed account, effort, thinking and reply length", () => {
    const a = now({ llm: { ...assistant.llm, account: "claude-subscription", useModules: true, effort: "high", thinking: "adaptive", maxTokens: 2048 } })
    expect(changedSince(trace(), ctx({ assistants: [a] }))).toEqual([
      "account Anthropic API → Claude subscription",
      "effort low → high",
      "thinking off → adaptive",
      "longest reply 1024 → 2048"
    ])
  })

  it("names changed tool rounds, and module and tool counts (a tool switched off counts)", () => {
    const off = now({ modules: { weather: { on: true, offTools: ["weather"] } }, toolRounds: 2 })
    expect(changedSince(trace(), ctx({ assistants: [off] }))).toEqual(["tools 1 → 0", "tool rounds 5 → 2"])
    const none = now({ modules: { weather: { on: false, offTools: [] } } })
    expect(changedSince(trace(), ctx({ assistants: [none] }))).toEqual(["modules 1 → 0", "tools 1 → 0"])
    // A module that is no longer installed contributes no tools.
    expect(changedSince(trace({ config: config({ tools: 0 }) }), ctx({ modules: [] }))).toEqual([])
  })

  it("counts no tools for a Claude subscription assistant that may not use its modules", () => {
    const sub = { account: "claude-subscription", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 } as const
    const gated = now({ llm: { ...assistant.llm, ...sub, useModules: false } })
    // The server recorded 0 tools (modules switched on, but the subscription may not use them): nothing changed.
    expect(changedSince(trace({ config: config({ llm: sub, tools: 0 }) }), ctx({ assistants: [gated] }))).toEqual([])
    // Let it use them again: its modules' tools count.
    const allowed = now({ llm: { ...assistant.llm, ...sub, useModules: true } })
    expect(changedSince(trace({ config: config({ llm: sub, tools: 0 }) }), ctx({ assistants: [allowed] }))).toEqual(["tools 0 → 1"])
    // The switch means nothing for another account.
    expect(changedSince(trace(), ctx({ assistants: [now({ llm: { ...assistant.llm, useModules: false } })] }))).toEqual([])
  })

  it("compares hearing engine, model, language and pauses when the same assistant still hears", () => {
    const h = now({ hearing: { ...assistant.hearing, model: "large", language: "nl", eagerSilenceMs: 200 } })
    expect(changedSince(trace(), ctx({ assistants: [h] }))).toEqual(["hearing model <small> → <large>", "hearing language en → nl", "early pause 300 → 200"])
    const dg = now({ hearing: { ...assistant.hearing, engine: "deepgram", deepgram: { ...assistant.hearing.deepgram, eotThreshold: 0.8 } } })
    expect(changedSince(trace(), ctx({ assistants: [dg] }))).toEqual(["hearing engine sherpa → deepgram"])
  })

  it("compares the end-of-turn threshold only for Deepgram, and skips what the snapshot did not record", () => {
    const dgNow = now({ hearing: { ...assistant.hearing, engine: "deepgram", deepgram: { ...assistant.hearing.deepgram, eotThreshold: 0.8 } } })
    const was = trace({ config: config({}, { engine: "deepgram", model: undefined, language: undefined, eagerSilenceMs: undefined, finalSilenceMs: undefined, eotThreshold: 0.6 }) })
    expect(changedSince(was, ctx({ assistants: [dgNow] }))).toEqual(["end-of-turn threshold 0.6 → 0.8"])
    // The snapshot has no eotThreshold: nothing to compare, nothing reported.
    const unrecorded = trace({ config: config({}, { engine: "deepgram", model: undefined, language: undefined, eagerSilenceMs: undefined, finalSilenceMs: undefined }) })
    expect(changedSince(unrecorded, ctx({ assistants: [dgNow] }))).toEqual([])
  })

  it("follows the assistant that hears on the device now, falling back to the snapshot's hearer without a device", () => {
    const keuken: AssistantInfo = { ...assistant, id: "keuken", name: "Keuken" }
    const moved = ctx({ assistants: [assistant, keuken], devices: [{ id: "d1", name: "Kitchen iPad", hearer: "keuken" }] })
    expect(changedSince(trace(), moved)).toEqual(["hearing Jeff's → Keuken's"])
    // The device is unknown now: the snapshot's own hearer is compared.
    expect(changedSince(trace({ deviceId: "gone" }), moved)).toEqual([])
    // A previous hearer that was removed is named by its id.
    expect(changedSince(trace({ config: config({}, { hearer: "removed" }) }), moved)).toEqual(["hearing removed's → Keuken's"])
    // Nobody hears on the device now (the device has no hearer, and the snapshot's hearer is gone): hearing is not compared.
    expect(changedSince(trace({ config: config({}, { hearer: "removed" }) }), ctx({ devices: [{ id: "d1", name: "Kitchen iPad", hearer: null }] }))).toEqual([])
  })

  it("names a changed voice with the catalog's names, once, and nothing for an equal voice", () => {
    const heart = now({ voice: { provider: "sherpa", voiceId: "kokoro-af_heart" } })
    expect(changedSince(trace(), ctx({ assistants: [heart], voiceName: ({ voiceId }) => (voiceId === "kokoro-af_heart" ? "Heart ♥" : undefined) }))).toEqual(["voice Lessac → Heart ♥"])
    expect(changedSince(trace(), ctx())).toEqual([])
  })

  it("reports nothing for a turn without an assistant", () => {
    expect(changedSince(trace({ assistant: undefined }), ctx({ assistants: [now({ replyEarly: false })] }))).toEqual([])
  })
})

describe("latency page: trace keys", () => {
  it("keeps a row's key when a newer trace arrives, and tells devices, assistants and repeated turn numbers apart", () => {
    const a = trace({ turnId: 1 })
    const b = trace({ turnId: 1, deviceId: "d2" })
    const c = trace({ turnId: 1, assistant: { id: "keuken", name: "Keuken" } })
    const before = traceKeys([a, b, c])
    expect(new Set(before).size).toBe(3)
    // Another device finishes a turn: the earlier rows keep their keys.
    expect(traceKeys([a, b, c, trace({ turnId: 2, deviceId: "d3" })]).slice(0, 3)).toEqual(before)
    // A device whose turn numbers started over: the same number again gets its own key, and the first keeps its own.
    const again = traceKeys([a, b, c, trace({ turnId: 1 })])
    expect(again.slice(0, 3)).toEqual(before)
    expect(new Set(again).size).toBe(4)
  })
})
