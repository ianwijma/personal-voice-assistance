"use client"
import { useClientState } from "./context.tsx"

/** Announces the final text of each assistant turn (not every clause) to screen readers. */
export function LiveAnnouncer() {
  const text = useClientState((s) => {
    for (let i = s.turns.length - 1; i >= 0; i--) {
      const t = s.turns[i]!
      if (t.outcome !== undefined && !t.fromHistory) return t.spoken ? t.clauses.map((c) => c.text).join(" ") : t.text
    }
    return ""
  })
  return <div className="sr-only" aria-live="polite" aria-atomic="true">{text}</div>
}
