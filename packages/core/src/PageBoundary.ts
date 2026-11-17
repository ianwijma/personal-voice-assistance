import { type ChoiceOption, OptionTag, type StatusLine } from "@pva/protocol"
import { Schema } from "effect"

/**
 * The one boundary between module-produced text and the admin page (docs/UI-AND-MODULES.md §1.7.1). Everything a
 * module says that a page shows passes `text` (or `options`, `status`): field-action results, `info` values, runtime
 * `combo` options, status lines, start errors, Health issues, tool and route descriptions, route call-log notes.
 *
 * It replaces every secret value the module has been given since the host started (`remember`: the settings its
 * `shared`, `start`, field actions and `health()` were called with), together with the secrets known now (`current`:
 * saved and environment), by `[secret]`, BEFORE anything is shortened: a vault locked since, or a key rotated since,
 * does not make an instance's old key showable, and clipping cannot leave a prefix that no longer matches. A value's
 * JSON-escaped and URL-encoded forms are replaced too. An option whose machine value holds a secret is dropped (a
 * changed value would change what choosing it means). Values shorter than `MIN_SECRET_LENGTH` are not looked for.
 */
export interface PageBoundary {
  /** The module was given these secret values (kept for the host's life; at most `MAX_REMEMBERED` per module). */
  readonly remember: (moduleId: string, values: Iterable<unknown>) => void
  /** `text` with every secret of the module replaced (no shortening). */
  readonly redact: (moduleId: string, text: string) => string
  /** What the page may show of `value`: as text, secrets replaced, then shortened to `max` characters. */
  readonly text: (moduleId: string, value: unknown, max: number) => string
  /** Runtime options: display texts replaced and shortened, known tags kept, options whose value holds a secret (or malformed) dropped; nothing else of a module's option is passed on. */
  readonly options: (moduleId: string, list: unknown) => Array<ChoiceOption> | undefined
  /** A status line: its text replaced and shortened to the wire's 120 characters, a known tone. */
  readonly status: (moduleId: string, status: StatusLine | undefined) => StatusLine | undefined
}

/** Distinct secret values remembered per module (rotations are rare; the oldest not known now goes first). */
export const MAX_REMEMBERED = 64

export const REDACTED = "[secret]"

/**
 * Shorter values are not looked for: a one- to three-character "secret" protects nothing (it is guessed at once),
 * and replacing every "t" would leave the page unreadable.
 */
export const MIN_SECRET_LENGTH = 4

const isOptionTag = Schema.is(OptionTag)

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`)

export const makePageBoundary = (options: {
  /** The module's secrets known now (saved, and set in the environment). */
  readonly current: (moduleId: string) => Iterable<string>
}): PageBoundary => {
  const given = new Map<string, Set<string>>()

  const remember = (moduleId: string, values: Iterable<unknown>) => {
    let set = given.get(moduleId)
    for (const v of values) {
      if (typeof v !== "string" || v.length === 0) continue
      if (set === undefined) given.set(moduleId, (set = new Set()))
      set.delete(v)
      set.add(v)
    }
    if (set === undefined || set.size <= MAX_REMEMBERED) return
    const now = new Set(options.current(moduleId))
    for (const v of set) {
      if (set.size <= MAX_REMEMBERED) break
      if (!now.has(v)) set.delete(v)
    }
  }

  /** Every form of every secret, longest first (a secret that contains another is replaced whole). */
  const needles = (moduleId: string): Array<string> => {
    const out = new Set<string>()
    for (const v of [...(given.get(moduleId) ?? []), ...options.current(moduleId)]) {
      if (typeof v !== "string" || v.length < MIN_SECRET_LENGTH) continue
      out.add(v)
      const json = JSON.stringify(v).slice(1, -1)
      if (json !== v) out.add(json)
      try {
        const url = encodeURIComponent(v)
        if (url !== v) out.add(url)
      } catch {
        // A lone surrogate cannot be URL-encoded (and so cannot appear so).
      }
    }
    return [...out].sort((a, b) => b.length - a.length)
  }

  const redact = (moduleId: string, text: string): string => {
    let out = text
    for (const needle of needles(moduleId)) if (out.includes(needle)) out = out.split(needle).join(REDACTED)
    return out
  }

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
    const out: Array<ChoiceOption> = []
    for (const o of list as ReadonlyArray<unknown>) {
      if (typeof o !== "object" || o === null) continue
      const { description, implication, label, tags, value } = o as Record<string, unknown>
      if (typeof value !== "string" || typeof label !== "string") continue
      // The machine value is what gets saved: one that holds a secret is not offered at all.
      if (redact(moduleId, value) !== value) continue
      out.push({
        value,
        label: text(moduleId, label, 200),
        ...(typeof description === "string" ? { description: text(moduleId, description, 500) } : {}),
        ...(Array.isArray(tags) ? { tags: tags.filter((t): t is OptionTag => isOptionTag(t)) } : {}),
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

  return { remember, redact, text, options: optionList, status }
}
