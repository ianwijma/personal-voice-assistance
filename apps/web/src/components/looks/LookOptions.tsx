"use client"
import type { ReactNode } from "react"
import type { Look } from "@pva/protocol"
import type { Character, OptionSpec } from "@/characters/contract.ts"
import { isDefault, normaliseColor, PALETTE_KEYS, validateValue } from "@/characters/options.ts"
import { changedCount, HOST_OPTIONS, resetAll, resetOption, setOption, valuesOf } from "@/lib/looks.ts"
import { inputClass } from "../fields/types.ts"
import { SELECT_CHEVRON } from "../settings/pages/assistants/parts.tsx"
import { cx, Segmented, Switch } from "../ui/controls.tsx"

/**
 * The selected character's settings, rendered from its manifest (docs/CHARACTERS.md §4.4): number → slider with its
 * value, toggle → switch, choice → segmented control (up to four short choices) or select, colour → a theme colour or
 * a custom one. Each with its help text and a Reset when it differs from the default; "Reset all" for the character's
 * own. Then the three host-level settings, which belong to no character (`$you`, `$voice`, `$sensitivity`). Every
 * value goes through `options.ts` validation before it is stored (`lib/looks.ts`).
 */
export function LookOptions({ character, look, onChange, idPrefix }: {
  readonly character: Character
  readonly look: Look | undefined
  readonly onChange: (look: Look) => void
  readonly idPrefix: string
}) {
  const values = valuesOf(character, look)
  const own = character.options ?? []
  const changed = changedCount(character, look)
  const groups = new Map<string, Array<OptionSpec>>()
  for (const s of own) {
    const g = s.group ?? "Settings"
    groups.set(g, [...(groups.get(g) ?? []), s])
  }
  const row = (s: OptionSpec) => (
    <OptionRow
      key={s.id}
      spec={s}
      value={values[s.id]}
      id={`${idPrefix}-opt-${s.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
      onSet={(v) => onChange(setOption(character, look, s.id, v))}
      onReset={() => onChange(resetOption(character, look, s.id))}
    />
  )
  return (
    <>
      <section className="flex flex-col gap-4" aria-labelledby={`${idPrefix}-opts`} data-testid="look-options">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h4 id={`${idPrefix}-opts`} className="label text-ink-faint">{character.name} settings</h4>
          {own.length > 0 && (
            <button
              type="button"
              className="ml-auto inline-flex min-h-8 items-center text-[13px] text-voice underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline max-sm:min-h-11"
              disabled={changed === 0}
              onClick={() => onChange(resetAll(character, look, false))}
              data-testid="reset-all"
            >
              Reset all{changed > 0 ? ` (${changed})` : ""}
            </button>
          )}
        </div>
        {own.length === 0
          ? <p className="text-[13px] text-ink-muted">{character.name} has nothing to tune.</p>
          : [...groups].map(([g, specs]) => (
            <div key={g} className="flex flex-col gap-4" role="group" aria-label={g}>
              {groups.size > 1 && <h5 className="text-[13px] font-medium text-ink-muted">{g}</h5>}
              {specs.map(row)}
            </div>
          ))}
      </section>
      <section className="flex flex-col gap-4 border-t border-line/60 pt-5" aria-labelledby={`${idPrefix}-host`} data-testid="look-host-options">
        <div className="flex flex-col gap-0.5">
          <h4 id={`${idPrefix}-host`} className="label text-ink-faint">Colours and sensitivity</h4>
          <p className="text-[13px] text-ink-muted">These belong to the look, not to the character: they stay when you pick another character.</p>
        </div>
        {HOST_OPTIONS.map(row)}
      </section>
    </>
  )
}

const COLOR_WORDS: Readonly<Record<(typeof PALETTE_KEYS)[number], string>> = { you: "Your colour (theme)", voice: "Assistant colour (theme)", ink: "Text colour (theme)", inkFaint: "Faint text colour (theme)" }

const shown = (spec: OptionSpec, v: unknown): string => {
  switch (spec.kind) {
    case "number": {
      const n = Number(v)
      const digits = Math.min(3, Math.max(0, (String(spec.step).split(".")[1] ?? "").length))
      return `${n.toFixed(digits)}${spec.unit !== undefined ? (spec.unit === "×" ? "×" : ` ${spec.unit}`) : ""}`
    }
    case "toggle":
      return v === true ? "On" : "Off"
    case "choice":
      return spec.choices.find((c) => c.value === v)?.label ?? String(v)
    case "color":
      return typeof v === "string" && Object.hasOwn(COLOR_WORDS, v) ? COLOR_WORDS[v as keyof typeof COLOR_WORDS] : String(v)
  }
}

function OptionRow({ spec, value, id, onSet, onReset }: {
  readonly spec: OptionSpec
  readonly value: number | boolean | string | undefined
  readonly id: string
  readonly onSet: (v: unknown) => void
  readonly onReset: () => void
}) {
  const v = value ?? validateValue(spec, spec.default)
  const changed = !isDefault(spec, v)
  const helpId = spec.help !== undefined ? `${id}-help` : undefined
  const labelled = spec.kind === "number" || spec.kind === "choice" || spec.kind === "color"
  let control: ReactNode
  switch (spec.kind) {
    case "number":
      control = (
        <input
          id={id}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={Number(v)}
          aria-valuetext={shown(spec, v)}
          aria-describedby={helpId}
          onChange={(e) => onSet(Number(e.target.value))}
          className="h-8 w-full cursor-pointer accent-[var(--color-voice)] max-sm:h-11"
        />
      )
      break
    case "toggle":
      control = (
        <div className="flex items-center gap-3">
          <Switch id={id} checked={v === true} onChange={(on) => onSet(on)} label={spec.label} {...(helpId !== undefined ? { describedBy: helpId } : {})} />
          <span className="text-[14px] text-ink">{v === true ? "On" : "Off"}</span>
        </div>
      )
      break
    case "choice": {
      const short = spec.choices.length <= 4 && spec.choices.every((c) => c.label.length <= 12)
      control = short
        ? (
          <div id={id} aria-describedby={helpId}>
            <Segmented name={id} label={spec.label} value={String(v)} options={spec.choices.map((c) => ({ value: c.value, label: c.label }))} onChange={(x) => onSet(x)} testId={`seg-${spec.id}`} />
          </div>
        )
        : (
          <select
            id={id}
            value={String(v)}
            aria-describedby={helpId}
            onChange={(e) => onSet(e.target.value)}
            className={cx(inputClass, "max-w-[320px] appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9")}
            style={{ backgroundImage: SELECT_CHEVRON }}
          >
            {spec.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        )
      break
    }
    case "color":
      control = <ColorControl id={id} value={String(v)} helpId={helpId} onSet={onSet} />
      break
  }
  return (
    <div className="flex flex-col gap-1.5" data-option={spec.id} data-changed={changed ? "true" : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {labelled
          ? <label htmlFor={id} className="text-[14px] font-medium text-ink">{spec.label}</label>
          : <span className="text-[14px] font-medium text-ink">{spec.label}</span>}
        {spec.kind === "number" && <span className="font-mono text-[12px] text-ink-muted" data-testid="option-value">{shown(spec, v)}</span>}
        {changed && (
          <button
            type="button"
            className="relative ml-auto inline-flex min-h-8 items-center text-[12px] text-voice underline-offset-4 hover:underline max-sm:before:absolute max-sm:before:-inset-x-2 max-sm:before:-inset-y-1.5 max-sm:before:content-['']"
            onClick={onReset}
            aria-label={`Reset ${spec.label} to its default, ${shown(spec, validateValue(spec, spec.default))}`}
            data-testid="option-reset"
          >
            Reset
          </button>
        )}
      </div>
      {control}
      {spec.help !== undefined && <p id={helpId} className="text-[13px] text-ink-muted">{spec.help}</p>}
    </div>
  )
}

function ColorControl({ id, value, helpId, onSet }: { readonly id: string; readonly value: string; readonly helpId: string | undefined; readonly onSet: (v: unknown) => void }) {
  const key = (PALETTE_KEYS as ReadonlyArray<string>).includes(value) ? value : "custom"
  const hex = key === "custom" ? normaliseColor(value) ?? "#808080" : undefined
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        id={id}
        value={key}
        aria-describedby={helpId}
        onChange={(e) => onSet(e.target.value === "custom" ? hex ?? "#808080" : e.target.value)}
        className={cx(inputClass, "max-w-[260px] appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9")}
        style={{ backgroundImage: SELECT_CHEVRON }}
      >
        {PALETTE_KEYS.map((k) => <option key={k} value={k}>{COLOR_WORDS[k]}</option>)}
        <option value="custom">Custom colour…</option>
      </select>
      {hex !== undefined && (
        <input
          type="color"
          aria-label="Custom colour"
          value={hex}
          onChange={(e) => onSet(e.target.value)}
          className="h-10 w-14 cursor-pointer rounded-md border border-line bg-surface p-1 text-[16px] max-sm:h-11"
        />
      )}
    </div>
  )
}
