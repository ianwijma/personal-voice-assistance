/**
 * The compatibility suite (docs/CHARACTERS.md §6) for every character in `src/characters/library/`, found the
 * same way the app finds them (the registry's `import.meta.glob`): a new character gets it by existing. Plus the
 * test-only character, so the suite is proven on more than the baseline.
 *
 * One character: `pnpm --filter @pva/web exec vitest run test/characters/compat.test.ts -t '"<id>"'`.
 */
import { vi } from "vitest"
import { registry } from "@/characters/registry.ts"
import { compatSuite } from "./support/compat.ts"
import { installFakeCanvas } from "./support/fakeCanvas.ts"

installFakeCanvas()

/** A freshly evaluated module per call, so per-page state (instance counters, caches) starts the same each run. */
const fresh = (id: string) => async (): Promise<unknown> => {
  vi.resetModules()
  const m = await import("@/characters/registry.ts")
  return m.registry.load(id)
}

for (const id of registry.ids) compatSuite(id, fresh(id))

compatSuite("test-dots", async () => {
  vi.resetModules()
  return (await import("./support/test-dots.ts")).default
})
