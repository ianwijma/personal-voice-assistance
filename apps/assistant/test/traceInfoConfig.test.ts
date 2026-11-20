// `traceInfo` and the snapshot (docs/ASSISTANTS.md §3.7): a trace made without a configuration has no `config` key.
import type { Trace } from "@pva/core"
import { type TraceConfig, TraceInfo } from "@pva/protocol"
import { Schema } from "effect"
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

describe("traceInfo: time line", () => {
  it("has the marks and the entries together, relative to end of turn, sorted, rounded and cut", () => {
    const long = "x".repeat(300)
    const t = trace({
      startedAt: 1000,
      marks: { endOfTurn: 1200, llmRequestSent: 1100.04, llmFirstToken: 1300 },
      events: [
        { name: "tool", at: 1350.26, ms: 12.34, detail: long },
        { name: "speechStarted", at: 900 },
        { name: "llmRequestSent", at: 1100.04, detail: "round 1" }
      ],
      outcome: "completed",
      endedAt: 1500
    })
    const line = traceInfo(t).timeline!
    expect(line.map((e) => e.name)).toEqual(["speechStarted", "turnStarted", "llmRequestSent", "endOfTurn", "llmFirstToken", "tool", "turnEnded"])
    expect(line.map((e) => e.at)).toEqual([-300, -200, -100, 0, 100, 150.3, 300])
    expect(line.find((e) => e.name === "tool")).toEqual({ name: "tool", at: 150.3, ms: 12.3, detail: "x".repeat(200) })
    expect(line.find((e) => e.name === "turnEnded")!.detail).toBe("completed")
    expect(line.filter((e) => e.name === "llmRequestSent")).toHaveLength(1)
    // As the protocol's schema reads it.
    expect(Schema.decodeUnknownSync(TraceInfo)(traceInfo(t)).timeline).toEqual(line)
  })

  it("derives the routing span and the audible time from the marks and the client's latency", () => {
    const line = traceInfo(trace({
      marks: { endOfTurn: 500, routeSent: 300, routeReceived: 390, playbackStart: 600 },
      client: { outputLatencyMs: 20, startDelayMs: 0 }
    })).timeline!
    expect(line.find((e) => e.name === "routing")).toEqual({ name: "routing", at: -200, ms: 90 })
    expect(line.find((e) => e.name === "audible")!.at).toBe(120)
  })

  it("leaves out entries whose time is not a number and never publishes a negative or non-finite duration", () => {
    const line = traceInfo(trace({
      marks: { endOfTurn: 100 },
      events: [
        { name: "tool", at: Number.NaN, ms: 5 },
        { name: "tool", at: 110, ms: -3 },
        { name: "tool", at: 120, ms: Number.POSITIVE_INFINITY },
        { name: "tool", at: Number.POSITIVE_INFINITY }
      ]
    })).timeline!
    const tools = line.filter((e) => e.name === "tool")
    expect(tools).toEqual([{ name: "tool", at: 10, ms: 0 }, { name: "tool", at: 20 }])
    expect(Schema.decodeUnknownSync(TraceInfo)(traceInfo(trace({ marks: { endOfTurn: 100 }, events: [{ name: "tool", at: Number.NaN }] })))).toBeDefined()
  })
})
