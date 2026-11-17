"use client"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { prettyId } from "@/characters/catalog.ts"
import type { OptionValues } from "@/characters/contract.ts"
import { createPreviewLoop, type PreviewHandle, type PreviewLoop } from "@/characters/preview.ts"
import { cx } from "../ui/controls.tsx"
import { useCharacter } from "./useCharacter.ts"

/**
 * The character picker (docs/LOOKS-AND-VOICES.md §4): one card per character in the registry, each with a small live
 * preview, its name, family and summary. A card loads its character's chunk only when it first scrolls into view, and
 * its preview runs only while it is in view (`preview.ts`: one shared loop, 30 frames a second at most, paused while
 * the tab is hidden, held still under reduced motion). A radio group: arrow keys move the choice, as in the rest of
 * the admin.
 */
export function CharacterPicker({ ids, value, onPick, stored, selectedStored, label, idPrefix }: {
  /** Every character id, sorted (`registry.ids`). */
  readonly ids: ReadonlyArray<string>
  readonly value: string
  readonly onPick: (id: string) => void
  /** What every card's preview gets: the host-level colours and sensitivity, so the cards show this look's colours. */
  readonly stored: OptionValues | undefined
  /** What the selected card's preview gets: every value of the look. */
  readonly selectedStored: OptionValues | undefined
  readonly label: string
  readonly idPrefix: string
}) {
  const [loop, setLoop] = useState<PreviewLoop | undefined>()
  useEffect(() => {
    const l = createPreviewLoop()
    setLoop(l)
    return () => l.stop()
  }, [])
  const group = useRef<HTMLDivElement>(null)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const i = Math.max(0, ids.indexOf(value))
    const next = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length
    onPick(ids[next]!)
    // The choice moves at once; focus follows to the card (it is the tab stop now).
    requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-character="${CSS.escape(ids[next]!)}"]`)?.focus())
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} id={`${idPrefix}-picker`} className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="character-picker">
      {ids.map((id) => (
        <Card
          key={id}
          id={id}
          checked={id === value}
          tabbable={id === value || (!ids.includes(value) && id === ids[0])}
          loop={loop}
          stored={id === value ? selectedStored : stored}
          onPick={() => onPick(id)}
          onKey={onKey}
        />
      ))}
    </div>
  )
}

const FAMILY: Readonly<Record<string, string>> = { baseline: "Baseline", abstract: "Abstract", figure: "Figure" }

function Card({ id, checked, tabbable, loop, stored, onPick, onKey }: {
  readonly id: string
  readonly checked: boolean
  readonly tabbable: boolean
  readonly loop: PreviewLoop | undefined
  readonly stored: OptionValues | undefined
  readonly onPick: () => void
  readonly onKey: (e: KeyboardEvent<HTMLDivElement>) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const handle = useRef<PreviewHandle | undefined>(undefined)
  const visible = useRef(false)
  const [seen, setSeen] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  const loaded = useCharacter(id, seen || checked)
  const character = loaded?.kind === "ready" ? loaded.character : undefined
  const storedRef = useRef(stored)
  storedRef.current = stored

  // In view: load (once) and run the preview; out of view: the preview stops.
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    if (typeof IntersectionObserver === "undefined") {
      visible.current = true
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((records) => {
      const on = records.some((r) => r.isIntersecting)
      visible.current = on
      if (on) setSeen(true)
      handle.current?.setVisible(on)
    }, { rootMargin: "120px" })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (loop === undefined || character === undefined || canvas.current === null) return
    const h = loop.add(canvas.current, character, storedRef.current, (m) => setFailed(m))
    handle.current = h
    h.setVisible(visible.current)
    return () => {
      h.dispose()
      handle.current = undefined
    }
  }, [loop, character])

  useEffect(() => handle.current?.setStored(stored), [stored])

  const name = character?.name ?? prettyId(id)
  const unavailable = loaded?.kind === "unavailable"
  return (
    <div
      ref={ref}
      role="radio"
      aria-checked={checked}
      aria-disabled={unavailable || undefined}
      aria-label={name}
      aria-describedby={`chr-${id}-sum`}
      tabIndex={tabbable ? 0 : -1}
      data-character={id}
      onClick={() => {
        if (!unavailable) onPick()
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault()
          if (!unavailable) onPick()
          return
        }
        onKey(e)
      }}
      className={cx(
        "flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border text-left transition-colors duration-[120ms]",
        checked ? "border-ink-muted bg-surface-2/70 shadow-[inset_0_0_0_1px_var(--color-ink-muted)]" : "border-line hover:border-ink-faint/60",
        unavailable && "cursor-not-allowed opacity-60"
      )}
    >
      <div className="relative h-[76px] w-full bg-bg" aria-hidden="true">
        <canvas ref={canvas} className="absolute inset-0 size-full" />
        {(failed !== undefined || unavailable) && (
          <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[12px] text-ink-faint">{unavailable ? "Not available" : "No preview"}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className={cx("inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border", checked ? "border-you" : "border-ink-faint")}>
            {checked && <span className="size-1.5 rounded-full bg-you" />}
          </span>
          <span className="truncate text-[14px] text-ink">{name}</span>
          {character !== undefined && <span className="label ml-auto shrink-0 text-[9px] text-ink-faint">{FAMILY[character.family] ?? character.family}</span>}
        </span>
        <span id={`chr-${id}-sum`} className="line-clamp-2 min-h-[2lh] text-[12px] leading-snug text-ink-muted">
          {character?.summary ?? (unavailable ? "This version cannot show it; the stage would show the baseline." : "")}
        </span>
      </div>
    </div>
  )
}
