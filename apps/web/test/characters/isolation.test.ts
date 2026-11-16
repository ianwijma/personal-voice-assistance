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

/**
 * The executable code of a source: comments dropped, the text of string and template literals emptied (so a word in
 * a label or help text does not count), but a template's `${...}` expressions kept, nested templates included,
 * because they run. A small scanner, not a regex: a template's expression can hold strings, braces and templates.
 */
const code = (src: string): string => {
  let out = ""
  let i = 0
  const n = src.length
  // One entry per open template expression: the brace depth inside it (it ends at its own closing brace).
  const exprs: Array<number> = []
  /** Skip a template literal's text from just after its opening backtick (or a closing `}`) to its end or `${`. */
  const templateText = (): void => {
    while (i < n) {
      const ch = src[i]!
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === "`") {
        i++
        out += '""'
        return
      }
      if (ch === "$" && src[i + 1] === "{") {
        i += 2
        out += "("
        exprs.push(0)
        return
      }
      i++
    }
  }
  while (i < n) {
    const ch = src[i]!
    const next = src[i + 1]
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2)
      i = end < 0 ? n : end + 2
      out += " "
      continue
    }
    if (ch === '"' || ch === "'") {
      i++
      while (i < n && src[i] !== ch && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1
      i++
      out += '""'
      continue
    }
    if (ch === "`") {
      i++
      templateText()
      continue
    }
    if (exprs.length > 0) {
      const top = exprs.length - 1
      if (ch === "{") exprs[top] = exprs[top]! + 1
      else if (ch === "}") {
        if (exprs[top] === 0) {
          // The end of a template expression: back in the template's text.
          exprs.pop()
          out += ")"
          i++
          templateText()
          continue
        }
        exprs[top] = exprs[top]! - 1
      }
    }
    out += ch
    i++
  }
  return out
}

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

  it("the check sees inside template expressions, and not inside literal text", () => {
    const uses = (src: string) => FORBIDDEN.exec(code(src))?.[0]
    // Executable: a page global inside `${...}`, also nested, also next to strings and braces.
    expect(uses("g.fillText(`${window.innerWidth}`, 0, 0)")).toBe("window")
    expect(uses("const s = `a ${f({ k: '}' })} b ${document.title}`")).toBe("document")
    expect(uses("const s = `outer ${`inner ${navigator.language}`} done`")).toBe("navigator")
    expect(uses("const s = `${x}` + localStorage.getItem('k')")).toBe("localStorage")
    expect(uses("const s = `${'a'}${`b`}`; fetch(s)")).toBe("fetch")
    // Text only: labels, help texts, comments.
    expect(uses("const label = `the window ${count} of the document`")).toBeUndefined()
    expect(uses("const help = 'resize the window'; const t = \"document\"")).toBeUndefined()
    expect(uses("// window\n/* document */ const a = 1")).toBeUndefined()
    expect(uses("const s = `\\${window}`")).toBeUndefined() // an escaped `${` is text
  })

  it("the kit and the contract import nothing of the application either", () => {
    for (const f of ["contract.ts", "kit.ts", "options.ts"]) {
      const specifiers = [...stripComments(readFileSync(join(root, f), "utf8")).matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]!)
      for (const s of specifiers) expect(s, `${f} imports ${s}`).toMatch(/^\.\/(contract|options)\.ts$/)
    }
  })
})
