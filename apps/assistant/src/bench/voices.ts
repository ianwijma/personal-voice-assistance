/**
 * Time to first audio of each voice with one or several voices loaded in the resource pool (docs/ASSISTANTS.md WP-10),
 * and the memory the loaded voices take.
 *
 *   tsx src/bench/voices.ts --voices piper,kokoro [--turns 12] [--mode sequential|concurrent] [--model-dir DIR]
 *
 * Voices: `piper` (en_US-lessac-medium), `dutch` (nl_NL-pim-medium), `kokoro` (kokoro-af_heart) and `kokoro2`
 * (kokoro-af_bella: the same engine as `kokoro`). One assistant per voice. The pool (`Resources.ts`, the real
 * `defaultTtsBuilder`, real engines) loads them all; then each assistant answers `--turns` spoken text turns through
 * its own `Conversation` with the voice of `TurnSetup.tts`, an instant stand-in language model and an output that
 * takes everything at once, so what `TurnTrace` marks is the voice: `ttsFirstAudio − firstClause` is the engine's
 * time to first audio for the first clause. `sequential`: one turn at a time, voices in turn; `concurrent`: every
 * assistant's turn k at the same moment (what several devices speaking at once do). One JSON line is printed.
 *
 * Memory is read as WP-0 did (`baseline.ts`): this process's RSS after the load minus before, plus the whole RSS of
 * every child process (the voice engines are child processes), from /proc.
 */
import { Conversation, Llm, type LlmEvent, makeToolRegistry, makeTurnTrace, Tts, TtsError, TurnTrace, type VoiceRef, voiceKey } from "@pva/core"
import { AudioOutput } from "@pva/core"
import { defaultModelDir } from "@pva/tts-sherpa"
import { ConfigProvider, Effect, Layer, Queue, Scope, Stream } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { defaultTtsBuilder, makeResourcePool, ResourceBuildError, ttsSpecOf } from "../serve/Resources.ts"

const MB = 1024 * 1024
const rssOf = (pid: number): number => (Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * 4096) / MB
const childrenOf = (pid: number): Array<number> =>
  readdirSync("/proc").flatMap((name) => {
    if (!/^\d+$/.test(name)) return []
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8")
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid ? [Number(name)] : []
    } catch {
      return []
    }
  })
/** The voice engines (`engine-host.mjs` of tts-sherpa) among the children (a `tsx` helper process is not one). */
const isEngine = (pid: number): boolean => readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("engine-host")
const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const known: Readonly<Record<string, VoiceRef>> = {
  piper: { provider: "sherpa", voiceId: "en_US-lessac-medium" },
  dutch: { provider: "sherpa", voiceId: "nl_NL-pim-medium" },
  kokoro: { provider: "sherpa", voiceId: "kokoro-af_heart" },
  kokoro2: { provider: "sherpa", voiceId: "kokoro-af_bella" }
}

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1]! : fallback
}
const names = flag("--voices", "piper").split(",")
const turns = Number(flag("--turns", "12"))
const mode = flag("--mode", "sequential")
const modelDir = flag("--model-dir", defaultModelDir)
if (names.some((n) => known[n] === undefined) || (mode !== "sequential" && mode !== "concurrent")) {
  console.error(`usage: voices.ts --voices ${Object.keys(known).join(",")} [--turns N] [--mode sequential|concurrent] [--model-dir DIR]`)
  process.exit(2)
}

const reply = "Good morning. The weather today is mild and the roads are clear, so the trip should be quick. Have a good one."
const llm = Llm.of({
  stream: () => Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: reply }, { _tag: "Done", stopReason: "end" }])
})
const noTts = Tts.of({ sampleRate: 22_050, synthesize: () => Stream.fail(new TtsError({ message: "no voice" })) })
const drain = Layer.succeed(AudioOutput, AudioOutput.of({ play: (audio) => Stream.runDrain(audio) }))

const program = Effect.gen(function*() {
  const pool = yield* makeResourcePool({
    buildLlm: () => Effect.fail(new ResourceBuildError({ message: "no language models in this bench" })),
    buildTts: defaultTtsBuilder(() => ConfigProvider.fromEnvRecord({ TTS_SHERPA_MODEL_DIR: modelDir })),
    graceMs: 60_000
  })
  const assistants = names.map((n, i) => ({ id: `a${i + 1}`, name: n, voice: known[n]! }))
  const rssBefore = rssOf(process.pid)
  const t0 = performance.now()
  yield* pool.reconcile(new Map(), { voices: new Map(assistants.map((a) => [a.id, ttsSpecOf(a.voice)])) })
  const loadMs = performance.now() - t0
  const failed = pool.status().filter((r) => r.state === "failed")
  if (failed.length > 0) return { error: failed.map((r) => `${r.key}: ${r.problem}`) }
  const children = childrenOf(process.pid).filter(isEngine).map(rssOf)
  const selfAfter = rssOf(process.pid)

  /** One assistant: its own conversation, trace and input queue; `ask` runs one spoken turn and returns its trace. */
  const sessions = yield* Effect.forEach(assistants, (a) =>
    Effect.gen(function*() {
      const trace = makeTurnTrace({ keep: 10_000 })
      const inputs = yield* Queue.unbounded<{ readonly _tag: "TextInput"; readonly text: string; readonly speak: true }>()
      const setup = Effect.sync(() => ({ system: "sys", registry: makeToolRegistry([]), llm, tts: pool.ttsFor(a.id)! }))
      const layer = Conversation.layerWithSetup({ setup }).pipe(
        Layer.provideMerge(Layer.mergeAll(Layer.succeed(Llm, llm), Layer.succeed(TurnTrace, trace)))
      )
      const conversation = yield* Effect.provide(Effect.service(Conversation), layer)
      yield* Effect.forkScoped(conversation.voice(Stream.fromQueue(inputs)).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(Tts, noTts), drain)), Effect.orDie))
      const ask = (k: number) =>
        Effect.gen(function*() {
          yield* Queue.offer(inputs, { _tag: "TextInput", text: `question ${k}`, speak: true })
          while ((yield* trace.recent).length <= k) yield* Effect.sleep(2)
        })
      return { a, trace, ask }
    }))

  for (let k = 0; k < turns; k++) {
    if (mode === "sequential") for (const s of sessions) yield* s.ask(k)
    else yield* Effect.forEach(sessions, (s) => s.ask(k), { concurrency: "unbounded", discard: true })
  }

  const perVoice: Record<string, unknown> = {}
  for (const s of sessions) {
    const rows = (yield* s.trace.recent).filter((t) => t.outcome === "completed").slice(1) // the first turn of a voice is dropped
    const clause = rows.flatMap((t) => (t.marks.ttsFirstAudio !== undefined && t.marks.firstClause !== undefined ? [t.marks.ttsFirstAudio - t.marks.firstClause] : []))
    const fromStart = rows.flatMap((t) => (t.marks.ttsFirstAudio !== undefined ? [t.marks.ttsFirstAudio - t.startedAt] : []))
    perVoice[`${s.a.id} ${voiceKey(s.a.voice)} voices=${[...new Set(rows.flatMap((t) => t.voices))].join(",")}`] = {
      n: clause.length,
      ttsAfterFirstClauseMs: { min: Math.min(...clause), median: median(clause), max: Math.max(...clause), all: clause.map((x) => Math.round(x)) },
      ttsFirstAudioFromTurnStartMedianMs: median(fromStart)
    }
  }
  return {
    voices: names,
    mode,
    turns,
    engines: children.length,
    loadMs: Math.round(loadMs),
    rss: { selfBeforeMb: Math.round(rssBefore), selfAfterMb: Math.round(selfAfter), childrenMb: children.map(Math.round), addedMb: Math.round(selfAfter - rssBefore + children.reduce((a, b) => a + b, 0)) },
    perVoice
  }
})

const result = await Effect.runPromise(Effect.scoped(program as Effect.Effect<unknown, never, Scope.Scope>))
console.log(JSON.stringify(result))
process.exit(0)
