"use client"
import { useRef } from "react"
import { useClient, useClientState, usePrefs } from "./context.tsx"
import { SHORTCUTS } from "./shortcuts.ts"
import { PanelHeader, useDialog } from "./ui/Panel.tsx"
import { Switch } from "./ui/controls.tsx"
import { AudioReport } from "./voice/AudioReport.tsx"

/**
 * Help (`?`, or "Keyboard and audio report" in the sheet's More): the keyboard shortcuts with a switch that turns the
 * single-key ones off (WCAG 2.1.4; kept in this browser), and this device's audio report.
 */
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
        data-testid="help-dialog"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[420px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-panel animate-[pva-rise_200ms_var(--ease-out)]"
      >
        <PanelHeader title="Help" titleId="shortcuts-title" onClose={close} />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-quiet">
          <ShortcutList />
          <div className="border-t border-line px-5 py-4">
            <AudioReport />
          </div>
        </div>
      </div>
    </div>
  )
}

export function ShortcutList() {
  const client = useClient()
  const on = usePrefs((p) => p.shortcuts)
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span id="shortcuts-switch-label" className="block text-[14px] font-medium text-ink">Keyboard shortcuts</span>
          <span id="shortcuts-switch-help" className="block text-[13px] text-ink-muted">
            {on ? "On: single keys act on the page (Esc always works)." : "Off: only Esc works; type and use buttons as usual."}
          </span>
        </span>
        <Switch
          id="shortcuts-switch"
          label="Keyboard shortcuts"
          describedBy="shortcuts-switch-help"
          checked={on}
          onChange={(shortcuts) => client.setPrefs({ shortcuts })}
        />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[14px]" data-testid="shortcut-list">
        {SHORTCUTS.map(([key, what]) => (
          <div key={key} className="contents">
            <dt><kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px] text-ink">{key}</kbd></dt>
            <dd className="text-ink-muted">{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
