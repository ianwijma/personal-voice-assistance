"use client"
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react"
import { MAX_TEXT_INPUT_CHARS } from "@pva/protocol"
import { sessionsFullText } from "@/lib/sessions.ts"
import { shallowEqual } from "@/lib/store.ts"
import { nameOf, NO_ASSISTANT, viewedId } from "@/lib/voiceSetup.ts"
import { useClient, useClientState } from "./context.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"

export function Composer() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      open: s.connection.status === "open",
      ready: s.summary.ready,
      // Typed text goes to the conversation the chat shows.
      to: viewedId(s),
      name: nameOf(s, viewedId(s)),
      several: (s.setup?.assistants.length ?? 0) > 1,
      none: s.setup !== undefined && s.setup.assistants.length === 0
    }),
    shallowEqual
  )
  const [text, setText] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [sending, setSending] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = area.current
    if (el === null) return
    el.style.height = "auto"
    const line = 22
    el.style.height = `${Math.min(el.scrollHeight, line * 6 + 16)}px`
  }, [text])

  const blocked = !v.open ? "Not connected to the assistant." : v.none ? `${NO_ASSISTANT}.` : !v.ready ? "The assistant is not ready yet." : undefined

  const send = async () => {
    const value = text.trim()
    if (value === "" || blocked !== undefined || sending) return
    setSending(true)
    setError(undefined)
    const result = await client.sendText(value.slice(0, MAX_TEXT_INPUT_CHARS), v.to) // continuation(state): the box is cleared only if it still holds what was sent
    setSending(false)
    if (result.ok) setText((now) => (now.trim() === value ? "" : now))
    else if (result.error?.code === "sessions_full") setError(sessionsFullText(result.error.message))
    else setError(result.error?.message ?? "The message was not accepted.")
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    // The notification region reserves Stop's room first. Only the textarea shrinks/scrolls; its draft stays intact.
    <div className="flex min-h-[78px] shrink flex-col border-t border-line px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5">
      {(blocked ?? error) !== undefined && (
        <p role={error !== undefined ? "alert" : undefined} className={cx("px-2 pb-2 text-[13px]", error !== undefined && blocked === undefined ? "text-danger" : "text-ink-muted")}>
          {blocked ?? error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 items-end gap-2 rounded-md border border-line bg-surface-2/70 py-1 pl-3 pr-1 focus-within:border-you focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-you">
        <label htmlFor="chat-input" className="sr-only">{v.several ? `Message to ${v.name}` : "Message"}</label>
        <textarea
          id="chat-input"
          ref={area}
          rows={1}
          value={text}
          maxLength={MAX_TEXT_INPUT_CHARS}
          disabled={blocked !== undefined}
          placeholder={v.several ? `Type a message to ${v.name}` : "Type a message"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-full min-h-[38px] flex-1 resize-none bg-transparent py-2 text-base leading-[22px] sm:text-[15px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          aria-label="Send"
          data-testid="send"
          disabled={text.trim() === "" || blocked !== undefined || sending}
          onClick={() => void send()}
          className="mb-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-ink text-bg max-sm:size-11 transition-opacity duration-[120ms] disabled:opacity-25"
        >
          <Icon name="send" size={18} />
        </button>
      </div>
      <p className="mt-2 hidden px-1 text-[11px] text-ink-faint sm:block">Enter to send · Shift+Enter for a new line</p>
    </div>
  )
}
