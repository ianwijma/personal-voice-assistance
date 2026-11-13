"use client"
import { useEffect, useRef } from "react"
import type { VisualState } from "@/lib/state.ts"
import { startVisualiser, type VisualInput } from "@/lib/visualiser.ts"

/**
 * The canvas. React renders it once; the animation reads `input`, a mutable
 * object updated in place when the visual state changes (no re-render per frame).
 */
export function Visualiser({ state, owner }: { readonly state: VisualState; readonly owner: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<VisualInput>({ state, owner })
  input.current.state = state
  input.current.owner = owner
  useEffect(() => {
    if (canvas.current === null) return
    const handle = startVisualiser(canvas.current, input.current)
    return handle.stop
  }, [])
  return <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 size-full" />
}
