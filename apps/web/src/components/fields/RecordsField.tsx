"use client"
import { type ComponentType, useEffect, useRef, useState } from "react"
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

let rowSeq = 0
const newRowId = () => `row${++rowSeq}`

/** An error of one item field of one row, by the row's stable id. */
const errorKey = (rowId: string, fieldKey: string) => `${rowId}\u0000${fieldKey}`

/**
 * An ordered list of flat records (protocol 10, `records`: rooms, lamps, members). Each record is a row titled by
 * its `titleKey` value with a summary of the others; it opens into a small form built from the same renderers as
 * every other field. Add, remove and (when `orderable`) move up and down; the whole list is the value.
 *
 * Rows have a stable identity (an id that follows a row when it moves): which row is open, the text in its inputs
 * and the problems of its fields stay with that row. A problem of an item field (text a field cannot take yet) is
 * shown under it and reported to the form with the row's number, so Save waits; removing the row removes its
 * problems. Row forms stay mounted while closed, so nothing typed is lost by closing one.
 */
export function RecordsField({ field, id, describedBy, value, onChange, disabled, onLocalError }: FieldProps<Extract<SettingField, { type: "records" }>>) {
  const list: ReadonlyArray<RecordValue> = Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))
    ? (value as ReadonlyArray<RecordValue>)
    : field.default
  // The ids of the list last seen; a list that changed from outside (Cancel, a save, another tab) keeps the ids by
  // place, and new places get new ids.
  const rows = useRef<{ list: ReadonlyArray<RecordValue>; ids: ReadonlyArray<string> } | undefined>(undefined)
  if (rows.current === undefined || rows.current.list !== list) {
    const old = rows.current?.ids ?? []
    rows.current = { list, ids: list.map((_, i) => old[i] ?? newRowId()) }
  }
  const ids = rows.current.ids
  const [open, setOpen] = useState<string | undefined>(undefined)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const max = field.maxItems ?? 50
  const noun = field.itemLabel
  const Noun = `${noun[0]!.toUpperCase()}${noun.slice(1)}`
  const titleField = field.itemFields.find((f) => f.key === field.titleKey)
  const emit = (next: ReadonlyArray<RecordValue>, nextIds: ReadonlyArray<string>) => {
    rows.current = { list: next, ids: nextIds }
    onChange(next as unknown as SettingValue)
  }
  const update = (index: number, key: string, v: SettingValue) =>
    emit(list.map((r, i) => (i === index ? { ...r, [key]: v as RecordValue[string] } : r)), ids)
  const move = (index: number, by: -1 | 1) => {
    const to = index + by
    if (to < 0 || to >= list.length) return
    const next = [...list]
    const nextIds = [...ids]
    ;[next[index], next[to]] = [next[to]!, next[index]!]
    ;[nextIds[index], nextIds[to]] = [nextIds[to]!, nextIds[index]!]
    emit(next, nextIds)
  }
  const remove = (index: number) => {
    const gone = ids[index]!
    emit(list.filter((_, i) => i !== index), ids.filter((_, i) => i !== index))
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(`${gone}\u0000`))))
    if (open === gone) setOpen(undefined)
  }
  const reportFor = (rowId: string, fieldKey: string) => (message: string | undefined) =>
    setErrors((e) => {
      const key = errorKey(rowId, fieldKey)
      if (e[key] === message) return e
      const { [key]: _old, ...rest } = e
      return message === undefined ? rest : { ...rest, [key]: message }
    })

  // The form hears of the first problem, with the row it is in; none once every one is fixed or its row removed.
  const live = new Set(ids)
  const first = ids.flatMap((rowId, index) =>
    field.itemFields.flatMap((f) => {
      const message = errors[errorKey(rowId, f.key)]
      return message === undefined || !live.has(rowId) ? [] : [`${Noun} ${index + 1}, ${f.label}: ${message}`]
    })
  )[0]
  const report = useRef(onLocalError)
  report.current = onLocalError
  useEffect(() => {
    report.current(first)
  }, [first])
  useEffect(() => () => {
    report.current(undefined)
  }, [])

  return (
    <div id={id} aria-describedby={describedBy} className="flex flex-col gap-1.5" data-testid={`records-${field.key}`} role="group" aria-label={field.label}>
      {list.length === 0 && <p className="text-[13px] text-ink-faint">No {noun}s yet.</p>}
      <ol className="flex flex-col gap-1.5">
        {list.map((record, index) => {
          const rowId = ids[index]!
          const title = titleField === undefined ? "" : shown(titleField, record[field.titleKey])
          const rest = field.itemFields.filter((f) => f.key !== field.titleKey).map((f) => shown(f, record[f.key])).filter((t) => t !== "").join(" · ")
          const expanded = open === rowId
          const domId = `${id}-${rowId}`
          const rowHasProblem = field.itemFields.some((f) => errors[errorKey(rowId, f.key)] !== undefined)
          return (
            <li key={rowId} className={cx("rounded-md border border-line/70", rowHasProblem && "border-danger/70")} data-testid="record" data-invalid={rowHasProblem ? "true" : undefined}>
              <div className="flex items-center gap-1 pl-3">
                <button
                  type="button"
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={expanded}
                  aria-controls={`${domId}-form`}
                  onClick={() => setOpen(expanded ? undefined : rowId)}
                >
                  <Icon name="chevron" size={13} className={cx("shrink-0 text-ink-faint transition-transform duration-[120ms]", expanded && "rotate-90")} />
                  <span className="truncate text-[14px] text-ink">{title === "" ? `${Noun} ${index + 1}` : title}</span>
                  {rest !== "" && <span className="truncate text-[13px] text-ink-muted">{rest}</span>}
                  {rowHasProblem && <span className="text-[12px] text-danger">Needs a fix</span>}
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
                <IconButton label={`Remove ${title || `${noun} ${index + 1}`}`} disabled={disabled} onClick={() => remove(index)}>
                  <Icon name="trash" size={14} />
                </IconButton>
              </div>
              <div id={`${domId}-form`} hidden={!expanded} className="flex flex-col gap-4 border-t border-line/60 px-3 py-3" data-testid="record-form">
                {field.itemFields.map((f) => {
                  const Renderer = itemRenderers[f.type]
                  const fid = `${domId}-${f.key}`
                  const problem = errors[errorKey(rowId, f.key)]
                  return (
                    <div key={f.key} className="flex flex-col gap-1.5">
                      <label htmlFor={fid} className="text-[13px] font-medium text-ink">{f.label}</label>
                      <Renderer
                        field={asField(f)}
                        id={fid}
                        describedBy={problem !== undefined ? `${fid}-desc ${fid}-err` : `${fid}-desc`}
                        value={record[f.key] as SettingValue | undefined}
                        onChange={(v) => update(index, f.key, v)}
                        onSecretChange={() => undefined}
                        disabled={disabled}
                        invalid={problem !== undefined}
                        onLocalError={reportFor(rowId, f.key)}
                      />
                      {problem !== undefined && <p id={`${fid}-err`} className="text-[12px] text-danger" data-testid="record-field-error">{problem}</p>}
                      {f.description !== undefined && <p id={`${fid}-desc`} className="text-[12px] text-ink-muted">{f.description}</p>}
                    </div>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={disabled || list.length >= max}
          onClick={() => {
            const rowId = newRowId()
            emit([...list, newRecord(field.itemFields)], [...ids, rowId])
            setOpen(rowId)
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
