"use client"
import type { ReactNode } from "react"
import { Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"
import { useKeyboardInset } from "../useKeyboardInset.ts"

/**
 * The one sticky footer of every admin form page (server settings and device profiles look and behave the same):
 * Save / Cancel (40 px, 44 px on a phone), an optional extra action, a note ("Unsaved changes", "Saved", the reload
 * note), a form error, and the warnings of a save. While warnings are shown it offers only "Save anyway" and "Go back".
 */
export function FormFooter({ dirty, saving, saveDisabled, onSave, onCancel, cancelDisabled, hideSave = false, extra, note, noteTone = "muted", error, warnings = [], onSaveAnyway, onBack }: {
  readonly dirty: boolean
  readonly saving: boolean
  readonly saveDisabled: boolean
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly cancelDisabled: boolean
  /** No Save button (the page has another, single way to commit). */
  readonly hideSave?: boolean
  readonly extra?: ReactNode
  readonly note: string
  readonly noteTone?: "ok" | "muted"
  readonly error?: string
  readonly warnings?: ReadonlyArray<string>
  readonly onSaveAnyway?: () => void
  readonly onBack?: () => void
}) {
  const inset = useKeyboardInset()
  const warning = warnings.length > 0 && onSaveAnyway !== undefined
  return (
    <div
      className="sticky bottom-0 z-10 -mx-5 mt-auto border-t border-line bg-surface/95 px-5 pt-3 backdrop-blur-sm sm:-mx-8 sm:px-8"
      style={{ bottom: inset, paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
      data-testid="page-footer"
    >
      {error !== undefined && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
      {warning ? (
        <div className="flex flex-col gap-2.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-2.5" role="alert" data-testid="save-warnings">
          {warnings.map((w, i) => <p key={i} className="text-[13px] text-ink">{w}</p>)}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" className="max-sm:h-11" onClick={onSaveAnyway} disabled={saving}>
              {saving && <Spinner size={12} />}
              Save anyway
            </Button>
            <Button className="max-sm:h-11" onClick={onBack} disabled={saving}>Go back</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {!hideSave && (
            <Button variant={dirty ? "primary" : "default"} className="max-sm:h-11" disabled={saveDisabled} onClick={onSave}>
              {saving && <Spinner size={13} />}
              Save
            </Button>
          )}
          {!hideSave && extra}
          <Button variant="quiet" className="max-sm:h-11" disabled={cancelDisabled} onClick={onCancel}>Cancel</Button>
          <span className={cx("text-[12px]", noteTone === "ok" ? "text-ok" : "text-ink-muted")} aria-live="polite" data-testid="footer-note">
            {note}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * A field's two markers, the same on every admin form, never shown for the same reason:
 * - **Unsaved** (amber): the draft differs from what is saved; it goes away on Save (or Cancel).
 * - **Custom** (server settings, front-end defaults) / **Override** (a device page): what is *saved* differs from what
 *   the field would inherit (its default, or the kind's default for a device). An outlined chip, not amber.
 * Reset (44 px hit area on a phone) says in its accessible name and tooltip what it returns to.
 */
export function FieldMarkers({ unsaved, unsavedTitle, saved, savedTitle, savedNote, reset }: {
  readonly unsaved: boolean
  readonly unsavedTitle?: string
  readonly saved?: "Custom" | "Override" | undefined
  readonly savedTitle?: string
  /** Extra words for assistive technology after the marker ("same as the default now"). */
  readonly savedNote?: string | undefined
  readonly reset?: { readonly label: string; readonly onReset: () => void; readonly disabled?: boolean } | undefined
}) {
  if (!unsaved && saved === undefined && reset === undefined) return null
  return (
    <span className="ml-auto inline-flex items-center gap-2" data-testid="field-markers">
      {unsaved && (
        <span className="label text-[11px] text-voice" title={unsavedTitle ?? "Changed here, not saved yet"} data-testid="unsaved-marker">Unsaved</span>
      )}
      {saved !== undefined && (
        <span className="label rounded-sm border border-ink-faint px-1 text-[11px] leading-[14px] text-ink-muted" title={savedTitle} data-testid="custom-marker">
          {saved}
          {savedNote !== undefined && <span className="sr-only"> ({savedNote})</span>}
        </span>
      )}
      {reset !== undefined && (
        <button
          type="button"
          className="relative inline-flex min-h-8 items-center text-[12px] text-voice underline-offset-4 hover:underline disabled:opacity-50 max-sm:before:absolute max-sm:before:-inset-x-2 max-sm:before:-inset-y-1.5 max-sm:before:content-['']"
          onClick={reset.onReset}
          disabled={reset.disabled}
          aria-label={reset.label}
          title={reset.label}
          data-testid="reset"
        >
          Reset
        </button>
      )}
    </span>
  )
}

/**
 * One visible line saying what Custom / Override and Reset mean (the tooltips are not there on touch). Shown on the
 * pages that can show those marks, right under the page's intro.
 */
export function MarkerLegend({ device }: { readonly device: boolean }) {
  return (
    <p className="text-[13px] text-ink-muted" data-testid="marker-legend">
      {device
        ? "Override: set for this device only. Reset returns to the front-end default."
        : "Custom: differs from the built-in default. Reset returns to it."}
    </p>
  )
}
