"use client"
import { type ReactNode, useState } from "react"
import {
  type AssistantInfo,
  type DeviceListInfo,
  type DeviceTypeInfo,
  evaluateCondition,
  hearerOf,
  type ModuleInfo,
  type SettingField,
  type SettingValue
} from "@pva/protocol"
import {
  accountInfo,
  accountState,
  errorsFor,
  hearingModelNames,
  listJoin,
  plural,
  targetName
} from "@/lib/assistants.ts"
import { displayValue } from "../../FieldRow.tsx"
import { formatSettingsHash, type SettingsPath } from "@/lib/settingsTree.ts"
import { parseKey } from "@/lib/voicePicker.ts"
import { rendererFor } from "@/ui/fieldRenderers.ts"
import { useClientState } from "../../../context.tsx"
import { VoicePicker } from "../../../voices/VoicePicker.tsx"
import { useCatalogState } from "../../../voices/useVoiceCatalog.ts"
import { LlmModelPicker, SttModelPicker } from "../../../pickers/ModelPickers.tsx"
import { Icon } from "../../../ui/Icon.tsx"
import { Button, cx } from "../../../ui/controls.tsx"
import {
  AField,
  Disclosure,
  Group,
  idOfPath,
  NumberControl,
  PresetControl,
  SegControl,
  SelectControl,
  SwitchControl,
  TextControl
} from "./parts.tsx"
import type { AssistantDraft } from "./useAssistantDraft.ts"

/** The seven tabs of an assistant (docs/ASSISTANTS.md §7.1, mock-up `admin.html`). Each reads and edits the one draft. */

export interface TabProps {
  readonly draft: AssistantDraft
  readonly info: AssistantInfo
}

/** A link into another settings page; the hash change takes the "Leave without saving?" guard like any navigation. */
export function SettingsLink({ path, children }: { readonly path: SettingsPath; readonly children: ReactNode }) {
  return <a href={formatSettingsHash(path)} className="text-voice underline-offset-4 hover:underline">{children}</a>
}

const modulesOf = (modules: ReadonlyArray<ModuleInfo>) => modules.filter((m) => m.kind === undefined || m.kind === "capability")

// ---- Basics

export function BasicsTab({ draft, info, onDuplicate, onDelete }: TabProps & { readonly onDuplicate: () => void; readonly onDelete: () => void }) {
  const a = draft.current
  const places = info.usedOn.length
  return (
    <>
      <AField label="Name" path="name" draft={draft} htmlFor={idOfPath("name")} help="Shown in lists, in Diagnostics and on the voice page.">
        <TextControl draft={draft} path="name" max={32} label="Name" />
      </AField>
      <AField label="Purpose" path="purpose" draft={draft} htmlFor={idOfPath("purpose")} help="One line, shown in lists and when people pick an assistant on the voice page.">
        <TextControl draft={draft} path="purpose" max={80} label="Purpose" placeholder="One line: what it is for" />
      </AField>
      <AField
        label="Handles"
        path="handles"
        draft={draft}
        htmlFor={idOfPath("handles")}
        help="Used when a device lets TypeSafe decide who a sentence is for. Describe what it is for, not which words to listen for."
      >
        <TextControl draft={draft} path="handles" max={240} label="Handles" multiline rows={2} placeholder="One or two sentences: when this assistant should be chosen" />
      </AField>
      <AField
        label="Switched on"
        path="on"
        draft={draft}
        help={a.on ? "On: it answers on the devices it is assigned to." : "Off: it cannot answer anywhere. Devices keep its phrases, and it answers again when switched back on."}
      >
        <SwitchControl draft={draft} path="on" label="Switched on" />
      </AField>
      <section className="flex flex-col gap-1.5 border-t border-line/60 pt-5" aria-labelledby="dup-title">
        <h3 id="dup-title" className="label text-ink-faint">Duplicate</h3>
        <p className="text-[13px] text-ink-muted">Starts a new assistant with these settings. Devices and phrases are not copied.</p>
        <div className="pt-1">
          <Button className="max-sm:h-11" onClick={onDuplicate} data-testid="duplicate">
            <Icon name="copy" size={16} />
            Duplicate…
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-1.5" aria-labelledby="del-title">
        <h3 id="del-title" className="label text-ink-faint">Delete</h3>
        <p className="text-[13px] text-ink-muted">
          Removes {info.name} and its conversations{places > 0 ? `, and takes it off ${plural(places, "device entry", "device entries")}` : ""}. This cannot be undone.
        </p>
        <div className="pt-1">
          <Button variant="danger" className="max-sm:h-11" onClick={onDelete} data-testid="delete">Delete {info.name}…</Button>
        </div>
      </section>
    </>
  )
}

// ---- Behaviour

const FOLLOW_UP = [[0, "Off: one answer per phrase"], [5, "5 seconds"], [8, "8 seconds"], [15, "15 seconds"], [30, "30 seconds"]] as const
const QUIET = [["never", "Never: one continuous conversation"], [5, "After 5 minutes quiet"], [10, "After 10 minutes quiet"], [15, "After 15 minutes quiet"], [30, "After 30 minutes quiet"], [60, "After 1 hour quiet"]] as const

export function BehaviourTab({ draft }: TabProps) {
  const a = draft.current
  const modules = useClientState((s) => s.modules)
  const name = a.name === "" ? "this assistant" : a.name
  const onModules = modulesOf(modules.order.map((id) => modules.byId[id]!)).filter((m) => a.modules[m.id]?.on === true)
  const promptErrors = draft.errors.some((e) => e.key === "prompt")
  return (
    <>
      <AField label="System prompt" path="prompt" draft={draft} htmlFor={idOfPath("prompt")}>
        <TextControl draft={draft} path="prompt" max={4000} label="System prompt" multiline rows={6} />
        <div className="flex items-baseline gap-3">
          <p className="text-[13px] text-ink-muted">The home, the date and each module's own instructions are added for you.</p>
          <span className={cx("ml-auto shrink-0 font-mono text-[12px]", promptErrors ? "text-danger" : "text-ink-faint")} data-testid="prompt-count">{a.prompt.length} / 4000</span>
        </div>
        <Disclosure title="See the full prompt" testId="full-prompt">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2/60 p-3 font-mono text-[12px] leading-5 text-ink">
            {a.prompt}
            {"\n\n"}
            <span className="text-ink-muted">
              Added when {name} answers: the home (Shared settings), the date and time{onModules.length > 0 ? `, and the instructions of ${listJoin(onModules.map((m) => m.name))}` : ""}.
            </span>
          </pre>
        </Disclosure>
        <p className="text-[13px] text-ink-muted">Instructions for the language model. Applies from the next turn.</p>
      </AField>
      <AField label="Tool rounds per turn" path="toolRounds" draft={draft} htmlFor={idOfPath("toolRounds")} help="How often the model may use its tools before it must answer. Lower answers sooner. 0 = no tools. Default 5.">
        <NumberControl draft={draft} path="toolRounds" min={0} max={10} unit="rounds" label="Tool rounds per turn" />
      </AField>
      <AField
        label="Keep listening after a reply"
        path="followUpSeconds"
        draft={draft}
        htmlFor={idOfPath("followUpSeconds")}
        help={`Within this time the next thing you say goes to ${name} without the phrase. Off: one answer per phrase. A device can set its own time for ${a.name === "" ? "it" : a.name}, and the device wins.`}
      >
        <PresetControl draft={draft} path="followUpSeconds" presets={FOLLOW_UP} unit="seconds" min={1} max={120} customDefault={10} label="Keep listening after a reply" />
      </AField>
      <AField
        label="New conversation after a quiet spell"
        path="newConversationAfter"
        draft={draft}
        htmlFor={idOfPath("newConversationAfter")}
        help={
          (a.newConversationAfter === "never"
            ? `Never: ${a.name === "" ? "it" : a.name} keeps one continuous conversation.`
            : `After this long without a turn, the next thing said to ${a.name === "" ? "it" : a.name} starts a fresh conversation: it forgets the earlier one.`) +
          " Each assistant keeps its own conversation on each device. Very long conversations will later be shortened automatically; that is not built yet."
        }
      >
        <PresetControl draft={draft} path="newConversationAfter" presets={QUIET} unit="minutes quiet" min={1} max={1440} customDefault={20} label="New conversation after a quiet spell" />
      </AField>
      <AField label="Start replying before I finish speaking" path="replyEarly" draft={draft} help="Faster, but a reply may be thrown away when you carry on.">
        <SwitchControl draft={draft} path="replyEarly" label="Start replying before I finish speaking" />
      </AField>
      <AField label="Ask before acting" path="confirmActions" draft={draft} help="Not available yet.">
        <SegControl draft={draft} path="confirmActions" label="Ask before acting" disabled options={[{ value: "off", label: "Off" }, { value: "some", label: "For actions that say so" }]} />
      </AField>
    </>
  )
}

// ---- Language model

/** The language model picker and effort: the essentials of the language model (the wizard shows only these). */
export function ModelFields({ draft }: { readonly draft: AssistantDraft }) {
  const a = draft.current
  const sections = useClientState((s) => s.sections)
  const modules = useClientState((s) => s.modules)
  const info = accountInfo(a.llm.account)
  const state = accountState(a.llm.account, sections, Object.values(modules.byId))
  const name = a.name === "" ? "The assistant" : a.name
  const needsSetup = state.tone === "todo"
  // One choice sets the account and the model together (the row's `apply`); the account's own options below follow it.
  const apply = (llm: { readonly account: typeof a.llm.account; readonly model: string }) =>
    draft.update((x) => ({ ...x, llm: { ...x.llm, account: llm.account, model: llm.model } }), "llm")
  return (
    <>
      <AField
        label="Language model"
        path="llm.model"
        alsoPaths={["llm.account"]}
        draft={draft}
        htmlFor={idOfPath("llm.model")}
        implication={info.implication}
        warn={
          needsSetup
            ? <>{info.title} is not set up yet: {name} cannot answer until you add it in <SettingsLink path={state.setUp ?? ["shared", "accounts"]}>Shared settings › Language model accounts</SettingsLink>.</>
            : undefined
        }
        help={<>Pick a model of any account. Accounts are set up once, in <SettingsLink path={["shared", "accounts"]}>Shared settings › Language model accounts</SettingsLink>.</>}
      >
        <div>
          <LlmModelPicker id={idOfPath("llm.model")} account={a.llm.account} model={a.llm.model} onApply={apply} />
        </div>
      </AField>
      <AField label="Effort" path="llm.effort" draft={draft} help="Low starts replies sooner; high thinks harder first.">
        <SegControl draft={draft} path="llm.effort" label="Effort" options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} />
      </AField>
    </>
  )
}

export function ModelTab({ draft }: TabProps) {
  const a = draft.current
  return (
    <>
      <ModelFields draft={draft} />
      <AField label="Thinking" path="llm.thinking" draft={draft} help={a.llm.thinking === "adaptive" ? "Adaptive: the model thinks first when a question needs it. Those replies start later." : "Off: replies start as soon as possible."}>
        <SegControl draft={draft} path="llm.thinking" label="Thinking" options={[{ value: "off", label: "Off" }, { value: "adaptive", label: "Adaptive" }]} />
      </AField>
      <Group title="Limits">
        <AField label="Longest reply" path="llm.maxTokens" draft={draft} htmlFor={idOfPath("llm.maxTokens")} help="Replies stop at this length. Spoken replies are short; 1024 is plenty.">
          <NumberControl draft={draft} path="llm.maxTokens" min={64} max={8192} step={64} unit="tokens" label="Longest reply" />
        </AField>
        <AField label="Give up after" path="llm.giveUpMs" draft={draft} htmlFor={idOfPath("llm.giveUpMs")} help="If the first word has not arrived by then, the assistant says it could not answer. Default 5000 ms.">
          <NumberControl draft={draft} path="llm.giveUpMs" min={1000} max={60000} step={500} unit="ms" label="Give up after" />
        </AField>
        <AField label="Connect at startup" path="llm.warmUp" draft={draft} help="Opens the connection when the engines start, so the first reply is not slower.">
          <SwitchControl draft={draft} path="llm.warmUp" label="Connect at startup" />
        </AField>
      </Group>
      {a.llm.account === "claude-subscription" && (
        <Group title="Claude subscription">
          <AField label="Let it use this assistant's modules" path="llm.useModules" draft={draft} help="Off: Claude answers from its own knowledge only, and the Modules tab has no effect.">
            <SwitchControl draft={draft} path="llm.useModules" label="Let it use this assistant's modules" />
          </AField>
          <AField label="Start a fresh Claude session after" path="llm.freshSessionAfterMinutes" draft={draft} htmlFor={idOfPath("llm.freshSessionAfterMinutes")} help="A fresh session starts faster but forgets earlier turns. 0 = never.">
            <NumberControl draft={draft} path="llm.freshSessionAfterMinutes" min={0} max={1440} unit="minutes" label="Start a fresh Claude session after" />
          </AField>
        </Group>
      )}
    </>
  )
}

// ---- Hearing

const LANGUAGES = [["auto", "Automatic"], ["en", "English"], ["nl", "Dutch"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"]] as const

/** Who hears with whom, in the words of the mock-up: from `usedOn` and each device's hearer. */
function hearingNotices(label: (preset: string) => string, info: AssistantInfo, assistants: ReadonlyArray<AssistantInfo>, devices: ReadonlyArray<DeviceListInfo>, types: ReadonlyArray<DeviceTypeInfo>, mine: AssistantInfo): { readonly differs: ReadonlyArray<string>; readonly summary: string } {
  const uses: Array<string> = []
  const same: Array<string> = []
  const differs: Array<string> = []
  const sameRecogniser = (x: AssistantInfo) =>
    x.hearing.engine === mine.hearing.engine && (x.hearing.engine === "deepgram" || (x.hearing.model === mine.hearing.model && x.hearing.language === mine.hearing.language))
  const describe = (x: AssistantInfo) => (x.hearing.engine === "deepgram" ? "Deepgram" : label(x.hearing.model))
  for (const u of info.usedOn) {
    const place = targetName(u.target, devices, types)
    if (u.hears) {
      uses.push(place)
      continue
    }
    const hearerId = u.target.kind === "device"
      ? devices.find((d) => d.id === (u.target as { id: string }).id)?.hearer
      : hearerOf((types.find((t) => t.kind === (u.target as { type: string }).type)?.settings ?? { assistants: [], withoutPhrase: { mode: "nobody" } }))
    const hearer = assistants.find((x) => x.id === hearerId)
    if (hearer === undefined) continue
    if (sameRecogniser(hearer)) same.push(`${place} hears with ${hearer.name}'s recogniser, which is the same.`)
    else differs.push(`${place} hears with ${hearer.name}'s recogniser (${describe(hearer)}). ${mine.name} is set to ${describe(mine)}: that is not used on this device.`)
  }
  const parts: Array<string> = []
  if (uses.length > 0) parts.push(`Used on ${listJoin(uses)}.`)
  parts.push(...same)
  if (info.usedOn.length === 0) parts.push("Not on any device yet, so these settings are not used anywhere.")
  return { differs, summary: `${parts.join(" ")} A device hears with one recogniser: that of the assistant that answers without a phrase there, or else the first in its list.` }
}

/** The recogniser picker and the language: the essentials of hearing (the wizard shows only these). */
export function HearingFields({ draft }: { readonly draft: AssistantDraft }) {
  const a = draft.current
  const sections = useClientState((s) => s.sections)
  const isDg = a.hearing.engine === "deepgram"
  const languageField = sections.flatMap((s) => s.form.fields).find((f) => f.key === "STT_SHERPA_LANGUAGE")
  const languageOk = languageField?.visibleWhen === undefined ||
    evaluateCondition(languageField.visibleWhen, (k): SettingValue | undefined => (k === "STT_SHERPA_MODEL" ? a.hearing.model : k === "STT_PROVIDER" ? "sherpa" : undefined))
  const deepgramSet = sections.some((s) => s.form.secrets.DEEPGRAM_API_KEY?.set === true)
  // One choice sets the engine (and, for a model on this machine, the model); what follows below follows the row.
  const apply = (hearing: { readonly engine: typeof a.hearing.engine; readonly model?: string | undefined }) =>
    draft.update((x) => ({ ...x, hearing: { ...x.hearing, engine: hearing.engine, ...(hearing.model !== undefined ? { model: hearing.model } : {}) } }), "hearing")
  return (
    <>
      <AField
        label="Speech recognition model"
        path="hearing.model"
        alsoPaths={["hearing.engine"]}
        draft={draft}
        htmlFor={idOfPath("hearing.model")}
        implication={isDg ? "What you say is sent to Deepgram." : "Your voice never leaves this machine."}
        warn={isDg && !deepgramSet ? <>Deepgram is not set up yet: speech recognition fails on the devices that hear with this assistant until you add its key in <SettingsLink path={["shared", "speech"]}>Shared settings › Speech recognition models</SettingsLink>.</> : undefined}
        help={<>Only downloaded models can be chosen: download one in the list. Keys and downloads are also in <SettingsLink path={["shared", "speech"]}>Shared settings › Speech recognition models</SettingsLink>.</>}
      >
        <div>
          <SttModelPicker id={idOfPath("hearing.model")} engine={a.hearing.engine} model={a.hearing.model} onApply={apply} />
        </div>
      </AField>
      {!isDg && (
        <AField label="Language" path="hearing.language" draft={draft} htmlFor={idOfPath("hearing.language")} help={languageOk ? "Automatic works, but naming the language is faster and makes fewer mistakes." : "This model has one language, so the setting is not used."}>
          <SelectControl draft={draft} path="hearing.language" label="Language" width={260} disabled={!languageOk} options={LANGUAGES.map(([value, label]) => ({ value, label }))} />
        </AField>
      )}
    </>
  )
}

export function HearingTab({ draft, info }: TabProps) {
  const a = draft.current
  const sections = useClientState((s) => s.sections)
  const assistants = useClientState((s) => s.assistants)
  const devices = useClientState((s) => s.devices)
  const types = useClientState((s) => s.deviceTypes)
  const isDg = a.hearing.engine === "deepgram"
  const notices = hearingNotices(hearingModelNames(sections).hearing, info, assistants, devices, types, { ...info, hearing: a.hearing })
  return (
    <>
      <div className="flex flex-col gap-2" data-testid="hearing-notices">
        {notices.differs.map((d, i) => (
          <p key={i} className="rounded-md border border-line px-3 py-2 text-[13px] text-ink-muted">{d}</p>
        ))}
        <p className="text-[13px] text-ink-muted" data-testid="hearing-where">{notices.summary}</p>
      </div>
      <HearingFields draft={draft} />
      {!isDg ? (
        <>
          <Group title="Turn timing">
            <AField label="Pause before an early reply" path="hearing.eagerSilenceMs" draft={draft} htmlFor={idOfPath("hearing.eagerSilenceMs")} help="After this pause a reply may start while you could still carry on. Lower is faster; raise it if replies cut in.">
              <NumberControl draft={draft} path="hearing.eagerSilenceMs" min={50} max={2000} step={10} unit="ms" label="Pause before an early reply" />
            </AField>
            <AField label="Pause that ends your turn" path="hearing.finalSilenceMs" draft={draft} htmlFor={idOfPath("hearing.finalSilenceMs")} help="Shorter is faster but cuts in when you pause to think; longer waits more patiently. Default 600 ms.">
              <NumberControl draft={draft} path="hearing.finalSilenceMs" min={100} max={3000} step={10} unit="ms" label="Pause that ends your turn" />
            </AField>
            <AField label="Shortest speech" path="hearing.minSpeechMs" draft={draft} htmlFor={idOfPath("hearing.minSpeechMs")} help="Sounds shorter than this are not treated as speech, such as a cough or a door.">
              <NumberControl draft={draft} path="hearing.minSpeechMs" min={20} max={1000} step={10} unit="ms" label="Shortest speech" />
            </AField>
          </Group>
          <Group title="Microphone processing">
            <AField label="Boost quiet microphones" path="hearing.agc" draft={draft} help="Raises a quiet microphone before recognising speech. It also raises background noise.">
              <SwitchControl draft={draft} path="hearing.agc" label="Boost quiet microphones" />
            </AField>
            <AField label="Maximum boost" path="hearing.agcMaxGainDb" draft={draft} htmlFor={idOfPath("hearing.agcMaxGainDb")} help="The most the boost may add. Default 30 dB.">
              <NumberControl draft={draft} path="hearing.agcMaxGainDb" min={0} max={40} unit="dB" integer={false} label="Maximum boost" />
            </AField>
            <AField label="Speech detection threshold" path="hearing.vadThreshold" draft={draft} htmlFor={idOfPath("hearing.vadThreshold")} help="Lower hears soft speech but also more noise; higher ignores more. Default 0.5.">
              <NumberControl draft={draft} path="hearing.vadThreshold" min={0.05} max={0.95} step={0.05} integer={false} label="Speech detection threshold" />
            </AField>
          </Group>
        </>
      ) : (
        <Group title="Deepgram">
          <AField label="End-of-turn confidence" path="hearing.deepgram.eotThreshold" draft={draft} htmlFor={idOfPath("hearing.deepgram.eotThreshold")} help="How sure Deepgram must be that you finished. Higher waits longer and cuts in less.">
            <NumberControl draft={draft} path="hearing.deepgram.eotThreshold" min={0.5} max={1} step={0.05} integer={false} label="End-of-turn confidence" />
          </AField>
          <AField label="Early reply confidence" path="hearing.deepgram.eagerEotThreshold" draft={draft} htmlFor={idOfPath("hearing.deepgram.eagerEotThreshold")} help="From this confidence a reply may start early. Lower is faster; a reply may be thrown away. 0 = off.">
            <NumberControl draft={draft} path="hearing.deepgram.eagerEotThreshold" min={0} max={0.9} step={0.05} integer={false} label="Early reply confidence" />
          </AField>
          <AField label="Longest silence" path="hearing.deepgram.eotTimeoutMs" draft={draft} htmlFor={idOfPath("hearing.deepgram.eotTimeoutMs")} help="After this much silence your turn ends, whatever the confidence.">
            <NumberControl draft={draft} path="hearing.deepgram.eotTimeoutMs" min={500} max={10000} step={100} unit="ms" label="Longest silence" />
          </AField>
        </Group>
      )}
    </>
  )
}

// ---- Voice

export function VoiceTab({ draft }: TabProps) {
  const a = draft.current
  const key = `${a.voice.provider}:${a.voice.voiceId}`
  const providers = useCatalogState((s) => s.lists)
  const provider = providers.find((p) => p.provider.id === a.voice.provider)?.provider
  const hosted = provider !== undefined ? provider.location === "hosted" : a.voice.provider !== "sherpa"
  const label = provider?.label ?? a.voice.provider
  return (
    <>
      <AField
        label="Voice"
        path="voice"
        draft={draft}
        implication={hosted ? `The text of each reply is sent to ${label}.` : "Speech is made on this machine."}
        help={<>{a.name === "" ? "This assistant" : a.name} speaks every reply with this voice. Applies from the next reply once the voice has loaded. Favourites are shared by all devices. Keys and downloads are in <SettingsLink path={["shared", "providers"]}>Shared settings › Voice providers</SettingsLink>.</>}
      >
        <div>
          <VoicePicker
            id={idOfPath("voice")}
            value={key}
            label="Choose the assistant's voice"
            onChange={(k) => {
              const ref = parseKey(k)
              if (ref !== undefined) draft.set("voice", { provider: ref.provider, voiceId: ref.voiceId })
            }}
          />
        </div>
      </AField>
      <p className="text-[13px] text-ink-muted">Whether replies are spoken at all is set per device, under Audio.</p>
    </>
  )
}

// ---- Modules

/** The fields an assistant may own: the data marks them (`overridable`); a secret never is. */
const ownableFields = (m: ModuleInfo): ReadonlyArray<SettingField> => m.settings.fields.filter((f) => f.overridable === true && f.type !== "secret")

/** The shared values of a module in words ("16 November 2026 · Open-Meteo"): what an assistant uses unless it has its own. */
const sharedSummary = (m: ModuleInfo): string =>
  m.settings.fields
    .filter((f) => f.type !== "secret" && f.type !== "boolean" && !(f.advanced === true))
    .map((f) => displayValue(f, m.settings.values[f.key]))
    .filter((t) => t !== "(empty)" && t !== "—")
    .join(" · ")

function ModuleRow({ draft, module: m, compact }: { readonly draft: AssistantDraft; readonly module: ModuleInfo; readonly compact: boolean }) {
  const a = draft.current
  const choice = a.modules[m.id] ?? { on: false, offTools: [] }
  const [open, setOpen] = useState(false)
  const total = m.tools.length
  const n = m.tools.filter((t) => !choice.offTools.includes(t.name)).length
  const needsSetup = m.state === "error" && m.instances === undefined
  const path = `modules.${m.id}`
  const ownable = ownableFields(m)
  const setChoice = (next: typeof choice) => draft.update((x) => ({ ...x, modules: { ...x.modules, [m.id]: next } }), path)
  const changed = draft.changed(path)
  // A refusal that names no field of the own settings (the tools list, say) is shown under the row.
  const rowErrors = draft.errors.filter((e) => (e.key?.startsWith(path) ?? false) && !(e.key?.startsWith(`${path}.own.`) ?? false))
  return (
    <li className={cx("flex items-start gap-3 px-3 py-3", !choice.on && "opacity-80")} data-module={m.id} data-changed={changed ? "true" : undefined}>
      <div className="pt-0.5">
        <ModuleSwitch checked={choice.on && !needsSetup} disabled={needsSetup} label={m.name} onChange={(on) => setChoice({ ...choice, on })} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[14px] font-medium text-ink">{m.name}</span>
          {changed && <span className="label text-[11px] text-voice" data-testid="unsaved-marker">Unsaved</span>}
        </div>
        <span className="text-[13px] text-ink-muted">{m.description}</span>
        {needsSetup ? (
          <p className="text-[13px] text-warn">Set up {m.name} in <SettingsLink path={["shared", "modules"]}>its settings</SettingsLink> first.</p>
        ) : !compact && choice.on && total > 0 ? (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`tools-${m.id}`}
              onClick={() => setOpen(!open)}
              className="inline-flex min-h-8 items-center gap-1 self-start text-[12px] text-ink-muted hover:text-ink max-sm:min-h-11"
              data-testid="tools-toggle"
            >
              <Icon name="chevron" size={12} className={cx("transition-transform duration-[120ms]", open && "rotate-90")} />
              {n} of {total} tools
            </button>
            {open && (
              <div id={`tools-${m.id}`} className="flex flex-col" data-testid="tools-list">
                {m.tools.map((t) => {
                  const on = !choice.offTools.includes(t.name)
                  return (
                    <button
                      key={t.name}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      data-tool={t.name}
                      onClick={() => setChoice({ ...choice, offTools: on ? [...choice.offTools, t.name] : choice.offTools.filter((x) => x !== t.name) })}
                      className="flex min-h-9 items-start gap-2.5 py-1.5 text-left max-sm:min-h-11"
                    >
                      <span aria-hidden="true" className={cx("mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border", on ? "border-you bg-you-soft text-you" : "border-ink-faint")}>
                        {on && <Icon name="check" size={12} />}
                      </span>
                      <span className="min-w-0">
                        <span className="font-mono text-[13px] text-ink">{t.name}</span>
                        <span className="block text-[12px] text-ink-faint">{t.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        ) : (
          <span className="font-mono text-[12px] text-ink-faint">{total === 0 ? "Its tools are listed while it runs" : plural(total, "tool")}</span>
        )}
        {choice.on && !needsSetup && m.settings.fields.length > 0 && (
          compact || ownable.length === 0
            ? <SharedLine module={m} link={false} />
            : <OwnSettings draft={draft} module={m} fields={ownable} />
        )}
        {rowErrors.map((e, i) => (
          <p key={i} role="alert" className="text-[13px] text-danger" data-testid="field-error">{e.message}</p>
        ))}
      </div>
    </li>
  )
}

/** "Uses the shared settings: …" with a way to the shared page. */
function SharedLine({ module: m, link }: { readonly module: ModuleInfo; readonly link: boolean }) {
  const summary = sharedSummary(m)
  return (
    <span className="text-[12px] text-ink-muted" data-testid="shared-line">
      Uses the shared settings{summary !== "" && <>: <span className="text-ink">{summary}</span></>}
      {link && <> · <SettingsLink path={["shared", "modules"]}>Open</SettingsLink></>}
    </span>
  )
}

function ModuleSwitch({ checked, disabled, label, onChange }: { readonly checked: boolean; readonly disabled: boolean; readonly label: string; readonly onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-[120ms] ease-out",
        "before:absolute before:-inset-x-[5px] before:-inset-y-[11px] before:content-['']",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-you bg-you-soft" : "border-line bg-surface-2"
      )}
      data-testid="module-switch"
    >
      <span className={cx("absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-[left,background-color] duration-[160ms] ease-out", checked ? "left-[19px] bg-you" : "left-[3px] bg-ink-faint")} />
    </button>
  )
}

/**
 * "Use own settings for this assistant" (docs/ASSISTANTS.md §2.6, §7.1): per overridable field, the assistant's own
 * value or the shared one. Shared by default, with the shared value shown; each field then says "Same as shared" or
 * "Own value" with Reset (back to following the shared value, whatever it becomes). Saved as `modules[id].own` with
 * the assistant; the server's refusal of a value comes back on its field (`modules.<id>.own.<field>`).
 */
function OwnSettings({ draft, module: m, fields }: { readonly draft: AssistantDraft; readonly module: ModuleInfo; readonly fields: ReadonlyArray<SettingField> }) {
  const choice = draft.current.modules[m.id]!
  const own = choice.own
  const set = (next: Record<string, SettingValue> | undefined, touched: string) =>
    draft.update((x) => {
      const { own: _o, ...rest } = x.modules[m.id]!
      return { ...x, modules: { ...x.modules, [m.id]: next === undefined ? rest : { ...rest, own: next } } }
    }, touched)
  if (own === undefined) {
    return (
      <div className="flex flex-col gap-1.5 pt-1" data-testid="own-settings" data-own="false">
        <SharedLine module={m} link />
        <div><Button size="sm" onClick={() => set({}, `modules.${m.id}`)} data-testid="use-own">Use own settings for this assistant</Button></div>
      </div>
    )
  }
  const staysShared = m.settings.fields.filter((f) => !ownable(f)).map((f) => f.label.toLowerCase())
  return (
    <div className="mt-1 flex flex-col gap-4 rounded-md border border-line/70 px-3 py-3" data-testid="own-settings" data-own="true">
      <div className="flex items-center gap-2">
        <span className="label text-[11px] text-ink-faint">Own settings for {draft.current.name}</span>
        <button type="button" className="ml-auto text-[12px] text-voice underline-offset-4 hover:underline" onClick={() => set(undefined, `modules.${m.id}`)} data-testid="use-shared">Use the shared settings</button>
      </div>
      {fields.map((f) => {
        const Renderer = rendererFor(f)
        const fieldPath = `modules.${m.id}.own.${f.key}`
        const shared = m.settings.values[f.key]
        const isOwn = Object.hasOwn(own, f.key)
        const value = isOwn ? own[f.key] : shared
        const differs = isOwn && !sameValue(value, shared)
        const id = `own-${m.id}-${f.key}`
        const errors = errorsFor(draft.errors, fieldPath)
        const sharedText = displayValue(f, shared)
        return (
          <div key={f.key} className="flex flex-col gap-1.5" data-field={fieldPath} data-own-value={differs ? "true" : "false"}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <label htmlFor={id} className="text-[13px] font-medium text-ink">{f.label}</label>
              <span className="ml-auto inline-flex items-center gap-2">
                {differs ? (
                  <>
                    <span className="label rounded-sm border border-ink-faint px-1 text-[11px] leading-[14px] text-ink-muted" data-testid="own-marker">Own value</span>
                    <button
                      type="button"
                      className="relative inline-flex min-h-8 items-center text-[12px] text-voice underline-offset-4 hover:underline max-sm:before:absolute max-sm:before:-inset-x-2 max-sm:before:-inset-y-1.5 max-sm:before:content-['']"
                      onClick={() => set(Object.fromEntries(Object.entries(own).filter(([k]) => k !== f.key)), fieldPath)}
                      aria-label={`Reset ${f.label} to the shared value (${sharedText})`}
                      title={`Back to the shared value (${sharedText})`}
                      data-testid="own-reset"
                    >
                      Reset
                    </button>
                  </>
                ) : (
                  <span className="text-[12px] text-ink-faint" data-testid="same-as-shared">Same as shared</span>
                )}
              </span>
            </div>
            <Renderer
              field={f}
              id={id}
              describedBy={`${id}-desc`}
              value={value}
              onChange={(v) => set({ ...own, [f.key]: v }, fieldPath)}
              onSecretChange={() => undefined}
              disabled={false}
              invalid={errors.length > 0}
              onLocalError={(message) => draft.setLocalError(fieldPath, message)}
            />
            <div id={`${id}-desc`} className="flex flex-col gap-0.5">
              {errors.map((message, i) => <p key={i} role="alert" className="text-[13px] text-danger" data-testid="field-error">{message}</p>)}
              {draft.localErrors[fieldPath] !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="field-error">{draft.localErrors[fieldPath]}</p>}
              {f.description !== undefined && <p className="text-[13px] text-ink-muted">{f.description}</p>}
            </div>
          </div>
        )
      })}
      {staysShared.length > 0 && (
        <p className="text-[13px] text-ink-muted">{listJoin(staysShared).replace(/^./, (c) => c.toUpperCase())} {staysShared.length > 1 ? "stay" : "stays"} shared.</p>
      )}
    </div>
  )
}

const ownable = (f: SettingField): boolean => f.overridable === true && f.type !== "secret"
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The module rows (switch, tools, own settings); the wizard shows them too, without the tools and own settings (`compact`). */
export function ModuleList({ draft, compact = false }: { readonly draft: AssistantDraft; readonly compact?: boolean }) {
  const modules = useClientState((s) => s.modules)
  const list = modulesOf(modules.order.map((id) => modules.byId[id]!))
  return list.length === 0 ? (
    <p className="rounded-md border border-dashed border-line px-4 py-5 text-[14px] text-ink-muted">No modules are installed.</p>
  ) : (
    <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="module-list">
      {list.map((m) => <ModuleRow key={m.id} draft={draft} module={m} compact={compact} />)}
    </ul>
  )
}

export function ModulesTab({ draft }: TabProps) {
  return (
    <>
      <p className="text-[14px] text-ink-muted">What this assistant can do. Each module uses the shared settings unless this assistant has its own.</p>
      <ModuleList draft={draft} />
    </>
  )
}
