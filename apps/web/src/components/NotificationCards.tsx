"use client"
import { useState } from "react"
import type { ClientState } from "@/lib/state.ts"
import { useClient, useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"

/**
 * P9: the notification cards of this device (docs/NOTIFICATIONS.md "The voice page"): a plain card per notification
 * with its title, its text and its buttons (`stop` first, in the household's language, as the server sent them).
 * Outside the character's stage, above the dock, so every character keeps drawing exactly as before
 * (docs/CHARACTERS.md); P10 moves it into its presentation stage. A press goes to the server (`notification.action`)
 * and its answer is shown on the card until the server takes it down.
 */
export function NotificationCards() {
  const cards = useClientState((s) => s.notifications)
  const audioOn = useClientState((s) => s.audio.phase === "running")
  if (cards.length === 0) return null
  return (
    <section
      aria-label="Notifications"
      data-testid="notification-cards"
      className="pointer-events-none fixed inset-x-0 top-[calc(64px+env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4"
    >
      {cards.map((card) => <Card key={card.id} card={card} audioOn={audioOn} />)}
    </section>
  )
}

function Card({ card, audioOn }: { readonly card: ClientState["notifications"][number]; readonly audioOn: boolean }) {
  const client = useClient()
  const [said, setSaid] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const press = (actionId: string) => {
    setBusy(true)
    client.store.dispatch({ type: "local/notification-pressed", id: card.id })
    // continuation(identity): shows this card's own answer; the card goes when the server resolves it.
    void client.request({ type: "notification.action", id: card.id, actionId }).then((r) => {
      setBusy(false)
      setSaid(r.say ?? (r.ok ? undefined : r.error?.message))
    }, () => setBusy(false))
  }
  const ringing = card.priority === "ring" && !card.silent && card.quiet !== true
  return (
    <article
      role={ringing ? "alert" : "status"}
      data-testid="notification-card"
      data-ringing={ringing || undefined}
      className="pointer-events-auto w-full max-w-[420px] rounded-lg border border-line bg-surface px-4 py-3 text-ink shadow-panel animate-[pva-rise_200ms_var(--ease-out)]"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={cx("mt-[7px] size-2 shrink-0 rounded-full", ringing ? "bg-voice animate-pulse" : "bg-ink-faint")} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-medium">{card.title}</h2>
          {card.text !== undefined ? <p className="mt-0.5 text-[14px] text-ink-muted">{card.text}</p> : null}
          {ringing && !audioOn ? <p className="mt-1 text-[12px] text-ink-faint" data-testid="notification-silent-note">Start audio to hear it.</p> : null}
          {said !== undefined ? <p className="mt-1 text-[13px] text-ink-muted" role="status">{said}</p> : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {card.actions.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={busy}
            data-action={a.id}
            onClick={() => press(a.id)}
            className={cx(
              "inline-flex min-h-11 items-center rounded-md border px-4 text-[14px]",
              a.id === "stop" ? "border-transparent bg-ink text-surface" : "border-line bg-surface text-ink hover:bg-surface-2"
            )}
          >
            {a.label}
          </button>
        ))}
      </div>
    </article>
  )
}
