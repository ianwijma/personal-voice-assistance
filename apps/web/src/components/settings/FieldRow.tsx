"use client"
import { useEffect, useRef, useState } from "react"
import type { ChoiceOption, SettingField, SettingsForm, SettingValue, VaultInfo } from "@pva/protocol"
import { type Draft, fieldDefault, hasOwnerValue, ownValue, resetDraftValue, setDraftValue, valueEqual } from "@/lib/forms.ts"
import type { FieldContext } from "@/components/fields/types.ts"
import { secretStatus } from "@/lib/vault.ts"
import { rendererFor } from "@/ui/fieldRenderers.ts"
import { useClient } from "../context.tsx"
import { Icon } from "../ui/Icon.tsx"
import { Button } from "../ui/controls.tsx"
import { DownloadControl } from "./DownloadControl.tsx"
import { FieldMarkers } from "./FormFooter.tsx"

export const RELOAD_NOTE = "Applies after reloading the engines (about 2 s; interrupts a reply)."

export const displayValue = (field: SettingField, value: SettingValue | undefined): string => {
  if (field.type === "secret") return ""
  if (value === undefined) return "—"
  if (field.type === "boolean") return value === true ? "On" : "Off"
  if (field.type === "choice") return field.options.find((o) => o.value === value)?.label ?? String(value)
  if (field.type === "multichoice" && Array.isArray(value)) {
    return value.map((v) => field.options.find((o) => o.value === v)?.label ?? v).join(", ") || "None"
  }
  if (field.type === "number") return `${String(value)}${field.unit ? ` ${field.unit}` : ""}`
  if (field.type === "action") return ""
  if (field.type === "records" && Array.isArray(value)) {
    return value.length === 0 ? "None" : `${value.length} ${field.itemLabel}${value.length === 1 ? "" : "s"}`
  }
  if (field.type === "textList" && Array.isArray(value)) return value.join(", ") || "None"
  return String(value) === "" ? "(empty)" : String(value)
}

/** The chosen options (of a choice or multichoice) whose model is not downloaded yet, with how to download it. */
export const optionsToDownload = (field: SettingField, value: SettingValue | undefined): ReadonlyArray<ChoiceOption & { readonly download: NonNullable<ChoiceOption["download"]> }> => {
  if (field.type !== "choice" && field.type !== "multichoice") return []
  const chosen = new Set(Array.isArray(value) ? value : [typeof value === "string" ? value : String(field.default)])
  return field.options.flatMap((o) =>
    chosen.has(o.value) && o.tags?.includes("not-downloaded") === true && o.download !== undefined ? [{ ...o, download: o.download }] : []
  )
}

/** The environment variable named by a lock ("Set by STT_SHERPA_AGC in /x/.env, line 3"). */
const lockedVariable = (field: SettingField): string | undefined =>
  field.type === "secret" && field.env !== undefined ? field.env : /^Set by (\S+) in /.exec(field.locked?.reason ?? "")?.[1]

export interface FieldRowProps {
  readonly field: SettingField
  readonly form: SettingsForm
  readonly draft: Draft
  readonly idPrefix: string
  readonly errors: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly readOnly: boolean
  readonly saving: boolean
  readonly vault: VaultInfo
  readonly setDraft: (f: (d: Draft) => Draft) => void
  readonly onLocalError: (message: string | undefined) => void
  /** The form around the field (its buttons need it). */
  readonly context?: FieldContext
}

/**
 * One generated field (docs/SETTINGS-UI.md §3.2, §3.5): label, a small reload marker (the footer says what it
 * means when such a field is changed), "Unsaved" for an edit and "Custom · Reset" for a saved non-default value, the field's renderer (or, when the environment sets it, the value read-only with a pin and where it comes
 * from), then errors, warnings and the description.
 */
export function FieldRow({ field, form, draft, idPrefix, errors, warnings, readOnly, saving, vault, setDraft, onLocalError, context }: FieldRowProps) {
  const id = `${idPrefix}-${field.key}`
  const describedBy = `${id}-desc`
  const Renderer = rendererFor(field)
  const resetPending = draft.reset?.includes(field.key) === true
  // Saved, and not what it would be by default: "Custom" (stays until a reset is saved).
  const custom = field.locked === undefined && field.type !== "secret" && hasOwnerValue(field) && field.source === "saved" && !resetPending &&
    !valueEqual(form.values[field.key], fieldDefault(field))
  const canReset = !readOnly && custom
  /** The default, in words (secrets have none). */
  const defaultText = field.type === "secret" ? "" : displayValue(field, fieldDefault(field))
  // Edited here and not saved yet (secrets show their own state).
  const unsaved = field.type !== "secret" && hasOwnerValue(field) && field.locked === undefined && (resetPending || (ownValue(draft.values, field.key) !== undefined && !valueEqual(ownValue(draft.values, field.key), ownValue(draft.base, field.key))))
  const secret = form.secrets[field.key]
  // A newly chosen model that is not downloaded: offer Download, and hold Save until it is there (§3.3).
  const toDownload = field.locked === undefined ? optionsToDownload(field, draft.values[field.key]) : []
  const saved = new Set(optionsToDownload(field, form.values[field.key]).map((o) => o.value))
  const blocking = toDownload.filter((o) => !saved.has(o.value)).map((o) => o.value).join(",")
  const report = useRef(onLocalError)
  report.current = onLocalError
  useEffect(() => {
    if (field.type !== "choice" && field.type !== "multichoice") return
    report.current(blocking === "" ? undefined : "Download this model first, or choose one that is downloaded.")
  }, [blocking])
  // A row that goes (hidden by `visibleWhen`, gone from a new form) takes its local error with it, whatever renderer
  // reported it.
  useEffect(() => () => report.current(undefined), [])
  return (
    <div className="flex flex-col gap-1.5" data-field={field.key} data-field-type={field.type} data-source={field.source}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <label htmlFor={id} className="text-[14px] font-medium text-ink">{field.label}</label>
        {field.apply === "reload" && (
          <span className="inline-flex self-center text-ink-faint" title={RELOAD_NOTE} data-testid="reload-marker">
            <Icon name="reload" size={12} />
            <span className="sr-only">(applies after an engine reload)</span>
          </span>
        )}
        <FieldMarkers
          unsaved={unsaved}
          {...(resetPending ? { unsavedTitle: `Goes back to the default (${defaultText}) when saved` } : {})}
          saved={custom ? "Custom" : undefined}
          savedTitle={`Saved from this screen; the default is ${defaultText}`}
          reset={canReset ? { label: `Reset ${field.label} to the default (${defaultText})`, onReset: () => setDraft((d) => resetDraftValue(d, field)) } : undefined}
        />
      </div>
      {field.locked !== undefined ? (
        <div id={id} className="flex items-start gap-2 rounded-md border border-line/70 bg-surface-2/40 px-3 py-2" data-testid="locked-value">
          <Icon name={field.source === "env-file" || field.source === "env-process" ? "pin" : "lock"} size={15} className="mt-0.5 shrink-0 text-ink-faint" />
          <div className="min-w-0 text-[14px]">
            {field.type !== "secret" && <div className="break-words font-mono text-[13px] text-ink">{displayValue(field, form.values[field.key])}</div>}
            <div className="text-[13px] text-ink-muted">
              {field.type === "secret" ? secretStatus(secret ?? { set: true, source: "env" }, vault, field.env, field.source) : field.locked.reason}
              {field.source === "env-process" ? " — exported by the shell or service that started the assistant." : ""}
            </div>
            {field.source === "env-file" && <MoveToSettings variable={lockedVariable(field)} readOnly={readOnly || !vault.admin} secret={field.type === "secret"} vaultLocked={vault.state === "locked"} />}
          </div>
        </div>
      ) : (
        <Renderer
          field={field}
          id={id}
          describedBy={describedBy}
          value={draft.values[field.key]}
          onChange={(value) => setDraft((d) => setDraftValue(d, field.key, value))}
          {...(secret !== undefined ? { secret } : {})}
          {...(field.key in draft.secrets ? { secretDraft: draft.secrets[field.key]! } : {})}
          onSecretChange={(value) =>
            setDraft((d) => {
              const { [field.key]: _old, ...rest } = d.secrets
              return { ...d, secrets: value === undefined || value === "" ? rest : { ...rest, [field.key]: value } }
            })}
          disabled={saving || readOnly}
          invalid={errors.length > 0}
          onLocalError={onLocalError}
          {...(context !== undefined ? { context } : {})}
        />
      )}
      {toDownload.map((o) => (
        <div key={o.value} className="flex flex-col gap-1.5 rounded-md border border-line/70 px-3 py-2.5" data-testid="inline-download" data-option={o.value}>
          <p className="text-[13px] text-ink">{o.label} is not downloaded yet.</p>
          <DownloadControl tool={o.download.tool} target={o.download.target} sizeMb={o.download.sizeMb} label={o.label} />
        </div>
      ))}
      <div id={describedBy} className="flex flex-col gap-0.5">
        {errors.map((m, i) => <p key={`e${i}`} role="alert" className="text-[13px] text-danger">{m}</p>)}
        {warnings.map((m, i) => <p key={`w${i}`} className="text-[13px] text-warn" data-testid="field-warning">{m}</p>)}
        {field.description !== undefined && <p className="text-[13px] text-ink-muted">{field.description}</p>}
      </div>
    </div>
  )
}

/** "Move to settings" on a field set by `.env` (docs/SETTINGS-UI.md §3.5): admin pages only. */
function MoveToSettings({ variable, readOnly, secret, vaultLocked }: {
  readonly variable: string | undefined
  readonly readOnly: boolean
  readonly secret: boolean
  readonly vaultLocked: boolean
}) {
  const client = useClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  if (variable === undefined) return null
  if (readOnly) return <p className="mt-1 text-[12px] text-ink-faint">Unlock the keys to move it into the settings.</p>
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || (secret && vaultLocked)}
          onClick={() => {
            setBusy(true)
            setError(undefined)
            void client.moveFromEnv([variable]).then((r) => {
              setBusy(false)
              if (!r.ok) setError(r.error?.message ?? "Could not move it.")
            })
          }}
          data-testid="move-to-settings"
        >
          Move to settings
        </Button>
        <span className="text-[12px] text-ink-faint">{secret ? (vaultLocked ? "Unlock the key vault first." : "The key goes into the vault; the line in .env is commented out.") : "The line in .env is commented out (a backup is kept)."}</span>
      </div>
      {error !== undefined && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
  )
}
