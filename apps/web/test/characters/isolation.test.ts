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

const FORBIDDEN = /\b(document|window|globalThis|self|navigator|location|history|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|EventSource|AudioContext|requestAnimationFrame|setTimeout|setInterval|postMessage|eval|Function|require)\b|\bimport\s*\(/g

/** Words after which a `/` starts a regular expression (after any other word, a number, `)` or `]` it divides). */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await", "instanceof"])

/**
 * Reads a source as the code that runs, not the text: comments dropped; string, template and regular expression
 * literals emptied (so a word in a label, a help text or a pattern does not count), but a template's `${...}`
 * expressions kept, nested templates included, because they run. Also returns the specifiers of its imports (a
 * string right after `from` or `import`). A scanner, not a parser, so it has to know where a regular expression
 * can start: a `}` or a quote inside one must not end a template expression or open a string.
 */
const scan = (src: string): { readonly code: string; readonly specifiers: ReadonlyArray<string> } => {
  let out = ""
  let i = 0
  const n = src.length
  const specifiers: Array<string> = []
  // One entry per open template expression: the brace depth inside it (it ends at its own closing brace).
  const exprs: Array<number> = []
  /** Does a `/` here start a regular expression? Decided by what came before it. */
  const regexAllowed = (): boolean => {
    const before = out.trimEnd()
    if (before === "") return true
    const last = before[before.length - 1]!
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true
    const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0]
    return word !== undefined && REGEX_AFTER_WORD.has(word)
  }
  /** Skip a regular expression literal starting at `i` (a `/`); false (and nothing skipped) when it is not one. */
  const skipRegex = (): boolean => {
    let j = i + 1
    let inClass = false
    while (j < n) {
      const ch = src[j]!
      if (ch === "\n") return false
      if (ch === "\\") j += 2
      else if (ch === "[") {
        inClass = true
        j++
      } else if (ch === "]") {
        inClass = false
        j++
      } else if (ch === "/" && !inClass) break
      else j++
    }
    if (j >= n) return false
    j++
    while (j < n && /[A-Za-z]/.test(src[j]!)) j++
    i = j
    out += "_re_"
    return true
  }
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
    if (ch === "/" && regexAllowed() && skipRegex()) continue
    if (ch === '"' || ch === "'") {
      const start = i + 1
      i++
      while (i < n && src[i] !== ch && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1
      if (/\b(from|import)\s*$/.test(out)) specifiers.push(src.slice(start, i))
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
  return { code: out, specifiers }
}

/** What a source imports, and the forbidden names (or `import()`) its code uses, in order. */
const analyse = (src: string): { readonly specifiers: ReadonlyArray<string>; readonly globals: ReadonlyArray<string> } => {
  const { code, specifiers } = scan(src)
  return { specifiers, globals: [...code.matchAll(FORBIDDEN)].map((m) => m[1] ?? "import()") }
}

describe("character isolation", () => {
  for (const dir of Object.keys(ALLOWED)) {
    for (const file of files(dir)) {
      const name = relative(root, file)
      it(`${name} imports only the contract, the kit and the shared modules, and no page globals`, () => {
        const { specifiers, globals } = analyse(readFileSync(file, "utf8"))
        for (const s of specifiers) expect(s, `${name} imports ${s}`).toMatch(ALLOWED[dir]!)
        expect(globals[0], `${name} uses ${globals[0]}`).toBeUndefined()
      })
    }
  }

  it("the check sees inside template expressions, and not inside literal text", () => {
    const uses = (src: string) => analyse(src).globals[0]
    // Executable: a page global inside `${...}`, also nested, also next to strings, braces and regular expressions.
    expect(uses("g.fillText(`${window.innerWidth}`, 0, 0)")).toBe("window")
    expect(uses("const s = `a ${f({ k: '}' })} b ${document.title}`")).toBe("document")
    expect(uses("const s = `outer ${`inner ${navigator.language}`} done`")).toBe("navigator")
    expect(uses("const s = `${x}` + localStorage.getItem('k')")).toBe("localStorage")
    expect(uses("const s = `${'a'}${`b`}`; fetch(s)")).toBe("fetch")
    expect(uses('g.fillText(`${/}/.test("}") ? window.innerWidth : 0}`, 0, 0)')).toBe("window") // a `}` in a regular expression
    expect(uses("const s = `${/`/.test(x) ? 1 : 2} ${self.name}`")).toBe("self") // a backtick in a regular expression
    expect(uses("const a = 4 / 2, b = `${a / 2}${location.href}`")).toBe("location") // division is not a regular expression
    // Text only: labels, help texts, comments, regular expressions.
    expect(uses("const label = `the window ${count} of the document`")).toBeUndefined()
    expect(uses("const help = 'resize the window'; const t = \"document\"")).toBeUndefined()
    expect(uses("// window\n/* document */ const a = 1")).toBeUndefined()
    expect(uses("const s = `\\${window}`")).toBeUndefined() // an escaped `${` is text
    expect(uses("const re = /window|document|fetch/g")).toBeUndefined()
  })

  it("the check finds a forbidden name however it is written", () => {
    const uses = (src: string) => analyse(src).globals[0]
    expect(uses("const w = window['document']")).toBe("window")
    expect(uses("const x = a ? globalThis.fetch : 0")).toBe("globalThis")
    expect(uses("const o = { window }")).toBe("window")
    expect(uses("const f = new Function('return 1')")).toBe("Function")
    expect(uses("setTimeout(() => 1, 5)")).toBe("setTimeout")
    expect(uses("const { a = document } = b")).toBe("document")
    expect(uses("class A extends EventSource {}")).toBe("EventSource")
    expect(uses("export { fetch }")).toBe("fetch")
    expect(uses("const m = await import('../../app/x.ts')")).toBe("import()")
    expect(uses("const o = { [window.x]: 1 }")).toBe("window")
    expect(uses("const ok = x.test('a') && /[/}]+/.test(y) ? window.name : 0")).toBe("window") // a `/` and a `}` in a character class
    expect(uses("function f() { return /\\//.test(s) ? navigator.language : 0 }")).toBe("navigator") // an escaped slash
    expect(uses("const q = a / b; const r = c / d; fetch(q)")).toBe("fetch") // dividing twice is not a regular expression
  })

  it("the check sees every kind of import", () => {
    const from = (src: string) => analyse(src).specifiers
    expect(from('import { a } from "../kit.ts"\nimport type { B } from "../../app/store.ts"')).toEqual(["../kit.ts", "../../app/store.ts"])
    expect(from('export * from "../shared/x.ts"\nexport { y } from "../../lib/y.ts"')).toEqual(["../shared/x.ts", "../../lib/y.ts"])
    expect(from('import "../side-effect.ts"')).toEqual(["../side-effect.ts"])
    expect(from('const s = "import x from \\"../../app/x.ts\\""; // import y from "../z.ts"')).toEqual([])
  })

  it("the kit and the contract import nothing of the application either", () => {
    for (const f of ["contract.ts", "kit.ts", "options.ts"]) {
      for (const s of analyse(readFileSync(join(root, f), "utf8")).specifiers) expect(s, `${f} imports ${s}`).toMatch(/^\.\/(contract|options)\.ts$/)
    }
  })
})
