"use client"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import type { Assistant } from "@pva/protocol"
import type { AssistantDraft } from "../assistants/useAssistantDraft.ts"
import { cx, Switch } from "../../../ui/controls.tsx"

/** The building blocks of the device and defaults pages: sections with their Own value · Reset marks, fields, callouts. */

/**
 * A single value as an `AssistantDraft`, so the assistant pages' number and preset controls (`NumberControl`,
 * `PresetControl`) work on one value of the device page. `blocked` reports a number that cannot be saved yet.
 */
export const useValueDraft = (path: string, value: unknown, onChange: (v: unknown) => void, onBlocked: (id: string, blocked: boolean) => void): AssistantDraft => {
  const [localErrors, setLocal] = useState<Readonly<Record<string, string>>>({})
  const blocked = Object.keys(localErrors).length > 0
  useEffect(() => onBlocked(path, blocked), [path, blocked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onBlocked(path, false), [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = useMemo(() => ({ [path]: value }) as unknown as Assistant, [path, value])
  return useMemo(
    () => ({
      current,
      epoch: 0,
      saved: current,
      dirty: false,
      saving: false,
      justSaved: false,
      behind: false,
      errors: [],
      localErrors,
      warnings: [],
      message: undefined,
      changed: () => false,
      tabChanged: () => false,
      tabErrors: () => false,
      set: (_p: string, v: unknown) => onChange(v),
      update: () => undefined,
      reset: () => undefined,
      setLocalError: (p: string, m: string | undefined) =>
        setLocal((s) => {
          if (s[p] === m) return s
          const { [p]: _old, ...rest } = s
          return m === undefined ? rest : { ...rest, [p]: m }
        }),
      save: () => Promise.resolve({ kind: "refused" as const, code: "internal", message: "Not a draft of its own." }),
      cancel: () => undefined,
      dismissWarnings: () => undefined
    }),
    [current, localErrors, onChange]
  )
}

/** A field with its label, control, help and an optional error. `markers` sit at the right of the label line. */
export function DField({ label, htmlFor, help, error, markers, children, testId }: {
  readonly label?: string
  readonly htmlFor?: string
  readonly help?: ReactNode
  readonly error?: ReactNode
  readonly markers?: ReactNode
  readonly children: ReactNode
  readonly testId?: string
}) {
  return (
    <div className="flex flex-col gap-1.5" data-field={testId}>
      {(label !== undefined || markers !== undefined) && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {label !== undefined && (htmlFor !== undefined
            ? <label htmlFor={htmlFor} className="text-[14px] font-medium text-ink">{label}</label>
            : <span className="text-[14px] font-medium text-ink">{label}</span>)}
          {markers}
        </div>
      )}
      {children}
      {error !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="field-error">{error}</p>}
      {help !== undefined && <p className="text-[13px] text-ink-muted">{help}</p>}
    </div>
  )
}

/** "Unsaved", then "Own value · Reset" or "Follows Every browser": the marks of one section. */
export function SectionMarks({ id, unsaved, own, follows, isType, onReset, resetTitle }: {
  readonly id: string
  readonly unsaved: boolean
  readonly own: boolean
  readonly follows: string
  readonly isType: boolean
  readonly onReset: () => void
  readonly resetTitle: string
}) {
  return (
    <span className="ml-auto inline-flex items-center gap-2" data-testid={`marks-${id}`} data-own={isType ? undefined : own ? "true" : "false"}>
      {unsaved && <span className="label text-[11px] text-voice" data-testid="unsaved-marker">Unsaved</span>}
      {!isType && own && (
        <>
          <span className="label rounded-sm border border-ink-faint px-1 text-[11px] leading-[14px] text-ink-muted" data-testid="own-marker">Own value</span>
          <button
            type="button"
            className="relative inline-flex min-h-8 items-center text-[12px] text-voice underline-offset-4 hover:underline max-sm:before:absolute max-sm:before:-inset-x-2 max-sm:before:-inset-y-1.5 max-sm:before:content-['']"
            onClick={onReset}
            title={resetTitle}
            aria-label={`Reset ${id} to ${follows}`}
            data-testid="reset"
          >
            Reset
          </button>
        </>
      )}
      {!isType && !own && <span className="text-[12px] text-ink-faint" data-testid="follows-marker">Follows {follows}</span>}
    </span>
  )
}

export function Callout({ tone = "neutral", children, testId }: { readonly tone?: "neutral" | "warn"; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <div
      className={cx("flex flex-col gap-1 rounded-md border px-3 py-2 text-[13px]", tone === "warn" ? "border-warn/40 bg-warn/5 text-ink" : "border-line bg-surface-2/40 text-ink-muted")}
      data-testid={testId}
    >
      {children}
    </div>
  )
}

/** The small chip: "Defaults", "Own value", "Talking now" (outlined, mono caps). */
export function Chip({ children, tone = "plain", testId }: { readonly children: ReactNode; readonly tone?: "plain" | "you" | "warn"; readonly testId?: string }) {
  return (
    <span
      className={cx(
        "label rounded-sm border px-1 text-[9px] leading-[14px]",
        tone === "you" ? "border-you/50 text-you" : tone === "warn" ? "border-warn/50 text-warn" : "border-ink-faint text-ink-muted"
      )}
      data-testid={testId}
    >
      {children}
    </span>
  )
}

/** A pill: a phrase, or "Jeff · without a phrase". */
export function Pill({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <span className={cx("inline-flex items-center rounded-full border border-line bg-surface-2/50 px-2 py-0.5 text-[12px] text-ink-muted", className)}>{children}</span>
}

/** A switch with "On" / "Off" beside it. */
export function Toggle({ label, checked, onChange, disabled = false }: { readonly label: string; readonly checked: boolean; readonly onChange: (v: boolean) => void; readonly disabled?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <span className="text-[14px] text-ink">{checked ? "On" : "Off"}</span>
    </div>
  )
}
