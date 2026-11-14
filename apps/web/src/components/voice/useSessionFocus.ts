"use client"
import { useEffect, useRef } from "react"
import { useClientState } from "../context.tsx"

/** Does this page hold the audio (the dock shows the microphone button)? */
export const useHoldsAudio = () => useClientState((s) => s.session.role === "owner" && (s.audio.phase === "running" || s.audio.phase === "suspended"))

/**
 * Keeps keyboard focus on something after the session starts or ends. The Start button (or End session) disappears
 * with the state change and focus would drop to `<body>`: after Start it goes to the microphone button, after End to
 * the Start button. Only when focus was actually lost, so a user who moved on is not pulled back.
 */
export function useSessionFocus() {
  const holds = useHoldsAudio()
  const before = useRef(holds)
  useEffect(() => {
    if (before.current === holds) return
    before.current = holds
    const target = holds ? '[data-testid="mic-toggle"]' : '[data-testid="start"]'
    let frames = 0
    let raf = 0
    // The button that was focused (Start, End session) goes away a moment after the state changes, and the stage may
    // swap its notices once more before it settles: for half a second, whenever focus is lost, put it on the target.
    const prior = document.activeElement
    let mine: Element | null = null
    const attempt = () => {
      const active = document.activeElement
      const lost = active === null || active === document.body
      const keeping = (active === prior && prior !== null && prior !== document.body && prior.isConnected) || (active !== null && active === mine)
      if (!lost && !keeping) return // the user moved on
      if (lost) {
        const el = document.querySelector<HTMLElement>(target)
        if (el !== null) {
          el.focus({ preventScroll: true })
          mine = el
        }
      }
      if (++frames < 30) raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => cancelAnimationFrame(raf)
  }, [holds])
}
