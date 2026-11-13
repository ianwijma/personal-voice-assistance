"use client"
import { useEffect, useState } from "react"
import type { SettingField } from "@pva/protocol"
import { parseNumber } from "@/lib/forms.ts"
import { type FieldProps, inputClass } from "./types.ts"

export function NumberField({ field, id, describedBy, value, onChange, disabled, invalid, onLocalError }: FieldProps<Extract<SettingField, { type: "number" }>>) {
  const num = typeof value === "number" ? value : field.default
  const [text, setText] = useState(String(num))
  useEffect(() => {
    // Follow external changes (cancel, another tab) unless the text already means this number.
    setText((t) => (Number(t) === num && t.trim() !== "" ? t : String(num)))
  }, [num])
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        inputMode={field.integer ? "numeric" : "decimal"}
        min={field.min}
        max={field.max}
        step={field.step ?? (field.integer ? 1 : "any")}
        value={text}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        onChange={(e) => {
          setText(e.target.value)
          const parsed = parseNumber(e.target.value, field)
          if ("value" in parsed) {
            onLocalError(undefined)
            onChange(parsed.value)
          } else {
            onLocalError(parsed.error)
          }
        }}
        className={`${inputClass} max-w-40 font-mono tabular-nums`}
      />
      {field.unit !== undefined && <span className="font-mono text-[13px] text-ink-muted">{field.unit}</span>}
    </div>
  )
}
