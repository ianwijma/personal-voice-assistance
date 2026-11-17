import type { ChoiceOption, Condition, RecordItemField, SettingField } from "@pva/protocol"
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

/** A list of short strings: aliases, greeting words. Trimmed, empty items dropped, duplicates (ignoring case) dropped. */
const textList = (o: Common & {
  readonly default?: ReadonlyArray<string>
  readonly maxItems?: number
  readonly itemMaxLength?: number
  readonly placeholder?: string
}): Setting<ReadonlyArray<string>> => {
  const maxItems = o.maxItems ?? 50
  const itemMaxLength = o.itemMaxLength ?? 60
  const decode = (raw: unknown): Decoded<ReadonlyArray<string>> => {
    if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === "string")) return fail("Must be a list of text")
    const seen = new Set<string>()
    const items: Array<string> = []
    for (const item of raw.map((s) => s.trim()).filter((s) => s.length > 0)) {
      if (item.length > itemMaxLength) return fail(`"${item.slice(0, 20)}…" is longer than ${itemMaxLength} characters`)
      if (seen.has(item.toLowerCase())) continue
      seen.add(item.toLowerCase())
      items.push(item)
    }
    return items.length > maxItems ? fail(`At most ${maxItems} items`) : ok(items)
  }
  return {
    type: "textList",
    secret: false,
    ...visibility(o),
    env: o.env,
    value: "editable",
    defaultValue: o.default ?? [],
    describe: (key) => ({
      type: "textList",
      ...commonFields(key, o),
      default: o.default ?? [],
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
 * An ordered list of records with the same flat fields (rooms with aliases, lamps). Missing item keys take the item
 * field's default; unknown keys are dropped. From the environment: JSON (`DEMO_ROOMS='[{"name":"Kitchen"}]'`).
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
  }
  if (!Object.hasOwn(o.item, o.titleKey)) throw new Error(`Records title "${o.titleKey}" is not one of its item fields`)
  const maxItems = o.maxItems ?? 50
  const decode = (raw: unknown): Decoded<ReadonlyArray<ItemOf<I>>> => {
    if (!Array.isArray(raw)) return fail("Must be a list")
    if (raw.length > maxItems) return fail(`At most ${maxItems} ${o.itemLabel}s`)
    const result: Array<ItemOf<I>> = []
    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(`${upper(o.itemLabel)} ${index + 1}: must be an object`)
      const value: Record<string, unknown> = {}
      for (const [key, setting] of Object.entries(o.item)) {
        if (!Object.hasOwn(entry, key)) {
          value[key] = setting.defaultValue
          continue
        }
        const decoded = setting.decode((entry as Record<string, unknown>)[key])
        if (!decoded.ok) return fail(`${upper(o.itemLabel)} ${index + 1}, ${setting.describe(key).label}: ${decoded.error}`)
        value[key] = decoded.value
      }
      result.push(value as ItemOf<I>)
    }
    const problem = o.check?.(result)
    return problem === undefined ? ok(result) : fail(problem)
  }
  return {
    type: "records",
    secret: false,
    ...visibility(o),
    env: o.env,
    value: "editable",
    defaultValue: o.default ?? [],
    describe: (key) => ({
      type: "records",
      ...commonFields(key, o),
      default: (o.default ?? []) as never,
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
 * options are accepted (so dynamic lists need `allowCustom: true`).
 */
const combo = (o: Common & {
  readonly default: string
  readonly options?: ReadonlyArray<ChoiceOption>
  readonly allowCustom?: boolean
  readonly maxLength?: number
  readonly placeholder?: string
}): Setting<string> => {
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
  return {
    type: "combo",
    secret: false,
    ...visibility(o),
    env: o.env,
    value: "editable",
    defaultValue: o.default,
    describe: (key) => ({
      type: "combo",
      ...commonFields(key, o),
      default: o.default,
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

/** Read-only text from the running instance (`info()[key]`); "" while it does not run. */
const info = (o: Omit<Common, "env" | "apply" | "overridable"> & { readonly tone?: "neutral" | "ok" | "warning" | "error" }): Setting<string> & { readonly value: "readOnly" } => ({
  type: "info",
  secret: false,
  ...visibility(o),
  overridable: false,
  env: undefined,
  value: "readOnly",
  defaultValue: "",
  describe: (key): SettingField => ({ type: "info", ...commonFields(key, o), ...(o.tone !== undefined ? { tone: o.tone } : {}) }),
  decode: () => fail("Read-only"),
  fromEnv: () => fail("Read-only")
})

/** The extended constructors (also members of `Setting`). */
export const SettingExtra = { textList, records, combo, action, info }
