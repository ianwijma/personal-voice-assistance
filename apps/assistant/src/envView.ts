/**
 * The environment as the settings see it (docs/SETTINGS-UI.md §4.4): every
 * variable with where it came from, a `.env` file (path and line) or the
 * process environment (exported by the shell or the service), and
 * "Move to settings": take a variable out of the environment (`release`) and
 * comment its line out of the `.env` file (`commentOutKeys`).
 *
 * Values come from Node's own parser (`util.parseEnv`), so they are exactly
 * what `process.loadEnvFile` would load; line numbers come from a scan that
 * follows the same rules for comments, `export` and quoted values over several
 * lines.
 */
import { randomBytes } from "node:crypto"
import { chmod, copyFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { parseEnv } from "node:util"

export type EnvOrigin = { readonly kind: "file"; readonly path: string; readonly line: number } | { readonly kind: "process" }

/** One assignment in a `.env` file: the key, the 1-based line it starts on, and how many lines it spans. */
export interface EnvAssignment {
  readonly key: string
  readonly line: number
  readonly lines: number
}

const ASSIGNMENT = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/s

/**
 * The assignments of a `.env` text, in order (a key assigned twice appears twice; the last one wins, as in
 * `util.parseEnv`). A value that opens a quote (`"`, `'` or `` ` ``) without closing it continues on the next lines.
 */
export const scanEnvAssignments = (text: string): ReadonlyArray<EnvAssignment> => {
  const lines = text.split(/\r?\n/)
  const out: Array<EnvAssignment> = []
  for (let i = 0; i < lines.length; i++) {
    const match = ASSIGNMENT.exec(lines[i]!)
    if (match === null) continue
    const key = match[1]!
    const value = match[2]!
    let span = 1
    const quote = value[0]
    if (quote === "\"" || quote === "'" || quote === "`") {
      const closesHere = value.indexOf(quote, 1) !== -1
      if (!closesHere) {
        // Look for the closing quote on a later line; without one, the value is just this line (as Node reads it).
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.includes(quote)) {
            span = j - i + 1
            break
          }
        }
      }
    }
    out.push({ key, line: i + 1, lines: span })
    i += span - 1
  }
  return out
}

/** The values (Node's parser) and the line of each key's effective (last) assignment. */
export const parseEnvFile = (text: string): ReadonlyArray<{ readonly key: string; readonly value: string; readonly line: number }> => {
  const values = parseEnv(text) as Record<string, string>
  const lineOf = new Map<string, number>()
  for (const a of scanEnvAssignments(text)) lineOf.set(a.key, a.line)
  return Object.entries(values).map(([key, value]) => ({ key, value, line: lineOf.get(key) ?? 0 }))
}

export interface EnvView {
  /** The variables in effect (non-empty and empty), as a live record: `release` deletes from it. Pass it as `env`. */
  readonly record: Readonly<Record<string, string | undefined>>
  readonly get: (key: string) => string | undefined
  readonly origin: (key: string) => EnvOrigin | undefined
  /** For `SettingsSources.envOrigin`. */
  readonly sourceOf: (key: string) => "env-file" | "env-process"
  /** For `SettingsSources.envLocation`. */
  readonly locationOf: (key: string) => { readonly file: string; readonly line: number } | undefined
  /** The `.env` files read, in the order they were applied (the first one wins). */
  readonly files: ReadonlyArray<string>
  /** Every loaded file that declares a key, including declarations shadowed by an earlier file. */
  readonly declaredIn: (key: string) => ReadonlyArray<string>
  /** Parsed declarations at startup, including shadowed values, for move-time validation. */
  readonly fileValues: (path: string) => Readonly<Record<string, string>>
  /** Every set variable (non-empty), including redacted ones (their value is gone, their origin is kept). */
  readonly keys: () => ReadonlyArray<string>
  /**
   * Forget the value but keep the variable listed with its origin (`PVA_VAULT_PASSWORD` once serve mode read it):
   * nothing can read it any more, and the Overrides page still says where it is set.
   */
  readonly redact: (key: string) => void
  /** Stop treating `key` as set (after "Move to settings"); also removes it from `process.env` when this view owns it. */
  readonly release: (key: string) => void
  /** Undo a `release` (the move failed). */
  readonly restore: (key: string, value: string, origin: EnvOrigin) => void
  readonly subscribe: (listener: () => void) => () => void
}

export interface EnvViewOptions {
  /** The environment before any `.env` file (the process's). The view copies it. */
  readonly processEnv: Readonly<Record<string, string | undefined>>
  /** Parsed `.env` files in order; a key already set (by the process or an earlier file) is not taken from a later one. */
  readonly files?: ReadonlyArray<{ readonly path: string; readonly text: string }>
  /** Also delete released keys from this object (the real `process.env`, so child processes do not inherit them). */
  readonly mirror?: Record<string, string | undefined>
}

export const makeEnvView = (options: EnvViewOptions): EnvView => {
  const record: Record<string, string | undefined> = { ...options.processEnv }
  const origins = new Map<string, EnvOrigin>()
  for (const key of Object.keys(record)) origins.set(key, { kind: "process" })
  const files: Array<string> = []
  const declarations = new Map<string, Array<string>>()
  const fileValues = new Map<string, Record<string, string>>()
  for (const file of options.files ?? []) {
    files.push(file.path)
    const parsed = parseEnvFile(file.text)
    fileValues.set(file.path, Object.fromEntries(parsed.map(({ key, value }) => [key, value])))
    for (const { key, value, line } of parsed) {
      declarations.set(key, [...(declarations.get(key) ?? []), file.path])
      if (Object.hasOwn(record, key)) continue
      record[key] = value
      origins.set(key, { kind: "file", path: file.path, line })
    }
  }
  const redacted = new Map<string, EnvOrigin>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // a listener must not break the view
      }
    }
  }
  return {
    record,
    get: (key) => {
      const v = record[key]
      return v === undefined || v === "" ? undefined : v
    },
    origin: (key) => (Object.hasOwn(record, key) ? origins.get(key) : redacted.get(key)),
    sourceOf: (key) => (origins.get(key)?.kind === "file" ? "env-file" : "env-process"),
    locationOf: (key) => {
      const o = origins.get(key)
      return o?.kind === "file" ? { file: o.path, line: o.line } : undefined
    },
    files,
    declaredIn: (key) => declarations.get(key) ?? [],
    fileValues: (path) => fileValues.get(path) ?? {},
    keys: () => [...Object.keys(record).filter((k) => (record[k] ?? "") !== ""), ...redacted.keys()],
    redact: (key) => {
      const origin = origins.get(key)
      if (!Object.hasOwn(record, key) || origin === undefined) return
      if ((record[key] ?? "") !== "") redacted.set(key, origin)
      for (const values of fileValues.values()) delete values[key]
      delete record[key]
      origins.delete(key)
      if (options.mirror !== undefined) delete options.mirror[key]
    },
    release: (key) => {
      if (!Object.hasOwn(record, key)) return
      delete record[key]
      origins.delete(key)
      if (options.mirror !== undefined) delete options.mirror[key]
      changed()
    },
    restore: (key, value, origin) => {
      record[key] = value
      origins.set(key, origin)
      if (options.mirror !== undefined) options.mirror[key] = value
      changed()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** `2026-11-14`. */
const day = (now: Date) => now.toISOString().slice(0, 10)

export interface CommentOutResult {
  /** The keys whose lines were commented out. */
  readonly keys: ReadonlyArray<string>
  /** The copy of the file as it was (mode 0600). */
  readonly backup: string
}

/**
 * Comment every assignment of `keys` out of a `.env` file: the line becomes `# KEY moved to the settings UI on
 * <date>` (the value is never written anywhere but the backup; the continuation lines of a quoted multi-line value
 * are dropped). The original is copied to `<file>.bak-<timestamp>` (0600) first, then the new text is written to a
 * temporary file in the same folder with the original's mode and renamed over it, so a crash leaves either the old
 * or the new file.
 */
export const commentOutKeys = async (
  path: string,
  keys: ReadonlyArray<string>,
  now: Date = new Date()
): Promise<CommentOutResult> => {
  const text = await readFile(path, "utf8")
  const { mode } = await stat(path)
  const wanted = new Set(keys)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  const out: Array<string> = []
  const done = new Set<string>()
  let next = 0
  for (const a of scanEnvAssignments(text)) {
    if (!wanted.has(a.key)) continue
    for (; next < a.line - 1; next++) out.push(lines[next]!)
    out.push(`# ${a.key} moved to the settings UI on ${day(now)}`)
    next = a.line - 1 + a.lines
    done.add(a.key)
  }
  for (; next < lines.length; next++) out.push(lines[next]!)

  const stamp = now.toISOString().replace(/[:.]/g, "-")
  const backup = `${path}.bak-${stamp}`
  await copyFile(path, backup)
  await chmod(backup, 0o600)
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(tmp, out.join(eol), { mode: mode & 0o777 })
    await chmod(tmp, mode & 0o777)
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  return { keys: [...done], backup }
}
