import { Schema } from "effect"
import { FieldError, FieldKey, ModuleId, NonNegativeFinite } from "./common.ts"
import { ToolId } from "./jobs.ts"

/**
 * Settings are described as data, so the UI renders a form for any module or
 * settings section without knowing it. The set of field types is closed on
 * purpose: each one has exactly one widget in the UI. Adding a type is a
 * protocol change (bump `PROTOCOL_VERSION`) plus one renderer.
 */

/** When a changed value takes effect. */
export const ApplyMode = Schema.Literals([
  /** Immediately (from the next turn). */
  "live",
  /** After the engines are reloaded (`engine.reload`); the UI offers a "Save and reload engines" button. */
  "reload"
])
export type ApplyMode = typeof ApplyMode.Type

/**
 * Where the settings screen shows a section or a module (docs/SETTINGS-UI.md §2.2): its category. The UI hard-codes
 * only these categories and their order; everything inside them comes from the server. Overview, This device and
 * About are pages of the UI itself.
 */
export const SettingsGroup = Schema.Literals(["agents", "speech", "voices", "modules", "access", "diagnostics", "general"])
export type SettingsGroup = typeof SettingsGroup.Type

/** A page of the settings screen. Sections with the same `page.id` (in one group) are shown stacked on one page. */
export const SettingsPage = Schema.Struct({
  /** Unique within its group; the deep link is `#settings/<group>/<id>`. */
  id: ModuleId,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String)
})
export type SettingsPage = typeof SettingsPage.Type

/** A value a condition compares with: a choice, a number or a switch. */
export const ConditionValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
export type ConditionValue = typeof ConditionValue.Type

/** True when the field `key` (in any section; keys are global) has one of the values `in`. */
export const FieldCondition = Schema.Struct({ key: FieldKey, in: Schema.Array(ConditionValue) })
export type FieldCondition = typeof FieldCondition.Type

/**
 * When a field or page is shown (docs/SETTINGS-UI.md §4.2): equality only, one level of `all` / `any`. The UI
 * evaluates it against the draft, so choosing a provider shows its fields before saving; the server evaluates it
 * against the saved values and never validates a hidden field.
 */
export const Condition = Schema.Union([
  FieldCondition,
  Schema.Struct({ all: Schema.Array(FieldCondition) }),
  Schema.Struct({ any: Schema.Array(FieldCondition) })
])
export type Condition = typeof Condition.Type

/**
 * Where a field's value comes from: its `default`, a value `saved` from the UI, or the environment, from a `.env`
 * file (`env-file`) or the process environment (`env-process`, exported by the shell or the service). The last two
 * lock the field. For secrets, `SecretState.source` says the same.
 */
export const FieldSource = Schema.Literals(["default", "saved", "env-file", "env-process"])
export type FieldSource = typeof FieldSource.Type

/** Evaluate a condition. `lookup` gives a field's current value (undefined: unknown, never matches). Pure. */
export const evaluateCondition = (condition: Condition, lookup: (key: string) => unknown): boolean => {
  const one = (c: FieldCondition) => {
    const value = lookup(c.key)
    return value !== undefined && c.in.some((v) => v === value)
  }
  if ("all" in condition) return condition.all.every(one)
  if ("any" in condition) return condition.any.some(one)
  return one(condition)
}

const common = {
  key: FieldKey,
  label: Schema.String,
  /** One or two sentences under the field. */
  description: Schema.optionalKey(Schema.String),
  apply: ApplyMode,
  /** Hidden behind "Show advanced settings". */
  advanced: Schema.optionalKey(Schema.Boolean),
  /**
   * The value is fixed by the environment (an environment variable or `.env`
   * entry wins over saved settings). The UI shows the value read-only with this reason.
   */
  locked: Schema.optionalKey(Schema.Struct({
    reason: Schema.String,
    /** The `.env` file that sets it, and the line (only for `source: "env-file"`): "Move to settings" can take it out. */
    file: Schema.optionalKey(Schema.String),
    line: Schema.optionalKey(Schema.Int)
  })),
  /** Shown only while this holds (evaluated against the draft). A hidden field is not validated and not sent. */
  visibleWhen: Schema.optionalKey(Condition),
  /** Where the value comes from (markers and "Reset to default" in the UI). Absent: unknown (an older server). */
  source: Schema.optionalKey(FieldSource),
  /**
   * Module fields only: an assistant may have its own value for this field (`ModuleChoice.own`, docs/ASSISTANTS.md
   * §2.6), which wins over the shared one for that assistant. Never on secrets or addresses. Absent = false.
   */
  overridable: Schema.optionalKey(Schema.Boolean)
}

/**
 * What choosing an option implies, shown as chips on every option (docs/SETTINGS-UI.md §3.3). A closed set: adding
 * a tag is a protocol change, so keep it small.
 * - `local` / `hosted`: runs on this machine, or sends data to a service;
 * - `needs-key`: needs an API key (see the provider's page);
 * - `not-downloaded`: its model files are not on this machine yet;
 * - `slow-start`: the first audio or word takes noticeably longer;
 * - `experimental`: works, with caveats the description names.
 */
export const OptionTag = Schema.Literals(["local", "hosted", "needs-key", "not-downloaded", "slow-start", "experimental"])
export type OptionTag = typeof OptionTag.Type

export const ChoiceOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(OptionTag)),
  /** One line under the selected option saying what choosing it means ("What you say is sent to Deepgram."). */
  implication: Schema.optionalKey(Schema.String),
  /**
   * This option is served by a module (an agent): the page shows that module's state, its switch and its opt-in
   * field (`optIn`, a boolean setting of the module) next to the choice, so one page sets it all up.
   */
  module: Schema.optionalKey(Schema.Struct({ id: ModuleId, optIn: Schema.optionalKey(FieldKey) })),
  /**
   * The option's model files can be downloaded from the UI (with `not-downloaded`: they are missing): an admin page
   * offers Download inline (`job.start` with this tool and target) instead of refusing the save.
   */
  download: Schema.optionalKey(Schema.Struct({ tool: ToolId, target: Schema.String, sizeMb: NonNegativeFinite }))
})
export type ChoiceOption = typeof ChoiceOption.Type

// ---------------------------------------------------------------------------------------------------------------------
// Bounds of the protocol 10 field types (docs/SETTINGS-UI.md §3.2). Every string, list and record they add has a
// maximum, checked here on the wire (both directions) and by the core's constructors and decoders, so one module form
// stays far below the frame limit (1 MB) however a module fills it.

/** A label, button text or note. */
export const MAX_FIELD_LABEL = 200
/** A description or confirmation text. */
export const MAX_FIELD_DESCRIPTION = 1000
/** Items of a `textList` (value, default and `maxItems`). */
export const MAX_TEXT_LIST_ITEMS = 200
/** Characters of one `textList` item (and `itemMaxLength`). */
export const MAX_TEXT_LIST_ITEM = 500
/** Records of a `records` value (and `maxItems`). */
export const MAX_RECORDS = 200
/** Item fields of a `records` field (keys of one record). */
export const MAX_RECORD_FIELDS = 32
/** Characters of one text value inside a record, of a `combo` value (and `maxLength`). */
export const MAX_RECORD_TEXT = 2000
/** A whole `records` or `textList` value as JSON, characters. */
export const MAX_LIST_JSON = 32_768
/** Options of a `combo` field (static and the running instance's together), or of a record's choice. */
export const MAX_COMBO_OPTIONS = 200
/** A whole options list as JSON, characters (the host drops the last options of a longer one). */
export const MAX_OPTIONS_JSON = 32_768

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
/** At most `max` characters as JSON (the list's whole size on the wire). */
const jsonAtMost = <T>(max: number, what: string) =>
  Schema.makeFilter((v: T) => JSON.stringify(v).length <= max || `${what} must be at most ${max} characters as JSON`)
/** A declared limit: a whole number from 1 to `max`. */
const Limit = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }))

/** An option of a protocol 10 field (a `combo`, a record's choice), bounded. */
export const BoundedChoiceOption = Schema.Struct({
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  label: Text(MAX_FIELD_LABEL),
  description: Schema.optionalKey(Text(500)),
  tags: Schema.optionalKey(Schema.Array(OptionTag).check(Schema.isMaxLength(6))),
  implication: Schema.optionalKey(Text(500))
})
const BoundedOptions = Schema.Array(BoundedChoiceOption).check(Schema.isMaxLength(MAX_COMBO_OPTIONS), jsonAtMost(MAX_OPTIONS_JSON, "The options"))

/** A `textList` value: bounded items and size. */
export const TextListValue = Schema.Array(Text(MAX_TEXT_LIST_ITEM)).check(Schema.isMaxLength(MAX_TEXT_LIST_ITEMS), jsonAtMost(MAX_LIST_JSON, "A list"))

const fieldText = {
  label: Text(MAX_FIELD_LABEL),
  description: Schema.optionalKey(Text(MAX_FIELD_DESCRIPTION))
}

export const TextField = Schema.Struct({
  type: Schema.Literal("text"),
  ...common,
  default: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
  maxLength: Schema.optionalKey(Schema.Int),
  /** Render as a multi-line text area (e.g. the system prompt). */
  multiline: Schema.optionalKey(Schema.Boolean)
})

/**
 * A secret (API key, token). Its value never leaves the server: the form gets
 * a `SecretState` instead, and the client can only set or clear it.
 */
export const SecretField = Schema.Struct({
  type: Schema.Literal("secret"),
  ...common,
  /** Environment variable that also provides it (and then wins), e.g. "HOME_ASSISTANT_TOKEN". */
  env: Schema.optionalKey(Schema.String)
})

export const NumberField = Schema.Struct({
  type: Schema.Literal("number"),
  ...common,
  default: Schema.Finite,
  integer: Schema.Boolean,
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  step: Schema.optionalKey(Schema.Finite),
  /** Shown after the input, e.g. "ms", "°C". */
  unit: Schema.optionalKey(Schema.String)
})

export const BooleanField = Schema.Struct({
  type: Schema.Literal("boolean"),
  ...common,
  default: Schema.Boolean
})

export const ChoiceField = Schema.Struct({
  type: Schema.Literal("choice"),
  ...common,
  default: Schema.String,
  options: Schema.Array(ChoiceOption)
})

export const MultiChoiceField = Schema.Struct({
  type: Schema.Literal("multichoice"),
  ...common,
  default: Schema.Array(Schema.String),
  options: Schema.Array(ChoiceOption)
})

// ---------------------------------------------------------------------------------------------------------------------
// Protocol 10: the extended field types (docs/AGENTS-AND-INTENTS.md §4.3, docs/MODULES-PLAN.md §4 P3). They were
// defined in `agents.ts` for agent forms and joined `SettingField` here, so module forms, settings sections and
// agent forms share one wire form.

/** A list of short strings (aliases, greeting words, rooms): chips with an "add" input. Value: `string[]`. */
export const TextListField = Schema.Struct({
  type: Schema.Literal("textList"),
  ...common,
  ...fieldText,
  default: TextListValue,
  maxItems: Schema.optionalKey(Limit(MAX_TEXT_LIST_ITEMS)),
  itemMaxLength: Schema.optionalKey(Limit(MAX_TEXT_LIST_ITEM)),
  placeholder: Schema.optionalKey(Text(MAX_FIELD_LABEL))
})

const itemCommon = {
  key: FieldKey,
  ...fieldText,
  /** Protocol 11: kept in every record but not drawn (an id the server makes, such as a person's). */
  hidden: Schema.optionalKey(Schema.Boolean)
}

/** The field types allowed inside a record: flat, no secrets, no nesting, no actions (docs/MODULES-PLAN.md §3.3). */
export const RecordItemField = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    ...itemCommon,
    default: Text(MAX_RECORD_TEXT),
    placeholder: Schema.optionalKey(Text(MAX_FIELD_LABEL)),
    maxLength: Schema.optionalKey(Limit(MAX_RECORD_TEXT)),
    multiline: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.Struct({
    type: Schema.Literal("number"),
    ...itemCommon,
    default: Schema.Finite,
    integer: Schema.Boolean,
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
    step: Schema.optionalKey(Schema.Finite),
    unit: Schema.optionalKey(Text(40))
  }),
  Schema.Struct({ type: Schema.Literal("boolean"), ...itemCommon, default: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("choice"), ...itemCommon, default: Text(200), options: BoundedOptions }),
  Schema.Struct({
    type: Schema.Literal("multichoice"),
    ...itemCommon,
    default: Schema.Array(Text(200)).check(Schema.isMaxLength(MAX_COMBO_OPTIONS)),
    options: BoundedOptions
  }),
  Schema.Struct({
    type: Schema.Literal("textList"),
    ...itemCommon,
    default: TextListValue,
    maxItems: Schema.optionalKey(Limit(MAX_TEXT_LIST_ITEMS)),
    itemMaxLength: Schema.optionalKey(Limit(MAX_TEXT_LIST_ITEM)),
    placeholder: Schema.optionalKey(Text(MAX_FIELD_LABEL))
  })
]).pipe(Schema.toTaggedUnion("type"))
export type RecordItemField = typeof RecordItemField.Type

/** One record: item field key → value (at most `MAX_RECORD_FIELDS` keys, bounded values). */
export const RecordValue = Schema.Record(
  FieldKey,
  Schema.Union([Text(MAX_RECORD_TEXT), Schema.Finite, Schema.Boolean, Schema.Array(Text(MAX_TEXT_LIST_ITEM)).check(Schema.isMaxLength(MAX_TEXT_LIST_ITEMS))])
).check(Schema.isMaxProperties(MAX_RECORD_FIELDS))
export type RecordValue = typeof RecordValue.Type

/** A `records` value: at most `MAX_RECORDS` records and `MAX_LIST_JSON` characters as JSON. */
export const RecordsValue = Schema.Array(RecordValue).check(Schema.isMaxLength(MAX_RECORDS), jsonAtMost(MAX_LIST_JSON, "A list of records"))

/**
 * An ordered list of records with the same flat fields (rooms with aliases, lamps, members). Rendered as a list of
 * compact rows, each expanding into a small form built from `itemFields`; add, remove and (if `orderable`) move
 * up/down. Value: `RecordValue[]`. Nested configuration is JSON in a validated text field instead.
 */
export const RecordsField = Schema.Struct({
  type: Schema.Literal("records"),
  ...common,
  ...fieldText,
  default: RecordsValue,
  itemFields: Schema.Array(RecordItemField).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RECORD_FIELDS)),
  /** Singular noun for buttons: "Add room". */
  itemLabel: Text(60),
  /** Item field whose value titles a collapsed row. */
  titleKey: FieldKey,
  maxItems: Schema.optionalKey(Limit(MAX_RECORDS)),
  /** Order matters (first match wins); show move controls. */
  orderable: Schema.Boolean
})

/**
 * Free text with suggestions (a combobox): a model name picked from the backend's own list, with any other name
 * allowed when `allowCustom`. The server adds the running instance's options (`settingOptions`) to the static ones;
 * `optionsNote` says where they came from ("From the server's model list", "Not running: type a name").
 * Value: `string`.
 */
export const ComboField = Schema.Struct({
  type: Schema.Literal("combo"),
  ...common,
  ...fieldText,
  default: Text(MAX_RECORD_TEXT),
  options: BoundedOptions,
  allowCustom: Schema.Boolean,
  maxLength: Schema.optionalKey(Limit(MAX_RECORD_TEXT)),
  placeholder: Schema.optionalKey(Text(MAX_FIELD_LABEL)),
  optionsNote: Schema.optionalKey(Text(MAX_FIELD_LABEL))
})

/**
 * A button that runs something on the server ("Test", "Refresh the list"). It has no value: it is never in
 * `values` and never in a patch. Pressing it sends `module.action`; the result (`Result.action`) is shown next to
 * the button until the form is closed. `requiresSaved`: the handler uses the saved settings, so the button is
 * disabled while the form has unsaved edits; without it the page sends its draft values with the press.
 */
export const ActionField = Schema.Struct({
  type: Schema.Literal("action"),
  ...common,
  ...fieldText,
  buttonLabel: Text(60),
  /** Ask "Are you sure?" with this text first. */
  confirm: Schema.optionalKey(Text(MAX_FIELD_DESCRIPTION)),
  requiresSaved: Schema.Boolean
})

/**
 * A link a button's answer offers (additive within 12, docs/modules/media.md "Signing in to Spotify"): an address on the
 * assistant's own origin, under `/api/modules/<id>/`, which the page shows beside the answer so the owner can open it in a
 * new tab (a sign-in that continues on another site). Never an address on another origin: the page resolves `href` against
 * its own.
 */
export const FieldActionLink = Schema.Struct({
  href: Schema.String.check(Schema.isMaxLength(400), Schema.isPattern(/^\/api\/modules\/[a-z][a-z0-9-]{0,39}\/[A-Za-z0-9._~/?=&%-]{0,300}$/)),
  label: Text(60)
})
export type FieldActionLink = typeof FieldActionLink.Type

/** What an `action` field's handler said: shown next to its button (`Result.action` of `module.action`). */
export const FieldActionResult = Schema.Struct({
  ok: Schema.Boolean,
  /** One or two sentences for the owner. At most 500 characters. */
  text: Schema.String.check(Schema.isMaxLength(500)),
  tone: Schema.optionalKey(Schema.Literals(["neutral", "ok", "warning", "error"])),
  /** A link the page shows beside the answer (opened by the owner, in a new tab). */
  link: Schema.optionalKey(FieldActionLink)
})
export type FieldActionResult = typeof FieldActionResult.Type

/** Read-only text computed by the server ("Logged in with a Max plan", "Last test: 912 ms"). Value: `string` ("" when not known). */
export const InfoField = Schema.Struct({
  type: Schema.Literal("info"),
  ...common,
  ...fieldText,
  tone: Schema.optionalKey(Schema.Literals(["neutral", "ok", "warning", "error"]))
})

export const SettingField = Schema.Union([
  TextField,
  SecretField,
  NumberField,
  BooleanField,
  ChoiceField,
  MultiChoiceField,
  TextListField,
  RecordsField,
  ComboField,
  ActionField,
  InfoField
]).pipe(Schema.toTaggedUnion("type"))
export type SettingField = typeof SettingField.Type
export type SettingFieldType = SettingField["type"]

/**
 * A non-secret value. The field's `type` says which member applies; protocol 10 adds a list of records. `action`
 * fields have no value; `info` fields have a string.
 */
export const SettingValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Array(Schema.String), RecordsValue])
export type SettingValue = typeof SettingValue.Type

/** What the client may know about a secret. */
export const SecretState = Schema.Struct({
  set: Schema.Boolean,
  /** `env`: from the environment (read-only in the UI); `store`: saved from the UI; `none`: not set. */
  source: Schema.Literals(["env", "store", "none"])
})
export type SecretState = typeof SecretState.Type

/** A settings form: field descriptions, current values, and any validation problems. */
export const SettingsForm = Schema.Struct({
  fields: Schema.Array(SettingField),
  /** Effective value of every non-secret field (saved value, else the default). */
  values: Schema.Record(FieldKey, SettingValue),
  /** State of every secret field. */
  secrets: Schema.Record(FieldKey, SecretState),
  /** Problems with the saved values (e.g. a value no longer valid after a module update). */
  errors: Schema.Array(FieldError),
  /**
   * Things that work but probably not as meant, for the saved values ("Anthropic is chosen but there is no key").
   * They never block anything. A save that would cause new ones is answered with them first (`ErrorInfo.warnings`),
   * and the UI offers "Save anyway" (`settings.update` with `confirmWarnings`).
   */
  warnings: Schema.optionalKey(Schema.Array(FieldError))
})
export type SettingsForm = typeof SettingsForm.Type

/**
 * A change sent by the client: only the fields the user changed. `null` resets
 * a value to its default (for a secret: removes the saved secret).
 */
export const SettingsPatch = Schema.Struct({
  values: Schema.Record(FieldKey, Schema.NullOr(SettingValue)),
  secrets: Schema.Record(FieldKey, Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))))
})
export type SettingsPatch = typeof SettingsPatch.Type
