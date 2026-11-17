"use client"
import { useState } from "react"
import type { AssistantInfo, Assignment, DeviceListInfo, DeviceTarget, DeviceTypeInfo } from "@pva/protocol"
import { type blankAssistantBody, copyName, targetKey, targetName, toBody } from "@/lib/assistants.ts"
import { useClient, useClientState } from "../../../context.tsx"
import { inputClass } from "../../../fields/types.ts"
import { Dialog, DialogButtons } from "./parts.tsx"
import { MAX_ASSIGNMENTS, WAKE_PHRASE_CHARS_MAX, WAKE_PHRASE_WORDS_MAX, wakeWords } from "@pva/protocol"

/** The dialogs of the assistant pages: delete (names the devices), duplicate, new, and "Add to a device…". */

/** Delete: names every device (or type defaults) the assistant is taken off, then sends `assistant.delete` with the rev. */
export function DeleteDialog({ info, onClose, onDeleted }: { readonly info: AssistantInfo; readonly onClose: () => void; readonly onDeleted: () => void }) {
  const client = useClient()
  const devices = useClientState((s) => s.devices)
  const types = useClientState((s) => s.deviceTypes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // The version the user was shown: if the assistant changes while the dialog is open, the delete is refused (stale).
  const [rev] = useState(info.rev)
  const places = info.usedOn.map((u) => targetName(u.target, devices, types))
  return (
    <Dialog title={`Delete ${info.name}?`} onClose={onClose} testId="delete-dialog" labelId="delete-dialog-title">
      <div className="mt-1 flex flex-col gap-2 text-[14px] text-ink-muted" aria-describedby="delete-dialog-text">
        <p id="delete-dialog-text">{info.name} and its conversations are removed. This cannot be undone.</p>
        {places.length > 0
          ? (
            <>
              <p>It is taken off these devices:</p>
              <ul className="flex flex-col gap-0.5 text-ink" data-testid="delete-devices">
                {info.usedOn.map((u, i) => <li key={targetKey(u.target)} className="list-inside list-disc">{places[i]}{u.target.kind === "type" ? " (defaults)" : ""}</li>)}
              </ul>
            </>
          )
          : <p>It is not on any device.</p>}
      </div>
      {error !== undefined && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
      <DialogButtons
        cancel="Keep it"
        confirm={`Delete ${info.name}`}
        variant="danger"
        busy={busy}
        onCancel={onClose}
        onConfirm={() => {
          setBusy(true)
          setError(undefined)
          // continuation(none): only this dialog's own state; the page may be gone after the delete
          void client.deleteAssistant(info.id, rev, info.name).then((o) => {
            setBusy(false)
            if (o.kind === "ok") onDeleted()
            else if (o.kind === "stale") onClose()
            else setError(o.message)
          })
        }}
      />
    </Dialog>
  )
}

/** A name for a new assistant: duplicate (the body is copied, `copyOf` says so) or a blank one. */
export function NameDialog({ title, text, confirm, initial, make, onClose, onCreated }: {
  readonly title: string
  readonly text: string
  readonly confirm: string
  readonly initial: string
  readonly make: (name: string) => { readonly body: ReturnType<typeof blankAssistantBody>; readonly copyOf?: string }
  readonly onClose: () => void
  readonly onCreated: (id: string) => void
}) {
  const client = useClient()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  /** The warnings of a create (a hosted voice without its key): nothing was created; "<confirm> anyway" sends `saveAnyway`. */
  const [warnings, setWarnings] = useState<ReadonlyArray<string>>([])
  const submit = (saveAnyway = false) => {
    setBusy(true)
    setError(undefined)
    setWarnings([])
    const { body, copyOf } = make(name.trim())
    // continuation(none): only this dialog's own state; the page navigates to the new assistant
    void client.createAssistant(body, { ...(copyOf !== undefined ? { copyOf } : {}), ...(saveAnyway ? { saveAnyway: true } : {}) }).then((o) => {
      setBusy(false)
      if (o.kind === "ok" && o.assistantId !== undefined) onCreated(o.assistantId)
      else if (o.kind === "warnings") setWarnings(o.warnings.map((w) => w.message))
      else if (o.kind === "invalid") setError(o.fieldErrors.map((e) => e.message).join(" "))
      else if (o.kind !== "ok") setError(o.message)
    })
  }
  const warned = warnings.length > 0
  return (
    <Dialog title={title} onClose={onClose} testId="name-dialog" labelId="name-dialog-title" wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() !== "" && !busy) submit(warned)
        }}
      >
        <p className="mt-1 text-[14px] text-ink-muted">{text}</p>
        <label htmlFor="new-assistant-name" className="mt-3 block text-[14px] font-medium text-ink">Name</label>
        <input
          id="new-assistant-name"
          className={`${inputClass} mt-1.5`}
          value={name}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value)
            setWarnings([])
          }}
          aria-invalid={error !== undefined || undefined}
        />
        {error !== undefined && <p role="alert" className="mt-2 text-[13px] text-danger" data-testid="field-error">{error}</p>}
        {warned && (
          <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-2.5" role="alert" data-testid="save-warnings">
            {warnings.map((w, i) => <p key={i} className="text-[13px] text-ink">{w}</p>)}
          </div>
        )}
        {warned
          ? <DialogButtons cancel="Go back" confirm={`${confirm} anyway`} busy={busy} onCancel={() => setWarnings([])} onConfirm={() => submit(true)} />
          : <DialogButtons cancel="Cancel" confirm={confirm} busy={busy} onCancel={onClose} onConfirm={() => submit()} disabled={name.trim() === ""} />}
      </form>
    </Dialog>
  )
}

export function DuplicateDialog({ info, onClose, onCreated }: { readonly info: AssistantInfo; readonly onClose: () => void; readonly onCreated: (id: string) => void }) {
  const names = useClientState((s) => s.assistants.map((a) => a.name))
  return (
    <NameDialog
      title={`Duplicate ${info.name}`}
      text="Starts a new assistant with the same settings. Devices and phrases are not copied."
      confirm="Duplicate"
      initial={copyName(info.name, names)}
      make={(name) => ({ body: { ...toBody(info), name }, copyOf: info.id })}
      onClose={onClose}
      onCreated={onCreated}
    />
  )
}

/** The list a target has now: a device's own, else what it follows. */
const listOf = (t: DeviceTarget, devices: ReadonlyArray<DeviceListInfo>, types: ReadonlyArray<DeviceTypeInfo>): { readonly list: ReadonlyArray<Assignment>; readonly rev: number } | undefined => {
  if (t.kind === "device") {
    const d = devices.find((x) => x.id === t.id)
    return d === undefined ? undefined : { list: d.settings.assistants, rev: d.rev }
  }
  const type = types.find((x) => x.kind === t.type)
  return type === undefined ? undefined : { list: type.settings.assistants, rev: type.rev }
}

/**
 * What the protocol would refuse in "Add to a device…" before it is sent (the request would throw): a phrase without
 * words or too long, or a list that is full. `undefined`: it can be sent.
 */
export const addToDeviceProblem = (phrase: string, list: ReadonlyArray<Assignment>, place: string): string | undefined => {
  const text = phrase.trim()
  if (text !== "") {
    const words = wakeWords(text).length
    if (words === 0) return "A wake phrase needs at least one word. Leave it empty to add it without one."
    if (words > WAKE_PHRASE_WORDS_MAX) return `Use at most ${WAKE_PHRASE_WORDS_MAX} words.`
    if (text.length > WAKE_PHRASE_CHARS_MAX) return `Use at most ${WAKE_PHRASE_CHARS_MAX} characters.`
  }
  if (list.length >= MAX_ASSIGNMENTS) return `${place} has ${MAX_ASSIGNMENTS} assistants already, the most it can have. Take one off first.`
  return undefined
}

/** "Add to a device…": appends the assistant to a device's (or a type's defaults) list with one phrase, through `device.save`. */
export function AddToDeviceDialog({ info, onClose }: { readonly info: AssistantInfo; readonly onClose: () => void }) {
  const client = useClient()
  const devices = useClientState((s) => s.devices)
  const types = useClientState((s) => s.deviceTypes)
  const targets: ReadonlyArray<DeviceTarget> = [
    ...types.map((t): DeviceTarget => ({ kind: "type", type: t.kind })),
    ...devices.map((d): DeviceTarget => ({ kind: "device", id: d.id }))
  ].filter((t) => !info.usedOn.some((u) => targetKey(u.target) === targetKey(t)))
  const [choice, setChoice] = useState(targets[0] === undefined ? "" : targetKey(targets[0]))
  const [phrase, setPhrase] = useState(`hey ${info.name.toLowerCase()}`)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [anyway, setAnyway] = useState(false)
  const target = targets.find((t) => targetKey(t) === choice)
  const send = (saveAnyway: boolean) => {
    if (target === undefined) return
    const current = listOf(target, devices, types)
    if (current === undefined) return
    const problem = addToDeviceProblem(phrase, current.list, targetName(target, devices, types))
    if (problem !== undefined) {
      setAnyway(false)
      setMessage(problem)
      return
    }
    setBusy(true)
    setMessage(undefined)
    const added: Assignment = { assistant: info.id, phrases: phrase.trim() === "" ? [] : [phrase.trim()] }
    // continuation(none): only this dialog's own state
    void client
      .saveDevice(target, current.rev, { assistants: [...current.list, added] }, { label: targetName(target, devices, types), ...(saveAnyway ? { saveAnyway: true } : {}) })
      .then((o) => {
        setBusy(false)
        if (o.kind === "ok") {
          client.store.dispatch({ type: "local/toast", message: `${info.name} added to ${targetName(target, devices, types)}.`, tone: "info" })
          onClose()
        } else if (o.kind === "stale") onClose()
        else if (o.kind === "warnings") {
          setAnyway(true)
          setMessage(o.message)
        } else setMessage(o.kind === "invalid" ? o.fieldErrors.map((e) => e.message).join(" ") : o.message)
      }, () => {
        // The request itself failed (it could not be sent): the dialog is usable again.
        setBusy(false)
        setMessage("Could not add it. Try again.")
      })
  }
  return (
    <Dialog title={`Add ${info.name} to a device`} onClose={onClose} testId="add-device-dialog" labelId="add-device-title" wide>
      {targets.length === 0 ? (
        <>
          <p className="mt-1 text-[14px] text-ink-muted">{info.name} is on every device already.</p>
          <DialogButtons cancel="Close" confirm="Add" busy={false} onCancel={onClose} onConfirm={onClose} disabled />
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (!busy) send(anyway) }}>
          <label htmlFor="atd-device" className="mt-3 block text-[14px] font-medium text-ink">Device</label>
          <select id="atd-device" className={`${inputClass} mt-1.5`} value={choice} onChange={(e) => { setChoice(e.target.value); setAnyway(false); setMessage(undefined) }}>
            {targets.map((t) => <option key={targetKey(t)} value={targetKey(t)}>{targetName(t, devices, types)}{t.kind === "type" ? " (defaults)" : ""}</option>)}
          </select>
          <label htmlFor="atd-phrase" className="mt-3 block text-[14px] font-medium text-ink">Wake phrase</label>
          <input id="atd-phrase" className={`${inputClass} mt-1.5`} value={phrase} autoComplete="off" onChange={(e) => { setPhrase(e.target.value); setAnyway(false); setMessage(undefined) }} />
          <p className="mt-1.5 text-[13px] text-ink-muted">Leave empty to add it without a phrase for now.</p>
          {message !== undefined && <p role="alert" className="mt-2 text-[13px] text-warn" data-testid="add-device-message">{message}</p>}
          <DialogButtons cancel="Cancel" confirm={anyway ? "Add anyway" : "Add"} busy={busy} onCancel={onClose} onConfirm={() => send(anyway)} />
        </form>
      )}
    </Dialog>
  )
}

