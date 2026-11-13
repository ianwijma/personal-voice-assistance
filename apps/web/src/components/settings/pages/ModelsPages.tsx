"use client"
import { useState } from "react"
import type { ModelItem, ToolId } from "@pva/protocol"
import { runningJob } from "@/lib/state.ts"
import { useClient, useClientState } from "../../context.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Button, cx } from "../../ui/controls.tsx"
import { DownloadControl, formatMb, JobProgress } from "../DownloadControl.tsx"

/**
 * Speech recognition › Models and Voices › Models (docs/SETTINGS-UI.md §5.4): every preset of the tool with its size
 * and state (installed, downloading x %, not downloaded), Download, Cancel and Delete. A model the running engines
 * use cannot be deleted. Downloads run on the server: closing the page does not stop them.
 */
function ModelsPage({ tool }: { readonly tool: ToolId }) {
  const set = useClientState((s) => s.models.find((m) => m.tool === tool))
  if (set === undefined) return <p className="text-[14px] text-ink-muted">This assistant does not offer model downloads.</p>
  const installed = set.items.filter((i) => i.installed)
  const onDisk = installed.reduce((n, i) => n + i.diskMb, 0)
  return (
    <div className="flex flex-col gap-4" data-testid={`models-${tool}`}>
      <p className="text-[13px] text-ink-muted">
        {installed.length} of {set.items.length} downloaded ({formatMb(onDisk)}) in <span className="break-all font-mono text-[12px] text-ink">{set.directory}</span>
        {set.freeMb !== undefined && <> · {formatMb(set.freeMb)} free</>}
      </p>
      <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
        {set.items.map((item) => <ModelRow key={item.id} tool={tool} item={item} />)}
      </ul>
      <p className="text-[12px] text-ink-faint">
        Downloads come from the sherpa-onnx releases on GitHub and are unpacked at low priority, so a conversation keeps its speed. A download
        needs room for the archive and the unpacked files.
      </p>
    </div>
  )
}

function ModelRow({ tool, item }: { readonly tool: ToolId; readonly item: ModelItem }) {
  const client = useClient()
  const admin = useClientState((s) => s.vault.admin)
  const job = useClientState((s) => runningJob(s, tool, item.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const state = job !== undefined ? "downloading" : item.installed ? "installed" : "missing"
  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-testid="model-row" data-model={item.id} data-state={state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 text-[14px] text-ink">{item.label}</span>
        <span className="font-mono text-[12px] text-ink-faint">{formatMb(item.sizeMb)}</span>
        <span className={cx("ml-auto inline-flex items-center gap-1.5 text-[12px]", item.installed ? "text-ok" : "text-ink-faint")}>
          {item.installed ? <><Icon name="check" size={13} /> {item.inUse ? "Installed · in use" : "Installed"}</> : job !== undefined ? "Downloading" : "Not downloaded"}
        </span>
      </div>
      {item.description !== undefined && <p className="text-[12px] text-ink-muted">{item.description}</p>}
      {job !== undefined ? (
        <JobProgress job={job} admin={admin} />
      ) : !item.installed ? (
        <DownloadControl tool={tool} target={item.id} sizeMb={item.sizeMb} label={item.label} />
      ) : admin ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="danger"
            disabled={busy || item.inUse}
            title={item.inUse ? "The running engines use it: choose another model and reload first" : undefined}
            onClick={() => {
              setBusy(true)
              setError(undefined)
              void client.deleteModel(tool, item.id).then((r) => {
                setBusy(false)
                if (!r.ok) setError(r.error?.message ?? "Could not delete it.")
              })
            }}
            aria-label={`Delete ${item.label}`}
          >
            <Icon name="trash" size={14} /> Delete
          </Button>
          {item.inUse && <span className="text-[12px] text-ink-faint">In use by the running engines.</span>}
        </div>
      ) : null}
      {error !== undefined && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </li>
  )
}

export function SpeechModelsPage() {
  return <ModelsPage tool="stt-models" />
}

export function VoiceModelsPage() {
  return <ModelsPage tool="tts-models" />
}
