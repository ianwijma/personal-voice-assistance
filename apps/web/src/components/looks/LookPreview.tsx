"use client"
import { useEffect, useRef, useState } from "react"
import type { Look } from "@pva/protocol"
import { CORE_MODES, type CoreMode } from "@/characters/contract.ts"
import { type CharacterHost, type HostInput, startCharacterHost } from "@/characters/host.ts"
import { NO_AUDIO, scriptedMode } from "@/characters/preview.ts"
import { deepEqual } from "@/lib/assistants.ts"
import { useMediaQuery } from "../useMediaQuery.ts"
import { cx } from "../ui/controls.tsx"

const MODE_WORDS: Readonly<Record<CoreMode, string>> = { idle: "Idle", listening: "Listening", hearing: "Hearing", thinking: "Thinking", speaking: "Speaking" }

/**
 * The large preview of a look (docs/LOOKS-AND-VOICES.md §4): the real character host, as on the voice page, driven by a
 * scripted conversation through the five core modes with stand-in voices instead of a microphone (`preview.ts`), in the
 * page's theme. Buttons pin one mode. The host runs only while the preview is in view (and pauses itself while the tab
 * is hidden); a new look swaps in place, and a character that fails shows the baseline here exactly as on the stage.
 * Under reduced motion it starts pinned to Speaking (the characters hold their poses).
 */
export function LookPreview({ look, idPrefix }: { readonly look: Look | undefined; readonly idPrefix: string }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)")
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<HostInput>({ state: "idle", owner: false })
  const host = useRef<CharacterHost | undefined>(undefined)
  const shown = useRef<Look | undefined>(look)
  const [inView, setInView] = useState(false)
  const [pin, setPin] = useState<CoreMode | "play" | undefined>()
  const [mode, setMode] = useState<CoreMode>("idle")
  const [state, setState] = useState<{ readonly id: string; readonly fallback: string | undefined }>({ id: "", fallback: undefined })
  const pinned = pin ?? (reduced ? "speaking" : "play")

  useEffect(() => {
    const el = box.current
    if (el === null) return
    if (typeof IntersectionObserver === "undefined") return setInView(true)
    const io = new IntersectionObserver((r) => setInView(r.some((x) => x.isIntersecting)))
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // The host, while in view.
  useEffect(() => {
    if (!inView || canvas.current === null) return
    const h = startCharacterHost(canvas.current, input.current, shown.current, { taps: NO_AUDIO, warn: () => undefined })
    host.current = h
    return () => {
      h.stop()
      host.current = undefined
    }
  }, [inView])

  useEffect(() => {
    if (deepEqual(look, shown.current)) return
    shown.current = look
    host.current?.setChoice(look)
  }, [look])

  // The script, and what is on stage (for the words under the preview and for tests).
  useEffect(() => {
    if (!inView) return
    const t0 = performance.now()
    const tick = () => {
      const m = pinned === "play" ? scriptedMode((performance.now() - t0) / 1000) : pinned
      input.current.state = m
      setMode(m)
      const d = host.current?.debug()
      if (d !== undefined) setState((s) => {
        const fallback = d.fallback === null ? undefined : d.fallback.message
        return s.id === d.id && s.fallback === fallback ? s : { id: d.id, fallback }
      })
    }
    tick()
    const t = setInterval(tick, 100)
    return () => clearInterval(t)
  }, [inView, pinned])

  const options: ReadonlyArray<readonly [CoreMode | "play", string]> = [["play", "Conversation"], ...CORE_MODES.map((m) => [m, MODE_WORDS[m]] as const)]
  const choose = (v: CoreMode | "play") => setPin(v)
  return (
    <div className="flex flex-col gap-2" data-testid="look-preview" data-on-stage={state.id} data-mode={mode}>
      <div ref={box} className="relative h-[150px] w-full overflow-hidden rounded-md border border-line bg-bg sm:h-[170px]">
        <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 size-full" />
        <span className="label pointer-events-none absolute left-3 top-2 text-[10px] text-ink-faint" aria-hidden="true">{MODE_WORDS[mode]}</span>
      </div>
      {state.fallback !== undefined && (
        <p className="text-[13px] text-warn" data-testid="preview-fallback">This character could not run here, so the baseline is shown, as the voice page would: {state.fallback}</p>
      )}
      <div role="radiogroup" aria-label="Preview" className="flex flex-wrap gap-1.5" data-testid="preview-modes">
        {options.map(([v, words]) => {
          const on = v === pinned
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-mode={v}
              id={`${idPrefix}-mode-${v}`}
              onClick={() => choose(v)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
                e.preventDefault()
                const i = options.findIndex(([x]) => x === pinned)
                const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length]![0]
                choose(next)
                requestAnimationFrame(() => document.getElementById(`${idPrefix}-mode-${next}`)?.focus())
              }}
              className={cx(
                "min-h-8 rounded-full border px-3 text-[13px] transition-colors duration-[120ms] max-sm:min-h-11",
                on ? "border-ink-muted bg-surface-2 font-medium text-ink shadow-[inset_0_0_0_1px_var(--color-ink-muted)]" : "border-line text-ink-muted hover:text-ink"
              )}
            >
              {words}
            </button>
          )
        })}
      </div>
      <p className="text-[12px] text-ink-faint">{pinned === "play" ? "A short conversation, played with stand-in voices: no microphone is used." : `Held on ${MODE_WORDS[pinned]}. Choose Conversation to play them all.`}</p>
    </div>
  )
}
