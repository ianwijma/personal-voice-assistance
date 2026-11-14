"use client"
import { useState } from "react"
import { formatDiagnostics } from "@/lib/audio/diagnostics.ts"
import { profileOf } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState, useDiagnostics } from "../context.tsx"
import { Button } from "../ui/controls.tsx"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** This device's audio numbers (microphone as reported, playback underruns), copied as text for a bug report. */
export function AudioReport() {
  const diagnostics = useDiagnostics((d) => d)
  const profile = useClientState(profileOf, shallowEqual)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const text = formatDiagnostics(diagnostics, { userAgent: navigator.userAgent, outputPath: profile.outputPath, prebufferMs: profile.prebufferMs })
    // continuation(none): only this button's own label changes.
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000) // continuation(none): only the label
    }, () => window.prompt("Copy this report", text))
  }
  const p = diagnostics.playback
  return (
    <div className="flex flex-col gap-2" data-testid="audio-report">
      <h3 className="text-[14px] font-medium text-ink">Audio report</h3>
      <p className="text-[13px] text-ink-muted">
        {p.replies === 0 ? "No replies played yet." : `${plural(p.replies, "reply", "replies")} played, ${plural(p.underruns, "short gap", "short gaps")}.`} Copy it when playback stutters or pops.
      </p>
      <div>
        <Button size="md" onClick={copy} className="max-sm:h-11">{copied ? "Copied" : "Copy report"}</Button>
      </div>
    </div>
  )
}
