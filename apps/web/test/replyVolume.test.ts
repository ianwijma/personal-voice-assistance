// P7 (docs/PHRASES.md "Louder and quieter"): the voice page's reply volume. `output.volume` sets a gain node after the
// visualiser's tap (the stage sees the reply as it was made; only what reaches the speaker is scaled), kept for the next
// graph, clamped to 0..1; a value that is not a number is ignored.
import { beforeEach, describe, expect, it } from "vitest"
import { replyGain, VoiceAudio } from "../src/lib/audio/VoiceAudio.ts"
import { installFakeAudio } from "./fakeAudio.ts"

let fake: ReturnType<typeof installFakeAudio>
let gains: Array<{ gain: { value: number }; targets: Array<unknown> }>
let analysers: Array<{ targets: Array<unknown> }>

beforeEach(() => {
  fake = installFakeAudio()
  gains = []
  analysers = []
  const proto = (globalThis as unknown as { AudioContext: { prototype: Record<string, (...a: Array<unknown>) => unknown> } }).AudioContext.prototype
  const makeGain = proto.createGain!
  const makeAnalyser = proto.createAnalyser!
  const recording = <T extends { connect: (n: unknown) => unknown }>(node: T, into: Array<unknown>) => {
    node.connect = (next: unknown) => (into.push(next), next)
    return node
  }
  proto.createGain = function(this: unknown) {
    const node = makeGain.call(this) as { gain: { value: number }; connect: (n: unknown) => unknown }
    const entry = { gain: node.gain, targets: [] as Array<unknown> }
    gains.push(entry)
    return recording(node, entry.targets)
  }
  proto.createAnalyser = function(this: unknown) {
    const node = makeAnalyser.call(this) as { connect: (n: unknown) => unknown }
    const entry = { targets: [] as Array<unknown> }
    analysers.push(entry)
    return recording(node, entry.targets)
  }
})

const startOptions = { micDeviceId: "", sinkId: "", outputPath: "direct" as const, prebufferMs: 60 }
const started = async (audio: VoiceAudio) => {
  const ready = audio.start(startOptions)
  fake.pending[0]!.resolve()
  await ready
}

describe("the reply volume on the voice page", () => {
  it("a gain node after the analyser, before the output; set before start, applied at start; changed live", async () => {
    const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: () => undefined, onState: () => undefined })
    audio.setReplyVolume(0.4)
    expect(audio.replyGain()).toBe(0.4)
    await started(audio)
    // The capture graph has its own silent gain; the reply volume is the one the analyser feeds.
    const volume = gains.find((g) => analysers[0]!.targets.includes(gainNodeOf(g)))
    expect(volume).toBeDefined()
    expect(volume!.gain.value).toBe(0.4)
    // The gain node feeds the output (the destination, for the direct path), the analyser only the gain.
    expect(analysers[0]!.targets).toHaveLength(1)
    expect(volume!.targets).toHaveLength(1)
    audio.setReplyVolume(0.8)
    expect(volume!.gain.value).toBe(0.8)
    audio.setReplyVolume(Number.NaN)
    expect(audio.replyGain()).toBe(0.8)
    audio.setReplyVolume(7)
    expect(volume!.gain.value).toBe(1)
    audio.setReplyVolume(-1)
    expect(volume!.gain.value).toBe(0)
    // Kept across sessions: a new graph starts at the level in force.
    await audio.stop()
    audio.setReplyVolume(0.6)
    const before = gains.length
    const ready = audio.start(startOptions)
    fake.pending[1]!.resolve()
    await ready
    expect(gains.slice(before).some((g) => g.gain.value === 0.6)).toBe(true)
  })

  it("replyGain clamps", () => {
    expect([replyGain(-0.5), replyGain(0.25), replyGain(3)]).toEqual([0, 0.25, 1])
  })
})

/** The node object a recorded gain belongs to (the recording keeps the node's `gain` object). */
const gainNodeOf = (g: { gain: { value: number } }) =>
  analysers.flatMap((a) => a.targets).find((t) => (t as { gain?: unknown }).gain === g.gain)
