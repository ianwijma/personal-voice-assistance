// Fake models for recognizerCore.mjs (the stand-in workers and the core's own tests). Plain JavaScript: it runs in
// worker threads, which do not get vitest's TypeScript loader.
//
// - VAD: a frame is speech when its mean absolute amplitude is above 0.05.
// - Online (streaming) recogniser: each 20 ms frame of speech is a "word" named after its amplitude in
//   thousands (`w8` for 8000/32768), so a test can tell which audio a text came from; repeats of the same word in
//   a row count once. Decoding is immediate.
// - Offline recogniser: `decodeAsync` takes `decodeMs`, or never settles while `hang.on` is true (a native decode
//   that does not return; `hang.release()` ends them); the text is `text`, or the words of the audio when `text` is undefined.

export const FRAME = 320

const meanAbs = (samples, from, to) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += Math.abs(samples[i])
  return to > from ? sum / (to - from) : 0
}

const wordsOf = (samples) => {
  const out = []
  for (let at = 0; at < samples.length; at += FRAME) {
    const mean = meanAbs(samples, at, Math.min(samples.length, at + FRAME))
    out.push(mean > 0.05 ? `w${Math.round((mean * 32768) / 1000)}` : null)
  }
  return out
}

const join = (words) => {
  const out = []
  for (const w of words) if (w !== null && out.at(-1) !== w) out.push(w)
  return out.join(" ")
}

export const fakeVad = () => {
  let detected = false
  return {
    acceptWaveform: (frame) => void (detected = meanAbs(frame, 0, frame.length) > 0.05),
    isDetected: () => detected,
    isEmpty: () => true,
    pop: () => {},
    reset: () => void (detected = false)
  }
}

/** `counters.framesDecoded` counts every frame any stream decoded (the cost of replays, for tests). */
export const fakeOnline = (counters = { framesDecoded: 0, streams: 0 }) => ({
  counters,
  createStream: () => {
    counters.streams++
    return { pending: [], words: [], finished: false, acceptWaveform({ samples }) { this.pending.push(samples.slice()) }, inputFinished() { this.finished = true }, setOption() {} }
  },
  isReady: (s) => s.pending.length > 0,
  decode: (s) => {
    const samples = s.pending.shift()
    counters.framesDecoded += Math.ceil(samples.length / FRAME)
    s.words.push(...wordsOf(samples))
  },
  getResult: (s) => ({ text: join(s.words) })
})

export const fakeOffline = (options = {}) => {
  const hang = options.hang ?? { on: false }
  // `hang.release()` lets the decodes that hung so far return (a stalled native decode that ends at last).
  const stalled = []
  hang.release = () => {
    for (const resolve of stalled.splice(0)) resolve()
  }
  const calls = options.calls ?? { started: 0, samples: [] }
  return {
    hang,
    calls,
    createStream: () => ({ samples: new Float32Array(0), acceptWaveform({ samples }) { this.samples = samples } }),
    decodeAsync: (s) => {
      calls.started++
      calls.samples.push(s.samples.length)
      if (hang.on) return new Promise((resolve) => void stalled.push(resolve))
      return new Promise((resolve) => setTimeout(resolve, options.decodeMs ?? 0))
    },
    getResult: (s) => ({ text: options.text ?? join(wordsOf(s.samples)) })
  }
}
