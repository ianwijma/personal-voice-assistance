// @vitest-environment node
/**
 * Characters do not import application code and do not reach outside their canvas (docs/CHARACTERS.md §1):
 * every file under `src/characters/library/` and `src/characters/shared/` imports only the contract, the kit and
 * the shared modules, and names none of the page's or the network's globals.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "../../src/characters")
const files = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(root, dir, f))

/** What a file under each directory may import, relative to it. */
const ALLOWED: { readonly [dir: string]: RegExp } = {
  library: /^\.\.\/(contract|kit)\.ts$|^\.\.\/shared\/[a-z0-9-]+\.ts$/,
  shared: /^\.\.\/(contract|kit)\.ts$|^\.\/[a-z0-9-]+\.ts$/
}

const FORBIDDEN = /\b(document|window|globalThis|self|navigator|location|history|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|EventSource|AudioContext|requestAnimationFrame|setTimeout|setInterval|postMessage|eval|Function)\b|\bimport\s*\(/

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
/** String literals emptied too, so a word inside a label or help text does not count. */
const code = (src: string) => stripComments(src).replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')

describe("character isolation", () => {
  for (const dir of Object.keys(ALLOWED)) {
    for (const file of files(dir)) {
      const name = relative(root, file)
      it(`${name} imports only the contract, the kit and the shared modules, and no page globals`, () => {
        const src = readFileSync(file, "utf8")
        const specifiers = [...stripComments(src).matchAll(/\b(?:import|export)\b[^;"']*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]!)
        for (const s of specifiers) expect(s, `${name} imports ${s}`).toMatch(ALLOWED[dir]!)
        const hit = FORBIDDEN.exec(code(src))
        expect(hit?.[0], `${name} uses ${hit?.[0]}`).toBeUndefined()
      })
    }
  }

  it("the kit and the contract import nothing of the application either", () => {
    for (const f of ["contract.ts", "kit.ts", "options.ts"]) {
      const specifiers = [...stripComments(readFileSync(join(root, f), "utf8")).matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!)
      for (const s of specifiers) expect(s, `${f} imports ${s}`).toMatch(/^\.\/(contract|options)\.ts$/)
    }
  })
})
