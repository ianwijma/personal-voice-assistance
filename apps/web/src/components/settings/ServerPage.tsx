"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ChoiceOption, FieldError, ModuleInfo, SettingField, SettingsSection } from "@pva/protocol"
import { type Draft, errorsByKey, setDraftValue, splitAdvanced } from "@/lib/forms.ts"
import { type NavPage, savedValues } from "@/lib/settingsTree.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { UnlockForm } from "../KeysPanel.tsx"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"
import { FieldRow } from "./FieldRow.tsx"
import { ModuleHeader, ModuleTools, moduleStateText } from "./ModuleHeader.tsx"
import { PageFooter } from "./PageFooter.tsx"
import { type PageFormDef, type PageForms, type PageFormView, usePageForms } from "./usePageForms.ts"

/** Options of a choice field that a module serves (`ChoiceOption.module`). */
const linkedOptions = (sections: ReadonlyArray<SettingsSection>) =>
  sections.flatMap((s) =>
    s.form.fields.flatMap((f) =>
      f.type === "choice" ? f.options.flatMap((o) => (o.module !== undefined ? [{ section: s, field: f, option: o, module: o.module }] : [])) : []
    )
  )

/**
 * A page built from server data (docs/SETTINGS-UI.md §3.2): the sections placed on it, or a module (switch, status,
 * form, tools). Protected pages are read-only without admin access and offer the password right here. One sticky
 * footer saves every form on the page.
 */
export function ServerPage({ page }: { readonly page: NavPage }) {
  const client = useClient()
  const admin = useClientState((s) => s.vault.admin)
  const vault = useClientState((s) => s.vault, shallowEqual)
  const allSections = useClientState((s) => s.sections)
  const modules = useClientState((s) => s.modules.byId)
  const sections = page.source.kind === "sections" ? page.source.sections : []
  const module = page.source.kind === "module" ? modules[page.source.moduleId] : undefined
  const links = linkedOptions(sections)
  const editable = !page.protected || admin

  const defs: ReadonlyArray<PageFormDef> = useMemo(() => [
    ...sections.map((s): PageFormDef => ({ key: `s:${s.id}`, kind: "section", id: s.id, form: s.form, revision: s.revision, readOnly: s.protected === true && !admin })),
    ...(module !== undefined
      ? [{ key: `m:${module.id}`, kind: "module" as const, id: module.id, form: module.settings, revision: module.revision, readOnly: module.protected === true && !admin }]
      : []),
    ...links.flatMap((l) => {
      const m = modules[l.module.id]
      return m === undefined || l.module.optIn === undefined
        ? []
        : [{ key: `m:${m.id}`, kind: "module" as const, id: m.id, form: m.settings, revision: m.revision, readOnly: m.protected === true && !admin, only: [l.module.optIn] }]
    })
  ], [sections, module, links.map((l) => `${l.module.id}:${modules[l.module.id]?.revision}`).join(","), modules, admin])

  const values = useMemo(() => savedValues(allSections), [allSections])
  const forms = usePageForms(defs, (key) => values.get(key), {
    section: (id, patch, confirm) => client.updateSection(id, patch, confirm),
    module: (id, patch) => client.configureModule(id, patch),
    reload: () => client.reloadEngines()
  })

  // The shell asks before leaving a page with unsaved edits.
  useEffect(() => {
    if (client.store.get().ui.settingsDirty !== forms.dirty) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: forms.dirty } })
  }, [client, forms.dirty])
  useEffect(() => () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } }), [client])

  const notInUse = !page.inUse
  return (
    <div className="flex flex-1 flex-col" data-testid={`page-${page.group}-${page.id}`} data-locked={editable ? undefined : "true"}>
      <div className="flex flex-1 flex-col gap-7 pb-8">
        {!editable && <EditAccess />}
        {notInUse && sections.length > 0 && <NotInUse />}
        {module !== undefined && <ModuleHeader module={module} editable={editable} />}
        {forms.views.filter((v) => v.def.only === undefined).map((view) => (
          <FormBlock key={view.def.key} view={view} forms={forms} heading={sections.length > 1 ? sections.find((s) => `s:${s.id}` === view.def.key)?.title : undefined} vault={vault}
            renderAfter={(field) => {
              const link = links.find((l) => l.field.key === field.key && `s:${l.section.id}` === view.def.key)
              const selected = link === undefined ? undefined : links.find((l) => l.field.key === field.key && l.option.value === view.lookup(field.key))
              if (selected === undefined) return null
              const m = modules[selected.module.id]
              return m === undefined ? null : (
                <OptionModuleCard
                  key={`card-${m.id}`}
                  module={m}
                  option={selected.option}
                  fieldKey={field.key}
                  view={forms.views.find((v) => v.def.key === `m:${m.id}` && v.def.only !== undefined)}
                  forms={forms}
                  editable={editable}
                  saved={values.get(field.key)}
                />
              )
            }}
          />
        ))}
        {module !== undefined && <ModuleTools module={module} />}
      </div>
      {editable && (forms.views.some((v) => !v.def.readOnly && v.def.form.fields.some((f) => f.locked === undefined)) || forms.dirty) && <PageFooter forms={forms} />}
    </div>
  )
}

/** The fields of one form: errors and warnings by field, the stale banner, and Advanced. */
function FormBlock({ view, forms, heading, vault, renderAfter }: {
  readonly view: PageFormView
  readonly forms: PageForms
  readonly heading: string | undefined
  readonly vault: Parameters<typeof FieldRow>[0]["vault"]
  readonly renderAfter: (field: SettingField) => React.ReactNode
}) {
  const { def, state } = view
  const shown = def.form.fields.filter(view.shown)
  const shownKeys = new Set(shown.map((f) => f.key))
  const errors = errorsByKey([...def.form.errors, ...state.serverErrors])
  // The saved values' warnings; a save's new warnings are shown with "Save anyway" in the footer.
  const warnings = errorsByKey(def.form.warnings ?? [])
  // Problems of fields that are not on screen (hidden, or of another section) are shown for the form as a whole.
  const loose = (map: ReadonlyMap<string | null, ReadonlyArray<string>>) =>
    [...map.entries()].flatMap(([key, list]) => (key === null || !shownKeys.has(key) ? list : []))
  const formErrors = [...(state.message !== undefined ? [state.message] : []), ...loose(errors)]
  const formWarnings = loose(warnings)
  const { basic, advanced } = splitAdvanced(shown)
  const row = (field: SettingField) => (
    <div key={field.key} className="flex flex-col gap-4">
      <FieldRow
        field={field}
        form={def.form}
        draft={state.sync.draft}
        idPrefix={def.key.replace(":", "-")}
        errors={[...(errors.get(field.key) ?? []), ...(state.localErrors[field.key] !== undefined ? [state.localErrors[field.key]!] : [])]}
        warnings={warnings.get(field.key) ?? []}
        readOnly={def.readOnly}
        saving={forms.saving}
        vault={vault}
        setDraft={(f) => forms.setDraft(def.key, f)}
        onLocalError={(message) => forms.setLocalError(def.key, field.key, message)}
      />
      {renderAfter(field)}
    </div>
  )
  if (shown.length === 0 && formErrors.length === 0) return null
  return (
    <section className="flex flex-col gap-5" data-testid={`form-${def.key.replace(":", "-")}`} data-readonly={def.readOnly ? "true" : undefined}>
      {heading !== undefined && <h3 className="label text-ink-faint">{heading}</h3>}
      {state.sync.stale && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-muted">
          Changed in another tab
          <button type="button" className="ml-auto text-voice hover:underline" onClick={() => forms.cancel(def.key)}>Load latest</button>
        </div>
      )}
      {formErrors.length > 0 && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-ink">
          {formErrors.map((m, i) => <p key={i}>{m}</p>)}
        </div>
      )}
      {formWarnings.length > 0 && (
        <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-ink" data-testid="form-warnings">
          {formWarnings.map((m, i) => <p key={i}>{m}</p>)}
        </div>
      )}
      {basic.map(row)}
      {advanced.length > 0 && (
        <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-4">
          <summary className="label flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-ink-muted marker:hidden hover:text-ink">
            <Icon name="chevron" size={14} className="transition-transform duration-[120ms] group-open:rotate-90" />
            Advanced ({advanced.length})
          </summary>
          <div className="mt-4 flex flex-col gap-5">{advanced.map(row)}</div>
        </details>
      )}
    </section>
  )
}

/** A protected page without admin access: say so, and take the password right here. */
function EditAccess() {
  const state = useClientState((s) => s.vault.state)
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2/40 px-4 py-3" data-testid="edit-access">
      <p className="flex items-start gap-2 text-[13px] text-ink">
        <Icon name="lock" size={15} className="mt-0.5 shrink-0 text-ink-muted" />
        <span>
          {state === "locked"
            ? "Protected, and the keys are locked. Type the password to unlock them and edit this page."
            : "Protected: only a page where the password was typed may change this. Type it to edit."}
        </span>
      </p>
      <UnlockForm label={state === "locked" ? "Unlock" : "Get edit access"} compact idSuffix="page" />
    </div>
  )
}

function NotInUse() {
  return (
    <p className="rounded-md border border-line bg-surface-2/40 px-4 py-3 text-[13px] text-ink-muted" data-testid="not-in-use">
      Not in use with the current settings. You can set it up now (a key, for example) and switch to it later.
    </p>
  )
}

const done = (ok: boolean, busy = false) => (
  <span aria-hidden="true" className={cx("inline-flex size-4 shrink-0 items-center justify-center rounded-full border", ok ? "border-ok text-ok" : "border-ink-faint")}>
    {busy ? <Spinner size={10} /> : ok ? <Icon name="check" size={11} /> : null}
  </span>
)

/**
 * The module that serves a chosen option (`ChoiceOption.module`, e.g. Claude subscription), next to the choice: its
 * state, its opt-in (part of the page's draft), its switch, and one button that does it all: save the choice and
 * the opt-in, switch the module on, reload the engines. The server still checks everything (admin, opt-in).
 */
function OptionModuleCard({ module: m, option, fieldKey, view, forms, editable, saved }: {
  readonly module: ModuleInfo
  readonly option: ChoiceOption
  readonly fieldKey: string
  readonly view: PageFormView | undefined
  readonly forms: PageForms
  readonly editable: boolean
  readonly saved: unknown
}) {
  const client = useClient()
  const vault = useClientState((s) => s.vault, shallowEqual)
  const llm = useClientState((s) => s.engine.engines.find((e) => e.stage === "llm")?.provider)
  const reloading = useClientState((s) => s.engine.state === "reloading")
  const [step, setStep] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])
  const optInKey = option.module?.optIn
  const optInField = optInKey === undefined ? undefined : m.settings.fields.find((f) => f.key === optInKey)
  const optedIn = optInKey === undefined || m.settings.values[optInKey] === true
  const chosen = saved === option.value
  const running = m.enabled && m.state === "running"
  const inUse = llm === option.value
  const complete = chosen && optedIn && running && inUse

  const useIt = async () => {
    setFailure(undefined)
    if (!chosen || !optedIn) {
      setStep("Saving…")
      // The page's own save: the choice (already in the draft), the opt-in, and any other edits on the page.
      const edits = optInKey !== undefined && view !== undefined && !optedIn
        ? { [view.def.key]: (d: Draft) => setDraftValue(d, optInKey, true) }
        : {}
      const ok = await forms.save({ edits })
      if (!ok) return finish("Not saved: see the messages on this page.")
    }
    if (!running) {
      setStep(`Starting ${m.name}…`)
      const on = await client.enableModule(m.id, true)
      if (!on.ok) return finish(on.error?.message ?? `${m.name} did not start.`)
    }
    if (client.store.get().engine.engines.find((e) => e.stage === "llm")?.provider !== option.value) {
      setStep("Reloading engines…")
      const reloaded = await client.reloadEngines()
      if (!reloaded.ok) return finish(reloaded.error?.message ?? "The engines were not reloaded.")
    }
    finish(undefined)
  }
  const finish = (message: string | undefined) => {
    if (!mounted.current) return
    setStep(undefined)
    setFailure(message)
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface px-4 py-4" data-testid="option-module" data-complete={complete ? "true" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[14px] font-medium text-ink">{m.name}</h4>
        <span className="text-[12px] text-ink-muted" data-testid="option-module-state">{moduleStateText(m)}</span>
      </div>
      <ol className="flex flex-col gap-2 text-[13px]">
        <li className="flex items-center gap-2">{done(chosen)}<span className={chosen ? "text-ink" : "text-ink-muted"}>Chosen as the {fieldKey === "LLM_PROVIDER" ? "language model" : "setting"}{chosen ? "" : " (not saved yet)"}</span></li>
        <li className="flex items-center gap-2">{done(optedIn)}<span className={optedIn ? "text-ink" : "text-ink-muted"}>Opted in</span></li>
        <li className="flex items-center gap-2">{done(running, m.state === "starting")}<span className={running ? "text-ink" : "text-ink-muted"}>Switched on and ready</span></li>
        <li className="flex items-center gap-2">{done(inUse, reloading)}<span className={inUse ? "text-ink" : "text-ink-muted"}>Answering (engines reloaded)</span></li>
      </ol>
      {optInField !== undefined && view !== undefined && (
        <FieldRow
          field={optInField}
          form={m.settings}
          draft={view.state.sync.draft}
          idPrefix={`m-${m.id}`}
          errors={view.state.serverErrors.filter((e: FieldError) => e.key === optInField.key).map((e) => e.message)}
          warnings={[]}
          readOnly={view.def.readOnly}
          saving={forms.saving || step !== undefined}
          vault={vault}
          setDraft={(f) => forms.setDraft(view.def.key, f)}
          onLocalError={() => undefined}
        />
      )}
      <ModuleHeader module={m} editable={editable} compact />
      {editable && !complete && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="sm" onClick={() => void useIt()} disabled={step !== undefined || forms.saving}>
            {step !== undefined && <Spinner size={12} />}
            {step ?? `Use ${option.label}`}
          </Button>
          <span className="text-[12px] text-ink-faint">Saves the choice and the opt-in, switches it on and reloads the engines.</span>
        </div>
      )}
      {failure !== undefined && <p role="alert" className="text-[13px] text-danger">{failure}</p>}
    </div>
  )
}
