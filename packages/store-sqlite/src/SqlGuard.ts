/**
 * The guard on module SQL (docs/STORING-DATA.md "Module SQL"): a module's statements may only reach its own tables,
 * those whose names start with `m_<moduleId>__`. `node:sqlite` on Node 22 has no authorizer hook, so the guard works
 * on SQLite's own tokens: it reads string literals, every identifier quoting (`"…"`, `` `…` ``, `[…]`, doubled quotes)
 * and comments the way SQLite does, then refuses
 *
 * - more than one statement per call (a migration string is split into statements first; a trigger body's `;` stays
 *   inside its `BEGIN … END`);
 * - statements other than `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `WITH`, `VALUES`, and in migrations
 *   `CREATE`, `DROP`, `ALTER`;
 * - `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, transaction statements, `TEMP` objects, `ANALYZE`, `REINDEX`,
 *   `load_extension`, `dbstat`, a `temp.` qualifier;
 * - any name or string, in any quoting and case, that starts with `sqlite_`, `pragma_`, `pva_` (the store's own),
 *   `core_` (core services) or another module's `m_…__` prefix, or that names an existing table, index, view or
 *   trigger outside the module's prefix;
 * - a created, dropped, altered or renamed object whose name is outside the prefix.
 *
 * Parameters (`?`) are values, never names, so they are not looked at. After every migration the store also checks
 * that no object outside the prefix appeared.
 */

export type TokenKind = "word" | "quoted" | "string" | "blob" | "number" | "param" | "punct"

export interface Token {
  readonly kind: TokenKind
  /** The raw text. */
  readonly text: string
  /** Words and quoted names unquoted, strings unquoted; lower-cased (ASCII, as SQLite folds names). */
  readonly value: string
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

const isWordStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80
const isWordPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80

/** SQLite's tokens of `sql`, or the reason it cannot be read (an unterminated string or name). */
export const tokenize = (sql: string): ReadonlyArray<Token> | string => {
  const out: Array<Token> = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++
      continue
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    const quoted = (close: string, kind: TokenKind, doubled: boolean, start = i): string | undefined => {
      let j = i + 1
      let value = ""
      while (j < n) {
        if (sql[j] === close) {
          if (doubled && sql[j + 1] === close) {
            value += close
            j += 2
            continue
          }
          out.push({ kind, text: sql.slice(start, j + 1), value: asciiLower(value) })
          i = j + 1
          return undefined
        }
        value += sql[j]
        j++
      }
      return `an unterminated ${kind === "string" ? "string" : "quoted name"}`
    }
    if ((c === "x" || c === "X") && sql[i + 1] === "'") {
      const start = i
      i++
      const problem = quoted("'", "blob", false, start)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "'") {
      const problem = quoted("'", "string", true)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "\"") {
      const problem = quoted("\"", "quoted", true)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "`") {
      const problem = quoted("`", "quoted", true)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "[") {
      const problem = quoted("]", "quoted", false)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "?" || ((c === ":" || c === "@" || c === "$") && i + 1 < n && isWordPart(sql[i + 1]!))) {
      let j = i + 1
      while (j < n && isWordPart(sql[j]!)) j++
      out.push({ kind: "param", text: sql.slice(i, j), value: "" })
      i = j
      continue
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) j++
      out.push({ kind: "number", text: sql.slice(i, j), value: "" })
      i = j
      continue
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordPart(sql[j]!)) j++
      const text = sql.slice(i, j)
      out.push({ kind: "word", text, value: asciiLower(text) })
      i = j
      continue
    }
    out.push({ kind: "punct", text: c, value: c })
    i++
  }
  return out
}

const isTrigger = (tokens: ReadonlyArray<Token>, start: number): boolean => {
  const w = (k: number) => (tokens[start + k]?.kind === "word" ? tokens[start + k]!.value : "")
  if (w(0) !== "create") return false
  const next = w(1) === "temp" || w(1) === "temporary" ? w(2) : w(1)
  return next === "trigger"
}

/** The statements of a token list (split on `;` outside a trigger's `BEGIN … END`); empty statements dropped. */
export const splitStatements = (tokens: ReadonlyArray<Token>): ReadonlyArray<ReadonlyArray<Token>> => {
  const out: Array<Array<Token>> = []
  let current: Array<Token> = []
  let depth = 0
  let trigger = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (current.length === 0) {
      trigger = isTrigger(tokens, i)
      depth = 0
    }
    if (t.kind === "punct" && t.value === ";" && depth === 0) {
      if (current.length > 0) out.push(current)
      current = []
      continue
    }
    if (trigger && t.kind === "word") {
      if (t.value === "begin" || t.value === "case") depth++
      else if (t.value === "end" && depth > 0) depth--
    }
    current.push(t)
  }
  if (current.length > 0) out.push(current)
  return out
}

const DML = new Set(["select", "insert", "update", "delete", "replace", "with", "values"])
const DDL = new Set(["create", "drop", "alter"])
const FORBIDDEN_WORDS = new Set([
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "commit",
  "savepoint",
  "release",
  "analyze",
  "reindex",
  "load_extension",
  "dbstat"
])
const RESERVED = ["sqlite_", "pragma_", "pva_", "core_"]
const OBJECT_KINDS = new Set(["table", "index", "view", "trigger"])

export interface GuardContext {
  /** `m_<moduleId>__`. */
  readonly prefix: string
  /** Every schema object's name now (lower case). */
  readonly schemaNames: ReadonlySet<string>
  /** Migrations: schema statements allowed. */
  readonly allowSchema: boolean
  /** Read-only stores: only reads. */
  readonly readOnly?: boolean
}

const isName = (t: Token | undefined): t is Token => t !== undefined && (t.kind === "word" || t.kind === "quoted")

/** Why one statement is refused, or `undefined` when it may run. */
export const refusal = (statement: ReadonlyArray<Token>, context: GuardContext): string | undefined => {
  const first = statement[0]
  if (first === undefined) return "an empty statement"
  if (first.kind !== "word") return "a statement must start with a keyword"
  const prefix = context.prefix
  const trigger = isTrigger(statement, 0)
  if (DDL.has(first.value)) {
    if (!context.allowSchema) return `${first.text.toUpperCase()} is only allowed in the module's migrations`
  } else if (!DML.has(first.value)) {
    return `${first.text.toUpperCase()} statements are not allowed`
  }
  const otherModule = (v: string) => /^m_[a-z0-9_]*?__/.test(v) && !v.startsWith(prefix)
  for (let i = 0; i < statement.length; i++) {
    const t = statement[i]!
    if (t.kind === "word") {
      if (FORBIDDEN_WORDS.has(t.value)) return `"${t.text}" is not allowed in module SQL`
      // Inside a trigger body BEGIN/END/ROLLBACK (RAISE) belong to the trigger; elsewhere they are transaction control.
      if (!trigger && (t.value === "begin" || t.value === "rollback")) return `"${t.text}" is not allowed in module SQL`
      if (context.readOnly === true && (t.value === "insert" || t.value === "update" || t.value === "delete" || t.value === "replace")) {
        return "the household data is read-only here"
      }
    }
    if (t.kind === "word" || t.kind === "quoted" || t.kind === "string") {
      const v = t.value
      if (RESERVED.some((r) => v.startsWith(r)) || otherModule(v)) return `"${t.text}" is outside the module's tables (${prefix}*)`
      if (!v.startsWith(prefix) && context.schemaNames.has(v)) return `"${t.text}" is outside the module's tables (${prefix}*)`
    }
    if (isName(t) && t.value === "temp" && statement[i + 1]?.value === ".") return "the temp schema is not allowed"
  }
  // Objects created, dropped or altered must be the module's own.
  const definedName = (): Token | undefined => {
    let k = 1
    const word = (j: number) => (statement[j]?.kind === "word" ? statement[j]!.value : "")
    if (first.value === "create") {
      if (word(k) === "temp" || word(k) === "temporary") return undefined
      while (word(k) === "unique" || word(k) === "virtual") k++
      if (!OBJECT_KINDS.has(word(k))) return statement[k] ?? first
      k++
      if (word(k) === "if" && word(k + 1) === "not" && word(k + 2) === "exists") k += 3
    } else if (first.value === "drop") {
      if (!OBJECT_KINDS.has(word(k))) return statement[k] ?? first
      k++
      if (word(k) === "if" && word(k + 1) === "exists") k += 2
    } else if (first.value === "alter") {
      if (word(k) !== "table") return statement[k] ?? first
      k++
    } else return undefined
    return statement[k]
  }
  if (DDL.has(first.value)) {
    const name = definedName()
    if (first.value === "create" && (statement[1]?.value === "temp" || statement[1]?.value === "temporary")) return "temporary objects are not allowed"
    if (!isName(name)) return "a schema statement must name its object"
    if (statement[statement.indexOf(name) + 1]?.value === ".") return "schema-qualified names are not allowed"
    if (!name.value.startsWith(prefix)) return `"${name.text}" must start with ${prefix}`
    if (first.value === "alter") {
      for (let i = 0; i + 2 < statement.length; i++) {
        if (statement[i]!.value === "rename" && statement[i + 1]!.value === "to") {
          const to = statement[i + 2]
          if (!isName(to) || !to.value.startsWith(prefix)) return `a table may only be renamed to a name starting with ${prefix}`
        }
      }
    }
  }
  return undefined
}

/** Check one call's SQL: exactly one statement that `refusal` accepts. */
export const checkModuleStatement = (sql: string, context: GuardContext): string | undefined => {
  const tokens = tokenize(sql)
  if (typeof tokens === "string") return tokens
  const statements = splitStatements(tokens)
  if (statements.length === 0) return "an empty statement"
  if (statements.length > 1) return "one statement per call"
  return refusal(statements[0]!, context)
}

/** A migration string as its statements (each checked), or the first refusal. */
export const migrationStatements = (sql: string, context: GuardContext): { readonly statements: ReadonlyArray<string> } | { readonly refused: string } => {
  const tokens = tokenize(sql)
  if (typeof tokens === "string") return { refused: tokens }
  const statements = splitStatements(tokens)
  const out: Array<string> = []
  for (const st of statements) {
    const why = refusal(st, context)
    if (why !== undefined) return { refused: why }
    out.push(st.map((t) => t.text).join(" "))
  }
  return { statements: out }
}

/** A migration string of a core service split into statements (not guarded: core code). */
export const coreStatements = (sql: string): ReadonlyArray<string> => {
  const tokens = tokenize(sql)
  if (typeof tokens === "string") throw new Error(`Core migration: ${tokens}`)
  return splitStatements(tokens).map((st) => st.map((t) => t.text).join(" "))
}
