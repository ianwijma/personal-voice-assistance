// The guard on module SQL: a module reaches only its own tables, however a statement is quoted or split.
import { describe, expect, it } from "@effect/vitest"
import { checkModuleStatement, type GuardContext, migrationStatements, splitStatements, tokenize } from "../src/SqlGuard.ts"

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
