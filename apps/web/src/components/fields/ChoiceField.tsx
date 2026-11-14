"use client"
import type { SettingField } from "@pva/protocol"
import { cx, Segmented } from "../ui/controls.tsx"
import { Tags } from "../ui/Tags.tsx"
import { type FieldProps, inputClass } from "./types.ts"

/**
 * A choice. Options that carry tags (up to four) are a list of radio rows, each with its chips
 * ("Hosted", "Needs key"), so the implications are visible before choosing; plain options are a segmented control
 * (up to four) or a select. The selected option's description and implication line are shown below.
 */
export function ChoiceField({ field, id, describedBy, value, onChange, disabled, invalid }: FieldProps<Extract<SettingField, { type: "choice" }>>) {
  const current = typeof value === "string" ? value : field.default
  const selected = field.options.find((o) => o.value === current)
  const rich = field.options.length <= 4 && field.options.some((o) => (o.tags?.length ?? 0) > 0)
  return (
    <div>
      {rich ? (
        <div id={id} role="radiogroup" aria-label={field.label} aria-describedby={describedBy} className="flex flex-col gap-1.5">
          {field.options.map((o) => {
            const checked = o.value === current
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={disabled}
                tabIndex={checked ? 0 : -1}
                onClick={() => onChange(o.value)}
                onKeyDown={(e) => {
                  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return
                  e.preventDefault()
                  const i = field.options.findIndex((x) => x.value === current)
                  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : field.options.length - 1
                  onChange(field.options[(i + step) % field.options.length]!.value)
                  const group = e.currentTarget.parentElement
                  requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus())
                }}
                className={cx(
                  "flex min-h-11 w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-[120ms]",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  checked ? "border-ink-muted bg-surface-2/70 shadow-[inset_0_0_0_1px_var(--color-ink-muted)]" : "border-line hover:border-ink-faint/50"
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx("mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-you" : "border-ink-faint")}
                >
                  {checked && <span className="size-2 rounded-full bg-you" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[14px] text-ink">{o.label}</span>
                    <Tags tags={o.tags} />
                  </span>
                  {o.description !== undefined && <span className="mt-0.5 block text-[13px] text-ink-muted">{o.description}</span>}
                </span>
              </button>
            )
          })}
        </div>
      ) : field.options.length <= 4 ? (
        <div id={id} aria-describedby={describedBy}>
          <Segmented name={id} label={field.label} value={current} disabled={disabled} options={field.options.map((o) => ({ value: o.value, label: o.label }))} onChange={onChange} />
        </div>
      ) : (
        <select
          id={id}
          value={current}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9`}
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M5 7.5l5 5 5-5'/%3E%3C/svg%3E\")" }}
        >
          {selected === undefined && <option value={current}>{current}</option>}
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}{o.tags?.includes("not-downloaded") === true ? " (not downloaded)" : ""}
            </option>
          ))}
        </select>
      )}
      {!rich && selected?.tags !== undefined && <Tags tags={selected.tags} className="mt-2" />}
      {!rich && selected?.description !== undefined && <p className="mt-1.5 text-[13px] text-ink-muted">{selected.description}</p>}
      {selected?.implication !== undefined && (
        <p className="mt-1.5 text-[13px] text-ink" data-testid="implication">{selected.implication}</p>
      )}
    </div>
  )
}
