"use client"
import { useEffect, useState } from "react"
import type { InterruptMode, OutputPath } from "@pva/protocol"
import { describeRoute, formatDiagnostics } from "@/lib/audio/diagnostics.ts"
import { VoiceAudio } from "@/lib/audio/VoiceAudio.ts"
import { MAX_PREBUFFER_MS } from "@/lib/prefs.ts"
import { useClient, useClientState, useDiagnostics, usePrefs } from "../../context.tsx"
import { inputClass } from "../../fields/types.ts"
import { Spinner } from "../../ui/Icon.tsx"
import { Button, Segmented, Switch } from "../../ui/controls.tsx"

const INTERRUPT: ReadonlyArray<{ readonly value: InterruptMode; readonly title: string; readonly label: string; readonly help: string }> = [
  { value: "instant", title: "Headphones", label: "Headphones: instant", help: "Any speech interrupts the reply at once. Use with headphones, or if the echo test passes." },
  { value: "confirm", title: "Speakers", label: "Speakers: say a few words", help: "Speech interrupts once two words are heard that are not the assistant's own voice." },
  { value: "manual", title: "Tap Stop", label: "Tap Stop to interrupt", help: "The microphone is held back while the assistant speaks; only Stop interrupts." }
]

const PROCESSING = [
  {
    key: "echoCancellation",
    label: "Echo cancellation",
    help:
      "Removes the assistant's own voice from the microphone. On iPhone it switches on Apple's voice processing, which also changes " +
      "the level and sound of your voice and can make playback crackle (WebKit bug 326286); try it off with headphones, or with " +
      "Interrupting set to Tap Stop, if the assistant mishears you or playback pops."
  },
  {
    key: "noiseSuppression",
    label: "Noise suppression",
    help: "Filters steady background noise. It can also blur quiet words; the speech recogniser copes with moderate noise on its own."
  },
  {
    key: "autoGainControl",
    label: "Automatic gain",
    help: "Lets the browser adjust your microphone level. The server also boosts quiet speech, so off is safe when the level meter moves well."
  }
] as const

const useDevices = (kind: MediaDeviceKind, refreshKey: unknown) => {
  const [devices, setDevices] = useState<ReadonlyArray<MediaDeviceInfo>>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (md === undefined) return
    // Overlapping enumerations (a device change during the first one) can settle out of order: only the
    // latest of this effect, while it is mounted, sets the list.
    let latest = 0
    let disposed = false
    const load = () => {
      const mine = ++latest
      // continuation(identity): only the latest enumeration of this effect, while it is mounted.
      void md.enumerateDevices().then((all) => {
        if (!disposed && mine === latest) setDevices(all.filter((d) => d.kind === kind && d.deviceId !== "" && d.deviceId !== "default"))
      }, () => undefined)
    }
    load()
    md.addEventListener("devicechange", load) // continuation(identity): see `load`; removed on cleanup
    return () => {
      disposed = true
      md.removeEventListener("devicechange", load)
    }
  }, [kind, refreshKey])
  return devices
}

function Row({ label, htmlFor, children, help }: { readonly label: string; readonly htmlFor?: string; readonly children: React.ReactNode; readonly help?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[14px] font-medium text-ink">{label}</label>
      {children}
      {help !== undefined && <div className="text-[13px] text-ink-muted">{help}</div>}
    </div>
  )
}

/** This device › Microphone & speaker: device choice, Interrupting and the echo test. */
export function MicrophonePage() {
  const client = useClient()
  const prefs = usePrefs((p) => p)
  const running = useClientState((s) => s.audio.phase === "running" || s.audio.phase === "suspended")
  const mics = useDevices("audioinput", running)
  const speakers = useDevices("audiooutput", running)
  const canChooseSpeaker = typeof window !== "undefined" && VoiceAudio.canChooseSpeaker()
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | undefined>()
  const mode = INTERRUPT.find((m) => m.value === prefs.interruptMode) ?? INTERRUPT[1]!

  // The test, its cancellation and saving the result are the client's (`client.echoTest`); this only shows progress.
  const runTest = async () => {
    setTesting(true)
    setTestError(undefined)
    try {
      await client.echoTest() // continuation(none): afterwards only this component's own display state changes
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "The test failed.")
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <Row label="Microphone" htmlFor="pref-mic" help={!running && mics.every((d) => d.label === "") ? "Names appear after you allow the microphone." : undefined}>
        <select id="pref-mic" value={prefs.micDeviceId} onChange={(e) => client.setPrefs({ micDeviceId: e.target.value })} className={inputClass}>
          <option value="">Default</option>
          {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
        </select>
      </Row>

      {canChooseSpeaker && (
        <Row label="Speaker" htmlFor="pref-speaker">
          <select id="pref-speaker" value={prefs.sinkId} onChange={(e) => client.setPrefs({ sinkId: e.target.value })} className={inputClass}>
            <option value="">Default</option>
            {speakers.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
          </select>
        </Row>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-[14px] font-medium text-ink" id="interrupt-label">Interrupting</span>
        <Segmented
          name="interrupt"
          label="Interrupting"
          value={prefs.interruptMode}
          options={INTERRUPT.map((m) => ({ value: m.value, label: <><span className="hidden sm:inline">{m.label}</span><span className="sm:hidden">{m.title}</span></> }))}
          onChange={(v) => client.setPrefs({ interruptMode: v })}
        />
        <p className="text-[13px] text-ink-muted">{mode.help}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void runTest()} disabled={!running || testing}>
            {testing && <Spinner size={12} />}
            {testing ? "Listening for echo…" : "Test echo"}
          </Button>
          {!running && <span className="text-[12px] text-ink-faint">Start audio first.</span>}
          {testError !== undefined && <span className="text-[13px] text-danger">{testError}</span>}
        </div>
        {prefs.echoTest !== undefined && (
          <p className="text-[13px] text-ink" data-testid="echo-result">
            {prefs.echoTest.cancelled
              ? <>Echo is cancelled ({prefs.echoTest.residualDb} dB): you can use <em>Headphones: instant</em> even on speakers.</>
              : <>Echo is not cancelled ({prefs.echoTest.residualDb > 0 ? "+" : ""}{prefs.echoTest.residualDb} dB): keep <em>Speakers</em>, or try <em>Through a media element</em> (Display › Advanced) and test again.</>}
            <span className="text-ink-faint"> · tested with {prefs.echoTest.outputPath === "direct" ? "direct output" : "a media element"}</span>
          </p>
        )}
      </div>
    </div>
  )
}

/** This device › Audio processing: the browser's voice processing, and the audio diagnostics. */
export function AudioProcessingPage() {
  const client = useClient()
  const prefs = usePrefs((p) => p)
  const running = useClientState((s) => s.audio.phase === "running" || s.audio.phase === "suspended")
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-4" data-testid="mic-processing">
        <p className="text-[13px] text-ink-muted">
          The browser's voice processing. Changing a switch re-opens the microphone{running ? "" : " (when audio is on)"}.
        </p>
        {PROCESSING.map((p) => (
          <ToggleRow key={p.key} label={p.label} help={p.help} checked={prefs[p.key]} onChange={(v) => client.setPrefs({ [p.key]: v })} />
        ))}
      </div>
      <AudioDiagnostics />
    </div>
  )
}

/** This device › Display: captions and the latency readout; Advanced: output path and prebuffer. */
export function DisplayPage() {
  const client = useClient()
  const prefs = usePrefs((p) => p)
  return (
    <div className="flex flex-col gap-7">
      <ToggleRow label="Captions" help="Show what you say and what the assistant is saying under the line." checked={prefs.captions} onChange={(v) => client.setPrefs({ captions: v })} />
      <ToggleRow label="Latency readout" help="The ↯ number in the top bar." checked={prefs.latencyReadout} onChange={(v) => client.setPrefs({ latencyReadout: v })} />
      <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-4">
        <summary className="label flex min-h-8 cursor-pointer list-none items-center text-ink-muted marker:hidden hover:text-ink">Advanced</summary>
        <div className="mt-4 flex flex-col gap-6">
          <Row label="Output path" help="A media element is an older workaround that can make some browsers cancel the assistant's echo.">
            <Segmented<OutputPath>
              name="output-path"
              label="Output path"
              value={prefs.outputPath}
              options={[{ value: "direct", label: "Direct" }, { value: "element", label: "Through a media element" }]}
              onChange={(v) => client.setPrefs({ outputPath: v })}
            />
          </Row>
          <Row
            label={`Prebuffer · ${prefs.prebufferMs} ms`}
            htmlFor="pref-prebuffer"
            help="Audio buffered before a reply starts. Lower is faster; raise it (200–300 ms on a phone over Wi-Fi) if replies stutter, pop or the underrun count (Audio processing) grows."
          >
            <input
              id="pref-prebuffer"
              type="range"
              min={20}
              max={MAX_PREBUFFER_MS}
              step={10}
              value={prefs.prebufferMs}
              onChange={(e) => client.setPrefs({ prebufferMs: Number(e.target.value) })}
              className="w-full accent-[var(--color-you)]"
            />
          </Row>
        </div>
      </details>
    </div>
  )
}

function ToggleRow({ label, help, checked, onChange }: { readonly label: string; readonly help: string; readonly checked: boolean; readonly onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{label}</div>
        <div className="text-[13px] text-ink-muted">{help}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

const flag = (v: boolean | undefined) => (v === undefined ? "not reported" : v ? "on" : "off")

/** What the microphone really is, and how playback went: numbers the owner can report. */
function AudioDiagnostics() {
  const client = useClient()
  const diagnostics = useDiagnostics((d) => d)
  const outputPath = usePrefs((p) => p.outputPath)
  const prebufferMs = usePrefs((p) => p.prebufferMs)
  const [copied, setCopied] = useState(false)
  const mic = diagnostics.mic
  const p = diagnostics.playback
  const copy = () => {
    const text = formatDiagnostics(diagnostics, { userAgent: navigator.userAgent, outputPath, prebufferMs })
    // continuation(none): only this component's own "Copied" label changes.
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000) // continuation(none): only the label
    }, () => window.prompt("Copy this report", text))
  }
  const cell = "py-0.5 pr-3 text-ink-muted"
  return (
    <div className="flex flex-col gap-3" data-testid="audio-diagnostics">
      <div className="text-[14px] font-medium text-ink">Audio diagnostics</div>
      <table className="text-[13px] tabular-nums">
        <tbody>
          <tr><td className={cell}>Microphone</td><td className="text-ink">{mic === undefined ? "not open" : mic.label || "(no name)"}</td></tr>
          {mic !== undefined && (
            <>
              <tr><td className={cell}>Sample rate</td><td className="text-ink" data-testid="mic-rate">{mic.sampleRate ?? "not reported"}{mic.sampleRate !== undefined ? " Hz" : ""} (audio context {mic.contextSampleRate} Hz)</td></tr>
              <tr><td className={cell}>Echo cancellation</td><td className="text-ink">{flag(mic.echoCancellation)} (asked {mic.requested.echoCancellation ? "on" : "off"})</td></tr>
              <tr><td className={cell}>Noise suppression</td><td className="text-ink">{flag(mic.noiseSuppression)} (asked {mic.requested.noiseSuppression ? "on" : "off"})</td></tr>
              <tr><td className={cell}>Automatic gain</td><td className="text-ink">{flag(mic.autoGainControl)} (asked {mic.requested.autoGainControl ? "on" : "off"})</td></tr>
            </>
          )}
          <tr><td className={cell}>Playback count</td><td className="text-ink" data-testid="playback-route">{describeRoute(diagnostics.route)}</td></tr>
          <tr><td className={cell}>Replies played</td><td className="text-ink" data-testid="playback-replies">{p.replies}</td></tr>
          <tr><td className={cell}>Underruns</td><td className="text-ink" data-testid="playback-underruns">{p.underruns} in {p.repliesWithUnderruns} replies, {p.gapMs} ms of gaps</td></tr>
          <tr><td className={cell}>Clicks smoothed</td><td className="text-ink">{p.clicks}</td></tr>
          <tr><td className={cell}>Lowest buffer</td><td className="text-ink">{p.minQueueMs === undefined ? "-" : `${p.minQueueMs} ms`}</td></tr>
          {p.last !== undefined && <tr><td className={cell}>Last reply</td><td className="text-ink">{p.last.srcRate} Hz → {p.last.ctxRate} Hz, {p.last.underruns} underruns</td></tr>}
        </tbody>
      </table>
      <p className="text-[13px] text-ink-muted">
        An underrun is a moment the reply ran out of audio (it arrived late); each one is a short gap, smoothed so it does not click.
        Underruns: raise the prebuffer. Popping with no underruns: try echo cancellation off, or the media element output path.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button size="sm" onClick={copy}>{copied ? "Copied" : "Copy report"}</Button>
        <Button size="sm" onClick={() => client.diagnostics.dispatch({ type: "reset" })}>Reset counters</Button>
      </div>
    </div>
  )
}
