"use client"
import { type ReactNode, useRef, useState } from "react"
import { type Activation, FOLLOW_UP_SECONDS_MAX, type ProfileField } from "@pva/protocol"
import { VoiceAudio } from "@/lib/audio/VoiceAudio.ts"
import { displayPhrase, profileOf } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState, usePrefs } from "../context.tsx"
import { inputClass } from "../fields/types.ts"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { PanelHeader, useDialog } from "../ui/Panel.tsx"
import { Button, cx, Segmented } from "../ui/controls.tsx"
import { useHref } from "../useHref.ts"
import { useMediaDevices } from "./useMediaDevices.ts"

/** Follow-up choices; a value set in admin that is not one of these is listed too. */
const FOLLOW_UP = [0, 5, 8, 15, 30, FOLLOW_UP_SECONDS_MAX]
const seconds = (n: number) => (n === 0 ? "Off: say the phrase every time" : `${n} seconds`)

const touchInput = `${inputClass} max-sm:h-11`

/**
 * The voice front end's settings (docs/FRONTENDS-AND-ACTIVATION.md §5): Activation, Microphone, Speaker, one "More"
 * group (the echo test, which only this device can run, and a way into Help), and a link to admin. Activation and
 * follow-up belong to the device profile on the server (`device.update`); microphone and speaker stay in this browser.
 * The voice is the assistant's, chosen in admin under Voices (docs/VOICE-PROVIDERS.md §1): a device has none of its own.
 * A bottom sheet on a phone, a side sheet from 640 px.
 */
export function VoiceSheet() {
  const client = useClient()
  const open = useClientState((s) => s.ui.sheetOpen)
  const ref = useRef<HTMLElement>(null)
  const close = () => client.store.dispatch({ type: "local/ui", patch: { sheetOpen: false } })
  useDialog(ref, open, close)
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-30 bg-bg/50" onClick={close} aria-hidden="true" />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        data-testid="voice-sheet"
        className={cx(
          "fixed z-40 flex flex-col overflow-hidden border-line bg-surface shadow-panel",
          "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-lg border-t animate-[pva-sheet-up_320ms_var(--ease-out)]",
          "sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-0 sm:max-h-none sm:w-[400px] sm:rounded-none sm:border-l sm:border-t-0 sm:animate-[pva-slide-in_320ms_var(--ease-out)]"
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <div className="pt-[env(safe-area-inset-top)] max-sm:pt-0">
          <PanelHeader title="Settings" titleId="sheet-title" onClose={close} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 scrollbar-quiet">
          <SheetBody />
        </div>
      </aside>
    </>
  )
}

function Section({ title, id, children }: { readonly title: string; readonly id: string; readonly children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-b border-line/60 pb-6 last:border-b-0">
      <h3 id={id} className="label text-ink-faint">{title}</h3>
      {children}
    </section>
  )
}

/** The sheet's own profile fields: a refused change is shown next to its control until fixed or dismissed. */
type SheetField = "activation" | "followUpSeconds"

function FieldError({ id, message, onDismiss }: { readonly id: string; readonly message: string; readonly onDismiss: () => void }) {
  return (
    <div id={id} role="alert" data-testid="sheet-error" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 py-1.5 pl-3 pr-1 text-[13px] text-danger">
      <span className="min-w-0 flex-1 py-1">Not changed: {message}</span>
      <button
        type="button"
        aria-label="Dismiss this message"
        onClick={onDismiss}
        className="-my-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:text-ink sm:size-8"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

function SheetBody() {
  const client = useClient()
  const [errors, setErrors] = useState<Partial<Record<SheetField, string>>>({})
  /** Sends one change; a refusal stays next to the control (the sheet covers the page's toasts). */
  const change = async (field: SheetField, patch: Parameters<typeof client.updateDevice>[0]) => {
    const result = await client.updateDevice(patch, { toast: false }) // continuation(none): only this sheet's own messages
    const refusal = result.error?.message ?? "the assistant refused it."
    setErrors(({ [field]: _old, ...rest }) => (result.ok ? rest : { ...rest, [field]: refusal }))
  }
  const dismiss = (field: SheetField) => setErrors(({ [field]: _old, ...rest }) => rest)
  const v = useClientState(
    (s) => {
      const profile = profileOf(s)
      return {
        activation: profile.activation,
        phrases: profile.wakePhrases,
        followUp: profile.followUpSeconds,
        editable: s.device?.editable ?? [],
        hasDevice: s.device?.deviceId !== undefined,
        running: s.audio.phase === "running" || s.audio.phase === "suspended"
      }
    },
    shallowEqual
  )
  const prefs = usePrefs((p) => p, shallowEqual)
  const mics = useMediaDevices("audioinput", v.running)
  const speakers = useMediaDevices("audiooutput", v.running)
  const canChooseSpeaker = typeof window !== "undefined" && VoiceAudio.canChooseSpeaker()
  const admin = useHref("/admin/")
  const can = (f: ProfileField) => v.editable.includes(f)
  const followUps = FOLLOW_UP.includes(v.followUp) ? FOLLOW_UP : [...FOLLOW_UP, v.followUp].sort((a, b) => a - b)

  return (
    <div className="flex flex-col gap-6">
      {!v.hasDevice && (
        <p className="rounded-md border border-line bg-surface-2/40 px-3 py-2.5 text-[13px] text-ink-muted">
          This browser has no device id (storage is off), so it uses the default settings.
        </p>
      )}

      <Section title="Activation" id="sheet-activation">
        <Segmented<Activation>
          name="activation"
          label="Activation"
          tall
          testId="activation"
          value={v.activation}
          disabled={!can("activation")}
          options={[{ value: "always", label: "Always listening" }, { value: "wake-phrase", label: "Wake phrase" }]}
          onChange={(activation) => void change("activation", { activation })}
        />
        {errors.activation !== undefined && <FieldError id="sheet-activation-error" message={errors.activation} onDismiss={() => dismiss("activation")} />}
        {v.activation === "always" ? (
          <p className="text-[13px] text-ink-muted">The assistant reacts to everything it hears.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2" data-testid="wake-phrases">
              <p className="text-[13px] text-ink-muted">It reacts after you say one of these:</p>
              <ul className="flex flex-wrap gap-1.5">
                {v.phrases.map((p) => (
                  <li key={p} className="rounded-full border border-line bg-surface-2/60 px-3 py-1 text-[13px] text-ink">{displayPhrase(p)}</li>
                ))}
              </ul>
              <p className="text-[12px] text-ink-faint">
                The phrases are changed in <a href={admin} className="text-voice underline-offset-4 hover:underline">admin</a>.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="sheet-follow-up" className="text-[14px] font-medium text-ink">Keep listening after a reply</label>
              <select
                id="sheet-follow-up"
                value={v.followUp}
                disabled={!can("followUpSeconds")}
                onChange={(e) => void change("followUpSeconds", { followUpSeconds: Number(e.target.value) })}
                className={touchInput}
                aria-describedby={errors.followUpSeconds !== undefined ? "sheet-follow-up-help sheet-follow-up-error" : "sheet-follow-up-help"}
              >
                {followUps.map((n) => <option key={n} value={n}>{seconds(n)}</option>)}
              </select>
              <p id="sheet-follow-up-help" className="text-[12px] text-ink-faint">Within this time you can answer without the phrase.</p>
              {errors.followUpSeconds !== undefined && <FieldError id="sheet-follow-up-error" message={errors.followUpSeconds} onDismiss={() => dismiss("followUpSeconds")} />}
            </div>
          </>
        )}
      </Section>

      <Section title="Microphone" id="sheet-mic">
        <select
          id="pref-mic"
          aria-labelledby="sheet-mic"
          value={prefs.micDeviceId}
          onChange={(e) => client.setPrefs({ micDeviceId: e.target.value })}
          className={touchInput}
        >
          <option value="">Default</option>
          {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
        </select>
        {!v.running && mics.every((d) => d.label === "") && <p className="text-[12px] text-ink-faint">Names appear after you allow the microphone.</p>}
      </Section>

      <Section title="Speaker" id="sheet-speaker">
        {canChooseSpeaker ? (
          <select
            id="pref-speaker"
            aria-labelledby="sheet-speaker"
            value={prefs.sinkId}
            onChange={(e) => client.setPrefs({ sinkId: e.target.value })}
            className={touchInput}
          >
            <option value="">Default</option>
            {speakers.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
          </select>
        ) : (
          <p className="text-[13px] text-ink-muted">This browser always plays through the system's speaker.</p>
        )}
      </Section>

      <details className="group rounded-md border border-line/70" data-testid="sheet-more">
        <summary className="label flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 text-ink-muted marker:hidden hover:text-ink">
          <Icon name="chevron" size={14} className="transition-transform duration-[120ms] group-open:rotate-90" />
          More
        </summary>
        <div className="flex flex-col gap-5 px-3 pb-4 pt-1">
          <EchoTest running={v.running} />
          <div className="flex flex-col gap-2">
            <p className="text-[14px] font-medium text-ink">Help</p>
            <p className="text-[13px] text-ink-muted">Keyboard shortcuts (and switching them off), and an audio report for when playback stutters.</p>
            <div>
              <Button
                size="md"
                className="max-sm:h-11"
                data-testid="open-help"
                onClick={() => client.store.dispatch({ type: "local/ui", patch: { sheetOpen: false, shortcutsOpen: true } })}
              >
                Keyboard and audio report
              </Button>
            </div>
          </div>
        </div>
      </details>

      <a
        href={admin}
        data-testid="admin-link"
        className="flex min-h-12 items-center gap-3 rounded-md border border-line px-4 py-3 text-[14px] text-ink transition-colors duration-[120ms] hover:bg-surface-2"
      >
        <Icon name="wrench" size={18} className="shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1">
          <span className="block">Admin</span>
          <span className="block text-[12px] text-ink-muted">Everything else: models, voices, phrases, devices. Needs the admin password.</span>
        </span>
        <Icon name="arrowRight" size={16} className="shrink-0 text-ink-faint" />
      </a>
    </div>
  )
}

/** The echo test: only this device can run it (it plays through this speaker and listens with this microphone). */
function EchoTest({ running }: { readonly running: boolean }) {
  const client = useClient()
  const result = usePrefs((p) => p.echoTest)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const run = async () => {
    setTesting(true)
    setError(undefined)
    try {
      await client.echoTest() // continuation(none): afterwards only this component's own display state changes
    } catch (e) {
      setError(e instanceof Error ? e.message : "The test failed.")
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="echo-test">
      <p className="text-[14px] font-medium text-ink">Echo test</p>
      <p className="text-[13px] text-ink-muted">
        Plays a short sound and listens for it. If this device removes its own echo, it can be set (in admin, under Interrupting) to stop a reply as soon as you talk.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="md" className="max-sm:h-11" onClick={() => void run()} disabled={!running || testing}>
          {testing && <Spinner size={12} />}
          {testing ? "Listening for echo…" : "Test echo"}
        </Button>
        {!running && <span className="text-[12px] text-ink-faint">Start talking first.</span>}
      </div>
      {error !== undefined && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      {result !== undefined && (
        <p className="text-[13px] text-ink" data-testid="echo-result" aria-live="polite">
          {result.cancelled
            ? `Echo is removed (${result.residualDb} dB): this device can use instant interrupting, even on speakers.`
            : `Echo is not removed (${result.residualDb > 0 ? "+" : ""}${result.residualDb} dB): keep interrupting on "say a few words", or use headphones.`}
        </p>
      )}
    </div>
  )
}
