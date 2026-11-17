"use client"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { errorsFor } from "@/lib/assistants.ts"
import { inputClass } from "../../../fields/types.ts"
import { Icon, Spinner } from "../../../ui/Icon.tsx"
import { useDialog } from "../../../ui/Panel.tsx"
import { Button, cx, Segmented, Switch } from "../../../ui/controls.tsx"
import { Tags } from "../../../ui/Tags.tsx"
import { FieldMarkers } from "../../FormFooter.tsx"
import type { AssistantDraft } from "./useAssistantDraft.ts"

/** The building blocks of the assistant pages: a field with its marks, errors and help, and the controls it holds. */

export const idOfPath = (path: string) => `a-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`

/** One field: label, "Unsaved", the control, what choosing it implies, a warning, the server's errors, the help. */
export function AField({ label, path, draft, htmlFor, implication, warn, help, readOnly = false, children, resetTitle }: {
  readonly label: string
  readonly path: string
  readonly draft: AssistantDraft
  /** The id of the control the label names (a group of buttons has none). */
  readonly htmlFor?: string
  readonly implication?: ReactNode
  readonly warn?: ReactNode
  readonly help?: ReactNode
  readonly readOnly?: boolean
  readonly children: ReactNode
  readonly resetTitle?: string
}) {
  const errors = errorsFor(draft.errors, path)
  const local = draft.localErrors[path]
  const changed = draft.changed(path)
  const id = htmlFor ?? idOfPath(path)
  return (
    <div className="flex flex-col gap-1.5" data-field={path} data-changed={changed ? "true" : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {htmlFor !== undefined
          ? <label htmlFor={htmlFor} className="text-[14px] font-medium text-ink">{label}</label>
          : <span id={`${id}-label`} className="text-[14px] font-medium text-ink">{label}</span>}
        <FieldMarkers unsaved={changed && !readOnly} {...(resetTitle !== undefined ? { unsavedTitle: resetTitle } : {})} saved={undefined} reset={undefined} />
      </div>
      {children}
      {implication !== undefined && <p className="text-[13px] text-ink" data-testid="implication">{implication}</p>}
      {warn !== undefined && <p className="text-[13px] text-warn" data-testid="field-warning">{warn}</p>}
      {(errors.length > 0 || local !== undefined) && (
        <div className="flex flex-col gap-0.5">
          {errors.map((m, i) => <p key={i} role="alert" className="text-[13px] text-danger" data-testid="field-error">{m}</p>)}
          {local !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="field-error">{local}</p>}
        </div>
      )}
      {help !== undefined && <p className="text-[13px] text-ink-muted">{help}</p>}
    </div>
  )
}

/** A group of fields under a small heading ("Limits", "Turn timing"). */
export function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 border-t border-line/60 pt-5" aria-label={title}>
      <h3 className="label text-ink-faint">{title}</h3>
      {children}
    </section>
  )
}

export function TextControl({ draft, path, max, placeholder, label, multiline = false, rows = 2, disabled = false }: {
  readonly draft: AssistantDraft
  readonly path: string
  readonly max: number
  readonly placeholder?: string
  readonly label: string
  readonly multiline?: boolean
  readonly rows?: number
  readonly disabled?: boolean
}) {
  const value = String(readPath(draft, path) ?? "")
  const id = idOfPath(path)
  const invalid = errorsFor(draft.errors, path).length > 0
  const common = {
    id,
    "aria-label": label,
    "aria-invalid": invalid || undefined,
    maxLength: max,
    disabled,
    placeholder,
    value,
    autoComplete: "off",
    spellCheck: false
  }
  return multiline
    ? <textarea {...common} rows={rows} onChange={(e) => draft.set(path, e.target.value)} className={cx(inputClass, "h-auto min-h-16 py-2 leading-snug")} />
    : <input {...common} type="text" onChange={(e) => draft.set(path, e.target.value)} className={inputClass} />
}

const readPath = (draft: AssistantDraft, path: string): unknown =>
  path.split(".").reduce<unknown>((x, k) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), draft.current)

export const valueAt = (draft: AssistantDraft, path: string) => readPath(draft, path)

/**
 * A number with its unit. What is typed is kept as text until it is a whole number (or a number, for `integer: false`)
 * in range; until then the field says so and Save waits (the draft keeps the last good value).
 */
export function NumberControl({ draft, path, min, max, step, unit, integer = true, label, width = 128, disabled = false }: {
  readonly draft: AssistantDraft
  readonly path: string
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly unit?: string
  readonly integer?: boolean
  readonly label: string
  readonly width?: number
  readonly disabled?: boolean
}) {
  const value = readPath(draft, path) as number
  const [text, setText] = useState(String(value))
  useEffect(() => {
    // Follows the draft when it changes elsewhere (Cancel, Reset, Load latest), not while a typed value is pending.
    if (Number(text) !== value || text.trim() === "") setText(String(value))
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const local = draft.localErrors[path]
  useEffect(() => {
    // Cancel and Load latest clear the field's error without changing the value it never took: show that value again.
    if (local === undefined && (Number(text.replace(",", ".")) !== value || text.trim() === "")) setText(String(value))
  }, [local]) // eslint-disable-line react-hooks/exhaustive-deps
  const id = idOfPath(path)
  const invalid = draft.localErrors[path] !== undefined || errorsFor(draft.errors, path).length > 0
  const { setLocalError } = draft
  useEffect(() => () => setLocalError(path, undefined), [path]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={text}
        data-step={step}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          const n = Number(t.replace(",", "."))
          if (t.trim() === "" || Number.isNaN(n)) return draft.setLocalError(path, "Enter a number.")
          if (integer && !Number.isInteger(n)) return draft.setLocalError(path, "Enter a whole number.")
          if (n < min || n > max) return draft.setLocalError(path, `Between ${min} and ${max}${unit !== undefined ? ` ${unit}` : ""}.`)
          draft.setLocalError(path, undefined)
          draft.set(path, n)
        }}
        className={cx(inputClass, "text-right font-mono")}
        style={{ maxWidth: width }}
      />
      {unit !== undefined && <span className="text-[13px] text-ink-muted">{unit}</span>}
    </div>
  )
}

export function SelectControl({ draft, path, options, label, width, disabled = false, value: given }: {
  readonly draft: AssistantDraft
  readonly path: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly disabled?: boolean }>
  readonly label: string
  readonly width?: number
  readonly disabled?: boolean
  readonly value?: string
}) {
  const value = given ?? String(readPath(draft, path) ?? "")
  const known = options.some((o) => o.value === value)
  return (
    <select
      id={idOfPath(path)}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => draft.set(path, e.target.value)}
      className={cx(inputClass, "appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9")}
      style={{ ...(width !== undefined ? { maxWidth: width } : {}), backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M5 7.5l5 5 5-5'/%3E%3C/svg%3E\")" }}
    >
      {!known && <option value={value}>{value === "" ? "—" : value}</option>}
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  )
}

export function SegControl({ draft, path, options, label, disabled = false }: {
  readonly draft: AssistantDraft
  readonly path: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  readonly label: string
  readonly disabled?: boolean
}) {
  return (
    <div id={idOfPath(path)}>
      <Segmented name={idOfPath(path)} label={label} value={String(readPath(draft, path))} options={options} disabled={disabled} onChange={(v) => draft.set(path, v)} testId={`seg-${path}`} />
    </div>
  )
}

export function SwitchControl({ draft, path, label, onWords = "On", offWords = "Off" }: {
  readonly draft: AssistantDraft
  readonly path: string
  readonly label: string
  readonly onWords?: string
  readonly offWords?: string
}) {
  const on = readPath(draft, path) === true
  return (
    <div className="flex items-center gap-3">
      <Switch id={idOfPath(path)} checked={on} onChange={(v) => draft.set(path, v)} label={label} />
      <span className="text-[14px] text-ink">{on ? onWords : offWords}</span>
    </div>
  )
}

/** A select of presets with "Custom…" revealing a number (the follow-up and quiet-spell fields). */
export function PresetControl({ draft, path, presets, unit, min, max, customDefault, label }: {
  readonly draft: AssistantDraft
  readonly path: string
  readonly presets: ReadonlyArray<readonly [number | "never", string]>
  readonly unit: string
  readonly min: number
  readonly max: number
  readonly customDefault: number
  readonly label: string
}) {
  const value = readPath(draft, path) as number | "never"
  const listed = presets.some(([v]) => v === value)
  const [custom, setCustom] = useState(!listed)
  const showCustom = custom || !listed
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        id={idOfPath(path)}
        aria-label={label}
        value={showCustom ? "__custom" : String(value)}
        onChange={(e) => {
          if (e.target.value === "__custom") {
            setCustom(true)
            if (listed) draft.set(path, customDefault)
            return
          }
          setCustom(false)
          draft.setLocalError(path, undefined)
          draft.set(path, e.target.value === "never" ? "never" : Number(e.target.value))
        }}
        className={cx(inputClass, "max-w-[320px] appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9")}
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M5 7.5l5 5 5-5'/%3E%3C/svg%3E\")" }}
      >
        {presets.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
        <option value="__custom">Custom…</option>
      </select>
      {showCustom && typeof value === "number" && (
        <NumberControl draft={draft} path={path} min={min} max={max} unit={unit} label={`${label} in ${unit}`} width={112} />
      )}
    </div>
  )
}

/** Radio cards with chips (the account list). Each card says what it is and, on the right, how ready it is. */
export function RadioCards<V extends string>({ label, value, cards, onChange, groupId }: {
  readonly label: string
  readonly value: V
  readonly groupId: string
  readonly cards: ReadonlyArray<{
    readonly value: V
    readonly title: string
    readonly tags: React.ComponentProps<typeof Tags>["tags"]
    readonly description: string
    readonly right?: ReactNode
  }>
  readonly onChange: (v: V) => void
}) {
  return (
    <div id={groupId} role="radiogroup" aria-label={label} className="flex flex-col gap-1.5" data-testid="radio-cards">
      {cards.map((c) => {
        const checked = c.value === value
        return (
          <div
            key={c.value}
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-value={c.value}
            onClick={() => onChange(c.value)}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault()
                return onChange(c.value)
              }
              if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return
              e.preventDefault()
              const i = cards.findIndex((x) => x.value === value)
              const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : cards.length - 1
              onChange(cards[(i + step) % cards.length]!.value)
              const group = e.currentTarget.parentElement
              requestAnimationFrame(() => group?.querySelector<HTMLElement>("[aria-checked=true]")?.focus())
            }}
            className={cx(
              "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-[120ms]",
              checked ? "border-ink-muted bg-surface-2/70 shadow-[inset_0_0_0_1px_var(--color-ink-muted)]" : "border-line hover:border-ink-faint/50"
            )}
          >
            <span aria-hidden="true" className={cx("mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-you" : "border-ink-faint")}>
              {checked && <span className="size-2 rounded-full bg-you" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[14px] text-ink">{c.title}</span>
                <Tags tags={c.tags} />
              </span>
              <span className="mt-0.5 block text-[13px] text-ink-muted">{c.description}</span>
            </span>
            {c.right !== undefined && <span className="shrink-0 text-[12px] text-ink-muted">{c.right}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** A closed-by-default section ("See the full prompt"). */
export function Disclosure({ title, children, testId }: { readonly title: string; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-3" data-testid={testId}>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[14px] text-ink-muted marker:hidden hover:text-ink">
        <Icon name="chevron" size={14} className="transition-transform duration-[120ms] group-open:rotate-90" />
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

/** "On" / "Off" chip next to a name. */
export function StateChip({ on }: { readonly on: boolean }) {
  return (
    <span
      className={cx("label rounded-sm border px-1 text-[10px] leading-[16px]", on ? "border-ok/50 text-ok" : "border-line text-ink-faint")}
      data-testid="state-chip"
    >
      {on ? "On" : "Off"}
    </span>
  )
}

/** The mono summary strip (model | hearing | voice | modules), the same on the list, the page and Diagnostics. */
export function Strip({ parts, className }: { readonly parts: ReadonlyArray<string>; readonly className?: string }) {
  return (
    <p className={cx("flex flex-wrap font-mono text-[12px] leading-5 text-ink-muted", className)} data-testid="assistant-strip">
      {parts.map((p, i) => (
        <span key={i} className={cx("whitespace-nowrap pr-2", i < parts.length - 1 && "mr-2 border-r border-line")}>{p}</span>
      ))}
    </p>
  )
}

/** A modal dialog on the page's pattern: focus in, Esc and Tab handled, a scrim, a bottom sheet on a phone. */
export function Dialog({ title, children, onClose, testId, labelId, wide = false }: {
  readonly title: string
  readonly children: ReactNode
  readonly onClose: () => void
  readonly testId: string
  readonly labelId?: string
  readonly wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const generated = useId()
  const titleId = labelId ?? `dlg-${generated}`
  useDialog(ref, true, onClose, "[data-cancel]", { inertBackground: true })
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-bg/70 p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center" data-testid={testId}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} className={cx("w-full rounded-lg border border-line bg-surface p-5 shadow-panel", wide ? "max-w-[460px]" : "max-w-[400px]")}>
        <h2 id={titleId} className="text-[16px] font-medium text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function DialogButtons({ cancel, confirm, busy, variant = "primary", onCancel, onConfirm, disabled = false }: {
  readonly cancel: string
  readonly confirm: string
  readonly busy: boolean
  readonly variant?: "primary" | "danger"
  readonly onCancel: () => void
  readonly onConfirm: () => void
  readonly disabled?: boolean
}) {
  return (
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <Button size="md" variant="quiet" className="max-sm:h-11" onClick={onCancel} data-cancel="" disabled={busy}>{cancel}</Button>
      <Button size="md" variant={variant} className="max-sm:h-11" disabled={busy || disabled} onClick={onConfirm} data-testid="dialog-confirm">
        {busy && <Spinner size={12} />}
        {confirm}
      </Button>
    </div>
  )
}
