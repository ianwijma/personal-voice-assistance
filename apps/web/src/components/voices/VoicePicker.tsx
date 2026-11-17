"use client"
import { useId, useMemo } from "react"
import type { ProviderVoices, VoiceEntry } from "@pva/protocol"
import { MAX_PREVIEW_CHARS } from "@pva/protocol"
import type { GenericFavourite, GenericProvider, GenericRow } from "@/lib/catalogPicker.ts"
import { shallowEqual } from "@/lib/store.ts"
import type { VoiceCatalog } from "@/lib/voiceCatalog.ts"
import { jobOf } from "@/lib/voiceCatalog.ts"
import { DEFAULT_PREVIEW_TEXT, indexVoices, languageLabel, needsKeyText, parseKey, voiceMeta } from "@/lib/voicePicker.ts"
import { useClient, useClientState } from "../context.tsx"
import { CatalogPicker, type PickerSource, type RowActionProps } from "../pickers/CatalogPicker.tsx"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"
import { catalogFor, useCatalogState, useVoiceCatalog } from "./useVoiceCatalog.ts"

/**
 * The voice picker (docs/VOICE-PROVIDERS.md §4): the generic catalog picker (`pickers/CatalogPicker.tsx`) over the
 * voice catalog, plus what only voices have: the preview. Its third column holds the preview text (Reset, what the
 * preview does now; folded under the list on a phone), and each row has a speaker that reads the text in that voice
 * without selecting it. A voice on this machine that is not downloaded downloads first (progress, cancel).
 *
 * It knows nothing about where it is used: `value` is a voice key, `onChange` gets the chosen key. The data comes from
 * the client's one voice catalog, shared by every picker on the page.
 */
export interface VoicePickerProps {
  /** The chosen voice (`provider:voiceId`); `""` = `fallbackKey`. */
  readonly value: string
  readonly onChange: (key: string) => void
  readonly disabled?: boolean
  /** Shown but cannot be changed here (set elsewhere): the button does not open. */
  readonly locked?: boolean
  /** The voice `""` stands for (e.g. what the assistant's voice resolves to), shown with "default". */
  readonly fallbackKey?: string
  /** DOM id of the button (a `<label htmlFor>` points at it). */
  readonly id?: string
  readonly describedBy?: string
  /** The popup's name for assistive technology. */
  readonly label?: string
}

// What the catalog's answer maps to is computed once per answer, however many components read it.
const providersCache = new WeakMap<ReadonlyArray<ProviderVoices>, ReadonlyArray<GenericProvider>>()
const favouritesCache = new WeakMap<ReadonlyArray<{ readonly key: string }>, ReadonlyArray<GenericFavourite>>()

const mapVoice = (v: VoiceEntry): GenericRow => {
  const meta = voiceMeta(v)
  return {
    key: v.key,
    providerId: v.voice.provider,
    name: v.name,
    ...(v.description !== undefined ? { description: v.description, title: v.description } : {}),
    meta: meta === "" ? [] : [meta],
    search: [v.language ?? "", v.language !== undefined ? languageLabel(v.language) : "", v.gender ?? "", ...v.tags].filter((x) => x !== ""),
    ...(v.local !== undefined ? { local: { state: v.local.state, sizeMb: v.local.sizeMb, ...(v.local.job !== undefined ? { job: v.local.job } : {}) } } : {}),
    selectable: true,
    listed: true,
    favourite: v.favourite,
    usedBy: v.usedBy,
    choice: { voice: v.voice }
  }
}

const mapProvider = (p: ProviderVoices): GenericProvider => ({
  id: p.provider.id,
  label: p.provider.label,
  location: p.provider.location,
  status: p.provider.status,
  ...(p.provider.reason !== undefined ? { reason: p.provider.reason } : {}),
  ...(p.provider.message !== undefined ? { message: p.provider.message } : {}),
  ...(p.provider.implication !== undefined ? { implication: p.provider.implication } : {}),
  settingsPath: p.provider.settingsPath,
  linkText: "Open Voice providers",
  notice: needsKeyText(p.provider),
  problem: {
    message: p.provider.message ?? p.error?.message ?? `${p.provider.label} could not be reached.`,
    ...(p.voices.length > 0 ? { note: "These voices are from earlier; previews wait until it works again." } : {})
  },
  rows: p.voices.map(mapVoice)
})

const sources = new WeakMap<VoiceCatalog, PickerSource>()

/** The voice source of a catalog (one per catalog, so its identity is stable). */
export const voiceSource = (catalog: VoiceCatalog): PickerSource => {
  let source = sources.get(catalog)
  if (source === undefined) {
    source = {
      id: "voices",
      noun: "voice",
      words: {
        search: "Search all voices…",
        searchLabel: "Search all voices",
        refresh: "Ask the providers for their voices again",
        loading: "Loading voices…",
        loadFailed: "The voices could not be loaded",
        noMatch: ["No voices match", "Try another name, language or style."],
        noFavourites: ["No favourites yet", "Star a voice to keep it here."],
        noRows: ["No voices", "This provider has no voices to offer."],
        rail: "Voice providers",
        none: "No voice",
        panel: "Voices"
      },
      emptyIcon: "speaker",
      useState: () => {
        const s = useCatalogState((x) => ({ load: x.load, loadError: x.loadError, refreshing: x.refreshing, lists: x.lists, favourites: x.favourites }), shallowEqual)
        let lists = providersCache.get(s.lists)
        if (lists === undefined) providersCache.set(s.lists, (lists = s.lists.map(mapProvider)))
        let favourites = favouritesCache.get(s.favourites)
        if (favourites === undefined) {
          favouritesCache.set(s.favourites, (favourites = s.favourites.map((f) => ({ key: f.key, providerId: f.voice.provider, name: f.name, addedAt: f.addedAt }))))
        }
        return { load: s.load, loadError: s.loadError, refreshing: s.refreshing, lists, favourites }
      },
      ensure: () => catalog.ensure(),
      refresh: () => void catalog.reload(true),
      retry: () => void catalog.reload(),
      toggleFavourite: (key, name) => {
        const ref = parseKey(key)
        if (ref !== undefined) void catalog.toggleFavourite(key, { provider: ref.provider, voiceId: ref.voiceId }, name)
      },
      download: (key) => {
        const ref = parseKey(key)
        if (ref !== undefined) void catalog.download(key, { provider: ref.provider, voiceId: ref.voiceId })
      },
      cancelDownload: (key) => {
        const ref = parseKey(key)
        if (ref !== undefined) void catalog.cancelDownload(key, { provider: ref.provider, voiceId: ref.voiceId })
      },
      useDownload: (key, row) => {
        const d = useCatalogState((x) => x.downloads[key])
        const job = useClientState((s) => (row?.local === undefined ? undefined : jobOf(s.jobs, d, row.local.job, parseKey(key)?.voiceId)))
        return { starting: d?.starting === true, job }
      },
      useRowPhase: (key) => useCatalogState((x) => (x.preview?.key === key ? x.preview.phase : undefined)),
      RowAction: VoiceAction,
      Side: PreviewSide,
      onClose: () => catalog.stopPreview()
    }
    sources.set(catalog, source)
  }
  return source
}

export function VoicePicker({ value, onChange, disabled, locked, fallbackKey, id, describedBy, label = "Choose a voice" }: VoicePickerProps) {
  const client = useClient()
  const source = useMemo(() => voiceSource(catalogFor(client)), [client])
  return (
    <CatalogPicker
      source={source}
      value={value}
      onChange={(key) => onChange(key)}
      label={label}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(locked !== undefined ? { locked } : {})}
      {...(fallbackKey !== undefined ? { fallbackKey } : {})}
      {...(id !== undefined ? { id } : {})}
      {...(describedBy !== undefined ? { describedBy } : {})}
    />
  )
}

const rowButton = "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 max-sm:size-10"

/** The speaker of a voice row: previews the text on the right without selecting; the same again stops it. */
function VoiceAction({ row, local, providerReady, active }: RowActionProps) {
  const catalog = useVoiceCatalog()
  const phase = useCatalogState((s) => (s.preview?.key === row.key ? s.preview.phase : undefined))
  const voice = useCatalogState((s) => s.lists.find((p) => p.provider.id === row.providerId)?.voices.find((v) => v.key === row.key))
  const ref = parseKey(row.key)
  const previewable = voice !== undefined && providerReady && (voice.previewable || (local === "installed" && voice.local?.state !== "installed"))
  const name = row.name
  return (
    <button
      type="button"
      tabIndex={active ? 0 : -1}
      className={cx(rowButton, phase !== undefined && "text-voice hover:text-voice")}
      disabled={!previewable && phase === undefined}
      aria-label={phase !== undefined ? `Stop the preview of ${name}` : `Preview ${name}`}
      title={phase !== undefined ? "Stop" : previewable ? "Preview: read the text on the right" : "No preview now"}
      onClick={() => ref !== undefined && void catalog.preview(row.key, { provider: ref.provider, voiceId: ref.voiceId })}
      data-action={phase !== undefined ? "stop" : "preview"}
    >
      {phase === "loading" ? <Spinner size={13} /> : phase === "playing" ? <Icon name="stop" size={16} /> : <Icon name="speaker" size={16} />}
    </button>
  )
}

/** The preview text (editable, with Reset) and what the preview does now. Folded under the list on a phone. */
function PreviewSide({ phone }: { readonly phone: boolean }) {
  const catalog = useVoiceCatalog()
  const id = useId()
  const s = useCatalogState((x) => ({ text: x.previewText, preview: x.preview, notice: x.notice, lists: x.lists }), shallowEqual)
  const playing = s.preview === undefined ? undefined : indexVoices(s.lists).get(s.preview.key)
  const editor = (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between px-1">
        <label htmlFor={`${id}-text`} className="text-[13px] font-medium text-ink-muted">Preview text</label>
        <button
          type="button"
          className="inline-flex min-h-8 items-center rounded-md px-2 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40 max-sm:min-h-11"
          disabled={s.text === DEFAULT_PREVIEW_TEXT}
          onClick={() => catalog.setPreviewText(DEFAULT_PREVIEW_TEXT)}
          data-testid="preview-reset"
        >
          Reset
        </button>
      </div>
      <textarea
        id={`${id}-text`}
        value={s.text}
        maxLength={MAX_PREVIEW_CHARS}
        onChange={(e) => catalog.setPreviewText(e.target.value)}
        rows={phone ? 3 : undefined}
        data-testid="preview-text"
        className={cx(
          "w-full resize-none rounded-md border border-line bg-bg px-2.5 py-2 text-base leading-snug text-ink placeholder:text-ink-faint focus-visible:border-you sm:text-[13px]",
          !phone && "min-h-0 flex-1"
        )}
      />
    </>
  )
  const status = (
    <p className="flex min-h-7 items-center gap-2 px-1 pt-1.5 text-[12px] text-ink-muted" aria-live="polite" data-testid="preview-status">
      {s.notice !== undefined ? (
        <span className={cx("min-w-0", s.notice.tone === "error" ? "text-danger" : "text-ink-muted")} role={s.notice.tone === "error" ? "alert" : undefined}>{s.notice.message}</span>
      ) : s.preview?.phase === "loading" ? (
        <><Spinner size={12} /><span className="truncate">Getting {playing?.voice.name ?? "the preview"}…</span></>
      ) : s.preview?.phase === "playing" ? (
        <>
          <span aria-hidden="true" className="inline-flex h-3.5 items-center gap-0.5">
            {[0, 1, 2, 3].map((i) => <i key={i} className="spin-keep block h-1 w-0.5 rounded-full bg-voice animate-[pva-bar_0.7s_ease-in-out_infinite_alternate]" style={{ animationDelay: `${i * 0.15}s` }} />)}
          </span>
          <span className="truncate">Reading in <b className="font-medium text-ink">{playing?.voice.name ?? "this voice"}</b>{playing !== undefined ? ` · ${playing.provider.label}` : ""}</span>
        </>
      ) : (
        <span>Press <Icon name="speaker" size={13} className="inline align-[-2px]" /><span className="sr-only">the speaker</span> on a voice to hear this text.</span>
      )}
    </p>
  )
  if (phone) {
    return (
      <div className="shrink-0 border-t border-line px-3 pb-2">
        <details className="group" data-testid="preview-side">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] text-ink-muted marker:hidden hover:text-ink">
            <Icon name="chevron" size={14} className="transition-transform duration-[120ms] group-open:rotate-90" />
            Preview text
          </summary>
          <div className="pb-1">{editor}</div>
        </details>
        {status}
      </div>
    )
  }
  return (
    <div className="flex w-56 shrink-0 flex-col border-l border-line/70 px-3 pb-3" data-testid="preview-side">
      {editor}
      {status}
    </div>
  )
}
