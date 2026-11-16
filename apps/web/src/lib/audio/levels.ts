/**
 * Audio levels for the stage: a plain mutable object written by the audio
 * code and read on every animation frame. Never part of React state.
 */
export interface Levels {
  /** RMS (0..1) of the latest 20 ms microphone frame. */
  micRms: number
  /** `performance.now()` of that frame. */
  micAt: number
  /**
   * The latest microphone samples (−1..1), a ring: sample `n` (counting from the first frame) is at
   * `n % mic.length`. Written once per 20 ms frame; the stage's character host reads the last 40 ms.
   */
  readonly mic: Float32Array
  /** Samples written to `mic` so far. */
  micWritten: number
  /** Sample rate of `mic` (the capture worklet's rate). */
  micRate: number
  /** Tap on the player's output (time-domain level and bands), while audio runs. */
  outAnalyser: AnalyserNode | null
  /** `performance.now()` of the last interruption (local Stop or an interrupted turn): the amber line collapses fast. */
  interruptedAt: number
}

/** 256 ms at 16 kHz: room for a few frames more than the 40 ms the host reads. */
export const MIC_RING = 4096

export const levels: Levels = { micRms: 0, micAt: 0, mic: new Float32Array(MIC_RING), micWritten: 0, micRate: 16_000, outAnalyser: null, interruptedAt: -Infinity }

/** RMS of a 16-bit PCM frame, normalised to 0..1. */
export const frameRms = (pcm: Int16Array): number => {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]! / 32768
    sum += s * s
  }
  return pcm.length === 0 ? 0 : Math.sqrt(sum / pcm.length)
}

/** One microphone frame: its level, and its samples into the ring (one pass, no allocation). */
export const pushMicFrame = (pcm: Int16Array, now: number = performance.now(), rate = 16_000) => {
  const ring = levels.mic
  let w = levels.micWritten % ring.length
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]! / 32768
    sum += s * s
    ring[w] = s
    w = w + 1 === ring.length ? 0 : w + 1
  }
  levels.micWritten += pcm.length
  levels.micRms = pcm.length === 0 ? 0 : Math.sqrt(sum / pcm.length)
  levels.micAt = now
  levels.micRate = rate
}

/** Frames older than this count as stopped (muted, stalled). */
const MIC_STALE_MS = 120

/** The microphone level, decayed to 0 when frames stop (muted, stalled). */
export const currentMicRms = (now: number): number => (now - levels.micAt > MIC_STALE_MS ? 0 : levels.micRms)

/**
 * Copy the latest `out.length` microphone samples into `out` (zeros where there are none yet). Returns false,
 * leaving `out` untouched, when frames have stopped (muted, stalled): the caller treats that as silence.
 */
export const readMicWindow = (out: Float32Array, now: number): boolean => {
  if (now - levels.micAt > MIC_STALE_MS || levels.micWritten === 0) return false
  const ring = levels.mic
  const n = Math.min(out.length, levels.micWritten, ring.length)
  const pad = out.length - n
  if (pad > 0) out.fill(0, 0, pad)
  let r = (levels.micWritten - n) % ring.length
  for (let i = pad; i < out.length; i++) {
    out[i] = ring[r]!
    r = r + 1 === ring.length ? 0 : r + 1
  }
  return true
}

export const markInterrupted = (now: number = performance.now()) => {
  levels.interruptedAt = now
}
