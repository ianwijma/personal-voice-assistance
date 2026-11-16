"use client"
import { memo, useLayoutEffect, useRef, useState } from "react"
import type { TurnView } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { nameOf, turnsOf, viewedId } from "@/lib/voiceSetup.ts"
import { useClientState } from "./context.tsx"
import { ToolChip } from "./ToolChip.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"

/** The conversation as a transcript, oldest first; sticks to the bottom unless you scrolled up. */
export function MessageList() {
  // One conversation per assistant: the chat shows the one the header names (docs/ASSISTANTS.md §7.2).
  const turns = useClientState((s) => turnsOf(s, viewedId(s)), shallowEqual)
  const divider = useClientState((s) => s.conversations[viewedId(s) ?? ""]?.divider)
  const loaded = useClientState((s) => s.conversations[viewedId(s) ?? ""]?.loaded !== false)
  const name = useClientState((s) => nameOf(s, viewedId(s)))
  const live = useClientState((s) => s.liveTranscript)
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const onScroll = () => {
    const el = scroller.current
    if (el === null) return
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    if (stuck.current) setShowJump(false)
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (el === null) return
    if (stuck.current) el.scrollTop = el.scrollHeight
    else setShowJump(true)
  }, [turns, live])
  const jump = () => {
    const el = scroller.current
    if (el === null) return
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
    stuck.current = true
    setShowJump(false)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} data-testid="messages" className="h-full overflow-y-auto px-5 py-4 scrollbar-quiet">
        {/* Polite: a new conversation started by another tab of this device, or after a quiet while, is announced. */}
        <div aria-live="polite">
          {divider !== undefined && (
            <p data-testid="conversation-divider" data-reason={divider} className="mb-5 flex items-center gap-3 text-center text-[12px] text-ink-faint">
              <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-line" />
              <span>{divider === "idle" ? "New conversation — it had been quiet for a while" : "New conversation"}</span>
              <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-line" />
            </p>
          )}
        </div>
        {turns.length === 0 && live === "" && (
          <p className="mt-8 text-center text-[14px] text-ink-faint">{loaded ? "Nothing said yet. Talk, or type below." : "Loading the conversation…"}</p>
        )}
        <ol className="flex flex-col gap-5">
          {turns.map((t) => <TurnBlock key={t.key} turn={t} name={name} />)}
          {live !== "" && (
            <li data-testid="live-transcript" className="border-l-2 border-you/50 pl-3 text-[15px] italic text-you">
              {live}
            </li>
          )}
        </ol>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1 text-[12px] text-ink shadow-panel"
        >
          <Icon name="arrowDown" size={14} /> Jump to latest
        </button>
      )}
    </div>
  )
}

const TurnBlock = memo(function TurnBlock({ turn, name }: { readonly turn: TurnView; readonly name: string }) {
  const hasReply = turn.clauses.length > 0 || turn.text !== "" || turn.tools.length > 0 || turn.error !== undefined || turn.outcome !== undefined
  return (
    <li className="flex flex-col gap-3" data-testid="turn" data-turn-id={turn.turnId} data-outcome={turn.outcome}>
      {turn.userText !== "" && (
        <div className="border-l-2 border-you pl-3">
          <div className="label flex items-center gap-1.5 text-you">
            You
            {turn.source === "text" && <Icon name="keyboard" size={13} aria-label="typed" className="text-ink-faint" />}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-[15px] text-ink">{turn.userText}</p>
        </div>
      )}
      {hasReply && <AssistantMessage turn={turn} name={name} />}
    </li>
  )
})

function AssistantMessage({ turn, name }: { readonly turn: TurnView; readonly name: string }) {
  const interrupted = turn.outcome === "interrupted"
  const allPlayed = turn.outcome === "completed" || turn.fromHistory === true
  return (
    <div className="border-l-2 border-voice pl-3" data-testid="assistant-message">
      <div className="flex items-center gap-2">
        <span className="label text-voice" data-testid="assistant-label">{name}</span>
      </div>
      {turn.tools.length > 0 && (
        <div className="mt-1.5 flex flex-col items-start gap-1">
          {turn.tools.map((t) => <ToolChip key={t.callId} tool={t} />)}
        </div>
      )}
      {turn.spoken && turn.clauses.length > 0 ? (
        <p className="mt-1 text-[15px]">
          {turn.clauses.map((c, i) => {
            const played = allPlayed || i <= turn.playedClause
            return (
              <span
                key={i}
                data-played={played || undefined}
                className={cx("transition-colors duration-[240ms] ease-out", played ? "text-ink" : interrupted ? "text-ink-faint" : "text-ink-muted")}
              >
                {i > 0 ? " " : ""}{c.text}
              </span>
            )
          })}
        </p>
      ) : turn.text !== "" ? (
        <p className="mt-1 whitespace-pre-wrap text-[15px] text-ink">{turn.text}</p>
      ) : turn.outcome === undefined ? (
        <p className="mt-1 text-[15px] text-ink-faint" aria-label="working">…</p>
      ) : null}
      {interrupted && <span data-testid="interrupted-tag" className="label mt-1.5 inline-block text-[10px] text-ink-faint">Interrupted</span>}
      {turn.outcome === "failed" && turn.error === undefined && <p className="mt-1.5 text-[13px] text-danger">The reply failed.</p>}
      {turn.error !== undefined && <p className="mt-1.5 text-[13px] text-danger">{turn.error}</p>}
    </div>
  )
}
