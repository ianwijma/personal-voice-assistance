import { isModuleSqlName } from "@pva/core"

/**
 * The guard on module SQL (docs/STORING-DATA.md "Module SQL"): a module's statements may only reach its own tables,
 * those whose names start with its prefix (`sqlPrefixOf`). `node:sqlite` on Node 22 has no authorizer hook, so the
 * guard reads the SQL with SQLite's own tokenizer rules and **refuses anything it does not fully understand**: a
 * character SQLite would not accept, an unterminated string, name or comment, a `$` or `#` parameter, a number run
 * into a name. Statements are passed to SQLite as the exact text the guard read (never re-joined), so operators such
 * as `!=`, `<=`, `||` and `->>` reach it unchanged.
 *
 * Refused, in any quoting (`"…"`, `` `…` ``, `[…]`, `'…'`) and case:
 *
 * - more than one statement per call (a migration string is split into statements first; a trigger body's `;` stays
 *   inside its `BEGIN … END`);
 * - statements other than `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `WITH`, `VALUES`, and in migrations
 *   `CREATE`, `DROP`, `ALTER`;
 * - the keywords `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `ANALYZE`, `REINDEX`, `COMMIT`, `SAVEPOINT`, `RELEASE`,
 *   `ROLLBACK` (also `RAISE(ROLLBACK, …)` and `OR ROLLBACK`: they would end the store's transaction), `BEGIN` outside a
 *   trigger body, `CREATE TEMP` / `CREATE TEMPORARY`, and a `temp.` qualifier;
 * - the names `load_extension`, every virtual-table module of the build other than `json_each` and `json_tree`
 *   (`dbstat`, `fts5vocab`, `fts4aux`, `fts3tokenize`, `sqlite_dbpage`, `sqlite_stmt`, …), and `fts5`, `fts4`, `fts3`,
 *   `rtree`, `rtree_i32` except right after `USING`;
 * - any name or string that starts with `sqlite_`, `pragma_`, `pva_` (the store's own), `core_` (core services) or is in
 *   another module's namespace (`m_…__…`, `mx_…`), or that is an existing table, index, view or trigger outside the
 *   module's prefix;
 * - a created, dropped, altered or renamed object whose name is outside the prefix.
 *
 * Parameters (`?`, `?NNN`, `:name`, `@name`) are values, never names. After every migration the store also checks
 * that no object outside the prefix appeared.
 */

export type TokenKind = "word" | "quoted" | "string" | "blob" | "number" | "param" | "punct"

export interface Token {
  readonly kind: TokenKind
  /** The raw text. */
  readonly text: string
  /** Words and quoted names unquoted, strings unquoted; lower-cased (ASCII, as SQLite folds names). */
  readonly value: string
  /** Offsets in the source: `sql.slice(start, end) === text`. */
  readonly start: number
  readonly end: number
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** SQLite's white space (sqlite3Isspace): space, tab, line feed, vertical tab, form feed, carriage return. */
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r"
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"
const isHex = (c: string | undefined) => c !== undefined && /^[0-9A-Fa-f]$/.test(c)
/** SQLite's identifier characters: letters, digits, `_`, `$`, and every character outside ASCII. */
const isIdStart = (c: string | undefined) => c !== undefined && (/^[A-Za-z_]$/.test(c) || c.charCodeAt(0) >= 0x80)
const isIdPart = (c: string | undefined) => c !== undefined && (/^[A-Za-z0-9_$]$/.test(c) || c.charCodeAt(0) >= 0x80)

/** The operators and punctuation SQLite's tokenizer knows, longest first. */
const OPERATORS = ["->>", "->", "||", "<=", ">=", "<>", "<<", ">>", "==", "!=", "(", ")", ";", ",", ".", "+", "-", "*", "/", "%", "=", "<", ">", "&", "|", "~"]

/** SQLite's tokens of `sql`, or why the guard cannot read it (and so refuses it). */
export const tokenize = (sql: string): ReadonlyArray<Token> | string => {
  const out: Array<Token> = []
  let i = 0
  const n = sql.length
  const push = (kind: TokenKind, start: number, end: number, value: string) => out.push({ kind, text: sql.slice(start, end), value, start, end })
  while (i < n) {
    const c = sql[i]!
    if (isSpace(c)) {
      i++
      continue
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++
      continue
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end === -1) return "an unterminated comment"
      i = end + 2
      continue
    }
    // A quoted string or name; `doubled`: the closing character written twice stands for itself.
    const quoted = (close: string, kind: TokenKind, doubled: boolean, start: number, from: number): string | undefined => {
      let j = from
      let value = ""
      while (j < n) {
        if (sql[j] === close) {
          if (doubled && sql[j + 1] === close) {
            value += close
            j += 2
            continue
          }
          push(kind, start, j + 1, kind === "blob" ? value : asciiLower(value))
          i = j + 1
          return undefined
        }
        value += sql[j]
        j++
      }
      return `an unterminated ${kind === "string" || kind === "blob" ? "string" : "quoted name"}`
    }
    if ((c === "x" || c === "X") && sql[i + 1] === "'") {
      const start = i
      const problem = quoted("'", "blob", false, start, i + 2)
      if (problem !== undefined) return problem
      const hex = out[out.length - 1]!.value
      if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) return "a malformed blob literal"
      continue
    }
    if (c === "'" || c === "\"" || c === "`") {
      const problem = quoted(c, c === "'" ? "string" : "quoted", true, i, i + 1)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "[") {
      const problem = quoted("]", "quoted", false, i, i + 1)
      if (problem !== undefined) return problem
      continue
    }
    if (c === "?") {
      let j = i + 1
      while (isDigit(sql[j])) j++
      push("param", i, j, "")
      i = j
      continue
    }
    if (c === ":" || c === "@") {
      let j = i + 1
      while (isIdPart(sql[j]) && sql[j] !== "$") j++
      if (j === i + 1) return `"${c}" without a parameter name`
      push("param", i, j, "")
      i = j
      continue
    }
    if (c === "$" || c === "#") return `"${c}" parameters are not accepted (use ? or :name)`
    if (isDigit(c) || (c === "." && isDigit(sql[i + 1]))) {
      let j = i
      if (c === "0" && (sql[i + 1] === "x" || sql[i + 1] === "X") && isHex(sql[i + 2])) {
        j = i + 2
        while (isHex(sql[j]) || (sql[j] === "_" && isHex(sql[j + 1]))) j++
      } else {
        while (isDigit(sql[j]) || (sql[j] === "_" && isDigit(sql[j + 1]))) j++
        if (sql[j] === ".") {
          j++
          while (isDigit(sql[j]) || (sql[j] === "_" && isDigit(sql[j + 1]))) j++
        }
        if ((sql[j] === "e" || sql[j] === "E") && (isDigit(sql[j + 1]) || ((sql[j + 1] === "+" || sql[j + 1] === "-") && isDigit(sql[j + 2])))) {
          j += 2
          while (isDigit(sql[j])) j++
        }
      }
      // SQLite does not accept a number run into a name (`1abc`), and neither does the guard.
      if (isIdPart(sql[j])) return `a number run into a name ("${sql.slice(i, j + 1)}")`
      push("number", i, j, "")
      i = j
      continue
    }
    if (isIdStart(c)) {
      let j = i + 1
      while (isIdPart(sql[j])) j++
      push("word", i, j, asciiLower(sql.slice(i, j)))
      i = j
      continue
    }
    const op = OPERATORS.find((o) => sql.startsWith(o, i))
    if (op === undefined) return `a character the guard does not accept (${JSON.stringify(c)})`
    push("punct", i, i + op.length, op)
    i += op.length
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

/** The exact source text of a statement (its first token to its last). */
const textOf = (sql: string, statement: ReadonlyArray<Token>) => sql.slice(statement[0]!.start, statement[statement.length - 1]!.end)

const DML = new Set(["select", "insert", "update", "delete", "replace", "with", "values"])
const DDL = new Set(["create", "drop", "alter"])
/** Keywords that end, nest or leave the store's transaction, or reach outside the database. */
const FORBIDDEN_KEYWORDS = new Set(["attach", "detach", "pragma", "vacuum", "analyze", "reindex", "commit", "savepoint", "release", "rollback"])
/** Names never allowed, in any quoting. */
const FORBIDDEN_NAMES = new Set(["load_extension", "dbstat", "fts5vocab", "fts4aux", "fts3tokenize"])
/** Table-valued functions a module may read anywhere. */
const ALLOWED_VTABLES = new Set(["json_each", "json_tree"])
/** Virtual-table modules a module may create its own tables with (`CREATE VIRTUAL TABLE … USING fts5(…)`). */
const CREATABLE_VTABLES = new Set(["fts5", "fts4", "fts3", "rtree", "rtree_i32"])
const RESERVED = ["sqlite_", "pragma_", "pva_", "core_"]
const OBJECT_KINDS = new Set(["table", "index", "view", "trigger"])

export interface GuardContext {
  /** The module's prefix (`sqlPrefixOf`). */
  readonly prefix: string
  /** Every schema object's name now (lower case). */
  readonly schemaNames: ReadonlySet<string>
  /** Migrations: schema statements allowed. */
  readonly allowSchema: boolean
  /** Read-only stores: only reads. */
  readonly readOnly?: boolean
  /** The build's virtual-table modules (`pragma_module_list`, lower case). */
  readonly vtableModules?: ReadonlySet<string>
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
  const outside = (t: Token) => `"${t.text}" is outside the module's tables (${prefix}*)`
  for (let i = 0; i < statement.length; i++) {
    const t = statement[i]!
    if (t.kind === "word") {
      if (FORBIDDEN_KEYWORDS.has(t.value)) return `"${t.text}" is not allowed in module SQL`
      // Inside a trigger body BEGIN belongs to the trigger; elsewhere it starts a transaction.
      if (!trigger && t.value === "begin") return `"${t.text}" is not allowed in module SQL`
      if ((t.value === "temp" || t.value === "temporary") && statement[i - 1]?.value === "create") return "temporary objects are not allowed"
      if (context.readOnly === true && (t.value === "insert" || t.value === "update" || t.value === "delete" || t.value === "replace")) {
        return "the household data is read-only here"
      }
    }
    if (isName(t) && (t.value === "temp" || t.value === "temporary") && statement[i + 1]?.value === ".") return "the temp schema is not allowed"
    if (t.kind === "word" || t.kind === "quoted" || t.kind === "string") {
      const v = t.value
      if (FORBIDDEN_NAMES.has(v)) return `"${t.text}" is not allowed in module SQL`
      if (RESERVED.some((r) => v.startsWith(r))) return outside(t)
      if (isModuleSqlName(v) && !v.startsWith(prefix)) return outside(t)
      if (!v.startsWith(prefix) && context.schemaNames.has(v)) return outside(t)
      if (context.vtableModules?.has(v) === true && !ALLOWED_VTABLES.has(v)) {
        const afterUsing = statement[i - 1]?.kind === "word" && statement[i - 1]!.value === "using"
        if (!(afterUsing && t.kind === "word" && CREATABLE_VTABLES.has(v))) return `"${t.text}" (a built-in virtual table) is not allowed in module SQL`
      }
    }
  }
  // Objects created, dropped or altered must be the module's own.
  if (DDL.has(first.value)) {
    const word = (j: number) => (statement[j]?.kind === "word" ? statement[j]!.value : "")
    let k = 1
    let name: Token | undefined
    if (first.value === "create") {
      while (word(k) === "unique" || word(k) === "virtual") k++
      if (!OBJECT_KINDS.has(word(k))) return "CREATE of something other than a table, index, view or trigger"
      k++
      if (word(k) === "if" && word(k + 1) === "not" && word(k + 2) === "exists") k += 3
      name = statement[k]
    } else if (first.value === "drop") {
      if (!OBJECT_KINDS.has(word(k))) return "DROP of something other than a table, index, view or trigger"
      k++
      if (word(k) === "if" && word(k + 1) === "exists") k += 2
      name = statement[k]
    } else {
      if (word(k) !== "table") return "ALTER of something other than a table"
      name = statement[k + 1]
      k++
    }
    if (!isName(name)) return "a schema statement must name its object"
    if (statement[k + 1]?.value === ".") return "schema-qualified names are not allowed"
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

/** A migration string as its statements (each checked, each its exact source text), or the first refusal. */
export const migrationStatements = (sql: string, context: GuardContext): { readonly statements: ReadonlyArray<string> } | { readonly refused: string } => {
  const tokens = tokenize(sql)
  if (typeof tokens === "string") return { refused: tokens }
  const out: Array<string> = []
  for (const st of splitStatements(tokens)) {
    const why = refusal(st, context)
    if (why !== undefined) return { refused: why }
    out.push(textOf(sql, st))
  }
  return { statements: out }
}

/** A migration string of a core service split into statements, each its exact source text (not guarded: core code). */
export const coreStatements = (sql: string): ReadonlyArray<string> => {
  const tokens = tokenize(sql)
  if (typeof tokens === "string") throw new Error(`Core migration: ${tokens}`)
  return splitStatements(tokens).map((st) => textOf(sql, st))
}
