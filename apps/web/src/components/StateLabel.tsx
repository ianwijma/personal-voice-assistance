"use client"
import { useEffect, useState } from "react"
import { displayPhrase, profileOf, visualState } from "@/lib/state.ts"
import { useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"
import { useHoldsAudio } from "./voice/useSessionFocus.ts"

/**
 * The label under the line. One line of fixed height, so nothing under it moves when the words change. Screen
 * readers hear only the changes that matter between replies (asleep, woke, mic off, connection and audio errors)
 * through a separate polite region; hearing / thinking / speaking are not announced (the reply announcer speaks the
 * reply itself).
 */
export function StateLabel() {
  const text = useClientState((s) => {
    const v = visualState(s)
    // Another device has the audio: what it hears is not this tab listening.
    if (v === "listening" && observing(s)) return "Listening on another device"
    switch (v) {
      case "disconnected":
        return s.connection.everConnected ? `Reconnecting · attempt ${s.connection.attempt}` : "Connecting"
      case "error":
        return s.connection.status === "outdated" ? "Page out of date" : "Audio error"
      case "not-started":
        return "Not started"
      case "speaking":
        return "Speaking"
      case "thinking":
        return "Thinking"
      case "muted":
        return "Mic off"
      case "hearing":
        return "Hearing you"
      case "listening":
        return s.woke !== undefined ? "Listening…" : "Listening"
      case "asleep": {
        const phrase = profileOf(s).wakePhrases[0]
        return phrase === undefined ? "Waiting for the wake phrase" : `Say “${displayPhrase(phrase)}”`
      }
      case "idle":
        return "Idle"
    }
  })
  const tone = useClientState((s) => {
    const v = visualState(s)
    if (v === "listening" && observing(s)) return "muted"
    return v === "speaking" || v === "thinking" ? "voice" : v === "hearing" || v === "listening" ? "you" : v === "error" ? "danger" : v === "asleep" ? "muted" : "faint"
  })
  // Room for the wake phrase on as many lines as it needs (up to six words), whatever the label says now, so nothing
  // under the line moves when the state changes. An invisible copy of the asleep label sets the box's height.
  const reserve = useClientState((s) => {
    const phrase = profileOf(s).activation === "wake-phrase" ? profileOf(s).wakePhrases[0] : undefined
    return phrase === undefined ? undefined : `Say “${displayPhrase(phrase)}”`
  })
  const colour = cx(
    tone === "voice" && "text-voice",
    tone === "you" && "text-you",
    tone === "danger" && "text-danger",
    tone === "muted" && "text-ink-muted",
    tone === "faint" && "text-ink-faint"
  )
  return (
    <div data-testid="state-label-box" className="mt-4 grid min-h-4 w-full max-w-[calc(100%-32px)] shrink-0 items-start justify-items-center short:mt-2">
      {reserve !== undefined && <span aria-hidden="true" className="label invisible col-start-1 row-start-1 select-none break-words text-center">{reserve}</span>}
      <p data-testid="state-label" className={cx("label col-start-1 row-start-1 break-words text-center transition-colors duration-[240ms] ease-out", colour)}>
        {text}
      </p>
    </div>
  )
}

/** This tab watches: another tab or device has the audio. */
const observing = (s: Parameters<typeof visualState>[0]) => s.session.ownerPresent && !(s.session.role === "owner" && s.audio.phase !== "off")

/**
 * The state changes that matter, for screen readers. Kept outside the stage so it is still heard while a modal
 * panel makes the page behind it inert.
 */
export function StateAnnouncer() {
  const holds = useHoldsAudio()
  const visual = useClientState((s) => visualState(s))
  // "Listening" once after Start and "Session ended" once after End; any other state replaces them, so the later
  // returns to plain listening (after a reply) say nothing.
  const [note, setNote] = useState<string | undefined>()
  const was = useState({ holds })[0]
  useEffect(() => {
    if (was.holds === holds) return
    was.holds = holds
    setNote(holds ? "Listening" : "Session ended")
  }, [holds, was])
  useEffect(() => {
    setNote((n) => (visual === "listening" || visual === "not-started" || visual === "idle" ? n : undefined))
  }, [visual])
  const announce = useClientState((s) => {
    const v = visualState(s)
    switch (v) {
      case "asleep": {
        const phrase = profileOf(s).wakePhrases[0]
        return phrase === undefined ? "Waiting for the wake phrase" : `Asleep. Say “${displayPhrase(phrase)}”`
      }
      case "listening":
        return s.woke !== undefined ? "Listening…" : ""
      case "muted":
        return "Mic off"
      case "error":
        return s.connection.status === "outdated" ? "Page out of date" : "Audio error"
      case "disconnected":
        return s.connection.everConnected ? "Connection lost, reconnecting" : ""
      default:
        return ""
    }
  })
  const spoken = announce !== "" ? announce : (note !== undefined && (note === "Listening") === holds && (visual === "listening" || visual === "not-started" || visual === "idle") ? note : "")
  return <p className="sr-only" aria-live="polite" data-testid="state-announcer">{spoken}</p>
}
