"use client"
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react"
import { MAX_TEXT_INPUT_CHARS } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState, usePrefs } from "./context.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"

export function Composer() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      open: s.connection.status === "open",
      engine: s.engine.state,
      owner: s.session.role === "owner" && s.audio.phase !== "off"
    }),
    shallowEqual
  )
  const speak = usePrefs((p) => p.speakReplies)
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

  const blocked = !v.open ? "Not connected to the assistant." : v.engine !== "ready" ? (v.engine === "failed" ? "The assistant's engines are not running. See Options → Assistant." : "The assistant is starting its engines…") : undefined

  const send = async () => {
    const value = text.trim()
    if (value === "" || blocked !== undefined || sending) return
    setSending(true)
    setError(undefined)
    const result = await client.sendText(value.slice(0, MAX_TEXT_INPUT_CHARS)) // continuation(state): the box is cleared only if it still holds what was sent
    setSending(false)
    if (result.ok) setText((now) => (now.trim() === value ? "" : now))
    else setError(result.error?.message ?? "The message was not accepted.")
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="shrink-0 border-t border-line px-3 pb-3 pt-2.5">
      {(blocked ?? error) !== undefined && (
        <p role={error !== undefined ? "alert" : undefined} className={cx("px-2 pb-2 text-[13px]", error !== undefined && blocked === undefined ? "text-danger" : "text-ink-muted")}>
          {blocked ?? error}
        </p>
      )}
      <div className="flex items-end gap-2 rounded-md border border-line bg-surface-2/70 py-1 pl-3 pr-1 focus-within:border-ink-faint">
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <textarea
          id="chat-input"
          ref={area}
          rows={1}
          value={text}
          maxLength={MAX_TEXT_INPUT_CHARS}
          disabled={blocked !== undefined}
          placeholder="Type a message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-[148px] min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-[22px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          aria-label="Send"
          data-testid="send"
          disabled={text.trim() === "" || blocked !== undefined || sending}
          onClick={() => void send()}
          className="mb-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-ink text-bg transition-opacity duration-[120ms] disabled:opacity-25"
        >
          <Icon name="send" size={18} />
        </button>
      </div>
      {v.owner && (
        <div className="mt-2 flex items-center px-1">
          <button
            type="button"
            role="switch"
            aria-checked={speak}
            onClick={() => client.setPrefs({ speakReplies: !speak })}
            className={cx("inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] transition-colors", speak ? "text-ink-muted hover:text-ink" : "text-ink-faint hover:text-ink-muted")}
          >
            <Icon name={speak ? "speaker" : "speakerOff"} size={15} />
            Speak replies
          </button>
          <span className="ml-auto hidden text-[11px] text-ink-faint sm:inline">Enter to send · Shift+Enter for a new line</span>
        </div>
      )}
    </div>
  )
}
