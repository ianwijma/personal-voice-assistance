// The audio of the current turn, for whole-turn (non-streaming) decoding.
// Plain JavaScript: it runs in the worker thread (see worker.mjs). Pure: no
// models, no I/O, so the turn logic is unit-tested with scripted frames.
//
// - Collection starts at the VAD's speech onset, with the pre-roll frames
//   before it, and then takes every frame (speech and pauses) until the turn
//   is committed.
// - `commit(atFrame)` ends the turn. Frames after `atFrame` that contain the
//   onset of new speech (and the pre-roll before it) are kept: they are the
//   start of the next turn.
// - Bounded: once the turn holds `maxFrames`, `push` returns the audio so far
//   at the next silence frame (or at `maxFrames` + `graceFrames` regardless)
//   and starts a new piece; the caller decodes it and prefixes its text.
//   Memory is one preallocated buffer.

export class TurnAudio {
  /**
   * @param {{ frameSamples?: number, maxFrames: number, graceFrames?: number, prerollFrames: number }} options
   */
  constructor(options) {
    this.frameSamples = options.frameSamples ?? 320
    this.maxFrames = options.maxFrames
    this.hardFrames = options.maxFrames + (options.graceFrames ?? 250)
    this.prerollFrames = options.prerollFrames
    const capacity = this.hardFrames + this.prerollFrames + 1
    this.samples = new Float32Array(capacity * this.frameSamples)
    this.index = new Int32Array(capacity)
    this.speech = new Uint8Array(capacity)
    this.count = 0
    this.collecting = false
  }

  /** Frames held. */
  get length() {
    return this.count
  }

  /** Index of the first frame held, or -1. */
  get firstFrame() {
    return this.count > 0 ? this.index[0] : -1
  }

  /**
   * One processed frame. `preroll()` is asked for the frames before an onset
   * (oldest first, ending with this frame) when collection starts.
   * @param {Float32Array} frame
   * @param {number} index
   * @param {boolean} speech
   * @param {() => Array<{ frame: Float32Array, index: number, speech: boolean }>} preroll
   * @returns {Float32Array | undefined} a full piece to decode now (the buffer was emptied), if the cap was reached
   */
  push(frame, index, speech, preroll) {
    if (!this.collecting) {
      if (!speech) return undefined
      this.collecting = true
      for (const p of preroll()) this.append(p.frame, p.index, p.speech)
      return undefined
    }
    this.append(frame, index, speech)
    if (this.count >= this.hardFrames || (this.count >= this.maxFrames && !speech)) {
      const piece = this.audio()
      this.count = 0
      return piece
    }
    return undefined
  }

  /** @private */
  append(frame, index, speech) {
    if (this.count > 0 && index <= this.index[this.count - 1]) return // already held (pre-roll overlap)
    if (this.count >= this.index.length) return // cannot happen: push splits before
    this.samples.set(frame, this.count * this.frameSamples)
    this.index[this.count] = index
    this.speech[this.count] = speech ? 1 : 0
    this.count++
  }

  /** A copy of the turn's audio so far. */
  audio() {
    return this.samples.slice(0, this.count * this.frameSamples)
  }

  /**
   * A copy of the turn's audio up to and including frame `atFrame`.
   * @param {number} atFrame
   */
  audioThrough(atFrame) {
    let n = this.count
    while (n > 0 && this.index[n - 1] > atFrame) n--
    return this.samples.slice(0, n * this.frameSamples)
  }

  /** Whether a frame after `atFrame` was speech. */
  speechAfter(atFrame) {
    for (let i = this.count - 1; i >= 0 && this.index[i] > atFrame; i--) if (this.speech[i] === 1) return true
    return false
  }

  /**
   * The turn was committed at frame `atFrame`. Keeps the onset of a new turn
   * that started after it (with its pre-roll); otherwise empties the buffer.
   * @param {number} atFrame
   */
  commit(atFrame) {
    let onset = -1
    for (let i = 0; i < this.count; i++) {
      if (this.index[i] > atFrame && this.speech[i] === 1) {
        onset = i
        break
      }
    }
    if (onset < 0) {
      this.clear()
      return
    }
    // The pre-roll may reach back before `atFrame`: those frames are the committed turn's closing silence.
    const start = Math.max(0, onset - this.prerollFrames)
    this.samples.copyWithin(0, start * this.frameSamples, this.count * this.frameSamples)
    this.index.copyWithin(0, start, this.count)
    this.speech.copyWithin(0, start, this.count)
    this.count -= start
  }

  clear() {
    this.count = 0
    this.collecting = false
  }
}
