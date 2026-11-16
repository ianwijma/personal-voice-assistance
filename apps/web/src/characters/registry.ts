/**
 * Every character the app has: each file `library/<id>.ts` default-exports a `Character`. The list of lazy loaders
 * is generated (`scripts/build-characters.mjs` writes the git-ignored `library.generated.ts` before dev, build,
 * check and test), so adding a character is adding its file and nothing else. Each loader is a plain `import()`,
 * so each character is its own chunk, loaded only when a viewer chooses it.
 *
 * The baseline is imported statically: it is part of the host, drawn before anything has loaded, and the
 * fallback when a character fails (docs/CHARACTERS.md §4.6).
 */
import { BASELINE_ID } from "./choice.ts"
import type { Character } from "./contract.ts"
import { loaders as generated } from "./library.generated.ts"
import baseline from "./library/sine-lines.ts"

export { BASELINE_ID }

/** Where a host finds characters by id. Tests pass their own. */
export interface Registry {
  /** Every id, sorted, the baseline included. */
  readonly ids: ReadonlyArray<string>
  readonly baseline: Character
  /** The module's default export (unchecked: the host validates it), or undefined for an unknown id. */
  readonly load: (id: string) => Promise<unknown> | undefined
}

const loaders = new Map(Object.entries(generated))

export const registry: Registry = {
  ids: [BASELINE_ID, ...loaders.keys()].sort(),
  baseline,
  load: (id) => {
    if (id === BASELINE_ID) return Promise.resolve(baseline)
    const load = loaders.get(id)
    return load === undefined ? undefined : load().then((m) => m.default)
  }
}
