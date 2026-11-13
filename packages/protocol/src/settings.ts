import { Schema } from "effect"
import { FieldError, FieldKey } from "./common.ts"

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
  locked: Schema.optionalKey(Schema.Struct({ reason: Schema.String }))
}

export const ChoiceOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String)
})
export type ChoiceOption = typeof ChoiceOption.Type

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

export const SettingField = Schema.Union([TextField, SecretField, NumberField, BooleanField, ChoiceField, MultiChoiceField])
  .pipe(Schema.toTaggedUnion("type"))
export type SettingField = typeof SettingField.Type
export type SettingFieldType = SettingField["type"]

/** A non-secret value. The field's `type` says which member applies. */
export const SettingValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Array(Schema.String)])
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
  errors: Schema.Array(FieldError)
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
