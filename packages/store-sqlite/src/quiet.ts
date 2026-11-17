/**
 * Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` once when `node:sqlite` is first loaded.
 * It would land in the middle of the CLI modes' output (stderr) and in every serve log, so it is filtered here: only
 * that one warning, everything else passes. The driver (and with it `node:sqlite`) is loaded with a dynamic import
 * in `makeSqliteStore`, after this filter is in place: a static import of a built-in is linked, and warns, before any
 * module code runs.
 */
const marker = Symbol.for("@pva/store-sqlite/quiet")
const global = globalThis as unknown as Record<symbol, boolean>

if (global[marker] !== true) {
  global[marker] = true
  const original = process.emitWarning.bind(process) as (...args: Array<unknown>) => void
  process.emitWarning = ((warning: unknown, ...rest: Array<unknown>) => {
    const text = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : ""
    const first = rest[0]
    const type = typeof first === "string"
      ? first
      : typeof first === "object" && first !== null && "type" in first
      ? String((first as { type: unknown }).type)
      : warning instanceof Error
      ? warning.name
      : ""
    if (type === "ExperimentalWarning" && /\bSQLite\b/.test(text)) return
    original(warning, ...rest)
  }) as typeof process.emitWarning
}

export {}
