"use client"
import { useRef } from "react"
import { profileOf, turnById, visualState } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"

interface Caption {
  readonly kind: "you" | "voice"
  readonly main: string
  readonly next: string
}

const tail = (text: string, max = 150) => (text.length <= max ? text : `…${text.slice(text.length - max).replace(/^\S*\s/, "")}`)

/** Captions: what you are saying while hearing, the playing clause (and the next one) while speaking. Fade 2 s after. */
export function Captions() {
  const enabled = useClientState((s) => profileOf(s).captions)
  const reserve = useClientState((s) => s.connection.status === "open" && ((s.session.role === "owner" && s.audio.phase !== "off") || s.session.ownerPresent))
  const caption = useClientState((s): Caption | null => {
    const v = visualState(s)
    if (v === "hearing" && s.liveTranscript !== "") return { kind: "you", main: tail(s.liveTranscript), next: "" }
    if (v === "speaking") {
      const t = turnById(s, s.audio.playing?.turnId ?? s.session.stateTurnId)
      if (t === undefined || t.clauses.length === 0) return null
      const i = Math.max(0, t.playedClause)
      return { kind: "voice", main: t.clauses[i]?.text ?? "", next: t.clauses[i + 1]?.text ?? "" }
    }
    return null
  }, shallowEqual)
  const last = useRef<Caption | null>(null)
  if (caption !== null) last.current = caption
  const shown = caption ?? last.current
  if (!enabled || (!reserve && caption === null)) return null
  return (
    <div
      data-testid="captions"
      className={cx(
        // Two lines are reserved, so nothing under them moves when they appear; smaller on a short screen.
        "mt-3 min-h-[3.2em] w-full max-w-[640px] px-6 text-center text-[16px] leading-[1.45] sm:text-caption short:mt-2 short:min-h-[2.9em] short:text-[16px]",
        "transition-opacity ease-out",
        caption !== null ? "opacity-100 duration-[240ms]" : "opacity-0 delay-[2000ms] duration-500"
      )}
    >
      {shown !== null && (
        <p className="line-clamp-2 text-balance">
          <span className={shown.kind === "you" ? "text-you" : "text-ink"}>{shown.main}</span>
          {shown.next !== "" && <span className="text-ink-muted"> {shown.next}</span>}
        </p>
      )}
    </div>
  )
}
