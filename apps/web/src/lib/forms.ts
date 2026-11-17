import { evaluateCondition, type FieldError, type SettingField, type SettingsForm, type SettingsPatch, type SettingValue } from "@pva/protocol"

/**
 * Pure helpers behind the generated settings forms: the local draft, the
 * patch to send (only the fields the user edited), and keeping edits when
 * another tab changes the same form.
 */

export interface Draft {
  /** Every non-secret value, as edited. */
  readonly values: Readonly<Record<string, SettingValue>>
  /** Only the secrets the user touched: a new value, or `null` to remove. */
  readonly secrets: Readonly<Record<string, string | null>>
  /** Saved values the user reset to their default ("Reset to default"): sent as `null`, so nothing stays saved. */
  readonly reset?: ReadonlyArray<string>
  /**
   * The server's values the draft is relative to. A field is edited when its value differs from
   * its base, and only edited fields are sent: comparing with the newest form instead would turn
   * a change made in another tab into a reset of that change.
   */
  readonly base: Readonly<Record<string, SettingValue>>
}

export const initialDraft = (form: SettingsForm): Draft => ({ values: { ...form.values }, secrets: {}, base: { ...form.values } })

const edited = (draft: Draft, key: string): boolean => {
  const value = draft.values[key]
  return value !== undefined && !valueEqual(value, draft.base[key])
}

/** The draft with `key` set to `value` (an edit undoes a pending reset of that field). */
export const setDraftValue = (draft: Draft, key: string, value: SettingValue): Draft => ({
  ...draft,
  values: { ...draft.values, [key]: value },
  ...(draft.reset?.includes(key) ? { reset: draft.reset.filter((k) => k !== key) } : {})
})

/** "Reset to default": the draft shows the default, and the save removes the saved value. */
export const resetDraftValue = (draft: Draft, field: SettingField): Draft => {
  if (field.type === "secret" || field.type === "action" || field.type === "info") return draft
  return { ...draft, values: { ...draft.values, [field.key]: field.default as SettingValue }, reset: [...(draft.reset ?? []).filter((k) => k !== field.key), field.key] }
}

/**
 * Is the field shown? `lookup` gives other fields' current values (the page's drafts, then every section's saved
 * values): the condition is evaluated against the draft, so choosing a provider shows its fields before saving.
 */
export const fieldVisible = (field: SettingField, lookup: (key: string) => unknown): boolean =>
  field.visibleWhen === undefined || evaluateCondition(field.visibleWhen, lookup)

/** A lookup over this form's draft first, then `fallback` (other forms, saved values). */
export const draftLookup = (draft: Draft, fallback: (key: string) => unknown) => (key: string): unknown =>
  Object.hasOwn(draft.values, key) ? draft.values[key] : fallback(key)

/** Equal values; lists (of text or, protocol 10, of records) are compared deeply. */
export const valueEqual = (a: SettingValue | undefined, b: SettingValue | undefined): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  return a === b
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** `record[key]` when `key` is the record's own (a field named `constructor` is not `Object`), else `undefined`. */
export const ownValue = <V>(record: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(record, key) ? record[key] : undefined)

/** Fields whose value the owner sets (protocol 10: an `action` has none, an `info` value is the server's). */
export const hasOwnerValue = (field: SettingField): boolean => field.type !== "action" && field.type !== "info"

/** A field's default (secrets, actions and info values have none). */
export const fieldDefault = (field: SettingField): SettingValue | undefined => ("default" in field ? field.default : undefined)

/**
 * The patch for the fields the user edited (changed from the draft's base). Locked fields are never sent, nor
 * hidden ones (`shown` false: their saved value stays). A reset field whose value is saved is sent as `null`.
 */
export const computePatch = (form: SettingsForm, draft: Draft, shown: (field: SettingField) => boolean = () => true): SettingsPatch => {
  const values: Record<string, SettingValue | null> = {}
  const secrets: Record<string, string | null> = {}
  for (const field of form.fields) {
    if (field.locked !== undefined || !shown(field) || !hasOwnerValue(field)) continue
    if (field.type === "secret") {
      if (field.key in draft.secrets) secrets[field.key] = draft.secrets[field.key]!
      continue
    }
    const next = ownValue(draft.values, field.key)
    if (draft.reset?.includes(field.key) === true && field.source === "saved" && valueEqual(next, fieldDefault(field))) {
      values[field.key] = null
      continue
    }
    if (edited(draft, field.key)) values[field.key] = draft.values[field.key]!
  }
  return { values, secrets }
}

/** Every changed field of the patch applies after an engine reload (offer "Save and reload"). */
export const onlyReloadFields = (form: SettingsForm, patch: SettingsPatch): boolean => {
  const keys = [...Object.keys(patch.values), ...Object.keys(patch.secrets)]
  return keys.length > 0 && keys.every((k) => form.fields.find((f) => f.key === k)?.apply === "reload")
}

/** Some changed field of the patch applies after an engine reload. */
export const someReloadFields = (form: SettingsForm, patch: SettingsPatch): boolean =>
  [...Object.keys(patch.values), ...Object.keys(patch.secrets)].some((k) => form.fields.find((f) => f.key === k)?.apply === "reload")

export const isEmptyPatch = (p: SettingsPatch) => Object.keys(p.values).length === 0 && Object.keys(p.secrets).length === 0

export const isDirty = (form: SettingsForm, draft: Draft) => !isEmptyPatch(computePatch(form, draft))

/** Field errors grouped by key (`null` = the form as a whole). */
export const errorsByKey = (errors: ReadonlyArray<FieldError>): ReadonlyMap<string | null, ReadonlyArray<string>> => {
  const map = new Map<string | null, Array<string>>()
  for (const e of errors) {
    const list = map.get(e.key) ?? []
    list.push(e.message)
    map.set(e.key, list)
  }
  return map
}

export interface FormSync {
  readonly draft: Draft
  /** The revision the draft was based on. */
  readonly baseRevision: number
  /** A newer revision arrived while the user had edits: offer "Load latest". */
  readonly stale: boolean
}

/**
 * A new form arrived (`module.changed` / `section.changed`). Without edits the
 * draft follows silently. With edits, the edited fields keep the user's values,
 * every other field takes the new server value, the new values become the base
 * (so a save sends only the edits), and the form is marked stale ("Changed in
 * another tab"). A field changed on both sides keeps the user's edit.
 */
export const reconcile = (sync: FormSync, previous: SettingsForm, next: SettingsForm, revision: number): FormSync => {
  if (revision <= sync.baseRevision) return sync
  if (!isDirty(previous, sync.draft)) return { draft: initialDraft(next), baseRevision: revision, stale: false }
  const values: Record<string, SettingValue> = { ...next.values }
  for (const key of Object.keys(sync.draft.values)) {
    if (edited(sync.draft, key)) values[key] = sync.draft.values[key]!
  }
  return {
    draft: {
      values,
      secrets: sync.draft.secrets,
      base: { ...next.values },
      ...(sync.draft.reset !== undefined ? { reset: sync.draft.reset } : {})
    },
    baseRevision: revision,
    stale: true
  }
}

/** Fields split into the normal ones and those behind "Advanced". */
export const splitAdvanced = (fields: ReadonlyArray<SettingField>) => ({
  basic: fields.filter((f) => f.advanced !== true),
  advanced: fields.filter((f) => f.advanced === true)
})

/** A number field's value from its text input, or a message when it is not acceptable. */
export const parseNumber = (text: string, field: Extract<SettingField, { type: "number" }>): { value: number } | { error: string } => {
  if (text.trim() === "") return { error: "Enter a number." }
  const n = Number(text)
  if (!Number.isFinite(n)) return { error: "Enter a number." }
  if (field.integer && !Number.isInteger(n)) return { error: "Enter a whole number." }
  if (field.min !== undefined && n < field.min) return { error: `At least ${field.min}${field.unit ? ` ${field.unit}` : ""}.` }
  if (field.max !== undefined && n > field.max) return { error: `At most ${field.max}${field.unit ? ` ${field.unit}` : ""}.` }
  return { value: n }
}
