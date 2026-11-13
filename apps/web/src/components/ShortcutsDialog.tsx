"use client"
import { useRef } from "react"
import { useClient, useClientState } from "./context.tsx"
import { SHORTCUTS } from "./shortcuts.ts"
import { PanelHeader, useDialog } from "./ui/Panel.tsx"

export function ShortcutsDialog() {
  const client = useClient()
  const open = useClientState((s) => s.ui.shortcutsOpen)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => client.store.dispatch({ type: "local/ui", patch: { shortcutsOpen: false } })
  useDialog(ref, open, close)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/60 p-4" onClick={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] rounded-lg border border-line bg-surface shadow-panel animate-[pva-rise_200ms_var(--ease-out)]"
      >
        <PanelHeader title="Keyboard" titleId="shortcuts-title" onClose={close} />
        <ShortcutList />
      </div>
    </div>
  )
}

export function ShortcutList() {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 px-5 py-4 text-[14px]">
      {SHORTCUTS.map(([key, what]) => (
        <div key={key} className="contents">
          <dt><kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px] text-ink">{key}</kbd></dt>
          <dd className="text-ink-muted">{what}</dd>
        </div>
      ))}
    </dl>
  )
}
