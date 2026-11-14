"use client"
import { type RefObject, useState } from "react"
import { stateWord, talkingSessions } from "@/lib/sessions.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { cx, ToneDot } from "../ui/controls.tsx"
import { useHref } from "../useHref.ts"

/**
 * What the assistant is doing, as one short line: connection, engines, then the devices talking to it (protocol 6:
 * from the voice sessions; one device says its state, several say how many).
 */
const useAssistantLine = () =>
  useClientState(
    (s) => {
      if (s.connection.status !== "open") {
        return { text: s.connection.everConnected ? `reconnecting · attempt ${s.connection.attempt}` : "connecting…", tone: "warning" as const }
      }
      if (s.engine.state === "failed") return { text: "engines failed", tone: "error" as const }
      if (s.engine.state !== "ready") return { text: s.engine.state === "reloading" ? "reloading engines…" : "starting engines…", tone: "warning" as const }
      const talking = talkingSessions(s.sessions)
      if (talking.length === 0) return { text: "ready · no device is listening", tone: "neutral" as const }
      if (talking.length > 1) {
        const busy = talking.filter((x) => x.state === "thinking" || x.state === "speaking").length
        return { text: `talking on ${talking.length} devices${busy > 0 ? ` · ${busy} answering` : ""}`, tone: "ok" as const }
      }
      const one = talking[0]!
      return { text: `${stateWord(one.state)} on ${one.name}`, tone: "ok" as const }
    },
    shallowEqual
  )

/**
 * The admin page's header: the assistant's state, a link to the voice front end and Log out. On a phone it also
 * carries the drill-down's back button and the level's title (the heading that takes focus after a navigation); on a
 * wide screen the page column's visible title takes focus instead, so there is no title here.
 */
export function AdminHeader({ back, title, headingRef }: {
  readonly back: { readonly label: string; readonly onClick: () => void } | undefined
  /** The phone's level title; undefined on a wide screen. */
  readonly title: string | undefined
  readonly headingRef: RefObject<HTMLHeadingElement | null>
}) {
  const client = useClient()
  const line = useAssistantLine()
  const voice = useHref("/")
  const [leaving, setLeaving] = useState(false)
  const logout = async () => {
    // Like every in-app navigation: unsaved changes are asked about first (the shell's "Leave without saving?").
    if (client.store.get().ui.settingsDirty) {
      client.store.dispatch({ type: "local/ui", patch: { settingsLeave: "close" } })
      return
    }
    setLeaving(true)
    const result = await client.adminLogout() // continuation(none): only this button's own state
    if (!result.ok) {
      setLeaving(false)
      client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "Logging out failed.", tone: "error" })
    }
  }
  const dot = <ToneDot tone={line.tone} className={cx("size-2 align-[1px]", line.tone === "warning" && "animate-pulse")} />
  const status = (wrap: boolean) => wrap ? (
    // Narrow: one line of text that wraps as a whole, never cut.
    <p className="label min-w-0 break-words text-ink-muted">
      {dot} <span className="text-ink-faint">Assistant</span> <span>{line.text}</span>
    </p>
  ) : (
    <>
      {dot}
      <span className="label shrink-0 text-ink-faint">Assistant</span>
      <span className="label min-w-0 truncate text-ink-muted">{line.text}</span>
    </>
  )
  return (
    <div className="shrink-0 border-b border-line" data-testid="admin-header">
      <header className="flex h-14 items-center gap-2 pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] sm:gap-3 sm:pl-4 sm:pr-4">
        {back !== undefined ? (
          <button
            type="button"
            onClick={back.onClick}
            className="inline-flex h-11 min-w-0 items-center gap-1 rounded-md pl-1 pr-2 text-[14px] text-voice transition-colors hover:bg-surface-2"
            data-testid="settings-back"
            aria-label={`Back to ${back.label}`}
          >
            <Icon name="back" size={20} className="shrink-0" />
            <span className="truncate">{back.label}</span>
          </button>
        ) : (
          <h1 className="label shrink-0 pl-2 text-ink"><span className="hidden sm:inline">PVA <span className="text-ink-faint">· </span></span>Admin</h1>
        )}
        {title !== undefined && (
          <h2
            id="settings-title"
            ref={headingRef}
            tabIndex={-1}
            className={cx("min-w-0 flex-1 truncate text-[15px] font-medium text-ink outline-none", back === undefined && "sr-only")}
          >
            {title}
          </h2>
        )}
        {/* Wide screens: the status sits in the header. Narrower: on its own line below (wrapping, never cut). */}
        <div className="hidden min-w-0 flex-1 items-center gap-2 pl-6 lg:flex" data-testid="assistant-line">{status(false)}</div>
        <nav aria-label="Admin" className="ml-auto flex shrink-0 items-center gap-1">
          <a
            href={voice}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-[14px] text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink sm:h-10 sm:px-2.5"
            data-testid="voice-link"
            title="Open the voice assistant"
            aria-label="Open the voice assistant"
          >
            <Icon name="open" size={18} />
            <span aria-hidden="true"><span className="sm:hidden">Voice</span><span className="hidden sm:inline">Voice assistant</span></span>
          </a>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={leaving}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-[14px] text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink disabled:opacity-50 sm:h-10 sm:px-2.5"
            data-testid="logout"
            title="Log out"
          >
            {leaving ? <Spinner size={16} /> : <Icon name="logout" size={18} />}
            <span className="sr-only sm:not-sr-only">Log out</span>
          </button>
        </nav>
      </header>
      <div
        className="flex min-h-8 items-start gap-2 border-t border-line/60 py-1.5 pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] lg:hidden"
        data-testid="assistant-line-narrow"
      >
        {status(true)}
      </div>
    </div>
  )
}
