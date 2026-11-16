"use client"
import { useState } from "react"
import type { Assistant, FieldError } from "@pva/protocol"
import { setPath } from "@/lib/assistants.ts"
import type { AssistantDraft } from "./useAssistantDraft.ts"

/**
 * The wizard's assistant as an `AssistantDraft`, so the fields of the assistant pages (account, model, hearing,
 * voice, module rows) work unchanged in its steps. Nothing is saved until "Create": there is no "Unsaved" mark and
 * no save bar. `errors` are those of a refused create, on the fields until the field is edited.
 */
export interface WizardDraft extends AssistantDraft {
  readonly replace: (next: Assistant) => void
  readonly setErrors: (errors: ReadonlyArray<FieldError>, message?: string) => void
}

export const useWizardDraft = (initial: () => Assistant): WizardDraft => {
  const [a, setA] = useState<Assistant>(initial)
  const [errors, setErrorList] = useState<ReadonlyArray<FieldError>>([])
  const [message, setMessage] = useState<string | undefined>()
  const [localErrors, setLocal] = useState<Readonly<Record<string, string>>>({})
  const edit = (f: (x: Assistant) => Assistant, touched?: string) => {
    setA(f)
    setMessage(undefined)
    if (touched !== undefined) setErrorList((list) => list.filter((e) => e.key !== touched && !(e.key?.startsWith(`${touched}.`) ?? false)))
  }
  return {
    current: a,
    saved: a,
    dirty: false,
    saving: false,
    justSaved: false,
    behind: false,
    errors,
    localErrors,
    warnings: [],
    message,
    changed: () => false,
    tabChanged: () => false,
    tabErrors: () => false,
    set: (path, value) => edit((x) => setPath(x, path, value), path),
    update: (f, touched) => edit(f, touched),
    reset: () => undefined,
    setLocalError: (path, m) =>
      setLocal((s) => {
        if (s[path] === m) return s
        const { [path]: _old, ...rest } = s
        return m === undefined ? rest : { ...rest, [path]: m }
      }),
    save: () => Promise.resolve({ kind: "refused", code: "internal", message: "The wizard creates, it does not save." }),
    cancel: () => undefined,
    dismissWarnings: () => undefined,
    replace: setA,
    setErrors: (list, m) => {
      setErrorList(list)
      setMessage(m)
    }
  }
}
