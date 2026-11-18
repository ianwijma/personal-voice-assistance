import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Latency tests: the test files that assert how long the main thread stops or how long real work takes
 * (docs/MODULES.md §15 "Latency tests"). **A test file is one when it imports `latencyBound.ts`** (for `bound()`,
 * packages/store-sqlite/test/latencyBound.ts, or with a bare `import` when it times real work without it).
 *
 * `pnpm test` runs them with everything else. CI runs them in a step of their own, one file at a time, after the rest
 * (`--project latency --no-file-parallelism`): on its two cores, tests that keep other threads busy on purpose
 * (workers spinning, megabytes parsed in workers) made the main thread's longest stops in them several times longer.
 */

/** The directories that hold the node project's test files (its `include`), repository-relative. */
const testDirs = (root: string): Array<string> => {
  const children = (dir: string) => {
    try {
      return readdirSync(join(root, dir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `${dir}/${d.name}`)
    } catch {
      return []
    }
  }
  return [
    ...children("packages").map((d) => `${d}/test`),
    ...children("apps").filter((d) => d !== "apps/web").map((d) => `${d}/test`),
    ...children("docs/research").map((d) => `${d}/lab/test`)
  ]
}

const IMPORTS_LATENCY_BOUND = /^\s*import\b[^;]*?["'][^"']*\/latencyBound(?:\.ts)?["']/m

/** Whether a test file's text makes it a latency test. */
export const isLatencyTest = (text: string): boolean => IMPORTS_LATENCY_BOUND.test(text)

/** Every node test file under `root` (`*.test.ts` in the directories above), repository-relative with `/`, sorted. */
export const nodeTestFiles = (root: string): Array<string> => {
  const out: Array<string> = []
  for (const dir of testDirs(root)) {
    let names: Array<string>
    try {
      names = readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    } catch {
      continue
    }
    for (const name of names) {
      const path = `${dir}/${name.split("\\").join("/")}`
      if (path.endsWith(".test.ts") && !path.includes("/node_modules/")) out.push(path)
    }
  }
  return out.sort()
}

/** The latency test files under `root` (see above), repository-relative, sorted. */
export const latencyTestFiles = (root: string): Array<string> =>
  nodeTestFiles(root).filter((path) => isLatencyTest(readFileSync(join(root, path), "utf8")))
