import type { StatusLine as Status } from "@pva/protocol"
import { ToneDot } from "./ui/controls.tsx"

/** A module's one-line status (data only; the one generic renderer for module output). */
export function StatusLine({ status }: { readonly status: Status }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-ink-muted">
      <ToneDot tone={status.tone} />
      <span className="truncate">{status.text}</span>
    </span>
  )
}
