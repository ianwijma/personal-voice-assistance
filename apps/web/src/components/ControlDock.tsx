"use client"
import { useEffect, useRef } from "react"
import { currentMicRms } from "@/lib/audio/levels.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "./context.tsx"
import { DockOverflow } from "./NewConversation.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"

const round = "inline-flex size-14 items-center justify-center rounded-full border transition-[background-color,border-color,color,opacity] duration-[120ms] ease-out disabled:cursor-not-allowed disabled:opacity-40 sm:size-12"

/** Mic (mute), Stop and Chat, centred at the bottom of the stage; on a phone also More (New conversation). */
export function ControlDock() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      owner: s.session.role === "owner" && (s.audio.phase === "running" || s.audio.phase === "suspended"),
      micLive: s.audio.micLive,
      open: s.connection.status === "open",
      canStop: s.session.serverState === "thinking" || s.session.serverState === "speaking" || s.audio.playing !== undefined,
      chatOpen: s.ui.chatOpen,
      unread: s.ui.unread > 0
    }),
    shallowEqual
  )
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
      <div role="toolbar" aria-label="Controls" className="pointer-events-auto flex items-center gap-4 sm:gap-3">
        {v.owner && (
          <>
            <button
              type="button"
              data-testid="mic-toggle"
              aria-label="Microphone (M)"
              aria-pressed={v.micLive}
              title={v.micLive ? "Mute (M)" : "Unmute (M)"}
              disabled={!v.open}
              onClick={() => client.setMicLive(!v.micLive)}
              className={cx(
                round,
                "relative",
                v.micLive ? "border-line bg-surface text-ink hover:bg-surface-2" : "border-line bg-surface-2 text-ink-faint hover:text-ink-muted"
              )}
            >
              {v.micLive && <MicRing />}
              <Icon name={v.micLive ? "mic" : "micOff"} />
            </button>
            <button
              type="button"
              data-testid="stop"
              aria-label="Stop the reply (Esc)"
              title="Stop (Esc)"
              disabled={!v.canStop || !v.open}
              onClick={client.stopReply}
              className={cx(
                round,
                v.canStop && v.open ? "border-voice/60 bg-voice-soft text-voice hover:border-voice" : "border-line bg-surface text-ink-faint opacity-60"
              )}
            >
              <Icon name="stop" />
            </button>
          </>
        )}
        <button
          type="button"
          data-testid="chat-toggle"
          aria-label={v.unread ? "Conversation (C), new replies" : "Conversation (C)"}
          aria-pressed={v.chatOpen}
          aria-haspopup="dialog"
          title="Conversation (C)"
          onClick={() => client.store.dispatch({ type: "local/ui", patch: { chatOpen: !v.chatOpen } })}
          className={cx(round, "relative border-line text-ink hover:bg-surface-2", v.chatOpen ? "bg-surface-2" : "bg-surface")}
        >
          <Icon name="chat" />
          {v.unread && !v.chatOpen && <span data-testid="unread-dot" className="absolute right-3 top-3 size-2 rounded-full bg-voice ring-2 ring-surface sm:right-2.5 sm:top-2.5" />}
        </button>
        <DockOverflow className="sm:hidden" />
      </div>
    </div>
  )
}

/** A mint ring that follows the microphone level, animated outside React. */
function MicRing() {
  const ring = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let level = 0
    let last = performance.now()
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = (now - last) / 1000
      last = now
      const target = Math.min(1, Math.sqrt(currentMicRms(now) * 6))
      level += (target - level) * (1 - Math.exp(-dt / (target > level ? 0.05 : 0.2)))
      const el = ring.current
      if (el === null) return
      const l = reduced ? Math.round(level * 3) / 3 : level
      el.style.transform = `scale(${1 + l * 0.22})`
      el.style.opacity = String(Math.min(1, 0.15 + l * 1.2))
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <span ref={ring} aria-hidden="true" className="pointer-events-none absolute -inset-[3px] rounded-full border-2 border-you opacity-0 will-change-transform" />
}
