import type { ChoiceOption, RecordItemField, SettingFieldTypeV2, SettingFieldV2 } from "@pva/protocol"
import type { Decoded, Setting } from "./Settings.ts"

/**
 * The five settings field types added for agents, routing, voices and actions
 * (docs/AGENTS-AND-INTENTS.md §4.3): `textList`, `records`, `combo`, `action`, `info`.
 *
 * STATUS: constructors and validation, tested on their own. They produce
 * `ExtendedSetting`s, which `resolveSettings` / `applySettingsPatch` cannot take
 * yet: at integration (build plan piece G, with protocol v2) `Setting<A>` is
 * widened to `SettingFieldV2`, these constructors join `Setting`, and the two
 * functions skip `action` fields (no value) and fill `info` fields from the
 * instance (never patchable).
 */

interface Common {
  readonly label: string
  readonly description?: string
  readonly advanced?: boolean
  readonly apply?: "live" | "reload"
  readonly env?: string
}

export interface ExtendedSetting<A> {
  readonly type: SettingFieldTypeV2
  readonly secret: false
  readonly env: string | undefined
  /** `action` has no value at all; `info` has a value that only the server sets. */
  readonly value: "editable" | "none" | "readOnly"
  readonly defaultValue: A
  readonly describe: (key: string) => SettingFieldV2
  readonly decode: (raw: unknown) => Decoded<A>
  readonly fromEnv: (text: string) => Decoded<A>
}

const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
const fail = (error: string): Decoded<never> => ({ ok: false, error })

const commonFields = (key: string, o: Common) => ({
  key,
  label: o.label,
  apply: o.apply ?? "live",
  ...(o.description !== undefined ? { description: o.description } : {}),
  ...(o.advanced !== undefined ? { advanced: o.advanced } : {})
})

/** A list of short strings: aliases, greeting words. Trimmed, empty items dropped, duplicates (ignoring case) dropped. */
const textList = (o: Common & {
  readonly default?: ReadonlyArray<string>
  readonly maxItems?: number
  readonly itemMaxLength?: number
  readonly placeholder?: string
}): ExtendedSetting<ReadonlyArray<string>> => {
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

/** A field allowed inside a record: the v1 non-secret constructors, or `textList`. */
export type ItemSetting = Setting<any> | ExtendedSetting<ReadonlyArray<string>>
export type ItemSpec = { readonly [key: string]: ItemSetting }
export type ItemOf<I extends ItemSpec> = {
  readonly [K in keyof I]: I[K] extends Setting<infer A> ? A : I[K] extends ExtendedSetting<infer B> ? B : never
}

const itemField = (key: string, setting: ItemSetting): RecordItemField => {
  const d = setting.describe(key) as Record<string, unknown> & { readonly type: string }
  const { apply: _a, advanced: _adv, locked: _l, ...rest } = d
  return rest as RecordItemField
}

/**
 * An ordered list of records with the same fields (routing rules, rooms with
 * aliases). Missing item keys take the item field's default; unknown keys are dropped.
 * From the environment: JSON (`ROUTING_RULES='[{"agent":"jev","phrases":["hey jev"]}]'`).
 */
const records = <const I extends ItemSpec>(o: Common & {
  readonly item: I
  readonly default?: ReadonlyArray<ItemOf<I>>
  /** Singular noun for buttons ("rule"). */
  readonly itemLabel: string
  /** Item key whose value titles a collapsed row. */
  readonly titleKey: keyof I & string
  readonly maxItems?: number
  readonly orderable?: boolean
  /** Extra validation of the whole list; return a message for an invalid value. */
  readonly check?: (value: ReadonlyArray<ItemOf<I>>) => string | undefined
}): ExtendedSetting<ReadonlyArray<ItemOf<I>>> => {
  for (const [key, s] of Object.entries(o.item)) {
    if (s.secret || !["text", "number", "boolean", "choice", "multichoice", "textList"].includes(s.type)) {
      throw new Error(`Record field "${key}" cannot be of type ${s.type}`)
    }
  }
  const maxItems = o.maxItems ?? 50
  const decode = (raw: unknown): Decoded<ReadonlyArray<ItemOf<I>>> => {
    if (!Array.isArray(raw)) return fail("Must be a list")
    if (raw.length > maxItems) return fail(`At most ${maxItems} ${o.itemLabel}s`)
    const result: Array<ItemOf<I>> = []
    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(`${o.itemLabel} ${index + 1}: must be an object`)
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
    env: o.env,
    value: "editable",
    defaultValue: o.default ?? [],
    describe: (key) => ({
      type: "records",
      ...commonFields(key, o),
      default: (o.default ?? []) as never,
      itemFields: Object.entries(o.item).map(([k, s]) => itemField(k, s)),
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
 * Free text with suggestions: a model name. `options` are the static
 * suggestions; a running instance adds more through `settingOptions`. With
 * `allowCustom: false` only static options are accepted (so dynamic lists need `allowCustom: true`).
 */
const combo = (o: Common & {
  readonly default: string
  readonly options?: ReadonlyArray<ChoiceOption>
  readonly allowCustom?: boolean
  readonly maxLength?: number
  readonly placeholder?: string
}): ExtendedSetting<string> => {
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

/** A button ("Test", "Play a sample"). No value; the handler is the instance's `fieldActions[key]` (or the server's, for sections). */
const action = (o: Omit<Common, "env" | "apply"> & {
  readonly buttonLabel: string
  readonly confirm?: string
  /** Default true: uses the saved settings, so it is disabled while the form has unsaved edits. */
  readonly requiresSaved?: boolean
}): ExtendedSetting<undefined> => ({
  type: "action",
  secret: false,
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

/** Read-only text from the running instance (`info`); "" while not running. */
const info = (o: Omit<Common, "env" | "apply"> & { readonly tone?: "neutral" | "ok" | "warning" | "error" }): ExtendedSetting<string> => ({
  type: "info",
  secret: false,
  env: undefined,
  value: "readOnly",
  defaultValue: "",
  describe: (key) => ({ type: "info", ...commonFields(key, o), ...(o.tone !== undefined ? { tone: o.tone } : {}) }),
  decode: () => fail("Read-only"),
  fromEnv: () => fail("Read-only")
})

/** Constructors joined into `Setting` at integration. */
export const SettingExtra = { textList, records, combo, action, info }
