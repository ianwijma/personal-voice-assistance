import type { FieldError, SettingField, SettingsForm, SettingsPatch, SettingValue } from "@pva/protocol"

/**
 * Pure helpers behind the generated settings forms: the local draft, the
 * patch to send (only changed fields), and keeping edits when another tab
 * changes the same form.
 */

export interface Draft {
  /** Every non-secret value, as edited. */
  readonly values: Readonly<Record<string, SettingValue>>
  /** Only the secrets the user touched: a new value, or `null` to remove. */
  readonly secrets: Readonly<Record<string, string | null>>
}

export const initialDraft = (form: SettingsForm): Draft => ({ values: { ...form.values }, secrets: {} })

export const valueEqual = (a: SettingValue | undefined, b: SettingValue | undefined): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return a === b
}

/** The patch for the changed fields only (locked fields are never sent). */
export const computePatch = (form: SettingsForm, draft: Draft): SettingsPatch => {
  const values: Record<string, SettingValue | null> = {}
  const secrets: Record<string, string | null> = {}
  for (const field of form.fields) {
    if (field.locked !== undefined) continue
    if (field.type === "secret") {
      if (field.key in draft.secrets) secrets[field.key] = draft.secrets[field.key]!
      continue
    }
    const next = draft.values[field.key]
    if (next !== undefined && !valueEqual(next, form.values[field.key])) values[field.key] = next
  }
  return { values, secrets }
}

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
 * draft follows silently; with edits they are kept and the form is marked stale.
 */
export const reconcile = (sync: FormSync, previous: SettingsForm, next: SettingsForm, revision: number): FormSync => {
  if (revision <= sync.baseRevision) return sync
  if (!isDirty(previous, sync.draft)) return { draft: initialDraft(next), baseRevision: revision, stale: false }
  return { ...sync, stale: true }
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
