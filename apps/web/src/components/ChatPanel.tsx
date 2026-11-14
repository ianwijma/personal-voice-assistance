"use client"
import { useRef } from "react"
import { Composer } from "./Composer.tsx"
import { useClient, useClientState } from "./context.tsx"
import { MessageList } from "./MessageList.tsx"
import { NewConversationButton } from "./NewConversation.tsx"
import { PanelHeader, useDialog } from "./ui/Panel.tsx"
import { useKeyboardInset } from "./useKeyboardInset.ts"
import { useMediaQuery, WIDE_QUERY } from "./useMediaQuery.ts"

/**
 * The conversation: a popover in the bottom right on desktop (not modal: Tab goes on to the page, so mute and stop
 * stay in reach), a right sheet on tablets and a bottom sheet on phones (modal: focus is kept inside, the page behind
 * is inert).
 */
export function ChatPanel() {
  const client = useClient()
  const open = useClientState((s) => s.ui.chatOpen)
  const ref = useRef<HTMLElement>(null)
  const close = () => client.store.dispatch({ type: "local/ui", patch: { chatOpen: false } })
  const modal = !useMediaQuery(WIDE_QUERY)
  useDialog(ref, open, close, "#chat-input", { trap: modal })
  // Phone: the bottom sheet rides above the on-screen keyboard and shrinks to fit what is left.
  const inset = useKeyboardInset()
  const lift = inset > 0 && typeof window !== "undefined" && window.innerWidth < 640
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-30 bg-bg/50 lg:hidden" onClick={close} aria-hidden="true" />
      <aside
        ref={ref}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby="chat-title"
        data-testid="chat-panel"
        style={lift ? { bottom: inset, height: `min(85dvh, calc(100dvh - ${inset + 16}px))` } : undefined}
        className={[
          "fixed z-40 flex flex-col overflow-hidden border-line bg-surface shadow-panel",
          // phone: bottom sheet
          "inset-x-0 bottom-0 h-[85dvh] rounded-t-lg border-t animate-[pva-sheet-up_320ms_var(--ease-out)]",
          // tablet: right sheet
          "sm:inset-x-auto sm:right-0 sm:top-0 sm:h-dvh sm:w-[400px] sm:rounded-none sm:border-l sm:border-t-0 sm:animate-[pva-slide-in_320ms_var(--ease-out)]",
          // desktop: popover
          "lg:bottom-6 lg:right-6 lg:top-auto lg:h-[min(640px,calc(100dvh-120px))] lg:rounded-lg lg:border lg:animate-[pva-rise_240ms_var(--ease-out)]"
        ].join(" ")}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <PanelHeader title="Conversation" titleId="chat-title" onClose={close}>
          <NewConversationButton />
        </PanelHeader>
        <MessageList />
        <Composer />
      </aside>
    </>
  )
}
