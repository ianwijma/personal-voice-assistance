"use client"
import { useEffect, useRef, useState } from "react"
import type { Assistant, AssistantInfo, DeviceTarget, FieldError } from "@pva/protocol"
import {
  accountInfo,
  blankAssistantBody,
  deepEqual,
  hearingModelNames,
  listJoin,
  type Outcome,
  plural,
  quoted,
  summaryParts,
  targetKey,
  targetName,
  toBody
} from "@/lib/assistants.ts"
import { lastSeenText } from "@/lib/profileForm.ts"
import { useClient, useClientState } from "../../context.tsx"
import { inputClass } from "../../fields/types.ts"
import { Icon, Spinner } from "../../ui/Icon.tsx"
import { Button, cx } from "../../ui/controls.tsx"
import { AField, idOfPath, RadioCards, Strip, TextControl } from "./assistants/parts.tsx"
import { HearingFields, ModelFields, ModuleList } from "./assistants/tabs.tsx"
import { useWizardDraft, type WizardDraft } from "./assistants/useWizardDraft.ts"
import { VoiceTab } from "./assistants/tabs.tsx"
import { useVoiceNameOf } from "./AssistantsPage.tsx"
import { useKeyboardInset } from "../../useKeyboardInset.ts"

/**
 * Assistants › New assistant (docs/ASSISTANTS.md §7.1, mock-up `admin.html` `pWizard`): seven steps, the step being the
 * third part of the path (`#settings/assistants/new/3`). Start (name, purpose, Handles, Start from), Language model,
 * Hearing, Voice, Modules, Where (the devices it answers on, with a phrase each) and Check. Nothing is saved before
 * "Create assistant", which sends `assistant.create` with the placements and lands on the new assistant's page.
 */

const STEPS = ["Start", "Language model", "Hearing", "Voice", "Modules", "Where", "Check"] as const
const LAST = STEPS.length

/** The step a path means (1..7; anything else is the first). */
export const wizardStep = (part: string | undefined): number => {
  const n = Number(part)
  return Number.isInteger(n) && n >= 1 && n <= LAST ? n : 1
}

/** Which step edits the field a refusal names. */
const stepOfPath = (key: string | null): number => {
  if (key === null) return LAST
  const head = key.split(".")[0]!
  return head === "name" || head === "purpose" || head === "handles" ? 1 : head === "llm" ? 2 : head === "hearing" ? 3 : head === "voice" ? 4 : head === "modules" ? 5 : 6
}

interface Placement {
  readonly on: boolean
  readonly phrase: string
}

const NO_PLACEMENT: Placement = { on: false, phrase: "" }

export function NewAssistantWizard() {
  const client = useClient()
  const part = useClientState((s) => s.ui.settingsPath[2])
  const step = wizardStep(part)
  const assistants = useClientState((s) => s.assistants)
  const modules = useClientState((s) => s.modules)
  const sections = useClientState((s) => s.sections)
  const devices = useClientState((s) => s.devices)
  const types = useClientState((s) => s.deviceTypes)
  const voiceName = useVoiceNameOf()
  const inset = useKeyboardInset()
  const moduleList = modules.order.flatMap((id) => (modules.byId[id] !== undefined ? [modules.byId[id]!] : []))
  const capability = moduleList.filter((m) => m.kind === undefined || m.kind === "capability")

  /** A blank assistant: the Claude API, Parakeet v2, the Lessac voice and the Clock module (the mock-up's "Good defaults"). */
  const blank = (): Assistant => ({
    id: "",
    rev: 0,
    ...blankAssistantBody(""),
    modules: Object.fromEntries(capability.map((m) => [m.id, { on: m.id === "clock", offTools: [] }]))
  })
  /** Set while `assistant.create` is on its way: the wizard is inert and ignores edits and step changes (they would not be in the request). */
  const creating = useRef(false)
  const draft = useWizardDraft(blank, () => creating.current)
  const a = draft.current
  const [from, setFrom] = useState("blank")
  const [where, setWhere] = useState<Readonly<Record<string, Placement>>>({})
  const [busy, setBusy] = useState(false)
  const [whereMessage, setWhereMessage] = useState<string | undefined>()
  const [createError, setCreateError] = useState<string | undefined>()
  const [now] = useState(() => Date.now())

  // The settings screen asks "Leave without saving?" once anything has been typed or chosen.
  const dirty = a.name !== "" || a.purpose !== "" || a.handles !== "" || from !== "blank" || Object.values(where).some((w) => w.on) || !deepEqual({ ...a, name: "", purpose: "", handles: "" }, { ...blank(), name: "", purpose: "", handles: "" })
  useEffect(() => {
    if (client.store.get().ui.settingsDirty !== dirty) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: dirty } })
  }, [client, dirty])
  useEffect(() => () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } }), [client])

  const go = (n: number) => {
    if (!creating.current) client.settings(["assistants", "new", String(n)])
  }
  const editWhere = (f: (s: Readonly<Record<string, Placement>>) => Readonly<Record<string, Placement>>) => {
    if (!creating.current) setWhere(f)
  }
  const next = () => go(Math.min(LAST, step + 1))

  /** Start from: a copy takes the prompt, language model, hearing, voice and modules; the typed name, purpose and Handles stay. */
  const chooseFrom = (id: string) => {
    if (creating.current) return
    setFrom(id)
    const source = assistants.find((x) => x.id === id)
    const fresh = blank()
    const body = source === undefined ? toBody(fresh) : toBody(source)
    draft.replace({ ...a, ...body, name: a.name, purpose: a.purpose, handles: a.handles, on: true, confirmActions: "off" })
  }

  const create = async () => {
    if (creating.current) return
    setCreateError(undefined)
    setWhereMessage(undefined)
    if (a.name.trim() === "") {
      draft.setErrors([{ key: "name", message: "An assistant needs a name." }])
      return go(1)
    }
    creating.current = true
    setBusy(true)
    const placements = Object.entries(where)
      .filter(([, w]) => w.on)
      .map(([key, w]) => ({ target: targetOfKey(key), ...(w.phrase.trim() !== "" ? { phrase: w.phrase.trim() } : {}) }))
    const body = { ...toBody(a), name: a.name.trim() }
    let outcome: Outcome
    try {
      outcome = await client.createAssistant(body, { ...(from !== "blank" ? { copyOf: from } : {}), placements }) // continuation(none): only this page's own state, then it navigates
    } catch {
      outcome = { kind: "refused", code: "internal", message: "Could not create it. Try again." }
    }
    creating.current = false
    setBusy(false)
    if (outcome.kind === "ok" && outcome.assistantId !== undefined) {
      client.store.dispatch({ type: "local/toast", message: `Created ${body.name}.`, tone: "info" })
      return client.settings(["assistants", outcome.assistantId], { discard: true })
    }
    if (outcome.kind === "invalid") {
      draft.setErrors(outcome.fieldErrors)
      const first = Math.min(...outcome.fieldErrors.map((e: FieldError) => stepOfPath(e.key)))
      if (first === 6) setWhereMessage(outcome.fieldErrors.map((e) => e.message).join(" "))
      return go(first)
    }
    setCreateError(outcome.kind === "ok" ? "The assistant did not say which one it created." : outcome.message)
  }

  const names = hearingModelNames(sections)
  const placed = Object.entries(where).filter(([, w]) => w.on)
  const dupes = assistants.some((x) => x.name.trim().toLowerCase() === a.name.trim().toLowerCase() && a.name.trim() !== "")

  return (
    <div className="flex flex-1 flex-col gap-6" data-testid="wizard" data-step={step} inert={busy} aria-busy={busy}>
      <p className="-mt-4 text-[14px] text-ink-muted" data-testid="wizard-step-name">{STEPS[step - 1]}</p>
      <Stepper step={step} go={go} />
      {step === 1 && (
        <>
          <p className="text-[14px] text-ink-muted">An assistant is who answers, and how. Where it listens and which phrase wakes it comes in step 6, or later under Devices.</p>
          <AField label="Name" path="name" draft={draft} htmlFor={idOfPath("name")} help="Shown in lists and on the voice page. It is not the wake phrase." warn={dupes ? "Another assistant already has this name." : undefined}>
            <TextControl draft={draft} path="name" max={32} label="Name" placeholder="For example Mia" />
          </AField>
          <AField label="Purpose" path="purpose" draft={draft} htmlFor={idOfPath("purpose")} help="One line, shown in lists.">
            <TextControl draft={draft} path="purpose" max={80} label="Purpose" placeholder="One line: what it is for" />
          </AField>
          <AField label="Handles (optional)" path="handles" draft={draft} htmlFor={idOfPath("handles")} help="Used when a device lets TypeSafe decide who a sentence is for. Describe what it is for, not which words to listen for.">
            <TextControl draft={draft} path="handles" max={240} label="Handles" multiline rows={2} placeholder="One or two sentences: when this assistant should be chosen" />
          </AField>
          <div className="flex flex-col gap-1.5">
            <span id="wizard-from-label" className="text-[14px] font-medium text-ink">Start from</span>
            <RadioCards
              groupId="wizard-from"
              label="Start from"
              value={from}
              onChange={chooseFrom}
              cards={[
                { value: "blank", title: "Blank", tags: [], description: "Good defaults: Anthropic API, Parakeet v2, the Lessac voice on this machine and the Clock module." },
                ...assistants.map((x) => ({
                  value: x.id,
                  title: `Copy of ${x.name}`,
                  tags: [] as [],
                  description: <Strip as="span" parts={summaryParts(x, moduleList, names, voiceName(x.voice))} className="text-ink-faint" />
                }))
              ]}
            />
            <p className="text-[13px] text-ink-muted">A copy takes the prompt, language model, hearing, voice and modules. Devices are not copied.</p>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <ModelFields draft={draft} />
          <Later />
        </>
      )}
      {step === 3 && (
        <>
          <HearingFields draft={draft} />
          <p className="rounded-md border border-line bg-surface-2/40 px-3 py-2 text-[13px] text-ink-muted" data-testid="hearing-callout">
            A device hears with one recogniser. If this assistant shares a device with others, it is only used there when it answers without a phrase or is first in that device’s list.
          </p>
          <Later />
        </>
      )}
      {step === 4 && (
        <>
          <VoiceTab draft={draft} info={emptyInfo(a)} />
          <Later />
        </>
      )}
      {step === 5 && (
        <>
          <p className="text-[14px] text-ink-muted">What it can do. Module settings are shared; here you only switch them on.</p>
          <ModuleList draft={draft} compact />
          <p className="text-[13px] text-ink-muted">Which tools of a module it may use can be narrowed later on the assistant’s page.</p>
        </>
      )}
      {step === 6 && (
        <>
          <p className="text-[14px] text-ink-muted">
            Optional. Tick where {a.name.trim() === "" ? "it" : a.name.trim()} should answer and type the phrase that wakes it there. You can change this any time under Devices.
          </p>
          {whereMessage !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="where-error">{whereMessage}</p>}
          {types.length === 0 ? (
            <p className="rounded-md border border-dashed border-line px-4 py-5 text-[14px] text-ink-muted">No device has connected yet. Assign {a.name.trim() === "" ? "it" : a.name.trim()} to a device under Devices later.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="where-list">
              {types.flatMap((t) => {
                const members = devices.filter((d) => d.kind === t.kind)
                const followers = members.filter((d) => d.own.assistants === undefined)
                const typeName = `Every ${t.one}`
                const rows: ReadonlyArray<{ readonly target: DeviceTarget; readonly name: string; readonly defaults: boolean; readonly sub: string }> = [
                  { target: { kind: "type", type: t.kind }, name: typeName, defaults: true, sub: `Also reaches ${followers.length > 0 ? listJoin(followers.map((f) => f.name)) : `new ${t.many}`}` },
                  ...members.map((d) => ({
                    target: { kind: "device", id: d.id } as DeviceTarget,
                    name: d.name,
                    defaults: false,
                    sub: d.own.assistants === undefined ? `Follows ${typeName}; ticking gives it its own list` : lastSeenText(d, now)
                  }))
                ]
                return [
                  <li key={`h-${t.kind}`} className="px-3 py-2"><span className="label text-[10px] text-ink-faint">{t.title}</span></li>,
                  ...rows.map((r) => {
                    const key = targetKey(r.target)
                    const w = where[key] ?? NO_PLACEMENT
                    return (
                      <li key={key} className="flex flex-col gap-2 px-3 py-2.5" data-where={key}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={w.on}
                          aria-label={`${r.name}${r.defaults ? " (defaults)" : ""}`}
                          onClick={() => editWhere((s) => ({ ...s, [key]: { ...(s[key] ?? NO_PLACEMENT), on: !w.on } }))}
                          className="flex min-h-11 items-start gap-3 text-left"
                          data-testid="where-check"
                        >
                          <span aria-hidden="true" className={cx("mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border", w.on ? "border-you bg-you-soft text-you" : "border-ink-faint")}>
                            {w.on && <Icon name="check" size={12} />}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-[14px] text-ink">{r.name}</span>
                              {r.defaults && <span className="label rounded-sm border border-ink-faint px-1 text-[9px] leading-[14px] text-ink-muted">Defaults</span>}
                            </span>
                            <span className="block text-[12px] text-ink-faint">{r.sub}</span>
                          </span>
                        </button>
                        {w.on && (
                          <div className="flex flex-col gap-1.5 pl-[30px]">
                            <label className="sr-only" htmlFor={`wp-${key}`}>Wake phrase on {r.name}</label>
                            <input
                              id={`wp-${key}`}
                              type="text"
                              value={w.phrase}
                              autoComplete="off"
                              placeholder={`Wake phrase, for example hey ${(a.name.trim() || "mia").toLowerCase()}`}
                              onChange={(e) => editWhere((s) => ({ ...s, [key]: { ...(s[key] ?? NO_PLACEMENT), phrase: e.target.value } }))}
                              className={cx(inputClass, "max-w-[360px]")}
                            />
                            {w.phrase.trim() === "" && <p className="text-[13px] text-warn">Without a phrase it cannot be reached here.</p>}
                          </div>
                        )}
                      </li>
                    )
                  })
                ]
              })}
            </ul>
          )}
          <div>
            <Button
              variant="quiet"
              onClick={() => {
                editWhere(() => ({}))
                go(7)
              }}
              data-testid="decide-later"
            >
              Decide later
            </Button>
          </div>
        </>
      )}
      {step === 7 && (
        <>
          <p className="text-[14px] text-ink-muted">Check, then create. Everything here can be changed afterwards.</p>
          <dl className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="check-list">
            <CheckRow n={1} label="Start" go={go}>
              {a.name.trim() !== "" ? <span className="text-ink">{a.name.trim()}</span> : <span className="text-warn">No name yet</span>}
              {a.purpose !== "" && <span className="text-ink-muted"> · {a.purpose}</span>}
              <span className="block text-[12px] text-ink-faint">{from === "blank" ? "Started blank" : `Copy of ${assistants.find((x) => x.id === from)?.name ?? from}`}</span>
            </CheckRow>
            <CheckRow n={2} label="Language model" go={go}>
              {accountInfo(a.llm.account).title} · <span className="font-mono text-[13px]">{a.llm.account === "offline" ? "no model" : a.llm.model} · effort {a.llm.effort}</span>
            </CheckRow>
            <CheckRow n={3} label="Hearing" go={go}>
              {a.hearing.engine === "deepgram" ? "Deepgram" : "On this machine"} ·{" "}
              <span className="font-mono text-[13px]">{a.hearing.engine === "deepgram" ? "Deepgram Flux" : names.hearing(a.hearing.model)}{a.hearing.engine === "sherpa" && a.hearing.language !== "auto" ? ` · ${a.hearing.language}` : ""}</span>
            </CheckRow>
            <CheckRow n={4} label="Voice" go={go}>
              {voiceName(a.voice) ?? a.voice.voiceId} · {a.voice.provider === "sherpa" ? "on this machine" : a.voice.provider}
            </CheckRow>
            <CheckRow n={5} label="Modules" go={go}>
              {listJoin(capability.filter((m) => a.modules[m.id]?.on === true).map((m) => m.name)) || "None"}
              <span className="text-[12px] text-ink-faint"> · {plural(capability.filter((m) => a.modules[m.id]?.on === true).reduce((n, m) => n + m.tools.filter((t) => !(a.modules[m.id]?.offTools ?? []).includes(t.name)).length, 0), "tool")}</span>
            </CheckRow>
            <CheckRow n={6} label="Where" go={go}>
              {placed.length === 0 ? "Decided later: not on any device yet." : (
                <span className="flex flex-col gap-0.5">
                  {placed.map(([key, w]) => (
                    <span key={key}>
                      {targetName(targetOfKey(key), devices, types)}
                      {w.phrase.trim() !== "" ? <> on <span className="rounded-full border border-line px-2 py-0.5 text-[12px]">{quoted(w.phrase.trim())}</span></> : <span className="text-[12px] text-warn"> no phrase</span>}
                    </span>
                  ))}
                </span>
              )}
            </CheckRow>
          </dl>
          {createError !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="create-error">{createError}</p>}
        </>
      )}
      <div
        className="sticky bottom-0 z-10 -mx-5 mt-auto border-t border-line bg-surface/95 px-5 pt-3 backdrop-blur-sm sm:-mx-8 sm:px-8"
        style={{ bottom: inset, paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
        data-testid="page-footer"
      >
        <div className="flex flex-wrap items-center gap-2">
          {step > 1
            ? <Button variant="quiet" onClick={() => go(step - 1)} data-testid="wizard-back"><Icon name="back" size={16} />Back</Button>
            : <Button variant="quiet" onClick={() => client.settings(["assistants", "all"])} data-testid="wizard-cancel">Cancel</Button>}
          <span className="ml-auto font-mono text-[12px] text-ink-muted" data-testid="step-count">Step {step} of {LAST}</span>
          {step < LAST
            ? <Button variant="primary" onClick={next} data-testid="wizard-next">Next: {STEPS[step]}</Button>
            : (
              <Button variant="primary" onClick={() => void create()} disabled={busy} data-testid="wizard-create">
                {busy && <Spinner size={13} />}
                Create assistant
              </Button>
            )}
        </div>
      </div>
    </div>
  )
}

const targetOfKey = (key: string): DeviceTarget => (key.startsWith("type:") ? { kind: "type", type: key.slice(5) } : { kind: "device", id: key.slice(7) })

/** The voice tab wants the assistant it belongs to; a new one is on no device yet. */
const emptyInfo = (a: Assistant): AssistantInfo => ({ ...a, usedOn: [], resources: { llm: "unused", voice: "unused" }, problems: [] }) as AssistantInfo

function Later() {
  return <p className="text-[13px] text-ink-muted">More settings later on the assistant’s page.</p>
}

function CheckRow({ n, label, go, children }: { readonly n: number; readonly label: string; readonly go: (n: number) => void; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-3 py-3" data-check={n}>
      <dt className="w-[110px] shrink-0 text-[13px] text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-[14px] text-ink-muted">{children}</dd>
      <button type="button" className="min-h-8 shrink-0 text-[13px] text-voice underline-offset-4 hover:underline max-sm:min-h-11" aria-label={`Edit ${label}`} onClick={() => go(n)}>Edit</button>
    </div>
  )
}

/** The seven steps: a bar and a number each; a step that is done goes back to it. */
function Stepper({ step, go }: { readonly step: number; readonly go: (n: number) => void }) {
  return (
    <nav aria-label="Steps" data-testid="stepper">
      <ol className="grid grid-cols-7 gap-1.5">
        {STEPS.map((name, i) => {
          const n = i + 1
          const done = n < step
          const current = n === step
          const inner = (
            <>
              <span className={cx("h-0.5 w-full rounded-full", done ? "bg-ok/60" : current ? "bg-voice" : "bg-line")} aria-hidden="true" />
              <span className="flex items-center gap-1.5 pt-1.5">
                <span
                  aria-hidden="true"
                  className={cx(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] border font-mono text-[11px]",
                    done ? "border-ok/60 bg-ok/10 text-ok" : current ? "border-voice/70 text-voice" : "border-line text-ink-muted"
                  )}
                >
                  {done ? <Icon name="check" size={12} /> : n}
                </span>
                <span className={cx("hidden text-[12px] leading-tight sm:inline", current ? "text-ink" : "text-ink-muted")}>{name}</span>
              </span>
            </>
          )
          return (
            <li key={name} className="min-w-0">
              {done ? (
                <button type="button" className="flex w-full flex-col text-left" aria-label={`Step ${n}: ${name}, done. Go back to it`} onClick={() => go(n)} data-step-link={n}>{inner}</button>
              ) : (
                <div className="flex flex-col" aria-current={current ? "step" : undefined} data-step-current={current ? n : undefined}>
                  <span className="sr-only">Step {n}{current ? ", current" : ""}: {name}</span>
                  {inner}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
