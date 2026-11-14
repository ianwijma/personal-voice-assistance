"use client"
import { useEffect } from "react"
import type { Toast } from "@/lib/state.ts"
import { useClient, useClientState } from "./context.tsx"
import { cx } from "./ui/controls.tsx"

/**
 * Transient messages above the dock (or where `className` puts them): 6 s each, at most 3. Fixed above every panel
 * and dialog (z 70), so a toast is never hidden under an open sheet. (The voice sheet shows its own refusals next to
 * the control instead, until they are dismissed.)
 */
export function Toasts({ className = "bottom-[calc(104px+env(safe-area-inset-bottom))] sm:bottom-[calc(96px+env(safe-area-inset-bottom))]" }: { readonly className?: string }) {
  const toasts = useClientState((s) => s.toasts)
  const chatOpen = useClientState((s) => s.ui.chatOpen)
  return (
    <div
      aria-live="polite"
      data-testid="toasts"
      data-keep-active=""
      // Like the stage: with the chat popover open (1024 to 1439 px) the stage moves 200 px left, and so do the toasts.
      className={cx("pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4 transition-transform duration-[320ms] ease-out", chatOpen && "lg:max-[1439px]:-translate-x-[200px]", className)}
    >
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
        className="-my-2.5 -mr-3 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
        </svg>
      </button>
    </div>
  )
}
