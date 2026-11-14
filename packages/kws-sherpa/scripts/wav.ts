/** Minimal 16-bit PCM WAV reading / writing (mono or first channel), with linear resampling to 16 kHz. */
import { readFileSync, writeFileSync } from "node:fs"

export const readWav16k = (path: string): Float32Array => {
  const b = readFileSync(path)
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path}: not a WAV`)
  let pos = 12
  let channels = 1
  let rate = 16000
  let bits = 16
  let fmt = 1
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4)
    const size = b.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === "fmt ") {
      fmt = b.readUInt16LE(body)
      channels = b.readUInt16LE(body + 2)
      rate = b.readUInt32LE(body + 4)
      bits = b.readUInt16LE(body + 14)
    } else if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - body) / (bits / 8) / channels)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const o = body + i * channels * (bits / 8)
        out[i] = fmt === 3 && bits === 32 ? b.readFloatLE(o) : bits === 16 ? b.readInt16LE(o) / 32768 : b.readInt32LE(o) / 2147483648
      }
      return resample(out, rate, 16000)
    }
    pos = body + size + (size % 2)
  }
  throw new Error(`${path}: no data chunk`)
}

export const resample = (x: Float32Array, from: number, to: number): Float32Array => {
  if (from === to) return x
  const n = Math.floor((x.length * to) / from)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (i * from) / to
    const j = Math.floor(t)
    const f = t - j
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f
  }
  return out
}

export const writeWav16k = (path: string, x: Float32Array): void => {
  const b = Buffer.alloc(44 + x.length * 2)
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVE", 8, "ascii")
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write("data", 36, "ascii"); b.writeUInt32LE(x.length * 2, 40)
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((x[i] ?? 0) * 32767))), 44 + i * 2)
  writeFileSync(path, b)
}
