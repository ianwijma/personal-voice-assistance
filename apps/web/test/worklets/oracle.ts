/**
 * An oracle for "how many source samples of a reply reached the output", computed from the rendered
 * output alone, independently of the player's own counters (third review: the property test used to read
 * the worklet's counter and check only an upper bound, so it could not see undercounting).
 *
 * The test feeds content at the context rate (no resampler) that alternates sign on every sample
 * (±`AMP`). Everything else the player adds is smooth: fade-in and fade-out are linear gains, the
 * de-clicker is an exponential decay, a held sample under a fade is constant. So a sample of the output
 * is content exactly where its second difference is large: `|y[n] − (y[n−1] + y[n+1]) / 2|` is about
 * `2·AMP·gain` for content and below 1e-3 for the smooth parts. Samples under the last ~1 % of a fade are
 * missed and the sample next to a cut can be miscounted, a few samples per edge: well inside one render
 * quantum (128) per reply, which is the tolerance the tests use.
 */
export const AMP = 0.5
export const QUANTUM = 128
const THRESHOLD = 0.01

/** `n` samples of alternating content continuing from sample `from` of the reply (s16). */
export const alternating = (from: number, n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((from + i) % 2 === 0 ? 1 : -1) * Math.round(AMP * 32_768))

export interface Rendered {
  /** The reply that was active while this quantum rendered (0: none). */
  readonly id: number
  readonly out: Float32Array
  /** The device was silent before this quantum (the context had stopped rendering). */
  readonly afterGap: boolean
}

/** Per reply id, the number of output samples that carry its content. */
export const contentCounts = (rendered: ReadonlyArray<Rendered>): Map<number, number> => {
  const values: Array<number> = []
  const owners: Array<number> = []
  for (const q of rendered) {
    if (q.afterGap) {
      // The device played silence meanwhile: the samples on either side are not neighbours.
      for (let k = 0; k < 4; k++) {
        values.push(0)
        owners.push(0)
      }
    }
    for (const v of q.out) {
      values.push(v)
      owners.push(q.id)
    }
  }
  const counts = new Map<number, number>()
  for (let n = 0; n < values.length; n++) {
    const before = n > 0 ? values[n - 1]! : 0
    const after = n + 1 < values.length ? values[n + 1]! : 0
    if (Math.abs(values[n]! - (before + after) / 2) > THRESHOLD && owners[n]! !== 0) {
      counts.set(owners[n]!, (counts.get(owners[n]!) ?? 0) + 1)
    }
  }
  return counts
}

/** A whole binary reply frame (8-byte header with the reply id, then s16le). */
export const replyFrame = (id: number, samples: Int16Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(8 + samples.byteLength)
  new DataView(buffer).setUint32(4, id, true)
  new Int16Array(buffer, 8).set(samples)
  return buffer
}

/**
 * For replies at a rate other than the context's (third-review oracle above needs equal rates: the
 * resampler smooths an alternating pattern away). Content is a tone at a quarter of the source rate,
 * which the resampler passes unchanged (half the source's Nyquist frequency, well inside its 0.94
 * cutoff). A sample counts as content where the energy of the second difference over two periods of the
 * tone, centred on it, is above `TONE_FLOOR` of what the tone at full level gives. The de-clicker's decay
 * and held samples have next to no second difference. What it misses or adds, per edge: the quietest
 * part of a 4 ms fade (gain below √TONE_FLOOR ≈ 0.22, about 0.9 ms), and up to a period at a cut.
 * Counts are in source samples.
 */
export const TONE_FLOOR = 0.05

export const tone = (from: number, n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => Math.round(AMP * 32_767 * Math.sin((Math.PI / 2) * (from + i) + Math.PI / 4)))

export interface Owned {
  /** The reply this quantum belongs to, from the messages the page sent the worklet (0: none). */
  readonly owner: number
  readonly out: Float32Array
  readonly afterGap: boolean
}

export const toneCounts = (rendered: ReadonlyArray<Owned>, ctxRate: number, rates: ReadonlyMap<number, number>): Map<number, number> => {
  const values: Array<number> = []
  const owners: Array<number> = []
  const longest = Math.max(8, ...[...rates.values()].map((r) => Math.round((8 * ctxRate) / r)))
  for (const q of rendered) {
    if (q.afterGap) {
      for (let k = 0; k < longest; k++) {
        values.push(0)
        owners.push(0)
      }
    }
    for (const v of q.out) {
      values.push(v)
      owners.push(q.owner)
    }
  }
  const d2 = values.map((v, n) => v - ((n > 0 ? values[n - 1]! : 0) + (n + 1 < values.length ? values[n + 1]! : 0)) / 2)
  const prefix = new Float64Array(d2.length + 1)
  for (let n = 0; n < d2.length; n++) prefix[n + 1] = prefix[n]! + d2[n]! * d2[n]!
  const counts = new Map<number, number>()
  for (let n = 0; n < values.length; n++) {
    const id = owners[n]!
    const rate = rates.get(id)
    if (id === 0 || rate === undefined) continue
    const period = Math.max(8, Math.round((8 * ctxRate) / rate)) // two periods of the tone
    const omega = (2 * Math.PI * (rate / 4)) / ctxRate
    const full = (AMP * AMP * (1 - Math.cos(omega)) ** 2) / 2
    const lo = Math.max(0, n - Math.floor(period / 2))
    const hi = Math.min(d2.length, lo + period)
    if ((prefix[hi]! - prefix[lo]!) / period > full * TONE_FLOOR) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const [id, c] of counts) counts.set(id, (c * rates.get(id)!) / ctxRate)
  return counts
}
