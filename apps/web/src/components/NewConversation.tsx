"use client"
import { useEffect, useRef, useState } from "react"
import { useClient, useClientState } from "./context.tsx"
import { Icon, Spinner } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"

/**
 * New conversation (docs/VOICE-SESSIONS.md §5): asks nothing, sends `conversation.new`; the chat empties when the
 * server's `conversation` message arrives (the reducer), so every tab of this device shows the same thing.
 * `announce`: say so with a toast (used where the chat is not on screen).
 */
const useNewConversation = (announce: boolean) => {
  const client = useClient()
  const open = useClientState((s) => s.connection.status === "open")
  const [busy, setBusy] = useState(false)
  const start = async () => {
    if (busy || !open) return
    setBusy(true)
    const result = await client.newConversation() // continuation(none): only this control's own state and a toast
    setBusy(false)
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "A new conversation could not be started.", tone: "error" })
    else if (announce && !client.store.get().ui.chatOpen) client.store.dispatch({ type: "local/toast", message: "Started a new conversation.", tone: "info" })
  }
  return { busy, disabled: busy || !open, start }
}

/** In the chat panel's header: icon + label (icon only on the narrowest phones, where the title needs the room). */
export function NewConversationButton() {
  const v = useNewConversation(false)
  return (
    <button
      type="button"
      data-testid="new-conversation"
      onClick={() => void v.start()}
      disabled={v.disabled}
      aria-label="New conversation"
      title="Start a new conversation: the assistant forgets this one"
      className="inline-flex h-11 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink disabled:opacity-40"
    >
      {v.busy ? <Spinner size={16} /> : <Icon name="newChat" size={18} />}
      <span className="max-[360px]:sr-only">New conversation</span>
    </button>
  )
}

/**
 * The control dock's overflow on a phone (below 640 px): a "More" button with a small menu above it. Wider screens
 * have the chat panel's header button in reach, so the dock stays as it is there.
 */
export function DockOverflow({ className }: { readonly className: string }) {
  const v = useNewConversation(true)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const item = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    item.current?.focus()
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return
        e.stopPropagation()
        e.preventDefault()
        setOpen(false)
        trigger.current?.focus()
        return
      }
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", close, true) // continuation(none): only closes this menu
    document.addEventListener("pointerdown", close, true) // continuation(none): only closes this menu
    return () => {
      document.removeEventListener("keydown", close, true)
      document.removeEventListener("pointerdown", close, true)
    }
  }, [open])
  return (
    <div ref={wrap} className={cx("relative", className)}>
      <button
        ref={trigger}
        type="button"
        data-testid="dock-more"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "inline-flex size-14 items-center justify-center rounded-full border border-line text-ink transition-[background-color] duration-[120ms] ease-out hover:bg-surface-2",
          open ? "bg-surface-2" : "bg-surface"
        )}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="More"
          data-testid="dock-menu"
          onKeyDown={(e) => {
            if (e.key === "Tab") setOpen(false)
          }}
          className="absolute bottom-full right-0 mb-3 w-max min-w-48 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-panel animate-[pva-rise_160ms_var(--ease-out)]"
        >
          <button
            ref={item}
            type="button"
            role="menuitem"
            data-testid="dock-new-conversation"
            disabled={v.disabled}
            onClick={() => {
              setOpen(false)
              trigger.current?.focus()
              void v.start()
            }}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-[15px] text-ink transition-colors duration-[120ms] hover:bg-surface-2 disabled:opacity-40"
          >
            <Icon name="newChat" size={18} className="text-ink-muted" />
            New conversation
          </button>
        </div>
      )}
    </div>
  )
}
