import { describe, expect, it } from "vitest"
import { activeAgent, armAgent, initialRouterState, type RouteInput, type RouterState, setActiveAgent } from "../src/Routing.ts"
import { DEFAULT_AGENT_REF, defaultRoutingConfig, makeTriggerRouter, type RoutingConfig, wordMatchScore } from "../src/TriggerRouter.ts"
import { phoneticWord } from "../src/TextMatching.ts"

const config: RoutingConfig = {
  ...defaultRoutingConfig,
  defaultAgent: "anthropic",
  rules: [
    { agent: "jev", phrases: ["hey jev"], mode: "turn" },
    { agent: "claude-subscription", phrases: ["hey claude"], mode: "conversation" },
    { agent: "codex-subscription", phrases: ["hey codex"], mode: "conversation" },
    { agent: "openrouter", phrases: ["hey open router", "hey router"], mode: "conversation" },
    { agent: "home-model", phrases: ["hey open"], mode: "turn" },
    { agent: DEFAULT_AGENT_REF, phrases: ["hey assistant", "back to normal"], mode: "conversation" }
  ]
}
const router = makeTriggerRouter(config)
const everyone = () => true

const route = (text: string, over: Partial<RouteInput> = {}) =>
  router.route({ text, source: "voice", state: initialRouterState, now: 1_000_000, isAvailable: everyone, ...over })

describe("trigger matching", () => {
  it("routes a trigger phrase and removes it from what the agent gets", () => {
    const d = route("Hey Jev, turn on the lights in the living room.")
    expect(d).toMatchObject({ agentId: "jev", reason: "trigger", text: "Turn on the lights in the living room." })
    expect(d.trigger).toMatchObject({ phrase: "hey jev", matched: "Hey Jev", score: 1, mode: "turn" })
  })

  it.each([
    ["hey Jeff turn on the lights", "same phonetic key"],
    ["Hey JEF, turn on the lights", "same phonetic key"],
    ["hay jev turn on the lights", "another greeting word"],
    ["Okay Jev, turn on the lights", "another greeting word"],
    ["Hi J. E. V. turn on the lights", "spelled out"],
    ["Um, hey Jev, turn on the lights", "a filler first"],
    ["Hé Jev, turn on the lights", "a Dutch greeting with an accent"]
  ])("accepts a misrecognised trigger: %s (%s)", (text) => {
    const d = route(text)
    expect(d.agentId).toBe("jev")
    expect(d.text).toBe("Turn on the lights")
  })

  it("accepts a name one edit away only for longer words", () => {
    expect(route("Hey cloud, what's a good name for a goldfish?")).toMatchObject({ agentId: "claude-subscription", text: "What's a good name for a goldfish?" })
    expect(route("Hey Claud what time is it")).toMatchObject({ agentId: "claude-subscription" })
    // "jen" and "rev" are one edit from "jev", but three-letter words must match exactly or phonetically
    expect(route("Hey Jen, are you there?")).toMatchObject({ agentId: "anthropic", reason: "default", text: "Hey Jen, are you there?" })
    expect(route("Hey rev the engine")).toMatchObject({ reason: "default" })
  })

  it("matches without the greeting only when the name itself is clear", () => {
    expect(route("Jev, lights off.")).toMatchObject({ agentId: "jev", text: "Lights off." })
    expect(route("Jev, lights off.").trigger?.score).toBe(0.85)
    // approximate name and no greeting: not a trigger
    expect(route("Cloud computing is what?")).toMatchObject({ reason: "default" })
    const strict = makeTriggerRouter({ ...config, requireGreeting: true })
    expect(strict.route({ text: "Jev, lights off.", source: "voice", state: {}, now: 0, isAvailable: everyone }).reason).toBe("default")
  })

  it("only looks at the start of the utterance", () => {
    expect(route("Can you tell Jev to turn on the lights")).toMatchObject({ reason: "default" })
    expect(route("Turn on the lights, hey Jev")).toMatchObject({ reason: "default" })
  })

  it("prefers the phrase that matches more words", () => {
    expect(route("Hey open router, tell me a joke")).toMatchObject({ agentId: "openrouter", text: "Tell me a joke" })
    expect(route("Hey open the blinds")).toMatchObject({ agentId: "home-model", text: "The blinds" })
  })

  it("matches phrases without a greeting word", () => {
    expect(route("Back to normal please")).toMatchObject({ agentId: "anthropic", reason: "trigger", text: "Please" })
  })

  it("scores words: exact, phonetic, approximate, none", () => {
    const p = (norm: string) => ({ norm, phon: phoneticWord(norm) })
    expect(wordMatchScore("jev", p("jev"))).toBe(1)
    expect(wordMatchScore("jeff", p("jev"))).toBe(0.9)
    expect(wordMatchScore("cluade", p("claude"))).toBe(0.8)
    expect(wordMatchScore("cloud", p("claude"))).toBe(0.75)
    expect(wordMatchScore("jen", p("jev"))).toBe(0)
  })
})

describe("trigger-only utterances and arming", () => {
  it("acknowledges a bare trigger and sends the next utterance to that agent", () => {
    const first = route("Hey Jev.")
    expect(first).toMatchObject({ agentId: "jev", reason: "trigger", text: "", acknowledge: "Yes?" })
    expect(first.next.armed).toEqual({ agentId: "jev", until: 1_000_000 + config.armedMs })

    const reply = route("turn on the lights", { state: first.next, now: 1_003_000 })
    expect(reply).toMatchObject({ agentId: "jev", reason: "armed", text: "turn on the lights" })
    expect(reply.next.armed).toBeUndefined()

    const late = route("turn on the lights", { state: first.next, now: 1_000_000 + config.armedMs + 1 })
    expect(late).toMatchObject({ agentId: "anthropic", reason: "default" })
  })

  it("arms an agent that asked a question", () => {
    const state = armAgent(initialRouterState, "jev", 0, 10_000)
    expect(route("the kitchen", { state, now: 5_000 })).toMatchObject({ agentId: "jev", reason: "armed" })
  })
})

describe("conversation-mode triggers", () => {
  it("keep the agent for the following turns until idle", () => {
    const first = route("Hey Claude, what is a quasar?")
    expect(first.next.sticky).toEqual({ agentId: "claude-subscription", lastUsedAt: 1_000_000 })
    const second = route("And how far away is the nearest one?", { state: first.next, now: 1_060_000 })
    expect(second).toMatchObject({ agentId: "claude-subscription", reason: "sticky" })
    expect(second.next.sticky?.lastUsedAt).toBe(1_060_000)
    const third = route("Thanks", { state: second.next, now: 1_060_000 + config.stickyIdleMs })
    expect(third).toMatchObject({ agentId: "anthropic", reason: "default" })
    expect(third.next).toEqual({})
  })

  it("end with the default agent's phrase", () => {
    const state: RouterState = { sticky: { agentId: "claude-subscription", lastUsedAt: 999_000 } }
    const d = route("Hey assistant, what time is it?", { state })
    expect(d).toMatchObject({ agentId: "anthropic", reason: "trigger", text: "What time is it?" })
    expect(d.next.sticky).toBeUndefined()
  })

  it("are kept (not refreshed) across a one-turn trigger", () => {
    const state: RouterState = { sticky: { agentId: "claude-subscription", lastUsedAt: 999_000 } }
    const d = route("Hey Jev lights on", { state })
    expect(d.agentId).toBe("jev")
    expect(d.next.sticky).toEqual(state.sticky)
  })

  it("can be set and cleared from the UI", () => {
    const state = setActiveAgent(initialRouterState, "codex-subscription", 0)
    expect(activeAgent(state, config, 1_000)).toEqual({ agentId: "codex-subscription", reason: "sticky", expiresInMs: config.stickyIdleMs - 1_000 })
    expect(activeAgent(setActiveAgent(state, null, 2_000), config, 2_000)).toEqual({ agentId: "anthropic", reason: "default" })
  })
})

describe("explicit choice and availability", () => {
  it("lets the composer choose, still removing a trigger", () => {
    expect(route("Hey Jev, what is a quasar?", { explicitAgent: "openrouter", source: "text" })).toMatchObject({
      agentId: "openrouter",
      reason: "explicit",
      text: "What is a quasar?"
    })
  })

  it("falls back to the default when the routed agent is not running, and does not stick to it", () => {
    const d = route("Hey Codex, write a haiku", { isAvailable: (id) => id !== "codex-subscription" })
    expect(d).toMatchObject({ agentId: "anthropic", reason: "trigger", unavailable: "codex-subscription", text: "Write a haiku" })
    expect(d.next.sticky).toBeUndefined()
  })

  it("uses the fallback agent when the default is not running either, or none", () => {
    const r = makeTriggerRouter({ ...config, fallbackAgent: "home-model" })
    const input = { text: "hello", source: "voice" as const, state: {}, now: 0 }
    expect(r.route({ ...input, isAvailable: (id) => id === "home-model" })).toMatchObject({ agentId: "home-model", unavailable: "anthropic" })
    expect(r.route({ ...input, isAvailable: () => false }).agentId).toBeUndefined()
  })
})

describe("cost", () => {
  it("routes in microseconds (it runs before every turn)", () => {
    const text = "Hey open router, what's the weather going to be like in Amsterdam tomorrow afternoon?"
    for (let i = 0; i < 200; i++) route(text) // warm up
    const n = 5_000
    const start = performance.now()
    for (let i = 0; i < n; i++) route(text)
    const perRouteMs = (performance.now() - start) / n
    expect(perRouteMs).toBeLessThan(0.5) // generous bound against regressions; measured value is printed below
    console.info(`route(): ${(perRouteMs * 1000).toFixed(1)} µs per utterance with ${config.rules.length} rules`)
  })
})
