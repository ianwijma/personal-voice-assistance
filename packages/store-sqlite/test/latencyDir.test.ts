// latencyDir() (latencyBound.ts) gives latency tests a directory on a real disk, and refuses one in memory: the system
// temporary directory, else the fallback under node_modules/.cache, each checked as returned. The file-system calls
// are substituted here, so the cases do not depend on how this machine is mounted.
import { describe, expect, it } from "vitest"
import { type LatencyDirSystem, latencyDirWith } from "./latencyBound.ts"

const TMPFS = 0x01021994
const RAMFS = 0x858458f6
const EXT4 = 0xef53

/** A system whose temporary directory is `/temp` and whose fallback is `/repo/cache`, on the file systems given. */
const fake = (temp: number, cache: number) => {
  const statfs: Array<string> = []
  const removed: Array<string> = []
  const finished: Array<() => void> = []
  const system: LatencyDirSystem = {
    tmpdir: () => "/temp",
    fileSystemType: (dir) => {
      statfs.push(dir)
      return dir.startsWith("/temp") ? temp : cache
    },
    mkdirp: () => {},
    mkdtemp: (prefix) => `${prefix}made`,
    remove: (dir) => void removed.push(dir),
    onTestFinished: (f) => void finished.push(f)
  }
  return { system, statfs, removed, finished }
}

describe("latencyDir: a real disk, checked as returned", () => {
  it("the temporary directory on a disk: a directory there, removed when the test ends", () => {
    const f = fake(EXT4, EXT4)
    expect(latencyDirWith(f.system, "/repo/cache", "t")).toBe("/temp/t-made")
    expect(f.statfs).toContain("/temp/t-made")
    for (const done of f.finished) done()
    expect(f.removed).toEqual(["/temp/t-made"])
  })

  it("the temporary directory in memory, the fallback on a disk: a directory under the fallback, checked itself", () => {
    const f = fake(TMPFS, EXT4)
    expect(latencyDirWith(f.system, "/repo/cache", "t")).toBe("/repo/cache/t-made")
    expect(f.statfs).toEqual(["/temp", "/repo/cache/t-made"])
  })

  for (const [name, type] of [["tmpfs", TMPFS], ["ramfs", RAMFS]] as const) {
    it(`both in memory (${name}): it fails, says so, and leaves nothing behind`, () => {
      const f = fake(type, type)
      expect(() => latencyDirWith(f.system, "/repo/cache", "t")).toThrow(/held in memory.*Set TMPDIR to a directory on a real disk/)
      expect(f.removed).toContain("/repo/cache/t-made")
    })
  }
})
