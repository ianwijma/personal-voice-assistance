"use client"
import type { DeviceUser } from "@pva/protocol"
import { deviceUserPath } from "@/lib/catalogPicker.ts"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClientState } from "../context.tsx"

const link = "text-voice underline-offset-4 hover:underline"

/**
 * Who speaks with a voice: the assistants (their own voice) and the devices or device types' defaults that use it as
 * theirs ("Used by Jeff, T3 · Kitchen iPad, Every browser"), each linking to its page. Nothing when there are none.
 * An assistant id the page does not know (not an admin) shows as the id. `plain`: names only, no links, for places
 * with their own keyboard model (a picker row: links there would add Tab stops between the row's buttons).
 */
export function UsedBy({ assistants, devices, testId = "used-by", plain = false }: {
  readonly assistants: ReadonlyArray<string>
  readonly devices: ReadonlyArray<DeviceUser>
  readonly testId?: string
  readonly plain?: boolean
}) {
  const names = useClientState((s) => s.assistants.map((a) => ({ id: a.id, name: a.name })), shallowEqual)
  if (assistants.length === 0 && devices.length === 0) return null
  const nameOf = (id: string) => names.find((a) => a.id === id)?.name ?? id
  return (
    <span data-testid={testId}>
      Used by{" "}
      {assistants.map((id, i) => (
        <span key={id}>{i > 0 && ", "}{plain ? nameOf(id) : <a href={formatSettingsHash(["assistants", id, "voice"])} className={link}>{nameOf(id)}</a>}</span>
      ))}
      {assistants.length > 0 && devices.length > 0 && " \u00B7 "}
      {devices.map((d, i) => (
        <span key={`${d.target.kind}-${d.target.kind === "type" ? d.target.type : d.target.id}`}>
          {i > 0 && ", "}{plain ? d.name : <a href={formatSettingsHash(deviceUserPath(d))} className={link}>{d.name}</a>}
        </span>
      ))}
    </span>
  )
}
