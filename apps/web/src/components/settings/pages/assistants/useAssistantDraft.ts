"use client"
import { useEffect, useRef, useState } from "react"
import type { Assistant, AssistantInfo, FieldError } from "@pva/protocol"
import { type AssistantTab, deepEqual, getPath, type Outcome, setPath, TAB_PATHS, tabOfPath, toAssistant } from "@/lib/assistants.ts"
import { useClient } from "../../../context.tsx"

/**
 * The edits of one assistant (docs/ASSISTANTS.md §7.1): the whole assistant is one draft, shared by every tab, saved
 * in one message (`assistant.save` takes the whole assistant). Nothing is kept in the draft until a field changes;
 * what the server pushes shows through for a clean assistant.
 *
 * - `rev`: the revision the draft started from; the save names it, and the server refuses (`stale`) when the
 *   assistant has changed since. A refused save drops the draft (the newest version is already in the state; the
 *   client tells the user) and shows it.
 * - A push that changes the assistant while the draft is dirty marks it `behind` ("Changed elsewhere"): Load latest.
 * - Field errors of a refused save stay on their fields until the field is edited; warnings wait for "Save anyway".
 */
export interface AssistantDraft {
  /** What the pages show: the draft, else what is saved. */
  readonly current: Assistant
  readonly saved: Assistant
  readonly dirty: boolean
  readonly saving: boolean
  readonly justSaved: boolean
  readonly behind: boolean
  readonly errors: ReadonlyArray<FieldError>
  /** The paths of fields that cannot take the text in them (a number field with "12a"): Save waits. */
  readonly localErrors: Readonly<Record<string, string>>
  readonly warnings: ReadonlyArray<FieldError>
  /** A refusal without a field (limits, the assistant could not save). */
  readonly message: string | undefined
  readonly changed: (path: string) => boolean
  readonly tabChanged: (tab: AssistantTab) => boolean
  readonly tabErrors: (tab: AssistantTab) => boolean
  readonly set: (path: string, value: unknown) => void
  /** Change several fields at once; `touched`: the path whose errors this edit clears. */
  readonly update: (f: (a: Assistant) => Assistant, touched?: string) => void
  readonly setLocalError: (path: string, message: string | undefined) => void
  readonly save: (options?: { readonly saveAnyway?: boolean }) => Promise<Outcome>
  readonly cancel: () => void
  readonly dismissWarnings: () => void
  readonly reset: (path: string) => void
}

interface DraftState {
  readonly edited: Assistant | undefined
  readonly rev: number
  readonly errors: ReadonlyArray<FieldError>
  readonly warnings: ReadonlyArray<FieldError>
  readonly message: string | undefined
  readonly localErrors: Readonly<Record<string, string>>
  readonly behind: boolean
}

const clean = (rev: number): DraftState => ({ edited: undefined, rev, errors: [], warnings: [], message: undefined, localErrors: {}, behind: false })

export const useAssistantDraft = (info: AssistantInfo): AssistantDraft => {
  const client = useClient()
  const saved = toAssistant(info)
  const [state, setState] = useState<DraftState>(() => clean(saved.rev))
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  // The version this page just saved, shown until the push with it arrives (the result can come first).
  const [awaiting, setAwaiting] = useState<Assistant | undefined>()
  const savedRef = useRef(saved)
  savedRef.current = saved

  const base = awaiting !== undefined && saved.rev < awaiting.rev + 1 ? { ...awaiting, rev: awaiting.rev + 1 } : saved
  const current = state.edited ?? base
  const dirty = state.edited !== undefined && !deepEqual({ ...state.edited, rev: 0 }, { ...base, rev: 0 })

  // A new version from the server: a clean draft follows it, a dirty one is marked behind.
  useEffect(() => {
    if (awaiting !== undefined && saved.rev >= awaiting.rev + 1) setAwaiting(undefined)
    setState((s) => {
      if (saved.rev === s.rev) return s
      if (s.edited === undefined || deepEqual({ ...s.edited, rev: 0 }, { ...saved, rev: 0 })) return clean(saved.rev)
      return { ...s, behind: true }
    })
  }, [saved.rev]) // eslint-disable-line react-hooks/exhaustive-deps

  const changed = (path: string) => state.edited !== undefined && !deepEqual(getPath(state.edited, path), getPath(base, path))

  const edit = (f: (a: Assistant) => Assistant, touched?: string) => {
    setJustSaved(false)
    setState((s) => {
      const from = s.edited ?? base
      const next = f(from)
      const errors = touched === undefined ? s.errors : s.errors.filter((e) => e.key !== touched && !(e.key?.startsWith(`${touched}.`) ?? false))
      return { ...s, edited: next, errors, warnings: [], message: undefined, rev: s.edited === undefined ? base.rev : s.rev }
    })
  }

  return {
    current,
    saved: base,
    dirty,
    saving,
    justSaved: justSaved && !dirty,
    behind: state.behind && dirty,
    errors: state.errors,
    localErrors: state.localErrors,
    warnings: state.warnings,
    message: state.message,
    changed,
    tabChanged: (tab) => state.edited !== undefined && TAB_PATHS[tab].some(changed),
    tabErrors: (tab) => state.errors.some((e) => e.key !== null && tabOfPath(e.key) === tab),
    set: (path, value) => edit((a) => setPath(a, path, value), path),
    update: (f, touched) => edit(f, touched),
    reset: (path) => edit((a) => setPath(a, path, getPath(base, path)), path),
    setLocalError: (path, message) =>
      setState((s) => {
        if ((s.localErrors[path] === undefined) === (message === undefined) && s.localErrors[path] === message) return s
        const { [path]: _old, ...rest } = s.localErrors
        return { ...s, localErrors: message === undefined ? rest : { ...rest, [path]: message } }
      }),
    cancel: () => {
      setJustSaved(false)
      setState(clean(base.rev))
    },
    dismissWarnings: () => setState((s) => ({ ...s, warnings: [] })),
    save: async (options = {}) => {
      const edited = state.edited
      if (edited === undefined || saving || Object.keys(state.localErrors).length > 0) return { kind: "refused", code: "internal", message: "Nothing to save." }
      setSaving(true)
      setJustSaved(false)
      const outcome = await client.saveAssistant({ ...edited, rev: state.rev }, options.saveAnyway === true ? { saveAnyway: true } : {}) // continuation(state): the draft state is read again when the answer comes
      setSaving(false)
      switch (outcome.kind) {
        case "ok":
          setAwaiting(edited)
          setState(clean(edited.rev + 1))
          setJustSaved(true)
          break
        case "stale":
          setState(clean(savedRef.current.rev))
          break
        case "invalid":
          setState((s) => ({ ...s, errors: outcome.fieldErrors, warnings: [], message: outcome.fieldErrors.every((e) => e.key === null) ? outcome.message : undefined }))
          break
        case "warnings":
          setState((s) => ({ ...s, warnings: outcome.warnings, errors: [], message: undefined }))
          break
        case "refused":
          setState((s) => ({ ...s, message: outcome.message }))
          break
      }
      return outcome
    }
  }
}
