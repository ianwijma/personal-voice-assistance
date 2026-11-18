import { mkdirSync, mkdtempSync, rmSync, statfsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { onTestFinished } from "vitest"

/**
 * A latency bound as a test asserts it: the documented bound (measured on the development machine) here, and
 * `CI_FACTOR` times it when `process.env.CI` is set. Shared CI runners are several times slower than that machine and
 * noisy: the run of 2026-11-17 measured 19.6 ms for a list whose bound was 10 ms (the same list took under 5 ms here),
 * so a bound of three times the local one keeps a margin there without hiding a real regression here.
 */
export const CI_FACTOR = 3
export const bound = (ms: number): number => (process.env.CI ? ms * CI_FACTOR : ms)

/** `statfs` types of file systems held in memory: tmpfs and ramfs. A sync there costs nothing. */
const MEMORY_FILE_SYSTEMS = new Set([0x01021994, 0x858458f6])

/** Whether `dir` is on a file system held in memory (tmpfs, ramfs). */
export const inMemoryFileSystem = (dir: string): boolean => MEMORY_FILE_SYSTEMS.has(Number(statfsSync(dir).type))

/**
 * A new directory for a latency test's database, on a real disk: the system temporary directory when it is on one
 * (as on CI), otherwise (`/tmp` on tmpfs, as on the development machine) one under the repository's
 * `node_modules/.cache/pva-latency/`. A store measured on tmpfs never waits for a disk: its syncs cost nothing, so a
 * stop that a sync on the main thread causes (tens of milliseconds on a slow disk or an SD card) would never show.
 * Removed when the test ends, also when it fails. Call it inside a test.
 */
export const latencyDir = (prefix: string): string => {
  const system = tmpdir()
  const base = inMemoryFileSystem(system) ? fileURLToPath(new URL("../../../node_modules/.cache/pva-latency", import.meta.url)) : system
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `${prefix}-`))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
