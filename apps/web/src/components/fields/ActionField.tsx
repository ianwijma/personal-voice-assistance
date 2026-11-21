"use client"
import { useEffect, useRef, useState } from "react"
import type { FieldActionResult, SettingField } from "@pva/protocol"
import { useClient } from "../context.tsx"
import { Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

/**
 * A button that runs something on the server (protocol 10, `action`: "Test"). It sends `module.action`; the result
 * is shown next to it (tone colour) until the form is closed. One press at a time; with `requiresSaved` it waits
 * for Save while the form has unsaved edits, otherwise the press carries the draft. A `confirm` text asks first. An
 * answer may carry a `link` (an address on this server, such as a sign-in that continues on another site): shown as a
 * link for the owner to open in a new tab, never opened by the page itself (a popup opened after a request is blocked).
 */
export function ActionField({ field, id, describedBy, disabled, context }: FieldProps<Extract<SettingField, { type: "action" }>>) {
  const client = useClient()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<FieldActionResult | undefined>(undefined)
  // Set in the effect (not only initially): StrictMode runs setup, cleanup and setup again on a live component.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  const moduleId = context?.form.kind === "module" ? context.form.id : undefined
  // One rule with Save: a press acts on exactly what the form shows, so not while a shown field is invalid.
  const invalid = context?.invalid
  const needsSave = invalid === undefined && field.requiresSaved && context?.dirty === true
  const press = async () => {
    if (running || moduleId === undefined || invalid !== undefined) return
    if (field.confirm !== undefined && !window.confirm(field.confirm)) return
    setRunning(true)
    setResult(undefined)
    const values = !field.requiresSaved && context?.dirty === true ? { ...context.draftValues } : undefined
    let next: FieldActionResult
    try {
      const reply = await client.request({ type: "module.action", moduleId, key: field.key, ...(values !== undefined ? { values } : {}) })
      next = reply.ok ? reply.action ?? { ok: true, text: "Done.", tone: "ok" } : { ok: false, text: reply.error?.message ?? "It did not run.", tone: "error" }
    } catch {
      next = { ok: false, text: "No answer from the assistant; try again.", tone: "error" }
    }
    if (!mounted.current) return
    setRunning(false)
    setResult(next)
  }
  const tone = result?.tone ?? (result?.ok === false ? "error" : "neutral")
  return (
    <div className="flex flex-col gap-1.5" data-testid={`action-${field.key}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          id={id}
          size="sm"
          aria-describedby={describedBy}
          aria-busy={running}
          disabled={disabled || running || needsSave || invalid !== undefined || moduleId === undefined}
          onClick={() => void press()}
        >
          {running && <Spinner size={13} />}
          {field.buttonLabel}
        </Button>
        {needsSave && <span className="text-[13px] text-ink-muted">Save first</span>}
        {invalid !== undefined && <span className="text-[13px] text-danger" data-testid="action-blocked">Fix this first: {invalid}</span>}
        {moduleId === undefined && <span className="text-[13px] text-ink-muted">Not available here</span>}
      </div>
      <p
        role="status"
        aria-live="polite"
        data-testid="action-result"
        data-ok={result === undefined ? undefined : String(result.ok)}
        className={cx("text-[13px]", tone === "ok" && "text-ok", tone === "warning" && "text-warn", tone === "error" && "text-danger", tone === "neutral" && "text-ink-muted")}
      >
        {result?.text ?? ""}
      </p>
      {result?.link !== undefined && (
        // The server only offers an address on its own origin (`/api/modules/<id>/…`): opened by the owner, in a new tab.
        <a
          href={result.link.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="action-link"
          className="min-h-8 w-fit text-[14px] text-voice underline underline-offset-4"
        >
          {result.link.label}
        </a>
      )}
    </div>
  )
}
