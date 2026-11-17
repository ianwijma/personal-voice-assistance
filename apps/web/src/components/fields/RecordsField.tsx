"use client"
import { type ComponentType, useState } from "react"
import type { RecordItemField, RecordValue, SettingField, SettingValue } from "@pva/protocol"
import { Icon } from "../ui/Icon.tsx"
import { Button, cx, IconButton } from "../ui/controls.tsx"
import { BooleanField } from "./BooleanField.tsx"
import { ChoiceField } from "./ChoiceField.tsx"
import { MultiChoiceField } from "./MultiChoiceField.tsx"
import { NumberField } from "./NumberField.tsx"
import { TextField } from "./TextField.tsx"
import { TextListField } from "./TextListField.tsx"
import type { FieldProps } from "./types.ts"

/** An item field as a field of its own (the renderers take a `SettingField`). */
const asField = (f: RecordItemField): SettingField => ({ ...f, apply: "live" }) as SettingField

const itemRenderers: { readonly [T in RecordItemField["type"]]: ComponentType<FieldProps> } = {
  text: TextField as ComponentType<FieldProps>,
  number: NumberField as ComponentType<FieldProps>,
  boolean: BooleanField as ComponentType<FieldProps>,
  choice: ChoiceField as ComponentType<FieldProps>,
  multichoice: MultiChoiceField as ComponentType<FieldProps>,
  textList: TextListField as ComponentType<FieldProps>
}

/** A new record: every item field's default. */
export const newRecord = (fields: ReadonlyArray<RecordItemField>): RecordValue =>
  Object.fromEntries(fields.map((f) => [f.key, f.default as RecordValue[string]]))

/** How an item value reads in a collapsed row. */
const shown = (f: RecordItemField, v: RecordValue[string] | undefined): string => {
  if (v === undefined) return ""
  if (f.type === "boolean") return v === true ? `${f.label}: on` : ""
  if (f.type === "choice") return f.options.find((o) => o.value === v)?.label ?? String(v)
  if (Array.isArray(v)) return v.map((x) => (f.type === "multichoice" ? f.options.find((o) => o.value === x)?.label ?? x : x)).join(", ")
  return String(v)
}

/**
 * An ordered list of flat records (protocol 10, `records`: rooms, lamps, members). Each record is a row titled by
 * its `titleKey` value with a summary of the others; it opens into a small form built from the same renderers as
 * every other field. Add, remove and (when `orderable`) move up and down; the whole list is the value.
 */
export function RecordsField({ field, id, describedBy, value, onChange, disabled, onLocalError }: FieldProps<Extract<SettingField, { type: "records" }>>) {
  const list: ReadonlyArray<RecordValue> = Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))
    ? (value as ReadonlyArray<RecordValue>)
    : field.default
  const [open, setOpen] = useState<number | undefined>(undefined)
  const max = field.maxItems ?? 50
  const titleField = field.itemFields.find((f) => f.key === field.titleKey)
  const set = (next: ReadonlyArray<RecordValue>) => onChange(next as unknown as SettingValue)
  const update = (index: number, key: string, v: SettingValue) =>
    set(list.map((r, i) => (i === index ? { ...r, [key]: v as RecordValue[string] } : r)))
  const move = (index: number, by: -1 | 1) => {
    const to = index + by
    if (to < 0 || to >= list.length) return
    const next = [...list]
    ;[next[index], next[to]] = [next[to]!, next[index]!]
    set(next)
    if (open === index) setOpen(to)
  }
  const noun = field.itemLabel
  return (
    <div id={id} aria-describedby={describedBy} className="flex flex-col gap-1.5" data-testid={`records-${field.key}`} role="group" aria-label={field.label}>
      {list.length === 0 && <p className="text-[13px] text-ink-faint">No {noun}s yet.</p>}
      <ol className="flex flex-col gap-1.5">
        {list.map((record, index) => {
          const title = titleField === undefined ? "" : shown(titleField, record[field.titleKey])
          const rest = field.itemFields.filter((f) => f.key !== field.titleKey).map((f) => shown(f, record[f.key])).filter((t) => t !== "").join(" · ")
          const expanded = open === index
          const rowId = `${id}-${index}`
          return (
            <li key={index} className="rounded-md border border-line/70" data-testid="record">
              <div className="flex items-center gap-1 pl-3">
                <button
                  type="button"
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={expanded}
                  aria-controls={`${rowId}-form`}
                  onClick={() => setOpen(expanded ? undefined : index)}
                >
                  <Icon name="chevron" size={13} className={cx("shrink-0 text-ink-faint transition-transform duration-[120ms]", expanded && "rotate-90")} />
                  <span className="truncate text-[14px] text-ink">{title === "" ? `${noun[0]!.toUpperCase()}${noun.slice(1)} ${index + 1}` : title}</span>
                  {rest !== "" && <span className="truncate text-[13px] text-ink-muted">{rest}</span>}
                </button>
                {field.orderable && (
                  <>
                    <IconButton label={`Move ${title || noun} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                      <Icon name="chevron" size={13} className="-rotate-90" />
                    </IconButton>
                    <IconButton label={`Move ${title || noun} down`} disabled={disabled || index === list.length - 1} onClick={() => move(index, 1)}>
                      <Icon name="chevron" size={13} className="rotate-90" />
                    </IconButton>
                  </>
                )}
                <IconButton
                  label={`Remove ${title || `${noun} ${index + 1}`}`}
                  disabled={disabled}
                  onClick={() => {
                    set(list.filter((_, i) => i !== index))
                    setOpen(undefined)
                  }}
                >
                  <Icon name="trash" size={14} />
                </IconButton>
              </div>
              {expanded && (
                <div id={`${rowId}-form`} className="flex flex-col gap-4 border-t border-line/60 px-3 py-3">
                  {field.itemFields.map((f) => {
                    const Renderer = itemRenderers[f.type]
                    const fid = `${rowId}-${f.key}`
                    return (
                      <div key={f.key} className="flex flex-col gap-1.5">
                        <label htmlFor={fid} className="text-[13px] font-medium text-ink">{f.label}</label>
                        <Renderer
                          field={asField(f)}
                          id={fid}
                          describedBy={`${fid}-desc`}
                          value={record[f.key] as SettingValue | undefined}
                          onChange={(v) => update(index, f.key, v)}
                          onSecretChange={() => undefined}
                          disabled={disabled}
                          invalid={false}
                          onLocalError={onLocalError}
                        />
                        {f.description !== undefined && <p id={`${fid}-desc`} className="text-[12px] text-ink-muted">{f.description}</p>}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={disabled || list.length >= max}
          onClick={() => {
            set([...list, newRecord(field.itemFields)])
            setOpen(list.length)
          }}
        >
          <Icon name="plus" size={13} />
          Add {noun}
        </Button>
        {list.length >= max * 0.8 && <span className="font-mono text-[11px] text-ink-faint">{list.length} / {max}</span>}
      </div>
    </div>
  )
}
