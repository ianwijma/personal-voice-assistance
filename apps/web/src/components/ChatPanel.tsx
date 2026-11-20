"use client"
import { useEffect, useRef } from "react"
import { visualState } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { answeringId, conversationNote, exchangesOf, nameOf, needsRead, viewedId } from "@/lib/voiceSetup.ts"
import { Composer } from "./Composer.tsx"
import { useClient, useClientState } from "./context.tsx"
import { MessageList } from "./MessageList.tsx"
import { NewConversationButton } from "./NewConversation.tsx"
import { Icon } from "./ui/Icon.tsx"
import { useDialog } from "./ui/Panel.tsx"
import { PopMenu } from "./voice/PopMenu.tsx"
import { useKeyboardInset } from "./useKeyboardInset.ts"
import { useMediaQuery, WIDE_QUERY } from "./useMediaQuery.ts"

/**
 * The conversation: a popover in the bottom right on desktop (not modal: Tab goes on to the page, so mute and stop
 * stay in reach), a right sheet on tablets and a bottom sheet on phones (modal: focus is kept inside, the page behind
 * is inert). One conversation per assistant: with several, the header names the one shown and switches it
 * (docs/ASSISTANTS.md §7.2).
 */
export function ChatPanel() {
  const client = useClient()
  const open = useClientState((s) => s.ui.chatOpen)
  const covered = useClientState((s) => s.ui.sheetOpen || s.ui.shortcutsOpen)
  // P5 round 3: a session the server ended takes the draft with it (the composer starts afresh); round 4: the message
  // list's scroll state too (it starts at the bottom of the new session).
  const sessionSeq = useClientState((s) => s.sessionSeq)
  const ref = useRef<HTMLElement>(null)
  const close = () => client.store.dispatch({ type: "local/ui", patch: { chatOpen: false } })
  const modal = !useMediaQuery(WIDE_QUERY)
  useDialog(ref, open && !covered, close, "#chat-input", { trap: modal, extraFocus: "#voice-notifications" })
  // Phone: the bottom sheet rides above the on-screen keyboard and shrinks to fit what is left.
  const inset = useKeyboardInset()
  const lift = inset > 0 && typeof window !== "undefined" && window.innerWidth < 640
  // A conversation the page does not hold yet (another assistant's, or the answering one after a pick) is asked for.
  const want = useClientState((s) => ({ id: viewedId(s), need: needsRead(s, viewedId(s)), online: s.connection.status === "open" }), shallowEqual)
  useEffect(() => {
    if (open && want.online && want.need && want.id !== undefined) client.readConversation(want.id)
  }, [client, open, want.online, want.need, want.id])
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-30 bg-bg/50 lg:hidden" onClick={close} aria-hidden="true" />
      <aside
        ref={ref}
        role="dialog"
        aria-modal={modal || undefined}
        aria-owns={covered ? undefined : "voice-notifications"}
        aria-labelledby="chat-title"
        data-testid="chat-panel"
        style={lift ? { bottom: inset, height: `min(85dvh, calc(100dvh - ${inset + 16}px - var(--pva-notifications-space, 88px)))` } : undefined}
        className={[
          "fixed z-40 flex flex-col overflow-hidden border-line bg-surface shadow-panel",
          // phone: bottom sheet
          "inset-x-0 bottom-0 h-[min(85dvh,calc(100dvh-var(--pva-notifications-space,88px)))] rounded-t-lg border-t animate-[pva-sheet-up_320ms_var(--ease-out)]",
          // tablet: right sheet
          "sm:inset-x-auto sm:right-0 sm:top-[var(--pva-notifications-space,88px)] sm:h-[calc(100dvh-var(--pva-notifications-space,88px))] sm:w-[400px] sm:rounded-none sm:border-l sm:border-t-0 sm:animate-[pva-slide-in_320ms_var(--ease-out)]",
          // desktop: popover
          "lg:bottom-6 lg:right-6 lg:top-auto lg:h-[min(640px,calc(100dvh-var(--pva-notifications-space,88px)-32px))] lg:rounded-lg lg:border lg:animate-[pva-rise_240ms_var(--ease-out)]"
        ].join(" ")}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line pl-5 pr-2">
          <ChatTitle />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <NewConversationButton />
            <button
              type="button"
              aria-label="Close conversation"
              onClick={close}
              className="inline-flex size-11 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
        <ConversationNote />
        <MessageList key={`list-${sessionSeq}`} />
        <Composer key={`composer-${sessionSeq}`} />
      </aside>
    </>
  )
}

interface SwitchItem {
  readonly value: string
  readonly title: string
  readonly detail: string
  readonly checked: boolean
}

/** "Conversation", or with several assistants "Conversation with Jeff" and a menu of the others' conversations. */
function ChatTitle() {
  const client = useClient()
  const v = useClientState(
    (s) => {
      const viewed = viewedId(s)
      const started = visualState(s) !== "not-started"
      const items: ReadonlyArray<SwitchItem> =
        s.setup?.assistants.map((a) => {
          const n = exchangesOf(s, a.id)
          return { value: a.id, title: a.name, detail: a.id === answeringId(s) && started ? "Answers when you speak" : `${n} ${n === 1 ? "exchange" : "exchanges"}`, checked: a.id === viewed }
        }) ?? []
      return { several: items.length > 1, name: nameOf(s, viewed), items: JSON.stringify(items) }
    },
    shallowEqual
  )
  if (!v.several) return <h2 id="chat-title" className="label min-w-0 text-ink-muted">Conversation</h2>
  return (
    <div className="min-w-0 flex-1">
      <h2 id="chat-title" className="sr-only">Conversation with {v.name}</h2>
      <PopMenu
        testId="conversation-switcher"
        label={`Conversation with ${v.name}`}
        title="Read another assistant's conversation"
        menuLabel="Conversations on this device"
        note="Reading a conversation does not change who answers."
        items={JSON.parse(v.items) as ReadonlyArray<SwitchItem>}
        triggerClass="-ml-2 h-11 px-2 text-ink-muted hover:text-ink"
        menuClass="top-[calc(100%+2px)] -left-2"
        onPick={(id) => {
          client.store.dispatch({ type: "local/ui", patch: { chatView: id } })
          // One the page already holds is asked for again (it may have moved on); one it does not is asked for by the effect above.
          if (!needsRead(client.store.get(), id)) client.readConversation(id)
        }}
      >
        {null}
      </PopMenu>
    </div>
  )
}

/** Under the header with several assistants: where typed text and speech go. */
function ConversationNote() {
  const text = useClientState((s) => ((s.setup?.assistants.length ?? 0) > 1 ? conversationNote(s, visualState(s) !== "not-started") : ""))
  if (text === "") return null
  return <p data-testid="conversation-note" className="shrink-0 border-b border-line/60 px-5 py-2.5 text-[12px] text-ink-faint">{text}</p>
}
