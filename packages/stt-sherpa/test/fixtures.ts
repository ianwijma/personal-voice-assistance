/** Test audio: WAV loading, timelines of utterances and silence, real-time paced streams. */
import { Effect, Queue, Stream } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { defaultModelDir } from "../src/presets.ts"

export const BYTES_PER_MS = 32
export const CHUNK_BYTES = 640 // 20 ms

/** Test WAVs and reference texts (from the sherpa-onnx test sets and FLEURS), see README. */
export const wavDir = join(defaultModelDir, "test-wavs")

export const references = (): Record<string, string> => {
  const read = (file: string) => existsSync(join(wavDir, file)) ? JSON.parse(readFileSync(join(wavDir, file), "utf8")) : {}
  return { ...read("refs.json"), ...read("refs_nl.json") }
}

/** 16 kHz mono WAV (16-bit PCM or 32-bit float) → raw s16le bytes. */
export const readWav = (path: string): Uint8Array => {
  const file = readFileSync(path)
  let offset = 12
  let format: { tag: number; channels: number; rate: number; bits: number } | undefined
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4)
    const size = file.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === "fmt ") {
      format = { tag: file.readUInt16LE(body), channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) }
    } else if (id === "data") {
      const length = Math.min(size, file.length - body)
      if (format?.channels === 1 && format.rate === 16000 && format.tag === 1 && format.bits === 16) {
        return new Uint8Array(file.buffer, file.byteOffset + body, length)
      }
      if (format?.channels === 1 && format.rate === 16000 && format.tag === 3 && format.bits === 32) {
        const pcm = new Int16Array(length / 4)
        for (let i = 0; i < pcm.length; i++) {
          pcm[i] = Math.max(-32768, Math.min(32767, Math.round(file.readFloatLE(body + i * 4) * 32768)))
        }
        return new Uint8Array(pcm.buffer)
      }
      throw new Error(`${path}: expected 16 kHz mono 16-bit PCM or 32-bit float`)
    }
    offset = body + size + (size & 1)
  }
  throw new Error(`${path}: no data chunk`)
}

/**
 * Speech span in ms from the start of `pcm`: the first 20 ms frame within 15 dB of
 * the loudest frame (stricter, so background or breath before the first word does
 * not count) to the end of the last frame within 25 dB of it.
 */
export const speechSpanMs = (pcm: Uint8Array): { start: number; end: number } => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const energy: Array<number> = []
  for (let frame = 0; (frame + 1) * CHUNK_BYTES <= pcm.length; frame++) {
    let sum = 0
    for (let i = frame * CHUNK_BYTES; i < (frame + 1) * CHUNK_BYTES; i += 2) sum += view.getInt16(i, true) ** 2
    energy.push(sum)
  }
  const peak = Math.max(...energy)
  return {
    start: energy.findIndex((e) => e >= peak / 10 ** 1.5) * 20,
    end: (energy.findLastIndex((e) => e >= peak / 10 ** 2.5) + 1) * 20
  }
}

/**
 * Silence for the timeline: white noise at about -70 dBFS (deterministic).
 * Not digital zeros: Silero reports phantom speech on long runs of exact zeros,
 * which a real microphone never produces.
 */
export const silence = (ms: number): Uint8Array => {
  const samples = new Int16Array(Math.round(ms * 16))
  let seed = 1
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    samples[i] = ((seed >>> 16) % 21) - 10
  }
  return new Uint8Array(samples.buffer)
}

export interface Utterance {
  readonly name: string
  /** Position of the utterance's first and last loud frames in the timeline. */
  readonly speechStartMs: number
  readonly speechEndMs: number
}

/**
 * Scale so the loudest 20 ms frame is at -18 dBFS (about where the English test
 * clips already are). The FLEURS clips peak near -40 dBFS, too quiet for Silero
 * to track reliably; a real microphone chain should deliver a normal level.
 */
export const normalizeLevel = (pcm: Uint8Array): Uint8Array => {
  const samples = new Int16Array(pcm.slice().buffer)
  let peak = 0
  for (let start = 0; start + 320 <= samples.length; start += 320) {
    let sum = 0
    for (let i = start; i < start + 320; i++) sum += samples[i]! ** 2
    peak = Math.max(peak, Math.sqrt(sum / 320) / 32768)
  }
  const gain = peak > 0 ? 10 ** (-18 / 20) / peak : 1
  for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * gain)))
  return new Uint8Array(samples.buffer)
}

/**
 * Concatenate WAV files and silences (ms) into one recording. Files are names in `wavDir`, level-normalised,
 * unless `options.dir` is given: then they are paths relative to it, at their own level, and the speech span
 * of each is taken from `options.spanDir` (the clean version of the same clip) when given.
 */
export const timeline = (
  parts: ReadonlyArray<string | number>,
  options: { readonly dir?: string; readonly spanDir?: string } = {}
): { pcm: Uint8Array; utterances: Array<Utterance> } => {
  const pieces = parts.map((part) =>
    typeof part === "number"
      ? silence(part)
      : options.dir === undefined
      ? normalizeLevel(readWav(join(wavDir, part)))
      : readWav(join(options.dir, part))
  )
  const pcm = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0))
  const utterances: Array<Utterance> = []
  let offset = 0
  parts.forEach((part, i) => {
    const piece = pieces[i]!
    if (typeof part === "string") {
      const span = speechSpanMs(options.spanDir === undefined ? piece : readWav(join(options.spanDir, part)))
      utterances.push({ name: part, speechStartMs: offset / BYTES_PER_MS + span.start, speechEndMs: offset / BYTES_PER_MS + span.end })
    }
    pcm.set(piece, offset)
    offset += piece.length
  })
  return { pcm, utterances }
}

/**
 * `pcm` as 20 ms chunks at `speed` × real time (absolute schedule, no drift).
 * `t0` receives the `performance.now()` of audio position 0, so audio position
 * `p` ms was handed over at `t0 + p / speed`.
 */
export const pacedAudio = (pcm: Uint8Array, options: { speed?: number; t0?: (t: number) => void } = {}) =>
  Stream.callback<Uint8Array>((queue) =>
    Effect.promise(async () => {
      const speed = options.speed ?? 1
      const t0 = performance.now()
      options.t0?.(t0)
      for (let k = 0; k * CHUNK_BYTES < pcm.length; k++) {
        const wait = t0 + (k * 20) / speed - performance.now()
        if (wait > 1) await sleep(wait)
        Queue.offerUnsafe(queue, pcm.subarray(k * CHUNK_BYTES, (k + 1) * CHUNK_BYTES))
      }
      Queue.endUnsafe(queue)
    })
  )

/** Case, punctuation and whitespace ignored, as `Conversation` compares transcripts. */
export const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean).join(" ")

/** Word errors of `hypothesis` against `reference` (Levenshtein over normalised words). */
export const wordErrors = (reference: string, hypothesis: string): { errors: number; words: number } => {
  const r = normalize(reference).split(" ").filter(Boolean)
  const h = normalize(hypothesis).split(" ").filter(Boolean)
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const row = [i]
    for (let j = 1; j <= h.length; j++) {
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)))
    }
    prev = row
  }
  return { errors: prev[h.length]!, words: r.length }
}

// The study's normalisation (docs/research/stt-quality.md §2.2), so its numbers and these compare: fillers dropped,
// UK → US spellings, number words 0–10 as digits, hyphens split.
const FILLERS = new Set(["um", "uh", "mm", "hmm", "mhm", "er", "erm", "ah", "eh", "uhm", "umm", "mmm", "hm"])
const US: Record<string, string> = {
  dishonoured: "dishonored", honour: "honor", colour: "color", favourite: "favorite", neighbour: "neighbor", centre: "center",
  realise: "realize", organisation: "organization", programme: "program", labour: "labor", behaviour: "behavior", grey: "gray", mum: "mom"
}
const NUMBERS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" }
export const studyWords = (text: string, lang: string): Array<string> => {
  let words = text.toLowerCase().replace(/[‘’`]/g, "'").replace(/[-–—_]/g, " ").replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean)
  if (lang === "en") {
    words = words.filter((w) => !FILLERS.has(w)).map((w) => US[w] ?? w).map((w) => NUMBERS[w] ?? w)
    words = words.join(" ").replace(/for ever/g, "forever").replace(/\bo k\b/g, "okay").replace(/\bok\b/g, "okay").split(" ").filter(Boolean)
  }
  return words
}
export const studyWordErrors = (reference: string, hypothesis: string, lang: string): { errors: number; words: number } => {
  const r = studyWords(reference, lang)
  const h = studyWords(hypothesis, lang)
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const row = [i]
    for (let j = 1; j <= h.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)))
    prev = row
  }
  return { errors: prev[h.length]!, words: r.length }
}
