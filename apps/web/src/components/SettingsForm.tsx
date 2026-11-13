"use client"
import { type ComponentType, useEffect, useRef, useState } from "react"
import type { FieldError, SettingField, SettingsForm as Form, SettingsPatch, SettingValue } from "@pva/protocol"
import type { ResultMessage } from "@/lib/connection.ts"
import { computePatch, type Draft, errorsByKey, type FormSync, initialDraft, isEmptyPatch, reconcile, splitAdvanced } from "@/lib/forms.ts"
import { fieldRenderers } from "@/ui/fieldRenderers.ts"
import type { FieldProps } from "./fields/types.ts"
import { Icon, Spinner } from "./ui/Icon.tsx"
import { Button, cx } from "./ui/controls.tsx"

const RELOAD_NOTE = "Applies after reloading the engines (about 2 s; interrupts a reply)."

const displayValue = (field: SettingField, value: SettingValue | undefined): string => {
  if (field.type === "secret") return ""
  if (value === undefined) return "—"
  if (field.type === "boolean") return value === true ? "On" : "Off"
  if (field.type === "choice") return field.options.find((o) => o.value === value)?.label ?? String(value)
  if (field.type === "multichoice" && Array.isArray(value)) {
    return value.map((v) => field.options.find((o) => o.value === v)?.label ?? v).join(", ") || "None"
  }
  if (field.type === "number") return `${String(value)}${field.unit ? ` ${field.unit}` : ""}`
  return String(value) === "" ? "(empty)" : String(value)
}

/**
 * A form generated from a `SettingsForm` description: one renderer per field
 * type (`fieldRenderers`), errors from the server under their fields, Save
 * sends only the changed fields.
 */
export function SettingsForm({
  form,
  revision,
  idPrefix,
  onSave,
  saveLabel = "Save"
}: {
  readonly form: Form
  readonly revision: number
  readonly idPrefix: string
  readonly onSave: (patch: SettingsPatch) => Promise<ResultMessage>
  readonly saveLabel?: string
}) {
  const [sync, setSync] = useState<FormSync>(() => ({ draft: initialDraft(form), baseRevision: revision, stale: false }))
  const [serverErrors, setServerErrors] = useState<ReadonlyArray<FieldError>>([])
  const [formMessage, setFormMessage] = useState<string | undefined>()
  const [localErrors, setLocalErrors] = useState<Readonly<Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const previous = useRef({ form, revision })

  useEffect(() => {
    const prev = previous.current
    if (revision === prev.revision && form === prev.form) return
    previous.current = { form, revision }
    if (saving) return // our own save: settled when the result arrives
    setSync((s) => reconcile(s, prev.form, form, revision))
  }, [form, revision, saving])

  const patch = computePatch(form, sync.draft)
  const dirty = !isEmptyPatch(patch)
  const hasLocalErrors = Object.keys(localErrors).length > 0
  const errors = errorsByKey([...form.errors, ...serverErrors])

  const setDraft = (f: (d: Draft) => Draft) => {
    setSaved(false)
    setSync((s) => ({ ...s, draft: f(s.draft) }))
  }

  const save = async () => {
    if (!dirty || hasLocalErrors) return
    setSaving(true)
    setFormMessage(undefined)
    setServerErrors([])
    const result = await onSave(patch) // continuation(state): the saved form is read from `previous.current` when the answer comes
    setSaving(false)
    if (result.ok) {
      // The broadcast (module.changed / section.changed) brings the saved values.
      setSync({ draft: initialDraft(previous.current.form), baseRevision: previous.current.revision, stale: false })
      setSaved(true)
      return
    }
    const fieldErrors = result.error?.fieldErrors ?? []
    setServerErrors(fieldErrors)
    if (fieldErrors.length === 0 || result.error?.code !== "invalid_settings") setFormMessage(result.error?.message ?? "The settings were not saved.")
  }

  const cancel = () => {
    setSync({ draft: initialDraft(form), baseRevision: revision, stale: false })
    setServerErrors([])
    setFormMessage(undefined)
    setLocalErrors({})
  }

  const { basic, advanced } = splitAdvanced(form.fields)
  const renderField = (field: SettingField) => {
    const id = `${idPrefix}-${field.key}`
    const fieldErrors = [...(errors.get(field.key) ?? []), ...(localErrors[field.key] !== undefined ? [localErrors[field.key]!] : [])]
    const Renderer = fieldRenderers[field.type] as ComponentType<FieldProps>
    const describedBy = `${id}-desc`
    return (
      <div key={field.key} className="flex flex-col gap-1.5" data-field={field.key} data-field-type={field.type}>
        <div className="flex items-baseline gap-2">
          <label htmlFor={id} className="text-[14px] font-medium text-ink">{field.label}</label>
          {field.apply === "reload" && <span className="label text-[10px] text-ink-faint" title={RELOAD_NOTE}>Reload</span>}
        </div>
        {field.locked !== undefined ? (
          <div id={id} className="flex items-start gap-2 rounded-md border border-line/70 bg-surface-2/40 px-3 py-2">
            <Icon name="lock" size={15} className="mt-0.5 shrink-0 text-ink-faint" />
            <div className="min-w-0 text-[14px]">
              {field.type !== "secret" && <div className="break-words font-mono text-[13px] text-ink">{displayValue(field, form.values[field.key])}</div>}
              <div className="text-[13px] text-ink-muted">{field.locked.reason}</div>
            </div>
          </div>
        ) : (
          <Renderer
            field={field}
            id={id}
            describedBy={describedBy}
            value={sync.draft.values[field.key]}
            onChange={(value) => setDraft((d) => ({ ...d, values: { ...d.values, [field.key]: value } }))}
            {...(form.secrets[field.key] !== undefined ? { secret: form.secrets[field.key]! } : {})}
            {...(field.key in sync.draft.secrets ? { secretDraft: sync.draft.secrets[field.key]! } : {})}
            onSecretChange={(value) =>
              setDraft((d) => {
                const { [field.key]: _old, ...rest } = d.secrets
                return { ...d, secrets: value === undefined || value === "" ? rest : { ...rest, [field.key]: value } }
              })}
            disabled={saving}
            invalid={fieldErrors.length > 0}
            onLocalError={(message) =>
              setLocalErrors((e) => {
                const { [field.key]: _old, ...rest } = e
                return message === undefined ? rest : { ...rest, [field.key]: message }
              })}
          />
        )}
        <div id={describedBy} className="flex flex-col gap-0.5">
          {fieldErrors.map((m, i) => <p key={i} role="alert" className="text-[13px] text-danger">{m}</p>)}
          {field.description !== undefined && <p className="text-[13px] text-ink-muted">{field.description}</p>}
          {field.apply === "reload" && field.locked === undefined && <p className="text-[12px] text-ink-faint">{RELOAD_NOTE}</p>}
        </div>
      </div>
    )
  }

  const formErrors = errors.get(null) ?? []
  return (
    <form
      className="flex flex-col gap-5"
      data-testid={`form-${idPrefix}`}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {sync.stale && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-muted">
          Changed in another tab
          <button type="button" className="ml-auto text-voice hover:underline" onClick={cancel}>Load latest</button>
        </div>
      )}
      {(formMessage !== undefined || formErrors.length > 0) && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-ink">
          {formMessage !== undefined && <p>{formMessage}</p>}
          {formErrors.map((m, i) => <p key={i}>{m}</p>)}
        </div>
      )}
      {basic.map(renderField)}
      {advanced.length > 0 && (
        <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-4">
          <summary className="label flex cursor-pointer list-none items-center gap-1.5 text-ink-muted marker:hidden hover:text-ink">
            <Icon name="chevron" size={14} className="transition-transform duration-[120ms] group-open:rotate-90" />
            Advanced
          </summary>
          <div className="mt-4 flex flex-col gap-5">{advanced.map(renderField)}</div>
        </details>
      )}
      {form.fields.some((f) => f.locked === undefined) && (
        <div className="flex items-center gap-2">
          <Button type="submit" variant={dirty ? "primary" : "default"} size="sm" disabled={!dirty || saving || hasLocalErrors}>
            {saving && <Spinner size={13} />}
            {saveLabel}
          </Button>
          <Button size="sm" variant="quiet" disabled={!dirty || saving} onClick={cancel}>Cancel</Button>
          <span className={cx("ml-1 text-[12px] text-ok transition-opacity duration-[240ms]", saved && !dirty ? "opacity-100" : "opacity-0")} aria-live="polite">
            {saved && !dirty ? "Saved" : ""}
          </span>
        </div>
      )}
    </form>
  )
}
