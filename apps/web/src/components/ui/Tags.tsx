"use client"
import type { OptionTag } from "@pva/protocol"
import { cx } from "./controls.tsx"

/** The words for option tags (docs/SETTINGS-UI.md §3.3): chips that say what choosing an option implies. */
export const TAG_LABEL: { readonly [T in OptionTag]: string } = {
  local: "Local",
  hosted: "Hosted",
  "needs-key": "Needs key",
  "not-downloaded": "Not downloaded",
  "slow-start": "Slower start",
  experimental: "Experimental"
}

const TONE: { readonly [T in OptionTag]: string } = {
  local: "text-ink-faint border-line",
  hosted: "text-warn border-warn/40",
  "needs-key": "text-warn border-warn/40",
  "not-downloaded": "text-danger border-danger/40",
  "slow-start": "text-ink-muted border-line",
  experimental: "text-voice border-voice/40"
}

export function Tags({ tags, className }: { readonly tags: ReadonlyArray<OptionTag> | undefined; readonly className?: string }) {
  if (tags === undefined || tags.length === 0) return null
  return (
    <span className={cx("inline-flex flex-wrap gap-1", className)} data-testid="option-tags">
      {tags.map((t) => (
        <span key={t} className={cx("label rounded-sm border px-1 text-[9px] leading-[14px]", TONE[t])} data-tag={t}>
          {TAG_LABEL[t]}
        </span>
      ))}
    </span>
  )
}
