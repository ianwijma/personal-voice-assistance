import type { JobInfo, ModelApply, ModelEntry, ModelFavourite, ModelProviderInfo, ProviderModels, VoiceRefJson } from "@pva/protocol"
import { ModelIdString } from "@pva/protocol"
import { Schema } from "effect"

/**
 * The generic catalog picker's pure logic (docs/MODEL-PICKERS.md §6): the shapes the picker draws (`GenericProvider`,
 * `GenericRow`), what a rail tab or a search lists, matching, favourites, the typed model, and the mapping of a model
 * catalog's answer (`ProviderModels`) to those shapes. Voices map theirs in `components/voices/VoicePicker.tsx`
 * (`voicePicker.ts` keeps their own words). No React, no network.
 */

export type LocalState = "installed" | "not_installed" | "downloading"

/** What choosing a row hands to the page: a model's `apply`, or a voice. */
export type PickerChoice = { readonly apply: ModelApply } | { readonly voice: VoiceRefJson }

/** The row the picker draws: a voice or a model, mapped by its source. */
export interface GenericRow {
  readonly key: string
  readonly providerId: string
  readonly name: string
  readonly description?: string
  /** The tooltip of the row's button. */
  readonly title?: string
  /** The words under the name (a model's badges; a voice's language and gender). */
  readonly meta: ReadonlyArray<string>
  /** Extra searched words. */
  readonly search: ReadonlyArray<string>
  readonly local?: { readonly state: LocalState; readonly sizeMb: number; readonly job?: JobInfo }
  /** A local row that is not downloaded is not selectable: it downloads instead. */
  readonly selectable: boolean
  /** false: the provider's list lacks it (an assistant uses it). */
  readonly listed: boolean
  readonly favourite: boolean
  readonly usedBy: ReadonlyArray<string>
  readonly choice: PickerChoice
}

export type ProviderStatus = "ready" | "needs_key" | "needs_address" | "needs_setup" | "error"

export interface GenericProvider {
  readonly id: string
  readonly label: string
  readonly location: "local" | "hosted"
  readonly status: ProviderStatus
  readonly reason?: "missing" | "vault_locked"
  readonly message?: string
  readonly implication?: string
  /** The settings page that sets it up ("shared/accounts"). */
  readonly settingsPath: string
  /** The words of the link to it ("Open Voice providers"). */
  readonly linkText: string
  /** What the panel of a provider that is not set up says. */
  readonly notice: { readonly title: string; readonly body: string }
  /** With `status: "error"`: the sentence about what failed, and a line about the rows that are still listed. */
  readonly problem?: { readonly message: string; readonly note?: string }
  /** A model may be typed by name. */
  readonly customModel?: { readonly placeholder: string; readonly help: string }
  readonly rows: ReadonlyArray<GenericRow>
}

export interface GenericFavourite {
  readonly key: string
  readonly providerId: string
  readonly name: string
  readonly addedAt: number
}

/** A provider that can be chosen from: set up, or set up but its list failed. */
export const isUsable = (p: GenericProvider): boolean => p.status === "ready" || p.status === "error"

/** One line of the list. */
export type ListRow =
  | { readonly kind: "entry"; readonly key: string; readonly provider: GenericProvider; readonly row: GenericRow }
  /** A favourite that is in no list now (its provider has no key, or dropped it). */
  | { readonly kind: "missing"; readonly key: string; readonly provider: GenericProvider | undefined; readonly providerId: string; readonly name: string }
  /** The last row of a provider's list: a text field for a model by name. */
  | { readonly kind: "typed"; readonly key: string; readonly provider: GenericProvider }
  /** A search result: use the text typed in the search as a model of that provider. */
  | { readonly kind: "use"; readonly key: string; readonly provider: GenericProvider; readonly text: string }

export interface ListGroup {
  /** A provider header (search results only); absent for a flat list. */
  readonly header?: string
  readonly rows: ReadonlyArray<ListRow>
}

/** Case- and accent-insensitive form of a text, for matching. */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** The share done of a download, 0–100, or undefined when not known. */
export const percentOf = (job: JobInfo): number | undefined => {
  const p = job.progress
  if (p === undefined || p.total === undefined || p.total === 0) return undefined
  return Math.min(100, Math.floor((p.done / p.total) * 100))
}

/** Every word of `query` appears in the row's name, description, words, extra words or provider label. */
export const matchesRow = (row: GenericRow, provider: Pick<GenericProvider, "label">, query: string): boolean => {
  const words = fold(query).split(/\s+/).filter((w) => w !== "")
  if (words.length === 0) return true
  const hay = fold([row.name, row.description ?? "", ...row.meta, ...row.search, provider.label].join(" \u0000 "))
  return words.every((w) => hay.includes(w))
}

/** Every row by key, with its provider. */
export const indexRows = (lists: ReadonlyArray<GenericProvider>): ReadonlyMap<string, { readonly provider: GenericProvider; readonly row: GenericRow }> => {
  const map = new Map<string, { provider: GenericProvider; row: GenericRow }>()
  for (const p of lists) for (const row of p.rows) map.set(row.key, { provider: p, row })
  return map
}

/** `provider:id` → its parts (split at the first colon). */
export const splitKey = (key: string): { readonly provider: string; readonly id: string } | undefined => {
  const i = key.indexOf(":")
  return i <= 0 || i === key.length - 1 ? undefined : { provider: key.slice(0, i), id: key.slice(i + 1) }
}

/** A typed model name is acceptable (the assistant's own bound: 1–100 characters, no control characters, trimmed). */
export const validModelId = (text: string): boolean => Schema.is(ModelIdString)(text)

const hasTyped = (p: GenericProvider) => p.customModel !== undefined && isUsable(p)

const entryRow = (provider: GenericProvider, row: GenericRow): ListRow => ({ kind: "entry", key: row.key, provider, row })

/** One provider's rows, then (where it takes a typed model) the field for one. */
export const providerRows = (list: GenericProvider): ReadonlyArray<ListRow> => [
  ...list.rows.map((r) => entryRow(list, r)),
  ...(hasTyped(list) ? [{ kind: "typed", key: `typed:${list.id}`, provider: list } satisfies ListRow] : [])
]

/**
 * Favourites as ONE flat list: rows of the same provider together (providers in rail order), each provider's in the
 * order they were added. A favourite that is in no list now is kept, as `missing`.
 */
export const favouriteRows = (lists: ReadonlyArray<GenericProvider>, favourites: ReadonlyArray<GenericFavourite>): ReadonlyArray<ListRow> => {
  const index = indexRows(lists)
  const order = new Map(lists.map((p, i) => [p.id, i]))
  const rank = (f: GenericFavourite) => order.get(f.providerId) ?? lists.length
  return [...favourites]
    .sort((a, b) => rank(a) - rank(b) || a.addedAt - b.addedAt)
    .map((f): ListRow => {
      const found = index.get(f.key)
      if (found !== undefined) return entryRow(found.provider, found.row)
      return { kind: "missing", key: f.key, provider: lists.find((p) => p.id === f.providerId), providerId: f.providerId, name: f.name }
    })
}

/**
 * Search results across every provider at once, under provider headers (providers without a match are left out). A
 * provider that takes a typed model also offers "Use “<text>” on <label>" when the text is a valid model id (one
 * word: ids have no spaces in practice) that is not exactly one of its listed ids.
 */
export const searchGroups = (lists: ReadonlyArray<GenericProvider>, query: string): ReadonlyArray<ListGroup> => {
  const text = query.trim()
  return lists.flatMap((p) => {
    const rows: Array<ListRow> = p.rows.filter((r) => matchesRow(r, p, query)).map((r) => entryRow(p, r))
    if (hasTyped(p) && validModelId(text) && !/\s/.test(text) && !p.rows.some((r) => splitKey(r.key)?.id === text)) {
      rows.push({ kind: "use", key: `use:${p.id}`, provider: p, text })
    }
    return rows.length === 0 ? [] : [{ header: p.label, rows }]
  })
}

/** What the rail says about a provider that cannot list now (a dot on its mark), or undefined when it can. */
export const providerTrouble = (p: Pick<GenericProvider, "status">): "needs_key" | "needs_setup" | "error" | undefined =>
  p.status === "needs_key" ? "needs_key" : p.status === "needs_address" || p.status === "needs_setup" ? "needs_setup" : p.status === "error" ? "error" : undefined

/** The words added to a provider's name for assistive technology (and the rail's tooltip). */
export const troubleSuffix = (p: Pick<GenericProvider, "status" | "reason">): string => {
  const t = providerTrouble(p)
  return t === "needs_key" ? (p.reason === "vault_locked" ? " (keys locked)" : " (needs a key)") : t === "needs_setup" ? " (not set up)" : t === "error" ? " (a problem)" : ""
}

/** The muted words of a favourite that is in no list. */
export const missingMeta = (provider: GenericProvider | undefined, providerId: string): string => {
  const label = provider?.label ?? providerId
  if (provider === undefined) return "Not available now"
  if (provider.status === "needs_key") return `Needs a ${label} key`
  if (provider.status === "needs_address" || provider.status === "needs_setup") return `${label} is not set up`
  return "Not available now"
}

// ---- Models (docs/MODEL-PICKERS.md §4)

const LOCAL_STATES: ReadonlyArray<LocalState> = ["installed", "not_installed", "downloading"]

/** A model catalog entry as the row the picker draws. */
export const mapModelEntry = (e: ModelEntry): GenericRow => {
  const meta = e.badges.map((b) => b.label)
  if (!e.listed && !meta.includes("Not in the list")) meta.push("Not in the list")
  const title = [e.description, ...e.badges.flatMap((b) => (b.title !== undefined ? [b.title] : []))].filter((x): x is string => x !== undefined && x !== "").join(" — ")
  const local = e.local
  return {
    key: e.key,
    providerId: e.model.provider,
    name: e.name,
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(title !== "" ? { title } : {}),
    meta,
    search: [e.model.modelId, ...e.tags],
    ...(local !== undefined && LOCAL_STATES.includes(local.state)
      ? { local: { state: local.state, sizeMb: local.sizeMb, ...(local.job !== undefined ? { job: local.job } : {}) } }
      : {}),
    selectable: e.selectable,
    listed: e.listed,
    favourite: e.favourite,
    usedBy: e.usedBy,
    choice: { apply: e.apply }
  }
}

/** What a model provider that is not set up says: a heading and the sentence under it. */
export const modelNotice = (p: Pick<ModelProviderInfo, "status" | "reason" | "label" | "message">): { readonly title: string; readonly body: string } => {
  switch (p.status) {
    case "needs_key":
      return p.reason === "vault_locked"
        ? { title: "The keys are locked", body: p.message ?? `Unlock the key vault to use ${p.label}.` }
        : { title: `No ${p.label} key yet`, body: p.message ?? "Add its key to use its models." }
    case "needs_address":
      return { title: `No ${p.label} address yet`, body: p.message ?? "Add the server's address to use its models." }
    case "needs_setup":
      return { title: `${p.label} is not set up`, body: p.message ?? "Set it up to use its models." }
    default:
      return { title: p.label, body: p.message ?? "" }
  }
}

/** A catalog provider with its models, as the picker draws it. */
export const mapModelProvider = (pm: ProviderModels): GenericProvider => {
  const p = pm.provider
  const rows = pm.models.map(mapModelEntry)
  const note = pm.stale
    ? "These models are from an earlier look."
    : p.listSource === "known"
    ? "These are the models this assistant knows of; the provider's own list could not be fetched."
    : undefined
  return {
    id: p.id,
    label: p.label,
    location: p.location,
    status: p.status,
    ...(p.reason !== undefined ? { reason: p.reason } : {}),
    ...(p.message !== undefined ? { message: p.message } : {}),
    ...(p.implication !== undefined ? { implication: p.implication } : {}),
    settingsPath: p.settingsPath,
    linkText: `Open ${p.settingsLabel}`,
    notice: modelNotice(p),
    ...(p.status === "error"
      ? { problem: { message: p.message ?? pm.error?.message ?? `${p.label} could not be reached.`, ...(note !== undefined ? { note } : {}) } }
      : {}),
    ...(p.customModel !== undefined ? { customModel: p.customModel } : {}),
    rows
  }
}

export const mapModelFavourite = (f: ModelFavourite): GenericFavourite => ({ key: f.key, providerId: f.model.provider, name: f.name, addedAt: f.addedAt })

/** The key the language model picker shows as chosen: `account:model` (the offline stand-in has one fixed row). */
export const llmValue = (account: string, model: string): string => (account === "offline" ? "offline:stand-in" : model === "" ? "" : `${account}:${model}`)

/** The key the recogniser picker shows as chosen: the local model, or Deepgram's one row (named by the catalog). */
export const sttValue = (engine: string, model: string, lists: ReadonlyArray<GenericProvider>): string =>
  engine === "deepgram" ? lists.find((p) => p.id === "deepgram")?.rows[0]?.key ?? "deepgram:flux-general-en" : `sherpa:${model}`
