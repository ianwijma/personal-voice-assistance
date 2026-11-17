"use client"
import { type KeyboardEvent, useEffect, useState } from "react"
import type { AssistantInfo } from "@pva/protocol"
import { ASSISTANT_TABS, type AssistantTab, hearingModelNames, isAssistantTab, listJoin, summaryMarks, summaryParts } from "@/lib/assistants.ts"
import { useClient, useClientState } from "../../context.tsx"
import { cx } from "../../ui/controls.tsx"
import { FormFooter } from "../FormFooter.tsx"
import { DeleteDialog, DuplicateDialog } from "./assistants/dialogs.tsx"
import { Strip } from "./assistants/parts.tsx"
import { BasicsTab, BehaviourTab, HearingTab, ModelTab, ModulesTab, VoiceTab } from "./assistants/tabs.tsx"
import { useAssistantDraft } from "./assistants/useAssistantDraft.ts"
import { UsedTab } from "./assistants/used.tsx"
import { useVoiceNameOf } from "./AssistantsPage.tsx"

/**
 * Assistants › one assistant (docs/ASSISTANTS.md §7.1, mock-up `admin.html`): the summary strip, seven tabs
 * (the tab is the third part of the path: `#settings/assistants/jeff/model`), and one save bar for the whole
 * assistant. Every tab edits the same draft; the dirty mark on a tab says which tabs have unsaved edits.
 */
export function AssistantPage() {
  const id = useClientState((s) => s.ui.settingsPath[1])
  const info = useClientState((s) => s.assistants.find((a) => a.id === id))
  const client = useClient()
  if (info === undefined) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line px-4 py-6" data-testid="assistant-missing">
        <p className="text-[14px] text-ink">This assistant does not exist (any more).</p>
        <button type="button" className="text-[13px] text-voice hover:underline" onClick={() => client.settings(["assistants"], { discard: true })}>Back to all assistants</button>
      </div>
    )
  }
  return <Editor key={info.id} info={info} />
}

function Editor({ info }: { readonly info: AssistantInfo }) {
  const client = useClient()
  const draft = useAssistantDraft(info)
  const path = useClientState((s) => s.ui.settingsPath)
  const modules = useClientState((s) => s.modules)
  const sections = useClientState((s) => s.sections)
  const voiceName = useVoiceNameOf()
  const tab: AssistantTab = isAssistantTab(path[2]) ? path[2] : "basics"
  const [asking, setAsking] = useState<"delete" | "duplicate" | undefined>()

  // The settings screen asks "Leave without saving?" while this is set.
  useEffect(() => {
    if (client.store.get().ui.settingsDirty !== draft.dirty) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: draft.dirty } })
  }, [client, draft.dirty])
  useEffect(() => () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } }), [client])

  const go = (t: AssistantTab) => client.settings(["assistants", info.id, t])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const keys = ASSISTANT_TABS.map(([k]) => k)
    const next = keys[(keys.indexOf(tab) + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]!
    go(next)
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus())
  }

  const elsewhere = ASSISTANT_TABS.filter(([k]) => k !== tab && draft.tabErrors(k)).map(([, l]) => l)
  const error = [
    draft.message,
    elsewhere.length > 0 ? `Not saved: ${listJoin(elsewhere)} ${elsewhere.length === 1 ? "has" : "have"} a field to correct.` : undefined,
    Object.keys(draft.localErrors).length > 0 ? "Correct the field marked above first." : undefined
  ].filter((m): m is string => m !== undefined).join(" ") || undefined
  const note = draft.saving ? "Saving…" : draft.justSaved
    ? "Saved. Applies from the next turn."
    : draft.dirty
    ? "Unsaved changes"
    : ""
  const names = hearingModelNames(sections)
  const parts = summaryParts(draft.saved, Object.values(modules.byId), names, voiceName(draft.saved.voice))

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="assistant-page" data-assistant={info.id}>
      <Strip parts={parts} marks={summaryMarks(draft.saved)} />
      <div className="-mx-5 overflow-x-auto border-b border-line px-5 scrollbar-quiet sm:mx-0 sm:px-0">
        <div role="tablist" aria-label={`${info.name} settings`} className="flex min-w-max gap-1">
          {ASSISTANT_TABS.map(([k, label]) => {
            const selected = k === tab
            const dirty = draft.tabChanged(k)
            const bad = draft.tabErrors(k)
            return (
              <button
                key={k}
                id={`tab-${k}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="assistant-panel"
                tabIndex={selected ? 0 : -1}
                data-tab={k}
                onKeyDown={onKey}
                onClick={() => go(k)}
                className={cx(
                  "relative inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[14px] transition-colors duration-[120ms]",
                  selected ? "border-voice text-ink" : "border-transparent text-ink-muted hover:text-ink"
                )}
              >
                {label}
                {dirty && <span aria-hidden="true" className="block size-2 rounded-full bg-voice" data-mark="dirty" title="Unsaved changes" />}
                {dirty && <span className="sr-only">(unsaved changes)</span>}
                {bad && <span aria-hidden="true" className="label block text-[11px] leading-none text-danger" data-mark="error" title="A field to correct">!</span>}
                {bad && <span className="sr-only">(a field to correct)</span>}
              </button>
            )
          })}
        </div>
      </div>
      {draft.behind && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-muted" data-testid="behind">
          Changed somewhere else since you started.
          <button type="button" className="ml-auto text-voice hover:underline" onClick={draft.cancel}>Load latest</button>
        </div>
      )}
      <div role="tabpanel" id="assistant-panel" aria-labelledby={`tab-${tab}`} className={cx("flex flex-col gap-6", tab === "used" && "pb-10")} data-testid={`tab-panel-${tab}`}>
        {tab === "basics" && <BasicsTab draft={draft} info={info} onDuplicate={() => setAsking("duplicate")} onDelete={() => setAsking("delete")} />}
        {tab === "behaviour" && <BehaviourTab draft={draft} info={info} />}
        {tab === "model" && <ModelTab draft={draft} info={info} />}
        {tab === "hearing" && <HearingTab draft={draft} info={info} />}
        {tab === "voice" && <VoiceTab draft={draft} info={info} />}
        {tab === "modules" && <ModulesTab draft={draft} info={info} />}
        {tab === "used" && <UsedTab info={info} />}
      </div>
      {tab !== "used" && (
        <FormFooter
          dirty={draft.dirty}
          saving={draft.saving}
          saveDisabled={!draft.dirty || draft.saving || Object.keys(draft.localErrors).length > 0}
          onSave={() => void draft.save()}
          onCancel={draft.cancel}
          cancelDisabled={!draft.dirty || draft.saving}
          note={note}
          noteTone={draft.justSaved ? "ok" : "muted"}
          {...(error !== undefined ? { error } : {})}
          warnings={draft.warnings.map((w) => w.message)}
          onSaveAnyway={() => void draft.save({ saveAnyway: true })}
          onBack={draft.dismissWarnings}
        />
      )}
      {asking === "delete" && (
        <DeleteDialog
          info={info}
          onClose={() => setAsking(undefined)}
          onDeleted={() => {
            client.store.dispatch({ type: "local/toast", message: `Deleted ${info.name}.`, tone: "info" })
            client.settings(["assistants"], { discard: true })
          }}
        />
      )}
      {asking === "duplicate" && (
        <DuplicateDialog
          info={info}
          onClose={() => setAsking(undefined)}
          onCreated={(id) => {
            setAsking(undefined)
            client.settings(["assistants", id], { discard: true })
          }}
        />
      )}
    </div>
  )
}
