import {
  type ApplyMode,
  type ChoiceOption,
  type Condition,
  evaluateCondition,
  type FieldError,
  type FieldSource,
  SecretState,
  SettingField,
  SettingsForm,
  SettingsPatch,
  SettingValue
} from "@pva/protocol"
import { SettingExtra } from "./SettingsExtra.ts"

/**
 * Typed settings for modules and assistant settings sections.
 *
 * A module declares its settings as a record of `Setting`s built with the
 * constructors below. From that one declaration come the TypeScript type of the
 * settings (`SettingsOf<typeof spec>`), validation of stored and submitted
 * values, environment-variable overrides, and the field descriptions the web UI
 * renders as a form (`SettingField` in `@pva/protocol`). The set of field types
 * is closed: each has exactly one widget in the UI. Since protocol 10 it includes the extended types of
 * `SettingsExtra.ts` (`textList`, `records`, `combo`, `action`, `info`); `action` and `info` have no value the
 * owner sets (`Setting.value`).
 *
 * Precedence for every field: environment variable (when the field names one
 * and it is set to a non-empty value; the field is then locked in the UI) >
 * saved value > default. For secrets: environment variable > saved secret > not set.
 *
 * A field with `visibleWhen` is shown only while its condition holds (keys may
 * name fields of other sections, through `SettingsSources.context`). A hidden
 * field is never validated: its saved value stays, problems with it are not
 * reported, a patch that names it is ignored for it, and the module or
 * provider gets its value if valid, else its default.
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
  /** Shown (and validated) only while this holds. */
  readonly visibleWhen?: Condition
  /**
   * Module fields: an assistant may have its own value (docs/ASSISTANTS.md §2.6), which wins over the shared one for
   * that assistant. Never for secrets (not offered) or addresses (do not set it).
   */
  readonly overridable?: boolean
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
  /** When the field is shown (and validated); absent = always. */
  readonly visibleWhen?: Condition
  /** An assistant may have its own value (`ModuleChoice.own`); never a secret. */
  readonly overridable: boolean
  /**
   * Absent or `editable`: an ordinary value. `none`: an `action` (no value at all: never in `values`, never saved or
   * patched). `readOnly`: an `info` value only the server sets ("" in the resolved form, never saved or patched).
   */
  readonly value?: "editable" | "none" | "readOnly"
}

/** Does the owner set this field's value (saved, patched, from the environment)? */
export const isEditableSetting = (setting: Setting<unknown>): boolean => setting.value === undefined || setting.value === "editable"

export type SettingsSpec = { readonly [key: string]: Setting<any> }
/** The settings a module receives: every field with a value (an `action` or `info` field has none the module reads). */
export type SettingsOf<S extends SettingsSpec> = {
  readonly [K in keyof S as S[K] extends { readonly value: "none" | "readOnly" } ? never : K]: S[K] extends Setting<infer A> ? A : never
}

const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
const fail = (error: string): Decoded<never> => ({ ok: false, error })

const commonFields = (key: string, options: SettingCommon) => ({
  key,
  label: options.label,
  apply: options.apply ?? "live",
  ...(options.description !== undefined ? { description: options.description } : {}),
  ...(options.advanced !== undefined ? { advanced: options.advanced } : {}),
  ...(options.visibleWhen !== undefined ? { visibleWhen: options.visibleWhen } : {}),
  ...(options.overridable === true ? { overridable: true } : {})
})

/** The `visibleWhen` of a constructor's options, for the `Setting` itself. */
const visibility = (options: SettingCommon) => ({
  ...(options.visibleWhen !== undefined ? { visibleWhen: options.visibleWhen } : {}),
  overridable: options.overridable === true
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
    ...visibility(options),
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
const secret = (options: Omit<SettingCommon, "advanced" | "overridable"> & {
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
    ...visibility(options),
    overridable: false,
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
    ...visibility(options),
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
    ...visibility(options),
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
    ...visibility(options),
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
    ...visibility(options),
    env: options.env,
    defaultValue: options.default,
    describe: (key) => ({ type: "multichoice", ...commonFields(key, options), default: options.default, options: options.options }),
    decode,
    fromEnv: (text) => decode(text.split(/[\s,]+/).filter((s) => s.length > 0))
  }
}

/** Constructors for settings fields (the five extended ones from `SettingsExtra.ts`). */
export const Setting = { text, secret, number, boolean, choice, multichoice, ...SettingExtra }

/** Where setting values come from. Plain records and functions, so they are easy to fake in tests. */
export interface SettingsSources {
  /** Saved values (the module's or section's entry in the settings file). */
  readonly stored: Readonly<Record<string, unknown>>
  /** Saved secrets (the secrets file). */
  readonly secrets: Readonly<Record<string, string>>
  /** The process environment (including `.env`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Where an environment variable came from (`.env` file or the process). Default: `env-process`. */
  readonly envOrigin?: (name: string) => "env-file" | "env-process"
  /** The `.env` file and line of a variable from a file (shown on the locked field, docs/SETTINGS-UI.md §4.4). */
  readonly envLocation?: (name: string) => { readonly file: string; readonly line: number } | undefined
  /** Effective values of fields outside this spec (other sections), for `visibleWhen`. */
  readonly context?: (key: string) => unknown
  /**
   * Defaults computed elsewhere (a module's linked defaults from Home, docs/ASSISTANTS.md §2.6): used instead of a
   * field's own default when nothing is saved and the environment does not set it. A value the field refuses is
   * ignored.
   */
  readonly defaults?: Readonly<Record<string, unknown>>
  /**
   * An assistant's own values (`ModuleChoice.own`): for `overridable` fields only (others are ignored), they win over
   * the environment, the saved value and the default. The form then shows the assistant's effective values.
   */
  readonly own?: Readonly<Record<string, unknown>>
  /**
   * How a field's decoder (module code: its checks, a record's item decoders) is called: the module host passes its
   * containment (`moduleCode`), so one that throws is that field's error (`fallback`'s message) and not the caller's
   * exception. Absent: called as it is.
   */
  readonly contain?: Contain
}

/** Run module-supplied settings code: `f`'s result, or `fallback` with a message if it throws (`SettingsSources.contain`). */
export type Contain = <A>(f: () => A, fallback: (message: string) => A) => A

/** A field's decoder or environment reader called through `contain` (when given): a throw is a field error. */
const contained = (contain: Contain | undefined, f: () => Decoded<unknown>): Decoded<unknown> =>
  contain === undefined ? f() : contain(f, (message) => fail(message))

/** The default of a field: the linked default when there is a valid one, else its own. */
const defaultOf = (setting: Setting<unknown>, key: string, sources: Pick<SettingsSources, "defaults" | "contain">): unknown => {
  if (sources.defaults === undefined || !Object.hasOwn(sources.defaults, key) || setting.secret) return setting.defaultValue
  const defaults = sources.defaults
  const decoded = contained(sources.contain, () => setting.decode(defaults[key]))
  return decoded.ok ? decoded.value : setting.defaultValue
}

/** Does `own` hold a value for this field that counts (an overridable, non-secret field)? */
const ownApplies = (setting: Setting<unknown>, key: string, own: SettingsSources["own"]): own is Readonly<Record<string, unknown>> =>
  own !== undefined && Object.hasOwn(own, key) && setting.overridable && !setting.secret

/** The keys of the fields an assistant may have its own value for, in declaration order. */
export const overridableKeys = (spec: SettingsSpec): ReadonlyArray<string> =>
  Object.entries(spec).flatMap(([key, setting]) => (setting.overridable && !setting.secret ? [key] : []))

/** Only the values of `own` that count (overridable, non-secret fields of `spec`). */
export const applicableOwnValues = (spec: SettingsSpec, own: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(own ?? {})) {
    const setting = Object.hasOwn(spec, key) ? spec[key] : undefined
    if (setting !== undefined && ownApplies(setting, key, own)) out[key] = value
  }
  return out
}

/**
 * Check an assistant's own values for a module (docs/ASSISTANTS.md §2.2): every key must be an `overridable` field
 * (never a secret), and every value one the field accepts. One error per bad key.
 */
export const checkOwnValues = (spec: SettingsSpec, own: Readonly<Record<string, unknown>>, contain?: Contain): ReadonlyArray<FieldError> => {
  const errors: Array<FieldError> = []
  for (const [key, value] of Object.entries(own)) {
    const setting = Object.hasOwn(spec, key) ? spec[key] : undefined
    if (setting === undefined) errors.push({ key, message: `There is no setting "${key}"` })
    else if (setting.secret) errors.push({ key, message: "A secret is shared: it cannot be set per assistant" })
    else if (!setting.overridable) errors.push({ key, message: "This setting is shared: it cannot be set per assistant" })
    else {
      const decoded = contained(contain, () => setting.decode(value))
      if (!decoded.ok) errors.push({ key, message: decoded.error })
    }
  }
  return errors
}

/** Is the field shown, given the effective values of its own form (`values`) and of the others (`context`)? */
export const isVisible = (
  setting: { readonly visibleWhen?: Condition | undefined },
  values: Readonly<Record<string, unknown>>,
  context: ((key: string) => unknown) | undefined
): boolean =>
  setting.visibleWhen === undefined ||
  evaluateCondition(setting.visibleWhen, (key) => (Object.hasOwn(values, key) ? values[key] : context?.(key)))

export interface ResolvedSettings<A> {
  /** The settings the module receives; `undefined` when any field has an error. */
  readonly value: A | undefined
  /** What the UI shows: fields, effective values, secret states and errors. */
  readonly form: SettingsForm
}

const envValue = (setting: Setting<unknown>, env: SettingsSources["env"]): string | undefined => {
  if (setting.env === undefined || !isEditableSetting(setting)) return undefined
  const text = env[setting.env]
  return text === undefined || text.length === 0 ? undefined : text
}

/** Combine environment, saved values and defaults into settings plus the UI form. Pure. */
export const resolveSettings = <S extends SettingsSpec>(spec: S, sources: SettingsSources): ResolvedSettings<SettingsOf<S>> => {
  const fields: Array<SettingField> = []
  const values: Record<string, SettingValue> = {}
  const secrets: Record<string, SecretState> = {}
  const problems: Array<FieldError> = []
  const result: Record<string, unknown> = {}
  const origin = (name: string): FieldSource => sources.envOrigin?.(name) ?? "env-process"
  const lock = (name: string, source: FieldSource) => {
    const at = source === "env-file" ? sources.envLocation?.(name) : undefined
    return at === undefined ? { reason: lockReason(name, source) } : { reason: lockReason(name, source, at), file: at.file, line: at.line }
  }

  for (const [key, setting] of Object.entries(spec)) {
    if (!isEditableSetting(setting)) {
      // An action has no value; an info value is the server's ("" here: the module host fills it from the instance).
      fields.push({ ...setting.describe(key), source: "default" })
      if (setting.value === "readOnly") values[key] = ""
      continue
    }
    const fromEnv = envValue(setting, sources.env)
    const fieldDefault = defaultOf(setting, key, sources)
    const described = fieldDefault === setting.defaultValue || setting.secret
      ? setting.describe(key)
      : ({ ...setting.describe(key), default: fieldDefault } as SettingField)

    if (setting.secret) {
      const stored = sources.secrets[key]
      const value = fromEnv ?? (stored !== undefined && stored.length > 0 ? stored : undefined)
      secrets[key] = { set: value !== undefined, source: fromEnv !== undefined ? "env" : value !== undefined ? "store" : "none" }
      const source: FieldSource = fromEnv !== undefined ? origin(setting.env!) : value !== undefined ? "saved" : "default"
      fields.push(fromEnv === undefined ? { ...described, source } : { ...described, source, locked: lock(setting.env!, source) })
      if (value === undefined && (setting as { readonly required?: boolean }).required === true) {
        problems.push({ key, message: setting.env === undefined ? "Not set" : `Not set (enter it here or set ${setting.env})` })
      }
      result[key] = value
      continue
    }

    let decoded: Decoded<unknown>
    let source: FieldSource
    if (ownApplies(setting, key, sources.own)) {
      source = "saved"
      const own = sources.own
      decoded = contained(sources.contain, () => setting.decode(own[key]))
      if (!decoded.ok) decoded = fail(`The assistant's own value is not valid (${decoded.error})`)
    } else if (fromEnv !== undefined) {
      source = origin(setting.env!)
      decoded = contained(sources.contain, () => setting.fromEnv(fromEnv))
      // The environment's value is never quoted (whatever the field is): the variable's name says where to look.
      if (!decoded.ok) decoded = fail(`${setting.env} in the environment is not valid: ${decoded.error}`)
    } else if (Object.hasOwn(sources.stored, key)) {
      source = "saved"
      decoded = contained(sources.contain, () => setting.decode(sources.stored[key]))
      if (!decoded.ok) decoded = fail(`The saved value is not valid (${decoded.error}); save a new one`)
    } else {
      source = "default"
      decoded = ok(fieldDefault)
    }
    fields.push(fromEnv === undefined ? { ...described, source } : { ...described, source, locked: lock(setting.env!, source) })
    if (decoded.ok) {
      values[key] = decoded.value as SettingValue
      result[key] = decoded.value
    } else {
      values[key] = fieldDefault as SettingValue
      result[key] = fieldDefault
      problems.push({ key, message: decoded.error })
    }
  }

  // Hidden fields are not validated: their problems are not reported (their value is the default when invalid).
  const errors = problems.filter((e) => e.key === null || isVisible(spec[e.key]!, values, sources.context))
  return {
    value: errors.length === 0 ? (result as SettingsOf<S>) : undefined,
    form: { fields, values, secrets, errors }
  }
}

const lockReason = (env: string, source: FieldSource, at?: { readonly file: string; readonly line: number }) =>
  source !== "env-file" ? `Set by ${env} in the environment` : at === undefined ? `Set by ${env} in .env` : `Set by ${env} in ${at.file}, line ${at.line}`

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
export const applySettingsPatch = (
  spec: SettingsSpec,
  sources: SettingsSources,
  patch: SettingsPatch,
  /** `includeHidden`: save fields whose `visibleWhen` does not hold too ("Move to settings" keeps every value). */
  options: { readonly includeHidden?: boolean } = {}
): PatchResult => {
  const stored: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(sources.stored)) {
    if (Object.hasOwn(spec, key) && isEditableSetting(spec[key]!)) stored[key] = value as SettingValue
  }
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(sources.secrets)) {
    if (Object.hasOwn(spec, key)) secrets[key] = value
  }
  const errors: Array<FieldError> = []

  // Visibility is judged on the values after the patch (a patch that chooses Deepgram shows its fields).
  const after: Record<string, unknown> = {}
  for (const [key, setting] of Object.entries(spec)) {
    if (setting.secret || !isEditableSetting(setting)) continue
    const fromEnv = envValue(setting, sources.env)
    const raw = fromEnv !== undefined
      ? contained(sources.contain, () => setting.fromEnv(fromEnv))
      : Object.hasOwn(patch.values, key) && patch.values[key] !== null
      ? contained(sources.contain, () => setting.decode(patch.values[key]))
      : Object.hasOwn(patch.values, key) || !Object.hasOwn(sources.stored, key)
      ? ok(defaultOf(setting, key, sources))
      : contained(sources.contain, () => setting.decode(sources.stored[key]))
    after[key] = raw.ok ? raw.value : defaultOf(setting, key, sources)
  }
  const hidden = (key: string) => {
    if (options.includeHidden === true) return false
    const setting = Object.hasOwn(spec, key) ? spec[key] : undefined
    return setting !== undefined && !isVisible(setting, after, sources.context)
  }

  const check = (key: string, wantSecret: boolean): Setting<unknown> | undefined => {
    const setting = Object.hasOwn(spec, key) ? spec[key] : undefined
    if (setting === undefined) {
      errors.push({ key: null, message: `Unknown setting "${key}"` })
      return undefined
    }
    if (!isEditableSetting(setting)) {
      errors.push({ key, message: setting.value === "none" ? "An action has no value" : "Read-only: the server sets it" })
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
    if (hidden(key)) continue // not validated, not changed: its saved value stays
    const setting = check(key, false)
    if (setting === undefined) continue
    if (raw === null) {
      delete stored[key]
      continue
    }
    const decoded = contained(sources.contain, () => setting.decode(raw))
    if (decoded.ok) stored[key] = decoded.value as SettingValue
    else errors.push({ key, message: decoded.error })
  }
  for (const [key, raw] of Object.entries(patch.secrets)) {
    if (hidden(key)) continue
    const setting = check(key, true)
    if (setting === undefined) continue
    if (raw === null) {
      delete secrets[key]
      continue
    }
    const decoded = contained(sources.contain, () => setting.decode(raw))
    if (decoded.ok && decoded.value !== undefined) secrets[key] = decoded.value as string
    else errors.push({ key, message: decoded.ok ? "Must be non-empty text" : decoded.error })
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, stored, secrets }
}

/**
 * Cross-field checks of a settings section (docs/SETTINGS-UI.md §3.3): run on
 * save against the values the save would produce (of every section: keys are
 * global). An `error` refuses the save, under the named field; a `warning`
 * refuses it only until the owner confirms ("Save anyway"), and is shown on
 * the form while the saved values still have it.
 */
export interface SettingsCheckView {
  /** The effective value of any non-secret field (environment > saved > default). */
  readonly value: (key: string) => unknown
  /** Whether a secret is set (environment or saved). */
  readonly secretSet: (key: string) => boolean
}

export interface SettingsProblem extends FieldError {
  readonly level: "error" | "warning"
}

export type SettingsCheck = (view: SettingsCheckView) => ReadonlyArray<SettingsProblem>

/** Run checks; their results split into errors and warnings. A check that throws is skipped. */
export const runSettingsChecks = (
  checks: ReadonlyArray<SettingsCheck>,
  view: SettingsCheckView
): { readonly errors: ReadonlyArray<FieldError>; readonly warnings: ReadonlyArray<FieldError> } => {
  const errors: Array<FieldError> = []
  const warnings: Array<FieldError> = []
  for (const check of checks) {
    let problems: ReadonlyArray<SettingsProblem>
    try {
      problems = check(view)
    } catch {
      continue
    }
    for (const p of problems) (p.level === "error" ? errors : warnings).push({ key: p.key, message: p.message })
  }
  return { errors, warnings }
}
