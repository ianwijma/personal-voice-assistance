import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const fakeMicPath = join(dirname(fileURLToPath(import.meta.url)), ".fixtures", "speech.wav")

/**
 * A 48 kHz mono WAV for Chromium's fake microphone: 4 s of a speech-like
 * amplitude-modulated tone (≈ −16 dBFS) then 2 s of near-silence, looped by Chromium.
 */
export const writeFakeMic = () => {
  const rate = 48_000
  const seconds = 6
  const n = rate * seconds
  const data = Buffer.alloc(n * 2)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    let s = 0
    if (t < 4) {
      const pitch = 140 + 30 * Math.sin(2 * Math.PI * 0.5 * t)
      phase += (2 * Math.PI * pitch) / rate
      const env = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 0.7
      s = 0.16 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase))
    } else {
      s = 0.0005 * Math.sin(2 * Math.PI * 50 * t)
    }
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  mkdirSync(dirname(fakeMicPath), { recursive: true })
  writeFileSync(fakeMicPath, Buffer.concat([header, data]))
}
