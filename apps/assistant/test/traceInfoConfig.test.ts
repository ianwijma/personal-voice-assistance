// `traceInfo` and the snapshot (docs/ASSISTANTS.md §3.7): a trace made without a configuration has no `config` key.
import type { Trace } from "@pva/core"
import type { TraceConfig } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { traceInfo } from "../src/serve/Publisher.ts"

const trace = (extra: Partial<Trace> = {}): Trace => ({ id: 1, mode: "text", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [], ...extra })

describe("traceInfo: configuration", () => {
  it("has no config key when the turn had no snapshot", () => {
    expect(traceInfo(trace())).not.toHaveProperty("config")
  })

  it("carries the very snapshot the turn began with (shared, not copied)", () => {
    const config = {
      llm: { account: "anthropic", model: "m", effort: "low", thinking: "off", maxTokens: 100 },
      hearing: { hearer: "h", engine: "sherpa", model: "x", eagerSilenceMs: 1, finalSilenceMs: 2 },
      voice: "piper:v",
      modules: 0,
      tools: 0,
      replyEarly: false,
      toolRounds: 1
    } as unknown as TraceConfig
    expect(traceInfo(trace({ config })).config).toBe(config)
  })
})
