"use client"
import { useEffect, useRef, useState } from "react"
import type { FieldError, SettingField, SettingsForm, SettingsPatch } from "@pva/protocol"
import type { ResultMessage } from "@/lib/connection.ts"
import {
  computePatch,
  type Draft,
  draftLookup,
  fieldVisible,
  type FormSync,
  initialDraft,
  isEmptyPatch,
  onlyReloadFields,
  reconcile,
  someReloadFields
} from "@/lib/forms.ts"

/**
 * The forms of one settings page (docs/SETTINGS-UI.md §3.2): one per section on
 * the page, or the module's form, plus the opt-in of a module that serves a
 * chosen option. One sticky footer saves them all: each dirty form is sent
 * (sections with `settings.update`, modules with `module.configure`) and
 * reports its own errors. A save answered with warnings waits for "Save
 * anyway". Field visibility is judged on the drafts, so choosing a provider
 * shows its fields before saving; hidden fields are not sent.
 */

export interface PageFormDef {
  /** `s:<section id>` or `m:<module id>`. */
  readonly key: string
  readonly kind: "section" | "module"
  readonly id: string
  readonly form: SettingsForm
  readonly revision: number
  readonly readOnly: boolean
  /** Only these fields are edited on this page (a module's opt-in next to a choice). */
  readonly only?: ReadonlyArray<string>
}

export interface FormState {
  readonly sync: FormSync
  readonly serverErrors: ReadonlyArray<FieldError>
  /** A message for the form as a whole (a refused save without field errors). */
  readonly message?: string
  readonly localErrors: Readonly<Record<string, string>>
  /** Warnings returned by the last save: shown above the footer until "Save anyway" or an edit. */
  readonly confirm: ReadonlyArray<FieldError>
  /**
   * New for every fresh draft (Cancel, a save, a new form): the fields are drawn again from it, so text a renderer
   * keeps for itself (a number being typed, a list item not added yet) goes with the draft it belonged to.
   */
  readonly epoch: number
}

let epochSeq = 0

export interface PageFormView {
  readonly def: PageFormDef
  readonly state: FormState
  readonly lookup: (key: string) => unknown
  readonly shown: (field: SettingField) => boolean
  readonly patch: SettingsPatch
  readonly dirty: boolean
}

export interface SaveFns {
  readonly section: (id: string, patch: SettingsPatch, confirmWarnings: boolean) => Promise<ResultMessage>
  readonly module: (id: string, patch: SettingsPatch) => Promise<ResultMessage>
  readonly reload: () => Promise<ResultMessage>
}

const fresh = (def: PageFormDef): FormState => ({
  sync: { draft: initialDraft(def.form), baseRevision: def.revision, stale: false },
  serverErrors: [],
  localErrors: {},
  confirm: [],
  epoch: ++epochSeq
})

export const usePageForms = (defs: ReadonlyArray<PageFormDef>, saved: (key: string) => unknown, fns: SaveFns) => {
  const [states, setStates] = useState<Readonly<Record<string, FormState>>>(() => Object.fromEntries(defs.map((d) => [d.key, fresh(d)])))
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const previous = useRef(new Map(defs.map((d) => [d.key, d])))
  const latest = useRef(defs)
  latest.current = defs

  // A new form or revision from the server: a clean draft follows it, a dirty one is marked stale.
  useEffect(() => {
    if (saving) return
    setStates((current) => {
      let next = current
      for (const def of defs) {
        const prev = previous.current.get(def.key)
        const state = next[def.key]
        if (state === undefined) {
          next = { ...next, [def.key]: fresh(def) }
        } else if (prev !== undefined && (prev.revision !== def.revision || prev.form !== def.form)) {
          const sync = reconcile(state.sync, prev.form, def.form, def.revision)
          if (sync !== state.sync) next = { ...next, [def.key]: { ...state, sync } }
        }
        previous.current.set(def.key, def)
      }
      return next
    })
  }, [defs, saving])

  const views = computeViews(defs, states, saved)

  const update = (key: string, f: (s: FormState) => FormState) => setStates((current) => {
    const state = current[key]
    return state === undefined ? current : { ...current, [key]: f(state) }
  })

  const dirtyViews = views.filter((v) => v.dirty)
  const dirty = dirtyViews.length > 0
  const hasLocalErrors = views.some((v) => Object.keys(v.state.localErrors).length > 0)

  return {
    views,
    dirty,
    saving,
    saved: savedFlash && !dirty,
    hasLocalErrors,
    /** Warnings waiting for "Save anyway". */
    confirming: views.flatMap((v) => v.state.confirm),
    /** Every changed field applies after an engine reload: offer "Save and reload". */
    allReload: dirty && dirtyViews.every((v) => v.def.kind === "section" && onlyReloadFields(v.def.form, v.patch)),
    someReload: dirtyViews.some((v) => someReloadFields(v.def.form, v.patch)),
    setDraft: (key: string, f: (d: Draft) => Draft) => {
      setSavedFlash(false)
      update(key, (s) => ({ ...s, confirm: [], sync: { ...s.sync, draft: f(s.sync.draft) } }))
    },
    setLocalError: (key: string, field: string, message: string | undefined) =>
      update(key, (s) => {
        const { [field]: _old, ...rest } = s.localErrors
        return { ...s, localErrors: message === undefined ? rest : { ...rest, [field]: message } }
      }),
    /** "Go back" from the warnings of a save: keep the edits, drop the warnings. */
    dismissWarnings: () => setStates((current) => Object.fromEntries(Object.entries(current).map(([k, s]) => [k, s.confirm.length === 0 ? s : { ...s, confirm: [] }]))),
    /** Discard the edits (Cancel, or "Load latest" for one form). */
    cancel: (key?: string) =>
      setStates((current) => {
        const next: Record<string, FormState> = { ...current }
        for (const def of latest.current) if (key === undefined || def.key === key) next[def.key] = fresh(def)
        return next
      }),
    /**
     * Save every dirty form; `confirm`: "Save anyway"; `reload`: reload the engines after a full success; `edits`:
     * changes to make to drafts first (one button that also sets a field, e.g. the opt-in).
     */
    save: async (options: {
      readonly confirm?: boolean
      readonly reload?: boolean
      readonly edits?: Readonly<Record<string, (d: Draft) => Draft>>
    } = {}): Promise<boolean> => {
      if (hasLocalErrors || saving) return false
      let toSave = dirtyViews
      if (options.edits !== undefined) {
        const edited: Record<string, FormState> = { ...states }
        for (const [key, edit] of Object.entries(options.edits)) {
          const state = edited[key]
          if (state !== undefined) edited[key] = { ...state, sync: { ...state.sync, draft: edit(state.sync.draft) } }
        }
        setStates(edited)
        toSave = computeViews(defs, edited, saved).filter((v) => v.dirty)
      }
      if (toSave.length === 0) return options.edits !== undefined
      setSaving(true)
      setSavedFlash(false)
      let allOk = true
      for (const view of toSave) {
        update(view.def.key, ({ message: _m, ...s }) => ({ ...s, serverErrors: [], confirm: [] }))
        // continuation(state): the saved form is read from `latest.current` / `previous.current` when the answer comes.
        const result = view.def.kind === "section"
          ? await fns.section(view.def.id, view.patch, options.confirm === true) // continuation(state): see above
          : await fns.module(view.def.id, view.patch) // continuation(state): see above
        if (result.ok) {
          // The broadcast (section.changed / module.changed) arrived first and carries the saved values.
          const def = latest.current.find((d) => d.key === view.def.key) ?? view.def
          previous.current.set(def.key, def)
          update(view.def.key, () => fresh(def))
          continue
        }
        allOk = false
        const fieldErrors = result.error?.fieldErrors ?? []
        const warnings = result.error?.warnings ?? []
        update(view.def.key, (s) => {
          const { message: _m, ...rest } = s
          const message = fieldErrors.length === 0 && warnings.length === 0 ? result.error?.message ?? "The settings were not saved." : undefined
          return { ...rest, serverErrors: fieldErrors, confirm: warnings, ...(message !== undefined ? { message } : {}) }
        })
      }
      setSaving(false)
      if (allOk) {
        setSavedFlash(true)
        if (options.reload === true) await fns.reload() // continuation(none): nothing runs after the reload's answer
      }
      return allOk
    }
  }
}

export type PageForms = ReturnType<typeof usePageForms>

/** The forms as shown: visibility judged on the drafts (section drafts on the page, then saved values), patches. */
const computeViews = (
  defs: ReadonlyArray<PageFormDef>,
  states: Readonly<Record<string, FormState>>,
  saved: (key: string) => unknown
): ReadonlyArray<PageFormView> => {
  const sectionDrafts = defs.filter((d) => d.kind === "section").map((d) => states[d.key]?.sync.draft).filter((d): d is Draft => d !== undefined)
  const pageLookup = (key: string): unknown => {
    for (const draft of sectionDrafts) if (Object.hasOwn(draft.values, key)) return draft.values[key]
    return saved(key)
  }
  return defs.map((def) => {
    const state = states[def.key] ?? fresh(def)
    const lookup = def.kind === "section" ? pageLookup : draftLookup(state.sync.draft, () => undefined)
    const shown = (field: SettingField) => (def.only === undefined || def.only.includes(field.key)) && fieldVisible(field, lookup)
    const patch = def.readOnly ? { values: {}, secrets: {} } : computePatch(def.form, state.sync.draft, shown)
    // Text a field could not take yet (`localErrors`) is an edit too: leaving the page asks first, Cancel is offered.
    return { def, state, lookup, shown, patch, dirty: !isEmptyPatch(patch) || Object.keys(state.localErrors).length > 0 }
  })
}
