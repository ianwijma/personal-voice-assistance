"use client"
import { type ReactNode, useEffect, useRef, useState } from "react"
import {
  type Activation,
  type DeviceProfile,
  FOLLOW_UP_SECONDS_MAX,
  CONVERSATION_IDLE_MINUTES_LIMITS,
  FOLLOW_UP_SECONDS_MIN,
  type InterruptMode,
  type OutputPath,
  PREBUFFER_MS_MAX,
  PREBUFFER_MS_MIN,
  type ProfileField,
  type ProfileOverrides,
  type ProfilePatch,
  WAKE_PHRASES_MAX,
  type WakeMatch
} from "@pva/protocol"
import type { ResultMessage } from "@/lib/connection.ts"
import {
  clearOverride,
  displayProfileValue,
  draftPatch,
  effectiveValue,
  FIELD_LABEL,
  INTERRUPT_CHOICES,
  normalisePhrase,
  overridesEqual,
  phraseProblem,
  PROFILE_GROUPS,
  setOverride
} from "@/lib/profileForm.ts"
import { displayPhrase } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../context.tsx"
import { inputClass } from "../fields/types.ts"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { Button, cx, Segmented, Switch } from "../ui/controls.tsx"
import { FieldMarkers, FormFooter, MarkerLegend } from "./FormFooter.tsx"

/** Help lines; `device`: on a device page ("this device"), else the kind's defaults ("these devices"). */
const help = (device: boolean): Partial<Record<ProfileField, string>> => {
  const here = device ? "this device" : "these devices"
  return {
    wakeMatch: "Close accepts small differences in longer words (“hey jeffs”, “hey geff”). Add a phrase for anything else.",
    followUpSeconds: "After a reply, the next question needs no phrase within this time. 0 = say the phrase every time.",
    conversationIdleMinutes: `After this long without a turn, the next thing said on ${here} starts a fresh conversation: the assistant forgets the earlier one. 0 = never.`,
    voice: `The voice replies use on ${here}. A voice that is switched off falls back to the assistant's default.`,
    echoCancellation: "Removes the assistant's own voice from the microphone. On iPhone it also changes your voice's level and can make playback crackle.",
    noiseSuppression: "Filters steady background noise. It can blur quiet words.",
    autoGainControl: "Lets the browser adjust the microphone level.",
    captions: "Show what you say and what the assistant says under the line.",
    speakReplies: `Replies to typed messages are spoken too, when ${device ? "this device has" : "one of these devices has"} the audio.`,
    outputPath: "A media element is an older workaround that makes some browsers cancel the assistant's echo.",
    prebufferMs: "Audio buffered before a reply starts. Lower is faster; raise it (200–300 ms on a phone over Wi-Fi) if replies stutter."
  }
}

/** The activation help describes the mode that is selected. */
const ACTIVATION_HELP: Record<Activation, string> = {
  always: "Always listening: the assistant reacts to everything it hears.",
  "wake-phrase": "Wake phrase: the assistant still hears everything, but reacts only after one of the phrases."
}

export interface ProfileFormProps {
  /** For ids and test ids ("frontend-web-voice", "device-…"). */
  readonly id: string
  /** The fields that apply (the kind's `fields`), in form order. */
  readonly fields: ReadonlyArray<ProfileField>
  /** What a field without an override gets. */
  readonly base: DeviceProfile
  /** The overrides saved at this level. */
  readonly saved: ProfileOverrides
  /** Device pages say "Default (…)" on every inherited field; the kind page marks only its changes. */
  readonly showInherited: boolean
  readonly onSave: (patch: ProfilePatch) => Promise<ResultMessage>
  /** Rendered under the phrase list (the phrase tester); gets a function that adds a phrase to the draft. */
  /** Edits on the same page outside the form (the device rename): count as unsaved for the leave check. */
  readonly extraDirty?: boolean
  readonly afterPhrases?: (addPhrase: (phrase: string) => string | undefined, phrases: { readonly draft: ReadonlyArray<string>; readonly saved: ReadonlyArray<string> }) => ReactNode
}

/**
 * The device-profile form (docs/FRONTENDS-AND-ACTIVATION.md §5): groups Activation, Voice, Interrupting, Audio
 * processing, Display, Advanced. A draft of overrides: a change sets one, Reset removes it (saved as `null`, the field
 * inherits again). One sticky footer saves the page; a change made elsewhere meanwhile shows "Load latest".
 */
export function ProfileForm({ id, fields, base, saved, showInherited, onSave, afterPhrases, extraDirty = false }: ProfileFormProps) {
  const [draft, setDraft] = useState<ProfileOverrides>(saved)
  const [from, setFrom] = useState<ProfileOverrides>(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [savedNote, setSavedNote] = useState(false)
  const [invalid, setInvalid] = useState<ReadonlySet<ProfileField>>(new Set())
  /** Bumped by Cancel: the controls start over (a half-typed number goes too). */
  const [generation, setGeneration] = useState(0)
  const dirty = !overridesEqual(draft, from, fields)
  const stale = !overridesEqual(from, saved, fields)
  // A change saved elsewhere (another tab, the device itself): take it at once while there are no edits here.
  useEffect(() => {
    if (!dirty && stale) {
      setDraft(saved)
      setFrom(saved)
    }
  }, [dirty, stale, saved])
  const shown = new Set(fields)
  // A field named like its group ("Voice" in VOICE) has no visible label of its own: the group's heading takes its
  // place and its markers (Unsaved / Custom / Override, Reset) sit on the heading's row.
  const headingOf = new Map<ProfileField, { readonly id: string; readonly title: string }>()
  for (const g of PROFILE_GROUPS) {
    const first = g.fields.find((f) => shown.has(f))
    if (g.advanced !== true && first !== undefined && FIELD_LABEL[first] === g.title) headingOf.set(first, { id: `${id}-group-${g.id}`, title: g.title })
  }

  const set = <F extends ProfileField>(field: F, value: DeviceProfile[F]) => {
    setSavedNote(false)
    setDraft((d) => setOverride(d, field, value))
  }
  const reset = (field: ProfileField) => {
    setSavedNote(false)
    setDraft((d) => clearOverride(d, field))
  }
  const markInvalid = (field: ProfileField, bad: boolean) =>
    setInvalid((s) => {
      if (s.has(field) === bad) return s
      const next = new Set(s)
      if (bad) next.add(field)
      else next.delete(field)
      return next
    })
  const value = <F extends ProfileField>(field: F) => effectiveValue(draft, base, field)
  const save = async () => {
    setSaving(true)
    setError(undefined)
    const result = await onSave(draftPatch(from, draft, fields)) // continuation(none): only this form's own display state
    setSaving(false)
    if (!result.ok) {
      const fieldErrors = result.error?.fieldErrors?.map((e) => (e.key === null ? e.message : `${FIELD_LABEL[e.key as ProfileField] ?? e.key}: ${e.message}`))
      setError(fieldErrors !== undefined && fieldErrors.length > 0 ? fieldErrors.join(" ") : result.error?.message ?? "Not saved.")
      return
    }
    setFrom(draft)
    setSavedNote(true)
  }
  const cancel = () => {
    setDraft(saved)
    setFrom(saved)
    setError(undefined)
    setInvalid(new Set())
    setGeneration((g) => g + 1)
  }
  const ownEditing = dirty || invalid.size > 0
  const editing = ownEditing || extraDirty
  // The shell asks "Leave without saving?" before leaving a page with edits.
  const client = useClient()
  useEffect(() => {
    if (client.store.get().ui.settingsDirty !== editing) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: editing } })
  }, [client, editing])
  useEffect(() => () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } }), [client])
  const addPhrase = (phrase: string): string | undefined => {
    const list = value("wakePhrases")
    const problem = phraseProblem(phrase, list)
    if (problem !== undefined) return problem
    set("wakePhrases", [...list, normalisePhrase(phrase)])
    return undefined
  }

  const row = (field: ProfileField, control: ReactNode, opts: { readonly labelFor?: string; readonly after?: ReactNode } = {}) => (
    <FieldShell
      key={field}
      field={field}
      formId={id}
      labelFor={opts.labelFor}
      overridden={Object.hasOwn(draft, field)}
      unsaved={!overridesEqual(draft, from, [field])}
      // Saved at this level: a kind default or server setting is "Custom" only when it differs from the built-in
      // default; a device's explicit value is always an "Override", even if it equals the default now.
      custom={Object.hasOwn(from, field) && (showInherited || !overridesEqual({ [field]: from[field] }, { [field]: base[field] }, [field]))}
      sameAsDefault={Object.hasOwn(from, field) && overridesEqual({ [field]: from[field] }, { [field]: base[field] }, [field])}
      heading={headingOf.get(field)}
      inherited={displayProfileValue(field, base[field])}
      showInherited={showInherited}
      onReset={() => reset(field)}
      disabled={saving}
      mode={value("activation")}
      labelHidden={groupTitleOf(field) === FIELD_LABEL[field]}
    >
      {control}
      {opts.after}
    </FieldShell>
  )

  const controls: { readonly [F in ProfileField]: () => ReactNode } = {
    activation: () =>
      row("activation", (
        <Segmented<Activation>
          name={`${id}-activation`}
          label={FIELD_LABEL.activation}
          value={value("activation")}
          disabled={saving}
          options={[{ value: "always", label: "Always listening" }, { value: "wake-phrase", label: "Wake phrase" }]}
          onChange={(v) => set("activation", v)}
        />
      )),
    wakePhrases: () =>
      row("wakePhrases", (
        <PhraseList
          id={`${id}-phrases`}
          phrases={value("wakePhrases")}
          disabled={saving}
          onRemove={(p) => set("wakePhrases", value("wakePhrases").filter((x) => x !== p))}
          onAdd={addPhrase}
        />
      ), { labelFor: `${id}-phrases-new`, after: afterPhrases?.(addPhrase, { draft: value("wakePhrases"), saved: effectiveValue(from, base, "wakePhrases") }) }),
    wakeMatch: () =>
      row("wakeMatch", (
        <Segmented<WakeMatch>
          name={`${id}-match`}
          label={FIELD_LABEL.wakeMatch}
          value={value("wakeMatch")}
          disabled={saving}
          options={[{ value: "close", label: "Close" }, { value: "exact", label: "Exact" }]}
          onChange={(v) => set("wakeMatch", v)}
        />
      )),
    followUpSeconds: () =>
      row("followUpSeconds", (
        <NumberInput
          id={`${id}-followUpSeconds`}
          value={value("followUpSeconds")}
          min={FOLLOW_UP_SECONDS_MIN}
          max={FOLLOW_UP_SECONDS_MAX}
          unit="seconds"
          disabled={saving}
          onChange={(n) => set("followUpSeconds", n)}
          onInvalid={(bad) => markInvalid("followUpSeconds", bad)}
        />
      ), { labelFor: `${id}-followUpSeconds` }),
    conversationIdleMinutes: () =>
      row("conversationIdleMinutes", (
        <NumberInput
          id={`${id}-conversationIdleMinutes`}
          value={value("conversationIdleMinutes")}
          min={CONVERSATION_IDLE_MINUTES_LIMITS.min}
          max={CONVERSATION_IDLE_MINUTES_LIMITS.max}
          unit="minutes quiet"
          disabled={saving}
          onChange={(n) => set("conversationIdleMinutes", n)}
          onInvalid={(bad) => markInvalid("conversationIdleMinutes", bad)}
        />
      ), { labelFor: `${id}-conversationIdleMinutes` }),
    voice: () => row("voice", <VoiceSelect id={`${id}-voice`} value={value("voice")} disabled={saving} onChange={(v) => set("voice", v)} />, { labelFor: `${id}-voice` }),
    interruptMode: () => {
      const mode = INTERRUPT_CHOICES.find((c) => c.value === value("interruptMode")) ?? INTERRUPT_CHOICES[1]
      return row("interruptMode", (
        <>
          <Segmented<InterruptMode>
            name={`${id}-interrupt`}
            label={FIELD_LABEL.interruptMode}
            value={value("interruptMode")}
            disabled={saving}
            options={INTERRUPT_CHOICES.map((c) => ({ value: c.value, label: <><span className="hidden sm:inline">{c.label}</span><span className="sm:hidden">{c.short}</span></> }))}
            onChange={(v) => set("interruptMode", v)}
          />
          <p className="text-[13px] text-ink-muted">{mode.help}</p>
        </>
      ))
    },
    captions: () => row("captions", <BoolControl label={FIELD_LABEL.captions} value={value("captions")} disabled={saving} onChange={(v) => set("captions", v)} />),
    speakReplies: () => row("speakReplies", <BoolControl label={FIELD_LABEL.speakReplies} value={value("speakReplies")} disabled={saving} onChange={(v) => set("speakReplies", v)} />),
    echoCancellation: () => row("echoCancellation", <BoolControl label={FIELD_LABEL.echoCancellation} value={value("echoCancellation")} disabled={saving} onChange={(v) => set("echoCancellation", v)} />),
    noiseSuppression: () => row("noiseSuppression", <BoolControl label={FIELD_LABEL.noiseSuppression} value={value("noiseSuppression")} disabled={saving} onChange={(v) => set("noiseSuppression", v)} />),
    autoGainControl: () => row("autoGainControl", <BoolControl label={FIELD_LABEL.autoGainControl} value={value("autoGainControl")} disabled={saving} onChange={(v) => set("autoGainControl", v)} />),
    outputPath: () =>
      row("outputPath", (
        <Segmented<OutputPath>
          name={`${id}-output`}
          label={FIELD_LABEL.outputPath}
          value={value("outputPath")}
          disabled={saving}
          options={[{ value: "direct", label: "Direct" }, { value: "element", label: "Media element" }]}
          onChange={(v) => set("outputPath", v)}
        />
      )),
    prebufferMs: () =>
      row("prebufferMs", (
        <div className="flex items-center gap-3">
          <input
            id={`${id}-prebufferMs`}
            type="range"
            min={PREBUFFER_MS_MIN}
            max={PREBUFFER_MS_MAX}
            step={10}
            value={value("prebufferMs")}
            disabled={saving}
            onChange={(e) => set("prebufferMs", Number(e.target.value))}
            className="h-11 min-w-0 flex-1 accent-[var(--color-you)]"
          />
          <span className="w-16 shrink-0 text-right font-mono text-[13px] tabular-nums text-ink">{value("prebufferMs")} ms</span>
        </div>
      ), { labelFor: `${id}-prebufferMs` })
  }

  const groups = PROFILE_GROUPS.map((g) => ({ ...g, fields: g.fields.filter((f) => shown.has(f)) })).filter((g) => g.fields.length > 0)
  const activationOff = value("activation") === "always"
  return (
    <div className="flex flex-1 flex-col" data-testid={`profile-${id}`}>
      <div key={generation} className="flex flex-1 flex-col gap-8 pb-8">
        <div className="-mb-4"><MarkerLegend device={showInherited} /></div>
        {stale && dirty && (
          <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-muted">
            Changed somewhere else meanwhile.
            <button type="button" className="ml-auto text-voice hover:underline" onClick={cancel}>Load latest</button>
          </div>
        )}
        {groups.map((g) => {
          const wakeOnly: ReadonlyArray<ProfileField> = g.id === "activation" && activationOff ? g.fields.filter((f) => f !== "activation") : []
          const body = (
            <div className="flex flex-col gap-6">
              {g.fields.filter((f) => !wakeOnly.includes(f)).map((f) => controls[f]())}
              {wakeOnly.length > 0 && (
                // Always listening: phrases, matching and follow-up do not apply; folded away, still editable.
                <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-4" data-testid="wake-settings-folded">
                  <summary className="flex min-h-10 max-sm:min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] text-ink-muted marker:hidden hover:text-ink">
                    <Icon name="chevron" size={14} className="shrink-0 transition-transform duration-[120ms] group-open:rotate-90" />
                    Phrases, matching and follow-up: used only in wake-phrase mode
                  </summary>
                  <div className="mt-4 flex flex-col gap-6">{wakeOnly.map((f) => controls[f]())}</div>
                </details>
              )}
            </div>
          )
          return g.advanced === true ? (
            <details key={g.id} className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-4" data-group={g.id}>
              <summary className="label flex min-h-10 max-sm:min-h-11 cursor-pointer list-none items-center gap-1.5 text-ink-muted marker:hidden hover:text-ink">
                <Icon name="chevron" size={14} className="transition-transform duration-[120ms] group-open:rotate-90" />
                {g.title}
              </summary>
              <div className="mt-4">{body}</div>
            </details>
          ) : (
            <section key={g.id} className="flex flex-col gap-4" aria-labelledby={`${id}-group-${g.id}`} data-group={g.id}>
              {!headingOf.has(g.fields[0]!) && <h4 id={`${id}-group-${g.id}`} className="label text-ink-faint">{g.title}</h4>}
              {body}
            </section>
          )
        })}
      </div>
      <FormFooter
        dirty={dirty}
        saving={saving}
        saveDisabled={!dirty || saving || invalid.size > 0}
        onSave={() => void save()}
        onCancel={cancel}
        cancelDisabled={!ownEditing || saving}
        note={savedNote && !editing ? "Saved. Devices pick it up at once." : invalid.size > 0 ? "Fix the marked field to save" : dirty ? "Unsaved changes" : extraDirty ? "Unsaved name" : ""}
        noteTone={savedNote && !editing ? "ok" : "muted"}
        {...(error !== undefined ? { error } : {})}
      />
    </div>
  )
}

/** The title of the group a field is in (a field named like its group shows no visible label of its own). */
const groupTitleOf = (field: ProfileField) => PROFILE_GROUPS.find((g) => g.fields.includes(field))?.title

/**
 * Label, the markers ("Unsaved" for an edit; "Custom" on the kind page or "Override" on a device page for a saved
 * value that differs from what it inherits; Reset, saying what it returns to) or "Default (…)" on a device page, the
 * control, and the help line. A field named like its group ("Voice" in VOICE) keeps its label for assistive
 * technology only.
 */
function FieldShell({ field, formId, labelFor, overridden, unsaved, custom, sameAsDefault, heading, inherited, showInherited, onReset, disabled, mode, labelHidden, children }: {
  readonly field: ProfileField
  readonly mode: Activation
  readonly formId: string
  readonly labelFor: string | undefined
  /** The draft has a value of its own here (Reset can take it away). */
  readonly overridden: boolean
  readonly unsaved: boolean
  readonly custom: boolean
  /** The saved value equals what the field would inherit now. */
  readonly sameAsDefault: boolean
  /** The group's heading, shown on the markers' row (the field's own label is hidden). */
  readonly heading: { readonly id: string; readonly title: string } | undefined
  readonly inherited: string
  readonly showInherited: boolean
  readonly onReset: () => void
  readonly disabled: boolean
  readonly labelHidden: boolean
  readonly children: ReactNode
}) {
  const helpLine = help(showInherited)[field] ?? (field === "activation" ? ACTIVATION_HELP[mode] : undefined)
  const labelId = `${formId}-${field}-label`
  const labelClass = cx("text-[14px] font-medium text-ink", labelHidden && "sr-only")
  const resetTo = showInherited ? `the default for this kind (${inherited})` : `the built-in default (${inherited})`
  return (
    <div className="flex flex-col gap-2" data-field={field} data-overridden={overridden ? "true" : "false"} role="group" aria-labelledby={labelId}>
      <div className={cx("flex flex-wrap items-baseline gap-x-2 gap-y-1", heading !== undefined ? "mb-2" : labelHidden && !overridden && !unsaved && !showInherited && "-mb-2")}>
        {heading !== undefined && <h4 id={heading.id} className="label text-ink-faint">{heading.title}</h4>}
        {labelFor !== undefined
          ? <label id={labelId} htmlFor={labelFor} className={labelClass}>{FIELD_LABEL[field]}</label>
          : <span id={labelId} className={labelClass}>{FIELD_LABEL[field]}</span>}
        {(overridden || unsaved || showInherited) && (
          <span className="ml-auto inline-flex items-center gap-2">
            <FieldMarkers
              unsaved={unsaved}
              saved={custom ? (showInherited ? "Override" : "Custom") : undefined}
              savedTitle={`Saved here; ${showInherited ? "the default for this kind" : "the built-in default"} is ${inherited}`}
              savedNote={showInherited && sameAsDefault ? "same as the default now" : undefined}
              reset={overridden ? { label: `Reset ${FIELD_LABEL[field]} to ${resetTo}`, onReset, disabled } : undefined}
            />
            {showInherited && !overridden && <span className="text-[12px] text-ink-faint" data-testid="inherited">Default ({inherited})</span>}
          </span>
        )}
      </div>
      {children}
      {helpLine !== undefined && <p className="text-[13px] text-ink-muted">{helpLine}</p>}
    </div>
  )
}

function BoolControl({ label, value, disabled, onChange }: { readonly label: string; readonly value: boolean; readonly disabled: boolean; readonly onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-10 items-center gap-3">
      <Switch checked={value} onChange={onChange} label={label} disabled={disabled} />
      <span className="text-[14px] text-ink-muted" aria-hidden="true">{value ? "On" : "Off"}</span>
    </div>
  )
}

function NumberInput({ id, value, min, max, unit, disabled, onChange, onInvalid }: {
  readonly id: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly unit: string
  readonly disabled: boolean
  readonly onChange: (n: number) => void
  readonly onInvalid: (bad: boolean) => void
}) {
  const [text, setText] = useState(String(value))
  const [problem, setProblem] = useState<string | undefined>()
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) {
      last.current = value
      setText(String(value))
      setProblem(undefined)
      onInvalid(false)
    }
  }, [value])
  const change = (t: string) => {
    setText(t)
    const n = Number(t)
    const bad = t.trim() === "" || !Number.isInteger(n) || n < min || n > max
    setProblem(bad ? `A whole number from ${min} to ${max}.` : undefined)
    onInvalid(bad)
    if (!bad) {
      last.current = n
      onChange(n)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          disabled={disabled}
          aria-invalid={problem !== undefined}
          aria-describedby={problem !== undefined ? `${id}-problem` : undefined}
          onChange={(e) => change(e.target.value)}
          className={cx(inputClass.replace("w-full", ""), "w-28 max-sm:h-11")}
        />
        <span className="text-[14px] text-ink-muted">{unit}</span>
      </div>
      {problem !== undefined && <p id={`${id}-problem`} role="alert" className="text-[13px] text-danger">{problem}</p>}
    </div>
  )
}

/** Voice ids are lower case ("natural"); shown capitalised, as on the voice page. */
const cap = (name: string) => (name === "" ? name : name[0]!.toUpperCase() + name.slice(1))

function VoiceSelect({ id, value, disabled, onChange }: { readonly id: string; readonly value: string; readonly disabled: boolean; readonly onChange: (v: string) => void }) {
  const voices = useClientState((s) => s.engine.voices.filter((v) => v.enabled), shallowEqual)
  const fallback = voices.find((v) => v.isDefault)
  const known = value === "" || voices.some((v) => v.name === value)
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx(inputClass, "max-sm:h-11")}>
      <option value="">Assistant default{fallback !== undefined ? ` (now ${cap(fallback.name)})` : ""}</option>
      {voices.map((v) => <option key={v.name} value={v.name}>{cap(v.name)}: {v.description}</option>)}
      {!known && <option value={value}>{value} (switched off)</option>}
    </select>
  )
}

/** The wake phrases: each with Remove (the last one cannot go), and a field to add one, checked as it is typed. */
function PhraseList({ id, phrases, disabled, onRemove, onAdd }: {
  readonly id: string
  readonly phrases: ReadonlyArray<string>
  readonly disabled: boolean
  readonly onRemove: (phrase: string) => void
  readonly onAdd: (phrase: string) => string | undefined
}) {
  const [text, setText] = useState("")
  const [problem, setProblem] = useState<string | undefined>()
  const add = () => {
    const p = onAdd(text)
    setProblem(p)
    if (p === undefined) setText("")
  }
  const full = phrases.length >= WAKE_PHRASES_MAX
  return (
    <div className="flex flex-col gap-3" data-testid="phrase-list">
      <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" aria-label="Wake phrases">
        {phrases.map((p) => (
          <li key={p} className="flex min-h-11 items-center gap-3 pl-3 pr-1" data-phrase={p}>
            <span className="min-w-0 flex-1 break-words py-2 text-[14px] text-ink" data-testid="phrase-text">{displayPhrase(p)}</span>
            <button
              type="button"
              onClick={() => onRemove(p)}
              disabled={disabled || phrases.length <= 1}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 max-sm:size-11"
              aria-label={`Remove “${p}”`}
              title={phrases.length <= 1 ? "At least one phrase is needed" : "Remove"}
            >
              <Icon name="close" size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <input
            id={`${id}-new`}
            type="text"
            value={text}
            disabled={disabled || full}
            placeholder={full ? `The list is full (${WAKE_PHRASES_MAX})` : "Add a phrase, e.g. hey geff"}
            aria-label="New wake phrase"
            aria-invalid={problem !== undefined}
            aria-describedby={problem !== undefined ? `${id}-problem` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value)
              if (problem !== undefined) setProblem(undefined)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                add()
              }
            }}
            className={cx(inputClass, "min-w-0 flex-1 max-sm:h-11")}
          />
          <Button size="md" onClick={add} disabled={disabled || full || text.trim() === ""} className="max-sm:h-11">
            <Icon name="plus" size={16} />
            Add
          </Button>
        </div>
        {problem !== undefined && <p id={`${id}-problem`} role="alert" className="text-[13px] text-danger">{problem}</p>}
      </div>
    </div>
  )
}
