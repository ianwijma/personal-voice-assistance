"use client"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { type AssistantInfo, type DeviceListInfo, type DeviceTypeInfo, type FieldError, MAX_DEVICE_NAME_CHARS, type SessionInfo } from "@pva/protocol"
import { type Outcome, quoted } from "@/lib/assistants.ts"
import {
  baseOfDevice,
  baseOfType,
  type DeviceBase,
  type DeviceDraft,
  type DeviceEdit,
  draftOnRevision,
  editDraft,
  isDirty,
  isOwn,
  noEdit,
  patchOf,
  phraseChip,
  quietLabel,
  sectionsOf,
  setKeys,
  settingsOf,
  wakesAssistant
} from "@/lib/devices.ts"
import { INTERRUPT_CHOICES, lastSeenText } from "@/lib/profileForm.ts"
import { agoText, stateWord, turnsText } from "@/lib/sessions.ts"
import { formatSettingsHash, isTypePageId, typePageId } from "@/lib/settingsTree.ts"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { inputClass } from "../../fields/types.ts"
import { Icon, Spinner } from "../../ui/Icon.tsx"
import { useDialog } from "../../ui/Panel.tsx"
import { Button, cx, Segmented, Switch } from "../../ui/controls.tsx"
import { FormFooter } from "../FormFooter.tsx"
import { PhraseTester } from "../PhraseTester.tsx"
import { Dialog, DialogButtons } from "./assistants/parts.tsx"
import { AssignSection, MarksFor, type SectionContext } from "./devices/AssignSection.tsx"
import { LookSection, LookVoiceLine, VoiceSection } from "./devices/LookVoiceSections.tsx"
import { Chip, DField, Pill } from "./devices/parts.tsx"

/** The time, ticking every 30 s, for "Seen 5 min ago". */
const useNow = () => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000) // continuation(none): only the clock
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * Whether a device is talking now (one of its tabs owns its session's audio), from its voice session; a server that
 * lists no sessions falls back to the device's `audioOwner`.
 */
const talkingOf = (d: DeviceListInfo, session: SessionInfo | undefined): boolean => (session === undefined ? d.audioOwner : session.ownerPresent)

/** How many sections a device has its own value for (the list and "who answers without a phrase" are one section). */
const ownSections = (d: Pick<DeviceListInfo, "own">): number => {
  const own = d.own as Record<string, unknown>
  return ["assistants|withoutPhrase", "matching", "voicePage", "look", "voice", "interruptMode", "audio", "captions"].filter((s) => s.split("|").some((k) => own[k] !== undefined)).length
}

/**
 * The server's `canAuto` (WP-14): the routing section is switched on and has a key. A server without that section:
 * a running decision module (the older rule). The page that sets it up exists only on a server that has Routing.
 */
const useCanAuto = () =>
  useClientState((s) => {
    const routing = s.sections.find((x) => x.id === "routing")
    if (routing !== undefined) return routing.form.values.TYPESAFE_ROUTING === true && routing.form.secrets.TYPESAFE_API_KEY?.set === true
    return Object.values(s.modules.byId).some((m) => m.kind === "decider" && m.state === "running")
  })
const useHasRouting = () => useClientState((s) => s.sections.some((x) => x.id === "routing") || Object.values(s.modules.byId).some((m) => m.kind === "decider"))

// ---- Devices › All devices

function Row({ d, type, defaults, assistants, session, now }: {
  readonly d: { readonly id?: string; readonly name: string; readonly settings: DeviceListInfo["settings"]; readonly own?: DeviceListInfo["own"] }
  readonly type: DeviceTypeInfo
  readonly defaults: boolean
  readonly assistants: ReadonlyArray<AssistantInfo>
  readonly session: SessionInfo | undefined
  readonly now: number
}) {
  const client = useClient()
  const devices = useClientState((s) => s.devices)
  const talking = !defaults && session?.ownerPresent === true
  const settings = d.settings
  const chips = settings.assistants.map((e) => {
    const a = assistants.find((x) => x.id === e.assistant)
    const without = settings.withoutPhrase.mode === "assistant" && settings.withoutPhrase.assistant === e.assistant
    const text = without ? "without a phrase" : phraseChip(e)
    return { id: e.assistant, name: a?.name ?? e.assistant, text }
  })
  const members = devices.filter((x) => x.kind === type.kind)
  const own = d.own === undefined ? 0 : ownSections({ own: d.own })
  const meta = defaults
    ? [`Applies to ${members.length} ${members.length === 1 ? type.one : type.many}`, "Each follows it unless it has its own value"]
    : [own > 0 ? `${own} own setting${own === 1 ? "" : "s"}` : "Follows the defaults", ...(d.id !== undefined ? [lastSeenText(devices.find((x) => x.id === d.id) ?? { lastSeen: 0, connections: 0 }, now)] : [])]
  if (settings.withoutPhrase.mode === "typesafe") meta.unshift("Without a phrase: TypeSafe decides")
  const connected = !defaults && (devices.find((x) => x.id === d.id)?.connections ?? 0) > 0
  const speaker = talking && session?.state === "speaking" ? assistants.find((a) => a.id === session.answering)?.name : undefined
  return (
    <li>
      <button
        type="button"
        onClick={() => client.settings(["devices", defaults ? typePageId(type.kind) : d.id!])}
        className="flex min-h-16 w-full items-start gap-3 px-3 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2/60"
        data-device={defaults ? `type:${type.kind}` : d.id}
      >
        <span className={cx("inline-flex size-9 shrink-0 items-center justify-center rounded-full border", connected ? "border-ok/50 text-ok" : "border-line text-ink-faint")} aria-hidden="true">
          <Icon name="device" size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-[14px] text-ink">{d.name}</span>
            {defaults && <Chip testId="defaults-chip">Defaults</Chip>}
            {talking && <Chip tone="you" testId="talking-now">Talking now</Chip>}
            {talking && session !== undefined && <span className="text-[12px] text-ink-muted" data-testid="session-state">{speaker !== undefined ? `${speaker} speaking` : stateWord(session.state)}</span>}
          </span>
          <span className="my-1 flex flex-wrap gap-1.5" data-testid="device-chips">
            {chips.length === 0 && <span className="text-[12px] text-warn">No assistant: nobody answers</span>}
            {chips.map((c) => (
              <Pill key={c.id}>{c.name} · {c.text !== undefined ? c.text : <span className="text-warn">no phrase</span>}</Pill>
            ))}
          </span>
          <span className="block text-[12px] text-ink-faint" data-testid="device-meta">{meta.join(" · ")}</span>
          <LookVoiceLine settings={settings} own={d.own} defaults={defaults} />
        </span>
        <Icon name="chevron" size={16} className="mt-2 shrink-0 text-ink-faint" />
      </button>
    </li>
  )
}

/** Devices › All devices: each type with its defaults first, then its devices; who answers on each, and how. */
export function DevicesPage() {
  const types = useClientState((s) => s.deviceTypes)
  const devices = useClientState((s) => s.devices)
  const sessions = useClientState((s) => s.sessions)
  const assistants = useClientState((s) => s.assistants)
  const now = useNow()
  return (
    <div className="flex flex-col gap-8" data-testid="device-list">
      {types.map((t) => {
        const members = devices.filter((d) => d.kind === t.kind)
        return (
          <section key={t.kind} data-testid={`device-type-${t.kind}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h4 className="label text-ink-faint">{t.title}</h4>
              <span className="font-mono text-[12px] text-ink-faint" data-testid="type-count">{members.length} {members.length === 1 ? t.one : t.many}</span>
            </div>
            <p className="mb-3 text-[13px] text-ink-muted">{t.description}</p>
            <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
              <Row d={{ name: `Every ${t.one}`, settings: t.settings }} type={t} defaults assistants={assistants} session={undefined} now={now} />
              {members.map((d) => <Row key={d.id} d={d} type={t} defaults={false} assistants={assistants} session={sessions.find((x) => x.deviceId === d.id)} now={now} />)}
            </ul>
            {members.length === 0 && (
              <div className="mt-3 flex flex-col items-start gap-1 rounded-md border border-dashed border-line px-4 py-4" data-testid="no-devices">
                <p className="text-[14px] text-ink">No devices yet.</p>
                <p className="text-[13px] text-ink-muted">Open the voice assistant on a phone, tablet or computer: it appears here the first time it connects.</p>
              </div>
            )}
          </section>
        )
      })}
      <p className="text-[13px] text-ink-muted">
        Assistants are made under <a href={formatSettingsHash(["assistants"])} className="text-voice underline-offset-4 hover:underline">Assistants</a>. Here you only choose which ones answer on each device.
      </p>
    </div>
  )
}

// ---- Device and defaults pages

/** Devices › device, or the defaults of a type (`type.web-voice`): a device page, with Own value · Reset per section. */
export function DevicePage() {
  const client = useClient()
  const id = useClientState((s) => s.ui.settingsPath[1])
  const types = useClientState((s) => s.deviceTypes)
  const device = useClientState((s) => s.devices.find((d) => d.id === id), shallowEqual)
  const type = isTypePageId(id) ? types.find((t) => typePageId(t.kind) === id) : types.find((t) => t.kind === device?.kind)
  if (type === undefined || (device === undefined && !isTypePageId(id))) {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="unknown-device">
        <p className="text-[14px] text-ink-muted">This device is not known (any more).</p>
        <Button onClick={() => client.settings(["devices"], { discard: true })}>All devices</Button>
      </div>
    )
  }
  return <DeviceEditor key={id} type={type} device={isTypePageId(id) ? undefined : device} />
}

const SECTION_HELP = {
  matching: {
    close: "Close accepts small differences in longer words (“hey jeffs”, “hey geff”). Add a phrase for anything else.",
    exact: "Exact: only the phrases as written. Add a phrase for every way it is said."
  }
} as const

function DeviceEditor({ type, device }: { readonly type: DeviceTypeInfo; readonly device: DeviceListInfo | undefined }) {
  const client = useClient()
  const assistants = useClientState((s) => s.assistants)
  const devices = useClientState((s) => s.devices)
  const session = useClientState((s) => (device === undefined ? undefined : s.sessions.find((x) => x.deviceId === device.id)), shallowEqual)
  const canAuto = useCanAuto()
  const hasRouting = useHasRouting()
  const memberCount = useClientState((s) => s.devices.filter((d) => d.kind === type.kind).length)
  const now = useNow()
  const isType = device === undefined
  const base: DeviceBase = device === undefined ? baseOfType(type) : baseOfDevice(device, type)
  const rev = device === undefined ? type.rev : device.rev
  const savedName = device?.name

  // The edits, the revision they started from, and what the last save said.
  const [state, setState] = useState<DeviceDraft>({ edit: noEdit, rev })
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  /** The edits of the last save that went through, until its revision arrives. */
  const [acked, setAcked] = useState<DeviceEdit | undefined>()
  /** Bumped when the draft is discarded or a section reset: the number fields start again (their text and errors). */
  const [generation, setGeneration] = useState(0)
  /** Bumped when the draft is discarded, a section reset or a save sent: an edit still on its way (a character loading) is dropped. */
  const [epoch, setEpoch] = useState(0)
  const revNow = useRef(rev)
  /**
   * Set while a save is on its way: the editor is inert and `update` ignores changes (they would not be in the save).
   * A save that went through is over only when the revision it made (`awaitRev`) has reached the base: an edit made
   * between the answer and that push would be judged against the old base and lost (PR #35 review 8).
   */
  const savingNow = useRef(false)
  const awaitRev = useRef<number | undefined>(undefined)
  /** The edits of that save, while its revision is awaited (as `acked`, which a render may not have picked up yet). */
  const awaitEdit = useRef<DeviceEdit | undefined>(undefined)
  /** A new connection while the revision is awaited: the next list it brings is the server's word (saved or not). */
  const reconnected = useRef(false)
  const saveOver = () => {
    savingNow.current = false
    awaitRev.current = undefined
    awaitEdit.current = undefined
    reconnected.current = false
    setSaving(false)
  }
  const connectionId = useClientState((s) => s.connection.connectionId)
  const list = useClientState((s) => (device === undefined ? s.deviceTypes : s.devices))
  const [justSaved, setJustSaved] = useState(false)
  const [errors, setErrors] = useState<ReadonlyArray<FieldError>>([])
  const [message, setMessage] = useState<string | undefined>()
  const [warnings, setWarnings] = useState<ReadonlyArray<FieldError>>([])
  const edit = state.edit
  const dirty = edit !== acked && isDirty(base, edit, savedName)
  const behind = dirty && state.rev !== rev

  // A new version from the server: a clean draft follows it (the edits of a save that went through are dropped, later ones kept).
  useEffect(() => {
    revNow.current = rev
    const sent = acked ?? awaitEdit.current
    setState((s) => draftOnRevision(s, rev, base, savedName, sent))
    setAcked(undefined)
    // The saved revision (or a later one, which contains it) is the base now: the editor is free again.
    if (awaitRev.current !== undefined && rev >= awaitRev.current) saveOver()
  }, [rev]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (awaitRev.current !== undefined) reconnected.current = true
  }, [connectionId])
  // The first list after a reconnect: had the save been applied, its revision would be in it (handled above); it was
  // not, so the draft is unsaved edits again.
  useEffect(() => {
    if (!reconnected.current || awaitRev.current === undefined) return
    saveOver()
    setAcked(undefined)
  }, [list]) // eslint-disable-line react-hooks/exhaustive-deps

  const discard = () => {
    setState({ edit: noEdit, rev })
    setGeneration((g) => g + 1)
    setEpoch((g) => g + 1)
  }
  const update = useCallback((f: (e: DeviceEdit) => DeviceEdit) => {
    setJustSaved(false)
    setErrors([])
    setMessage(undefined)
    const busy = savingNow.current
    setState((s) => editDraft(s, f, rev, busy))
  }, [rev])
  const setBlockedId = useCallback((key: string, on: boolean) => {
    setBlocked((s) => {
      if (s.has(key) === on) return s
      const next = new Set(s)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  // The settings screen asks "Leave without saving?" while this is set.
  useEffect(() => {
    if (client.store.get().ui.settingsDirty !== dirty) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: dirty } })
  }, [client, dirty])
  useEffect(() => () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } }), [client])

  const settings = settingsOf(base, edit)
  const defaultsName = `Every ${type.one}`
  const thisWord = isType ? `these ${type.many}` : `this ${type.one}`
  const name = edit.name ?? device?.name ?? defaultsName
  const ctx: SectionContext = { base, edit, update, settings, isType, thisWord, defaultsName, deviceName: name, setBlocked: setBlockedId, generation, epoch, renew: () => {
    setGeneration((g) => g + 1)
    setEpoch((g) => g + 1)
  } }
  const sections = sectionsOf(type)
  const has = (s: ReturnType<typeof sectionsOf>[number]) => sections.includes(s)

  const save = async (saveAnyway = false): Promise<Outcome> => {
    // The save takes the draft as shown: an edit still on its way is not in it and must not land after it.
    setEpoch((g) => g + 1)
    savingNow.current = true
    setSaving(true)
    setMessage(undefined)
    const patch = patchOf(base, edit)
    let outcome: Outcome
    try {
      // continuation(state): the draft is read again when the answer comes
      outcome = await client.saveDevice(
        device === undefined ? { kind: "type", type: type.kind } : { kind: "device", id: device.id },
        state.rev,
        patch,
        { label: name, ...(saveAnyway ? { saveAnyway: true } : {}), ...(edit.name !== undefined && edit.name.trim() !== savedName ? { name: edit.name.trim() } : {}) }
      )
    } catch {
      // A request that fails gives the editor back, with the draft as it was.
      outcome = { kind: "refused", code: "internal", message: "Could not save. Try again." }
    }
    // A save that went through waits for its revision unless it is here already; anything else is over now. Without a
    // revision in the answer (an older server) there is nothing to wait for.
    const savedRev = outcome.kind === "ok" ? outcome.rev : undefined
    if (savedRev !== undefined && revNow.current < savedRev) {
      awaitRev.current = savedRev
      awaitEdit.current = edit
    } else saveOver()
    switch (outcome.kind) {
      case "ok": {
        // Only what was sent is saved: edits made meanwhile stay. Its revision may have arrived before the answer.
        const r = revNow.current
        if (r !== state.rev) setState((s) => draftOnRevision(s, r, base, savedName, edit))
        else setAcked(edit)
        setJustSaved(true)
        setWarnings([])
        setErrors([])
        break
      }
      case "stale":
        discard()
        break
      case "invalid":
        setErrors(outcome.fieldErrors)
        setWarnings([])
        if (outcome.fieldErrors.every((e) => e.key === null)) setMessage(outcome.message)
        break
      case "warnings":
        setWarnings(outcome.warnings)
        break
      case "refused":
        setMessage(outcome.message)
        break
    }
    return outcome
  }

  const assignError = errors.filter((e) => e.key !== null && (e.key === "assistants" || e.key.startsWith("assistants.") || e.key.startsWith("withoutPhrase"))).map((e) => e.message).join(" ") || undefined
  const otherError = [message, ...errors.filter((e) => e.key === null || !(e.key === "assistants" || e.key.startsWith("assistants.") || e.key.startsWith("withoutPhrase"))).map((e) => e.message)].filter((m): m is string => m !== undefined).join(" ") || undefined
  // The server judges a line with the tested device's saved settings, not with this page's draft.
  const wakesOf = (phrase: string, testedId: string | undefined): string | undefined => {
    const tested = devices.find((d) => d.id === testedId)
    const hit = tested === undefined ? undefined : wakesAssistant(tested.settings.assistants, phrase)
    return hit === undefined ? undefined : assistants.find((a) => a.id === hit)?.name ?? hit
  }
  const allPhrases = settings.assistants.flatMap((a) => a.phrases)
  const savedPhrases = base.saved.assistants.flatMap((a) => a.phrases)
  const conv = session?.conversations ?? []
  const convText = conv.length > 0
    ? conv.map((c) => `${assistants.find((a) => a.id === c.assistantId)?.name ?? c.assistantId}: ${turnsText(c.turns)}`).join(" · ") + (session?.lastTurnAt !== null && session?.lastTurnAt !== undefined ? ` · last ${agoText(session.lastTurnAt, now)}` : "")
    : session !== undefined ? `${turnsText(session.turns)}${session.lastTurnAt !== null ? ` · last ${agoText(session.lastTurnAt, now)}` : ""}` : "No conversation open"

  return (
    <div className="flex flex-1 flex-col gap-8" data-testid="device-editor" data-target={isType ? `type:${type.kind}` : device.id} inert={saving} aria-busy={saving}>
      <p className="-mt-4 text-[14px] text-ink-muted" data-testid="device-sub">
        {isType
          ? `Applies to ${memberCount} ${memberCount === 1 ? type.one : type.many} except where one has its own value. A change reaches running devices at once.`
          : `A ${type.one}. Each section follows ${defaultsName} until you change it here.`}
      </p>
      {device !== undefined && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]" data-testid="device-facts">
            <dt className="text-ink-muted">Type</dt>
            <dd className="text-ink">{type.one.charAt(0).toUpperCase() + type.one.slice(1)}</dd>
            <dt className="text-ink-muted">Status</dt>
            <dd className="text-ink" data-testid="device-status">
              {lastSeenText(device, now)}
              {device.connections > 1 ? ` · ${device.connections} tabs` : ""}
              {talkingOf(device, session) ? ` · talking now${session !== undefined ? `, ${stateWord(session.state)}` : ""}` : ""}
            </dd>
            <dt className="text-ink-muted">Conversations</dt>
            <dd className="text-ink" data-testid="device-conversation">{convText}</dd>
            <dt className="text-ink-muted">First seen</dt>
            <dd className="text-ink">{new Date(device.firstSeen).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</dd>
          </dl>
          <DField testId="name" label="Name" htmlFor="device-name" help="Shown here, in Diagnostics and in the header while this device has the audio." markers={edit.name !== undefined && edit.name.trim() !== device.name ? <span className="label ml-auto text-[11px] text-voice" data-testid="unsaved-marker">Unsaved</span> : undefined}>
            <input
              id="device-name"
              value={edit.name ?? device.name}
              maxLength={MAX_DEVICE_NAME_CHARS}
              onChange={(e) => update((x) => ({ ...x, name: e.target.value }))}
              aria-invalid={edit.name !== undefined && edit.name.trim() === "" ? true : undefined}
              className={inputClass}
            />
          </DField>
          <p className="-mt-4 text-[13px] text-ink-muted" data-testid="own-legend">Own value: set for this device only. Reset returns to {defaultsName}.</p>
        </>
      )}
      {behind && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-muted" data-testid="behind">
          Changed somewhere else since you started.
          <button type="button" className="ml-auto text-voice hover:underline" onClick={discard}>Load latest</button>
        </div>
      )}
      {has("assign") && <AssignSection ctx={ctx} assistants={assistants} canAuto={canAuto} hasRouting={hasRouting} serverError={assignError} />}
      {has("phrases") && (
        <section className="flex flex-col gap-5" aria-labelledby="h-phrases" data-testid="section-phrases">
          <div className="flex items-baseline gap-2">
            <h3 id="h-phrases" className="label text-ink-faint">Phrases</h3>
            <MarksFor ctx={ctx} section="phrases" title="Phrases" />
          </div>
          <DField label="Matching" help={SECTION_HELP.matching[settings.matching]}>
            <Segmented name="matching" label="Matching" value={settings.matching} onChange={(v) => update((e) => setKeys(base, e, { matching: v }))} options={[{ value: "close", label: "Close" }, { value: "exact", label: "Exact" }]} testId="seg-matching" />
          </DField>
          <PhraseTester {...(device !== undefined ? { deviceId: device.id, deviceName: device.name } : {})} phrases={allPhrases} savedPhrases={savedPhrases} wakes={wakesOf} />
        </section>
      )}
      {has("voicePage") && (
        <section className="flex flex-col gap-5" aria-labelledby="h-vp" data-testid="section-voicePage">
          <div className="flex items-baseline gap-2">
            <h3 id="h-vp" className="label text-ink-faint">On the voice page</h3>
            <MarksFor ctx={ctx} section="voicePage" title="On the voice page" />
          </div>
          <DField label="Let people pick the assistant on the device" help="Shows the assistant’s name at the top of the voice page as a menu. Picking one there makes it the one that answers without a phrase on that device.">
            <Toggle label="Let people pick the assistant on the device" checked={settings.voicePage.pick} onChange={(v) => update((e) => setKeys(base, e, { voicePage: { pick: v } }))} />
          </DField>
        </section>
      )}
      {has("look") && <LookSection ctx={ctx} assistants={assistants} />}
      {has("voice") && <VoiceSection ctx={ctx} assistants={assistants} />}
      <section className="flex flex-col gap-3" aria-labelledby="h-other" data-testid="section-other">
        <h3 id="h-other" className="label text-ink-faint">Other device settings</h3>
        {has("interrupting") && (
          <Group title="Interrupting" ctx={ctx} section="interrupting">
            <DField help={INTERRUPT_CHOICES.find((c) => c.value === settings.interruptMode)?.help}>
              <Segmented
                name="interrupt"
                label="Interrupting"
                value={settings.interruptMode}
                onChange={(v) => update((e) => setKeys(base, e, { interruptMode: v }))}
                options={INTERRUPT_CHOICES.map((c) => ({ value: c.value, label: <><span className="sm:hidden">{c.short}</span><span className="max-sm:hidden">{c.label}</span></> }))}
                testId="seg-interrupt"
              />
            </DField>
          </Group>
        )}
        <Group title="Conversation" ctx={ctx} section={undefined}>
          <p className="text-[13px] text-ink-muted" data-testid="conversation-help">
            Each assistant keeps its own conversation on {thisWord}. When a fresh one starts is set on each assistant:{" "}
            {settings.assistants.length === 0 ? "no assistant here yet" : settings.assistants.map((e, i) => {
              const a = assistants.find((x) => x.id === e.assistant)
              return (
                <span key={e.assistant}>
                  {i > 0 && ", "}
                  {a?.name ?? e.assistant} {a !== undefined ? quietLabel(a.newConversationAfter) : ""} (<a className="text-voice underline-offset-4 hover:underline" href={formatSettingsHash(["assistants", e.assistant, "behaviour"])}>Behaviour</a>)
                </span>
              )
            })}.
          </p>
        </Group>
        {has("audio") && (
          <Group title="Audio" ctx={ctx} section="audio">
            <DField label="Echo cancellation" help="Removes the assistant’s own voice from the microphone. On iPhone it also changes your voice’s level and can make playback crackle.">
              <Toggle label="Echo cancellation" checked={settings.audio.echoCancellation} onChange={(v) => update((e) => setKeys(base, e, { audio: { ...settings.audio, echoCancellation: v } }))} />
            </DField>
            <DField label="Noise suppression" help="Filters steady background noise. It can blur quiet words.">
              <Toggle label="Noise suppression" checked={settings.audio.noiseSuppression} onChange={(v) => update((e) => setKeys(base, e, { audio: { ...settings.audio, noiseSuppression: v } }))} />
            </DField>
            <DField label="Automatic gain" help="Lets the browser adjust the microphone level.">
              <Toggle label="Automatic gain" checked={settings.audio.autoGainControl} onChange={(v) => update((e) => setKeys(base, e, { audio: { ...settings.audio, autoGainControl: v } }))} />
            </DField>
            <DField label="Speak replies aloud" help="Off: replies are shown as text only. The voice is set on each assistant.">
              <Toggle label="Speak replies aloud" checked={settings.audio.speakAloud} onChange={(v) => update((e) => setKeys(base, e, { audio: { ...settings.audio, speakAloud: v } }))} />
            </DField>
          </Group>
        )}
        {has("captions") && (
          <Group title="Captions" ctx={ctx} section="captions">
            <DField label="Captions" help="Show what you say and what the assistant says under the line.">
              <Toggle label="Captions" checked={settings.captions.captions} onChange={(v) => update((e) => setKeys(base, e, { captions: { ...settings.captions, captions: v } }))} />
            </DField>
            <DField label="Speak replies to typed messages" help={`Replies to typed messages are spoken too, when ${thisWord} ${isType ? "have" : "has"} the audio.`}>
              <Toggle label="Speak replies to typed messages" checked={settings.captions.speakTyped} onChange={(v) => update((e) => setKeys(base, e, { captions: { ...settings.captions, speakTyped: v } }))} />
            </DField>
          </Group>
        )}
      </section>
      {device !== undefined && <Forget device={device} />}
      <FormFooter
        dirty={dirty}
        saving={saving}
        saveDisabled={!dirty || saving || blocked.size > 0 || (edit.name !== undefined && edit.name.trim() === "")}
        onSave={() => void save()}
        onCancel={() => {
          discard()
          setErrors([])
          setMessage(undefined)
        }}
        cancelDisabled={!dirty || saving}
        note={saving ? "Saving…" : justSaved && !dirty ? "Saved. Applies at once." : dirty ? "Unsaved changes" : ""}
        noteTone={justSaved && !dirty ? "ok" : "muted"}
        {...(otherError !== undefined ? { error: otherError } : {})}
      />
      {warnings.length > 0 && (
        <SaveAnywayDialog
          warnings={warnings}
          busy={saving}
          onBack={() => setWarnings([])}
          onConfirm={() => void save(true)}
        />
      )}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onChange={onChange} label={label} />
      <span className="text-[14px] text-ink">{checked ? "On" : "Off"}</span>
    </div>
  )
}

/** One of "Other device settings": closed by default, with the marks of its section. */
function Group({ title, ctx, section, children }: {
  readonly title: string
  readonly ctx: SectionContext
  readonly section: Parameters<typeof isOwn>[2] | undefined
  readonly children: ReactNode
}) {
  return (
    <details className="group rounded-md border border-line/70 px-3 py-2 [&[open]]:pb-4" data-testid={`group-${title.toLowerCase()}`}>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[14px] text-ink-muted marker:hidden hover:text-ink max-sm:min-h-11">
        <Icon name="chevron" size={14} className="shrink-0 transition-transform duration-[120ms] group-open:rotate-90" />
        {title}
        {section !== undefined ? <MarksFor ctx={ctx} section={section} title={title} /> : <span className="ml-auto text-[12px] text-ink-faint">Set on each assistant</span>}
      </summary>
      <div className="mt-4 flex flex-col gap-5">{children}</div>
    </details>
  )
}

/** The unreachable-assistant warning: the save works, but looks like a mistake; Save anyway sends it again with `saveAnyway`. */
function SaveAnywayDialog({ warnings, busy, onBack, onConfirm }: {
  readonly warnings: ReadonlyArray<FieldError>
  readonly busy: boolean
  readonly onBack: () => void
  readonly onConfirm: () => void
}) {
  return (
    <Dialog title="Save anyway?" onClose={onBack} testId="warnings-dialog" labelId="warnings-dialog-title" wide>
      <div className="mt-1 flex flex-col gap-2 text-[14px] text-ink-muted" data-testid="warnings-list">
        {warnings.map((w, i) => <p key={i}>{w.message}</p>)}
      </div>
      <DialogButtons cancel="Go back" confirm="Save anyway" busy={busy} onCancel={onBack} onConfirm={onConfirm} />
    </Dialog>
  )
}

function Forget({ device }: { readonly device: DeviceListInfo }) {
  const client = useClient()
  const [asking, setAsking] = useState(false)
  return (
    <section className="flex flex-col items-start gap-2 border-t border-line/60 pt-6" aria-labelledby="forget-title">
      <h4 id="forget-title" className="label text-ink-faint">Forget</h4>
      <p className="text-[13px] text-ink-muted">
        Removes this device, its own settings and its conversations.{device.connections > 0 ? " It is connected now, so it comes back at once as a new device with the defaults." : " If it connects again, it comes back with the defaults."}
      </p>
      <Button variant="danger" className="max-sm:h-11" onClick={() => setAsking(true)} data-testid="forget">Forget this device…</Button>
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
        <p id="forget-dialog-text" className="mt-1 text-[14px] text-ink-muted">Its name, own settings and conversations are removed. This cannot be undone.</p>
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

