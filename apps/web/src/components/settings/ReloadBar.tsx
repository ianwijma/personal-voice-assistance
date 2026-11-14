"use client"
import { useState } from "react"
import { describeServerPaths, type NavGroup } from "@/lib/settingsTree.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"

/**
 * The global "reload engines" bar (docs/SETTINGS-UI.md §3.4): shown on every page while saved changes wait for an
 * engine reload, naming the pages; red with the problem when a reload failed (the running engines are kept).
 */
export function ReloadBar({ tree }: { readonly tree: ReadonlyArray<NavGroup> }) {
  const client = useClient()
  const e = useClientState(
    (s) => ({
      pending: s.engine.reloadPending,
      pages: s.engine.reloadPendingFor ?? [],
      state: s.engine.state,
      speaking: s.session.serverState === "speaking" || s.session.serverState === "thinking"
    }),
    shallowEqual
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  if (!e.pending && failure === undefined) return null
  const reload = async () => {
    setBusy(true)
    setFailure(undefined)
    const result = await client.reloadEngines() // continuation(none): shows this request's own outcome; no audio or preference state
    setBusy(false)
    if (!result.ok) setFailure(result.error?.message ?? "The reload failed; the running engines were kept.")
  }
  const pages = describeServerPaths(tree, e.pages)
  const working = busy || e.state === "reloading"
  return (
    <div
      className={cx(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5 sm:px-6",
        failure !== undefined ? "border-danger/40 bg-danger/5" : "border-voice/40 bg-voice-soft"
      )}
      data-testid="reload-pending"
      role="status"
    >
      <p className="min-w-0 flex-1 text-[13px] text-ink">
        {failure !== undefined ? failure : "Saved changes need an engine reload"}
        {failure === undefined && pages.length > 0 && (
          <span className="text-ink-muted">
            {" ("}
            {pages.map((p, i) => (
              <span key={p.label}>
                {i > 0 && ", "}
                <button type="button" className="underline-offset-4 hover:underline" onClick={() => client.settings(p.path)}>{p.label}</button>
              </span>
            ))}
            {")"}
          </span>
        )}
        .
      </p>
      <Button size="sm" variant="primary" onClick={() => void reload()} disabled={working}>
        {working && <Spinner size={12} />}
        {failure !== undefined ? "Try again" : e.speaking ? "Reload now (stops the reply)" : "Reload now"}
      </Button>
      {failure !== undefined && !e.pending && <Button size="sm" variant="quiet" onClick={() => setFailure(undefined)}>Dismiss</Button>}
    </div>
  )
}
