// @vitest-environment node
/**
 * Characters do not import application code and do not reach outside their canvas (docs/CHARACTERS.md §1):
 * every file under `src/characters/library/` and `src/characters/shared/` imports only the contract, the kit and
 * the shared modules, and names none of the page's or the network's globals.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "../../src/characters")
const files = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(root, dir, f))

/** What a file under each directory may import, relative to it. */
const ALLOWED: { readonly [dir: string]: RegExp } = {
  library: /^\.\.\/(contract|kit)\.ts$|^\.\.\/shared\/[a-z0-9-]+\.ts$/,
  shared: /^\.\.\/(contract|kit)\.ts$|^\.\/[a-z0-9-]+\.ts$/
}

/** Names a character must not reference as free identifiers (a global of the page or the network, or a way to run text as code). */
const FORBIDDEN = new Set(["document", "window", "globalThis", "self", "navigator", "location", "history", "localStorage", "sessionStorage", "indexedDB", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "AudioContext", "requestAnimationFrame", "setTimeout", "setInterval", "postMessage", "eval", "Function", "require"])

/** Is this identifier a use of a variable (a free reference), and not a name that is declared, a property name, a label or a type? */
const isReference = (node: ts.Identifier): boolean => {
  const p = node.parent
  if (ts.isPropertyAccessExpression(p)) return p.expression === node // `a.window`: `window` is a property name
  if (ts.isShorthandPropertyAssignment(p)) return true // `{ window }` reads the variable
  if (ts.isExportSpecifier(p)) return p.parent.parent.moduleSpecifier === undefined && (p.propertyName ?? p.name) === node
  if (ts.isBindingElement(p)) return p.initializer === node // a default value; the names are declarations
  if (ts.isQualifiedName(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
  if ((p as { name?: ts.Node }).name === node) return false // a declaration, a property key, a member name
  if ((p as { propertyName?: ts.Node }).propertyName === node) return false
  return true
}

/**
 * What a source imports (every module specifier: `import`, `export ... from`, `import x = require()`, `import()`
 * types) and which forbidden names it uses as free references, by the TypeScript parser: comments, strings,
 * template text and regular expression literals are not code, and a template's `${...}` expressions are walked
 * like any other expression. Type positions are not walked.
 */
const analyse = (src: string): { readonly specifiers: ReadonlyArray<string>; readonly globals: ReadonlyArray<string> } => {
  const file = ts.createSourceFile("character.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specifiers: Array<string> = []
  const globals: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text)
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) globals.push("import()")
    else if (ts.isIdentifier(node) && FORBIDDEN.has(node.text) && isReference(node)) globals.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { specifiers, globals }
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

  it("the check finds free references by name, however they are written, and not property names, declarations or types", () => {
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
    expect(uses("const x = obj.window + obj.document + obj?.fetch; const o = { window: 1, fetch: 2, history() {} }")).toBeUndefined()
    expect(uses("type T = typeof window; let f: Function; const n = x as Function; interface I { document: string }")).toBeUndefined()
    expect(uses("const { window: w, fetch: f } = o; function g(self: number) { return 1 }")).toBeUndefined() // a declared name is not a reference
    expect(uses("export { a as window }; import { fetch as get } from '../kit.ts'")).toBeUndefined()
  })

  it("the check sees every kind of import", () => {
    const from = (src: string) => analyse(src).specifiers
    expect(from('import { a } from "../kit.ts"\nimport type { B } from "../../app/store.ts"')).toEqual(["../kit.ts", "../../app/store.ts"])
    expect(from('export * from "../shared/x.ts"\nexport { y } from "../../lib/y.ts"')).toEqual(["../shared/x.ts", "../../lib/y.ts"])
    expect(from('import "../side-effect.ts"')).toEqual(["../side-effect.ts"])
    expect(from('type T = import("../../app/x.ts").X')).toEqual(["../../app/x.ts"])
    expect(from('const s = "import x from \\"../../app/x.ts\\""; // import y from "../z.ts"')).toEqual([])
  })

  it("the kit and the contract import nothing of the application either", () => {
    for (const f of ["contract.ts", "kit.ts", "options.ts"]) {
      for (const s of analyse(readFileSync(join(root, f), "utf8")).specifiers) expect(s, `${f} imports ${s}`).toMatch(/^\.\/(contract|options)\.ts$/)
    }
  })
})
