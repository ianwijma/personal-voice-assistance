"use client"
import { speakingVoice, visualState } from "@/lib/state.ts"
import { useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"

/** The label under the line; the one polite announcement of state changes. */
export function StateLabel() {
  const text = useClientState((s) => {
    const v = visualState(s)
    switch (v) {
      case "disconnected":
        return s.connection.everConnected ? `Reconnecting · ${s.connection.attempt}` : "Connecting"
      case "error":
        return s.connection.status === "outdated" ? "Not connected" : "Audio error"
      case "not-started":
        return "Not started"
      case "speaking": {
        const voice = speakingVoice(s)
        return voice === undefined ? "Speaking" : `Speaking · ${voice}`
      }
      case "thinking":
        return "Thinking"
      case "muted":
        return "Mic off"
      case "hearing":
        return "Hearing you"
      case "listening":
        return "Listening"
      case "idle":
        return s.session.ownerPresent ? "Idle" : "Idle"
    }
  })
  const tone = useClientState((s) => {
    const v = visualState(s)
    return v === "speaking" || v === "thinking" ? "voice" : v === "hearing" || v === "listening" ? "you" : v === "error" ? "danger" : "faint"
  })
  return (
    <p
      aria-live="polite"
      data-testid="state-label"
      className={cx(
        "label mt-4 transition-colors duration-[240ms] ease-out",
        tone === "voice" && "text-voice",
        tone === "you" && "text-you",
        tone === "danger" && "text-danger",
        tone === "faint" && "text-ink-faint"
      )}
    >
      {text}
    </p>
  )
}
