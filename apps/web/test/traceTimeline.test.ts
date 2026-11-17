import { describe, expect, it } from "vitest"
import { TRACE_EVENT_NAMES, type TraceEvent, type TraceInfo } from "@pva/protocol"
import {
  audibleDetail, BREAK_PX, derivedPairs, endNote, EVENT_LABELS, eventText, gapExtraPx, groupLanes, inlineLabels, laneOf, listRows, makeAxis, MAX_ENTRIES,
  modulesAndTools, navOrder, nearestInLane, packLane, phoneRows, rebuildTimeline, signed, SUB_ROWS, timelineOf
} from "../src/lib/traceTimeline.ts"

const e = (name: string, at: number, extra?: Partial<TraceEvent>): TraceEvent => ({ name, at, ...extra })
const trace = (over: Partial<TraceInfo> = {}): TraceInfo => ({ turnId: 1, mode: "voice", speculative: false, outcome: "completed", marks: {}, tools: [], voices: [], ...over })

/** A turn like seed 43: 2.3 s of speaking, a reply of 1.7 s, 3 s of playback. */
const turn43 = (): Array<TraceEvent> => [
  e("speechStarted", -2339), e("firstInterim", -1959), e("wakePhrase", -1639), e("endOfTurn", 0), e("assistantChosen", 2),
  e("llmRequestSent", 4, { detail: "round 1" }), e("llmFirstToken", 521, { detail: "round 1" }), e("llmDone", 611, { detail: "round 1" }),
  e("tool", 613, { ms: 2, detail: "add_note" }), e("tool", 616, { ms: 1, detail: "read_notes" }),
  e("llmRequestSent", 619, { detail: "round 2" }), e("llmFirstToken", 1302, { detail: "round 2" }), e("firstClause", 1367), e("ttsFirstAudio", 1411),
  e("llmDone", 1413, { detail: "round 2" }), e("audioSent", 1414), e("playbackStart", 1490), e("audible", 1544), e("ttsDone", 1641), e("playbackEnd", 4564)
]

describe("labels", () => {
  it("has plain words for every name the protocol knows (ttsRequestSent too), and shows an unknown name as it is", () => {
    for (const n of TRACE_EVENT_NAMES) expect(EVENT_LABELS[n], n).toMatch(/\S/)
    expect(EVENT_LABELS.ttsRequestSent).toBe("Voice: synthesis asked for")
    expect(eventText(e("somethingNew", 1)).label).toBe("somethingNew")
  })
  it("puts a round in the label of a language-model entry and keeps other details apart", () => {
    expect(eventText(e("llmRequestSent", 4, { detail: "round 2" }))).toEqual({ label: "Language model: request sent · round 2", detail: undefined })
    expect(eventText(e("tool", 4, { ms: 2, detail: "weather" }))).toEqual({ label: "Tool call", detail: "weather" })
  })
  it("formats times with a real minus sign", () => {
    expect([signed(-2400), signed(312), signed(0), signed(0.2)]).toEqual(["−2,400", "+312", "0", "0"])
  })
})

describe("lanes", () => {
  it("puts every known name in a lane except the turn's start and end, and an unknown name in Other", () => {
    for (const n of TRACE_EVENT_NAMES) expect(laneOf(n) === undefined, n).toBe(n === "turnStarted" || n === "turnEnded")
    expect(laneOf("somethingNew")).toBe("other")
  })
  it("groups in turn order and leaves empty lanes out", () => {
    const ev = [e("speechStarted", -2400), e("endOfTurn", 0), e("llmRequestSent", 4), e("tool", 20, { ms: 30, detail: "a" }), e("ttsFirstAudio", 200), e("audible", 260)]
    const lanes = groupLanes(ev)
    expect(lanes.map((l) => l.id)).toEqual(["hearing", "model", "tools", "voice", "playback"])
    expect(lanes[0]!.indices).toEqual([0, 1])
  })
})

describe("axis, reply mode", () => {
  it("shortens a long stretch of speaking and a long playback, with a break and a caption each, and keeps 0 and the order", () => {
    const ax = makeAxis(turn43(), 1000, "reply")
    expect(ax.mode).toBe("reply")
    expect(ax.shortened).toBe(true)
    expect(ax.segments.map((s) => s.shortened)).toEqual([true, false, true])
    expect(ax.breaks).toHaveLength(2)
    expect(ax.captions.map((c) => c.text)).toEqual(["2.3 s, shortened", "2.9 s, shortened"])
    // The shortened parts take 12 % each; the reply gets the rest minus the two breaks.
    expect(ax.segments[0]!.x1).toBeCloseTo(120)
    expect(ax.segments[2]!.x1).toBeCloseTo(1000)
    expect(ax.segments[1]!.x1 - ax.segments[1]!.x0).toBeCloseTo(1000 - 240 - 2 * BREAK_PX)
    expect(ax.x(-2339)).toBe(0)
    expect(ax.x(0)).toBeGreaterThan(ax.x(-1000))
    expect(ax.x(4564)).toBeCloseTo(1000)
    const xs = turn43().map((ev) => ax.x(ev.at))
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    // No entry falls in a break.
    for (const ev of turn43()) for (const b of ax.breaks) expect(ax.x(ev.at) <= b.x0 || ax.x(ev.at) >= b.x1).toBe(true)
  })
  it("labels only the linear part (at least 80 px apart, 0 among them) and the outer edges of the shortened parts", () => {
    const ax = makeAxis(turn43(), 1000, "reply")
    const lin = ax.ticks.filter((k) => !k.edge)
    expect(lin.some((k) => k.t === 0 && k.label === "0")).toBe(true)
    for (let i = 1; i < lin.length; i++) expect(lin[i]!.x - lin[i - 1]!.x).toBeGreaterThanOrEqual(79.9)
    expect(ax.ticks.filter((k) => k.edge).map((k) => k.label)).toEqual(["−2,339", "+4,564"])
  })
  it("is linear across when speaking is a small share, with no break", () => {
    const ax = makeAxis([e("speechStarted", -150), e("endOfTurn", 0), e("llmFirstToken", 500), e("audible", 900)], 800, "reply")
    expect(ax.shortened).toBe(false)
    expect(ax.breaks).toHaveLength(0)
    expect(ax.x(-150)).toBe(0)
    expect(ax.x(900)).toBeCloseTo(800)
  })
  it("pieces: a bar across a break is two pieces", () => {
    const ax = makeAxis(turn43(), 1000, "reply")
    expect(ax.pieces(-2339, 0)).toHaveLength(2)
    expect(ax.pieces(100, 200)).toHaveLength(1)
  })
  it("fits the end of a turn that did not complete", () => {
    const ax = makeAxis([e("endOfTurn", 0), e("llmFirstToken", 150)], 800, "reply", 1820)
    expect(ax.max).toBe(1820)
  })
})

describe("axis, entire mode", () => {
  it("is one linear scale from the first entry to the last, with negative ticks and nothing shortened", () => {
    const ax = makeAxis(turn43(), 1000, "entire")
    expect(ax.mode).toBe("entire")
    expect(ax.segments).toHaveLength(1)
    expect(ax.breaks).toHaveLength(0)
    expect(ax.captions).toHaveLength(0)
    expect(ax.shortened).toBe(false)
    expect(ax.x(-2339)).toBe(0)
    expect(ax.x(4564)).toBeCloseTo(1000)
    expect(ax.x(0)).toBeCloseTo(1000 * 2339 / (2339 + 4564))
    expect(ax.ticks.some((k) => k.t < 0)).toBe(true)
    expect(ax.ticks.every((k) => !k.edge)).toBe(true)
  })
})

describe("packLane", () => {
  const ax = makeAxis([e("endOfTurn", 0), e("audible", 1000)], 1000, "entire") // 1 px per ms from 0
  it("keeps entries that do not touch in one sub-row, and moves a colliding one to the next", () => {
    const entries = [e("llmRequestSent", 100), e("llmFirstToken", 300), e("llmDone", 305), e("llmDone", 600)]
    const p = packLane(entries, ax)
    expect(p.rowOf).toEqual([0, 0, 1, 0])
    expect(p.rows).toBe(2)
  })
  it("packs a span by its width and caps at three sub-rows, putting the overflow where it overlaps least", () => {
    const entries = [e("tool", 100, { ms: 300 }), e("tool", 110, { ms: 300 }), e("tool", 120, { ms: 300 }), e("tool", 130, { ms: 300 }), e("tool", 140, { ms: 300 })]
    const p = packLane(entries, ax)
    expect(p.rows).toBe(SUB_ROWS)
    expect(p.rowOf.slice(0, 3)).toEqual([0, 1, 2])
    expect(p.rowOf[3]).toBe(0) // the smallest right edge
  })
  it("shows an inline text only when it fits before the next entry in its sub-row and in the plot", () => {
    const entries = [e("tool", 100, { ms: 2, detail: "add_note" }), e("tool", 130, { ms: 2, detail: "read_notes" }), e("tool", 900, { ms: 2, detail: "far_away_tool_name" })]
    const p = packLane(entries, ax)
    const shown = inlineLabels(entries, p.rowOf, ax)
    expect(shown.has(0)).toBe(false) // "add_note 2 ms" would reach the next mark
    expect(shown.has(1)).toBe(true)
    expect(shown.has(2)).toBe(false) // runs off the plot
  })
})

describe("derived pairs", () => {
  it("pairs rounds by their number, the voice, playback and speaking, and only when both ends exist", () => {
    const pairs = derivedPairs(turn43())
    const ev = turn43()
    const names = pairs.map((p) => `${ev[p.from]!.name}>${ev[p.to]!.name}:${p.kind}`)
    expect(names).toContain("llmRequestSent>llmDone:round")
    expect(pairs.filter((p) => p.kind === "round")).toHaveLength(2)
    expect(names).toContain("firstClause>ttsDone:voice")
    expect(names).toContain("playbackStart>playbackEnd:playback")
    expect(names).toContain("speechStarted>endOfTurn:speaking")
    const r1 = pairs.find((p) => p.kind === "round" && ev[p.from]!.detail === "round 1")!
    expect(ev[r1.to]!.detail).toBe("round 1")
    expect(derivedPairs([e("playbackStart", 10)])).toEqual([])
    expect(derivedPairs([e("ttsRequestSent", 1), e("ttsDone", 9)])).toEqual([])
  })
  it("gives the table's Took column the derived duration of an ending entry", () => {
    const rows = listRows(turn43())
    const done = rows.find((r) => r.event.name === "playbackEnd")!
    expect(done.derivedMs).toBe(4564 - 1490)
    expect(done.derivedKind).toBe("playback")
    expect(rows[0]!.gap).toBeUndefined()
    expect(rows[1]!.gap).toBe(380)
  })
})

describe("keyboard order", () => {
  it("orders by time, then lane, then list order, and leaves out turnStarted and turnEnded", () => {
    const ev = [e("turnStarted", -5), e("speechStarted", -5), e("llmFirstToken", 0), e("endOfTurn", 0), e("turnEnded", 9)]
    const nav = navOrder(ev)
    expect(nav.order).toEqual([1, 3, 2]) // endOfTurn (hearing) before llmFirstToken (model) at 0
    expect(nav.lanes).toEqual(["hearing", "model"])
  })
  it("moves up and down to the nearest entry in time in the next lane", () => {
    const ev = turn43().sort((a, b) => a.at - b.at)
    const nav = navOrder(ev)
    const from = ev.findIndex((x) => x.name === "audible")
    const down = nearestInLane(nav, ev, from, 1)
    expect(down).toBeUndefined() // playback is the last lane
    const up = nearestInLane(nav, ev, from, -1)!
    expect(laneOf(ev[up]!.name)).toBe("voice")
    expect(ev[up]!.name).toBe("ttsDone") // 1641 is nearer to 1544 than 1411 is
    expect(nearestInLane(nav, ev, ev.findIndex((x) => x.name === "speechStarted"), -1)).toBeUndefined()
  })
})

describe("phone list", () => {
  it("folds a run of four or more of the same name, with its range and total", () => {
    const ev = [e("endOfTurn", 0), ...[10, 20, 30, 40, 50].map((at, i) => e("tool", at, { ms: 5, detail: `t${i}` })), e("audible", 90)]
    const rows = phoneRows(ev)
    expect(rows.map((r) => r.kind)).toEqual(["row", "run", "row"])
    const run = rows[1]!
    if (run.kind !== "run") throw new Error("run")
    expect(run.rows).toHaveLength(5)
    expect([run.from, run.to, run.totalMs]).toEqual([10, 55, 45])
    expect(phoneRows([e("tool", 1), e("tool", 2), e("tool", 3)]).every((r) => r.kind === "row")).toBe(true)
  })
  it("adds rail height by the gap: none under 50 ms, 6 px per doubling, 36 at most", () => {
    expect(gapExtraPx(49)).toBe(0)
    expect(gapExtraPx(50)).toBe(0)
    expect(gapExtraPx(100)).toBeCloseTo(6)
    expect(gapExtraPx(1e9)).toBe(36)
  })
})

describe("200 entries", () => {
  const many = Array.from({ length: MAX_ENTRIES }, (_, i) => e(i % 3 === 0 ? "tool" : "llmFirstToken", i * 7 - 300, i % 3 === 0 ? { ms: 4, detail: `t${i}` } : undefined))
  it("axis, packing, order and the list handle the ceiling, and a lane stays within three sub-rows", () => {
    const sorted = timelineOf(trace({ timeline: [...many].reverse() })).events
    expect(sorted).toHaveLength(MAX_ENTRIES)
    expect(sorted.every((x, i) => i === 0 || sorted[i - 1]!.at <= x.at)).toBe(true)
    const ax = makeAxis(sorted, 600, "reply")
    for (const lane of groupLanes(sorted)) {
      const p = packLane(lane.indices.map((i) => sorted[i]!), ax)
      expect(p.rows).toBeLessThanOrEqual(SUB_ROWS)
      expect(p.rowOf).toHaveLength(lane.indices.length)
    }
    expect(navOrder(sorted).order).toHaveLength(MAX_ENTRIES)
    expect(listRows(sorted)).toHaveLength(MAX_ENTRIES)
    expect(phoneRows(sorted).length).toBeLessThanOrEqual(MAX_ENTRIES)
  })
})

describe("where the time line comes from, and notes", () => {
  it("uses the recorded time line, sorted", () => {
    expect(timelineOf(trace({ timeline: [e("b", 5), e("a", -5)] })).events.map((x) => x.name)).toEqual(["a", "b"])
  })
  it("rebuilds from the marks of an older server, with the audible moment and routing", () => {
    const t = trace({
      marks: { llmFirstToken: 150, ttsFirstAudio: 200, playbackStart: 230, routeSent: -400, routeReceived: -260 },
      client: { outputLatencyMs: 20, startDelayMs: 5 },
      route: { by: "typesafe", outcome: "chosen", ms: 140, fallback: false },
      totalMs: 2500
    })
    const r = timelineOf(t)
    expect(r.source).toBe("rebuilt")
    expect(r.events.map((x) => x.name)).toEqual(["routing", "endOfTurn", "llmFirstToken", "ttsFirstAudio", "playbackStart", "audible", "turnEnded"])
    expect(audibleDetail(t, r.events)).toBe("playback start +230 + output latency 20 ms")
    expect(audibleDetail(trace(), [])).toBe("playback start + output latency")
  })
  it("says there is none when the trace has no marks", () => {
    expect(timelineOf(trace()).source).toBe("none")
    expect(rebuildTimeline(trace({ totalMs: 100 }))).toEqual([])
  })
  it("says where a turn that did not complete ended, and nothing for a completed one", () => {
    expect(endNote(trace({ outcome: "interrupted" }), [e("turnEnded", 1820)])).toBe("This turn was interrupted at +1,820 ms; later steps did not happen and are not drawn.")
    expect(endNote(trace({ outcome: "failed", totalMs: 90 }), [])).toContain("failed at +90 ms")
    expect(endNote(trace({ outcome: "discarded" }), [])).toBe("This turn was discarded; later steps did not happen and are not drawn.")
    expect(endNote(trace(), [e("turnEnded", 1)])).toBeUndefined()
  })
})

describe("modules and tools", () => {
  const config = {
    llm: { account: "anthropic", model: "m", effort: "low", thinking: "off", maxTokens: 1 },
    hearing: { hearer: "x", engine: "sherpa" },
    voice: "v", modules: 3, tools: 4, replyEarly: false, toolRounds: 1
  } as unknown as NonNullable<TraceInfo["config"]>
  it("says it is not recorded without a config, and lists what was called", () => {
    const m = modulesAndTools(trace({ tools: [{ name: "a", ms: 2 }] }))
    expect(m).toMatchObject({ recorded: false, message: "Modules and tools not recorded for this turn." })
    expect(m.called).toEqual([{ name: "a", called: true, calls: 1, ms: 2 }])
  })
  it("gives the counts when the config has no lists", () => {
    expect(modulesAndTools(trace({ config })).message).toBe("Modules and tools not recorded for this turn · 3 modules · 4 tools")
  })
  it("keeps the modules when the tool list is missing", () => {
    const m = modulesAndTools(trace({ config: { ...config, moduleList: [{ id: "c", name: "Clock" }] } }))
    expect(m.recorded).toBe(false)
    expect(m.modules).toEqual([{ id: "c", name: "Clock", tools: undefined }])
  })
  it("groups the tools under their modules, marks called ones (summing repeats), and puts the rest in Other", () => {
    const t = trace({
      tools: [{ name: "weather", ms: 1 }, { name: "weather", ms: 4 }, { name: "gone", ms: 1 }],
      config: { ...config, moduleList: [{ id: "c", name: "Clock" }, { id: "w", name: "Weather" }], toolList: [{ name: "time_in", module: "c" }, { name: "weather", module: "w" }, { name: "loose" }] }
    })
    const m = modulesAndTools(t)
    expect(m.recorded).toBe(true)
    expect(m.modules.map((x) => x.name)).toEqual(["Clock", "Weather"])
    expect(m.modules[1]!.tools).toEqual([{ name: "weather", called: true, calls: 2, ms: 5 }])
    expect(m.other.map((x) => x.name)).toEqual(["loose", "gone"])
  })
  it("reads a known empty list as 'no modules'", () => {
    expect(modulesAndTools(trace({ config: { ...config, moduleList: [], toolList: [] } })).none).toBe(true)
  })
})
