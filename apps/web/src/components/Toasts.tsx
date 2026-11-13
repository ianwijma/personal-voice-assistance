"use client"
import { useEffect } from "react"
import type { Toast } from "@/lib/state.ts"
import { useClient, useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"

/** Transient messages above the dock: 6 s each, at most 3. */
export function Toasts() {
  const toasts = useClientState((s) => s.toasts)
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-[104px] z-20 flex flex-col items-center gap-2 px-4 sm:bottom-24">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  )
}

function ToastItem({ toast }: { readonly toast: Toast }) {
  const client = useClient()
  useEffect(() => {
    // continuation(identity): dismisses only this toast, by its id; cleared when the toast goes.
    const timer = setTimeout(() => client.store.dispatch({ type: "local/toast-dismiss", id: toast.id }), 6000)
    return () => clearTimeout(timer)
  }, [client, toast.id])
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className="pointer-events-auto flex max-w-[520px] items-start gap-3 rounded-md border border-line bg-surface px-4 py-2.5 text-[14px] text-ink shadow-panel animate-[pva-rise_200ms_var(--ease-out)]"
    >
      <span aria-hidden="true" className={cx("mt-[7px] size-1.5 shrink-0 rounded-full", toast.tone === "error" ? "bg-danger" : "bg-ink-faint")} />
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => client.store.dispatch({ type: "local/toast-dismiss", id: toast.id })}
        className="-mr-1 shrink-0 rounded px-1 text-ink-faint hover:text-ink"
      >
        ×
      </button>
    </div>
  )
}
