"use client"
import { useEffect, useRef, useState } from "react"
import type { SettingField } from "@pva/protocol"
import { Icon } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

/** Add the text to the list as the server would keep it: trimmed, no empty items, no duplicates (ignoring case). */
export const addItems = (list: ReadonlyArray<string>, text: string, max: number, itemMax: number): { readonly next: ReadonlyArray<string>; readonly error?: string } => {
  const next = [...list]
  for (const raw of text.split(",")) {
    const item = raw.trim()
    if (item.length === 0) continue
    if (item.length > itemMax) return { next: list, error: `"${item.slice(0, 20)}…" is longer than ${itemMax} characters.` }
    if (next.some((x) => x.toLowerCase() === item.toLowerCase())) continue
    if (next.length >= max) return { next: list, error: `At most ${max} items.` }
    next.push(item)
  }
  return { next }
}

/**
 * The input's placeholder: the field's example while the list is empty, the generic "Add…" once it has an item (an
 * example beside real chips reads as one more item), nothing when it is full.
 */
export const textListPlaceholder = (example: string | undefined, count: number, max: number): string =>
  count >= max ? "" : count > 0 ? "Add…" : example ?? "Add…"

/**
 * A list of short texts (protocol 10, `textList`): chips with a remove button, and an input that adds what was typed
 * on Enter, a comma or leaving the input (Backspace in the empty input removes the last chip). A counter shows near
 * `maxItems`.
 *
 * Text that could not be added (too long, too many) stays in the input, and its reason is reported to the form
 * (`onLocalError`, shown under the field): Save waits and the page counts as edited until the text is fixed, added
 * or cleared.
 */
export function TextListField({ field, id, describedBy, value, onChange, disabled, invalid, onLocalError }: FieldProps<Extract<SettingField, { type: "textList" }>>) {
  const list: ReadonlyArray<string> = Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as ReadonlyArray<string>) : field.default
  const max = field.maxItems ?? 50
  const itemMax = field.itemMaxLength ?? 60
  const [text, setText] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const report = useRef(onLocalError)
  report.current = onLocalError
  useEffect(() => {
    report.current(problem === undefined ? undefined : `Not added: ${problem}`)
  }, [problem])
  useEffect(() => () => {
    report.current(undefined)
  }, [])
  const commit = (input: string) => {
    const { next, error } = addItems(list, input, max, itemMax)
    setProblem(error)
    if (error === undefined) {
      setText("")
      if (next.length !== list.length) onChange(next as Array<string>)
    } else {
      setText(input)
    }
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid={`textlist-${field.key}`}>
      <div className={cx("flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-2/60 px-2 py-1.5", (invalid || problem !== undefined) && "border-danger/70", disabled && "opacity-60")}>
        {list.map((item, i) => (
          <span key={`${item}-${i}`} className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-0.5 text-[13px] text-ink" data-testid="chip">
            {item}
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded-sm text-ink-faint hover:text-ink disabled:opacity-40"
              aria-label={`Remove ${item}`}
              disabled={disabled}
              onClick={() => onChange(list.filter((_, j) => j !== i) as Array<string>)}
            >
              <Icon name="cross" size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={text}
          disabled={disabled || (list.length >= max && text === "")}
          placeholder={textListPlaceholder(field.placeholder, list.length, max)}
          aria-describedby={describedBy}
          aria-invalid={invalid || problem !== undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={itemMax * 4}
          className="h-7 min-w-24 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint sm:text-[14px]"
          onChange={(e) => {
            const v = e.target.value
            if (v.includes(",")) commit(v)
            else {
              setText(v)
              // Cleared: nothing is pending any more.
              if (v.trim() === "") setProblem(undefined)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit(text)
            } else if (e.key === "Backspace" && text === "" && list.length > 0) {
              onChange(list.slice(0, -1) as Array<string>)
            }
          }}
          onBlur={() => {
            if (text.trim() !== "") commit(text)
          }}
        />
      </div>
      {list.length >= max * 0.8 && <p className="text-right font-mono text-[11px] text-ink-faint">{list.length} / {max}</p>}
    </div>
  )
}
