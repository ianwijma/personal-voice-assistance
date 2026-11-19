"use client"
import { createContext, type Dispatch, type SetStateAction, useContext, useId, useLayoutEffect, useRef } from "react"

/** Open page menus obscure ordinary presentations; notifications keep their separate fixed strip. */
export const PageMenus = createContext<{
  readonly surface: string
  readonly ids: ReadonlyArray<string>
  readonly set: Dispatch<SetStateAction<ReadonlyArray<string>>>
} | undefined>(undefined)

export const usePageMenu = (open: boolean, setOpen: Dispatch<SetStateAction<boolean>>): string => {
  const id = useId()
  const context = useContext(PageMenus)
  const set = context?.set
  const surface = context?.surface
  const previousSurface = useRef(surface)
  // A new dialog takes focus from a menu left open behind it.
  useLayoutEffect(() => {
    if (surface !== previousSurface.current) setOpen(false)
    previousSurface.current = surface
  }, [surface, setOpen])
  useLayoutEffect(() => {
    if (!open || set === undefined) return
    set((ids) => [...ids, id])
    return () => set((ids) => ids.filter((x) => x !== id))
  }, [open, id, set])
  return id
}
