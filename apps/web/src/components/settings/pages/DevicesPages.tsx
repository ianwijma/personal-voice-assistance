"use client"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { type DeviceInfo, MAX_DEVICE_NAME_CHARS } from "@pva/protocol"
import { activationSummary, lastSeenText } from "@/lib/profileForm.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { inputClass } from "../../fields/types.ts"
import { Icon, Spinner } from "../../ui/Icon.tsx"
import { useDialog } from "../../ui/Panel.tsx"
import { Button, cx } from "../../ui/controls.tsx"
import { ProfileForm } from "../ProfileForm.tsx"

/** The time, ticking every 30 s, for "Seen 5 min ago". */
const useNow = () => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000) // continuation(none): only the clock
    return () => clearInterval(t)
  }, [])
  return now
}

/** Devices › All devices: name, kind, last seen, the audio owner, how it activates. */
export function DevicesPage() {
  const client = useClient()
  const devices = useClientState((s) => s.devices)
  const kinds = useClientState((s) => s.frontends)
  const now = useNow()
  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line px-4 py-6" data-testid="no-devices">
        <Icon name="device" size={22} className="text-ink-faint" />
        <p className="text-[14px] text-ink">No devices yet.</p>
        <p className="text-[13px] text-ink-muted">Open the voice assistant on a phone, tablet or computer: it appears here the first time it connects.</p>
      </div>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="device-list">
      {devices.map((d) => {
        const overrides = Object.keys(d.overrides).length
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => client.settings(["devices", d.id])}
              className="flex min-h-16 w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2/60"
              data-device={d.id}
            >
              <span className={cx("inline-flex size-9 shrink-0 items-center justify-center rounded-full border", d.connections > 0 ? "border-ok/50 text-ok" : "border-line text-ink-faint")} aria-hidden="true">
                <Icon name="device" size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate text-[14px] text-ink">{d.name}</span>
                  {d.audioOwner && <span className="label rounded-sm border border-you/50 px-1 text-[9px] leading-[14px] text-you" data-testid="audio-owner">Audio owner now</span>}
                </span>
                <span className="block text-[13px] text-ink-muted" title={activationSummary(d.profile)}>
                  {d.profile.activation === "always" ? "Always listening" : (
                    <>
                      Wake phrase ·{" "}
                      <PhraseAndCount phrase={d.profile.wakePhrases[0] ?? ""} more={d.profile.wakePhrases.length - 1} />
                    </>
                  )}
                </span>
                {/* Facts side by side; the "·" separators exist only from 640 px, where a line does not wrap, so none
                    is left at the end of a line. The kind is dropped on a phone. */}
                <span className="flex flex-wrap gap-x-3 text-[12px] text-ink-faint sm:gap-x-0" data-testid="device-meta">
                  {overrides > 0 && <span className="whitespace-nowrap sm:not-first:before:mx-2 sm:not-first:before:content-['·']">{overrides} own setting{overrides === 1 ? "" : "s"}</span>}
                  <span className="whitespace-nowrap sm:not-first:before:mx-2 sm:not-first:before:content-['·']">{lastSeenText(d, now)}</span>
                  <span className="hidden sm:inline sm:before:mx-2 sm:before:content-['·']">{kinds.find((k) => k.id === d.kind)?.title ?? d.kind}</span>
                </span>
              </span>
              <Icon name="chevron" size={16} className="shrink-0 text-ink-faint" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * “the whole phrase”, wrapping at its spaces, with only its last word and the "+2" kept together (a phrase can be up
 * to six words / 60 characters).
 */
function PhraseAndCount({ phrase, more }: { readonly phrase: string; readonly more: number }) {
  const words = phrase.split(" ")
  const last = words.pop() ?? ""
  return (
    <span data-testid="device-phrase">
      “{words.length > 0 ? `${words.join(" ")} ` : ""}
      <span className="whitespace-nowrap">{last}”{more > 0 ? ` +${more}` : ""}</span>
    </span>
  )
}

/** Devices › device: rename, forget, and the profile form with "Default (…)" or an override with Reset per field. */
export function DevicePage() {
  const client = useClient()
  /** A typed, unsent new name counts as an unsaved edit of this page (leave check, "Unsaved" marker). */
  const [renaming, setRenaming] = useState(false)
  const id = useClientState((s) => s.ui.settingsPath[1])
  const device = useClientState((s) => s.devices.find((d) => d.id === id), shallowEqual)
  const kind = useClientState((s) => s.frontends.find((k) => k.id === device?.kind), shallowEqual)
  const now = useNow()
  // Without a profile form (unknown kind) the rename registers the unsaved edit itself.
  const noForm = device !== undefined && kind === undefined
  useEffect(() => {
    if (!noForm) return
    if (client.store.get().ui.settingsDirty !== renaming) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: renaming } })
    return () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } })
  }, [client, noForm, renaming])
  if (device === undefined) {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="unknown-device">
        <p className="text-[14px] text-ink-muted">This device is not known (any more).</p>
        <Button onClick={() => client.settings(["devices"])}>All devices</Button>
      </div>
    )
  }
  return (
    <div className="flex flex-1 flex-col gap-8">
      <section className="flex flex-col gap-4" aria-label="Device">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
          <dt className="text-ink-muted">Kind</dt>
          <dd className="text-ink">{kind?.title ?? device.kind}</dd>
          <dt className="text-ink-muted">Status</dt>
          <dd className="text-ink" data-testid="device-status">
            {lastSeenText(device, now)}
            {device.connections > 1 ? ` · ${device.connections} tabs` : ""}
            {device.audioOwner ? " · has the audio now" : ""}
          </dd>
          <dt className="text-ink-muted">First seen</dt>
          <dd className="text-ink">{new Date(device.firstSeen).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</dd>
        </dl>
        <RenameForm device={device} onDirty={setRenaming} />
      </section>
      {kind === undefined ? (
        <p className="text-[14px] text-ink-muted">This kind of front end is not known to the assistant, so its settings cannot be shown.</p>
      ) : (
        <ProfileForm
          key={device.id}
          id={`device-${device.id}`}
          fields={kind.fields}
          base={kind.profile}
          saved={device.overrides}
          showInherited
          extraDirty={renaming}
          onSave={(patch) => client.updateDeviceAdmin(device.id, { patch })}
        />
      )}
      <Forget device={device} />
    </div>
  )
}

function RenameForm({ device, onDirty }: { readonly device: DeviceInfo; readonly onDirty: (dirty: boolean) => void }) {
  const client = useClient()
  const [name, setName] = useState(device.name)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string } | undefined>()
  useEffect(() => setName(device.name), [device.name])
  const trimmed = name.trim()
  const dirty = name !== device.name
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (trimmed === "") return setMessage({ ok: false, text: "A name is needed." })
    setBusy(true)
    setMessage(undefined)
    const result = await client.updateDeviceAdmin(device.id, { name: trimmed }) // continuation(none): only this form's state
    setBusy(false)
    setMessage(result.ok ? { ok: true, text: "Renamed" } : { ok: false, text: result.error?.message ?? "Not renamed." })
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1.5" data-testid="rename">
      <div className="flex items-center gap-2">
        <label htmlFor="device-name" className="text-[14px] font-medium text-ink">Name</label>
        {dirty && <span className="label text-[11px] text-voice" title="Changed here, not saved yet" data-testid="unsaved-marker">Unsaved</span>}
      </div>
      <div className="flex gap-2">
        <input
          id="device-name"
          value={name}
          maxLength={MAX_DEVICE_NAME_CHARS}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value)
            setMessage(undefined)
          }}
          aria-invalid={message?.ok === false}
          aria-describedby="device-name-note"
          className={cx(inputClass, "min-w-0 flex-1 max-sm:h-11")}
        />
        <Button type="submit" size="md" disabled={busy || trimmed === device.name || trimmed === ""} className="max-sm:h-11">
          {busy && <Spinner size={12} />}
          Rename
        </Button>
      </div>
      <p id="device-name-note" className={cx("text-[12px]", message === undefined ? "text-ink-faint" : message.ok ? "text-ok" : "text-danger")} aria-live="polite">
        {message?.text ?? "Shown here and in the header while this device has the audio."}
      </p>
    </form>
  )
}

function Forget({ device }: { readonly device: DeviceInfo }) {
  const client = useClient()
  const [asking, setAsking] = useState(false)
  return (
    <section className="flex flex-col items-start gap-2 border-t border-line/60 pt-6" aria-labelledby="forget-title">
      <h4 id="forget-title" className="label text-ink-faint">Forget</h4>
      <p className="text-[13px] text-ink-muted">
        Removes this device and its own settings.{device.connections > 0 ? " It is connected now, so it comes back at once as a new device with the defaults." : " If it connects again, it comes back with the defaults."}
      </p>
      <Button variant="danger" className="max-sm:h-11" onClick={() => setAsking(true)} data-testid="forget">Forget this device</Button>
      {asking && (
        <ConfirmForget
          name={device.name}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            const result = await client.forgetDevice(device.id) // continuation(none): navigates away or shows the error
            if (result.ok) {
              client.store.dispatch({ type: "local/toast", message: `Forgot ${device.name}.`, tone: "info" })
              client.settings(["devices"], { discard: true })
            }
            return result.ok ? undefined : result.error?.message ?? "Not forgotten."
          }}
        />
      )}
    </section>
  )
}

function ConfirmForget({ name, onCancel, onConfirm }: { readonly name: string; readonly onCancel: () => void; readonly onConfirm: () => Promise<string | undefined> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  useDialog(ref, true, onCancel, "[data-cancel]", { inertBackground: true })
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-bg/70 p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center" data-testid="forget-dialog">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="forget-dialog-title" aria-describedby="forget-dialog-text" className="w-full max-w-[400px] rounded-lg border border-line bg-surface p-5 shadow-panel">
        <h2 id="forget-dialog-title" className="text-[16px] font-medium text-ink">Forget {name}?</h2>
        <p id="forget-dialog-text" className="mt-1 text-[14px] text-ink-muted">Its name and own settings are removed. This cannot be undone.</p>
        {error !== undefined && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="md" variant="quiet" className="max-sm:h-11" onClick={onCancel} data-cancel="" disabled={busy}>Keep it</Button>
          <Button
            size="md"
            variant="danger"
            className="max-sm:h-11"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              // continuation(none): only this dialog's own state; it may already be gone after a navigation
              void onConfirm().then((e) => {
                setBusy(false)
                setError(e)
              })
            }}
          >
            {busy && <Spinner size={12} />}
            Forget
          </Button>
        </div>
      </div>
    </div>
  )
}
