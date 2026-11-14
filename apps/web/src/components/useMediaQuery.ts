"use client"
import { useSyncExternalStore } from "react"

/** Whether a media query matches now, following changes (false during prerender). */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia?.(query)
      mq?.addEventListener("change", onChange)
      return () => mq?.removeEventListener("change", onChange)
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false
  )

/** The voice page's wide layout (the chat is a non-modal popover from here). */
export const WIDE_QUERY = "(min-width: 1024px)"
