"use client"
import { useRef, useState } from "react"
import type { InfoStep, SettingField } from "@pva/protocol"
import { copyText } from "@/lib/clipboard.ts"
import { Button, ToneDot } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

/**
 * The one substitution in a step's copy value: the address the owner has this admin page open on (the server does not know
 * it, the page does). Nothing else is replaced; the value is otherwise shown verbatim, as text.
 */
export const withOrigin = (value: string, origin: string): string => value.split("{origin}").join(origin)

type InfoProps = FieldProps<Extract<SettingField, { type: "info" }>>

/** Read-only text the server computes (protocol 10, `info`): "Connected to Home (HA 2026.11)". "—" while not known. With `steps`, a numbered guide. */
export function InfoField(props: InfoProps) {
  const { field, id, describedBy, value } = props
  const text = typeof value === "string" ? value : ""
  const steps = field.steps
  if (steps !== undefined && steps.length > 0) return <Guide {...props} steps={steps} text={text} />
  return (
    <p id={id} aria-describedby={describedBy} className="flex min-h-8 items-center gap-2 text-[14px] text-ink" data-testid={`info-${field.key}`}>
      {field.tone !== undefined && text !== "" && <ToneDot tone={field.tone} />}
      <span className={text === "" ? "text-ink-faint" : "break-words"}>{text === "" ? "—" : text}</span>
    </p>
  )
}

function Guide({ field, id, describedBy, steps, text }: InfoProps & { readonly steps: ReadonlyArray<InfoStep>; readonly text: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [announce, setAnnounce] = useState("")
  const copy = (label: string, value: string) => {
    // continuation(none): only the live-region line
    void copyText(value, host.current).then((ok) => setAnnounce(ok ? `Copied ${label}` : "Select the text and copy it."))
  }
  return (
    <div ref={host} id={id} aria-describedby={describedBy} className="flex flex-col gap-3" data-testid={`info-${field.key}`}>
      {text !== "" && (
        <p className="flex items-center gap-2 text-[14px] text-ink">
          {field.tone !== undefined && <ToneDot tone={field.tone} />}
          <span className="break-words">{text}</span>
        </p>
      )}
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-[14px] text-ink marker:text-ink-muted">
        {steps.map((step, n) => (
          <li key={n} className="pl-1" data-testid="info-step">
            <p className="break-words">{step.text}</p>
            {step.copy !== undefined && step.copy.length > 0 && (
              <ul className="mt-2 flex flex-col gap-2">
                {step.copy.map((c, k) => {
                  const shown = withOrigin(c.value, window.location.origin)
                  return (
                    <li key={k} className="flex flex-col gap-1">
                      <span className="text-[13px] text-ink-muted">{c.label}</span>
                      <div className="flex flex-wrap items-center gap-2">
                        <code
                          className="min-w-0 flex-1 select-all rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[13px] break-all text-ink"
                          data-testid="info-copy-value"
                        >
                          {shown}
                        </code>
                        <Button size="sm" aria-label={`Copy ${c.label}`} onClick={() => copy(c.label, shown)}>
                          Copy
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {step.link !== undefined && (
              <a
                href={step.link.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="info-step-link"
                className="mt-2 inline-block min-h-8 w-fit text-[14px] text-voice underline underline-offset-4"
              >
                {step.link.label}
              </a>
            )}
          </li>
        ))}
      </ol>
      <p role="status" aria-live="polite" className="min-h-4 text-[13px] text-ink-muted" data-testid="info-copied">{announce}</p>
    </div>
  )
}
