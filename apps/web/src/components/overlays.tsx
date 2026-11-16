"use client"
import { useEffect, useState, useSyncExternalStore } from "react"
import { displayPhrase } from "@/lib/state.ts"
import { phrased } from "@/lib/voiceSetup.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState, usePrefs } from "./context.tsx"
import { Button } from "./ui/controls.tsx"
import { Icon, Spinner } from "./ui/Icon.tsx"

const noop = () => () => undefined
/** `window.isSecureContext`, true during prerender (the page is then re-checked on the client). */
const useSecureContext = () => useSyncExternalStore(noop, () => window.isSecureContext, () => true)

function StartButton({ children }: { readonly children: string }) {
  const client = useClient()
  const starting = useClientState((s) => s.audio.phase === "starting")
  // Engines that failed to start: there is nothing to talk to, so the invitation is muted and says why.
  const failed = useClientState((s) => s.connection.status === "open" && !s.summary.ready && s.summary.state === "failed")
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        data-testid="start"
        onClick={client.startAudio}
        disabled={starting || failed}
        aria-describedby={failed ? "start-unavailable" : undefined}
        className="group inline-flex h-12 items-center gap-3 rounded-full border border-voice/70 px-7 text-voice transition-[background-color,border-color] duration-[120ms] ease-out hover:border-voice hover:bg-voice-soft disabled:cursor-wait disabled:border-line disabled:bg-transparent disabled:text-ink-faint disabled:hover:border-line disabled:hover:bg-transparent disabled:data-[unavailable]:cursor-not-allowed"
        data-unavailable={failed || undefined}
      >
        {starting ? <Spinner size={16} /> : <Icon name="mic" size={18} />}
        <span className="label text-[12px]">{starting ? "Allow the microphone…" : children}</span>
      </button>
      {failed && <p id="start-unavailable" data-testid="start-unavailable" className="text-center text-[13px] text-ink-muted">Not available until the assistant can start.</p>}
    </div>
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
    <div className="flex flex-col items-center gap-4 animate-[pva-fade-in_320ms_var(--ease-out)] short:gap-3">
      {secure ? <StartButton>Start talking</StartButton> : <InsecureNotice />}
      {/* One line; the rest on demand, so the start screen fits a small phone above the dock. */}
      <details className="group max-w-[420px] text-center text-[13px] leading-relaxed text-ink-faint" data-testid="privacy">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 marker:hidden hover:text-ink-muted short:min-h-8">
          Only text goes to the language model
          <Icon name="chevron" size={12} className="shrink-0 transition-transform duration-[120ms] group-open:rotate-90" />
        </summary>
        <p className="mt-1">
          Uses your microphone. The assistant turns your speech into text, on its own machine or with a speech service chosen in admin.
        </p>
      </details>
      <button
        type="button"
        data-testid="type-instead"
        onClick={() => {
          client.store.dispatch({ type: "local/ui", patch: { chatOpen: true } })
          requestAnimationFrame(() => document.getElementById("chat-input")?.focus())
        }}
        // On a short screen the chat button in the dock is right below: this one goes.
        className="inline-flex items-center text-[13px] text-ink-muted underline decoration-line underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-muted max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center short:hidden"
      >
        or type instead
      </button>
    </div>
  )
}

export function ObserverBanner() {
  const secure = useSecureContext()
  return (
    <div data-testid="observer-banner" className="flex flex-col items-center gap-3 animate-[pva-fade-in_320ms_var(--ease-out)] short:gap-2">
      <p className="text-[14px] text-ink-muted short:text-[13px]">Audio is on another tab</p>
      {secure ? <StartButton>Use this tab</StartButton> : <InsecureNotice />}
    </div>
  )
}

export function AudioErrorCard() {
  const client = useClient()
  const error = useClientState((s) => s.audio.error ?? "Audio failed.")
  return (
    <div role="alert" data-testid="audio-error" className="flex w-full max-w-[460px] flex-col items-center gap-3 rounded-lg border border-danger/40 bg-surface px-5 py-4 text-center short:gap-2 short:py-3">
      <p className="text-[14px] text-ink">{error}</p>
      <Button onClick={client.startAudio} className="max-sm:h-11">Try again</Button>
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
    <p className="stage-legible max-w-[420px] text-center text-[14px] text-ink-muted animate-[pva-fade-in_320ms_var(--ease-out)]">
      Is the assistant running? Start it with <code className="font-mono text-[13px] text-ink">pnpm start serve</code>.
    </p>
  )
}

/** True on a touch-first device (no fine pointer): hints then say what to tap rather than which key to press. */
const coarse = (onChange: () => void) => {
  const mq = window.matchMedia?.("(pointer: coarse)")
  mq?.addEventListener("change", onChange)
  return () => mq?.removeEventListener("change", onChange)
}
export const useTouch = () => useSyncExternalStore(coarse, () => window.matchMedia?.("(pointer: coarse)").matches ?? false, () => false)

/**
 * A one-time hint after the first successful start, for 7 s. Showing it is remembered at once (so it never comes
 * back), but the timer belongs to this showing and is not restarted by that. While the microphone is off it says how
 * to unmute instead. In wake mode the label already says "Say “Hey Jeff”", so the hint goes on from there.
 */
export function StartHint() {
  const client = useClient()
  const touch = useTouch()
  const keys = usePrefs((p) => p.shortcuts)
  const v = useClientState(
    (s) => ({
      muted: !s.audio.micLive,
      asleep: s.setup !== undefined && s.setup.withoutPhrase.mode === "nobody" && s.session.serverState === "asleep" && s.woke === undefined && phrased(s.setup).length > 0
    }),
    shallowEqual
  )
  // Read once: the pref is written below, and that must not hide this showing early or cancel its timer.
  const [visible, setVisible] = useState(() => !client.prefs.get().startHintShown)
  useEffect(() => {
    if (!visible) return
    client.setPrefs({ startHintShown: true })
    const t = setTimeout(() => setVisible(false), 7000)
    return () => clearTimeout(t)
    // Only when it first shows: `visible` turning false ends it.
  }, [client, visible])
  if (!visible) return null
  const kbd = (k: string) => <kbd className="font-mono text-ink-muted">{k}</kbd>
  if (v.muted) {
    return (
      <p data-testid="start-hint" className="stage-legible text-center text-[13px] text-ink-faint animate-[pva-fade-in_320ms_var(--ease-out)]">
        {touch || !keys ? "Tap the microphone to unmute." : <>Press {kbd("M")} or the microphone to unmute.</>}
      </p>
    )
  }
  return (
    <p data-testid="start-hint" className="stage-legible text-center text-[13px] text-ink-faint animate-[pva-fade-in_320ms_var(--ease-out)]">
      {v.asleep ? "…then ask." : "Speak any time."}{" "}
      {touch ? (
        "Tap the microphone to mute, the square to stop a reply."
      ) : !keys ? (
        <>{kbd("Esc")} stops a reply.</>
      ) : (
        <>
          {kbd("M")} mutes, {kbd("Esc")} stops a reply.
        </>
      )}
    </p>
  )
}

/**
 * Asleep with more phrases than the label can name ("Say a wake phrase"): the phrases here, or where to find them
 * (docs/mockups/assistants/voice.html).
 */
export function AsleepHint() {
  const text = useClientState((s) => {
    if (s.setup === undefined) return ""
    if (s.setup.canPick) return "Each assistant wakes on its own phrase: the menu at the top left lists them."
    const list = phrased(s.setup).map((a) => `“${displayPhrase(a.phrases[0]!)}”`)
    return `${list.slice(0, -1).join(", ")} or ${list.at(-1) ?? ""}, then ask.`
  })
  return <p data-testid="asleep-hint" className="text-center text-[13px] text-ink-faint">{text}</p>
}
