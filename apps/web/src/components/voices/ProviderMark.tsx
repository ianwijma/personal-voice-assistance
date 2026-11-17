"use client"
import { providerMarkOf } from "@/ui/voiceProviderMarks.ts"
import { cx } from "../ui/controls.tsx"

const TONE = {
  neutral: "border border-line bg-surface-2 text-ink",
  you: "bg-you-soft text-you",
  // Ink letters: amber on its own tint is under 4.5:1 on a hovered row in the light theme (test/contrast.test.ts).
  voice: "bg-voice-soft text-ink"
} as const

/** A voice provider's mark (`ui/voiceProviderMarks.ts`): its icon when it has one, else its letters. Decorative. */
export function ProviderMark({ id, label, size = 20, className }: { readonly id: string; readonly label?: string; readonly size?: number; readonly className?: string }) {
  const mark = providerMarkOf(id, label)
  const Custom = mark.icon
  return (
    <span
      aria-hidden="true"
      data-provider-mark={id}
      className={cx("inline-grid shrink-0 place-items-center rounded-[5px] font-mono font-medium leading-none tracking-tight", TONE[mark.tone], className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {Custom !== undefined ? <Custom size={size} /> : mark.letters}
    </span>
  )
}
