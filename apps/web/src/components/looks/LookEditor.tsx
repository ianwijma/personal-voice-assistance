"use client"
import { useMemo, useRef } from "react"
import type { Look } from "@pva/protocol"
import { loadCharacter, prettyId } from "@/characters/catalog.ts"
import type { OptionValues } from "@/characters/contract.ts"
import { registry } from "@/characters/registry.ts"
import { baselineLook, HOST_OPTIONS, switchCharacter } from "@/lib/looks.ts"
import { CharacterPicker } from "./CharacterPicker.tsx"
import { LookOptions } from "./LookOptions.tsx"
import { LookPreview } from "./LookPreview.tsx"
import { Icon } from "../ui/Icon.tsx"
import { useCharacter } from "./useCharacter.ts"

/**
 * One look, edited (docs/LOOKS-AND-VOICES.md §4): the character picker, a large live preview, the character's own
 * settings and the host-level ones. Used by an assistant's Look tab and by a device's (or a device type's) own look; it
 * knows nothing about where the look is kept: `value` (undefined = the baseline with every default) in, a whole
 * canonical look out (`lib/looks.ts`).
 *
 * A look naming a character this version does not have is shown as such and left untouched until another is picked:
 * the stage shows the baseline for it (docs/CHARACTERS.md §4.6).
 */
export function LookEditor({ value, onChange, idPrefix, whose, foldPicker = false }: {
  readonly value: Look | undefined
  readonly onChange: (look: Look) => void
  readonly idPrefix: string
  /** Whose look this is, for the headings: "Jeff's", "Kitchen iPad's own". */
  readonly whose: string
  /** The picker folded under "Choose another character" (a device page, where the look is one section of many). */
  readonly foldPicker?: boolean
}) {
  const current: Look = value ?? baselineLook(registry.baseline)
  const id = current.character
  const unknown = !registry.ids.includes(id)
  const loaded = useCharacter(unknown ? undefined : id)
  const character = loaded?.kind === "ready" ? loaded.character : undefined
  const pickToken = useRef(0)
  const latest = useRef(current)
  latest.current = current

  const pick = (next: string) => {
    // Every pick is the newest, the current character too: picking it again drops a load still on its way.
    const token = ++pickToken.current
    if (next === id) return
    // continuation(state): only the newest pick applies, on the look as it is when the character has loaded
    void loadCharacter(next).then((r) => {
      if (token !== pickToken.current || r.kind !== "ready") return
      onChange(switchCharacter(latest.current, r.character))
    })
  }

  // The cards show this look's colours and sensitivity; the selected card shows all of it.
  const hostKey = JSON.stringify(HOST_OPTIONS.map((s) => current.options?.[s.id]))
  const hostStored = useMemo<OptionValues>(() => Object.fromEntries(HOST_OPTIONS.flatMap((s) => (current.options?.[s.id] !== undefined ? [[s.id, current.options[s.id]!]] : []))), [hostKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const allKey = JSON.stringify(current.options ?? {})
  const allStored = useMemo<OptionValues>(() => ({ ...(current.options ?? {}) }), [allKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const picker = (
    <CharacterPicker
      ids={registry.ids}
      value={id}
      onPick={pick}
      stored={hostStored}
      selectedStored={allStored}
      label={`Choose ${whose} character`}
      idPrefix={idPrefix}
    />
  )
  return (
    <div className="flex flex-col gap-6" data-testid="look-editor" data-character={id}>
      {unknown && (
        <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-ink" data-testid="look-unknown">
          This look names “{prettyId(id)}”, a character this version does not have, so the voice page shows the baseline instead. It is kept as it is until you pick another character.
        </p>
      )}
      {/* The preview stays in view (from tablet width up) while the picker and the settings below it scroll. */}
      <section className="z-10 -mx-1 flex flex-col gap-2 bg-bg px-1 pb-2 sm:sticky sm:top-0 sm:pt-2" aria-labelledby={`${idPrefix}-prev`}>
        <h4 id={`${idPrefix}-prev`} className="label text-ink-faint" data-testid="look-title">{whose} look{character !== undefined ? `: ${character.name}` : unknown ? `: ${prettyId(id)}` : ""}</h4>
        <LookPreview look={value} idPrefix={idPrefix} />
      </section>
      {foldPicker
        ? (
          <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-3" data-testid="picker-fold">
            <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[14px] text-ink-muted marker:hidden hover:text-ink max-sm:min-h-11">
              <Icon name="chevron" size={14} className="shrink-0 transition-transform duration-[120ms] group-open:rotate-90" />
              Choose another character
              <span className="ml-auto font-mono text-[12px] text-ink-faint">{registry.ids.length} characters</span>
            </summary>
            <div className="mt-3">{picker}</div>
          </details>
        )
        : (
          <section className="flex flex-col gap-2" aria-labelledby={`${idPrefix}-chr`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h4 id={`${idPrefix}-chr`} className="label text-ink-faint">Character</h4>
              <span className="font-mono text-[12px] text-ink-faint">{registry.ids.length} characters</span>
            </div>
            {picker}
          </section>
        )}
      {character !== undefined && <LookOptions character={character} look={value} onChange={onChange} idPrefix={idPrefix} />}
    </div>
  )
}
