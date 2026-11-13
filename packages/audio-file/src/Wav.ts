import { AudioError } from "@pva/core"

/** 16-bit little-endian PCM with its format. */
export interface Pcm16 {
  readonly sampleRate: number
  readonly channels: number
  /** Interleaved s16le samples. */
  readonly data: Uint8Array
}

const ascii = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))

/** 32-bit float samples (clamped to [-1, 1]) → s16le. */
const floatToS16 = (bytes: Uint8Array): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Int16Array(bytes.length / 4)
  for (let i = 0; i < out.length; i++) {
    const x = Math.max(-1, Math.min(1, view.getFloat32(i * 4, true)))
    out[i] = Math.round(x < 0 ? x * 32768 : x * 32767)
  }
  return new Uint8Array(out.buffer)
}

/**
 * Parse a RIFF/WAVE file holding 16-bit integer PCM or 32-bit float samples
 * (plain or WAVE_FORMAT_EXTENSIBLE); float is converted to 16-bit. Anything
 * else throws an `AudioError` that says why.
 */
export const parseWav = (bytes: Uint8Array): Pcm16 => {
  const fail = (why: string) => new AudioError({ message: `unsupported WAV: ${why}` })
  if (bytes.length < 12 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") throw fail("not a RIFF/WAVE file")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let format: { sampleRate: number; channels: number } | undefined
  let float = false
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = ascii(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === "fmt ") {
      if (size < 16) throw fail("fmt chunk too short")
      let tag = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (tag === 0xfffe && size >= 40) tag = view.getUint16(body + 24, true)
      const bits = view.getUint16(body + 14, true)
      float = tag === 3 && bits === 32
      if (tag !== 1 && !float) throw fail(`format tag ${tag} is neither integer PCM nor 32-bit float`)
      if (tag === 1 && bits !== 16) throw fail(`${bits}-bit samples (only 16-bit integer or 32-bit float is supported)`)
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true) }
    } else if (id === "data") {
      if (format === undefined) throw fail("data chunk before fmt chunk")
      // Streamed WAVs may carry a placeholder size; take what is there.
      const end = Math.min(body + size, bytes.length)
      const frame = (float ? 4 : 2) * format.channels
      const usable = end - body - ((end - body) % frame)
      const data = bytes.slice(body, body + usable)
      return { ...format, data: float ? floatToS16(data) : data }
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  throw fail(format === undefined ? "no fmt chunk" : "no data chunk")
}

/** A canonical 44-byte header for 16-bit PCM. */
export const wavHeader = (sampleRate: number, channels: number, dataBytes: number): Uint8Array => {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  header.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0)
  view.setUint32(4, 36 + dataBytes, true)
  header.set([..."WAVEfmt "].map((c) => c.charCodeAt(0)), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  header.set([..."data"].map((c) => c.charCodeAt(0)), 36)
  view.setUint32(40, dataBytes, true)
  return header
}

/** Header + data. */
export const encodeWav = (pcm: Pcm16): Uint8Array => {
  const out = new Uint8Array(44 + pcm.data.length)
  out.set(wavHeader(pcm.sampleRate, pcm.channels, pcm.data.length))
  out.set(pcm.data, 44)
  return out
}
