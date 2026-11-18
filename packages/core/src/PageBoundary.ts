import { type ChoiceOption, OptionTag, type StatusLine } from "@pva/protocol"
import { Schema } from "effect"

/**
 * The safety net between text a module's own code wrote and an admin page (docs/UI-AND-MODULES.md §1.7.1).
 *
 * What it is not: the guarantee that no secret reaches a page. That has two other parts. The host itself never puts a
 * secret on a page: everything it produces from settings leaves secret fields out by construction (by field kind, not
 * by looking at text). Text a module's code writes (a status line, an error, an action result, an `info` value, an
 * option label, a route description or path, a token label) is the module's responsibility: modules are compiled into
 * the app and trusted, and the module author documentation says never to put a secret, or anything derived from one,
 * in any of them.
 *
 * Its exact contract, for module-written text on its way to a page (`text`, `redact`, `options`, `status`):
 *
 * - Every exact, case-sensitive occurrence of a current or earlier value of a secret field of that module is replaced
 *   by `[secret]`, whatever its length (one character upwards; the empty string is no value). Overlapping or adjacent
 *   occurrences become one placeholder. Matching happens on the whole text, before it is clipped; a text longer than
 *   `MAX_CHECKED_LENGTH` is not shown at all (`TOO_LONG`), so no cut can leave part of a value behind.
 * - Current values: what `current` reports (the module's saved, proposed and environment secrets). Earlier values:
 *   those the module's code was given (`remember`), each kept for as long as any holder that received it (a shared
 *   part or instance of the module, a field-action press, a health check) is alive (`release` when it has ended).
 *   Nothing is evicted while its holder lives. Tokens the module mints through `host.routeTokens` are remembered the
 *   same way, with the part that minted them as holder.
 * - The number of distinct values kept per module is capped (`MAX_REMEMBERED`, generous: the secret fields of a
 *   manifest times many rotations). A value that would exceed it is not forgotten silently: while any holder that was
 *   given a value the boundary could not keep is alive, every text of that module is replaced by `OVERFLOW` (and its
 *   runtime options are dropped).
 * - A runtime option (a `combo` suggestion) whose machine value contains a value is dropped (a changed value would
 *   change what choosing it means); its display texts are redacted like any text. At most `MAX_OPTIONS` are looked at.
 *
 * It does not promise to find a secret that module code encoded, split, hashed or otherwise transformed: only exact
 * occurrences of the values themselves.
 */
export interface PageBoundary {
  /** `holder` (a part, a press, a health check) of module `moduleId` was given these values: kept while it lives. */
  readonly remember: (moduleId: string, holder: object, values: Iterable<unknown>) => void
  /** `holder` has ended: the values only it held are forgotten. */
  readonly release: (holder: object) => void
  /** `text` with every value of the module replaced (no shortening; `OVERFLOW` / `TOO_LONG` as above). */
  readonly redact: (moduleId: string, text: string) => string
  /** What the page may show of `value`: as text, values replaced, then shortened to `max` characters. */
  readonly text: (moduleId: string, value: unknown, max: number) => string
  /**
   * Runtime options: at most `MAX_OPTIONS` looked at; display texts replaced and shortened, known tags kept, options
   * whose value holds a value (or malformed) dropped; nothing else of a module's option is passed on.
   */
  readonly options: (moduleId: string, list: unknown) => Array<ChoiceOption> | undefined
  /** A status line: its text replaced and shortened to the wire's 120 characters, a known tone. */
  readonly status: (moduleId: string, status: StatusLine | undefined) => StatusLine | undefined
  /** Is any value of the module found in `text`? (A route path or a token name that holds one is not shown.) */
  readonly holds: (moduleId: string, text: string) => boolean
}

/** Distinct remembered values per module before the boundary fails closed for it. */
export const MAX_REMEMBERED = 1024

/** Longest module text that is checked at all; a longer one is replaced by `TOO_LONG`. */
export const MAX_CHECKED_LENGTH = 65_536

/** Runtime options looked at per field (the rest are not offered). */
export const MAX_OPTIONS = 200

export const REDACTED = "[secret]"
/** What every text of a module says while the boundary could not keep all of its values. */
export const OVERFLOW = "[hidden: this module was given more secret values than the page can check]"
/** What a text too long to be checked says. */
export const TOO_LONG = "[hidden: too long to show]"

const isOptionTag = Schema.is(OptionTag)

/** Cut to `max` characters with "…", never through the middle of a character (a surrogate pair stays whole). */
const clip = (text: string, max: number) => {
  if (text.length <= max) return text
  let n = Math.max(0, max - 1)
  const c = n > 0 ? text.charCodeAt(n - 1) : 0
  if (c >= 0xd800 && c <= 0xdbff) n--
  return `${text.slice(0, n)}…`
}

interface ModuleValues {
  /** Value → the holders that were given it. */
  readonly held: Map<string, Set<object>>
  /** Holders given a value that could not be kept: the module fails closed while any of them lives. */
  readonly overflowed: Set<object>
  /** Changes with `held` (the matcher cache key, with the current values). */
  revision: number
  cache: { readonly key: string; readonly matcher: Matcher } | undefined
}

/** The values to look for, by their first character, longest first. */
type Matcher = ReadonlyMap<string, ReadonlyArray<string>>

const matcherOf = (values: Iterable<string>): Matcher => {
  const byFirst = new Map<string, Array<string>>()
  for (const v of new Set(values)) {
    const list = byFirst.get(v[0]!) ?? []
    list.push(v)
    byFirst.set(v[0]!, list)
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length)
  return byFirst
}

/** Replace every occurrence (overlapping ones merged) of every value by one placeholder per covered run. */
const replaceAll = (text: string, matcher: Matcher): string => {
  if (matcher.size === 0) return text
  let out = ""
  let coveredUntil = 0
  let runStart = -1
  for (let i = 0; i < text.length; i++) {
    const candidates = matcher.get(text[i]!)
    if (candidates !== undefined) {
      for (const v of candidates) {
        if (i + v.length > coveredUntil && text.startsWith(v, i)) {
          coveredUntil = i + v.length
          break
        }
      }
      // Shorter candidates cannot reach further than the longest that matched; a longer one that did not match is
      // tried before them (longest first), so the first match is the furthest.
    }
    if (i < coveredUntil) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0) {
      out += REDACTED
      runStart = -1
    }
    out += text[i]
  }
  if (runStart >= 0) out += REDACTED
  return out
}

export const makePageBoundary = (options: {
  /** The module's secret values known now (saved, proposed, set in the environment). */
  readonly current: (moduleId: string) => Iterable<string>
}): PageBoundary => {
  const modules = new Map<string, ModuleValues>()
  /** Holder → the values it holds, by module (for `release`). */
  const holders = new Map<object, Array<readonly [string, string]>>()

  const of = (moduleId: string): ModuleValues => {
    let m = modules.get(moduleId)
    if (m === undefined) modules.set(moduleId, (m = { held: new Map(), overflowed: new Set(), revision: 0, cache: undefined }))
    return m
  }

  const remember = (moduleId: string, holder: object, values: Iterable<unknown>) => {
    const m = of(moduleId)
    for (const v of values) {
      if (typeof v !== "string" || v.length === 0) continue
      let set = m.held.get(v)
      if (set === undefined) {
        if (m.held.size >= MAX_REMEMBERED) {
          // Fail closed rather than forget a value: every text of the module is hidden while this holder lives.
          m.overflowed.add(holder)
          if (!holders.has(holder)) holders.set(holder, [])
          continue
        }
        m.held.set(v, (set = new Set()))
        m.revision++
      }
      if (set.has(holder)) continue
      set.add(holder)
      const list = holders.get(holder) ?? []
      list.push([moduleId, v])
      holders.set(holder, list)
    }
  }

  const release = (holder: object) => {
    const list = holders.get(holder)
    holders.delete(holder)
    for (const m of modules.values()) m.overflowed.delete(holder)
    for (const [moduleId, v] of list ?? []) {
      const m = modules.get(moduleId)
      const set = m?.held.get(v)
      if (m === undefined || set === undefined) continue
      set.delete(holder)
      if (set.size === 0) {
        m.held.delete(v)
        m.revision++
      }
    }
  }

  /** The module's matcher: cached per revision of what it holds and per current values. */
  const matcher = (moduleId: string): Matcher => {
    const m = of(moduleId)
    const current = [...options.current(moduleId)].filter((v): v is string => typeof v === "string" && v.length > 0)
    // A collision-free key: a value may itself contain any character (NUL included), so the list is serialized whole.
    const key = JSON.stringify([m.revision, current])
    if (m.cache?.key === key) return m.cache.matcher
    const built = matcherOf([...m.held.keys(), ...current])
    m.cache = { key, matcher: built }
    return built
  }

  const closed = (moduleId: string) => (modules.get(moduleId)?.overflowed.size ?? 0) > 0

  const redact = (moduleId: string, text: string): string => {
    if (closed(moduleId)) return OVERFLOW
    if (text.length > MAX_CHECKED_LENGTH) return TOO_LONG
    return replaceAll(text, matcher(moduleId))
  }

  const holds = (moduleId: string, text: string): boolean => closed(moduleId) || text.length > MAX_CHECKED_LENGTH || replaceAll(text, matcher(moduleId)) !== text

  const asText = (value: unknown): string => {
    if (typeof value === "string") return value
    if (value === undefined || value === null) return ""
    try {
      return String(value)
    } catch {
      return ""
    }
  }

  const text = (moduleId: string, value: unknown, max: number) => clip(redact(moduleId, asText(value)), max)

  const optionList = (moduleId: string, list: unknown): Array<ChoiceOption> | undefined => {
    if (!Array.isArray(list)) return undefined
    if (closed(moduleId)) return []
    const out: Array<ChoiceOption> = []
    for (const o of (list as ReadonlyArray<unknown>).slice(0, MAX_OPTIONS)) {
      if (typeof o !== "object" || o === null) continue
      const { description, implication, label, tags, value } = o as Record<string, unknown>
      if (typeof value !== "string" || typeof label !== "string" || value.length === 0 || value.length > 200) continue
      // The machine value is what gets saved: one that holds a secret is not offered at all.
      if (holds(moduleId, value)) continue
      out.push({
        value,
        label: text(moduleId, label, 200),
        ...(typeof description === "string" ? { description: text(moduleId, description, 500) } : {}),
        ...(Array.isArray(tags) ? { tags: tags.slice(0, 6).filter((t): t is OptionTag => isOptionTag(t)) } : {}),
        ...(typeof implication === "string" ? { implication: text(moduleId, implication, 500) } : {})
      })
    }
    return out
  }

  const status = (moduleId: string, line: StatusLine | undefined): StatusLine | undefined => {
    if (line === undefined || typeof line !== "object" || line === null) return undefined
    const tone = line.tone === "ok" || line.tone === "warning" || line.tone === "error" ? line.tone : "neutral"
    return { text: text(moduleId, line.text, 120), tone }
  }

  return { remember, release, redact, text, options: optionList, status, holds }
}
