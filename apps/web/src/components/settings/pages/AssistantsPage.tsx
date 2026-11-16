"use client"
import { useEffect } from "react"
import { hearingModelNames, plural, summaryMarks, summaryParts } from "@/lib/assistants.ts"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { useClient, useClientState } from "../../context.tsx"
import { useCatalogState, useVoiceCatalog } from "../../voices/useVoiceCatalog.ts"
import { indexVoices } from "@/lib/voicePicker.ts"
import { Icon } from "../../ui/Icon.tsx"
import { Button } from "../../ui/controls.tsx"
import { StateChip, Strip } from "./assistants/parts.tsx"

/** The voice's name from the voice catalog, once it has loaded (a voice's id is shown until then). */
export const useVoiceNameOf = () => {
  const catalog = useVoiceCatalog()
  useEffect(() => catalog.ensure(), [catalog])
  const lists = useCatalogState((s) => s.lists)
  const index = indexVoices(lists)
  return (voice: { readonly provider: string; readonly voiceId: string }): string | undefined => index.get(`${voice.provider}:${voice.voiceId}`)?.voice.name
}

/** "On 5 devices": the devices it answers on (those following a type's defaults count); only a type's defaults: "On the defaults". */
const usedWords = (usedOn: ReadonlyArray<{ readonly target: { readonly kind: string } }>): string => {
  const devices = usedOn.filter((u) => u.target.kind === "device").length
  return devices === 0 && usedOn.length > 0 ? "On the defaults" : `On ${plural(devices, "device")}`
}

/** Assistants › All assistants: each assistant with its state, where it is used and the summary strip; New assistant. */
export function AssistantsPage() {
  const client = useClient()
  const assistants = useClientState((s) => s.assistants)
  const modules = useClientState((s) => s.modules)
  const sections = useClientState((s) => s.sections)
  const voiceName = useVoiceNameOf()
  const names = hearingModelNames(sections)
  const moduleList = Object.values(modules.byId)
  const on = assistants.filter((a) => a.on).length
  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="assistant-list">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-ink-muted" data-testid="assistant-count">{plural(assistants.length, "assistant")} · {on} switched on</span>
        <Button variant="primary" className="ml-auto max-sm:h-11" onClick={() => client.settings(["assistants", "new", "1"])} data-testid="new-assistant">
          <Icon name="plus" size={16} />
          New assistant
        </Button>
      </div>
      {assistants.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line px-4 py-6" data-testid="no-assistants">
          <p className="text-[14px] text-ink">No assistants yet.</p>
          <p className="text-[13px] text-ink-muted">An assistant is who answers. Create one, then assign it to a device.</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
          {assistants.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => client.settings(["assistants", a.id])}
                className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2/60"
                data-assistant={a.id}
              >
                <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line text-[13px] text-ink-muted">{a.name.charAt(0).toUpperCase()}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[14px] font-medium text-ink">{a.name}</span>
                    <StateChip on={a.on} />
                    <span className="ml-auto text-[12px] text-ink-faint" data-testid="used-count">{usedWords(a.usedOn)}</span>
                  </span>
                  {a.purpose !== "" && <span className="text-[13px] text-ink-muted">{a.purpose}</span>}
                  <Strip parts={summaryParts(a, moduleList, names, voiceName(a.voice))} marks={summaryMarks(a)} className="text-ink-faint" />
                </span>
                <Icon name="chevron" size={16} className="mt-2 shrink-0 text-ink-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-ink-muted">
        An assistant is who answers. Where it listens and which phrase wakes it is set under{" "}
        <a href={formatSettingsHash(["devices"])} className="text-voice underline-offset-4 hover:underline">Devices</a>.
      </p>
    </div>
  )
}
