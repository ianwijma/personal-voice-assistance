/**
 * Level and band statistics of 16 kHz mono speech audio, to tell "the audio is
 * bad" from "the model is bad" (docs/research/stt-quality.md §1.4 and its
 * appendix, whose reference analyser this follows).
 *
 * 20 ms frame RMS; noise floor = 10th percentile of frame RMS; speech frames =
 * RMS above max(floor + 12 dB, 90th percentile − 20 dB); 512-point Hann FFT
 * (50 % overlap) averaged over speech frames; roll-off = the frequency below
 * which 99 % of the speech energy lies.
 */

export interface LevelStats {
  readonly seconds: number
  readonly peakDbfs: number
  readonly rmsDbfs: number
  readonly speechRmsDbfs: number
  readonly noiseFloorDbfs: number
  readonly snrDb: number
  readonly clippedPct: number
  readonly dcOffset: number
  readonly speechFramesPct: number
  /** Estimated bandwidth: 99 % of the speech energy lies below this. */
  readonly rolloff99Hz: number
  readonly energyAbove3400Pct: number
  readonly energyAbove5000Pct: number
  /** Plain-language findings ("too quiet", "narrowband", ...), or "levels and band look fine". */
  readonly verdict: ReadonlyArray<string>
}

const FRAME = 320
const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9))
const round = (v: number, digits = 1) => Number.isFinite(v) ? Number(v.toFixed(digits)) : v

const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const p = i + k
        const q = p + len / 2
        const tr = re[q]! * cr - im[q]! * ci
        const ti = re[q]! * ci + im[q]! * cr
        re[q] = re[p]! - tr
        im[q] = im[p]! - ti
        re[p] = re[p]! + tr
        im[p] = im[p]! + ti
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

export const levelStats = (pcm: Int16Array): LevelStats => {
  const n = pcm.length
  const frames = Math.floor(n / FRAME)
  const x = Float32Array.from(pcm, (v) => v / 32768)
  let peak = 0
  let clipped = 0
  let sum = 0
  let energy = 0
  for (const v of x) {
    const a = Math.abs(v)
    if (a > peak) peak = a
    if (a >= 0.9995) clipped++
    sum += v
    energy += v * v
  }
  const rms: Array<number> = []
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let j = 0; j < FRAME; j++) s += x[f * FRAME + j]! ** 2
    rms.push(db(Math.sqrt(s / FRAME)))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? -180
  const floor = pct(0.1)
  const top = pct(0.9)
  const speech = rms.flatMap((r, i) => (r > Math.max(floor + 12, top - 20) ? [i] : []))
  const speechRms = speech.length > 0 ? 10 * Math.log10(speech.reduce((a, i) => a + 10 ** (rms[i]! / 10), 0) / speech.length) : NaN

  const power = new Float64Array(257)
  const re = new Float64Array(512)
  const im = new Float64Array(512)
  for (const f of speech) {
    for (let off = 0; off + 512 <= FRAME * 2 && f * FRAME + off + 512 <= n; off += 256) {
      for (let k = 0; k < 512; k++) {
        re[k] = x[f * FRAME + off + k]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / 511))
        im[k] = 0
      }
      fft(re, im)
      for (let k = 0; k <= 256; k++) power[k] = power[k]! + re[k]! ** 2 + im[k]! ** 2
    }
  }
  const total = power.reduce((a, b) => a + b, 1e-30)
  const below = (hz: number) => {
    let c = 0
    for (let k = 0; k <= 256; k++) if (k * 31.25 <= hz) c += power[k]!
    return c / total
  }
  let rolloff = 8000
  let c = 0
  for (let k = 0; k <= 256; k++) {
    c += power[k]!
    if (c / total >= 0.99) {
      rolloff = k * 31.25
      break
    }
  }

  const stats = {
    seconds: round(n / 16000, 2),
    peakDbfs: round(db(peak)),
    rmsDbfs: round(10 * Math.log10(energy / Math.max(1, n) + 1e-18)),
    speechRmsDbfs: round(speechRms),
    noiseFloorDbfs: round(floor),
    snrDb: round(speechRms - floor),
    clippedPct: round((100 * clipped) / Math.max(1, n), 3),
    dcOffset: round(sum / Math.max(1, n), 5),
    speechFramesPct: round((100 * speech.length) / Math.max(1, frames), 0),
    rolloff99Hz: Math.round(rolloff),
    energyAbove3400Pct: round(100 * (1 - below(3400)), 2),
    energyAbove5000Pct: round(100 * (1 - below(5000)), 2)
  }
  const verdict: Array<string> = []
  if (stats.peakDbfs < -30) verdict.push("too quiet (peak below -30 dBFS)")
  else if (stats.peakDbfs < -18) verdict.push("quiet (peak below -18 dBFS)")
  if (stats.clippedPct > 0.05) verdict.push("clipping")
  if (speech.length > 0 && rolloff < 4000) verdict.push(`narrowband (energy ends near ${Math.round(rolloff)} Hz: phone or Bluetooth headset)`)
  else if (speech.length > 0 && rolloff < 6500) verdict.push(`band-limited at about ${Math.round(rolloff)} Hz`)
  if (stats.snrDb < 15) verdict.push("noisy (speech less than 15 dB above the noise floor)")
  if (Math.abs(stats.dcOffset) > 0.01) verdict.push("DC offset")
  return { ...stats, verdict: verdict.length > 0 ? verdict : ["levels and band look fine"] }
}

/** One line for the log. */
export const formatLevelStats = (s: LevelStats): string =>
  `peak ${s.peakDbfs} dBFS, speech ${s.speechRmsDbfs} dBFS RMS, floor ${s.noiseFloorDbfs} dBFS, SNR ${s.snrDb} dB, ` +
  `clipped ${s.clippedPct} %, band to ~${(s.rolloff99Hz / 1000).toFixed(1)} kHz (${s.energyAbove3400Pct} % above 3.4 kHz); ${s.verdict.join("; ")}`

/** 16 kHz mono 16-bit WAV. */
export const wavBytes = (pcm: Int16Array, sampleRate = 16000): Uint8Array => {
  const out = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, pcm.byteLength, true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44)
  return out
}
