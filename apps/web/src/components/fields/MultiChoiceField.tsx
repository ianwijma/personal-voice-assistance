"use client"
import type { SettingField } from "@pva/protocol"
import { Icon } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

export function MultiChoiceField({ field, id, describedBy, value, onChange, disabled }: FieldProps<Extract<SettingField, { type: "multichoice" }>>) {
  const current = Array.isArray(value) ? value : field.default
  const toggle = (v: string) => {
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v]
    // Keep the options' order, so the patch is stable.
    onChange(field.options.map((o) => o.value).filter((x) => next.includes(x)).concat(next.filter((x) => !field.options.some((o) => o.value === x))))
  }
  return (
    <fieldset id={id} aria-describedby={describedBy} className="flex flex-col gap-1">
      <legend className="sr-only">{field.label}</legend>
      {field.options.map((o) => {
        const checked = current.includes(o.value)
        return (
          <label key={o.value} className={cx("flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 hover:bg-surface-2/50", disabled && "cursor-not-allowed opacity-60")}>
            <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={() => toggle(o.value)} />
            <span
              aria-hidden="true"
              className={cx(
                "mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-[120ms] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-you",
                checked ? "border-you bg-you-soft text-you" : "border-ink-faint bg-surface-2"
              )}
            >
              {checked && <Icon name="check" size={13} />}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] text-ink">{o.label}</span>
              {o.description !== undefined && <span className="block text-[13px] text-ink-muted">{o.description}</span>}
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}
