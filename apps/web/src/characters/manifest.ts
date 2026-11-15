/**
 * Manifest checks: what the host verifies on every load before it creates a character, and what the
 * compatibility tests verify for every character in the library (docs/CHARACTERS.md §3, §6).
 */
import { CONTRACT_VERSION, CORE_MODES, EXTRA_MODES, type Character } from "./contract.ts"
import { optionProblems, reservedOptionProblems } from "./options.ts"

/** The contract major versions this host can drive. */
export const SERVED_CONTRACTS: ReadonlyArray<number> = [CONTRACT_VERSION]
/** The renderers this host can give a canvas for. */
export const SERVED_RENDERERS: ReadonlyArray<string> = ["2d", "webgl2"]

const FAMILIES = ["baseline", "abstract", "figure"]
const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const text = (v: unknown): boolean => typeof v === "string" && v.trim() !== ""

/** Why the host would not run this module's default export, or `[]`. `id`: the id it was loaded under (its file name). */
export const manifestProblems = (c: unknown, id: string): ReadonlyArray<string> => {
  if (!isObj(c)) return ["no default export (export default a Character)"]
  const out: Array<string> = []
  if (c.id !== id) out.push(`id is ${JSON.stringify(c.id)}, must equal the file name "${id}"`)
  else if (!ID.test(id)) out.push(`id "${id}" must be kebab-case`)
  for (const k of ["name", "summary", "inspiredBy"]) if (!text(c[k])) out.push(`${k} must be a non-empty string`)
  if (typeof c.version !== "string" || !SEMVER.test(c.version)) out.push(`version ${JSON.stringify(c.version)} must be a semantic version, e.g. "1.0.0"`)
  if (typeof c.contract !== "number" || !SERVED_CONTRACTS.includes(c.contract)) out.push(`contract ${JSON.stringify(c.contract)} is not served (this host serves ${SERVED_CONTRACTS.join(", ")})`)
  if (typeof c.family !== "string" || !FAMILIES.includes(c.family)) out.push(`family must be one of ${FAMILIES.join(", ")}`)
  if (typeof c.renderer !== "string" || !SERVED_RENDERERS.includes(c.renderer)) out.push(`renderer ${JSON.stringify(c.renderer)} is not served (this host serves ${SERVED_RENDERERS.join(", ")})`)
  if (typeof c.create !== "function") out.push("create(canvas) is missing")
  const modes = isObj(c.modes) ? c.modes : undefined
  for (const m of CORE_MODES) if (!text(modes?.[m])) out.push(`modes.${m} is missing`)
  if (c.extraModes !== undefined) {
    if (!isObj(c.extraModes)) out.push("extraModes must be an object")
    else
      for (const [m, v] of Object.entries(c.extraModes)) {
        if (!Object.hasOwn(EXTRA_MODES, m)) out.push(`extraModes.${m} is not a mode of the contract (${Object.keys(EXTRA_MODES).join(", ")})`)
        else if (!text(v)) out.push(`extraModes.${m} must say how it looks`)
      }
  }
  if (!Array.isArray(c.mappings) || c.mappings.length === 0) out.push("mappings must list at least one signal → effect")
  else c.mappings.forEach((m: unknown, i) => {
    if (!isObj(m) || !text(m.signal) || !text(m.effect)) out.push(`mappings[${i}] needs a signal and an effect`)
  })
  if (c.uses !== undefined) {
    if (!Array.isArray(c.uses)) out.push("uses must be an array")
    else c.uses.forEach((u: unknown, i) => {
      if (!isObj(u) || !text(u.ext) || !text(u.gain) || !text(u.without)) out.push(`uses[${i}] needs ext, gain and without (what it does when the extension is absent)`)
    })
  }
  const options = optionProblems(c.options)
  out.push(...options)
  if (options.length === 0 && Array.isArray(c.options)) out.push(...reservedOptionProblems(c.options as Character["options"]))
  return out
}
