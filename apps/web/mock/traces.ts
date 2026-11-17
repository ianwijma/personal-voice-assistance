/**
 * The mock's seeded latency traces (scenario `latency`): turns of every route kind (phrase, armed, follow-up, without a
 * phrase, typed, TypeSafe chosen / none fits / timed out / error) with configuration snapshots, some of which differ
 * from what the assistants are set to now ("changed since"), and two from an older server (turn 36 without a snapshot, turn 37 with one but no time line or module lists).
 */
import type { TraceConfig, TraceEvent, TraceInfo } from "@pva/protocol"

const SPARK = "sherpa:en_US-lessac-medium"
const HEART = "sherpa:kokoro-af_heart"
const PIM = "sherpa:nl_NL-pim-medium"

const HEARING = { engine: "sherpa", model: "parakeet-v2", language: "en", eagerSilenceMs: 250, finalSilenceMs: 600 }
const JEFF: TraceConfig = {
  llm: { account: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024 },
  hearing: { hearer: "jeff", ...HEARING },
  voice: SPARK,
  modules: 3,
  tools: 4,
  moduleList: [{ id: "clock", name: "Clock" }, { id: "weather", name: "Weather" }, { id: "home", name: "Home state" }],
  toolList: [{ name: "time_in", module: "clock" }, { name: "set_timer", module: "clock" }, { name: "weather", module: "weather" }, { name: "home_state", module: "home" }],
  replyEarly: true,
  toolRounds: 5
}
const T3: TraceConfig = {
  llm: { account: "claude-subscription", model: "claude-sonnet-5-5", effort: "medium", thinking: "adaptive", maxTokens: 2048 },
  hearing: { hearer: "t3", ...HEARING },
  voice: HEART,
  modules: 2,
  tools: 4,
  moduleList: [{ id: "t3", name: "T3 threads" }, { id: "clock", name: "Clock" }],
  toolList: [{ name: "t3_start_thread", module: "t3" }, { name: "t3_list_threads", module: "t3" }, { name: "time_in", module: "clock" }, { name: "set_timer", module: "clock" }],
  replyEarly: false,
  toolRounds: 8
}
const KEUKEN: TraceConfig = {
  llm: { account: "home-model", model: "qwen3-14b", effort: "low", thinking: "off", maxTokens: 768 },
  hearing: { hearer: "keuken", engine: "sherpa", model: "nemotron-320", language: "nl", eagerSilenceMs: 300, finalSilenceMs: 800 },
  voice: PIM,
  modules: 2,
  tools: 4,
  moduleList: [{ id: "notes", name: "Notes" }, { id: "home", name: "Home state" }],
  toolList: [{ name: "add_note", module: "notes" }, { name: "read_notes", module: "notes" }, { name: "home_state", module: "home" }, { name: "set_light", module: "home" }],
  replyEarly: true,
  toolRounds: 5
}
/** Kitchen iPad lists Jeff first: Jeff's recogniser hears there, whoever answers. */
const withJeffHearing = (c: TraceConfig): TraceConfig => ({ ...c, hearing: JEFF.hearing })

const NAMES = { jeff: "Jeff", t3: "T3", keuken: "Keuken" } as const
const DEVICES = {
  iphone: { id: "d-iphone-0004", name: "iPhone · Safari" },
  desk: { id: "d-desk-0005", name: "Desk · Firefox" },
  kitchen: { id: "d-kitchen-ipad-0001", name: "Kitchen iPad" },
  living: { id: "d-living-room-0003", name: "Living room tablet" },
  office: { id: "d-office-0006", name: "Office · Chrome" }
} as const

interface Seed {
  readonly n: number
  readonly a: keyof typeof NAMES
  readonly d: keyof typeof DEVICES
  /** 1st token, TTS audio, playback; the audible time is playback + `lag`. */
  readonly t: readonly [number, number, number]
  readonly lag: number
  readonly route: NonNullable<TraceInfo["route"]>
  readonly config: TraceConfig | undefined
  readonly outcome?: TraceInfo["outcome"]
  readonly tools?: ReadonlyArray<{ name: string; ms: number }>
  readonly early?: boolean
  readonly text?: boolean
  readonly voice: string
}

/**
 * A realistic time line for a seed, derived from its numbers (the marks are repeated in it, as the server does). A
 * voice turn starts with 1.5 to 3.7 s of speaking; a wake phrase comes first in it; TypeSafe's routing is the span
 * `make` already puts before the end of the turn; a turn with tools has two language-model rounds (the first ends in
 * the tool calls, the second's first token is the seed's); an early turn starts work 330 ms before the end (negative
 * times); a typed turn has no hearing. Seed 36 and 37 get none (an older server).
 */
const timelineOf = (s: Seed, sent: number | undefined): Array<TraceEvent> => {
  const [t0, t1, t2] = s.t
  const out: Array<TraceEvent> = []
  const ev = (name: string, at: number, extra?: Partial<TraceEvent>) => out.push({ name, at: Math.round(at * 10) / 10, ...extra })
  const voice = s.text !== true
  const talk = -(1500 + ((s.n * 173) % 2200))
  if (voice) {
    ev("speechStarted", talk)
    ev("firstInterim", talk + 380)
    if (s.route.by === "phrase" || s.route.by === "armed") ev("wakePhrase", talk + 700, { detail: s.route.phrase })
    if (s.early === true) {
      ev("eagerEndOfTurn", -330, { detail: "42 characters" })
      ev("turnStarted", -330, { detail: "early" })
    }
    ev("endOfTurn", 0)
  } else ev("turnStarted", 0, { detail: "typed" })
  if (s.route.by === "typesafe" && sent !== undefined) {
    ev("routing", sent, { ms: s.route.ms, detail: s.route.outcome })
    ev("assistantChosen", sent + s.route.ms, { detail: s.route.outcome === "chosen" ? NAMES[s.a] : `${NAMES[s.a]} (fallback)` })
  } else ev("assistantChosen", s.early === true ? -325 : 2, { detail: NAMES[s.a] })
  const first = s.early === true ? -322 : 4
  const tools = s.tools ?? []
  if (tools.length === 0) {
    ev("llmRequestSent", first, { detail: "round 1" })
    ev("llmFirstToken", t0, { detail: "round 1" })
  } else {
    const tok = Math.round(t0 * 0.4)
    const done = tok + 90
    ev("llmRequestSent", first, { detail: "round 1" })
    ev("llmFirstToken", tok, { detail: "round 1" })
    ev("llmDone", done, { detail: "round 1" })
    let at = done + 2
    for (const x of tools) {
      ev("tool", at, { ms: x.ms, detail: x.name })
      at += x.ms + 1
    }
    ev("llmRequestSent", at + 1, { detail: "round 2" })
    ev("llmFirstToken", t0, { detail: "round 2" })
  }
  const ttsReq = t1 - 38
  ev("llmDone", ttsReq + 40, { detail: tools.length === 0 ? "round 1" : "round 2" })
  ev("firstClause", ttsReq - 6, { detail: "clause 1" })
  ev("ttsFirstAudio", t1)
  ev("ttsDone", t1 + 140 + (s.n % 5) * 30)
  ev("audioSent", t1 + 3)
  ev("playbackStart", t2)
  ev("audible", t2 + s.lag)
  const end = t2 + s.lag + (s.outcome === "interrupted" ? 380 : 2200 + ((s.n * 40) % 900))
  ev("playbackEnd", end)
  ev("turnEnded", end + 5, { detail: s.outcome ?? "completed" })
  return out.sort((a, b) => a.at - b.at)
}

const withoutLists = ({ moduleList: _m, toolList: _t, ...c }: TraceConfig): TraceConfig => c

const make = (s: Seed): TraceInfo => {
  const ts = s.route.by === "typesafe"
  const sent = ts ? -(s.route.ms + 240) : undefined
  return {
    turnId: s.n,
    mode: s.text === true ? "text" : "voice",
    speculative: s.early === true,
    outcome: s.outcome ?? "completed",
    marks: {
      llmFirstToken: s.t[0],
      ttsFirstAudio: s.t[1],
      playbackStart: s.t[2],
      ...(sent !== undefined ? { routeSent: sent, ...(s.route.by === "typesafe" && s.route.outcome !== "timeout" ? { routeReceived: sent + s.route.ms } : {}) } : {})
    },
    tools: s.tools ?? [],
    voices: [s.voice],
    client: { outputLatencyMs: s.lag, startDelayMs: 12 },
    session: DEVICES[s.d].name,
    assistant: { id: s.a, name: NAMES[s.a] },
    deviceId: DEVICES[s.d].id,
    device: DEVICES[s.d].name,
    route: s.route,
    ...(s.config !== undefined ? { config: s.n > 37 ? s.config : withoutLists(s.config) } : {}),
    // Seed 36 and 37 stand for an older server: no time line (and 36 no snapshot at all).
    ...(s.n > 37 ? { timeline: timelineOf(s, sent) } : {})
  }
}

/** Oldest first, as the server keeps them. */
export const seedTraces = (): Array<TraceInfo> =>
  ([
    { n: 36, a: "jeff", d: "iphone", t: [150, 207, 233], lag: 18, route: { by: "default" }, config: undefined, voice: SPARK },
    { n: 37, a: "jeff", d: "desk", t: [166, 213, 236], lag: 17, route: { by: "default" }, config: JEFF, voice: SPARK },
    { n: 38, a: "t3", d: "desk", t: [421, 560, 619], lag: 36, route: { by: "typesafe", outcome: "error", ms: 212, fallback: true }, config: T3, tools: [{ name: "t3_start_thread", ms: 1 }], voice: HEART },
    { n: 39, a: "keuken", d: "kitchen", t: [655, 772, 849], lag: 53, route: { by: "typesafe", outcome: "timeout", ms: 400, fallback: true }, config: KEUKEN, voice: PIM },
    { n: 40, a: "jeff", d: "iphone", t: [149, 201, 227], lag: 18, route: { by: "follow-up" }, config: JEFF, outcome: "interrupted", early: true, voice: SPARK },
    {
      n: 41,
      a: "t3",
      d: "office",
      t: [371, 470, 538],
      lag: 50,
      route: { by: "typed" },
      config: { ...T3, voice: SPARK },
      text: true,
      tools: [{ name: "t3_start_thread", ms: 1 }],
      voice: HEART
    },
    { n: 42, a: "jeff", d: "living", t: [160, 214, 239], lag: 23, route: { by: "armed", phrase: "hey jeff" }, config: { ...JEFF, llm: { ...JEFF.llm, model: "claude-sonnet-5-5", effort: "medium" } }, tools: [{ name: "weather", ms: 1 }], voice: SPARK },
    { n: 43, a: "keuken", d: "kitchen", t: [1302, 1411, 1490], lag: 54, route: { by: "phrase", phrase: "hey keuken" }, config: withJeffHearing(KEUKEN), tools: [{ name: "add_note", ms: 2 }, { name: "read_notes", ms: 1 }], voice: PIM },
    { n: 44, a: "jeff", d: "kitchen", t: [136, 190, 214], lag: 17, route: { by: "typesafe", outcome: "none-fits", probability: 0.22, fits: 0.18, ms: 141, fallback: true }, config: withJeffHearing(JEFF), voice: SPARK },
    { n: 45, a: "keuken", d: "kitchen", t: [688, 801, 870], lag: 61, route: { by: "typesafe", outcome: "chosen", probability: 0.91, fits: 0.97, ms: 138, fallback: false }, config: withJeffHearing(KEUKEN), tools: [{ name: "add_note", ms: 1 }], voice: PIM },
    { n: 46, a: "jeff", d: "desk", t: [152, 205, 230], lag: 14, route: { by: "phrase", phrase: "hey jeff" }, config: JEFF, tools: [{ name: "home_state", ms: 1 }], voice: SPARK },
    { n: 47, a: "t3", d: "desk", t: [398, 534, 590], lag: 22, route: { by: "default" }, config: T3, tools: [{ name: "time_in", ms: 1 }], voice: HEART },
    { n: 48, a: "jeff", d: "iphone", t: [141, 196, 221], lag: 17, route: { by: "default" }, config: JEFF, early: true, voice: SPARK }
  ] satisfies ReadonlyArray<Seed>).map(make)
