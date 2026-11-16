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

/** Words after which a `/` starts a regular expression (after any other word it divides). */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"])
/** Words after which a `{` opens a block. */
const BLOCK_AFTER_WORD = new Set(["else", "do", "try", "finally", "import", "export"])
/** Statements whose head is in parentheses: a `/` right after the closing one starts a regular expression. */
const CONTROL = new Set(["if", "while", "for", "with"])
/** Punctuators of more than one character, longest first (a `/` is read apart: it may start a regular expression). */
const PUNCTUATORS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "%=", "&=", "|=", "^=", "**", "<<", ">>"]
const IDENT_START = /[A-Za-z_$#\u0080-\uffff]/
const IDENT_PART = /[\w$\u0080-\uffff]/
const NUMBER = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/
/** Readings of one source at most (each `/` whose meaning cannot be told doubles them). */
const MAX_READINGS = 64

/** What a `{` opened: a block, an expression (an object literal), or it cannot be told. */
type Brace = "block" | "expression" | "unknown"
/** A significant token, as much of it as the next `/` and `{` need. */
type Token =
  | { readonly kind: "start" }
  | { readonly kind: "punct"; readonly value: string }
  | { readonly kind: "word"; readonly value: string; readonly property: boolean }
  | { readonly kind: "close"; readonly value: string; readonly control: boolean; readonly fn: boolean; readonly brace: Brace }
  | { readonly kind: "number" | "string" | "template" | "regex" }
/** An open bracket: `(` (heading a control statement, or a function's parameters), `[`, `{`, or a template's `${`. */
interface Opener {
  readonly open: "(" | "[" | "{" | "${"
  readonly control: boolean
  readonly fn: boolean
  readonly brace: Brace
}
interface State {
  i: number
  out: Array<string>
  specifiers: Array<string>
  stack: Array<Opener>
  prev: Token
  prev2: Token
  /** How to read the next `/`, when a forked reading has decided it. */
  force: "regex" | "divide" | null
}
interface Reading {
  readonly code: string
  readonly specifiers: ReadonlyArray<string>
}

const START: Token = { kind: "start" }

/** Does a `/` after `t` start a regular expression, divide, or can that not be told (read it both ways)? */
const slashAfter = (t: Token): "regex" | "divide" | "either" => {
  switch (t.kind) {
    case "start":
      return "regex"
    case "punct":
      return t.value === "++" || t.value === "--" ? "divide" : "regex"
    case "word":
      return !t.property && REGEX_AFTER_WORD.has(t.value) ? "regex" : "divide"
    case "close":
      if (t.value === ")") return t.control ? "regex" : "divide"
      if (t.value === "]") return "divide"
      return t.brace === "block" ? "regex" : t.brace === "expression" ? "divide" : "either"
    default:
      return "divide"
  }
}

/** What a `{` after `t` opens. */
const braceAfter = (t: Token): Brace => {
  switch (t.kind) {
    case "start":
      return "block"
    case "punct":
      if (t.value === ";" || t.value === "=>") return "block"
      if (t.value === ":" || t.value === "++" || t.value === "--") return "unknown" // a label, or a postfix operator
      return "expression"
    case "word":
      if (t.property) return "unknown"
      if (BLOCK_AFTER_WORD.has(t.value)) return "block"
      return REGEX_AFTER_WORD.has(t.value) ? "expression" : "unknown" // `return {`; `class A {` may be an expression
    case "close":
      // After `)`: a body, but a function expression's body can be divided.
      if (t.value === ")") return t.fn ? "unknown" : "block"
      if (t.value === "}") return t.brace === "block" ? "block" : "unknown"
      return "unknown"
    default:
      return "unknown"
  }
}

/** Does `t` end an operand (so a `!` after it is TypeScript's postfix non-null assertion)? */
const endsOperand = (t: Token): boolean => {
  switch (t.kind) {
    case "word":
      return t.property || !REGEX_AFTER_WORD.has(t.value)
    case "close":
      return !t.control
    case "number":
    case "string":
    case "template":
    case "regex":
      return true
    default:
      return false
  }
}

/**
 * Reads a source as the code that runs, not the text: a tokenizer (identifiers and keywords, numbers, strings,
 * template literals with nested `${...}`, comments, punctuators, regular expression literals). Comments are dropped;
 * string, template and regular expression literals emptied (so a word in a label, a help text or a pattern does
 * not count), but a template's `${...}` expressions kept, nested templates included, because they run. Also
 * collects the specifiers of its imports (a string right after `from` or `import`).
 *
 * A `/` starts a regular expression or divides depending on the token before it (`slashAfter`): it divides after
 * an operand (a name, a number, a literal, `]`, `)`, a postfix `++`, `--` or `!`), and starts a regular expression
 * after an operator, a keyword like `return`, or the `)` of an `if`, `while`, `for` or `with` head (a stack records
 * what opened each bracket). After a `}` it depends on what the brace closed: a block, an object literal; where
 * that cannot be told the rest of the source is read both ways (fail closed), so one source gives one or more
 * readings.
 */
const scan = (src: string): ReadonlyArray<Reading> => {
  const n = src.length
  const readings: Array<Reading> = []
  let forks = 0
  const read = (st: State): void => {
    const emit = (s: string) => st.out.push(s)
    const push = (t: Token) => {
      st.prev2 = st.prev
      st.prev = t
    }
    /** A template literal's text from just after its opening backtick (or a closing `}`) to its end or `${`. */
    const templateText = () => {
      while (st.i < n) {
        const ch = src[st.i]!
        if (ch === "\\") {
          st.i += 2
          continue
        }
        if (ch === "`") {
          st.i++
          emit('""')
          push({ kind: "template" })
          return
        }
        if (ch === "$" && src[st.i + 1] === "{") {
          st.i += 2
          emit("(")
          st.stack.push({ open: "${", control: false, fn: false, brace: "expression" })
          push({ kind: "punct", value: "${" })
          return
        }
        st.i++
      }
    }
    /** Where a regular expression literal starting at `st.i` (a `/`) ends, or -1 when there is none. */
    const regexEnd = (): number => {
      let j = st.i + 1
      let inClass = false
      while (j < n) {
        const ch = src[j]!
        if (ch === "\n") return -1
        if (ch === "\\") j += 2
        else {
          if (ch === "[") inClass = true
          else if (ch === "]") inClass = false
          else if (ch === "/" && !inClass) break
          j++
        }
      }
      if (j >= n) return -1
      j++
      while (j < n && /[A-Za-z]/.test(src[j]!)) j++
      return j
    }
    while (st.i < n) {
      const ch = src[st.i]!
      const next = src[st.i + 1]
      if (/\s/.test(ch)) {
        st.i++
        continue
      }
      if (ch === "/" && next === "/") {
        while (st.i < n && src[st.i] !== "\n") st.i++
        continue
      }
      if (ch === "/" && next === "*") {
        const end = src.indexOf("*/", st.i + 2)
        st.i = end < 0 ? n : end + 2
        continue
      }
      if (ch === "/") {
        let how = st.force ?? slashAfter(st.prev)
        st.force = null
        if (how === "either") {
          if (++forks >= MAX_READINGS) throw new Error("isolation scan: too many `/` that could start a regular expression or divide")
          read({ ...st, out: [...st.out], specifiers: [...st.specifiers], stack: [...st.stack], force: "regex" })
          how = "divide"
        }
        if (how === "regex") {
          const end = regexEnd()
          if (end >= 0) {
            st.i = end
            emit("_re_")
            push({ kind: "regex" })
            continue
          }
        }
        const op = next === "=" ? "/=" : "/"
        st.i += op.length
        emit(op)
        push({ kind: "punct", value: op })
        continue
      }
      if (ch === '"' || ch === "'") {
        const start = st.i + 1
        st.i++
        while (st.i < n && src[st.i] !== ch && src[st.i] !== "\n") st.i += src[st.i] === "\\" ? 2 : 1
        const p = st.prev
        if (p.kind === "word" && !p.property && (p.value === "from" || p.value === "import")) st.specifiers.push(src.slice(start, st.i))
        st.i++
        emit('""')
        push({ kind: "string" })
        continue
      }
      if (ch === "`") {
        st.i++
        templateText()
        continue
      }
      if (IDENT_START.test(ch)) {
        let j = st.i + 1
        while (j < n && IDENT_PART.test(src[j]!)) j++
        const value = src.slice(st.i, j)
        st.i = j
        emit(value)
        const p = st.prev
        push({ kind: "word", value, property: p.kind === "punct" && (p.value === "." || p.value === "?.") })
        continue
      }
      const num = /[\d.]/.test(ch) ? (NUMBER.exec(src.slice(st.i, st.i + 64))?.[0] ?? "") : ""
      if (num !== "" && num !== ".") {
        st.i += num.length
        emit(num)
        push({ kind: "number" })
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        st.i++
        emit(ch)
        const p = st.prev
        const q = st.prev2
        if (ch === "(") {
          const control = p.kind === "word" && !p.property && CONTROL.has(p.value)
          // `function (`, `function name (`, `function* name (`: a body follows that may be an expression.
          const fn = p.kind === "word" && (p.value === "function" || (q.kind === "word" && q.value === "function") || (q.kind === "punct" && q.value === "*"))
          st.stack.push({ open: "(", control, fn, brace: "unknown" })
        } else st.stack.push({ open: ch, control: false, fn: false, brace: ch === "{" ? braceAfter(p) : "unknown" })
        push({ kind: "punct", value: ch })
        continue
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        const top = st.stack.pop()
        st.i++
        if (ch === "}" && top?.open === "${") {
          // The end of a template expression: back in the template's text.
          emit(")")
          templateText()
          continue
        }
        emit(ch)
        push({ kind: "close", value: ch, control: top?.control === true, fn: top?.fn === true, brace: top?.brace ?? "unknown" })
        continue
      }
      let op = ch
      for (const p of PUNCTUATORS)
        if (src.startsWith(p, st.i)) {
          op = p
          break
        }
      if (op === "?." && /\d/.test(src[st.i + 2] ?? "")) op = "?" // `a ?.5 : 1`
      st.i += op.length
      emit(op)
      // A `!` right after an operand is TypeScript's non-null assertion: a `/` after it divides, like after `)`.
      if (op === "!" && endsOperand(st.prev)) push({ kind: "close", value: ")", control: false, fn: false, brace: "unknown" })
      else push({ kind: "punct", value: op })
    }
    readings.push({ code: st.out.join(" "), specifiers: st.specifiers })
  }
  read({ i: 0, out: [], specifiers: [], stack: [], prev: START, prev2: START, force: null })
  return readings
}

/** What a source imports, and the forbidden names (or `import()`) its code uses, in order, over every reading. */
const analyse = (src: string): { readonly specifiers: ReadonlyArray<string>; readonly globals: ReadonlyArray<string>; readonly readings: number } => {
  const readings = scan(src)
  const specifiers: Array<string> = []
  const globals: Array<string> = []
  for (const r of readings) {
    for (const s of r.specifiers) if (!specifiers.includes(s)) specifiers.push(s)
    for (const m of r.code.matchAll(FORBIDDEN)) globals.push(m[1] ?? "import()")
  }
  return { specifiers, globals, readings: readings.length }
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

  it("the check tells a regular expression from a division by the tokens before it", () => {
    const uses = (src: string) => analyse(src).globals[0]
    // Division, so the names between the slashes are code (review of #12: `++` is postfix here, and `)` of a call).
    expect(uses("let n = 1; const ratio = n++ / window.innerWidth / 2")).toBe("window")
    expect(uses("const r = x--/window.y/2")).toBe("window")
    expect(uses("const r = f(x) / window.devicePixelRatio / 2")).toBe("window")
    expect(uses("const r = a[i]! / window.devicePixelRatio / 2")).toBe("window") // TypeScript's non-null assertion
    expect(uses("const r = a.b! / window.devicePixelRatio / 2")).toBe("window")
    expect(uses("const r = x.return / window.y / 2")).toBe("window") // a property named like a keyword
    expect(uses("const r = 3 / window.y / 2")).toBe("window")
    expect(uses("const r = `${a}` / window.y / 2")).toBe("window")
    expect(uses("const o = { a: 1 } / window.x / 2")).toBe("window") // an object literal's `}`
    // Regular expressions, so the names inside are text (review of #12: the `)` of an `if` head).
    expect(uses("if (ok) /window/.test(label)")).toBeUndefined()
    expect(uses("while (ok) /window/.test(label)")).toBeUndefined()
    expect(uses("for (const k of /window/.exec(s) ?? []) k")).toBeUndefined()
    expect(uses("const r = !/window/.test(s)")).toBeUndefined()
    expect(uses("return /window/.test(s)")).toBeUndefined()
    expect(uses("const t = typeof /window/")).toBeUndefined()
    expect(uses("{}\n/window/.test(s)")).toBeUndefined() // a block's `}`
    expect(uses("x = () => {}\n/window/.test(s)")).toBeUndefined()
  })

  it("where a `}` could close an expression or a block, the check reads the rest both ways (fail closed)", () => {
    // A function expression or a class expression can be divided; a declaration's body is followed by a statement.
    expect(analyse("const f = function () {} / window.x / 2").globals[0]).toBe("window")
    expect(analyse("const C = class {} / window.x / 2").globals[0]).toBe("window")
    const both = analyse("function f() {}\n/window/.test(s)")
    expect(both.readings).toBe(2)
    expect(both.globals).toEqual(["window"]) // the division reading names it: reported
    // Every character and shared module reads one way only.
    for (const dir of Object.keys(ALLOWED)) for (const file of files(dir)) expect(analyse(readFileSync(file, "utf8")).readings, relative(root, file)).toBe(1)
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
