import {
  type ChoiceOption,
  INFO_STEP_LINK_HREF,
  type InfoStep,
  MAX_INFO_STEP_COPY,
  MAX_INFO_STEPS,
  type Condition,
  MAX_COMBO_OPTIONS,
  MAX_FIELD_DESCRIPTION,
  MAX_FIELD_LABEL,
  MAX_LIST_JSON,
  MAX_OPTIONS_JSON,
  MAX_RECORD_FIELDS,
  MAX_RECORD_TEXT,
  MAX_RECORDS,
  MAX_TEXT_LIST_ITEM,
  MAX_TEXT_LIST_ITEMS,
  type RecordItemField,
  type SettingField
} from "@pva/protocol"
import type { Decoded, Setting } from "./Settings.ts"

/**
 * The five extended settings field types (docs/AGENTS-AND-INTENTS.md §4.3, docs/MODULES-PLAN.md §4 P3):
 * `textList`, `records`, `combo`, `action`, `info`. Since protocol 10 they are ordinary `Setting`s, joined into
 * `Setting` (`Setting.records`, …), described on the wire as `SettingField`s, stored, loaded and resolved like the
 * other six:
 *
 * - `textList`, `records`, `combo` have values: saved, read from the environment (`records` as JSON, `textList`
 *   comma-separated), validated, and `overridable` when the module says so.
 * - `action` has no value (`value: "none"`): never in `values`, never patchable; its handler is a `fieldActions`
 *   entry of the module definition or of its running instance.
 * - `info` has a value only the server sets (`value: "readOnly"`): "" in the resolved form, filled by the module
 *   host from the running instance's `info()`; never patchable, never saved.
 *
 * `records` stay flat: an item is a set of non-secret simple fields (`text`, `number`, `boolean`, `choice`,
 * `multichoice`, `textList`). Nested configuration is JSON in a validated text field (docs/MODULES-PLAN.md §3.3).
 */

interface Common {
  readonly label: string
  readonly description?: string
  readonly advanced?: boolean
  readonly apply?: "live" | "reload"
  readonly env?: string
  readonly visibleWhen?: Condition
  /** An assistant may have its own value (`ModuleChoice.own`). Valued fields only. */
  readonly overridable?: boolean
}

/** Kept for compatibility: the extended constructors now return plain `Setting`s. */
export type ExtendedSetting<A> = Setting<A>

const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
const fail = (error: string): Decoded<never> => ({ ok: false, error })

/**
 * A declaration outside the wire's bounds (docs/SETTINGS-UI.md §3.2) is refused when the module is defined, not
 * when its form is sent: one module's long label must never break the admin snapshot.
 */
const declare = (what: string, ok: boolean, rule: string) => {
  if (!ok) throw new Error(`${what}: ${rule}`)
}
const limit = (what: string, n: number | undefined, max: number) =>
  declare(what, n === undefined || (Number.isInteger(n) && n >= 1 && n <= max), `must be a whole number from 1 to ${max}`)
const textBound = (what: string, text: string | undefined, max: number) => declare(what, text === undefined || text.length <= max, `at most ${max} characters`)
const declareCommon = (o: { readonly label: string; readonly description?: string | undefined }) => {
  textBound(`Field "${o.label.slice(0, 40)}" label`, o.label, MAX_FIELD_LABEL)
  textBound(`Field "${o.label.slice(0, 40)}" description`, o.description, MAX_FIELD_DESCRIPTION)
}
const declareOptions = (what: string, options: ReadonlyArray<ChoiceOption> | undefined) => {
  if (options === undefined) return
  declare(what, options.length <= MAX_COMBO_OPTIONS, `at most ${MAX_COMBO_OPTIONS} options`)
  for (const option of options) {
    declare(what, option.value.length >= 1 && option.value.length <= 200, "an option value has 1 to 200 characters")
    declare(what, option.tags === undefined || option.tags.length <= 6, "an option has at most 6 tags")
    textBound(`${what} option label`, option.label, MAX_FIELD_LABEL)
    textBound(`${what} option description`, option.description, 500)
    textBound(`${what} option implication`, option.implication, 500)
  }
  declare(what, JSON.stringify(options).length <= MAX_OPTIONS_JSON, `the options must be at most ${MAX_OPTIONS_JSON} characters as JSON`)
}
const tooLarge = (value: unknown) => JSON.stringify(value).length > MAX_LIST_JSON
/**
 * A field's default goes through its own decoder: a default the field refuses is a declaration error, and the decoded
 * value (trimmed, without duplicates) is the one kept, in `defaultValue` and in the described field alike.
 */
const declaredDefault = <A>(what: string, decoded: Decoded<A>): A => {
  if (!decoded.ok) throw new Error(`${what}: must be a value the field accepts (${decoded.error})`)
  return decoded.value
}

const commonFields = (key: string, o: Common) => ({
  key,
  label: o.label,
  apply: o.apply ?? "live",
  ...(o.description !== undefined ? { description: o.description } : {}),
  ...(o.advanced !== undefined ? { advanced: o.advanced } : {}),
  ...(o.visibleWhen !== undefined ? { visibleWhen: o.visibleWhen } : {}),
  ...(o.overridable === true ? { overridable: true } : {})
})

const visibility = (o: Common) => ({
  ...(o.visibleWhen !== undefined ? { visibleWhen: o.visibleWhen } : {}),
  overridable: o.overridable === true
})

/** Line breaks, control characters and bidirectional overrides: never in a one-line value. */
export const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u

/**
 * A list of short strings: aliases, greeting words. Trimmed, empty items dropped, duplicates (ignoring case) dropped;
 * an item with a line break or a control character is refused.
 */
const textList = (o: Common & {
  readonly default?: ReadonlyArray<string>
  readonly maxItems?: number
  readonly itemMaxLength?: number
  readonly placeholder?: string
}): Setting<ReadonlyArray<string>> => {
  declareCommon(o)
  limit("A text list's maxItems", o.maxItems, MAX_TEXT_LIST_ITEMS)
  limit("A text list's itemMaxLength", o.itemMaxLength, MAX_TEXT_LIST_ITEM)
  textBound("A text list's placeholder", o.placeholder, MAX_FIELD_LABEL)
  const maxItems = o.maxItems ?? 50
  const itemMaxLength = o.itemMaxLength ?? 60
  const decode = (raw: unknown): Decoded<ReadonlyArray<string>> => {
    if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === "string")) return fail("Must be a list of text")
    // Bounded before anything is looked at (the wire's limits, whatever the field declares).
    if (raw.length > MAX_TEXT_LIST_ITEMS * 4) return fail(`At most ${maxItems} items`)
    const seen = new Set<string>()
    const items: Array<string> = []
    for (const [n, item] of raw.map((s) => s.trim()).filter((s) => s.length > 0).entries()) {
      // The rejected item is never quoted (it may be anything, a key pasted in the wrong field included).
      if (item.length > itemMaxLength) return fail(`Item ${n + 1} is longer than ${itemMaxLength} characters`)
      // Items are short words that may reach a prompt: one line each.
      if (NOT_ONE_LINE.test(item)) return fail(`Item ${n + 1} holds a line break or a control character`)
      if (seen.has(item.toLowerCase())) continue
      seen.add(item.toLowerCase())
      items.push(item)
    }
    if (items.length > maxItems) return fail(`At most ${maxItems} items`)
    return tooLarge(items) ? fail(`The list is too long (at most ${MAX_LIST_JSON} characters in all)`) : ok(items)
  }
  const defaultValue = declaredDefault("A text list's default", decode(o.default ?? []))
  return {
    type: "textList",
    secret: false,
    ...visibility(o),
    env: o.env,
    value: "editable",
    defaultValue,
    describe: (key) => ({
      type: "textList",
      ...commonFields(key, o),
      default: defaultValue,
      maxItems,
      itemMaxLength,
      ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {})
    }),
    decode,
    fromEnv: (text) => decode(text.split(","))
  }
}

/** A field allowed inside a record: the non-secret v1 constructors, or `textList`. */
export type ItemSetting = Setting<any>
export type ItemSpec = { readonly [key: string]: ItemSetting }
export type ItemOf<I extends ItemSpec> = { readonly [K in keyof I]: I[K] extends Setting<infer A> ? A : never }

const ITEM_TYPES: ReadonlyArray<string> = ["text", "number", "boolean", "choice", "multichoice", "textList"]

const itemField = (key: string, setting: ItemSetting, hidden: boolean): RecordItemField => {
  const d = setting.describe(key) as Record<string, unknown> & { readonly type: string }
  const { apply: _a, advanced: _adv, locked: _l, visibleWhen: _v, overridable: _o, source: _s, ...rest } = d
  return (hidden ? { ...rest, hidden: true } : rest) as RecordItemField
}

/**
 * An ordered list of records with the same flat fields (rooms with aliases, lamps). A missing item key is the item
 * field's default, decoded and checked exactly like a given value (a field whose check refuses its default refuses the
 * omission); unknown keys are dropped. From the environment: JSON (`DEMO_ROOMS='[{"name":"Kitchen"}]'`).
 */
const records = <const I extends ItemSpec>(o: Common & {
  readonly item: I
  readonly default?: ReadonlyArray<ItemOf<I>>
  /** Singular noun for buttons ("room"). */
  readonly itemLabel: string
  /** Item key whose value titles a collapsed row. */
  readonly titleKey: keyof I & string
  readonly maxItems?: number
  readonly orderable?: boolean
  /** Extra validation of the whole list (unique names); return a message for an invalid value. */
  readonly check?: (value: ReadonlyArray<ItemOf<I>>) => string | undefined
  /** Item keys kept in every record but not drawn (protocol 11: an id the server makes). */
  readonly hiddenKeys?: ReadonlyArray<keyof I & string>
}): Setting<ReadonlyArray<ItemOf<I>>> => {
  for (const [key, s] of Object.entries(o.item)) {
    if (s.secret || !ITEM_TYPES.includes(s.type)) throw new Error(`Record field "${key}" cannot be of type ${s.type}`)
    const d = s.describe(key) as { readonly label: string; readonly description?: string; readonly maxLength?: number; readonly options?: ReadonlyArray<ChoiceOption> }
    declareCommon(d)
    if (s.type === "text") limit(`Record field "${key}" maxLength`, d.maxLength, MAX_RECORD_TEXT)
    declareOptions(`Record field "${key}"`, d.options)
  }
  if (!Object.hasOwn(o.item, o.titleKey)) throw new Error(`Records title "${o.titleKey}" is not one of its item fields`)
  declareCommon(o)
  declare("A records field", Object.keys(o.item).length <= MAX_RECORD_FIELDS, `at most ${MAX_RECORD_FIELDS} item fields`)
  limit("A records field's maxItems", o.maxItems, MAX_RECORDS)
  textBound("A records field's itemLabel", o.itemLabel, 60)
  const maxItems = o.maxItems ?? 50
  const decode = (raw: unknown): Decoded<ReadonlyArray<ItemOf<I>>> => {
    if (!Array.isArray(raw)) return fail("Must be a list")
    if (raw.length > maxItems) return fail(`At most ${maxItems} ${o.itemLabel}s`)
    const result: Array<ItemOf<I>> = []
    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(`${upper(o.itemLabel)} ${index + 1}: must be an object`)
      const value: Record<string, unknown> = {}
      for (const [key, setting] of Object.entries(o.item)) {
        // An omitted key is the field's default, decoded and checked exactly like a value that was given (a field
        // whose check refuses its own default, a required name, refuses the omission too). A field without a
        // default must be given.
        const given = Object.hasOwn(entry, key)
        if (!given && setting.defaultValue === undefined) return fail(`${upper(o.itemLabel)} ${index + 1}, ${setting.describe(key).label}: Missing`)
        const decoded = setting.decode(given ? (entry as Record<string, unknown>)[key] : setting.defaultValue)
        if (!decoded.ok) return fail(`${upper(o.itemLabel)} ${index + 1}, ${setting.describe(key).label}: ${decoded.error}`)
        value[key] = decoded.value
      }
      result.push(value as ItemOf<I>)
    }
    if (tooLarge(result)) return fail(`The list is too long (at most ${MAX_LIST_JSON} characters in all)`)
    const problem = o.check?.(result)
    return problem === undefined ? ok(result) : fail(problem)
  }
  const defaultValue = declaredDefault("A records field's default", decode(o.default ?? []))
  return {
    type: "records",
    secret: false,
    ...visibility(o),
    env: o.env,
    value: "editable",
    defaultValue,
    describe: (key) => ({
      type: "records",
      ...commonFields(key, o),
      default: defaultValue as never,
      itemFields: Object.entries(o.item).map(([k, s]) => itemField(k, s, o.hiddenKeys?.includes(k) === true)),
      itemLabel: o.itemLabel,
      titleKey: o.titleKey,
      maxItems,
      orderable: o.orderable ?? false
    }),
    decode,
    fromEnv: (text) => {
      try {
        return decode(JSON.parse(text))
      } catch {
        return fail("Must be JSON: a list of objects")
      }
    }
  }
}

const upper = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/**
 * Free text with suggestions: a model name. `options` are the static suggestions; a running instance adds more
 * through `settingOptions` (the host puts them on the described field). With `allowCustom: false` only static
 * options are accepted, on every path a value arrives by (the form, the environment, an assistant's own value, a
 * button's draft), and the host shows only those: a list known only while the module runs needs `allowCustom: true`.
 */
const combo = (o: Common & {
  readonly default: string
  readonly options?: ReadonlyArray<ChoiceOption>
  readonly allowCustom?: boolean
  readonly maxLength?: number
  readonly placeholder?: string
}): Setting<string> => {
  declareCommon(o)
  limit("A combo's maxLength", o.maxLength, MAX_RECORD_TEXT)
  textBound("A combo's placeholder", o.placeholder, MAX_FIELD_LABEL)
  declareOptions("A combo", o.options)
  const allowCustom = o.allowCustom ?? true
  const maxLength = o.maxLength ?? 200
  const known = new Set((o.options ?? []).map((x) => x.value))
  const decode = (raw: unknown): Decoded<string> => {
    if (typeof raw !== "string") return fail("Must be text")
    const value = raw.trim()
    if (value.length === 0) return fail("Must not be empty")
    if (value.length > maxLength) return fail(`At most ${maxLength} characters`)
    if (!allowCustom && !known.has(value)) return fail(`Must be one of: ${[...known].join(", ")}`)
    return ok(value)
  }
  // A closed combo's default must be one of its static options; an open one's must be text it accepts.
  const defaultValue = declaredDefault("A combo's default", decode(o.default))
  return {
    type: "combo",
    secret: false,
    ...visibility(o),
    env: o.env,
    value: "editable",
    defaultValue,
    describe: (key) => ({
      type: "combo",
      ...commonFields(key, o),
      default: defaultValue,
      options: o.options ?? [],
      allowCustom,
      maxLength,
      ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {})
    }),
    decode,
    fromEnv: decode
  }
}

/**
 * A button ("Test", "Refresh the list"). No value. The handler is `fieldActions[key]` of the module definition (runs
 * without a running instance, with the settings) or of the running instance (the generated `test` of an agent too).
 */
const action = (o: Omit<Common, "env" | "apply" | "overridable"> & {
  readonly buttonLabel: string
  readonly confirm?: string
  /**
   * Default true: the handler uses the saved settings, so the button is disabled while the form has unsaved edits.
   * False: the page sends its draft (non-secret values; secrets stay the saved ones) and the handler sees it.
   */
  readonly requiresSaved?: boolean
}): Setting<undefined> & { readonly value: "none" } => {
  declareCommon(o)
  textBound("An action's buttonLabel", o.buttonLabel, 60)
  textBound("An action's confirm text", o.confirm, MAX_FIELD_DESCRIPTION)
  return actionSetting(o)
}

const actionSetting = (o: Omit<Common, "env" | "apply" | "overridable"> & {
  readonly buttonLabel: string
  readonly confirm?: string
  readonly requiresSaved?: boolean
}): Setting<undefined> & { readonly value: "none" } => ({
  type: "action",
  secret: false,
  ...visibility(o),
  overridable: false,
  env: undefined,
  value: "none",
  defaultValue: undefined,
  describe: (key) => ({
    type: "action",
    ...commonFields(key, o),
    buttonLabel: o.buttonLabel,
    requiresSaved: o.requiresSaved ?? true,
    ...(o.confirm !== undefined ? { confirm: o.confirm } : {})
  }),
  decode: () => fail("An action has no value"),
  fromEnv: () => fail("An action has no value")
})

type InfoOptions = Omit<Common, "env" | "apply" | "overridable"> & {
  readonly tone?: "neutral" | "ok" | "warning" | "error"
  /** A numbered guide drawn from the definition (static): text, values to copy (`{origin}` becomes the admin page's own origin), a `https://` link. */
  readonly steps?: ReadonlyArray<InfoStep>
}

/** The bounds the wire has (`InfoField.steps`), checked where the module is defined. */
const declareSteps = (label: string, steps: ReadonlyArray<InfoStep> | undefined) => {
  if (steps === undefined) return
  const what = `Field "${label.slice(0, 40)}" steps`
  declare(what, steps.length >= 1 && steps.length <= MAX_INFO_STEPS, `1 to ${MAX_INFO_STEPS} steps`)
  for (const [n, step] of steps.entries()) {
    const at = `${what}, step ${n + 1}`
    textBound(`${at} text`, step.text, 300)
    declare(at, step.copy === undefined || step.copy.length <= MAX_INFO_STEP_COPY, `at most ${MAX_INFO_STEP_COPY} values to copy`)
    for (const c of step.copy ?? []) {
      textBound(`${at} copy label`, c.label, 40)
      textBound(`${at} copy value`, c.value, 300)
    }
    if (step.link !== undefined) {
      textBound(`${at} link label`, step.link.label, 60)
      declare(at, step.link.href.length <= 300 && INFO_STEP_LINK_HREF.test(step.link.href), "a link is an absolute https:// address of at most 300 characters, without credentials, spaces or control characters")
    }
  }
}

/** Read-only text from the running instance (`info()[key]`); "" while it does not run. */
const info = (o: InfoOptions): Setting<string> & { readonly value: "readOnly" } => {
  declareCommon(o)
  declareSteps(o.label, o.steps)
  return infoSetting(o)
}

const infoSetting = (o: InfoOptions): Setting<string> & { readonly value: "readOnly" } => ({
  type: "info",
  secret: false,
  ...visibility(o),
  overridable: false,
  env: undefined,
  value: "readOnly",
  defaultValue: "",
  describe: (key): SettingField => ({
    type: "info",
    ...commonFields(key, o),
    ...(o.tone !== undefined ? { tone: o.tone } : {}),
    ...(o.steps !== undefined ? { steps: o.steps.map((s) => ({ ...s })) } : {})
  }),
  decode: () => fail("Read-only"),
  fromEnv: () => fail("Read-only")
})

/** The extended constructors (also members of `Setting`). */
export const SettingExtra = { textList, records, combo, action, info }
