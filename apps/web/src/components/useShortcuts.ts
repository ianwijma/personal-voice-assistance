"use client"
import { useEffect } from "react"
import { useClient } from "./context.tsx"

const typingTarget = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")

/** Single-key shortcuts (docs/UI-AND-MODULES.md §3.5); ignored while typing. Panels handle their own Esc first. */
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
        if (s.ui.settingsOpen) {
          // The settings screen handles Esc itself when focus is inside it (up a level); otherwise close.
          e.preventDefault()
          client.settings("close")
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
        case "o":
        case "O":
          e.preventDefault()
          client.settings(s.ui.settingsOpen ? "close" : s.ui.settingsPath)
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
