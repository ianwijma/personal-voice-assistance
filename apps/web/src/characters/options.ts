/**
 * Character options, pure: validation, merging with defaults, colour resolution, the reserved ids, the host's
 * common settings and the sensitivity copy of the voice features. No DOM, no storage, so unit tests can import it.
 * Copied from the lab (docs/research/visualiser-investigation/lab/src/options.ts); behaviour unchanged, plus
 * `RESERVED_OPTIONS` and `reservedOptionProblems` (docs/CHARACTERS.md §4.4).
 */
import { BAND_COUNT, type OptionSpec, type OptionValues, type Palette, type Rgb, type VoiceFeatures } from "./contract.ts"

export const PALETTE_KEYS = ["you", "voice", "ink", "inkFaint"] as const
export type PaletteKey = (typeof PALETTE_KEYS)[number]

const HEX = /^#[0-9a-f]{6}$/i
export const isPaletteKey = (v: unknown): v is PaletteKey => typeof v === "string" && (PALETTE_KEYS as ReadonlyArray<string>).includes(v)
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v)

/** A valid colour value in its canonical form (palette key, or lower-case "#rrggbb"), or null. */
export const normaliseColor = (v: unknown): string | null => (isPaletteKey(v) ? v : isHexColor(v) ? v.toLowerCase() : null)

// ---------------------------------------------------------------------------------------------
// Colours

const parsed = new Map<string, Rgb>()
const FALLBACK: Rgb = [128, 128, 128]

/** Parse "#rrggbb" (cached, so repeated calls allocate nothing). Anything else gives mid grey. */
export const parseHex = (hex: string): Rgb => {
  const hit = parsed.get(hex)
  if (hit !== undefined) return hit
  if (!HEX.test(hex)) return FALLBACK
  const n = parseInt(hex.slice(1), 16)
  const rgb: Rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  if (parsed.size > 256) parsed.clear()
  parsed.set(hex, rgb)
  return rgb
}

/** A palette key resolved against `palette`, or a "#rrggbb" parsed. Anything else gives `palette.ink`. */
export const resolveColor = (value: unknown, palette: Palette): Rgb => {
  if (typeof value !== "string") return palette.ink
  switch (value) {
    case "you":
      return palette.you
    case "voice":
      return palette.voice
    case "ink":
      return palette.ink
    case "inkFaint":
      return palette.inkFaint
  }
  return HEX.test(value) ? parseHex(value) : palette.ink
}

export const rgbToHex = (c: Rgb): string => "#" + [c[0], c[1], c[2]].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")

// ---------------------------------------------------------------------------------------------
// Validation

const decimals = (x: number): number => {
  const s = String(x)
  const i = s.indexOf(".")
  return i < 0 ? 0 : s.length - i - 1
}

type NumberSpec = Extract<OptionSpec, { kind: "number" }>

/** Clamp to min..max and snap to the step grid anchored at min. Non-finite input gives the default. */
export const snapNumber = (spec: NumberSpec, v: number): number => {
  if (!Number.isFinite(v)) return spec.default
  const clamped = Math.min(spec.max, Math.max(spec.min, v))
  const step = spec.step > 0 ? spec.step : 0
  if (step === 0) return clamped
  let n = Math.round((clamped - spec.min) / step)
  if (spec.min + n * step > spec.max + 1e-9) n -= 1
  const d = Math.max(decimals(step), decimals(spec.min))
  return Number((spec.min + n * step).toFixed(Math.min(10, d)))
}

const TRUE = new Set(["1", "true", "on", "yes"])
const FALSE = new Set(["0", "false", "off", "no"])

/** One value validated against its spec; anything invalid gives the default. Accepts strings (from the URL). */
export const validateValue = (spec: OptionSpec, raw: unknown): number | boolean | string => {
  switch (spec.kind) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN
      return Number.isFinite(n) ? snapNumber(spec, n) : spec.default
    }
    case "toggle": {
      if (typeof raw === "boolean") return raw
      if (typeof raw === "string") {
        const s = raw.toLowerCase()
        if (TRUE.has(s)) return true
        if (FALSE.has(s)) return false
      }
      return spec.default
    }
    case "choice":
      return typeof raw === "string" && spec.choices.some((c) => c.value === raw) ? raw : spec.default
    case "color":
      return normaliseColor(raw) ?? normaliseColor(spec.default) ?? "ink"
  }
}

/**
 * The character's defaults overlaid with `stored`, every value validated. Complete: one entry per spec.
 * Unknown ids in `stored` are dropped. A character without options gives `{}`.
 */
export const resolveOptions = (specs: ReadonlyArray<OptionSpec> | undefined, stored: { readonly [id: string]: unknown } | undefined): OptionValues => {
  const out: { [id: string]: number | boolean | string } = {}
  if (specs === undefined) return out
  for (const s of specs) out[s.id] = stored !== undefined && Object.hasOwn(stored, s.id) ? validateValue(s, stored[s.id]) : validateValue(s, s.default)
  return out
}

/** True when `value` equals the spec's default. */
export const isDefault = (spec: OptionSpec, value: unknown): boolean => value === validateValue(spec, spec.default)

/** Canonical text for a value in the URL and in tests: numbers as written, toggles 1/0, the rest as is. */
export const valueToString = (v: number | boolean | string): string => (typeof v === "boolean" ? (v ? "1" : "0") : String(v))

// ---------------------------------------------------------------------------------------------
// Metadata checks (used by the host on every load and by the compatibility tests)

const ID = /^[a-z][A-Za-z0-9]*$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

export const optionProblems = (options: unknown): ReadonlyArray<string> => {
  if (options === undefined) return []
  if (!Array.isArray(options)) return ["options must be an array of option specs"]
  const out: Array<string> = []
  const seen = new Set<string>()
  options.forEach((o: unknown, i) => {
    if (!isObj(o)) {
      out.push(`options[${i}] is not an object`)
      return
    }
    const id = typeof o.id === "string" ? o.id : ""
    const at = id !== "" ? `options.${id}` : `options[${i}]`
    if (id === "") out.push(`${at}: id must be a non-empty string`)
    else {
      if (!ID.test(id)) out.push(`${at}: id must be camelCase (letters and digits, starting with a lower-case letter)`)
      if (seen.has(id)) out.push(`${at}: duplicate id`)
      seen.add(id)
    }
    if (typeof o.label !== "string" || o.label.trim() === "") out.push(`${at}: label must be a non-empty string`)
    if (o.help !== undefined && (typeof o.help !== "string" || o.help.trim() === "")) out.push(`${at}: help, when given, must be a non-empty string`)
    if (o.group !== undefined && (typeof o.group !== "string" || o.group.trim() === "")) out.push(`${at}: group, when given, must be a non-empty string`)
    switch (o.kind) {
      case "number": {
        const { min, max, step, default: d } = o as { min: unknown; max: unknown; step: unknown; default: unknown }
        if (typeof min !== "number" || typeof max !== "number" || typeof step !== "number" || typeof d !== "number" || ![min, max, step, d].every(Number.isFinite)) {
          out.push(`${at}: min, max, step and default must be finite numbers`)
          break
        }
        if (!(min < max)) out.push(`${at}: min (${min}) must be below max (${max})`)
        if (!(step > 0)) out.push(`${at}: step must be above 0`)
        if (d < min || d > max) out.push(`${at}: default ${d} is outside ${min}..${max}`)
        else if (min < max && step > 0 && snapNumber(o as unknown as NumberSpec, d) !== d) out.push(`${at}: default ${d} is not on the step grid (min ${min}, step ${step})`)
        if (o.unit !== undefined && typeof o.unit !== "string") out.push(`${at}: unit must be a string`)
        break
      }
      case "toggle":
        if (typeof o.default !== "boolean") out.push(`${at}: default must be true or false`)
        break
      case "choice": {
        const choices = o.choices
        if (!Array.isArray(choices) || choices.length < 2) {
          out.push(`${at}: choices must list at least two { value, label }`)
          break
        }
        const values = new Set<string>()
        choices.forEach((c: unknown, j) => {
          if (!isObj(c) || typeof c.value !== "string" || c.value === "") out.push(`${at}: choices[${j}].value must be a non-empty string`)
          else {
            if (values.has(c.value)) out.push(`${at}: duplicate choice value "${c.value}"`)
            values.add(c.value)
          }
          if (!isObj(c) || typeof c.label !== "string" || c.label.trim() === "") out.push(`${at}: choices[${j}].label must be a non-empty string`)
        })
        if (typeof o.default !== "string" || !values.has(o.default)) out.push(`${at}: default ${JSON.stringify(o.default)} is not one of the choices`)
        break
      }
      case "color":
        if (normaliseColor(o.default) === null) out.push(`${at}: default must be "#rrggbb" or one of ${PALETTE_KEYS.join(", ")}`)
        break
      default:
        out.push(`${at}: kind must be "number", "toggle", "choice" or "color"`)
    }
  })
  return out
}

// ---------------------------------------------------------------------------------------------
// Reserved ids (docs/CHARACTERS.md §4.4): the same id means the same thing in every character, so a person's
// settings carry over when they switch. A character need not offer them; when it does, it uses this kind and a
// default that is the designed look (1 for a number, on for a toggle).

export const RESERVED_OPTIONS: { readonly [id: string]: { readonly kinds: ReadonlyArray<"number" | "toggle">; readonly meaning: string } } = {
  size: { kinds: ["number"], meaning: "Overall size, 1 = designed size." },
  speed: { kinds: ["number"], meaning: "Speed of ambient motion, 1 = designed speed." },
  glow: { kinds: ["number", "toggle"], meaning: "Amount of glow or halo (1 = designed), or on/off where there is one glow." },
  expressiveness: { kinds: ["number"], meaning: "Figures: size of nods, tilts, bounces, flinches." },
  liveliness: { kinds: ["number"], meaning: "Figures: how often it blinks and shifts gaze." },
  mouthRange: { kinds: ["number"], meaning: "Figures with a mouth: how far it opens." },
  nods: { kinds: ["toggle"], meaning: "Figures: nods along at phrase ends." },
  followsPointer: { kinds: ["toggle"], meaning: "Figures with eyes: gaze follows the pointer." }
}

/** Reserved ids used with another kind, or with a default that is not the designed look. */
export const reservedOptionProblems = (options: ReadonlyArray<OptionSpec> | undefined): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const o of options ?? []) {
    const r = Object.hasOwn(RESERVED_OPTIONS, o.id) ? RESERVED_OPTIONS[o.id] : undefined
    if (r === undefined) continue
    if (o.kind !== "number" && o.kind !== "toggle") out.push(`options.${o.id}: a reserved id (${r.meaning}) must be of kind ${r.kinds.join(" or ")}`)
    else if (!r.kinds.includes(o.kind)) out.push(`options.${o.id}: a reserved id (${r.meaning}) must be of kind ${r.kinds.join(" or ")}, not ${o.kind}`)
    else if (o.kind === "number" && o.default !== 1) out.push(`options.${o.id}: a reserved number's default must be 1 (the designed look), not ${o.default}`)
    else if (o.kind === "toggle" && o.default !== true) out.push(`options.${o.id}: a reserved toggle's default must be on (the designed look)`)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Common settings (the host applies these to every character; their keys start with `$`)

export const COMMON_GROUP = "General"
export const COMMON_OPTIONS: ReadonlyArray<OptionSpec> = [
  { id: "$you", kind: "color", label: "Your colour", default: "you", group: COMMON_GROUP, help: "Replaces the colour of your side. The default follows the theme." },
  { id: "$voice", kind: "color", label: "Assistant colour", default: "voice", group: COMMON_GROUP, help: "Replaces the colour of the assistant's side. The default follows the theme." },
  { id: "$sensitivity", kind: "number", label: "Sensitivity", min: 0.4, max: 2.5, step: 0.05, default: 1, unit: "×", group: COMMON_GROUP, help: "Scales how loud the character thinks both voices are." }
]

/** What the host needs per character: its validated options plus the common settings. Replaced, not mutated, on change. */
export interface ResolvedOptions {
  /** Changes whenever any value of this character changes. */
  readonly version: number
  /** Validated values of the character's own options (`Frame.options`). */
  readonly values: OptionValues
  /** Validated common values, keyed "$you", "$voice", "$sensitivity". */
  readonly common: OptionValues
  /** `common.$you`: a palette key or "#rrggbb". */
  readonly you: string
  readonly voice: string
  readonly sensitivity: number
}

export const resolveAll = (specs: ReadonlyArray<OptionSpec> | undefined, stored: { readonly [id: string]: unknown } | undefined, version: number): ResolvedOptions => {
  const common = resolveOptions(COMMON_OPTIONS, stored)
  return {
    version,
    values: resolveOptions(specs, stored),
    common,
    you: String(common.$you),
    voice: String(common.$voice),
    sensitivity: Number(common.$sensitivity)
  }
}

/** The palette with `you` and `voice` replaced by the viewer's choice (keys resolve against `base`). */
export const recolour = (base: Palette, you: string, voice: string): Palette =>
  you === "you" && voice === "voice" ? base : { ...base, you: resolveColor(you, base), voice: resolveColor(voice, base) }

// ---------------------------------------------------------------------------------------------
// Sensitivity

const c01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * Copy `src` into `dst` with the loudness-like features (level, rms, bands, low, mid, high) multiplied by `k`
 * and clamped to 0..1. `bands` is the instance's own buffer (BAND_COUNT long): no allocation. Everything else
 * is copied as is, so a new field of VoiceFeatures needs no change here.
 */
export const scaleFeatures = (src: VoiceFeatures, dst: VoiceFeatures, bands: Float32Array, k: number): void => {
  Object.assign(dst, src)
  const n = Math.min(BAND_COUNT, bands.length, src.bands.length)
  for (let i = 0; i < n; i++) bands[i] = c01(src.bands[i]! * k)
  dst.bands = bands
  dst.level = c01(src.level * k)
  dst.rms = c01(src.rms * k)
  dst.low = c01(src.low * k)
  dst.mid = c01(src.mid * k)
  dst.high = c01(src.high * k)
}
