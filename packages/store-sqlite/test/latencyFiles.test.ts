// Latency tests run alone on CI (vitest.latency.ts, docs/MODULES.md §15 "Latency tests"): a test file is one when it
// imports `latencyBound.ts`. This checks that every file using `bound()` is one, and that each test file is in exactly
// one of the two node projects, so a new latency file cannot end up in the parallel run, or in neither.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import config, { latency } from "../../../vitest.config.ts"
import { isLatencyTest, latencyTestFiles, nodeTestFiles } from "../../../vitest.latency.ts"

const root = join(import.meta.dirname, "../../..")
const all = nodeTestFiles(root)

describe("latency tests are recognised by their import of latencyBound.ts", () => {
  it("every test file that uses bound() imports it, so it runs in the latency project", () => {
    const unmarked = all.filter((path) => {
      const text = readFileSync(join(root, path), "utf8")
      return /\bbound\(\s*[\w.]/.test(text) && !isLatencyTest(text)
    })
    expect(unmarked, "use bound() from packages/store-sqlite/test/latencyBound.ts (imported), not one of your own").toEqual([])
  })

  it("the node project leaves out exactly the latency files, and the latency project takes exactly them", () => {
    const projects = (config.test?.projects ?? []).flatMap((p) => (typeof p === "object" && "test" in p ? [p.test!] : []))
    const node = projects.find((p) => p.name === "node")!
    const slow = projects.find((p) => p.name === "latency")!
    expect(latency).toEqual(latencyTestFiles(root))
    expect(slow.include).toEqual(latency)
    expect(node.exclude).toEqual(expect.arrayContaining(latency))
    // Every node test file is in one of the two (the latency files are a part of all of them).
    expect(latency.every((path) => all.includes(path))).toBe(true)
    expect(latency).toEqual(expect.arrayContaining([
      "packages/store-sqlite/test/latency.test.ts",
      "packages/core/test/OffThread.test.ts",
      "packages/module-contracts/test/kit/offThread.test.ts",
      "apps/assistant/test/vault.test.ts"
    ]))
  })

  it("a latency file that opens a SQLite file puts it on a real disk (latencyDir), never on a tmpfs /tmp", () => {
    const onTmp = latencyTestFiles(root).filter((path) => {
      const text = readFileSync(join(root, path), "utf8")
      return /makeSqliteStore\(|new DatabaseSync\(/.test(text) && !/\blatencyDir\(/.test(text)
    })
    expect(onTmp, "take the database's directory from latencyDir() in packages/store-sqlite/test/latencyBound.ts").toEqual([])
  })

  it("the rule: an import of latencyBound.ts, with bound() or bare; a mention elsewhere is not one", () => {
    expect(isLatencyTest(`import { bound } from "../../store-sqlite/test/latencyBound.ts"`)).toBe(true)
    expect(isLatencyTest(`import { bound } from "./latencyBound.ts"`)).toBe(true)
    expect(isLatencyTest(`import "../../../store-sqlite/test/latencyBound.ts"`)).toBe(true)
    expect(isLatencyTest(`// as the store's latency tests (\`bound()\` in packages/store-sqlite/test/latencyBound.ts)`)).toBe(false)
    expect(isLatencyTest(`const bound = (ms: number) => ms * 3`)).toBe(false)
  })
})
