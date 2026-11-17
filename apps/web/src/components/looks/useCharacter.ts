"use client"
import { useEffect, useState } from "react"
import { type Loaded, loadCharacter, loadedNow } from "@/characters/catalog.ts"

/**
 * One character's manifest, loaded on demand (`catalog.ts`): undefined while it loads or while `enabled` is false
 * (a card not scrolled into view yet).
 */
export const useCharacter = (id: string | undefined, enabled = true): Loaded | undefined => {
  const [state, setState] = useState<{ readonly id: string | undefined; readonly loaded: Loaded | undefined }>(() => ({ id, loaded: id === undefined ? undefined : loadedNow(id) }))
  useEffect(() => {
    if (id === undefined) return setState({ id, loaded: undefined })
    const now = loadedNow(id)
    if (now !== undefined) return setState({ id, loaded: now })
    if (!enabled) return
    let live = true
    // continuation(none): only this component's own state, dropped when it unmounts or the id changes
    void loadCharacter(id).then((loaded) => {
      if (live) setState({ id, loaded })
    })
    return () => {
      live = false
    }
  }, [id, enabled])
  return state.id === id ? state.loaded ?? (id === undefined ? undefined : loadedNow(id)) : id === undefined ? undefined : loadedNow(id)
}
