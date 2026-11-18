/**
 * A latency bound as a test asserts it: the documented bound (measured on the development machine) here, and
 * `CI_FACTOR` times it when `process.env.CI` is set. Shared CI runners are several times slower than that machine and
 * noisy: the run of 2026-11-17 measured 19.6 ms for a list whose bound was 10 ms (the same list took under 5 ms here),
 * so a bound of three times the local one keeps a margin there without hiding a real regression here.
 */
export const CI_FACTOR = 3
export const bound = (ms: number): number => (process.env.CI ? ms * CI_FACTOR : ms)
