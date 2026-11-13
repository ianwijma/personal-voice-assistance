"use client"
import type { SettingField } from "@pva/protocol"
import { Segmented } from "../ui/controls.tsx"
import { type FieldProps, inputClass } from "./types.ts"

/** A segmented control for up to 4 options, a select beyond; the selected option's description below. */
export function ChoiceField({ field, id, describedBy, value, onChange, disabled, invalid }: FieldProps<Extract<SettingField, { type: "choice" }>>) {
  const current = typeof value === "string" ? value : field.default
  const selected = field.options.find((o) => o.value === current)
  return (
    <div>
      {field.options.length <= 4 ? (
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
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {selected?.description !== undefined && <p className="mt-1.5 text-[13px] text-ink-muted">{selected.description}</p>}
    </div>
  )
}
