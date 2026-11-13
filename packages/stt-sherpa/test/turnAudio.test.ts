import { assert, describe, it } from "@effect/vitest"
import { TurnAudio } from "../src/turnAudio.mjs"

// Each frame is 4 samples whose value is the frame index, so the audio shows which frames were kept.
const F = 4
const frameOf = (index: number) => new Float32Array(F).fill(index)
const frames = (audio: Float32Array) => Array.from({ length: audio.length / F }, (_, i) => audio[i * F]!)

/** Feeds `script` (true = speech) from frame `start`; the pre-roll is the last `preroll` frames, as the worker's ring. */
const feed = (turn: TurnAudio, script: ReadonlyArray<boolean>, start = 1, preroll = 3) => {
  const pieces: Array<Array<number>> = []
  script.forEach((speech, k) => {
    const index = start + k
    const piece = turn.push(frameOf(index), index, speech, () => {
      const out = []
      for (let i = Math.max(start, index - preroll + 1); i <= index; i++) out.push({ frame: frameOf(i), index: i, speech: script[i - start]! })
      return out
    })
    if (piece) pieces.push(frames(piece))
  })
  return pieces
}
const S = true
const _ = false

describe("TurnAudio", () => {
  it("collects from the onset with the pre-roll, through pauses", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 100, prerollFrames: 3 })
    feed(turn, [_, _, _, _, S, S, _, _, S, _])
    assert.isTrue(turn.collecting)
    assert.deepStrictEqual(frames(turn.audio()), [3, 4, 5, 6, 7, 8, 9, 10])
  })

  it("nothing before speech", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 100, prerollFrames: 3 })
    feed(turn, [_, _, _, _])
    assert.isFalse(turn.collecting)
    assert.strictEqual(turn.length, 0)
  })

  it("commit empties the turn when nothing was said after it", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 100, prerollFrames: 3 })
    feed(turn, [S, S, _, _, _, _])
    turn.commit(5)
    assert.isFalse(turn.collecting)
    assert.strictEqual(turn.length, 0)
    // The next onset starts a fresh turn from the pre-roll.
    feed(turn, [_, _, S], 7)
    assert.deepStrictEqual(frames(turn.audio()), [7, 8, 9])
  })

  it("commit keeps a new turn that started after the commit point, with its pre-roll", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 100, prerollFrames: 2 })
    feed(turn, [S, S, _, _, _, _, _, S, S], 1, 2)
    turn.commit(5) // frames 6, 7 silent; 8, 9 speech belong to the next turn
    assert.isTrue(turn.collecting)
    assert.deepStrictEqual(frames(turn.audio()), [6, 7, 8, 9])
    assert.isTrue(turn.speechAfter(5))
    assert.isFalse(turn.speechAfter(9))
  })

  it("an over-long turn is handed out at the next silence frame and collection goes on", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 5, graceFrames: 3, prerollFrames: 1 })
    const pieces = feed(turn, [S, S, S, S, S, S, _, S, S], 1, 1)
    assert.deepStrictEqual(pieces, [[1, 2, 3, 4, 5, 6, 7]])
    assert.deepStrictEqual(frames(turn.audio()), [8, 9])
  })

  it("hard cut after the grace frames when nobody pauses", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 4, graceFrames: 2, prerollFrames: 1 })
    const pieces = feed(turn, Array(9).fill(S), 1, 1)
    assert.deepStrictEqual(pieces, [[1, 2, 3, 4, 5, 6]])
    assert.deepStrictEqual(frames(turn.audio()), [7, 8, 9])
  })

  it("audioThrough: the turn's audio up to a frame, leaving out what came after it", () => {
    const turn = new TurnAudio({ frameSamples: F, maxFrames: 100, prerollFrames: 3 })
    feed(turn, [_, _, S, S, _, _, S, S, _])
    assert.deepStrictEqual(frames(turn.audioThrough(6)), [1, 2, 3, 4, 5, 6])
    assert.deepStrictEqual(frames(turn.audioThrough(100)), frames(turn.audio()))
    assert.deepStrictEqual(frames(turn.audioThrough(0)), [])
  })
})
