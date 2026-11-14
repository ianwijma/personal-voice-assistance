"use client"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState } from "./context.tsx"
import { Spinner } from "./ui/Icon.tsx"
import { useHref } from "./useHref.ts"

/** What the bar says per engine state (`engine.summary.state`); the details and the fix are in admin. */
const TEXT = {
  starting: ["The assistant is starting.", "This takes a few seconds."],
  reloading: ["The assistant is reloading its engines.", "This takes a few seconds."],
  failed: ["The assistant could not start.", "Something needs fixing in admin."],
  ready: ["", ""]
} as const

/**
 * A bar at the top of the stage while the assistant cannot hold a conversation. A voice page knows the engines'
 * state (protocol 5 `engine.summary`) but not the problems: why it failed, and the fix, are in admin.
 */
export function EngineBanner() {
  const e = useClientState((s) => ({ ready: s.summary.ready, state: s.summary.state, open: s.connection.status === "open" }), shallowEqual)
  const admin = useHref("/admin/")
  if (!e.open || e.ready) return null
  return (
    <div
      role="status"
      data-testid="engine-banner"
      data-state={e.state}
      className="absolute inset-x-3 top-2 mx-auto flex max-w-[720px] items-center gap-3 rounded-md border border-line bg-surface px-4 py-2.5 text-[14px] sm:inset-x-6"
    >
      {e.state === "failed" ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger" /> : <Spinner className="shrink-0 text-ink-muted" />}
      <p className="min-w-0 flex-1 text-ink">
        {TEXT[e.state][0]} <span className="text-ink-muted">{TEXT[e.state][1]}</span>
      </p>
      <a href={admin} className="inline-flex min-h-11 shrink-0 items-center text-[13px] text-voice underline-offset-4 hover:underline">
        See why in admin
      </a>
    </div>
  )
}
