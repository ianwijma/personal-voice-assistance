"use client"
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { JobInfo, ProviderInfo, ProviderVoices, VoiceEntry, VoiceRefJson } from "@pva/protocol"
import { MAX_PREVIEW_CHARS } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { jobOf } from "@/lib/voiceCatalog.ts"
import {
  DEFAULT_PREVIEW_TEXT,
  favouriteRows,
  indexVoices,
  needsKeyText,
  parseKey,
  percentOf,
  type PickerGroup,
  type PickerRow,
  providerRows,
  providerTrouble,
  searchGroups,
  voiceMeta
} from "@/lib/voicePicker.ts"
import { useClient, useClientState } from "../context.tsx"
import { formatMb } from "../settings/DownloadControl.tsx"
import { Icon, Spinner } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"
import { useMediaQuery } from "../useMediaQuery.ts"
import { ProviderMark } from "./ProviderMark.tsx"
import { useCatalogState, useVoiceCatalog } from "./useVoiceCatalog.ts"

/**
 * The voice picker (docs/VOICE-PROVIDERS.md §4): a compact button with the provider's mark and the voice's name; it
 * opens a popover anchored to it with three columns: a rail (Favourites, then one mark per provider), a search over a
 * list of voices, and the text a preview reads. Searching looks across every provider at once (results under provider
 * headers); Favourites is one flat list. A row selects its voice; its speaker previews without selecting; a voice on
 * this machine that is not downloaded downloads first (progress, cancel). Below 640 px the popover is a bottom sheet:
 * the rail becomes a row of tabs over the search, and the preview text folds away under the list.
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

const PHONE = "(max-width: 639px)"
const FAVOURITES = "favourites"

export function VoicePicker({ value, onChange, disabled = false, locked = false, fallbackKey, id, describedBy, label = "Choose a voice" }: VoicePickerProps) {
  const catalog = useVoiceCatalog()
  useEffect(() => catalog.ensure(), [catalog])
  const lists = useCatalogState((s) => s.lists)
  const favourites = useCatalogState((s) => s.favourites)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const index = useMemo(() => indexVoices(lists), [lists])
  const effective = value !== "" ? value : fallbackKey ?? ""
  const found = index.get(effective)
  const ref = parseKey(effective)
  const providerId = found?.provider.id ?? ref?.provider
  const providerLabel = found?.provider.label ?? lists.find((p) => p.provider.id === ref?.provider)?.provider.label
  const name = found?.voice.name ?? favourites.find((f) => f.key === effective)?.name ?? ref?.voiceId ?? (effective === "" ? "No voice" : effective)
  const close = (returnFocus: boolean) => {
    setOpen(false)
    catalog.stopPreview()
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const blocked = disabled || locked
  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        data-testid="voice-picker"
        data-value={effective}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={describedBy}
        disabled={blocked}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={cx(
          "inline-flex h-9 max-w-full items-center gap-2 rounded-md border border-line bg-surface-2/60 pl-1.5 pr-2.5 text-[14px] font-medium text-ink max-sm:h-11",
          "transition-colors duration-[120ms] ease-out hover:border-ink-faint/60 aria-expanded:border-ink-faint/60",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      >
        {providerId !== undefined ? <ProviderMark id={providerId} {...(providerLabel !== undefined ? { label: providerLabel } : {})} /> : <Icon name="speaker" size={18} className="text-ink-muted" />}
        <span className="min-w-0 truncate">{name}</span>
        <span className="sr-only">{providerLabel !== undefined ? `, ${providerLabel}` : ""}</span>
        {value === "" && fallbackKey !== undefined && <span className="shrink-0 font-normal text-ink-muted">· default</span>}
        {locked ? <Icon name="lock" size={14} className="shrink-0 text-ink-faint" /> : <Icon name="chevronDown" size={14} className="shrink-0 text-ink-muted" />}
      </button>
      {open && !blocked && (
        <PickerPopup
          anchor={triggerRef}
          label={label}
          current={effective}
          onSelect={(key) => {
            onChange(key)
            close(true)
          }}
          onClose={close}
        />
      )}
    </>
  )
}

/** Where the popover goes: under the button, or above it when there is more room there; always on screen. */
const usePlacement = (anchor: React.RefObject<HTMLElement | null>, popup: React.RefObject<HTMLElement | null>, phone: boolean): CSSProperties | undefined => {
  const [style, setStyle] = useState<CSSProperties | undefined>()
  useLayoutEffect(() => {
    if (phone) return setStyle(undefined)
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const el = popup.current
      if (a === undefined || el === null) return
      const margin = 8
      const gap = 6
      const w = el.offsetWidth
      const natural = Number(el.dataset.height ?? el.offsetHeight)
      const below = innerHeight - a.bottom - gap - margin
      const above = a.top - gap - margin
      const down = below >= natural || below >= above
      const height = Math.min(natural, Math.max(down ? below : above, 220))
      const top = down ? a.bottom + gap : a.top - gap - height
      setStyle({
        top: Math.max(margin, Math.min(top, innerHeight - height - margin)),
        left: Math.max(margin, Math.min(a.left, innerWidth - w - margin)),
        height
      })
    }
    place()
    addEventListener("resize", place)
    addEventListener("scroll", place, true)
    return () => {
      removeEventListener("resize", place)
      removeEventListener("scroll", place, true)
    }
  }, [anchor, popup, phone])
  return style
}

function PickerPopup({ anchor, label, current, onSelect, onClose }: {
  readonly anchor: React.RefObject<HTMLButtonElement | null>
  readonly label: string
  readonly current: string
  readonly onSelect: (key: string) => void
  readonly onClose: (returnFocus: boolean) => void
}) {
  const catalog = useVoiceCatalog()
  const s = useCatalogState((x) => ({ load: x.load, loadError: x.loadError, refreshing: x.refreshing, lists: x.lists, favourites: x.favourites }), shallowEqual)
  const phone = useMediaQuery(PHONE)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const style = usePlacement(anchor, popupRef, phone)
  const ids = useId()
  const listId = `${ids}-list`
  // Until a tab is chosen: Favourites when there are any, else the current voice's provider (judged again once the
  // lists arrive, when the popup opened before they did).
  const [chosenTab, setTab] = useState<string | undefined>()
  const tab = chosenTab ?? (s.favourites.length > 0 ? FAVOURITES : parseKey(current)?.provider ?? s.lists[0]?.provider.id ?? FAVOURITES)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Focus the search once the popup is placed (it cannot take focus while hidden); close on Esc (focus back to the
  // button), a press outside, or focus leaving.
  const placed = phone || style !== undefined
  const focused = useRef(false)
  useEffect(() => {
    if (!placed || focused.current) return
    focused.current = true
    searchRef.current?.focus({ preventScroll: true })
  }, [placed])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popupRef.current?.contains(t) || anchor.current?.contains(t)) return
      closeRef.current(false)
    }
    // Esc wherever focus is (a control that turned disabled, Reset, drops focus to the page), before anything else
    // on the page hears it.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      e.preventDefault()
      closeRef.current(true)
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [anchor])

  const query_ = query.trim()
  const listOf = (id: string) => s.lists.find((p) => p.provider.id === id)
  const tabList = tab === FAVOURITES ? undefined : listOf(tab)
  const groups: ReadonlyArray<PickerGroup> = useMemo(() => {
    if (query_ !== "") return searchGroups(s.lists, query_)
    if (tab === FAVOURITES) return [{ rows: favouriteRows(s.lists, s.favourites) }]
    return tabList === undefined ? [] : [{ rows: providerRows(tabList) }]
  }, [query_, tab, s.lists, s.favourites, tabList])
  const rows = groups.flatMap((g) => g.rows)
  useEffect(() => setActive(0), [tab, query_])
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1))

  // At once (the row is there), so a second key press right after the first already goes to the row.
  const focusRow = (i: number) => {
    setActive(i)
    popupRef.current?.querySelector<HTMLElement>(`[data-row-main][data-index="${i}"]`)?.focus()
  }
  const onListKey = (e: KeyboardEvent) => {
    if (rows.length === 0) return
    const from = Number((e.target as HTMLElement).closest("[data-index]")?.getAttribute("data-index") ?? activeIndex)
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, from + 1)
      : e.key === "ArrowUp" ? from - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? rows.length - 1
      : undefined
    if (next === undefined) return
    e.preventDefault()
    if (next < 0) return searchRef.current?.focus()
    focusRow(next)
  }

  const needsKey = query_ === "" && tabList !== undefined && tabList.provider.status === "needs_key" ? tabList.provider : undefined
  const tabs: ReadonlyArray<{ readonly id: string; readonly label: string; readonly provider?: ProviderInfo }> = [
    { id: FAVOURITES, label: "Favourites" },
    ...s.lists.map((p) => ({ id: p.provider.id, label: p.provider.label, provider: p.provider }))
  ]
  const panelLabel = query_ !== "" ? "Search results" : tabs.find((t) => t.id === tab)?.label ?? "Voices"

  const body = (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={label}
      data-testid="voice-popup"
      data-layout={phone ? "sheet" : "popover"}
      data-height="380"
      style={style}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null
        if (to !== null && !e.currentTarget.contains(to) && !anchor.current?.contains(to)) onClose(false)
      }}
      className={cx(
        "fixed z-50 flex overflow-hidden border-line bg-surface text-ink shadow-panel",
        phone
          ? "inset-x-0 bottom-0 max-h-[85dvh] flex-col rounded-t-lg border-t pb-[env(safe-area-inset-bottom)] animate-[pva-sheet-up_240ms_var(--ease-out)]"
          : cx("w-[min(660px,calc(100vw-16px))] rounded-lg border animate-[pva-fade-in_120ms_var(--ease-out)]", style === undefined && "invisible")
      )}
    >
      {phone && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-1">
          <h2 className="label text-ink-muted">{label}</h2>
          <button type="button" aria-label="Close" onClick={() => onClose(true)} className="ml-auto inline-flex size-11 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      <Rail tabs={tabs} tab={query_ === "" ? tab : undefined} horizontal={phone} listId={listId} onTab={(t) => {
        setTab(t)
        setQuery("")
      }} />
      <div className={cx("flex min-w-0 flex-1 flex-col", phone ? "min-h-[260px]" : "border-l border-line/70")}>
        <div className="mx-3 flex h-11 shrink-0 items-center gap-2 border-b border-line text-ink-muted">
          <Icon name="search" size={15} className="shrink-0" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows.length > 0) {
                e.preventDefault()
                focusRow(0)
              }
            }}
            placeholder="Search all voices…"
            aria-label="Search all voices"
            aria-controls={listId}
            autoComplete="off"
            spellCheck={false}
            data-testid="voice-search"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint sm:text-[14px] [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            aria-label="Ask the providers for their voices again"
            title="Ask the providers for their voices again"
            onClick={() => void catalog.reload(true)}
            disabled={s.refreshing || s.load === "loading"}
            data-testid="voice-refresh"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50 max-sm:size-11"
          >
            {s.refreshing ? <Spinner size={13} /> : <Icon name="reload" size={15} />}
          </button>
        </div>
        <div id={listId} role="tabpanel" aria-label={panelLabel} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 scrollbar-quiet" data-testid="voice-list" data-mode={query_ !== "" ? "search" : tab === FAVOURITES ? "favourites" : "provider"}>
          {s.load === "loading" || s.load === "idle" ? (
            <Empty title="Loading voices…"><Spinner size={16} className="mx-auto mt-2" /></Empty>
          ) : s.load === "error" ? (
            <Empty title="The voices could not be loaded">
              {s.loadError}
              <button type="button" className="mt-2 block w-full text-voice underline-offset-4 hover:underline" onClick={() => void catalog.reload()}>Try again</button>
            </Empty>
          ) : needsKey !== undefined ? (
            <NeedsKey provider={needsKey} onOpen={() => onClose(false)} />
          ) : (
            <>
              {query_ === "" && tabList !== undefined && tabList.provider.status === "error" && <ProviderProblem list={tabList} onOpen={() => onClose(false)} />}
              {rows.length === 0 ? (
                query_ !== "" ? <Empty title="No voices match">Try another name, language or style.</Empty>
                  : tab === FAVOURITES ? <Empty title="No favourites yet">Star a voice to keep it here.</Empty>
                  : tabList?.provider.status === "error" ? null
                  : <Empty title="No voices">This provider has no voices to offer.</Empty>
              ) : (
                <ul onKeyDown={onListKey} aria-label={panelLabel} className="flex flex-col">
                  {(() => {
                    let i = -1
                    return groups.map((g) => [
                      g.header !== undefined && (
                        <li key={`h-${g.header}`} aria-hidden="true" className="label px-2 pb-1 pt-2.5 text-[10px] text-ink-faint first:pt-1">{g.header}</li>
                      ),
                      ...g.rows.map((row) => {
                        i++
                        return <Row key={`${g.header ?? ""}-${row.key}`} row={row} index={i} active={i === activeIndex} selected={row.key === current} onSelect={onSelect} onFocusRow={setActive} />
                      })
                    ])
                  })()}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      <PreviewSide phone={phone} />
    </div>
  )
  return createPortal(
    phone ? (
      <>
        <div className="fixed inset-0 z-40 bg-bg/50" aria-hidden="true" />
        {body}
      </>
    ) : body,
    document.body
  )
}

function Rail({ tabs, tab, horizontal, listId, onTab }: {
  readonly tabs: ReadonlyArray<{ readonly id: string; readonly label: string; readonly provider?: ProviderInfo }>
  /** The chosen tab (none while searching). */
  readonly tab: string | undefined
  readonly horizontal: boolean
  readonly listId: string
  readonly onTab: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const focusable = tab ?? tabs[0]?.id
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === (e.target as HTMLElement).dataset.tab)
    const forward = horizontal ? "ArrowRight" : "ArrowDown"
    const back = horizontal ? "ArrowLeft" : "ArrowUp"
    const next = e.key === forward ? (i + 1) % tabs.length : e.key === back ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : undefined
    if (next === undefined) return
    e.preventDefault()
    const t = tabs[next]!
    onTab(t.id)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(t.id)}"]`)?.focus())
  }
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Voice providers"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      onKeyDown={onKey}
      data-testid="voice-rail"
      className={cx("flex shrink-0 gap-1 bg-surface-2/40", horizontal ? "flex-row overflow-x-auto border-b border-line px-2 py-1.5" : "w-12 flex-col items-center py-2")}
    >
      {tabs.map((t) => {
        const trouble = t.provider !== undefined ? providerTrouble(t.provider) : undefined
        const chosen = t.id === tab
        const name = `${t.label}${trouble === "needs_key" ? (t.provider?.reason === "vault_locked" ? " (keys locked)" : " (needs a key)") : trouble === "error" ? " (a problem)" : ""}`
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            data-trouble={trouble}
            aria-selected={chosen}
            aria-controls={listId}
            aria-label={name}
            title={name}
            tabIndex={t.id === focusable ? 0 : -1}
            onClick={() => onTab(t.id)}
            className={cx(
              "relative grid shrink-0 place-items-center rounded-md transition-colors duration-[120ms]",
              horizontal ? "h-11 min-w-11 px-2" : "size-9",
              chosen ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
            )}
          >
            {t.provider === undefined ? <Icon name="star" size={17} fill={chosen ? "currentColor" : "none"} className={chosen ? "text-voice" : undefined} /> : <ProviderMark id={t.id} label={t.label} />}
            {chosen && <span aria-hidden="true" className={cx("absolute rounded-full bg-voice", horizontal ? "inset-x-2.5 -bottom-1.5 h-0.5" : "-right-[7px] inset-y-1.5 w-0.5")} />}
            {trouble !== undefined && (
              <span aria-hidden="true" className={cx("absolute right-0.5 top-0.5 size-2 rounded-full border-[1.5px] border-surface", trouble === "error" ? "bg-danger" : "bg-warn")} />
            )}
          </button>
        )
      })}
    </div>
  )
}

function Empty({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="px-5 py-7 text-center text-[13px] leading-relaxed text-ink-muted" data-testid="voice-list-empty">
      <p className="mb-1 font-medium text-ink">{title}</p>
      {children}
    </div>
  )
}

/** Opens the settings page that configures a provider (its key). */
function SettingsLink({ provider, onOpen, children }: { readonly provider: ProviderInfo; readonly onOpen: () => void; readonly children: ReactNode }) {
  const client = useClient()
  return (
    <button
      type="button"
      data-testid="open-provider-settings"
      className="mt-2 inline-flex min-h-8 items-center gap-1 text-voice underline-offset-4 hover:underline max-sm:min-h-11"
      onClick={() => {
        onOpen()
        client.settings(provider.settingsPath.split("/").filter((p) => p !== ""))
      }}
    >
      {children} <Icon name="arrowRight" size={14} />
    </button>
  )
}

function NeedsKey({ provider, onOpen }: { readonly provider: ProviderInfo; readonly onOpen: () => void }) {
  const text = needsKeyText(provider)
  return (
    <div className="px-5 py-7 text-center text-[13px] leading-relaxed text-ink-muted" data-testid="provider-needs-key" data-reason={provider.reason}>
      <p className="mb-1 font-medium text-ink">{text.title}</p>
      <p>{text.body}</p>
      {provider.implication !== undefined && <p className="mt-1 text-[12px] text-ink-faint">{provider.implication}</p>}
      <SettingsLink provider={provider} onOpen={onOpen}>{provider.reason === "vault_locked" ? "Open Keys & vault" : "Open Voice providers"}</SettingsLink>
    </div>
  )
}

function ProviderProblem({ list, onOpen }: { readonly list: ProviderVoices; readonly onOpen: () => void }) {
  return (
    <div role="alert" className="m-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-ink" data-testid="provider-error">
      <p>{list.provider.message ?? list.error?.message ?? `${list.provider.label} could not be reached.`}</p>
      {list.voices.length > 0 && <p className="text-[12px] text-ink-muted">These voices are from earlier; previews wait until it works again.</p>}
      <SettingsLink provider={list.provider} onOpen={onOpen}>Open Voice providers</SettingsLink>
    </div>
  )
}

type LocalState = "installed" | "not_installed" | "downloading"
const localStateOf = (voice: VoiceEntry, job: JobInfo | undefined): LocalState | undefined => {
  if (voice.local === undefined) return undefined
  if (job?.state === "running") return "downloading"
  if (voice.local.state === "installed" || job?.state === "succeeded") return "installed"
  return "not_installed"
}

const rowButton = "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 max-sm:size-10"

function Row({ row, index, active, selected, onSelect, onFocusRow }: {
  readonly row: PickerRow
  readonly index: number
  readonly active: boolean
  readonly selected: boolean
  readonly onSelect: (key: string) => void
  readonly onFocusRow: (index: number) => void
}) {
  const catalog = useVoiceCatalog()
  const r = useCatalogState((s) => ({
    favourite: s.favourites.some((f) => f.key === row.key),
    preview: s.preview?.key === row.key ? s.preview.phase : undefined,
    download: s.downloads[row.key]
  }), shallowEqual)
  const voice = row.kind === "voice" ? row.voice : undefined
  const job = useClientState((s) => (voice?.local === undefined ? undefined : jobOf(s.jobs, r.download, voice.local.job, voice.voice.voiceId)))
  const tab = active ? 0 : -1
  const name = row.kind === "voice" ? row.voice.name : row.name
  const providerId = row.kind === "voice" ? row.provider.id : row.providerId
  const providerLabel = row.provider?.label ?? providerId
  const ref: VoiceRefJson = row.kind === "voice" ? row.voice.voice : { provider: row.providerId, voiceId: parseKey(row.key)?.voiceId ?? row.key }
  const local = voice === undefined ? undefined : localStateOf(voice, job)
  const percent = local === "downloading" && job !== undefined ? percentOf(job) : undefined
  const ready = row.kind === "voice" && row.provider.status !== "needs_key"
  const previewable = voice !== undefined && row.kind === "voice" && row.provider.status === "ready" && (voice.previewable || (local === "installed" && voice.local?.state !== "installed"))
  const starting = r.download?.starting === true
  const select = () => {
    if (!ready || voice === undefined) return
    if (local === "not_installed") return void catalog.download(row.key, ref)
    if (local === "downloading") return
    onSelect(row.key)
  }
  const meta = row.kind === "missing"
    ? row.provider?.status === "needs_key" ? `Needs a ${providerLabel} key` : "Not available now"
    : voiceMeta(row.voice)
  return (
    <li
      className={cx(
        "group flex items-center gap-1 rounded-md pr-1 transition-colors duration-[120ms] hover:bg-surface-2 focus-within:bg-surface-2",
        r.preview !== undefined && "bg-surface-2"
      )}
      data-testid="voice-row"
      data-voice={row.key}
      data-selected={selected || undefined}
      data-local={local}
      data-preview={r.preview}
      data-favourite={r.favourite || undefined}
    >
      <button
        type="button"
        data-row-main=""
        data-index={index}
        tabIndex={tab}
        onFocus={() => onFocusRow(index)}
        onClick={select}
        // Not `disabled`: the arrow keys must still reach the row (its star still works).
        aria-disabled={!ready || undefined}
        aria-current={selected ? "true" : undefined}
        title={voice?.description}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left aria-disabled:cursor-default max-sm:h-11"
      >
        <ProviderMark id={providerId} label={providerLabel} />
        <span className={cx("shrink-0 truncate text-[14px] font-medium max-sm:max-w-[45%]", local === "not_installed" || row.kind === "missing" ? "text-ink-muted" : "text-ink")}>{name}</span>
        <span className="sr-only">, {providerLabel}{selected ? ", selected" : ""}{local === "not_installed" ? ", not downloaded: press to download" : ""}</span>
        {selected && <Icon name="check" size={14} className="shrink-0 text-you" data-testid="voice-selected" />}
        {local === "downloading" ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 pr-1 font-mono text-[12px] text-ink-muted tabular-nums" data-testid="voice-download-progress">
            <span
              role="progressbar"
              aria-label={`Downloading ${name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent !== undefined ? { "aria-valuenow": percent } : {})}
              className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-line"
            >
              <span className={cx("block h-full rounded-full bg-voice transition-[width] duration-200", percent === undefined && "w-1/3 animate-pulse")} style={percent !== undefined ? { width: `${percent}%` } : undefined} />
            </span>
            <span aria-hidden="true">{job?.phase === "unpack" ? "unpacking" : percent !== undefined ? `${percent}%` : "…"}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{meta}</span>
        )}
      </button>
      {local === "downloading" ? (
        <button type="button" tabIndex={tab} className={rowButton} aria-label={`Cancel the download of ${name}`} title="Cancel the download" onClick={() => void catalog.cancelDownload(row.key, ref)} data-action="cancel">
          <Icon name="close" size={15} />
        </button>
      ) : local === "not_installed" ? (
        <button
          type="button"
          tabIndex={tab}
          className={rowButton}
          disabled={starting}
          aria-label={`Download ${name} (${formatMb(voice?.local?.sizeMb ?? 0)})`}
          title={`Download (${formatMb(voice?.local?.sizeMb ?? 0)})`}
          onClick={() => void catalog.download(row.key, ref)}
          data-action="download"
        >
          {starting ? <Spinner size={13} /> : <Icon name="download" size={16} />}
        </button>
      ) : (
        <button
          type="button"
          tabIndex={tab}
          className={cx(rowButton, r.preview !== undefined && "text-voice hover:text-voice")}
          disabled={!previewable && r.preview === undefined}
          aria-label={r.preview !== undefined ? `Stop the preview of ${name}` : `Preview ${name}`}
          title={r.preview !== undefined ? "Stop" : previewable ? "Preview: read the text on the right" : "No preview now"}
          onClick={() => void catalog.preview(row.key, ref)}
          data-action={r.preview !== undefined ? "stop" : "preview"}
        >
          {r.preview === "loading" ? <Spinner size={13} /> : r.preview === "playing" ? <Icon name="stop" size={16} /> : <Icon name="speaker" size={16} />}
        </button>
      )}
      <button
        type="button"
        tabIndex={tab}
        aria-pressed={r.favourite}
        aria-label={`Favourite ${name}`}
        title={r.favourite ? "Remove from favourites" : "Add to favourites"}
        onClick={() => void catalog.toggleFavourite(row.key, ref, name)}
        data-action="favourite"
        className={cx(
          rowButton,
          r.favourite ? "text-voice hover:text-voice" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        )}
      >
        <Icon name="star" size={16} fill={r.favourite ? "currentColor" : "none"} />
      </button>
    </li>
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
