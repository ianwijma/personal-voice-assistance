"use client"
import { type ClientState, ringingCard } from "@/lib/state.ts"
import { useClient, useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"

/**
 * P9: the notification cards of this device (docs/NOTIFICATIONS.md "The voice page"): a plain card per notification the
 * server says to show, with its title, its text and its buttons (`stop` first). Every word on it comes from the server,
 * in the household's language (the card's `texts` and labels). Since P10 it is drawn first in the presentation stage
 * (`PresentationStage.tsx`), or inside narrow chat so its modal focus scope includes Stop. Both regions scroll within
 * the viewport (every Stop reachable, long text wrapped), so every character keeps drawing exactly as before
 * (docs/CHARACTERS.md). A press goes to the server (`notification.action`):
 * Stop is always usable, a module action disables only its own button while it is pending, and an answer that comes
 * after the card is gone is ignored. Pending actions and replies live with the held notification across placements;
 * inside chat the region may shrink as well as scroll to leave the composer reachable.
 */
export function NotificationCards({ inChat = false }: { readonly inChat?: boolean }) {
  const cards = useClientState((s) => s.notifications)
  const audioOn = useClientState((s) => s.audio.phase === "running")
  const shown = cards.filter((c) => c.show)
  if (shown.length === 0) return null
  return (
    <section
      aria-label={shown[0]!.texts.region}
      data-testid="notification-cards"
      className={cx("flex max-h-[max(160px,min(42dvh,calc(100dvh-540px)))] min-h-0 w-full flex-col items-center gap-2 overflow-y-auto overscroll-contain", inChat ? "shrink" : "shrink-0")}
    >
      {shown.map((card) => <Card key={card.id} card={card} audioOn={audioOn} />)}
    </section>
  )
}

function Card({ card, audioOn }: { readonly card: ClientState["notifications"][number]; readonly audioOn: boolean }) {
  const client = useClient()
  const press = (actionId: string) => {
    if (actionId !== "stop" && card.pendingActions?.some((p) => p.actionId === actionId)) return
    const press = { actionId }
    client.store.dispatch({ type: "local/notification-pressed", id: card.id, press })
    // The exact pending request belongs to this holding, even if chat moves its component. After withdrawal its
    // completion is ignored, including when the server has shown the same notification id again in the meantime.
    void client.request({ type: "notification.action", id: card.id, actionId }).then((r) => {
      client.store.dispatch({ type: "local/notification-answered", id: card.id, press, answer: { say: r.say ?? (r.ok ? undefined : r.error?.message) } })
    }, () => client.store.dispatch({ type: "local/notification-answered", id: card.id, press }))
  }
  const ringing = ringingCard(card)
  return (
    <article
      role={ringing ? "alert" : "status"}
      data-testid="notification-card"
      data-ringing={ringing || undefined}
      className="w-full shrink-0 rounded-lg border border-line bg-surface px-4 py-3 text-ink shadow-panel animate-[pva-rise_200ms_var(--ease-out)]"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={cx("mt-[7px] size-2 shrink-0 rounded-full", ringing ? "bg-voice animate-pulse" : "bg-ink-faint")} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-medium [overflow-wrap:anywhere]">{card.title}</h2>
          {card.text !== undefined ? <p className="mt-0.5 text-[14px] text-ink-muted [overflow-wrap:anywhere]">{card.text}</p> : null}
          {ringing && !audioOn ? <p className="mt-1 text-[12px] text-ink-faint" data-testid="notification-silent-note">{card.texts.startAudio}</p> : null}
          {card.said !== undefined ? <p className="mt-1 text-[13px] text-ink-muted [overflow-wrap:anywhere]" role="status">{card.said}</p> : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {card.actions.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={a.id !== "stop" && card.pendingActions?.some((p) => p.actionId === a.id)}
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
