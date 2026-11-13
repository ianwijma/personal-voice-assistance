/**
 * Audio levels for the visualiser: a plain mutable object written by the audio
 * code and read on every animation frame. Never part of React state.
 */
export interface Levels {
  /** RMS (0..1) of the latest 20 ms microphone frame. */
  micRms: number
  /** `performance.now()` of that frame. */
  micAt: number
  /** Tap on the player's output (time-domain level and bands), while audio runs. */
  outAnalyser: AnalyserNode | null
  /** `performance.now()` of the last interruption (local Stop or an interrupted turn): the amber line collapses fast. */
  interruptedAt: number
}

export const levels: Levels = { micRms: 0, micAt: 0, outAnalyser: null, interruptedAt: -Infinity }

/** RMS of a 16-bit PCM frame, normalised to 0..1. */
export const frameRms = (pcm: Int16Array): number => {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]! / 32768
    sum += s * s
  }
  return pcm.length === 0 ? 0 : Math.sqrt(sum / pcm.length)
}

export const pushMicFrame = (pcm: Int16Array, now: number = performance.now()) => {
  levels.micRms = frameRms(pcm)
  levels.micAt = now
}

/** The microphone level, decayed to 0 when frames stop (muted, stalled). */
export const currentMicRms = (now: number): number => (now - levels.micAt > 120 ? 0 : levels.micRms)

export const markInterrupted = (now: number = performance.now()) => {
  levels.interruptedAt = now
}
