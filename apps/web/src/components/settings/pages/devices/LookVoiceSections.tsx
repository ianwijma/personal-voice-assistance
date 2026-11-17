"use client"
import { useRef } from "react"
import { type AssistantInfo, type DeviceListInfo, FOLLOW_ASSISTANT, type Look, type VoiceRefJson } from "@pva/protocol"
import { BASELINE_ID } from "@/characters/choice.ts"
import { prettyId } from "@/characters/catalog.ts"
import { setKeys } from "@/lib/devices.ts"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { parseKey } from "@/lib/voicePicker.ts"
import { LookEditor } from "../../../looks/LookEditor.tsx"
import { useCharacter } from "../../../looks/useCharacter.ts"
import { useCatalogState } from "../../../voices/useVoiceCatalog.ts"
import { VoicePicker } from "../../../voices/VoicePicker.tsx"
import { RadioCards } from "../assistants/parts.tsx"
import { useVoiceNameOf } from "../AssistantsPage.tsx"
import { MarksFor, type SectionContext } from "./AssignSection.tsx"
import { Callout, DField, Pill } from "./parts.tsx"

/**
 * The Look and Voice sections of a device page and of a device type's defaults (docs/LOOKS-AND-VOICES.md §4): each
 * either follows the assistant that answers (`{ from: "assistant" }`: its own look or voice, set on the assistant) or
 * is the device's own for every assistant (`{ from: "device", … }`). Two levels are at play and the page keeps them
 * apart: the section's marks ("Own value · Reset" / "Follows Every browser") say whether this device has its own
 * setting or follows its type's defaults; the choice inside says whether that setting follows each assistant or fixes
 * one look or voice here.
 */

/** The name of a character, loading its manifest (a small chunk) if needed. */
export function CharacterName({ id }: { readonly id: string }) {
  const loaded = useCharacter(id)
  return <>{loaded?.kind === "ready" ? loaded.character.name : prettyId(id)}</>
}

const assignedOf = (ctx: SectionContext, assistants: ReadonlyArray<AssistantInfo>): ReadonlyArray<AssistantInfo> =>
  ctx.settings.assistants.flatMap((x) => assistants.filter((a) => a.id === x.assistant))

function AssistantLinks({ ctx, assistants, tab, what }: {
  readonly ctx: SectionContext
  readonly assistants: ReadonlyArray<AssistantInfo>
  readonly tab: "look" | "voice"
  readonly what: (a: AssistantInfo) => React.ReactNode
}) {
  const list = assignedOf(ctx, assistants)
  if (list.length === 0) return <p className="text-[13px] text-ink-muted">No assistant answers on {ctx.thisWord} yet.</p>
  return (
    <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid={`${tab}-per-assistant`}>
      {list.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]" data-assistant={a.id}>
          <span className="min-w-16 text-[14px] text-ink">{a.name}</span>
          <span className="text-ink-muted">{what(a)}</span>
          <a href={formatSettingsHash(["assistants", a.id, tab])} className="ml-auto text-voice underline-offset-4 hover:underline">
            Change on {a.name} › {tab === "look" ? "Look" : "Voice"}
          </a>
        </li>
      ))}
    </ul>
  )
}

export function LookSection({ ctx, assistants }: { readonly ctx: SectionContext; readonly assistants: ReadonlyArray<AssistantInfo> }) {
  const look = ctx.settings.look
  // The device's own look while it follows the assistants for a moment: choosing "One look" again brings it back.
  const lastOwn = useRef<Look | undefined>(look.from === "device" ? look.look : undefined)
  if (look.from === "device") lastOwn.current = look.look
  const first = assignedOf(ctx, assistants)[0]
  const set = (next: typeof look) => ctx.update((e) => setKeys(ctx.base, e, { look: next }))
  return (
    <section className="flex flex-col gap-4" aria-labelledby="h-look" data-testid="section-look" data-from={look.from}>
      <div className="flex items-baseline gap-2">
        <h3 id="h-look" className="label text-ink-faint">Look</h3>
        <MarksFor ctx={ctx} section="look" title="Look" />
      </div>
      <p className="-mt-2 text-[13px] text-ink-muted">The character on the voice page of {ctx.thisWord}.</p>
      <RadioCards
        label={`Look on ${ctx.thisWord}`}
        groupId="device-look-from"
        value={look.from}
        onChange={(v) => set(v === "assistant" ? FOLLOW_ASSISTANT : { from: "device", look: lastOwn.current ?? first?.look ?? { character: BASELINE_ID } })}
        cards={[
          { value: "assistant", title: "Each assistant's own look", tags: [], description: "The stage changes with the assistant that answers. Each assistant's look is set on the assistant, under Look." },
          { value: "device", title: `One look on ${ctx.thisWord}`, tags: [], description: `Every assistant that answers on ${ctx.thisWord} shows this look, instead of its own.` }
        ]}
      />
      {look.from === "assistant"
        ? <AssistantLinks ctx={ctx} assistants={assistants} tab="look" what={(a) => <CharacterName id={a.look?.character ?? BASELINE_ID} />} />
        : (
          <>
            <Callout testId="look-own-note">{ctx.isType ? `The default for ${ctx.thisWord}; one with a Look of its own keeps it.` : `For ${ctx.thisWord} only.`} The assistants' own looks are not changed.</Callout>
            <LookEditor value={look.look} idPrefix="d-look" whose={`${ctx.deviceName}'s own`} foldPicker onChange={(l) => set({ from: "device", look: l })} />
          </>
        )}
    </section>
  )
}

const keyOf = (v: VoiceRefJson): string => `${v.provider}:${v.voiceId}`

export function VoiceSection({ ctx, assistants }: { readonly ctx: SectionContext; readonly assistants: ReadonlyArray<AssistantInfo> }) {
  const voice = ctx.settings.voice
  const lastOwn = useRef<VoiceRefJson | undefined>(voice.from === "device" ? voice.voice : undefined)
  if (voice.from === "device") lastOwn.current = voice.voice
  const first = assignedOf(ctx, assistants)[0]
  const voiceName = useVoiceNameOf()
  const providers = useCatalogState((s) => s.lists)
  const set = (next: typeof voice) => ctx.update((e) => setKeys(ctx.base, e, { voice: next }))
  const own = voice.from === "device" ? voice.voice : undefined
  const provider = own === undefined ? undefined : providers.find((p) => p.provider.id === own.provider)?.provider
  const hosted = own === undefined ? false : provider !== undefined ? provider.location === "hosted" : own.provider !== "sherpa"
  return (
    <section className="flex flex-col gap-4" aria-labelledby="h-voice" data-testid="section-voice" data-from={voice.from}>
      <div className="flex items-baseline gap-2">
        <h3 id="h-voice" className="label text-ink-faint">Voice</h3>
        <MarksFor ctx={ctx} section="voice" title="Voice" />
      </div>
      <p className="-mt-2 text-[13px] text-ink-muted">The voice replies are spoken with on {ctx.thisWord}.</p>
      <RadioCards
        label={`Voice on ${ctx.thisWord}`}
        groupId="device-voice-from"
        value={voice.from}
        onChange={(v) => {
          if (v === "assistant") return set(FOLLOW_ASSISTANT)
          const start = lastOwn.current ?? first?.voice ?? assistants[0]?.voice
          if (start !== undefined) set({ from: "device", voice: { provider: start.provider, voiceId: start.voiceId } })
        }}
        cards={[
          { value: "assistant", title: "Each assistant's own voice", tags: [], description: "Each assistant speaks with its own voice, set on the assistant, under Voice." },
          { value: "device", title: `One voice on ${ctx.thisWord}`, tags: [], description: `Every assistant that answers on ${ctx.thisWord} speaks with this voice, instead of its own.` }
        ]}
      />
      {voice.from === "assistant"
        ? <AssistantLinks ctx={ctx} assistants={assistants} tab="voice" what={(a) => voiceName(a.voice) ?? a.voice.voiceId} />
        : (
          <DField
            label={`Voice on ${ctx.thisWord}`}
            htmlFor="device-voice"
            help={<>Applies from the next reply once the voice has loaded. The assistants' own voices are not changed. Keys and downloads are in <a href={formatSettingsHash(["shared", "providers"])} className="text-voice underline-offset-4 hover:underline">Shared settings › Voice providers</a>.</>}
          >
            <div>
              <VoicePicker
                id="device-voice"
                value={keyOf(voice.voice)}
                label={`Choose the voice on ${ctx.thisWord}`}
                onChange={(k) => {
                  const ref = parseKey(k)
                  if (ref !== undefined) set({ from: "device", voice: { provider: ref.provider, voiceId: ref.voiceId } })
                }}
              />
            </div>
            <p className="text-[13px] text-ink" data-testid="implication">{hosted ? `The text of each reply is sent to ${provider?.label ?? own?.provider}.` : "Speech is made on this machine."}</p>
          </DField>
        )}
    </section>
  )
}

/**
 * "Own look: Flame · Own voice: Amy": a device (or a type's defaults) that fixes the look or voice for every assistant
 * (docs/LOOKS-AND-VOICES.md §4); "(defaults)" when a device follows its type's defaults for it.
 */
export function LookVoiceLine({ settings, own, defaults }: {
  readonly settings: DeviceListInfo["settings"]
  readonly own: DeviceListInfo["own"] | undefined
  readonly defaults: boolean
}) {
  const look = settings.look.from === "device" ? settings.look.look : undefined
  const voice = settings.voice.from === "device" ? settings.voice.voice : undefined
  if (look === undefined && voice === undefined) return null
  const word = (k: "look" | "voice") => (defaults ? (k === "look" ? "Look" : "Voice") : own?.[k] !== undefined ? (k === "look" ? "Own look" : "Own voice") : (k === "look" ? "Look (defaults)" : "Voice (defaults)"))
  return (
    <span className="mt-1 flex flex-wrap gap-1.5" data-testid="device-look-voice">
      {look !== undefined && <Pill className="border-you/40"><span data-testid="device-own-look">{word("look")}: <CharacterName id={look.character} /></span></Pill>}
      {voice !== undefined && <Pill className="border-you/40"><span data-testid="device-own-voice">{word("voice")}: <VoiceName voice={voice} /></span></Pill>}
    </span>
  )
}

/** A voice's name from the catalog (loaded on first use), else its id. */
function VoiceName({ voice }: { readonly voice: { readonly provider: string; readonly voiceId: string } }) {
  const voiceName = useVoiceNameOf()
  return <>{voiceName(voice) ?? voice.voiceId}</>
}

