import {
  type Assignment,
  type DeviceListInfo,
  type DeviceOwn,
  type DeviceSettings,
  type DeviceSettingsKey,
  type DeviceSettingsPatch,
  type DeviceTypeInfo,
  type WithoutPhrase,
  hearerOf,
  phraseKey,
  type AssistantInfo
} from "@pva/protocol"
import { deepEqual } from "./assistants.ts"

/**
 * The device and defaults pages (docs/ASSISTANTS.md §2.3, §2.6, §7.1; mock-up `admin.html` `pDevice`), as pure
 * functions: the sections a page shows, a draft of edits over what is saved (a section is "own" or "follows the
 * defaults"), the patch it saves, and the words of the notices. No React, no network.
 */

/** A section of the page. `assign` is two keys of the settings: the list and who answers without a phrase. */
export type SectionId = "assign" | "phrases" | "voicePage" | "interrupting" | "audio" | "captions"

export const SECTION_KEYS: Readonly<Record<SectionId, ReadonlyArray<DeviceSettingsKey>>> = {
  assign: ["assistants", "withoutPhrase"],
  phrases: ["matching"],
  voicePage: ["voicePage"],
  interrupting: ["interruptMode"],
  audio: ["audio"],
  captions: ["captions"]
}

/** The sections a device type has (its `keys`). */
export const sectionsOf = (type: Pick<DeviceTypeInfo, "keys"> | undefined): ReadonlyArray<SectionId> =>
  (Object.keys(SECTION_KEYS) as ReadonlyArray<SectionId>).filter((s) => SECTION_KEYS[s].every((k) => type === undefined || type.keys.includes(k)))

/** What a page edits: a type's defaults (complete values, no "own") or one device (own sections over the defaults). */
export interface DeviceBase {
  readonly isType: boolean
  /** The values in force now (a device's effective settings, a type's own). */
  readonly saved: DeviceSettings
  /** What a section returns to on Reset (the type's defaults; for a type, itself). */
  readonly defaults: DeviceSettings
  /** A device's own sections; always empty for a type. */
  readonly own: DeviceOwn
}

export const baseOfDevice = (d: Pick<DeviceListInfo, "settings" | "own">, type: Pick<DeviceTypeInfo, "settings">): DeviceBase => ({ isType: false, saved: d.settings, defaults: type.settings, own: d.own })
export const baseOfType = (t: Pick<DeviceTypeInfo, "settings">): DeviceBase => ({ isType: true, saved: t.settings, defaults: t.settings, own: {} })

/** The edits over the base: values set, keys reset to the defaults, and a new name. */
export interface DeviceEdit {
  readonly values: Partial<DeviceSettings>
  readonly reset: ReadonlyArray<DeviceSettingsKey>
  readonly name: string | undefined
}
export const noEdit: DeviceEdit = { values: {}, reset: [], name: undefined }

const ownSaved = (base: DeviceBase, k: DeviceSettingsKey) => (base.own as Partial<Record<DeviceSettingsKey, unknown>>)[k] !== undefined

/** The value of a key as the page shows it: the edit, else back to the defaults when reset, else what is in force. */
export const valueOf = <K extends DeviceSettingsKey>(base: DeviceBase, edit: DeviceEdit, key: K): DeviceSettings[K] =>
  (Object.hasOwn(edit.values, key) ? edit.values[key] : edit.reset.includes(key) ? base.defaults[key] : base.saved[key]) as DeviceSettings[K]

/** The effective settings with the edits. */
export const settingsOf = (base: DeviceBase, edit: DeviceEdit): DeviceSettings => ({
  assistants: valueOf(base, edit, "assistants"),
  withoutPhrase: valueOf(base, edit, "withoutPhrase"),
  matching: valueOf(base, edit, "matching"),
  voicePage: valueOf(base, edit, "voicePage"),
  interruptMode: valueOf(base, edit, "interruptMode"),
  audio: valueOf(base, edit, "audio"),
  captions: valueOf(base, edit, "captions")
})

const keyOwn = (base: DeviceBase, edit: DeviceEdit, k: DeviceSettingsKey): boolean =>
  base.isType ? false : Object.hasOwn(edit.values, k) || (!edit.reset.includes(k) && ownSaved(base, k))

/** Whether a device has its own value for the section (any of its keys), with the edits. A type has none: it is the defaults. */
export const isOwn = (base: DeviceBase, edit: DeviceEdit, section: SectionId): boolean => SECTION_KEYS[section].some((k) => keyOwn(base, edit, k))

/** The section differs from what is saved (its value, or being own at all). */
export const sectionChanged = (base: DeviceBase, edit: DeviceEdit, section: SectionId): boolean =>
  SECTION_KEYS[section].some((k) => !deepEqual(valueOf(base, edit, k), base.saved[k]) || keyOwn(base, edit, k) !== (!base.isType && ownSaved(base, k)))

/** Set the keys of a section (the section becomes own on a device); a value that changes nothing leaves no edit. */
export const setKeys = (base: DeviceBase, edit: DeviceEdit, values: Partial<DeviceSettings>): DeviceEdit => {
  const next: Partial<Record<DeviceSettingsKey, unknown>> = { ...edit.values }
  let reset = edit.reset
  for (const [k, v] of Object.entries(values) as Array<[DeviceSettingsKey, unknown]>) {
    next[k] = v
    reset = reset.filter((x) => x !== k)
    // An edit equal to what is saved (the own value, or for a section that follows the defaults, what it follows) is no edit.
    const same = ownSaved(base, k) ? deepEqual(v, (base.own as Record<string, unknown>)[k]) : deepEqual(v, base.saved[k])
    if (same) delete next[k]
  }
  return { ...edit, values: next as Partial<DeviceSettings>, reset }
}

/** A device's section back to the defaults: the edits go, and an own value that is saved is reset. */
export const resetSection = (base: DeviceBase, edit: DeviceEdit, section: SectionId): DeviceEdit => {
  const keys = SECTION_KEYS[section]
  const values = { ...edit.values } as Partial<Record<DeviceSettingsKey, unknown>>
  for (const k of keys) delete values[k]
  const reset = [...edit.reset.filter((x) => !keys.includes(x)), ...keys.filter((k) => ownSaved(base, k))]
  return { ...edit, values: values as Partial<DeviceSettings>, reset }
}

/** The patch `device.save` takes: the values of edited keys, `null` for each reset (devices only). */
export const patchOf = (base: DeviceBase, edit: DeviceEdit): DeviceSettingsPatch => {
  const patch: Record<string, unknown> = {}
  for (const k of edit.reset) if (!base.isType && ownSaved(base, k)) patch[k] = null
  for (const [k, v] of Object.entries(edit.values)) patch[k] = v
  return patch as DeviceSettingsPatch
}

export const isDirty = (base: DeviceBase, edit: DeviceEdit, savedName: string | undefined): boolean =>
  Object.keys(patchOf(base, edit)).length > 0 || (edit.name !== undefined && edit.name.trim() !== savedName)

/** The page's edits and the revision they started from. */
export interface DeviceDraft {
  readonly edit: DeviceEdit
  readonly rev: number
}

/**
 * The draft when revision `rev` arrives. `acked`: the edits a save of this page sent and the server took (they are
 * in `rev`): exactly those leave a clean draft, and edits made while that save was on its way stay, on `rev`.
 * Otherwise a draft with nothing to save follows `rev`, and one with edits stays where it is ("Changed somewhere else").
 */
export const draftOnRevision = (draft: DeviceDraft, rev: number, base: DeviceBase, savedName: string | undefined, acked: DeviceEdit | undefined): DeviceDraft =>
  draft.rev === rev
    ? draft
    : acked !== undefined
    ? { edit: draft.edit === acked ? noEdit : draft.edit, rev }
    : draft.edit === noEdit || !isDirty(base, draft.edit, savedName)
    ? { edit: noEdit, rev }
    : draft

/** The phrase without punctuation, as the tester compares a matched phrase. */
const bare = (p: string) => p.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "")

/** The assistant a matched phrase wakes, among the assignments of the device that was tested (its saved settings). */
export const wakesAssistant = (assignments: ReadonlyArray<Assignment>, phrase: string): string | undefined => {
  const key = phrase.trim().toLowerCase()
  return assignments.find((a) => a.phrases.some((p) => p.trim().toLowerCase() === key || bare(p) === bare(key)))?.assistant
}

// ---- Reading the list

/** Whether the assistant answers without a phrase here. */
export const answersWithoutPhrase = (wp: WithoutPhrase, id: string): boolean => wp.mode === "assistant" && wp.assistant === id

export type ReachWords = "phrase" | "without-phrase" | "typesafe" | "unreachable"

export const reachWords = (s: Pick<DeviceSettings, "assistants" | "withoutPhrase">, a: Assignment): ReachWords =>
  answersWithoutPhrase(s.withoutPhrase, a.assistant) ? "without-phrase" : a.phrases.length > 0 ? "phrase" : s.withoutPhrase.mode === "typesafe" ? "typesafe" : "unreachable"

/** The hearer, from settings (the protocol's own rule). */
export const hearerId = (s: Pick<DeviceSettings, "assistants" | "withoutPhrase">): string | null => hearerOf(s)

/** What the list says after "hears with": a short name for a recogniser. */
export const recogniserWords = (a: Pick<AssistantInfo, "hearing">, label: (preset: string) => string): string =>
  a.hearing.engine === "deepgram" ? "Deepgram" : `${label(a.hearing.model)}${a.hearing.language !== "auto" ? ` · ${a.hearing.language}` : ""}`

export const sameRecogniser = (a: Pick<AssistantInfo, "hearing">, b: Pick<AssistantInfo, "hearing">): boolean =>
  a.hearing.engine === b.hearing.engine && (a.hearing.engine === "deepgram" || (a.hearing.model === b.hearing.model && a.hearing.language === b.hearing.language))

/** "Hey Jeff" → "“Hey Jeff”"; one phrase and a count: "“Hey T3” +1". */
export const phraseChip = (a: Assignment): string | undefined =>
  a.phrases.length === 0 ? undefined : `“${a.phrases[0]}”${a.phrases.length > 1 ? ` +${a.phrases.length - 1}` : ""}`

// ---- Phrases

/** What is wrong with adding `text` to an assignment's phrases when the whole list is `assignments`: the device-wide duplicates too. */
export const phraseConflict = (text: string, assignments: ReadonlyArray<Assignment>, names: (id: string) => string): string | undefined => {
  const key = phraseKey(text)
  if (key === "") return undefined
  for (const a of assignments) {
    if (a.phrases.some((p) => phraseKey(p) === key)) return `“${text.trim()}” is already a phrase of ${names(a.assistant)} on this device. A phrase can wake one assistant only.`
  }
  return undefined
}

/** "after 10 min quiet", for the Conversation section's read-only lines. */
export const quietLabel = (v: number | "never"): string => (v === "never" ? "never" : v >= 60 && v % 60 === 0 ? `after ${v / 60} h quiet` : `after ${v} min quiet`)

export const followUpLabel = (v: number): string => (v === 0 ? "Off" : `${v} seconds`)
