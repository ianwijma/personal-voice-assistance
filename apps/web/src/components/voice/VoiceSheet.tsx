"use client"
import { type ReactNode, useRef, useState } from "react"
import { VoiceAudio } from "@/lib/audio/VoiceAudio.ts"
import { displayPhrase, visualState } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { defaultAssistantId, reachText } from "@/lib/voiceSetup.ts"
import { NotificationCards } from "../NotificationCards.tsx"
import { useClient, useClientState, usePrefs } from "../context.tsx"
import { inputClass } from "../fields/types.ts"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { PanelHeader, useDialog } from "../ui/Panel.tsx"
import { Button, cx } from "../ui/controls.tsx"
import { useHref } from "../useHref.ts"
import { useMediaDevices } from "./useMediaDevices.ts"

const touchInput = `${inputClass} max-sm:h-11`

/**
 * The voice front end's settings (docs/ASSISTANTS.md §7.2): Assistant (who answers without a phrase, as a choice
 * where the device lets people pick, else the list), Microphone, Speaker, one "More" group (the echo test, which only
 * this device can run, and a way into Help), and a link to admin. The pick belongs to the device on the server
 * (`device.pick`); microphone and speaker stay in this browser. The voice is the assistant's, chosen in admin: a device
 * has none of its own, and phrases and follow-up are admin's too.
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
        <NotificationCards inPanel />
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

interface Choice {
  readonly value: string
  readonly title: string
  readonly detail?: string
  readonly reach: string
}

/** Who answers without a phrase: a choice where the device lets people pick, else the plain list (docs/mockups/assistants/voice.html). */
function AssistantGroup({ admin }: { readonly admin: string }) {
  const client = useClient()
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)
  const v = useClientState(
    (s) => {
      const started = visualState(s) !== "not-started"
      return {
        canPick: s.setup?.canPick === true,
        canAuto: s.setup?.canAuto === true,
        several: (s.setup?.assistants.length ?? 0) > 1,
        mode: s.setup?.withoutPhrase.mode,
        assistant: defaultAssistantId(s.setup),
        list: JSON.stringify(
          (s.setup?.assistants ?? []).map((a): Choice => ({ value: a.id, title: a.name, detail: a.purpose, reach: reachText(s, a.id, started, displayPhrase) }))
        )
      }
    },
    shallowEqual
  )
  const list = JSON.parse(v.list) as ReadonlyArray<Choice>
  const pick = async (value: string) => {
    setSaved(false)
    // continuation(none): only this group's own note or error.
    const result = await client.pickAssistant(value)
    if (result.ok) {
      setError(undefined)
      setSaved(true)
    } else setError(result.error?.message ?? "the assistant refused it.")
  }
  if (!v.canPick) {
    return (
      <>
        <div className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="assistant-list">
          {list.map((a) => <ChoiceText key={a.value} choice={a} />)}
        </div>
        <p className="text-[12px] text-ink-faint">
          {v.several ? "Who answers, phrases and follow-up are" : "Phrases and follow-up are"} changed in <a href={admin} className="text-voice underline-offset-4 hover:underline">admin</a>.
        </p>
      </>
    )
  }
  const rows: ReadonlyArray<Choice & { readonly checked: boolean }> = [
    ...list.map((a) => ({ ...a, checked: v.mode === "assistant" && v.assistant === a.value })),
    ...(v.canAuto ? [{ value: "typesafe", title: "Whichever fits", reach: "Each thing you say goes to the assistant it suits.", checked: v.mode === "typesafe" }] : []),
    { value: "", title: "Nobody", reach: "Sleeps until it hears a phrase", checked: v.mode === "nobody" }
  ]
  return (
    <>
      <div role="radiogroup" aria-labelledby="sheet-assistant" data-testid="assistant-choices" className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
        {rows.map((r) => {
          const id = `sheet-assistant-${r.value === "" ? "none" : r.value}`
          return (
            <label
              key={r.value}
              htmlFor={id}
              className={cx("flex min-h-12 cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors duration-[120ms] hover:bg-surface-2/60", r.checked && "bg-surface-2/60")}
            >
              <input
                type="radio"
                id={id}
                name="sheet-assistant"
                value={r.value}
                checked={r.checked}
                data-testid={`sheet-assistant-${r.value === "" ? "none" : r.value}`}
                onChange={() => void pick(r.value)}
                className="mt-1 size-[18px] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-ink-faint bg-surface transition-[border-color,border-width] duration-[120ms] checked:border-[5px] checked:border-you"
              />
              <ChoiceText choice={r} bare />
            </label>
          )
        })}
      </div>
      <p className={saved ? "flex items-center gap-1.5 text-[12px] text-ok" : "sr-only"} aria-live="polite" data-testid="assistant-saved">
        {saved && <Icon name="check" size={14} />}
        {saved ? "Used from the next thing you say." : ""}
      </p>
      {error !== undefined && <FieldError id="sheet-assistant-error" message={error} onDismiss={() => setError(undefined)} />}
      <p className="text-[12px] text-ink-faint">This decides who answers without a phrase on this device, for everyone who uses it.</p>
      <p className="text-[12px] text-ink-faint">
        Phrases and follow-up are changed in <a href={admin} className="text-voice underline-offset-4 hover:underline">admin</a>.
      </p>
    </>
  )
}

function ChoiceText({ choice, bare = false }: { readonly choice: Choice; readonly bare?: boolean }) {
  const text = (
    <span className="min-w-0">
      <span className="block text-[14px] text-ink">{choice.title}</span>
      {choice.detail !== undefined && choice.detail !== "" && <span className="block text-[13px] text-ink-muted">{choice.detail}</span>}
      <span className="mt-0.5 block text-[12px] text-ink-faint">{choice.reach}</span>
    </span>
  )
  return bare ? text : <div className="px-3 py-2.5">{text}</div>
}

function SheetBody() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      hasDevice: s.setup?.deviceId !== undefined,
      running: s.audio.phase === "running" || s.audio.phase === "suspended"
    }),
    shallowEqual
  )
  const prefs = usePrefs((p) => p, shallowEqual)
  const mics = useMediaDevices("audioinput", v.running)
  const speakers = useMediaDevices("audiooutput", v.running)
  const canChooseSpeaker = typeof window !== "undefined" && VoiceAudio.canChooseSpeaker()
  const admin = useHref("/admin/")

  return (
    <div className="flex flex-col gap-6">
      {!v.hasDevice && (
        <p className="rounded-md border border-line bg-surface-2/40 px-3 py-2.5 text-[13px] text-ink-muted">
          This browser has no device id (storage is off), so it uses the default settings.
        </p>
      )}

      <Section title="Assistant" id="sheet-assistant">
        <AssistantGroup admin={admin} />
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
