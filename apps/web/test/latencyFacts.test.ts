import { describe, expect, it } from "vitest"
import { exampleAdminSnapshot, exampleAssistantInfo, exampleWeatherModule, serverExamples } from "@pva/protocol/examples"
import type { AssistantInfo, ModuleInfo, ServerMessage, TraceConfig, TraceInfo } from "@pva/protocol"
import { prettyVoice } from "@/lib/assistants.ts"
import { type ClientState, initialState, MAX_TRACES, reducer } from "@/lib/state.ts"
import { changedSince, chosenBy, factsOf, type LatencyContext, LLM_KNOBS, ROUTE_FILTERS, TRACE_COLUMNS, voiceLabel } from "@/components/settings/latency.tsx"

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
    // A module that is no longer installed runs no more and contributes no tools.
    expect(changedSince(trace({ config: config({ tools: 0 }) }), ctx({ modules: [] }))).toEqual(["modules 1 → 0"])
  })

  it("counts the modules that run for the assistant, as the server records them", () => {
    const weather = (over: Partial<ModuleInfo>): ModuleInfo => ({ ...exampleWeatherModule, ...over })
    // Recorded while Weather was in error (the server counts no module and no tool); still in error: nothing changed.
    const failed = trace({ config: config({ modules: 0, tools: 0 }) })
    expect(changedSince(failed, ctx({ modules: [weather({ state: "error", tools: [] })] }))).toEqual([])
    // This assistant's own instance fails while the module as a whole runs: its tools do not count either.
    const ownFails = weather({ instances: [{ assistants: ["jeff"], own: ["units"], state: "error" }, { assistants: ["other"], own: [], state: "running" }] })
    expect(changedSince(failed, ctx({ modules: [ownFails] }))).toEqual([])
    // Its instance runs again: one module and its tool.
    const ownRuns = weather({ instances: [{ assistants: ["jeff"], own: ["units"], state: "running" }] })
    expect(changedSince(failed, ctx({ modules: [ownRuns] }))).toEqual(["modules 0 → 1", "tools 0 → 1"])
    // An agent or decision provider is not one of the assistant's modules.
    expect(changedSince(failed, ctx({ modules: [weather({ kind: "agent" })] }))).toEqual([])
    // The module runs, but only for another assistant: nothing runs for this one (the module's state is not its own).
    const othersOnly = weather({ state: "running", instances: [{ assistants: ["other"], own: [], state: "running" }] })
    expect(changedSince(failed, ctx({ modules: [othersOnly] }))).toEqual([])
  })

  it("does not compare tools while another instance of the module runs (its tools are not this assistant's)", () => {
    // Home Assistant for two assistants: Jeff on the shared settings, another with its own domains (no tools). The
    // module's tools are the union of both running instances, so neither assistant's own count is known.
    const ha = (instances: NonNullable<ModuleInfo["instances"]>): ModuleInfo => ({ ...exampleWeatherModule, id: "home-assistant", name: "Home Assistant", tools: [1, 2, 3, 4, 5].map((n) => ({ name: `ha_${n}`, description: "", speculative: false })), instances })
    const two = ha([{ assistants: ["jeff"], own: [], state: "running" }, { assistants: ["other"], own: ["domains"], state: "running" }])
    const other: AssistantInfo = { ...assistant, id: "other", name: "Other", modules: { "home-assistant": { on: true, offTools: [] } } }
    const otherTurn = trace({ assistant: { id: "other", name: "Other" }, config: config({ tools: 0 }) })
    // The reviewer's case: the other assistant's turn recorded no tools, and nothing changed for it.
    expect(changedSince(otherTurn, ctx({ assistants: [assistant, other], modules: [two] }))).toEqual([])
    // Nor for Jeff, whatever the union says.
    const jeff: AssistantInfo = { ...assistant, modules: { "home-assistant": { on: true, offTools: [] } } }
    expect(changedSince(trace({ config: config({ tools: 2 }) }), ctx({ assistants: [jeff, other], modules: [two] }))).toEqual([])
    // Switching the module off is this assistant's own change: no module and no tool.
    const jeffOff: AssistantInfo = { ...jeff, modules: { "home-assistant": { on: false, offTools: [] } } }
    expect(changedSince(trace({ config: config({ tools: 2 }) }), ctx({ assistants: [jeffOff, other], modules: [two] }))).toEqual(["modules 1 → 0", "tools 2 → 0"])
    // The other instance failing leaves one running: its tools are this assistant's again and are compared.
    const one = ha([{ assistants: ["jeff"], own: [], state: "running" }, { assistants: ["other"], own: ["domains"], state: "error" }])
    expect(changedSince(trace({ config: config({ tools: 2 }) }), ctx({ assistants: [jeff, other], modules: [one] }))).toEqual(["tools 2 → 5"])
    expect(changedSince(trace({ config: config({ tools: 5 }) }), ctx({ assistants: [jeff, other], modules: [one] }))).toEqual([])
  })

  it("compares only the language-model settings the account uses, as the server records them", () => {
    // An offline assistant saved with effort high, thinking adaptive and 2048 tokens: the server records its stand-in
    // (no model, low, off, 1024). Nothing changed after the turn, so nothing is reported.
    const offline = now({ llm: { ...assistant.llm, account: "offline", model: "", effort: "high", thinking: "adaptive", maxTokens: 2048 } })
    const offlineTurn = trace({ config: config({ llm: { account: "offline", model: "", effort: "low", thinking: "off", maxTokens: 1024 } }) })
    expect(changedSince(offlineTurn, ctx({ assistants: [offline] }))).toEqual([])
    // OpenRouter and the home model use the model and the longest reply, not effort or thinking.
    const or = (over: Partial<AssistantInfo["llm"]>) => now({ llm: { ...assistant.llm, account: "openrouter", model: "vendor/m", effort: "high", thinking: "adaptive", maxTokens: 2048, ...over } })
    const orTurn = trace({ config: config({ llm: { account: "openrouter", model: "vendor/m", effort: "low", thinking: "off", maxTokens: 2048 } }) })
    expect(changedSince(orTurn, ctx({ assistants: [or({})] }))).toEqual([])
    expect(changedSince(orTurn, ctx({ assistants: [or({ model: "vendor/n", maxTokens: 512 })] }))).toEqual(["model vendor/m → vendor/n", "longest reply 2048 → 512"])
    expect(LLM_KNOBS["home-model"]).toEqual(LLM_KNOBS.openrouter)
    // A Claude subscription assistant without a model answers with the first Claude model (as the server records it).
    const sub = { account: "claude-subscription", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 } as const
    const blank = now({ llm: { ...assistant.llm, ...sub, model: "", useModules: true } })
    expect(changedSince(trace({ config: config({ llm: sub }) }), ctx({ assistants: [blank] }))).toEqual([])
    // An account that uses them still reports changed ones; a changed account names only the settings both use.
    const anthropic = now({ llm: { ...assistant.llm, effort: "high" } })
    expect(changedSince(trace(), ctx({ assistants: [anthropic] }))).toEqual(["effort low → high"])
    expect(changedSince(offlineTurn, ctx({ assistants: [anthropic] }))).toEqual(["account Offline stand-in → Anthropic API"])
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

describe("latency page: trace ids", () => {
  const loggedIn = { ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, admin: { enabled: true, loggedIn: true } } }
  const run = (actions: ReadonlyArray<ServerMessage>, from: ClientState = initialState) => actions.reduce((s, m) => reducer(s, m), from)
  const traceMsg = (turnId: number, deviceId = "d1"): ServerMessage => ({ type: "trace", key: deviceId, trace: trace({ turnId, deviceId }) })
  const ids = (s: ClientState) => new Map(s.traces.map((t, i) => [t, s.traceIds[i]]))

  it("gives each trace its own id when it arrives, which a newer trace does not change", () => {
    let s = run([loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, traces: [trace({ turnId: 7 })] } }])
    s = run([traceMsg(1), traceMsg(1, "d2")], s)
    expect(s.traceIds.length).toBe(s.traces.length)
    expect(new Set(s.traceIds).size).toBe(3)
    const before = ids(s)
    s = run([traceMsg(2, "d3")], s)
    for (const [t, id] of before) expect(ids(s).get(t)).toBe(id)
  })

  it("keeps the ids when the oldest traces are dropped, also for a turn number that came back", () => {
    let s = run([loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, traces: [] } }])
    // The device's session started over: turn 1 twice, from the same device and assistant.
    s = run([traceMsg(1), traceMsg(1)], s)
    const second = s.traces[1]!
    const secondId = s.traceIds[1]
    s = run(Array.from({ length: MAX_TRACES - 1 }, (_, i) => traceMsg(100 + i, "d9")), s)
    // The first turn 1 was dropped; the second keeps its id (so its open row stays open and no other row opens).
    expect(s.traces.length).toBe(MAX_TRACES)
    expect(s.traces[0]).toBe(second)
    expect(s.traceIds[0]).toBe(secondId)
    expect(new Set(s.traceIds).size).toBe(MAX_TRACES)
  })

  it("never gives an id twice, also after a new snapshot or a logout", () => {
    let s = run([loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, traces: [trace({ turnId: 1 })] } }, traceMsg(2)])
    const seen = [...s.traceIds]
    s = run([loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, traces: [trace({ turnId: 1 })] } }], s)
    s = run([{ type: "admin.state", admin: { enabled: true, loggedIn: false } }, loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, traces: [trace({ turnId: 1 })] } }], s)
    expect(s.traceIds.some((id) => seen.includes(id))).toBe(false)
  })
})
