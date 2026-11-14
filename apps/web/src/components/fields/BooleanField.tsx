"use client"
import type { SettingField } from "@pva/protocol"
import { Switch } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

/** A switch with its state in words next to it ("On" / "Off"), like the device-profile switches. */
export function BooleanField({ field, id, describedBy, value, onChange, disabled }: FieldProps<Extract<SettingField, { type: "boolean" }>>) {
  const checked = typeof value === "boolean" ? value : field.default
  return (
    <div className="flex min-h-10 items-center gap-3">
      <Switch id={id} checked={checked} onChange={onChange} label={field.label} disabled={disabled} describedBy={describedBy} />
      <span className="text-[14px] text-ink-muted" aria-hidden="true">{checked ? "On" : "Off"}</span>
    </div>
  )
}
