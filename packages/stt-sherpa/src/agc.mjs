// Automatic gain control for the recogniser's input, per 20 ms frame, in place.
// Plain JavaScript: it runs in the worker thread (see worker.mjs).
//
// From docs/research/stt-quality.md §2.4 (instant attack, ~6 s release, at most
// +30 dB, no gain change below a -48 dBFS peak), plus one protection the study
// did not have: the gain is capped so the estimated noise floor (the quietest
// 20 ms frame of the last ~5 s) is not raised above -50 dBFS RMS. So steady
// background noise, the server's -75 dBFS noise floor, a fan or a quiet room
// tone cannot be pumped up into something the VAD takes for speech; quiet speech
// over a quiet floor still gets its full gain.

const dbToAmp = (db) => 10 ** (db / 20)

/**
 * @param {{ targetDbfs?: number, maxGainDb?: number, minPeakDbfs?: number, noiseCeilingDbfs?: number,
 *           releaseSeconds?: number, riseDbPerSecond?: number, frameSamples?: number }} [options]
 */
export const makeAgc = (options = {}) => {
  const frameSeconds = (options.frameSamples ?? 320) / 16000
  const target = dbToAmp(options.targetDbfs ?? -12)
  const maxGain = dbToAmp(options.maxGainDb ?? 30)
  const minPeak = dbToAmp(options.minPeakDbfs ?? -48)
  const noiseCeiling = dbToAmp(options.noiseCeilingDbfs ?? -50)
  // Peak envelope decays to 1/e in `releaseSeconds` (0.9985 per frame ≈ 13 s to -60 dB, as in the study).
  const release = Math.exp(-frameSeconds / (options.releaseSeconds ?? 13.3))
  const rise = dbToAmp((options.riseDbPerSecond ?? 8.6) * frameSeconds)

  // Noise floor: minimum frame RMS over 10 blocks of 25 frames (5 s).
  const BLOCK = 25
  const blocks = new Float64Array(10).fill(Infinity)
  let blockMin = Infinity
  let blockCount = 0
  let blockIndex = 0

  let env = 0
  let gain = 1

  const floor = () => {
    let m = blockMin
    for (const b of blocks) if (b < m) m = b
    return m
  }

  /** @param {Float32Array} frame */
  const process = (frame) => {
    let peak = 0
    let sum = 0
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i]
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      sum += v * v
    }
    const rms = Math.sqrt(sum / frame.length)
    if (rms < blockMin) blockMin = rms
    if (++blockCount === BLOCK) {
      blocks[blockIndex] = blockMin
      blockIndex = (blockIndex + 1) % blocks.length
      blockMin = Infinity
      blockCount = 0
    }
    const noise = floor()
    const noiseCap = noise > 0 && Number.isFinite(noise) ? Math.max(1, noiseCeiling / noise) : maxGain

    env = Math.max(peak, env * release)
    if (env > minPeak) {
      const want = Math.min(maxGain, noiseCap, Math.max(1, target / env))
      gain = want < gain ? want : Math.min(want, gain * rise)
    } else if (gain > noiseCap) {
      gain = noiseCap
    }
    if (gain !== 1) {
      for (let i = 0; i < frame.length; i++) {
        const v = frame[i] * gain
        frame[i] = v > 1 ? 1 : v < -1 ? -1 : v
      }
    }
  }

  return {
    process,
    /** Current gain in dB. */
    gainDb: () => 20 * Math.log10(gain),
    /** Estimated noise floor (dBFS RMS of the quietest recent frame). */
    noiseFloorDbfs: () => 20 * Math.log10(Math.max(floor(), 1e-9)),
    reset: () => {
      env = 0
      gain = 1
      blocks.fill(Infinity)
      blockMin = Infinity
      blockCount = 0
      blockIndex = 0
    }
  }
}
