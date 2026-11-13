import type {
  ApplyMode,
  ChoiceOption,
  FieldError,
  SecretState,
  SettingField,
  SettingsForm,
  SettingsPatch,
  SettingValue
} from "@pva/protocol"

/**
 * Typed settings for modules and assistant settings sections.
 *
 * A module declares its settings as a record of `Setting`s built with the
 * constructors below. From that one declaration come the TypeScript type of the
 * settings (`SettingsOf<typeof spec>`), validation of stored and submitted
 * values, environment-variable overrides, and the field descriptions the web UI
 * renders as a form (`SettingField` in `@pva/protocol`). The set of field types
 * is closed: each has exactly one widget in the UI.
 *
 * Precedence for every field: environment variable (when the field names one
 * and it is set to a non-empty value; the field is then locked in the UI) >
 * saved value > default. For secrets: environment variable > saved secret > not set.
 *
 * See docs/UI-AND-MODULES.md §1.
 */

export type Decoded<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }

interface SettingCommon {
  readonly label: string
  readonly description?: string
  /** Hidden behind "Show advanced settings". */
  readonly advanced?: boolean
  /** Default "live". Assistant settings that need new engines use "reload". */
  readonly apply?: ApplyMode
  /** Environment variable that, when set, provides the value and locks the field. */
  readonly env?: string
}

/** One setting. `A` is the type the module receives. */
export interface Setting<A> {
  readonly type: SettingField["type"]
  readonly secret: boolean
  readonly env: string | undefined
  /** Value when nothing is saved and the environment does not set it. */
  readonly defaultValue: A
  /** The field description for the UI (without `locked`, which depends on the environment). */
  readonly describe: (key: string) => SettingField
  /** Validate a saved or submitted value (JSON). */
  readonly decode: (raw: unknown) => Decoded<A>
  /** Parse the text of an environment variable. */
  readonly fromEnv: (text: string) => Decoded<A>
}

export type SettingsSpec = { readonly [key: string]: Setting<any> }
export type SettingsOf<S extends SettingsSpec> = { readonly [K in keyof S]: S[K] extends Setting<infer A> ? A : never }

const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
const fail = (error: string): Decoded<never> => ({ ok: false, error })

const commonFields = (key: string, options: SettingCommon) => ({
  key,
  label: options.label,
  apply: options.apply ?? "live",
  ...(options.description !== undefined ? { description: options.description } : {}),
  ...(options.advanced !== undefined ? { advanced: options.advanced } : {})
})

const text = (options: SettingCommon & {
  readonly default?: string
  readonly placeholder?: string
  readonly maxLength?: number
  readonly multiline?: boolean
  /** Extra validation; return a message for an invalid value. */
  readonly check?: (value: string) => string | undefined
}): Setting<string> => {
  const maxLength = options.maxLength ?? 500
  const decode = (raw: unknown): Decoded<string> => {
    if (typeof raw !== "string") return fail("Must be text")
    if (raw.length > maxLength) return fail(`At most ${maxLength} characters`)
    const problem = options.check?.(raw)
    return problem === undefined ? ok(raw) : fail(problem)
  }
  return {
    type: "text",
    secret: false,
    env: options.env,
    defaultValue: options.default ?? "",
    describe: (key) => ({
      type: "text",
      ...commonFields(key, options),
      default: options.default ?? "",
      maxLength,
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      ...(options.multiline !== undefined ? { multiline: options.multiline } : {})
    }),
    decode,
    fromEnv: decode
  }
}

/** A secret (API key, token): never sent to the browser, stored apart from other settings. `undefined` = not set. */
const secret = (options: Omit<SettingCommon, "advanced"> & {
  /** The module cannot work without it: a missing secret is a settings error and the module does not start. */
  readonly required?: boolean
}): Setting<string | undefined> & { readonly required: boolean } => {
  const decode = (raw: unknown): Decoded<string | undefined> =>
    typeof raw !== "string" || raw.length === 0
      ? fail("Must be non-empty text")
      : raw.length > 4096
      ? fail("Too long")
      : ok(raw)
  return {
    type: "secret",
    secret: true,
    required: options.required ?? false,
    env: options.env,
    defaultValue: undefined,
    describe: (key) => ({ type: "secret", ...commonFields(key, options), ...(options.env !== undefined ? { env: options.env } : {}) }),
    decode,
    fromEnv: decode
  }
}

const number = (options: SettingCommon & {
  readonly default: number
  readonly integer?: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
}): Setting<number> => {
  const integer = options.integer ?? false
  const decode = (raw: unknown): Decoded<number> => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fail("Must be a number")
    if (integer && !Number.isInteger(raw)) return fail("Must be a whole number")
    if (options.min !== undefined && raw < options.min) return fail(`At least ${options.min}`)
    if (options.max !== undefined && raw > options.max) return fail(`At most ${options.max}`)
    return ok(raw)
  }
  return {
    type: "number",
    secret: false,
    env: options.env,
    defaultValue: options.default,
    describe: (key) => ({
      type: "number",
      ...commonFields(key, options),
      default: options.default,
      integer,
      ...(options.min !== undefined ? { min: options.min } : {}),
      ...(options.max !== undefined ? { max: options.max } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}),
      ...(options.unit !== undefined ? { unit: options.unit } : {})
    }),
    decode,
    fromEnv: (text) => (text.trim() === "" ? fail("Must be a number") : decode(Number(text)))
  }
}

const boolean = (options: SettingCommon & { readonly default: boolean }): Setting<boolean> => {
  const decode = (raw: unknown): Decoded<boolean> => (typeof raw === "boolean" ? ok(raw) : fail("Must be on or off"))
  return {
    type: "boolean",
    secret: false,
    env: options.env,
    defaultValue: options.default,
    describe: (key) => ({ type: "boolean", ...commonFields(key, options), default: options.default }),
    decode,
    fromEnv: (text) => {
      const t = text.trim().toLowerCase()
      return ["true", "1", "yes", "on"].includes(t) ? ok(true) : ["false", "0", "no", "off"].includes(t) ? ok(false) : fail("Must be true or false")
    }
  }
}

interface Choice<V extends string> extends ChoiceOption {
  readonly value: V
}

const choice = <const V extends string>(options: SettingCommon & {
  readonly options: ReadonlyArray<Choice<V>>
  readonly default: NoInfer<V>
}): Setting<V> => {
  const values = new Set<string>(options.options.map((o) => o.value))
  const decode = (raw: unknown): Decoded<V> =>
    typeof raw === "string" && values.has(raw)
      ? ok(raw as V)
      : fail(`Must be one of: ${options.options.map((o) => o.value).join(", ")}`)
  return {
    type: "choice",
    secret: false,
    env: options.env,
    defaultValue: options.default,
    describe: (key) => ({ type: "choice", ...commonFields(key, options), default: options.default, options: options.options }),
    decode,
    fromEnv: (text) => decode(text.trim())
  }
}

const multichoice = <const V extends string>(options: SettingCommon & {
  readonly options: ReadonlyArray<Choice<V>>
  readonly default: ReadonlyArray<NoInfer<V>>
}): Setting<ReadonlyArray<V>> => {
  const values = new Set<string>(options.options.map((o) => o.value))
  const decode = (raw: unknown): Decoded<ReadonlyArray<V>> => {
    if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === "string")) return fail("Must be a list of choices")
    const unknown = raw.filter((v) => !values.has(v))
    if (unknown.length > 0) return fail(`Unknown choice: ${unknown.join(", ")}`)
    // Keep declaration order and drop duplicates, so equal selections compare equal.
    return ok(options.options.map((o) => o.value).filter((v) => raw.includes(v)))
  }
  return {
    type: "multichoice",
    secret: false,
    env: options.env,
    defaultValue: options.default,
    describe: (key) => ({ type: "multichoice", ...commonFields(key, options), default: options.default, options: options.options }),
    decode,
    fromEnv: (text) => decode(text.split(/[\s,]+/).filter((s) => s.length > 0))
  }
}

/** Constructors for settings fields. */
export const Setting = { text, secret, number, boolean, choice, multichoice }

/** Where setting values come from. All three are plain records so they are easy to fake in tests. */
export interface SettingsSources {
  /** Saved values (the module's or section's entry in the settings file). */
  readonly stored: Readonly<Record<string, unknown>>
  /** Saved secrets (the secrets file). */
  readonly secrets: Readonly<Record<string, string>>
  /** The process environment (including `.env`). */
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface ResolvedSettings<A> {
  /** The settings the module receives; `undefined` when any field has an error. */
  readonly value: A | undefined
  /** What the UI shows: fields, effective values, secret states and errors. */
  readonly form: SettingsForm
}

const envValue = (setting: Setting<unknown>, env: SettingsSources["env"]): string | undefined => {
  if (setting.env === undefined) return undefined
  const text = env[setting.env]
  return text === undefined || text.length === 0 ? undefined : text
}

/** Combine environment, saved values and defaults into settings plus the UI form. Pure. */
export const resolveSettings = <S extends SettingsSpec>(spec: S, sources: SettingsSources): ResolvedSettings<SettingsOf<S>> => {
  const fields: Array<SettingField> = []
  const values: Record<string, SettingValue> = {}
  const secrets: Record<string, SecretState> = {}
  const errors: Array<FieldError> = []
  const result: Record<string, unknown> = {}

  for (const [key, setting] of Object.entries(spec)) {
    const fromEnv = envValue(setting, sources.env)
    const described = setting.describe(key)
    fields.push(fromEnv === undefined ? described : { ...described, locked: { reason: `Set by ${setting.env} in the environment` } })

    if (setting.secret) {
      const stored = sources.secrets[key]
      const value = fromEnv ?? (stored !== undefined && stored.length > 0 ? stored : undefined)
      secrets[key] = { set: value !== undefined, source: fromEnv !== undefined ? "env" : value !== undefined ? "store" : "none" }
      if (value === undefined && (setting as { readonly required?: boolean }).required === true) {
        errors.push({ key, message: setting.env === undefined ? "Not set" : `Not set (enter it here or set ${setting.env})` })
      }
      result[key] = value
      continue
    }

    let decoded: Decoded<unknown>
    if (fromEnv !== undefined) {
      decoded = setting.fromEnv(fromEnv)
      if (!decoded.ok) decoded = fail(`${setting.env}=${fromEnv} is not valid: ${decoded.error}`)
    } else if (Object.hasOwn(sources.stored, key)) {
      decoded = setting.decode(sources.stored[key])
      if (!decoded.ok) decoded = fail(`The saved value is not valid (${decoded.error}); save a new one`)
    } else {
      decoded = ok(setting.defaultValue)
    }
    if (decoded.ok) {
      values[key] = decoded.value as SettingValue
      result[key] = decoded.value
    } else {
      values[key] = setting.defaultValue as SettingValue
      errors.push({ key, message: decoded.error })
    }
  }

  return {
    value: errors.length === 0 ? (result as SettingsOf<S>) : undefined,
    form: { fields, values, secrets, errors }
  }
}

export type PatchResult =
  | {
    readonly ok: true
    /** The new saved values (only fields that were ever set; `null` in the patch removed a key). */
    readonly stored: Readonly<Record<string, SettingValue>>
    /** The new saved secrets. */
    readonly secrets: Readonly<Record<string, string>>
  }
  | { readonly ok: false; readonly errors: ReadonlyArray<FieldError> }

/**
 * Apply a patch from the UI to the saved values. Validates every field; a
 * field set by the environment cannot be changed. All or nothing. Pure: the
 * caller persists the result and restarts the module with it.
 */
export const applySettingsPatch = (spec: SettingsSpec, sources: SettingsSources, patch: SettingsPatch): PatchResult => {
  const stored: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(sources.stored)) {
    if (Object.hasOwn(spec, key)) stored[key] = value as SettingValue
  }
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(sources.secrets)) {
    if (Object.hasOwn(spec, key)) secrets[key] = value
  }
  const errors: Array<FieldError> = []

  const check = (key: string, wantSecret: boolean): Setting<unknown> | undefined => {
    const setting = Object.hasOwn(spec, key) ? spec[key] : undefined
    if (setting === undefined) {
      errors.push({ key: null, message: `Unknown setting "${key}"` })
      return undefined
    }
    if (setting.secret !== wantSecret) {
      errors.push({ key, message: wantSecret ? "Not a secret" : "Secrets go in the secrets part of the patch" })
      return undefined
    }
    if (envValue(setting, sources.env) !== undefined) {
      errors.push({ key, message: `Set by ${setting.env} in the environment; change it there` })
      return undefined
    }
    return setting
  }

  for (const [key, raw] of Object.entries(patch.values)) {
    const setting = check(key, false)
    if (setting === undefined) continue
    if (raw === null) {
      delete stored[key]
      continue
    }
    const decoded = setting.decode(raw)
    if (decoded.ok) stored[key] = decoded.value as SettingValue
    else errors.push({ key, message: decoded.error })
  }
  for (const [key, raw] of Object.entries(patch.secrets)) {
    const setting = check(key, true)
    if (setting === undefined) continue
    if (raw === null) {
      delete secrets[key]
      continue
    }
    const decoded = setting.decode(raw)
    if (decoded.ok && decoded.value !== undefined) secrets[key] = decoded.value as string
    else errors.push({ key, message: decoded.ok ? "Must be non-empty text" : decoded.error })
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, stored, secrets }
}
