// Pure behaviour added for per-assistant Claude subscription sessions (WP-13a): how effort and thinking reach Claude
// Code's options, and which settings make a running session replaceable (`launchKeyOf`).
import { describe, expect, it } from "@effect/vitest"
import { launchKeyOf, sessionOptions, type SessionOptionsInput } from "../src/index.ts"

const base: SessionOptionsInput = { model: "claude-haiku-5-5", system: "s", tools: [], mcpServer: undefined, claudePath: undefined, env: {}, stderr: () => {} }

describe("sessionOptions: effort and thinking", () => {
  it("defaults to no thinking and no effort option (the spoken default: Claude Code's own effort for the model)", () => {
    const options = sessionOptions(base)
    expect(options.thinking).toEqual({ type: "disabled" })
    expect(options).not.toHaveProperty("effort")
  })

  it("'adaptive' lets Claude decide when to think; 'off' and absent disable it", () => {
    expect(sessionOptions({ ...base, thinking: "adaptive" }).thinking).toEqual({ type: "adaptive" })
    expect(sessionOptions({ ...base, thinking: "off" }).thinking).toEqual({ type: "disabled" })
    expect(sessionOptions({ ...base, thinking: undefined }).thinking).toEqual({ type: "disabled" })
  })

  it("passes each effort level through", () => {
    for (const effort of ["low", "medium", "high"] as const) expect(sessionOptions({ ...base, effort }).effort).toBe(effort)
  })
})

describe("launchKeyOf", () => {
  it("is the same for the same model, effort and thinking, and differs when any of them differs", () => {
    const key = launchKeyOf({ model: "m", effort: "high", thinking: "adaptive" })
    expect(launchKeyOf({ model: "m", effort: "high", thinking: "adaptive" })).toBe(key)
    expect(launchKeyOf({ model: "m2", effort: "high", thinking: "adaptive" })).not.toBe(key)
    expect(launchKeyOf({ model: "m", effort: "low", thinking: "adaptive" })).not.toBe(key)
    expect(launchKeyOf({ model: "m", effort: "high", thinking: "off" })).not.toBe(key)
  })

  it("treats absent thinking as 'off' and absent effort as its own value", () => {
    expect(launchKeyOf({ model: "m", effort: undefined, thinking: undefined })).toBe(launchKeyOf({ model: "m", effort: undefined, thinking: "off" }))
    expect(launchKeyOf({ model: "m", effort: undefined, thinking: "off" })).not.toBe(launchKeyOf({ model: "m", effort: "low", thinking: "off" }))
  })
})
