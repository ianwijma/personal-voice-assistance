/** A seeded pseudo-random generator (mulberry32): the generated tests are the same on every run. */
export interface Rng {
  readonly next: () => number
  readonly int: (min: number, max: number) => number
  readonly pick: <T>(xs: ReadonlyArray<T>) => T
  readonly chance: (p: number) => boolean
}
export const rng = (seed: number): Rng => {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  return { next, int, pick: (xs) => xs[int(0, xs.length - 1)]!, chance: (p) => next() < p }
}
