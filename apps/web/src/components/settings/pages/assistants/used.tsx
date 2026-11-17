"use client"
import { useState } from "react"
import type { AssistantInfo, DeviceListInfo, DeviceTarget } from "@pva/protocol"
import { plural, quoted, targetName } from "@/lib/assistants.ts"
import { useClient, useClientState } from "../../../context.tsx"
import { Icon } from "../../../ui/Icon.tsx"
import { Button, cx } from "../../../ui/controls.tsx"
import { AddToDeviceDialog } from "./dialogs.tsx"

/** Used on (docs/ASSISTANTS.md §7.1): where the assistant answers and how it is reached there. Read-only on purpose. */

const usedGroupKey = (t: DeviceTarget, devices: ReadonlyArray<DeviceListInfo>): string => (t.kind === "type" ? t.type : devices.find((d) => d.id === t.id)?.kind ?? "")

export function UsedTab({ info }: { readonly info: AssistantInfo }) {
  const client = useClient()
  const devices = useClientState((s) => s.devices)
  const types = useClientState((s) => s.deviceTypes)
  const [adding, setAdding] = useState(false)
  return (
    <>
      <p className="text-[14px] text-ink-muted">Where {info.name} answers, and how it is reached there. This is set on each device: open one to change it.</p>
      {types.map((t) => {
        const rows = info.usedOn.filter((u) => usedGroupKey(u.target, devices) === t.kind)
        const members = devices.filter((d) => d.kind === t.kind)
        const deviceRows = rows.filter((u) => u.target.kind === "device").length
        return (
          <section key={t.kind} className="flex flex-col gap-2" aria-label={t.title} data-testid={`used-${t.kind}`}>
            <div className="flex items-baseline gap-2">
              <h4 className="label text-ink-faint">{t.title}</h4>
              <span className="ml-auto font-mono text-[12px] text-ink-faint">{deviceRows} of {members.length}</span>
            </div>
            {rows.length === 0 ? (
              <div className="rounded-md border border-dashed border-line px-4 py-4 text-[14px] text-ink-muted">Not on any {t.one}.</div>
            ) : (
              <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
                {rows.map((u) => {
                  const device = u.target.kind === "device" ? devices.find((d) => d.id === (u.target as { id: string }).id) : undefined
                  const settings = device?.settings ?? t.settings
                  const phrases = settings.assistants.find((x) => x.assistant === info.id)?.phrases ?? []
                  const follows = device !== undefined && device.own.assistants === undefined
                  return (
                    <li key={u.target.kind === "device" ? u.target.id : `type-${u.target.type}`}>
                      <button
                        type="button"
                        onClick={() => client.settings(u.target.kind === "device" ? ["devices", u.target.id] : ["frontends", u.target.type])}
                        className="flex min-h-16 w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2/60"
                        data-used={u.target.kind === "device" ? u.target.id : `type:${u.target.type}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[14px] text-ink">{targetName(u.target, devices, types)}</span>
                            {u.target.kind === "type" && <span className="label rounded-sm border border-ink-faint px-1 text-[9px] leading-[14px] text-ink-muted">Defaults</span>}
                          </span>
                          <span className="block text-[12px] text-ink-faint">
                            {u.target.kind === "type" ? `Followed by ${plural(members.filter((d) => d.own.assistants === undefined).length, t.one)}` : follows ? `Follows ${targetName({ kind: "type", type: t.kind }, devices, types)}` : "Own value"}
                            {u.hears ? " · hears with this one" : ""}
                          </span>
                        </span>
                        <span className="flex max-w-[55%] flex-wrap justify-end gap-1" data-testid="reach">
                          {u.reach === "unreachable" ? (
                            <span className="text-[12px] text-warn">Cannot be reached on this device.</span>
                          ) : (
                            <>
                              {u.reach === "without-phrase" && <Chip>Answers without a phrase</Chip>}
                              {u.reach === "typesafe" && <Chip>Whichever fits</Chip>}
                              {phrases.map((p) => <Chip key={p}>{quoted(p)}</Chip>)}
                            </>
                          )}
                        </span>
                        <Icon name="chevron" size={16} className="shrink-0 text-ink-faint" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
      <div>
        <Button className="max-sm:h-11" onClick={() => setAdding(true)} data-testid="add-to-device">
          <Icon name="plus" size={16} />
          Add to a device…
        </Button>
      </div>
      {adding && <AddToDeviceDialog info={info} onClose={() => setAdding(false)} />}
    </>
  )
}

function Chip({ children }: { readonly children: React.ReactNode }) {
  return <span className={cx("rounded-full border border-line px-2 py-0.5 text-[12px] text-ink-muted")}>{children}</span>
}
