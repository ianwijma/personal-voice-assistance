// The guard on module SQL: a module reaches only its own tables, however a statement is quoted or split.
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { DatabaseSync } from "node:sqlite"
import { makeSqliteStore } from "../src/SqliteStore.ts"
import { checkModuleStatement, coreStatements, type GuardContext, migrationStatements, splitStatements, tokenize } from "../src/SqlGuard.ts"

const LISTS = ["CREATE TABLE m_lists__items (id TEXT PRIMARY KEY, text TEXT NOT NULL)"]

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  prefix: "m_lists__",
  schemaNames: new Set(["pva_docs", "pva_changes", "m_lists__items", "m_kitchen__stock", "m_kitchen__stock_fts_data", "recipes"]),
  allowSchema: false,
  ...over
})
const ok = (sql: string, c = ctx()) => expect(checkModuleStatement(sql, c), sql).toBeUndefined()
const refused = (sql: string, c = ctx()) => expect(checkModuleStatement(sql, c), sql).toBeTypeOf("string")

describe("module SQL guard", () => {
  it("lets the module use its own tables", () => {
    ok("SELECT * FROM m_lists__items WHERE list_id = ? ORDER BY position")
    ok("INSERT INTO m_lists__items (id, text) VALUES (?, ?)")
    ok("UPDATE m_lists__items SET text = ? WHERE id = ?")
    ok("DELETE FROM m_lists__items WHERE id = ?")
    ok("WITH open AS (SELECT * FROM m_lists__items WHERE status = 'open') SELECT count(*) FROM open")
    ok("SELECT i.text FROM m_lists__items AS i JOIN m_lists__lists l ON l.id = i.list_id")
    ok("SELECT * FROM \"m_lists__items\"")
    ok("SELECT * FROM m_lists__items; -- a trailing comment")
    ok("SELECT 'it''s; fine' AS x FROM m_lists__items")
    ok("SELECT value FROM json_each(?)")
  })

  it("refuses the store's own tables and other modules', in any quoting and case", () => {
    for (const sql of [
      "SELECT * FROM pva_docs",
      "SELECT * FROM PVA_DOCS",
      "SELECT * FROM \"pva_docs\"",
      "SELECT * FROM `pva_changes`",
      "SELECT * FROM [pva_docs]",
      "SELECT * FROM \"PvA_dOcS\"",
      "SELECT * FROM m_kitchen__stock",
      "SELECT * FROM \"m_kitchen__stock_fts_data\"",
      "SELECT * FROM m_lists__items JOIN m_kitchen__stock ON 1",
      "SELECT * FROM m_lists__items WHERE id IN (SELECT row_id FROM pva_changes)",
      "SELECT * FROM recipes",
      "SELECT * FROM main.pva_docs",
      "SELECT * FROM sqlite_master",
      "SELECT * FROM sqlite_schema",
      "SELECT * FROM pragma_table_info('pva_docs')",
      "SELECT * FROM dbstat",
      "SELECT * FROM temp.x",
      "SELECT * FROM core_scheduler__jobs",
      "SELECT * FROM m_other__anything"
    ]) refused(sql)
  })

  it("refuses several statements, comments hiding a second one, and control statements", () => {
    refused("SELECT 1 FROM m_lists__items; DELETE FROM pva_docs")
    refused("SELECT 1 FROM m_lists__items; SELECT 2")
    refused("SELECT 1 /* ; */ FROM m_lists__items; DROP TABLE m_lists__items")
    refused("ATTACH DATABASE 'x.db' AS other")
    refused("PRAGMA writable_schema = 1")
    refused("VACUUM INTO 'copy.db'")
    refused("BEGIN")
    refused("COMMIT")
    refused("SAVEPOINT a")
    refused("SELECT load_extension('x')")
    refused("DETACH other")
    refused("SELECT 'unterminated")
    refused("SELECT \"unterminated FROM m_lists__items")
  })

  it("splits like SQLite: a `;` inside a string, a quoted name or a comment does not end a statement", () => {
    const tokens = tokenize("SELECT ';' FROM \"a;b\" -- ;\n; SELECT 2 /* ; */")
    expect(typeof tokens).toBe("object")
    expect(splitStatements(tokens as never).length).toBe(2)
  })

  it("schema statements only in migrations, and only with the module's prefix", () => {
    refused("CREATE TABLE m_lists__x (id TEXT)")
    const mig = ctx({ allowSchema: true })
    ok("CREATE TABLE m_lists__x (id TEXT PRIMARY KEY, text TEXT)", mig)
    ok("CREATE TABLE IF NOT EXISTS m_lists__x (id TEXT)", mig)
    ok("CREATE UNIQUE INDEX m_lists__x_text ON m_lists__items (text)", mig)
    ok("CREATE VIRTUAL TABLE m_lists__fts USING fts5(text, content='m_lists__items')", mig)
    ok("ALTER TABLE m_lists__items ADD COLUMN note TEXT", mig)
    ok("ALTER TABLE m_lists__items RENAME TO m_lists__entries", mig)
    ok("DROP TABLE IF EXISTS m_lists__x", mig)
    refused("CREATE TABLE lists (id TEXT)", mig)
    refused("CREATE TABLE \"pva_x\" (id TEXT)", mig)
    refused("CREATE TEMP TABLE m_lists__t (id TEXT)", mig)
    refused("CREATE TABLE main.m_lists__t (id TEXT)", mig)
    refused("CREATE INDEX m_lists__ix ON pva_docs (id)", mig)
    refused("CREATE VIEW m_lists__v AS SELECT * FROM pva_docs", mig)
    refused("CREATE VIRTUAL TABLE m_lists__fts USING fts5(text, content='pva_docs')", mig)
    refused("ALTER TABLE m_lists__items RENAME TO entries", mig)
    refused("DROP TABLE pva_docs", mig)
    refused("DROP TABLE m_kitchen__stock", mig)
  })

  it("a trigger body keeps its statements inside the trigger and is checked too", () => {
    const mig = ctx({ allowSchema: true })
    const good = migrationStatements(
      "CREATE TABLE m_lists__a (id TEXT); CREATE TRIGGER m_lists__t AFTER INSERT ON m_lists__a BEGIN INSERT INTO m_lists__items (id) VALUES (new.id); SELECT CASE WHEN 1 THEN 1 END; END; CREATE INDEX m_lists__ia ON m_lists__a (id)",
      mig
    )
    expect("statements" in good && good.statements.length).toBe(3)
    const bad = migrationStatements("CREATE TRIGGER m_lists__t AFTER INSERT ON m_lists__items BEGIN DELETE FROM pva_docs; END", mig)
    expect("refused" in bad).toBe(true)
  })

  it("read-only stores refuse writes even in a query", () => {
    refused("INSERT INTO m_lists__items (id) VALUES (?) RETURNING id", ctx({ readOnly: true }))
    ok("SELECT * FROM m_lists__items", ctx({ readOnly: true }))
  })
})

describe("module SQL guard, round 1 of the review", () => {
  const vtables = new Set(["pragma_module_list", "sqlite_stmt", "json_tree", "json_each", "fts4aux", "fts3", "fts4", "fts3tokenize", "fts5vocab", "dbstat", "fts5", "rtree", "rtree_i32", "sqlite_dbpage"])
  const c = (over: Partial<GuardContext> = {}) => ctx({ vtableModules: vtables, ...over })

  it("refuses built-in virtual tables in any quoting, as a table name or a string; json_each and json_tree pass", () => {
    for (const sql of [
      "SELECT * FROM dbstat",
      "SELECT * FROM \"dbstat\"",
      "SELECT * FROM 'dbstat'",
      "SELECT * FROM [DBSTAT]",
      "SELECT * FROM `dbstat`",
      "SELECT \"load_extension\"('x')",
      "SELECT * FROM fts5vocab",
      "SELECT * FROM fts4aux",
      "SELECT * FROM fts3tokenize",
      "SELECT * FROM \"sqlite_dbpage\"",
      "SELECT * FROM sqlite_stmt",
      "SELECT * FROM pragma_module_list",
      "SELECT * FROM fts5"
    ]) refused(sql, c())
    ok("SELECT value FROM json_each(?)", c())
    ok("SELECT key FROM \"json_tree\"(?)", c())
    ok("CREATE VIRTUAL TABLE m_lists__fts USING fts5(text)", c({ allowSchema: true }))
    ok("CREATE VIRTUAL TABLE m_lists__geo USING rtree(id, x0, x1)", c({ allowSchema: true }))
    refused("CREATE VIRTUAL TABLE m_lists__v USING fts5vocab(m_lists__fts, row)", c({ allowSchema: true }))
    refused("CREATE VIRTUAL TABLE m_lists__d USING dbstat", c({ allowSchema: true }))
  })

  it("refuses another module's namespace whatever its id looks like (a--b, a trailing dash), and statements that end the store's transaction", () => {
    const a = c({ prefix: "m_a__" })
    ok("SELECT * FROM m_a__items", a)
    refused("SELECT * FROM mx_612d2d62__items", a)
    refused("SELECT * FROM \"mx_612d2d62__items\"", a)
    refused("SELECT * FROM m_b__items", a)
    for (const sql of [
      "INSERT OR ROLLBACK INTO m_lists__items VALUES (1)",
      "SELECT RAISE(ROLLBACK, 'x')",
      "CREATE TRIGGER m_lists__t AFTER INSERT ON m_lists__items BEGIN SELECT RAISE(ROLLBACK, 'no'); END",
      "CREATE TEMP TABLE m_lists__x (a)",
      "SELECT * FROM temp.m_lists__items",
      "SELECT * FROM \"temp\".m_lists__items"
    ]) refused(sql, c({ allowSchema: true }))
    // A column called temp is fine.
    ok("SELECT temp FROM m_lists__items")
  })

  it("fails closed on anything it does not read exactly as SQLite does", () => {
    for (const sql of [
      "SELECT * FROM m_lists__items /* unterminated",
      "SELECT $name FROM m_lists__items",
      "SELECT #x FROM m_lists__items",
      "SELECT 1abc FROM m_lists__items",
      "SELECT x'abc' FROM m_lists__items",
      "SELECT x'zz' FROM m_lists__items",
      "SELECT a ^ b FROM m_lists__items",
      "SELECT { FROM m_lists__items",
      "SELECT * FROM m_lists__items WHERE a ! b",
      "SELECT 'unterminated FROM m_lists__items"
    ]) refused(sql, c())
    // Characters outside ASCII belong to a name, as in SQLite: this is one name in the module's own namespace.
    const t = tokenize("SELECT * FROM m_lists__items\u00a0pva_docs")
    assert.strictEqual(Array.isArray(t) ? t.at(-1)!.value : t, "m_lists__items\u00a0pva_docs")
  })

  it("keeps every operator as written, in core and module migrations alike", () => {
    const operators = ["!=", "<>", "<=", ">=", "==", "=", "<", ">", "||", "<<", ">>", "&", "|", "~", "+", "-", "*", "/", "%", "->", "->>"]
    const expr = (op: string) => (op === "~" ? "~ a" : op === "->" || op === "->>" ? `'{"k":1}' ${op} '$.k'` : `a ${op} b`)
    const sql = operators.map((op) => `CREATE VIEW core_s__v${operators.indexOf(op)} AS SELECT ${expr(op)} AS r FROM core_s__t`).join(";\n")
    const statements = coreStatements(`CREATE TABLE core_s__t (a INTEGER, b INTEGER);\n${sql}`)
    assert.strictEqual(statements.length, operators.length + 1)
    for (const [i, op] of operators.entries()) assert.include(statements[i + 1]!, expr(op))
    // They run on SQLite.
    const db = new DatabaseSync(":memory:")
    for (const s of statements) db.exec(s)
    db.exec("INSERT INTO core_s__t VALUES (6, 3)")
    assert.strictEqual((db.prepare("SELECT r FROM core_s__v0").get() as { r: number }).r, 1)
    assert.strictEqual((db.prepare(`SELECT r FROM core_s__v${operators.indexOf("||")}`).get() as { r: string }).r, "63")
    assert.strictEqual((db.prepare(`SELECT r FROM core_s__v${operators.indexOf("->>")}`).get() as { r: number }).r, 1)
    db.close()
    // A module migration the same way (comments and strings kept too).
    const split = migrationStatements("CREATE TABLE m_lists__t (a, b); -- note\nCREATE VIEW m_lists__v AS SELECT a FROM m_lists__t WHERE a != b AND a <= 'x;y' OR b >= 2", ctx({ allowSchema: true }))
    assert.deepStrictEqual("statements" in split ? split.statements : split, ["CREATE TABLE m_lists__t (a, b)", "CREATE VIEW m_lists__v AS SELECT a FROM m_lists__t WHERE a != b AND a <= 'x;y' OR b >= 2"])
  })

  it("a quoted dbstat is refused by the real store, which would otherwise run it", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      yield* store.prepare([{ id: "lists", storage: { sql: { migrations: LISTS } } }])
      const sql = store.forModule("lists").sql
      for (const q of ["SELECT name FROM \"dbstat\"", "SELECT name FROM 'dbstat'", "SELECT * FROM \"pragma_table_info\"('pva_docs')"]) {
        const exit = yield* Effect.exit(sql.query(q))
        assert.isTrue(Exit.isFailure(exit), q)
      }
      // What the guard refused does run on raw SQLite (so the refusal is what protects the store).
      const raw = new DatabaseSync(":memory:")
      assert.isTrue(raw.prepare("SELECT count(*) AS n FROM \"dbstat\"").all().length >= 0)
      raw.close()
      // Operators reach SQLite unchanged at run time too.
      yield* sql.run("INSERT INTO m_lists__items (id, text) VALUES ('1', 'a'), ('2', 'b')")
      assert.deepStrictEqual((yield* sql.query<{ id: string }>("SELECT id FROM m_lists__items WHERE text != 'a' AND id >= '1' AND text || 'x' <> 'ax'")).map((r) => r.id), ["2"])
    }))))
})
