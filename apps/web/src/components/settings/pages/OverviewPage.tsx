"use client"
import { useEffect, useState } from "react"
import { agoText, stateWord, turnsText } from "@/lib/sessions.ts"
import { setupChecklist } from "@/lib/setupChecklist.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { Icon, Spinner } from "../../ui/Icon.tsx"
import { Button, cx } from "../../ui/controls.tsx"

const STAGE: Record<string, string> = { llm: "Language model", stt: "Speech recognition", tts: "Speech synthesis" }

export function Where({ location }: { readonly location: "local" | "hosted" }) {
  return <span className={cx("label shrink-0 text-[9px]", location === "local" ? "text-ink-faint" : "text-warn")}>{location}</span>
}

/** The assistant setting `MAX_VOICE_SESSIONS`, if a settings section carries it. */
const maxSessionsOf = (sections: ReadonlyArray<{ readonly form: { readonly values: Readonly<Record<string, unknown>> } }>): number | undefined => {
  for (const x of sections) {
    const v = x.form.values.MAX_VOICE_SESSIONS
    if (typeof v === "number") return v
  }
  return undefined
}

/**
 * The voice sessions (docs/VOICE-SESSIONS.md §5): one row per device with a conversation, most recently active first,
 * saying whether it is talking now, its state and how far its conversation went.
 */
function SessionsSection() {
  const client = useClient()
  const sessions = useClientState((s) => s.sessions)
  const max = useClientState((s) => maxSessionsOf(s.sections))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000) // continuation(none): only the clock
    return () => clearInterval(t)
  }, [])
  const talking = sessions.filter((x) => x.ownerPresent).length
  return (
    <section data-testid="sessions">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h4 className="label text-ink-faint">Voice sessions</h4>
        {sessions.length > 0 && (
          <span className="font-mono text-[12px] text-ink-faint" data-testid="sessions-count">
            {talking} talking{max !== undefined ? ` · ${sessions.length} of ${max}` : ""}
          </span>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
        {sessions.map((x) => (
          <li key={x.key} data-session={x.key} data-talking={x.ownerPresent ? "true" : "false"}>
            <button
              type="button"
              disabled={x.deviceId === undefined}
              onClick={() => x.deviceId !== undefined && client.settings(["devices", x.deviceId])}
              className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-[120ms] enabled:hover:bg-surface-2/60"
            >
              <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", x.ownerPresent ? "bg-ok" : "bg-line")} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="truncate text-[14px] text-ink">{x.name}</span>
                  {x.ownerPresent && <span className="label rounded-sm border border-you/50 px-1 text-[9px] leading-[14px] text-you">Talking now</span>}
                </span>
                <span className="block text-[13px] text-ink-muted">
                  {x.ownerPresent ? stateWord(x.state) : "no tab has the audio"} · {turnsText(x.turns)}
                  {x.lastTurnAt !== null ? `, last ${agoText(x.lastTurnAt, now)}` : ""}
                </span>
              </span>
              {x.deviceId !== undefined && <Icon name="chevron" size={16} className="shrink-0 text-ink-faint" />}
            </button>
          </li>
        ))}
        {sessions.length === 0 && <li className="px-3 py-2.5 text-[13px] text-ink-faint">No device is talking to the assistant.</li>}
      </ul>
    </section>
  )
}

/**
 * Overview (docs/SETTINGS-UI.md §3.7): what works and what still needs doing (each item links to the page that
 * fixes it), engine problems with Try again, the voice sessions, and the running engines and voices.
 */
export function OverviewPage() {
  const client = useClient()
  const items = useClientState(setupChecklist, shallowEqual)
  const engine = useClientState((s) => s.engine)
  const [reloading, setReloading] = useState(false)
  const reload = async () => {
    setReloading(true)
    const result = await client.reloadEngines() // continuation(none): shows this request's own outcome; no audio or preference state
    setReloading(false)
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "The reload failed.", tone: "error" })
  }
  const open = items.filter((i) => !i.ok).length
  return (
    <div className="flex flex-col gap-8">
      {engine.problems.length > 0 && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-[13px]" data-testid="engine-problems">
          <p className="mb-1 font-medium text-ink">The engines could not start</p>
          <ul className="flex flex-col gap-1 text-ink-muted">
            {engine.problems.map((p, i) => <li key={i}><span className="font-mono text-ink">{p.stage}</span>: {p.message}</li>)}
          </ul>
          {!engine.reloadPending && (
            <Button size="sm" className="mt-2" onClick={() => void reload()} disabled={reloading}>
              {reloading && <Spinner size={12} />}
              Try again
            </Button>
          )}
        </div>
      )}
      <section data-testid="checklist">
        <div className="mb-3 flex items-baseline justify-between">
          <h4 className="label text-ink-faint">Getting started</h4>
          <span className="font-mono text-[12px] text-ink-faint">{items.length - open} of {items.length}</span>
        </div>
        <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
          {items.map((item) => (
            <li key={item.id} className="flex min-h-12 items-center gap-3 px-3 py-2" data-ok={item.ok ? "true" : "false"}>
              <span aria-hidden="true" className={cx("inline-flex size-5 shrink-0 items-center justify-center rounded-full border", item.ok ? "border-ok text-ok" : "border-ink-faint")}>
                {item.ok && <Icon name="check" size={12} />}
              </span>
              <span className={cx("min-w-0 flex-1 text-[14px]", item.ok ? "text-ink" : "text-ink-muted")}>{item.text}</span>
              {item.action !== undefined && (
                <Button size="sm" onClick={() => client.settings(item.action!.path)}>{item.action.label}</Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <SessionsSection />
      <section>
        <h4 className="label mb-3 text-ink-faint">Engines</h4>
        <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
          {engine.engines.map((e, i) => (
            <li key={`${e.stage}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink-muted">{STAGE[e.stage] ?? e.stage}</span>
                <span className="block truncate font-mono text-[13px] text-ink">{e.provider} · {e.detail}</span>
              </span>
              <Where location={e.location} />
            </li>
          ))}
          {engine.engines.length === 0 && <li className="px-3 py-2.5 text-[13px] text-ink-faint">{engine.state === "starting" ? "Starting…" : "None running."}</li>}
        </ul>
      </section>
      {engine.voices.length > 0 && (
        <section>
          {/* One voice (docs/VOICE-PROVIDERS.md §8): `name` is its key, `description` its name. */}
          <h4 className="label mb-3 text-ink-faint">Voice</h4>
          <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
            {engine.voices.map((v) => (
              <li key={v.name} className="flex items-start gap-3 px-3 py-2.5" data-testid="running-voice" data-voice={v.name}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] text-ink">{v.description || v.name}</span>
                  <span className="block truncate font-mono text-[12px] text-ink-faint">{v.engine}</span>
                </span>
                <Where location={v.location} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
