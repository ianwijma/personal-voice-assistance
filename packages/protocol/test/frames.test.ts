import { describe, expect, it } from "vitest"
import {
  decodeFrame,
  decodeMicFrame,
  decodeReplyFrame,
  encodeMicFrame,
  encodeReplyFrame,
  FRAME_HEADER_BYTES,
  FrameKind,
  MAX_FRAME_PAYLOAD_BYTES,
  MIC_FRAME_SAMPLES,
  micSequenceGap,
  pcmSamples,
  writeFrameHeader
} from "../src/index.ts"

const pcm = (samples: ReadonlyArray<number>) => new Uint8Array(Int16Array.from(samples).buffer)

describe("binary frames", () => {
  it("lays out the header exactly as specified", () => {
    const frame = encodeReplyFrame(0x0102_0304, pcm([1, -2]))
    expect(Array.from(frame)).toEqual([
      2, 0, 0, 0, // kind, reserved
      0x04, 0x03, 0x02, 0x01, // turn id, little-endian
      1, 0, 0xfe, 0xff // samples 1 and -2, s16le
    ])
  })

  it("round-trips a 20 ms microphone frame", () => {
    const samples = Array.from({ length: MIC_FRAME_SAMPLES }, (_, i) => Math.round(Math.sin(i / 5) * 12_000))
    const frame = encodeMicFrame(7, pcm(samples))
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES + MIC_FRAME_SAMPLES * 2)
    const decoded = decodeMicFrame(frame)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.frame.seq).toBe(7)
    expect(Array.from(pcmSamples(decoded.frame.pcm))).toEqual(samples)
  })

  it("round-trips a reply frame and returns a view, not a copy", () => {
    const frame = encodeReplyFrame(12, pcm([100, 200, 300]))
    const decoded = decodeReplyFrame(frame.buffer)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.frame.turnId).toBe(12)
    expect(decoded.frame.pcm.buffer).toBe(frame.buffer)
    expect(decoded.frame.pcm.byteOffset).toBe(FRAME_HEADER_BYTES)
    expect(Array.from(pcmSamples(decoded.frame.pcm))).toEqual([100, 200, 300])
  })

  it("supports zero-copy sending: header written into a buffer that already holds the PCM", () => {
    const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + 4)
    new Int16Array(buffer, FRAME_HEADER_BYTES).set([5, -5])
    writeFrameHeader(new Uint8Array(buffer), FrameKind.mic, 0xffff_ffff)
    const decoded = decodeFrame(buffer)
    expect(decoded).toMatchObject({ ok: true, frame: { kind: "mic", seq: 0xffff_ffff } })
  })

  it("decodes a frame inside a larger buffer at an odd offset (Node's pooled buffers)", () => {
    const frame = encodeReplyFrame(3, pcm([42, -42]))
    const pool = new Uint8Array(frame.byteLength + 3)
    pool.set(frame, 1)
    const decoded = decodeFrame(pool.subarray(1, 1 + frame.byteLength))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.frame.pcm.byteOffset % 2).toBe(1)
    expect(Array.from(pcmSamples(decoded.frame.pcm))).toEqual([42, -42])
  })

  it("ignores the reserved bytes", () => {
    const frame = encodeMicFrame(1, pcm([1]))
    frame[1] = 0xaa
    frame[2] = 0xbb
    frame[3] = 0xcc
    expect(decodeFrame(frame)).toMatchObject({ ok: true, frame: { kind: "mic", seq: 1 } })
  })

  it("rejects malformed frames", () => {
    expect(decodeFrame(new Uint8Array(4))).toMatchObject({ ok: false })
    expect(decodeFrame(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]))).toMatchObject({ ok: false, error: "empty audio payload" })
    expect(decodeFrame(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 9]))).toMatchObject({ ok: false })
    expect(decodeFrame(new Uint8Array([9, 0, 0, 0, 0, 0, 0, 0, 1, 2]))).toMatchObject({ ok: false, error: "unknown frame kind 9" })
    expect(decodeFrame(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 1, 2]))).toMatchObject({ ok: false, error: "reply frame with turn id 0" })
    expect(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES + 2).fill(1, 0, 1))).toMatchObject({ ok: false })
  })

  it("enforces direction", () => {
    expect(decodeMicFrame(encodeReplyFrame(1, pcm([1])))).toMatchObject({ ok: false })
    expect(decodeReplyFrame(encodeMicFrame(1, pcm([1])))).toMatchObject({ ok: false })
  })

  it("refuses to encode invalid frames", () => {
    expect(() => encodeMicFrame(-1, pcm([1]))).toThrow(RangeError)
    expect(() => encodeMicFrame(2 ** 32, pcm([1]))).toThrow(RangeError)
    expect(() => encodeReplyFrame(0, pcm([1]))).toThrow(RangeError)
    expect(() => encodeReplyFrame(1.5, pcm([1]))).toThrow(RangeError)
    expect(() => encodeReplyFrame(1, new Uint8Array(0))).toThrow(RangeError)
    expect(() => encodeReplyFrame(1, new Uint8Array(3))).toThrow(RangeError)
    expect(() => writeFrameHeader(new Uint8Array(4), FrameKind.mic, 0)).toThrow(RangeError)
  })
})

describe("micSequenceGap", () => {
  it("counts lost frames, including across the u32 wrap", () => {
    expect(micSequenceGap(undefined, 5)).toBe(0)
    expect(micSequenceGap(4, 5)).toBe(0)
    expect(micSequenceGap(4, 9)).toBe(4)
    expect(micSequenceGap(0xffff_ffff, 0)).toBe(0)
    expect(micSequenceGap(0xffff_fffe, 1)).toBe(2)
  })
  it("treats a repeated or backwards number as no gap", () => {
    expect(micSequenceGap(5, 5)).toBe(0)
    expect(micSequenceGap(9, 4)).toBe(0)
  })
})
