import type { AssistantInfo, DeviceListInfo, DeviceTypeInfo, DeviceUser, Favourite, JobInfo, ProviderInfo, ProviderVoices, VoiceEntry } from "@pva/protocol"
import { deviceVoiceUser, typeVoiceUser, voiceUsersOf } from "@pva/protocol"

/**
 * The voice picker's pure logic (docs/VOICE-PROVIDERS.md §4.2): what a list shows for a rail tab or a search, the
 * words under a voice, and search matching. No React, no network: `voiceCatalog.ts` holds the data, the picker
 * component draws it.
 */

/** The default text a preview reads; the picker's Reset goes back to it. */
export const DEFAULT_PREVIEW_TEXT = "Hi, I'm your assistant. It's twelve degrees and cloudy, and you have two meetings this afternoon."

/** `provider:voiceId` → its parts (split at the first colon), or undefined when it is not a voice key. */
export const parseKey = (key: string): { readonly provider: string; readonly voiceId: string } | undefined => {
  const i = key.indexOf(":")
  if (i <= 0 || i === key.length - 1) return undefined
  const provider = key.slice(0, i)
  const voiceId = key.slice(i + 1)
  return /^[a-z][a-z0-9-]{0,31}$/.test(provider) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(voiceId) ? { provider, voiceId } : undefined
}

/** Who speaks with each voice (`usedBy`, `usedByDevices` of the catalogue), by voice key. */
export interface VoiceUsers {
  readonly assistants: ReadonlyMap<string, ReadonlyArray<string>>
  readonly devices: ReadonlyMap<string, ReadonlyArray<DeviceUser>>
}

let lastUsers: { readonly a: unknown; readonly d: unknown; readonly t: unknown; readonly users: VoiceUsers } | undefined

/**
 * The voices' users from the admin state this page already has (docs/LOOKS-AND-VOICES.md §5.1), by the server's own
 * rule (`voiceUsersOf`): every assistant by its voice, every device type's defaults and every device by its
 * effective voice section. The catalogue is loaded once, so the picker shows these instead of the answer's, and a
 * saved device, device type or assistant shows at once. The same lists give the same object.
 */
export const voiceUsersFrom = (
  assistants: ReadonlyArray<Pick<AssistantInfo, "id" | "voice">>,
  devices: ReadonlyArray<Pick<DeviceListInfo, "id" | "name" | "settings">>,
  deviceTypes: ReadonlyArray<Pick<DeviceTypeInfo, "kind" | "one" | "settings">>
): VoiceUsers => {
  if (lastUsers !== undefined && lastUsers.a === assistants && lastUsers.d === devices && lastUsers.t === deviceTypes) return lastUsers.users
  const users = voiceUsersOf(assistants, [
    ...deviceTypes.map((t) => ({ user: typeVoiceUser(t.kind, t.one), voice: t.settings.voice })),
    ...devices.map((d) => ({ user: deviceVoiceUser(d.id, d.name), voice: d.settings.voice }))
  ])
  lastUsers = { a: assistants, d: devices, t: deviceTypes, users }
  return users
}

/** Case- and accent-insensitive form of a text, for matching. */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" })
  } catch {
    return undefined
  }
})()

/** "en-US" → "English (US)", "nl" → "Dutch"; the tag itself when the browser does not know it. */
export const languageLabel = (tag: string): string => {
  const [base, ...rest] = tag.split(/[-_]/)
  if (base === undefined || base === "") return tag
  let name: string | undefined
  try {
    name = languageNames?.of(base.toLowerCase())
  } catch {
    name = undefined
  }
  const region = rest.find((p) => /^[A-Za-z]{2}$|^\d{3}$/.test(p))?.toUpperCase()
  if (name === undefined) return tag
  return region === undefined ? name : `${name} (${region})`
}

/** The muted words under a voice: language, gender, then up to two of its tags. */
export const voiceMeta = (v: Pick<VoiceEntry, "language" | "gender" | "tags">): string =>
  [v.language !== undefined ? languageLabel(v.language) : undefined, v.gender, ...v.tags.slice(0, 2)].filter((x): x is string => x !== undefined && x !== "").join(" · ")

/** Every word of `query` appears in the voice's name, description, language, gender, tags or provider label. */
export const matchesVoice = (v: VoiceEntry, provider: Pick<ProviderInfo, "label">, query: string): boolean => {
  const words = fold(query).split(/\s+/).filter((w) => w !== "")
  if (words.length === 0) return true
  const hay = fold([v.name, v.description ?? "", v.language ?? "", v.language !== undefined ? languageLabel(v.language) : "", v.gender ?? "", ...v.tags, provider.label].join(" \u0000 "))
  return words.every((w) => hay.includes(w))
}

/** One row of the list: a voice of a provider, or a favourite whose voice is not in any list now. */
export type PickerRow =
  | { readonly kind: "voice"; readonly key: string; readonly provider: ProviderInfo; readonly voice: VoiceEntry }
  | { readonly kind: "missing"; readonly key: string; readonly provider: ProviderInfo | undefined; readonly name: string; readonly providerId: string }

export interface PickerGroup {
  /** A provider header (search results only); absent for a flat list. */
  readonly header?: string
  readonly rows: ReadonlyArray<PickerRow>
}

/** Every voice by key, with its provider. */
export const indexVoices = (lists: ReadonlyArray<ProviderVoices>): ReadonlyMap<string, { readonly provider: ProviderInfo; readonly voice: VoiceEntry }> => {
  const map = new Map<string, { provider: ProviderInfo; voice: VoiceEntry }>()
  for (const p of lists) for (const v of p.voices) map.set(v.key, { provider: p.provider, voice: v })
  return map
}

/**
 * Favourites as ONE flat list: voices of the same provider together (providers in rail order), each provider's in the
 * order they were added. A favourite that is in no list now is kept, as `missing`.
 */
export const favouriteRows = (lists: ReadonlyArray<ProviderVoices>, favourites: ReadonlyArray<Favourite>): ReadonlyArray<PickerRow> => {
  const index = indexVoices(lists)
  const order = new Map(lists.map((p, i) => [p.provider.id, i]))
  const rank = (f: Favourite) => order.get(f.voice.provider) ?? lists.length
  return [...favourites]
    .sort((a, b) => rank(a) - rank(b) || a.addedAt - b.addedAt)
    .map((f): PickerRow => {
      const found = index.get(f.key)
      if (found !== undefined) return { kind: "voice", key: f.key, provider: found.provider, voice: found.voice }
      return { kind: "missing", key: f.key, provider: lists.find((p) => p.provider.id === f.voice.provider)?.provider, name: f.name, providerId: f.voice.provider }
    })
}

/** Search results across every provider at once, under provider headers (providers without a match are left out). */
export const searchGroups = (lists: ReadonlyArray<ProviderVoices>, query: string): ReadonlyArray<PickerGroup> =>
  lists.flatMap((p) => {
    const rows = p.voices.filter((v) => matchesVoice(v, p.provider, query)).map((v): PickerRow => ({ kind: "voice", key: v.key, provider: p.provider, voice: v }))
    return rows.length === 0 ? [] : [{ header: p.provider.label, rows }]
  })

/** One provider's voices. */
export const providerRows = (list: ProviderVoices): ReadonlyArray<PickerRow> =>
  list.voices.map((v): PickerRow => ({ kind: "voice", key: v.key, provider: list.provider, voice: v }))

/** The share done of a download, 0–100, or undefined when not known. */
export const percentOf = (job: JobInfo): number | undefined => {
  const p = job.progress
  if (p === undefined || p.total === undefined || p.total === 0) return undefined
  return Math.min(100, Math.floor((p.done / p.total) * 100))
}

/** What the rail says about a provider that cannot list voices now (a dot on its icon), or undefined when it can. */
export const providerTrouble = (p: ProviderInfo): "needs_key" | "error" | undefined =>
  p.status === "needs_key" ? "needs_key" : p.status === "error" ? "error" : undefined

/** A provider that needs a key, in words: a heading and the line under it. */
export const needsKeyText = (p: ProviderInfo): { readonly title: string; readonly body: string } =>
  p.reason === "vault_locked"
    ? { title: "The keys are locked", body: p.message ?? `Unlock the key vault to list and preview ${p.label} voices.` }
    : { title: `No ${p.label} key yet`, body: p.message ?? `Add one to list and preview its voices.` }
