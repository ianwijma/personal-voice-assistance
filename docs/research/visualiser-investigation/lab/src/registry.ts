/**
 * The design registry: every `src/designs/<id>.ts`, discovered by the build (no shared list to edit).
 * Each module is checked against the contract at load; a broken one becomes an error entry that the
 * page shows as a tile with the message, and the rest keep working.
 */
import { designs as modules } from "lab:designs"
import { MODES, type Design } from "./contract.ts"
import { optionProblems } from "./options.ts"

export type Entry = { readonly file: string; readonly design: Design; readonly error?: undefined } | { readonly file: string; readonly design?: undefined; readonly error: string }

const FAMILIES = ["baseline", "abstract", "character"] as const

const problems = (file: string, d: unknown): ReadonlyArray<string> => {
  if (typeof d !== "object" || d === null) return ["no default export (export default a Design)"]
  const o = d as Record<string, unknown>
  const out: Array<string> = []
  if (o.id !== file) out.push(`id is ${JSON.stringify(o.id)}, must equal the file name "${file}"`)
  for (const k of ["name", "summary", "inspiredBy", "serverNeeds"]) if (typeof o[k] !== "string" || o[k] === "") out.push(`${k} must be a non-empty string`)
  if (!FAMILIES.includes(o.family as (typeof FAMILIES)[number])) out.push(`family must be one of ${FAMILIES.join(", ")}`)
  if (o.renderer !== "2d" && o.renderer !== "webgl2") out.push(`renderer must be "2d" or "webgl2"`)
  if (typeof o.create !== "function") out.push("create(canvas) is missing")
  const modes = o.modes as Record<string, unknown> | undefined
  for (const m of MODES) if (typeof modes?.[m] !== "string") out.push(`modes.${m} is missing`)
  if (!Array.isArray(o.mappings) || o.mappings.length === 0) out.push("mappings must list at least one signal → effect")
  out.push(...optionProblems(o.options))
  return out
}

/** Families in order; entries that failed to load go last. */
const rank = (e: Entry): number => (e.design === undefined ? FAMILIES.length : FAMILIES.indexOf(e.design.family))

export const ENTRIES: ReadonlyArray<Entry> = modules
  .map((m): Entry => {
    if (m.error !== undefined) return { file: m.file, error: m.error }
    const d = (m.module as { default?: unknown } | undefined)?.default
    const p = problems(m.file, d)
    return p.length > 0 ? { file: m.file, error: p.join("; ") } : { file: m.file, design: d as Design }
  })
  .sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file))

export const FAMILY_LABEL: { readonly [F in Design["family"]]: string } = { baseline: "Baseline", abstract: "Abstract", character: "Character" }
