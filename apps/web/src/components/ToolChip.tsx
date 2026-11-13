"use client"
import { useState } from "react"
import type { ToolView } from "@/lib/state.ts"
import { Icon, Spinner } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"

/** A short summary of a tool's input: its first string value ("Paris"). */
const summary = (input: unknown): string | undefined => {
  if (typeof input === "string") return input
  if (input !== null && typeof input === "object") {
    for (const v of Object.values(input)) if (typeof v === "string" && v !== "") return v
  }
  return undefined
}

export function ToolChip({ tool }: { readonly tool: ToolView }) {
  const [open, setOpen] = useState(false)
  const what = summary(tool.input)
  const detail = tool.status === "running"
    ? what
    : tool.status === "ok"
    ? tool.ms === undefined ? undefined : `${Math.round(tool.ms)} ms`
    : tool.error ?? "failed"
  const hasInput = tool.input !== null && tool.input !== undefined
  return (
    <div className="max-w-full">
      <button
        type="button"
        data-testid="tool-chip"
        data-status={tool.status}
        aria-expanded={hasInput ? open : undefined}
        disabled={!hasInput}
        onClick={() => setOpen(!open)}
        className={cx(
          "inline-flex max-w-full items-start gap-1.5 rounded-sm border px-2 py-0.5 text-left font-mono text-[12px] transition-colors duration-[120ms]",
          tool.status === "error" ? "border-danger/40 text-danger" : "border-line text-ink-muted",
          hasInput && "hover:bg-surface-2"
        )}
      >
        <span className="mt-[3px] shrink-0">
          {tool.status === "running" ? <Spinner size={11} /> : <Icon name={tool.status === "ok" ? "check" : "cross"} size={12} className={tool.status === "ok" ? "text-ok" : ""} />}
        </span>
        <span className="min-w-0">
          <span className="text-ink">{tool.tool}</span>
          {detail !== undefined && <span className={tool.status === "error" ? "break-words" : ""}> · {detail}</span>}
        </span>
      </button>
      {open && hasInput && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-sm bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-ink-muted scrollbar-quiet">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
      )}
    </div>
  )
}
