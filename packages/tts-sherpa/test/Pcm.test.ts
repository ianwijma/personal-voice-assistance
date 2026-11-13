import { assert, describe, it } from "@effect/vitest"
import { chunkPcm, defaultJoinOptions, floatToS16, type JoinedClause, makeJoiner, silentRuns } from "../src/Pcm.ts"

const RATE = 16_000
const samplesFor = (ms: number) => Math.round((RATE * ms) / 1000)

/** `leadMs` of silence, `toneMs` of a 0.5-amplitude tone, `trailMs` of silence. */
const clause = (leadMs: number, toneMs: number, trailMs: number) => {
  const lead = samplesFor(leadMs)
  const tone = samplesFor(toneMs)
  const out = new Float32Array(lead + tone + samplesFor(trailMs))
  for (let i = 0; i < tone; i++) out[lead + i] = 0.5 * Math.cos((2 * Math.PI * 200 * i) / RATE)
  return out
}

/** A joined clause as played: the pause, then the speech. */
const all = (joined: JoinedClause) => [...joined.pause, ...joined.speech]

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  return new Int16Array(bytes.buffer)
}

describe("floatToS16", () => {
  it("scales and clamps", () => {
    const out = floatToS16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]))
    assert.deepStrictEqual([...out], [0, 16384, -16383, 32767, -32767, 32767, -32768])
  })
})

describe("chunkPcm", () => {
  it("splits into views of at most the chunk size", () => {
    const chunks = chunkPcm(new Int16Array(1000), 300)
    assert.deepStrictEqual(chunks.map((c) => c.length), [600, 600, 600, 200])
  })
})

describe("makeJoiner", () => {
  it("trims the first clause to the pad and puts the configured pause at each join", () => {
    const join = makeJoiner(RATE)
    const pcm = concat([
      ...all(join(clause(70, 400, 180), "Sure,")),
      ...all(join(clause(40, 300, 120), "that works.")),
      ...all(join(clause(10, 300, 90), "Anything else?"))
    ])
    const runs = silentRuns(pcm, RATE, defaultJoinOptions.threshold, 30)
    // pad before the first clause (20 ms, below the 30 ms floor so not a run), then the two joins.
    assert.strictEqual(runs.length, 2)
    assert.closeTo(runs[0]!.ms, 150, 1) // after a comma
    assert.closeTo(runs[1]!.ms, 300, 1) // after a full stop
    const leading = silentRuns(pcm, RATE, defaultJoinOptions.threshold, 0)[0]!
    assert.strictEqual(leading.atMs, 0)
    assert.closeTo(leading.ms, 20, 1)
    // total = pads + pauses + speech
    assert.closeTo((pcm.length * 1000) / RATE, 20 + 400 + 150 + 300 + 300 + 300 + 20, 1)
  })

  it("keeps a clause's own silence when it is shorter than the pad", () => {
    const join = makeJoiner(RATE)
    join(clause(0, 100, 5), "a,")
    const second = concat(all(join(clause(5, 100, 0), "b")))
    // pause 150 ms = 5 ms kept trailing + 5 ms kept leading + 140 ms inserted
    assert.strictEqual(second.length, samplesFor(140 + 5 + 100))
  })

  it("fades cut edges to zero", () => {
    const join = makeJoiner(RATE)
    const audio = clause(70, 400, 180)
    audio.fill(0.008, 0, samplesFor(70)) // quiet noise in the leading silence, below the threshold
    const pcm = concat(all(join(audio, "x")))
    assert.strictEqual(pcm[0], 0)
    assert.strictEqual(pcm[pcm.length - 1], 0)
  })

  it("drops all-silent clauses and passes audio through untouched when trimming is off", () => {
    assert.deepStrictEqual(all(makeJoiner(RATE)(new Float32Array(1000), "...")), [])
    const raw = clause(70, 100, 100)
    const pcm = concat(all(makeJoiner(RATE, { ...defaultJoinOptions, trim: false })(raw, "x")))
    assert.strictEqual(pcm.length, raw.length)
  })

  it("emits chunks of the configured size", () => {
    const chunks = makeJoiner(RATE, { ...defaultJoinOptions, chunkMs: 20 })(clause(0, 1000, 0), "x").speech
    const size = samplesFor(20) * 2
    for (const c of chunks.slice(0, -1)) assert.strictEqual(c.length, size)
    assert.isAtMost(chunks.at(-1)!.length, size)
  })

  it("returns the inserted pause apart from the speech; the speech starts at the pad", () => {
    const join = makeJoiner(RATE)
    assert.deepStrictEqual(join(clause(70, 400, 180), "Done.").pause, [], "nothing before the first clause")
    const second = join(clause(40, 300, 120), "Next one")
    // 300 ms after a full stop = 20 ms kept trailing pad + 20 ms leading pad + 260 ms inserted.
    assert.strictEqual(concat(second.pause).length, samplesFor(260))
    assert.isTrue(concat(second.pause).every((x) => x === 0))
    const speech = concat(second.speech)
    const firstLoud = speech.findIndex((x) => Math.abs(x) >= defaultJoinOptions.threshold * 32767)
    assert.closeTo(firstLoud, samplesFor(defaultJoinOptions.padMs), 2)
  })
})
