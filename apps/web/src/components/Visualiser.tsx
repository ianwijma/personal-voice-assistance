"use client"
import { type RefObject, useEffect, useRef } from "react"
import { type Tryout, tryoutFromSearch, withTryout } from "@/characters/choice.ts"
import type { CharacterChoice, Mode } from "@/characters/contract.ts"
import { type CharacterHost, type HostInput, startCharacterHost } from "@/characters/host.ts"
import { deepEqual } from "@/lib/assistants.ts"
import type { ClientState, VisualState } from "@/lib/state.ts"
import { stageLookOf } from "@/lib/voiceSetup.ts"
import { useClient } from "./context.tsx"

/** The app's visual states are exactly the characters' modes (docs/CHARACTERS.md §4.3): this fails to compile if they drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const VISUAL_STATES_ARE_MODES: Same<VisualState, Mode> = true
void VISUAL_STATES_ARE_MODES

/**
 * The address bar's try-out (`?character=<id>&opt.<id>=<value>`), read once per page load: its parameters then leave the
 * address bar, and it lasts until the page is reloaded (docs/LOOKS-AND-VOICES.md §3). Nothing is stored.
 */
let pageTryout: { readonly value: Tryout | undefined } | undefined
const takeTryout = (): Tryout | undefined => {
  if (pageTryout === undefined) {
    const asked = tryoutFromSearch(location.search)
    pageTryout = { value: asked?.tryout }
    if (asked !== undefined) history.replaceState(history.state, "", `${location.pathname}${asked.search}${location.hash}`)
  }
  return pageTryout.value
}

/** What the stage shows for `s`: the configured look (`stageLookOf`), with this page's try-out over it. */
export const stageChoiceOf = (s: ClientState, tryout: Tryout | undefined): CharacterChoice | undefined => withTryout(stageLookOf(s), tryout)

/**
 * The stage's canvas. React renders it once; the character host (`characters/host.ts`) draws on it outside
 * React, reading `input`, a mutable object updated in place when the visual state changes, and the look from the
 * device's setup (`stageLookOf`: the answering assistant's, or the device's own), followed live without a re-render:
 * another assistant taking the turn swaps the character in place (no blank frame). `stage`: the page's full-stage
 * layer, where the host puts the canvas of a character that asks for the whole stage (this canvas then stays,
 * hidden, as the box that character centres on).
 */
export function Visualiser({ state, owner, stage }: { readonly state: VisualState; readonly owner: boolean; readonly stage?: RefObject<HTMLElement | null> }) {
  const client = useClient()
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<HostInput>({ state, owner })
  input.current.state = state
  input.current.owner = owner
  useEffect(() => {
    if (canvas.current === null) return
    const tryout = takeTryout()
    const store = client.store
    let choice = stageChoiceOf(store.get(), tryout)
    // Refs are attached before effects run, so the layer is there when the host starts.
    const host = startCharacterHost(canvas.current, input.current, choice, { stage: stage?.current ?? null })
    const unsubscribe = store.subscribe(() => {
      const next = stageChoiceOf(store.get(), tryout)
      if (deepEqual(next, choice)) return
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
