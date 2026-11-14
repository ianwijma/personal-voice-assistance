"use client"
import { useEffect } from "react"
import { useClient } from "./context.tsx"
import { WIDE_QUERY } from "./useMediaQuery.ts"

const typingTarget = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")

/**
 * Single-key shortcuts (docs/UI-AND-MODULES.md §3.5); ignored while typing, and off when the viewer switched them off
 * in the help dialog (`prefs.shortcuts`). Panels handle their own Esc first.
 */
export const useShortcuts = () => {
  const client = useClient()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const s = client.store.get()
      const ui = (patch: Partial<typeof s.ui>) => client.store.dispatch({ type: "local/ui", patch })
      if (e.key === "Escape") {
        // Panels handle Esc themselves when focus is inside them; modal ones close even if it is not.
        if (s.ui.shortcutsOpen) {
          e.preventDefault()
          ui({ shortcutsOpen: false })
          return
        }
        if (s.ui.sheetOpen) {
          // The settings sheet handles Esc itself when focus is inside it; otherwise close it.
          e.preventDefault()
          ui({ sheetOpen: false })
          return
        }
        // Otherwise: stop the reply.
        if (s.session.serverState === "thinking" || s.session.serverState === "speaking" || s.audio.playing !== undefined) {
          e.preventDefault()
          client.stopReply()
        }
        return
      }
      if (typingTarget(e.target)) return
      // A modal panel is open (the settings sheet, Help, or the chat as a sheet below 1024 px): only its own keys
      // (Esc, above) work, so nothing opens underneath it and focus never moves behind it.
      if (s.ui.sheetOpen || s.ui.shortcutsOpen || (s.ui.chatOpen && !window.matchMedia(WIDE_QUERY).matches)) return
      // Single-character shortcuts can be switched off in the help dialog (WCAG 2.1.4); Esc always works.
      if (!client.prefs.get().shortcuts) return
      switch (e.key) {
        case "m":
        case "M":
          if (s.session.role === "owner" && s.audio.phase === "running") {
            e.preventDefault()
            client.setMicLive(!s.audio.micLive)
          }
          return
        case "c":
        case "C":
          e.preventDefault()
          ui({ chatOpen: !s.ui.chatOpen })
          return
        case "s":
        case "S":
          e.preventDefault()
          ui({ sheetOpen: !s.ui.sheetOpen })
          return
        case "/":
          e.preventDefault()
          ui({ chatOpen: true })
          requestAnimationFrame(() => document.getElementById("chat-input")?.focus())
          return
        case "?":
          e.preventDefault()
          ui({ shortcutsOpen: true })
          return
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [client])
}
