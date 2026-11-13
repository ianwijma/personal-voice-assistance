"use client"
import { useState } from "react"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "./context.tsx"
import { SettingsForm } from "./SettingsForm.tsx"
import { Spinner } from "./ui/Icon.tsx"
import { Button, cx } from "./ui/controls.tsx"

const STAGE: Record<string, string> = { llm: "Language model", stt: "Speech recognition", tts: "Speech synthesis" }

export function AssistantTab() {
  const client = useClient()
  const engine = useClientState((s) => s.engine)
  const sections = useClientState((s) => s.sections, shallowEqual)
  const [reloading, setReloading] = useState(false)
  const reload = async () => {
    setReloading(true)
    const result = await client.reloadEngines()
    setReloading(false)
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "The reload failed.", tone: "error" })
  }
  return (
    <div className="flex flex-col gap-7">
      {engine.reloadPending && (
        <div className="flex items-center gap-3 rounded-md border border-voice/40 bg-voice-soft px-3 py-2.5" data-testid="reload-pending">
          <p className="flex-1 text-[13px] text-ink">Saved changes need an engine reload.</p>
          <Button size="sm" variant="primary" onClick={() => void reload()} disabled={reloading || engine.state === "reloading"}>
            {(reloading || engine.state === "reloading") && <Spinner size={12} />}
            Reload now
          </Button>
        </div>
      )}
      {engine.problems.length > 0 && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-[13px]">
          <p className="mb-1 font-medium text-ink">The engines could not start</p>
          <ul className="flex flex-col gap-1 text-ink-muted">
            {engine.problems.map((p, i) => <li key={i}><span className="font-mono text-ink">{p.stage}</span>: {p.message}</li>)}
          </ul>
          {!engine.reloadPending && <Button size="sm" className="mt-2" onClick={() => void reload()} disabled={reloading}>Try again</Button>}
        </div>
      )}
      <section>
        <h3 className="label mb-3 text-ink-faint">Engines</h3>
        <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
          {engine.engines.map((e) => (
            <li key={e.stage} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink-muted">{STAGE[e.stage] ?? e.stage}</span>
                <span className="block truncate font-mono text-[13px] text-ink">{e.provider} · {e.detail}</span>
              </span>
              <Where location={e.location} />
            </li>
          ))}
          {engine.engines.length === 0 && <li className="px-3 py-2.5 text-[13px] text-ink-faint">{engine.state === "starting" ? "Starting…" : "None running."}</li>}
        </ul>
      </section>
      {engine.voices.length > 0 && (
        <section>
          <h3 className="label mb-3 text-ink-faint">Voices</h3>
          <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
            {engine.voices.map((v) => (
              <li key={v.name} className={cx("flex items-start gap-3 px-3 py-2.5", !v.enabled && "opacity-55")}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[14px] text-ink">{v.name}</span>
                    {v.isDefault && <span className="label text-[9px] text-voice">Default</span>}
                    {!v.enabled && <span className="label text-[9px] text-ink-faint">Off</span>}
                  </span>
                  <span className="block text-[13px] text-ink-muted">{v.description}</span>
                  <span className="block font-mono text-[12px] text-ink-faint">{v.engine}</span>
                </span>
                <Where location={v.location} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {sections.map((section) => (
        <section key={section.id} data-testid={`section-${section.id}`}>
          <h3 className="label mb-1 text-ink-faint">{section.title}</h3>
          {section.description !== undefined && <p className="mb-3 text-[13px] text-ink-muted">{section.description}</p>}
          <div className="mt-3">
            <SettingsForm form={section.form} revision={section.revision} idPrefix={`s-${section.id}`} onSave={(patch) => client.updateSection(section.id, patch)} />
          </div>
        </section>
      ))}
    </div>
  )
}

function Where({ location }: { readonly location: "local" | "hosted" }) {
  return <span className={cx("label shrink-0 text-[9px]", location === "local" ? "text-ink-faint" : "text-warn")}>{location}</span>
}
