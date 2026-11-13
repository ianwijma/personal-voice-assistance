"use client"
import { useState } from "react"
import type { SettingField } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { secretStatus } from "@/lib/vault.ts"
import { useClientState } from "../context.tsx"
import { Button } from "../ui/controls.tsx"
import { type FieldProps, inputClass } from "./types.ts"

/** Never pre-filled: shows whether the secret is set, and lets you replace or remove it. */
export function SecretField({ field, id, describedBy, secret, secretDraft, onSecretChange, disabled, invalid }: FieldProps<Extract<SettingField, { type: "secret" }>>) {
  const [editing, setEditing] = useState(false)
  const vault = useClientState((s) => s.vault, shallowEqual)
  const state = secret ?? { set: false, source: "none" as const }
  const status = secretDraft === null
    ? "Will be removed when you save"
    : typeof secretDraft === "string" && secretDraft !== ""
    ? "New value entered"
    : secretStatus(state, vault, field.env)
  if (editing) {
    return (
      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoFocus
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={secretDraft ?? ""}
          disabled={disabled}
          onChange={(e) => onSecretChange(e.target.value)}
          placeholder="Paste the new value"
          className={inputClass}
        />
        <Button
          variant="quiet"
          size="md"
          onClick={() => {
            onSecretChange(undefined)
            setEditing(false)
          }}
        >
          Cancel
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        id={id}
        className={`inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-line px-3 font-mono text-[13px] ${state.set && secretDraft !== null ? "text-ink" : "text-ink-muted"}`}
      >
        <span aria-hidden="true" className={`size-1.5 rounded-full ${state.set && secretDraft !== null ? "bg-ok" : "bg-ink-faint"}`} />
        {status}
      </span>
      {state.source !== "env" && !disabled && (
        <>
          <Button size="sm" disabled={disabled} onClick={() => setEditing(true)}>{state.set ? "Replace" : "Set"}</Button>
          {state.set && secretDraft !== null && (
            <Button size="sm" variant="quiet" disabled={disabled} onClick={() => onSecretChange(null)}>Remove</Button>
          )}
          {secretDraft === null && <Button size="sm" variant="quiet" onClick={() => onSecretChange(undefined)}>Keep</Button>}
        </>
      )}
    </div>
  )
}

