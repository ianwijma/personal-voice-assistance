import { defineConfig } from "vitest/config"
import { latencyTestFiles } from "./vitest.latency.ts"

const include = ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "docs/research/*/lab/test/**/*.test.ts"]
const exclude = ["**/node_modules/**", "apps/web/**"]
/** Test files that import `latencyBound.ts` (vitest.latency.ts): the `latency` project, the rest is `node`. */
export const latency = latencyTestFiles(import.meta.dirname)

export default defineConfig({
  test: {
    // `pnpm test` runs every project: `node` and `web` together, then `latency` (group 1) one file at a time. CI runs
    // the same as two steps (.github/workflows/ci.yml), so the latency results are seen also when the others fail.
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // The CI machine has two cores: tests that start several households pass the default 5 s there now and then.
          ...(process.env.CI ? { testTimeout: 20_000 } : {}),
          include,
          exclude: [...exclude, ...latency],
          globalSetup: ["./vitest.global-setup.ts"]
        }
      },
      {
        test: {
          name: "latency",
          environment: "node",
          // The same limit as the node project on the two-core CI machine: a slow run passed the default 5 s in two tests.
          ...(process.env.CI ? { testTimeout: 20_000 } : {}),
          include: latency,
          exclude,
          // After the other projects, alone: nothing else keeps the cores busy while these measure.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          globalSetup: ["./vitest.global-setup.ts"]
        }
      },
      // The web app has its own config (jsdom, path aliases).
      "apps/web"
    ]
  }
})
