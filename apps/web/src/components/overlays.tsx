"use client"
import { useEffect, useState, useSyncExternalStore } from "react"
import { useClient, useClientState, usePrefs } from "./context.tsx"
import { Button } from "./ui/controls.tsx"
import { Icon, Spinner } from "./ui/Icon.tsx"

const noop = () => () => undefined
/** `window.isSecureContext`, true during prerender (the page is then re-checked on the client). */
const useSecureContext = () => useSyncExternalStore(noop, () => window.isSecureContext, () => true)

function StartButton({ children }: { readonly children: string }) {
  const client = useClient()
  const starting = useClientState((s) => s.audio.phase === "starting")
  return (
    <button
      type="button"
      data-testid="start"
      onClick={client.startAudio}
      disabled={starting}
      className="group inline-flex h-12 items-center gap-3 rounded-full border border-voice/70 px-7 text-voice transition-[background-color,border-color] duration-[120ms] ease-out hover:border-voice hover:bg-voice-soft disabled:cursor-wait"
    >
      {starting ? <Spinner size={16} /> : <Icon name="mic" size={18} />}
      <span className="label text-[12px]">{starting ? "Allow the microphone…" : children}</span>
    </button>
  )
}

function InsecureNotice() {
  return (
    <p className="max-w-[440px] rounded-md border border-line bg-surface px-4 py-3 text-center text-[14px] text-ink-muted">
      The microphone needs HTTPS or localhost. Open this page through an SSH tunnel (<code className="font-mono text-[13px] text-ink">ssh -L 8787:localhost:8787 …</code>) or an HTTPS address.
    </p>
  )
}

export function StartPrompt() {
  const client = useClient()
  const secure = useSecureContext()
  return (
    <div className="flex flex-col items-center gap-4 animate-[pva-fade-in_320ms_var(--ease-out)]">
      {secure ? <StartButton>Start talking</StartButton> : <InsecureNotice />}
      <p className="max-w-[420px] text-center text-[13px] leading-relaxed text-ink-faint">
        Uses your microphone. Speech is recognised on the assistant's machine; only text goes to the language model.
      </p>
      <button
        type="button"
        onClick={() => {
          client.store.dispatch({ type: "local/ui", patch: { chatOpen: true } })
          requestAnimationFrame(() => document.getElementById("chat-input")?.focus())
        }}
        className="text-[13px] text-ink-muted underline decoration-line underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-muted"
      >
        or type instead
      </button>
    </div>
  )
}

export function ObserverBanner() {
  const secure = useSecureContext()
  return (
    <div data-testid="observer-banner" className="flex flex-col items-center gap-3 animate-[pva-fade-in_320ms_var(--ease-out)]">
      <p className="text-[14px] text-ink-muted">Audio is on another tab or device</p>
      {secure ? <StartButton>Use this tab</StartButton> : <InsecureNotice />}
    </div>
  )
}

export function AudioErrorCard() {
  const client = useClient()
  const error = useClientState((s) => s.audio.error ?? "Audio failed.")
  return (
    <div role="alert" data-testid="audio-error" className="flex w-full max-w-[460px] flex-col items-center gap-3 rounded-lg border border-danger/40 bg-surface px-5 py-4 text-center">
      <p className="text-[14px] text-ink">{error}</p>
      <Button onClick={client.startAudio} size="sm">Try again</Button>
    </div>
  )
}

export function ResumeAudio() {
  const client = useClient()
  return (
    <Button variant="primary" onClick={client.resumeAudio} data-testid="resume-audio">
      <Icon name="speaker" size={18} /> Tap to resume audio
    </Button>
  )
}

export function OutdatedNotice() {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 text-center">
      <p className="text-[20px] text-ink">This page is older than the assistant.</p>
      <Button variant="primary" onClick={() => location.reload()}>
        <Icon name="reload" size={18} /> Reload
      </Button>
    </div>
  )
}

export function ConnectingHint() {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 3000)
    return () => clearTimeout(t)
  }, [])
  if (!late) return null
  return (
    <p className="max-w-[420px] text-center text-[14px] text-ink-muted animate-[pva-fade-in_320ms_var(--ease-out)]">
      Is the assistant running? Start it with <code className="font-mono text-[13px] text-ink">pnpm start serve</code>.
    </p>
  )
}

/** A one-time hint after the first successful start. */
export function StartHint() {
  const client = useClient()
  const shown = usePrefs((p) => p.startHintShown)
  const [visible, setVisible] = useState(!shown)
  useEffect(() => {
    if (shown) return
    client.setPrefs({ startHintShown: true })
    const t = setTimeout(() => setVisible(false), 7000)
    return () => clearTimeout(t)
  }, [client, shown])
  if (!visible) return null
  return (
    <p className="text-center text-[13px] text-ink-faint animate-[pva-fade-in_320ms_var(--ease-out)]">
      Speak any time. <kbd className="font-mono text-ink-muted">M</kbd> mutes, <kbd className="font-mono text-ink-muted">Esc</kbd> stops a reply.
    </p>
  )
}
