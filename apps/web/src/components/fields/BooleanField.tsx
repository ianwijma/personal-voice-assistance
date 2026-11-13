"use client"
import type { SettingField } from "@pva/protocol"
import { Switch } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

export function BooleanField({ field, id, describedBy, value, onChange, disabled }: FieldProps<Extract<SettingField, { type: "boolean" }>>) {
  const checked = typeof value === "boolean" ? value : field.default
  return <Switch id={id} checked={checked} onChange={onChange} label={field.label} disabled={disabled} describedBy={describedBy} />
}
