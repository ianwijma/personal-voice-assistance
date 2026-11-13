import { FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES } from "./constants.ts"

/**
 * Binary frames carry audio. Every frame starts with an 8-byte header:
 *
 * | offset | size | field                                                        |
 * |--------|------|--------------------------------------------------------------|
 * | 0      | u8   | kind: 1 = microphone audio (browser → assistant),            |
 * |        |      |       2 = reply audio (assistant → browser)                  |
 * | 1      | u8   | reserved: senders write 0, receivers ignore                  |
 * | 2      | u16  | reserved: senders write 0, receivers ignore                  |
 * | 4      | u32  | little-endian. kind 1: frame sequence number (0 at the first |
 * |        |      | frame after `mic.state {live:true}` or `audio.claim`; wraps  |
 * |        |      | at 2^32). kind 2: the reply's turn id.                       |
 * | 8      | ...  | PCM, signed 16-bit little-endian, mono. Kind 1: 16 kHz.      |
 * |        |      | Kind 2: the rate from the reply's `reply.start`. Non-empty,  |
 * |        |      | even length, at most `MAX_FRAME_PAYLOAD_BYTES`.              |
 *
 * The header never forces a copy: a sender allocates `FRAME_HEADER_BYTES + n`
 * and writes the PCM after the header (`writeFrameHeader`); a receiver takes a
 * view of the payload (`decodeFrame` returns a view, not a copy). The header is
 * 8 bytes so the payload stays aligned for `Int16Array` when the buffer is.
 */
export const FrameKind = { mic: 1, reply: 2 } as const
export type FrameKind = typeof FrameKind[keyof typeof FrameKind]

export interface MicFrame {
  readonly kind: "mic"
  readonly seq: number
  /** A view into the received buffer (no copy). */
  readonly pcm: Uint8Array
}

export interface ReplyFrame {
  readonly kind: "reply"
  readonly turnId: number
  /** A view into the received buffer (no copy). */
  readonly pcm: Uint8Array
}

export type Frame = MicFrame | ReplyFrame

export type FrameResult<F> =
  | { readonly ok: true; readonly frame: F }
  | { readonly ok: false; readonly error: string }

const U32_MAX = 0xffff_ffff

const checkU32 = (name: string, value: number, min: number) => {
  if (!Number.isInteger(value) || value < min || value > U32_MAX) {
    throw new RangeError(`${name} must be an integer from ${min} to ${U32_MAX}, got ${value}`)
  }
}

const checkPayloadLength = (length: number): string | undefined =>
  length === 0
    ? "empty audio payload"
    : length % 2 !== 0
    ? `audio payload has an odd length (${length} bytes)`
    : length > MAX_FRAME_PAYLOAD_BYTES
    ? `audio payload too large (${length} bytes, limit ${MAX_FRAME_PAYLOAD_BYTES})`
    : undefined

/**
 * Write a header into the first 8 bytes of `target` (which must be at least
 * 8 bytes long). `id` is the sequence number (mic) or the turn id (reply).
 */
export const writeFrameHeader = (target: Uint8Array, kind: FrameKind, id: number): void => {
  if (target.byteLength < FRAME_HEADER_BYTES) throw new RangeError("target is shorter than the frame header")
  if (kind !== FrameKind.mic && kind !== FrameKind.reply) throw new RangeError(`unknown frame kind ${String(kind)}`)
  checkU32(kind === FrameKind.mic ? "seq" : "turnId", id, kind === FrameKind.mic ? 0 : 1)
  const view = new DataView(target.buffer, target.byteOffset, FRAME_HEADER_BYTES)
  view.setUint8(0, kind)
  view.setUint8(1, 0)
  view.setUint16(2, 0, true)
  view.setUint32(4, id, true)
}

const encode = (kind: FrameKind, id: number, pcm: Uint8Array): Uint8Array<ArrayBuffer> => {
  const problem = checkPayloadLength(pcm.byteLength)
  if (problem !== undefined) throw new RangeError(problem)
  const frame = new Uint8Array(FRAME_HEADER_BYTES + pcm.byteLength)
  writeFrameHeader(frame, kind, id)
  frame.set(pcm, FRAME_HEADER_BYTES)
  return frame
}

/** A microphone frame (copies `pcm` once into a new buffer). `seq` must already be wrapped to u32. */
export const encodeMicFrame = (seq: number, pcm: Uint8Array): Uint8Array<ArrayBuffer> => encode(FrameKind.mic, seq, pcm)

/** A reply audio frame (copies `pcm` once into a new buffer). */
export const encodeReplyFrame = (turnId: number, pcm: Uint8Array): Uint8Array<ArrayBuffer> => encode(FrameKind.reply, turnId, pcm)

const asBytes = (data: ArrayBuffer | Uint8Array): Uint8Array => data instanceof Uint8Array ? data : new Uint8Array(data)

/** Decode any frame. The payload is a view into `data`. */
export const decodeFrame = (data: ArrayBuffer | Uint8Array): FrameResult<Frame> => {
  const bytes = asBytes(data)
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    return { ok: false, error: `frame shorter than its ${FRAME_HEADER_BYTES}-byte header (${bytes.byteLength} bytes)` }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_BYTES)
  const kind = view.getUint8(0)
  const id = view.getUint32(4, true)
  const pcm = bytes.subarray(FRAME_HEADER_BYTES)
  const problem = checkPayloadLength(pcm.byteLength)
  if (problem !== undefined) return { ok: false, error: problem }
  switch (kind) {
    case FrameKind.mic:
      return { ok: true, frame: { kind: "mic", seq: id, pcm } }
    case FrameKind.reply:
      if (id === 0) return { ok: false, error: "reply frame with turn id 0" }
      return { ok: true, frame: { kind: "reply", turnId: id, pcm } }
    default:
      return { ok: false, error: `unknown frame kind ${kind}` }
  }
}

/** For the assistant: only microphone frames are valid from a browser. */
export const decodeMicFrame = (data: ArrayBuffer | Uint8Array): FrameResult<MicFrame> => {
  const result = decodeFrame(data)
  if (!result.ok) return result
  return result.frame.kind === "mic" ? { ok: true, frame: result.frame } : { ok: false, error: "expected a microphone frame" }
}

/** For the browser: only reply frames are valid from the assistant. */
export const decodeReplyFrame = (data: ArrayBuffer | Uint8Array): FrameResult<ReplyFrame> => {
  const result = decodeFrame(data)
  if (!result.ok) return result
  return result.frame.kind === "reply" ? { ok: true, frame: result.frame } : { ok: false, error: "expected a reply frame" }
}

/**
 * Microphone frames lost between two sequence numbers (0 when `current`
 * follows `previous`, or when there is no previous frame). Wrap-around at 2^32
 * is handled; a duplicate or out-of-order number (impossible on one WebSocket
 * unless the sender restarted its count) counts as no gap.
 */
export const micSequenceGap = (previous: number | undefined, current: number): number => {
  if (previous === undefined) return 0
  const gap = (current - previous - 1) >>> 0
  return gap >= 0x8000_0000 ? 0 : gap
}

/**
 * The payload as 16-bit samples. A view when the payload is 2-byte aligned
 * (always the case for buffers this package allocates); otherwise a copy.
 * Assumes a little-endian platform, as every browser and Node target is.
 */
export const pcmSamples = (pcm: Uint8Array): Int16Array =>
  pcm.byteOffset % 2 === 0
    ? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
    : new Int16Array(pcm.slice().buffer, 0, pcm.byteLength >> 1)
