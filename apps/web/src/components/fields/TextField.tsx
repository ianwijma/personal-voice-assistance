"use client"
import type { SettingField } from "@pva/protocol"
import { type FieldProps, inputClass } from "./types.ts"

export function TextField({ field, id, describedBy, value, onChange, disabled, invalid }: FieldProps<Extract<SettingField, { type: "text" }>>) {
  const text = typeof value === "string" ? value : ""
  const max = field.maxLength ?? 500
  const near = text.length >= max * 0.8
  const common = {
    id,
    value: text,
    maxLength: max,
    disabled,
    placeholder: field.placeholder,
    "aria-describedby": describedBy,
    "aria-invalid": invalid,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value)
  }
  return (
    <div>
      {field.multiline ? (
        <textarea {...common} rows={5} className={`${inputClass} h-auto min-h-28 resize-y py-2 leading-relaxed`} />
      ) : (
        <input {...common} type="text" autoComplete="off" spellCheck={false} className={inputClass} />
      )}
      {near && <p className="mt-1 text-right font-mono text-[11px] text-ink-faint">{text.length} / {max}</p>}
    </div>
  )
}
