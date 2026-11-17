"use client"
import { useEffect, useState } from "react"
import { answersWithoutPhrase } from "@/lib/devices.ts"
import { listJoin, plural } from "@/lib/assistants.ts"
import { typePageId } from "@/lib/settingsTree.ts"
import { agoText, stateWord, turnsText } from "@/lib/sessions.ts"
import { setupChecklist } from "@/lib/setupChecklist.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { Icon, Spinner } from "../../ui/Icon.tsx"
import { Button, cx } from "../../ui/controls.tsx"
import { LookVoiceLine } from "./devices/LookVoiceSections.tsx"
import type { AssistantInfo, DeviceListInfo, DeviceTypeInfo } from "@pva/protocol"

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
  const assistants = useClientState((s) => s.assistants, shallowEqual)
  const nameOf = (id: string | undefined) => assistants.find((a) => a.id === id)?.name
  const answerer = (x: { readonly answering?: string | undefined }) => nameOf(x.answering)
  const conversationsText = (x: { readonly turns: number; readonly conversations?: ReadonlyArray<{ readonly assistantId: string; readonly turns: number }> | undefined }) =>
    x.conversations !== undefined && x.conversations.length > 0
      ? `conversations: ${x.conversations.map((c) => `${nameOf(c.assistantId) ?? c.assistantId} ${turnsText(c.turns)}`).join(", ")}`
      : turnsText(x.turns)
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
                  {x.ownerPresent ? `${answerer(x) !== undefined && x.state === "speaking" ? `${answerer(x)} speaking` : stateWord(x.state)}` : "no tab has the audio"} · {conversationsText(x)}
                  {x.lastTurnAt !== null ? ` · last ${agoText(x.lastTurnAt, now)}` : ""}
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


/** How an assistant is reached on a device: without a phrase, by its phrases, and "or when it fits" under TypeSafe. */
function Reach({ settings, assistant, max }: { readonly settings: DeviceListInfo["settings"]; readonly assistant: string; readonly max?: number }) {
  const e = settings.assistants.find((x) => x.assistant === assistant)
  if (e === undefined) return null
  const without = answersWithoutPhrase(settings.withoutPhrase, assistant)
  const phrases = max === undefined ? e.phrases : e.phrases.slice(0, max)
  return (
    <span className="flex flex-wrap items-center gap-1" data-reach={without ? "without-phrase" : e.phrases.length > 0 ? "phrase" : settings.withoutPhrase.mode === "typesafe" ? "typesafe" : "unreachable"}>
      {without && <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[12px] text-ink">Without a phrase</span>}
      {phrases.map((p) => <span key={p} className="rounded-full border border-line bg-surface-2/50 px-2 py-0.5 text-[12px] text-ink-muted">{`“${p}”`}</span>)}
      {max !== undefined && e.phrases.length > max && <span className="text-[12px] text-ink-muted">+{e.phrases.length - max}</span>}
      {settings.withoutPhrase.mode === "typesafe" && <span className="text-[12px] text-ink-faint" title="TypeSafe can choose this assistant for a sentence without a phrase">or when it fits</span>}
    </span>
  )
}

/**
 * "Who answers where" (docs/ASSISTANTS.md §7.1): devices against assistants; a cell opens the device to change it.
 * A row's key is a device id or `type:<kind>`, a group heading's `g:<kind>`: the colons keep them from any device id.
 */
export function WhoAnswersWhere() {
  const client = useClient()
  const types = useClientState((s) => s.deviceTypes)
  const devices = useClientState((s) => s.devices)
  const assistants = useClientState((s) => s.assistants)
  const sessions = useClientState((s) => s.sessions)
  const real = devices.length
  type Entry = { readonly key: string; readonly path: string; readonly name: string; readonly defaults: boolean; readonly sub: string; readonly follows: boolean; readonly talking: boolean; readonly settings: DeviceListInfo["settings"]; readonly own?: DeviceListInfo["own"] }
  const entries = (t: DeviceTypeInfo): ReadonlyArray<Entry> => {
    const members = devices.filter((d) => d.kind === t.kind)
    const followers = members.filter((d) => d.own.assistants === undefined)
    return [
      { key: `type:${t.kind}`, path: typePageId(t.kind), name: `Every ${t.one}`, defaults: true, follows: false, talking: false, settings: t.settings, sub: followers.length > 0 ? `Followed by ${listJoin(followers.map((m) => m.name))}` : "No device follows it" },
      ...members.map((d): Entry => ({
        key: d.id,
        path: d.id,
        name: d.name,
        defaults: false,
        follows: d.own.assistants === undefined,
        talking: sessions.find((x) => x.deviceId === d.id)?.ownerPresent === true,
        settings: d.settings,
        own: d.own,
        sub: d.own.assistants === undefined ? `Follows Every ${t.one}` : d.connections > 0 ? "Connected now" : "Own list"
      }))
    ]
  }
  const label = (e: Entry, a: AssistantInfo): string => {
    const x = e.settings.assistants.find((y) => y.assistant === a.id)
    if (x === undefined) return `${a.name} on ${e.name}: not here`
    const how = answersWithoutPhrase(e.settings.withoutPhrase, a.id) ? "answers without a phrase" : x.phrases.map((p) => `“${p}”`).join(", ") || "no phrase"
    return `${a.name} on ${e.name}: ${how}${e.settings.withoutPhrase.mode === "typesafe" ? ", or when TypeSafe finds it fits" : ""}`
  }
  return (
    <section data-testid="who-answers-where">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h4 className="label text-ink-faint">Who answers where</h4>
        <span className="font-mono text-[12px] text-ink-faint" data-testid="grid-count">{plural(real, "device")} · {plural(assistants.length, "assistant")}</span>
      </div>
      <p className="mb-3 text-[13px] text-ink-muted">Rows are devices, columns are assistants. A cell shows how that assistant is reached on that device. Open a device to change it.</p>
      {assistants.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-4 py-5 text-[14px] text-ink-muted" data-testid="grid-empty">Nobody answers anywhere: there is no assistant yet.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-md border border-line scrollbar-quiet lg:block">
            <table className="w-full border-collapse text-left" data-testid="grid">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="px-3 py-3 align-bottom text-[12px] font-normal text-ink-faint">Device</th>
                  {assistants.map((a) => (
                    <th key={a.id} scope="col" className="max-w-[180px] px-3 py-3 align-bottom font-normal" data-assistant={a.id}>
                      <a href={`#settings/assistants/${a.id}`} className="text-[14px] font-medium text-ink underline-offset-4 hover:underline">{a.name}</a>
                      {!a.on && <span className="label ml-2 rounded-sm border border-line px-1 text-[9px] text-ink-faint">Off</span>}
                      <span className="block truncate text-[12px] font-normal text-ink-faint">{a.purpose}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {types.flatMap((t) => [
                  <tr key={`g:${t.kind}`}><th colSpan={assistants.length + 1} scope="colgroup" className="label px-3 pb-1 pt-4 text-left text-[10px] font-normal text-ink-faint">{t.title}</th></tr>,
                  ...entries(t).map((e) => (
                    <tr key={e.key} className={cx("border-t border-line/60", e.follows && "opacity-70")} data-row={e.key}>
                      <th scope="row" className="p-0 text-left font-normal">
                        <button type="button" className="flex w-full flex-col gap-0.5 px-3 py-3 text-left hover:bg-surface-2/50" onClick={() => client.settings(["devices", e.path])}>
                          <span className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
                            {e.name}
                            {e.defaults && <span className="label rounded-sm border border-ink-faint px-1 text-[9px] leading-[14px] text-ink-muted">Defaults</span>}
                            {e.talking && <span className="label rounded-sm border border-you/50 px-1 text-[9px] leading-[14px] text-you">Talking now</span>}
                          </span>
                          <span className="text-[12px] font-normal text-ink-faint">{e.sub}</span>
                          <LookVoiceLine settings={e.settings} own={e.own} defaults={e.defaults} />
                        </button>
                      </th>
                      {assistants.map((a) => (
                        <td key={a.id} className="p-0 align-top" data-cell={`${e.key}:${a.id}`}>
                          <button type="button" aria-label={label(e, a)} className="block h-full min-h-[56px] w-full px-3 py-3 text-left hover:bg-surface-2/50" onClick={() => client.settings(["devices", e.path])}>
                            <Reach settings={e.settings} assistant={a.id} />
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))
                ])}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line lg:hidden" data-testid="grid-list">
            {types.flatMap((t) => [
              <li key={`g:${t.kind}`} className="px-3 py-2"><span className="label text-[10px] text-ink-faint">{t.title}</span></li>,
              ...entries(t).map((e) => (
                <li key={e.key}>
                  <button type="button" className="flex w-full flex-col gap-1.5 px-3 py-3 text-left hover:bg-surface-2/50" onClick={() => client.settings(["devices", e.path])}>
                    <span className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
                      {e.name}
                      {e.defaults && <span className="label rounded-sm border border-ink-faint px-1 text-[9px] leading-[14px] text-ink-muted">Defaults</span>}
                      {e.talking && <span className="label rounded-sm border border-you/50 px-1 text-[9px] leading-[14px] text-you">Talking now</span>}
                    </span>
                    <span className="text-[12px] text-ink-faint">{e.sub}</span>
                    <LookVoiceLine settings={e.settings} own={e.own} defaults={e.defaults} />
                    {e.settings.assistants.map((x) => (
                      <span key={x.assistant} className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
                        <span className="min-w-12 text-ink">{assistants.find((a) => a.id === x.assistant)?.name ?? x.assistant}</span>
                        {x.phrases.length === 0 && !answersWithoutPhrase(e.settings.withoutPhrase, x.assistant) && e.settings.withoutPhrase.mode !== "typesafe"
                          ? <span className="text-[12px] text-warn">Cannot be reached</span>
                          : <Reach settings={e.settings} assistant={x.assistant} max={2} />}
                      </span>
                    ))}
                  </button>
                </li>
              ))
            ])}
          </ul>
        </>
      )}
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
      <WhoAnswersWhere />
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
