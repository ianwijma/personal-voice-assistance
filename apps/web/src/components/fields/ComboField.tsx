"use client"
import { useEffect, useRef } from "react"
import type { SettingField } from "@pva/protocol"
import { type FieldProps, inputClass } from "./types.ts"

/**
 * Free text with suggestions (protocol 10, `combo`): an input with the server's options as a list to pick from (the
 * running module's own ones included), and where they came from (`optionsNote`). Without `allowCustom` only an
 * option is accepted.
 */
export function ComboField({ field, id, describedBy, value, onChange, disabled, invalid, onLocalError }: FieldProps<Extract<SettingField, { type: "combo" }>>) {
  const text = typeof value === "string" ? value : field.default
  const listId = `${id}-options`
  const known = field.options.some((o) => o.value === text.trim())
  const refused = !field.allowCustom && !known
  const report = useRef(onLocalError)
  report.current = onLocalError
  useEffect(() => {
    report.current(refused ? "Choose one of the suggestions." : text.trim() === "" ? "Enter a value." : undefined)
  }, [refused, text])
  // Hidden (`visibleWhen`) or removed: its error goes with it.
  useEffect(() => () => report.current(undefined), [])
  const selected = field.options.find((o) => o.value === text.trim())
  return (
    <div className="flex flex-col gap-1">
      <input
        id={id}
        type="text"
        list={listId}
        value={text}
        maxLength={field.maxLength ?? 200}
        disabled={disabled}
        placeholder={field.placeholder}
        aria-describedby={describedBy}
        aria-invalid={invalid || refused}
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </datalist>
      {selected !== undefined && selected.label !== selected.value && <p className="text-[13px] text-ink-muted">{selected.label}</p>}
      {field.optionsNote !== undefined && <p className="text-[12px] text-ink-faint" data-testid="options-note">{field.optionsNote}</p>}
    </div>
  )
}
