"use client"
import type { SettingField } from "@pva/protocol"
import { ToneDot } from "../ui/controls.tsx"
import type { FieldProps } from "./types.ts"

/** Read-only text the server computes (protocol 10, `info`): "Connected to Home (HA 2026.11)". "—" while not known. */
export function InfoField({ field, id, describedBy, value }: FieldProps<Extract<SettingField, { type: "info" }>>) {
  const text = typeof value === "string" ? value : ""
  return (
    <p id={id} aria-describedby={describedBy} className="flex min-h-8 items-center gap-2 text-[14px] text-ink" data-testid={`info-${field.key}`}>
      {field.tone !== undefined && text !== "" && <ToneDot tone={field.tone} />}
      <span className={text === "" ? "text-ink-faint" : "break-words"}>{text === "" ? "—" : text}</span>
    </p>
  )
}
