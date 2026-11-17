"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ChoiceOption, FieldError, ModuleInfo, SettingField, SettingsSection } from "@pva/protocol"
import { type Draft, errorsByKey, setDraftValue, splitAdvanced } from "@/lib/forms.ts"
import { formatSettingsHash, type NavPage, savedValues } from "@/lib/settingsTree.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { UnlockForm } from "../KeysPanel.tsx"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"
import { Tags } from "../ui/Tags.tsx"
import { FieldRow } from "./FieldRow.tsx"
import { ModuleHeader, ModuleInstances, ModuleTools, moduleStateText } from "./ModuleHeader.tsx"
import { MarkerLegend } from "./FormFooter.tsx"
import { ModuleRoutes } from "./ModuleRoutes.tsx"
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
 * form, tools). Every change needs admin, and this screen is only shown to a logged-in admin; a protected page (it
 * has keys, chooses providers or is an agent) is read-only only while the key vault is locked, and offers Unlock
 * right here. One sticky footer saves every form on the page.
 */
export function ServerPage({ page, extra }: { readonly page: NavPage; readonly extra?: React.ReactNode }) {
  const client = useClient()
  const keysLocked = useClientState((s) => s.vault.state === "locked")
  const admin = !keysLocked
  const vault = useClientState((s) => s.vault, shallowEqual)
  const allSections = useClientState((s) => s.sections)
  const modules = useClientState((s) => s.modules.byId)
  const sections = page.source.kind === "server" ? page.source.sections : []
  const pageModules = (page.source.kind === "server" ? page.source.moduleIds : []).flatMap((id) => (modules[id] !== undefined ? [modules[id]!] : []))
  const links = linkedOptions(sections)
  const editable = !page.protected || admin

  const defs: ReadonlyArray<PageFormDef> = useMemo(() => [
    ...sections.map((s): PageFormDef => ({ key: `s:${s.id}`, kind: "section", id: s.id, form: s.form, revision: s.revision, readOnly: s.protected === true && !admin })),
    ...pageModules.map((module) => ({ key: `m:${module.id}`, kind: "module" as const, id: module.id, form: module.settings, revision: module.revision, readOnly: module.protected === true && !admin })),
    ...links.flatMap((l) => {
      const m = modules[l.module.id]
      return m === undefined || l.module.optIn === undefined
        ? []
        : [{ key: `m:${m.id}`, kind: "module" as const, id: m.id, form: m.settings, revision: m.revision, readOnly: m.protected === true && !admin, only: [l.module.optIn] }]
    })
  ], [sections, pageModules.map((m) => `${m.id}:${m.revision}:${m.protected}`).join(","), links.map((l) => `${l.module.id}:${modules[l.module.id]?.revision}`).join(","), modules, admin])

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

  // A choice served by a module (Claude subscription) chosen but not saved yet: the card's one button commits it
  // (save, opt in, switch on, reload), so the footer's Save buttons wait and point at it.
  const commitVia = links.find((l) => {
    const view = forms.views.find((v) => v.def.key === `s:${l.section.id}`)
    return view !== undefined && view.lookup(l.field.key) === l.option.value && values.get(l.field.key) !== l.option.value
  })?.option.label

  const notInUse = !page.inUse
  // A merged page can hold protected and unprotected forms: while the vault is locked only the protected ones are
  // read-only, so Save and Cancel are there for the others.
  const someEditable = forms.views.some((v) => !v.def.readOnly && v.def.form.fields.some((f) => f.locked === undefined))
  return (
    <div className="flex flex-1 flex-col" data-testid={`page-${page.group}-${page.id}`} data-locked={editable ? undefined : "true"}>
      <div className="flex flex-1 flex-col gap-7 pb-8">
        {forms.views.some((v) => v.def.form.fields.some((f) => f.locked === undefined)) && <div className="-mb-3"><MarkerLegend device={false} /></div>}
        {!editable && <KeysLocked partly={someEditable} />}
        {notInUse && sections.length > 0 && <NotInUse />}
        {page.group === "shared" && page.id === "routing" && <RoutingIntro />}
        {page.id === "modules" && pageModules.length === 0 && (
          <p className="rounded-md border border-dashed border-line px-4 py-5 text-[14px] text-ink-muted" data-testid="no-modules">No modules are installed.</p>
        )}
        {forms.views.filter((v) => v.def.only === undefined && v.def.kind === "section").map((view) => (
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
                  editable={!view.def.readOnly && (m.protected !== true || admin)}
                  saved={values.get(field.key)}
                />
              )
            }}
          />
        ))}
        {pageModules.map((module, i) => (
          <ModuleBlock key={module.id} module={module} editable={module.protected !== true || admin} first={i === 0 && sections.length === 0} forms={forms} vault={vault} />
        ))}
        {extra}
      </div>
      {(someEditable || forms.dirty) && <PageFooter forms={forms} commitVia={commitVia} />}
    </div>
  )
}

/** One module on a shared page: its name, who uses it, its switch and state, its form and its tools. */
function ModuleBlock({ module: m, editable, first, forms, vault }: {
  readonly module: ModuleInfo
  readonly editable: boolean
  readonly first: boolean
  readonly forms: PageForms
  readonly vault: Parameters<typeof FieldRow>[0]["vault"]
}) {
  const view = forms.views.find((v) => v.def.key === `m:${m.id}` && v.def.only === undefined)
  const assistants = useClientState((s) => s.assistants, shallowEqual)
  // Who uses the module: the switched-on assistants that have it on; those with their own values for some of its fields are named for them.
  const users = assistants.filter((a) => a.on && a.modules[m.id]?.on === true)
  const ownerOf = (a: (typeof users)[number]) => {
    const own = a.modules[m.id]?.own
    if (own === undefined) return undefined
    const keys = m.settings.fields.filter((f) => f.overridable === true && Object.hasOwn(own, f.key) && JSON.stringify(own[f.key]) !== JSON.stringify(m.settings.values[f.key])).map((f) => f.label.toLowerCase())
    return keys.length === 0 ? "settings, the same as these" : keys.join(", ")
  }
  const sharedUsers = users.filter((a) => ownerOf(a) === undefined || ownerOf(a) === "settings, the same as these")
  const owners = users.filter((a) => ownerOf(a) !== undefined && ownerOf(a) !== "settings, the same as these")
  const link = (a: (typeof users)[number]) => <a href={formatSettingsHash(["assistants", a.id, "modules"])} className="text-voice underline-offset-4 hover:underline">{a.name}</a>
  return (
    <section className={cx("flex flex-col gap-5", !first && "border-t border-line/60 pt-7")} data-testid={`module-block-${m.id}`}>
      <div className="flex flex-col gap-1">
        <h3 className="text-[16px] font-medium text-ink">{m.name}</h3>
        {m.kind !== "agent" && m.kind !== "decider" && (
          <p className="text-[13px] text-ink-muted" data-testid="used-by">
            {users.length === 0 ? "Used by: no assistant yet" : (
              <>
                Used by:{" "}
                {sharedUsers.length === 0 ? "no assistant with these values" : sharedUsers.map((a, i) => <span key={a.id}>{i > 0 && ", "}{link(a)}</span>)}
                {owners.map((a) => <span key={a.id}>{" · "}{link(a)} has its own {ownerOf(a)}</span>)}
              </>
            )}
          </p>
        )}
      </div>
      {m.instances !== undefined && m.kind !== "agent" && m.kind !== "decider" ? <ModuleInstances module={m} /> : <ModuleHeader module={m} editable={editable} />}
      {view !== undefined && <FormBlock view={view} forms={forms} heading={undefined} vault={vault} renderAfter={() => null} />}
      {m.instances !== undefined && m.settings.fields.some((f) => f.overridable === true) && (
        <p className="-mt-2 text-[13px] text-ink-muted" data-testid="own-note">
          An assistant can have its own {m.settings.fields.filter((f) => f.overridable === true).map((f) => f.label.toLowerCase()).join(", ")}
          {m.settings.fields.some((f) => f.overridable !== true) ? "; the other settings are always shared" : ""}.
        </p>
      )}
      <ModuleTools module={m} />
      <ModuleRoutes module={m} />
    </section>
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
  // One rule for the form (Save, a button press): they act on exactly what is shown, never while a shown field is
  // invalid. A press with the draft gets only the shown fields' values.
  const firstInvalid = Object.entries(view.localErrors)[0]
  const invalid = firstInvalid === undefined ? undefined : `${shown.find((f) => f.key === firstInvalid[0])?.label ?? firstInvalid[0]}: ${firstInvalid[1]}`
  const shownDraft = Object.fromEntries(Object.entries(state.sync.draft.values).filter(([k]) => shownKeys.has(k)))
  const row = (field: SettingField) => (
    <div key={`${field.key}:${state.epoch}:${state.fieldEpochs[field.key] ?? 0}`} className="flex flex-col gap-4">
      <FieldRow
        field={field}
        form={def.form}
        draft={state.sync.draft}
        idPrefix={def.key.replace(":", "-")}
        errors={[...(errors.get(field.key) ?? []), ...(Object.hasOwn(state.localErrors, field.key) ? [state.localErrors[field.key]!] : [])]}
        warnings={warnings.get(field.key) ?? []}
        readOnly={def.readOnly}
        saving={forms.saving}
        vault={vault}
        setDraft={(f) => forms.setDraft(def.key, f)}
        onLocalError={(message) => forms.setLocalError(def.key, field.key, message)}
        onReset={() => forms.resetField(def.key, field)}
        context={{ form: { kind: def.kind, id: def.id }, dirty: view.dirty, draftValues: shownDraft, ...(invalid !== undefined ? { invalid } : {}) }}
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

/**
 * Shared settings › Routing: what TypeSafe is, that it is hosted, whether it is set up, and which devices let it
 * decide (the mock-up's header; the switch, key, model and address are the section's own fields below).
 */
function RoutingIntro() {
  const routing = useClientState((s) => s.sections.find((x) => x.id === "routing"))
  const devices = useClientState((s) => s.devices.filter((d) => d.settings.withoutPhrase.mode === "typesafe").map((d) => ({ id: d.id, name: d.name })), shallowEqual)
  const on = routing?.form.values.TYPESAFE_ROUTING === true
  const key = routing?.form.secrets.TYPESAFE_API_KEY?.set === true
  const status = on && key ? "On" : key ? "Key set, switched off" : on ? "Needs a key" : "Not set up"
  return (
    <section className="flex flex-col gap-3" data-testid="routing-intro">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-[16px] font-medium text-ink">TypeSafe</h3>
        <Tags tags={["hosted", "needs-key"]} />
        <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-ink-muted" data-testid="routing-status">
          <span className={cx("inline-block size-2 rounded-full", on && key ? "bg-ok" : "bg-ink-faint")} aria-hidden="true" />
          {status}
        </span>
      </div>
      {routing?.description !== undefined && <p className="text-[13px] text-ink-muted">{routing.description}</p>}
      <p className="text-[13px] text-ink-muted" data-testid="routing-used-by">
        Used by:{" "}
        {devices.length === 0 ? "no device yet" : devices.map((d, i) => (
          <span key={d.id}>
            {i > 0 && ", "}
            <a href={formatSettingsHash(["devices", d.id])} className="text-voice underline-offset-4 hover:underline">{d.name}</a>
          </span>
        ))}
      </p>
    </section>
  )
}

/** A protected page while the key vault is locked: say so, and take the vault password right here. */
function KeysLocked({ partly }: { readonly partly: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2/40 px-4 py-3" data-testid="keys-locked">
      <p className="flex items-start gap-2 text-[13px] text-ink">
        <Icon name="key" size={15} className="mt-0.5 shrink-0 text-ink-muted" />
        <span>The keys are locked, so {partly ? "some settings on this page" : "this page"} cannot be changed. Type the vault password to unlock them.</span>
      </p>
      <UnlockForm label="Unlock" compact idSuffix="page" />
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

/**
 * A step's marker: a check when done, a spinner while it happens, its number when it is the next thing to do, and a
 * dash while it waits for an earlier step. Square, so it does not look like the radio buttons of the choice above.
 */
const StepMarker = ({ n, state }: { readonly n: number; readonly state: "done" | "busy" | "next" | "waiting" }) => (
  <span
    aria-hidden="true"
    data-step={state}
    className={cx(
      "inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] border font-mono text-[11px]",
      state === "done" ? "border-ok/60 bg-ok/10 text-ok" : state === "next" ? "border-voice/70 text-voice" : "border-line text-ink-muted"
    )}
  >
    {state === "done" ? <Icon name="check" size={12} /> : state === "busy" ? <Spinner size={10} /> : state === "next" ? n : "–"}
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
      const ok = await forms.save({ edits }) // continuation(state): each step re-reads the store; `finish` checks `mounted`
      if (!ok) return finish("Not saved: see the messages on this page.")
    }
    if (!running) {
      setStep(`Starting ${m.name}…`)
      const on = await client.enableModule(m.id, true) // continuation(state): see above
      if (!on.ok) return finish(on.error?.message ?? `${m.name} did not start.`)
    }
    if (client.store.get().engine.engines.find((e) => e.stage === "llm")?.provider !== option.value) {
      setStep("Reloading engines…")
      const reloaded = await client.reloadEngines() // continuation(state): see above
      if (!reloaded.ok) return finish(reloaded.error?.message ?? "The engines were not reloaded.")
    }
    finish(undefined)
  }
  const finish = (message: string | undefined) => {
    if (!mounted.current) return
    setStep(undefined)
    setFailure(message)
  }

  const steps = [
    { text: `Chosen as the ${fieldKey === "LLM_PROVIDER" ? "language model" : "setting"}${chosen ? "" : " (not saved yet)"}`, ok: chosen, busy: false },
    { text: "Opted in", ok: optedIn, busy: false },
    { text: "Switched on and ready", ok: running, busy: m.state === "starting" },
    { text: "Answering (engines reloaded)", ok: inUse, busy: reloading }
  ]
  const firstOpen = steps.findIndex((st) => !st.ok)
  const optIn = optInField !== undefined && view !== undefined && (
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
  )
  // The separate controls: needed to switch it off again once it is in use, or to do the steps one by one. While
  // the one button above can do everything, they are folded away.
  const separate = complete || !editable ? (
    <div className="flex flex-col gap-4 border-t border-line/60 pt-4">
      {optIn}
      <ModuleHeader module={m} editable={editable} compact />
    </div>
  ) : (
    <details className="group border-t border-line/60 pt-3" data-testid="option-module-steps">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-[13px] text-ink-muted marker:hidden hover:text-ink">
        <Icon name="chevron" size={14} className="shrink-0 transition-transform duration-[120ms] group-open:rotate-90" />
        Do the steps one by one
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        {optIn}
        <ModuleHeader module={m} editable={editable} compact />
      </div>
    </details>
  )
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface px-4 py-4" data-testid="option-module" data-complete={complete ? "true" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[14px] font-medium text-ink">{m.name}</h4>
        <span className="text-[12px] text-ink-muted" data-testid="option-module-state">{moduleStateText(m)}</span>
      </div>
      <ol className="flex flex-col gap-2 text-[13px]" aria-label="Steps">
        {steps.map((st, i) => {
          const state = st.ok ? "done" : st.busy ? "busy" : i === firstOpen ? "next" : "waiting"
          return (
            <li key={st.text} className="flex items-center gap-2.5" data-done={st.ok ? "true" : "false"}>
              <StepMarker n={i + 1} state={state} />
              <span className={st.ok ? "text-ink" : "text-ink-muted"}>
                {st.text}
                <span className="sr-only">{st.ok ? ": done" : state === "busy" ? ": in progress" : ": not yet"}</span>
              </span>
            </li>
          )
        })}
      </ol>
      {editable && !complete && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" className="max-sm:h-11" onClick={() => void useIt()} disabled={step !== undefined || forms.saving} data-testid="use-option">
            {step !== undefined && <Spinner size={12} />}
            {step ?? `Use ${option.label}`}
          </Button>
          <span className="text-[12px] text-ink-muted">Does every step: saves the choice and the opt-in, switches it on, reloads the engines.</span>
        </div>
      )}
      {separate}
      {failure !== undefined && <p role="alert" className="text-[13px] text-danger">{failure}</p>}
    </div>
  )
}
