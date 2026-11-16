"use client"
import { type RefObject, useEffect, useRef } from "react"
import type { Mode } from "@/characters/contract.ts"
import { type CharacterHost, type HostInput, startCharacterHost } from "@/characters/host.ts"
import type { VisualState } from "@/lib/state.ts"
import { useClient } from "./context.tsx"

/** The app's visual states are exactly the characters' modes (docs/CHARACTERS.md §4.3): this fails to compile if they drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const VISUAL_STATES_ARE_MODES: Same<VisualState, Mode> = true
void VISUAL_STATES_ARE_MODES

/**
 * The stage's canvas. React renders it once; the character host (`characters/host.ts`) draws on it outside
 * React, reading `input`, a mutable object updated in place when the visual state changes, and the browser's
 * character choice (`prefs.character`), followed live without a re-render. `stage`: the page's full-stage layer,
 * where the host puts the canvas of a character that asks for the whole stage (this canvas then stays, hidden, as
 * the box that character centres on).
 */
export function Visualiser({ state, owner, stage }: { readonly state: VisualState; readonly owner: boolean; readonly stage?: RefObject<HTMLElement | null> }) {
  const client = useClient()
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<HostInput>({ state, owner })
  input.current.state = state
  input.current.owner = owner
  useEffect(() => {
    if (canvas.current === null) return
    const prefs = client.prefs
    let choice = prefs.get().character
    // Refs are attached before effects run, so the layer is there when the host starts.
    const host = startCharacterHost(canvas.current, input.current, choice, { stage: stage?.current ?? null })
    const unsubscribe = prefs.subscribe(() => {
      const next = prefs.get().character
      if (next === choice) return
      choice = next
      host.setChoice(next)
    })
    // For tests and debugging in the console: `__pvaStage.debug()`.
    const w = window as unknown as { __pvaStage?: CharacterHost }
    w.__pvaStage = host
    return () => {
      unsubscribe()
      host.stop()
      if (w.__pvaStage === host) delete w.__pvaStage
    }
  }, [client, stage])
  return <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 size-full" />
}
