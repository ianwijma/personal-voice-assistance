"use client"
import { type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { JobInfo } from "@pva/protocol"
import {
  favouriteRows,
  type GenericFavourite,
  type GenericProvider,
  type GenericRow,
  indexRows,
  isUsable,
  type ListGroup,
  type ListRow,
  type LocalState,
  missingMeta,
  percentOf,
  type PickerChoice,
  providerRows,
  providerTrouble,
  searchGroups,
  splitKey,
  troubleSuffix,
  validModelId
} from "@/lib/catalogPicker.ts"
import { currentSettingsPath } from "@/lib/settingsTree.ts"
import { useClient } from "../context.tsx"
import { formatMb } from "../settings/DownloadControl.tsx"
import { Icon, type IconName, Spinner } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"
import { useMediaQuery } from "../useMediaQuery.ts"
import { ProviderMark } from "../voices/ProviderMark.tsx"
import { UsedBy } from "./UsedBy.tsx"

/**
 * One picker over any catalog: voices, language models, recogniser models (docs/MODEL-PICKERS.md §6). A compact button
 * with the provider's mark and the chosen name; it opens a popover anchored to it with a rail (Favourites, then one
 * mark per provider) and a search over a list (and, for a source that has one, a third column: the voices' preview
 * text). Searching looks across every provider at once (results under provider headers); Favourites is one flat list.
 * A row selects; its star adds it to the favourites; its action (a voice's speaker, a download) does not select. A
 * provider that is not set up shows a link to its settings instead of a list. Below 640 px the popover is a bottom
 * sheet: the rail becomes a row of tabs over the search.
 *
 * It knows nothing about voices or models: `source` is the data adapter (what is listed, favourites, downloads), and
 * `onChange` gets the chosen key with what the row says choosing it does (`PickerChoice`).
 */
export interface PickerState {
  readonly load: "idle" | "loading" | "ready" | "error"
  readonly loadError?: string | undefined
  readonly refreshing: boolean
  readonly lists: ReadonlyArray<GenericProvider>
  readonly favourites: ReadonlyArray<GenericFavourite>
  /** A line about what just went wrong (a favourite, a download); a source that shows its own leaves it out. */
  readonly notice?: { readonly tone: "error" | "info"; readonly message: string } | undefined
}

/** The words of one kind of picker. */
export interface PickerWords {
  /** The search field's placeholder and name. */
  readonly search: string
  readonly searchLabel: string
  readonly refresh: string
  readonly loading: string
  readonly loadFailed: string
  readonly noMatch: readonly [string, string]
  readonly noFavourites: readonly [string, string]
  readonly noRows: readonly [string, string]
  readonly rail: string
  /** The button when nothing is chosen. */
  readonly none: string
  /** The panel title when no tab is known. */
  readonly panel: string
}

export interface RowActionProps {
  readonly row: GenericRow
  readonly local: LocalState | undefined
  readonly providerReady: boolean
  readonly active: boolean
}

export interface PickerSource {
  readonly id: "voices" | "llm" | "stt"
  /** "voice" or "model": the test ids (`voice-picker`, `model-row`, …) and the row's attribute. */
  readonly noun: "voice" | "model"
  readonly words: PickerWords
  readonly emptyIcon: IconName
  /** The data (a hook: re-renders when it changes). */
  readonly useState: () => PickerState
  /** First load (lists and favourites). */
  readonly ensure: () => void
  /** Ask the providers again now. */
  readonly refresh: () => void
  /** The load failed: try again. */
  readonly retry: () => void
  /** Ask one provider again (a failed list's Retry); absent: no Retry button. */
  readonly retryProvider?: (id: string) => void
  readonly toggleFavourite: (key: string, name: string) => void
  /** Local rows only. */
  readonly download?: (key: string) => void
  readonly cancelDownload?: (key: string) => void
  /** The download a row shows (a hook): the one the picker started, and the job of it. */
  readonly useDownload: (key: string, row: GenericRow | undefined) => { readonly starting: boolean; readonly job?: JobInfo | undefined }
  /** A state of the row for styling and tests (a voice's preview phase). */
  readonly useRowPhase: (key: string) => string | undefined
  /** The row's own action next to the star (not for downloading); absent: none. */
  readonly RowAction?: ComponentType<RowActionProps>
  /** A third column (voices: the preview text). `phone`: folded under the list. */
  readonly Side?: ComponentType<{ readonly phone: boolean }>
  /** A model typed by name: the choice it makes, for a provider that takes one. */
  readonly typed?: (providerId: string, text: string) => PickerChoice
  /** The popup closed (voices: stop the preview). */
  readonly onClose?: () => void
}

export interface CatalogPickerProps {
  readonly source: PickerSource
  /** The chosen key (`provider:id`); `""` = `fallbackKey`. */
  readonly value: string
  /** The chosen row's key and what it sets. */
  readonly onChange: (key: string, choice: PickerChoice) => void
  readonly disabled?: boolean
  /** Shown but cannot be changed here (set elsewhere): the button does not open. */
  readonly locked?: boolean
  /** The key `""` stands for (e.g. what the assistant's voice resolves to), shown with "default". */
  readonly fallbackKey?: string
  /** DOM id of the button (a `<label htmlFor>` points at it). */
  readonly id?: string
  readonly describedBy?: string
  /** The popup's name for assistive technology. */
  readonly label?: string
  /** The name on the button when the chosen key is in no list (default: the key's own id). */
  readonly fallbackName?: string
}

const PHONE = "(max-width: 639px)"
const FAVOURITES = "favourites"

export function CatalogPicker({ source, value, onChange, disabled = false, locked = false, fallbackKey, id, describedBy, label = "Choose", fallbackName }: CatalogPickerProps) {
  useEffect(() => source.ensure(), [source])
  const state = source.useState()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const index = useMemo(() => indexRows(state.lists), [state.lists])
  const effective = value !== "" ? value : fallbackKey ?? ""
  const found = index.get(effective)
  const ref = splitKey(effective)
  const providerId = found?.provider.id ?? ref?.provider
  const providerLabel = found?.provider.label ?? state.lists.find((p) => p.id === ref?.provider)?.label
  const name = found?.row.name ?? state.favourites.find((f) => f.key === effective)?.name ?? fallbackName ?? ref?.id ?? (effective === "" ? source.words.none : effective)
  const close = (returnFocus: boolean) => {
    setOpen(false)
    source.onClose?.()
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const blocked = disabled || locked
  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        data-testid={`${source.noun}-picker`}
        data-picker={source.id}
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
        {providerId !== undefined ? <ProviderMark id={providerId} {...(providerLabel !== undefined ? { label: providerLabel } : {})} /> : <Icon name={source.emptyIcon} size={18} className="text-ink-muted" />}
        <span className="min-w-0 truncate">{name}</span>
        <span className="sr-only">{providerLabel !== undefined ? `, ${providerLabel}` : ""}</span>
        {value === "" && fallbackKey !== undefined && <span className="shrink-0 font-normal text-ink-muted">· default</span>}
        {locked ? <Icon name="lock" size={14} className="shrink-0 text-ink-faint" /> : <Icon name="chevronDown" size={14} className="shrink-0 text-ink-muted" />}
      </button>
      {open && !blocked && (
        <PickerPopup
          source={source}
          anchor={triggerRef}
          label={label}
          current={effective}
          onSelect={(key, choice) => {
            onChange(key, choice)
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

function PickerPopup({ source, anchor, label, current, onSelect, onClose }: {
  readonly source: PickerSource
  readonly anchor: React.RefObject<HTMLButtonElement | null>
  readonly label: string
  readonly current: string
  readonly onSelect: (key: string, choice: PickerChoice) => void
  readonly onClose: (returnFocus: boolean) => void
}) {
  const s = source.useState()
  const { noun, words } = source
  const Side = source.Side
  const phone = useMediaQuery(PHONE)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const style = usePlacement(anchor, popupRef, phone)
  const ids = useId()
  const listId = `${ids}-list`
  // Until a tab is chosen: Favourites when there are any, else the current row's provider (judged again once the
  // lists arrive, when the popup opened before they did).
  const [chosenTab, setTab] = useState<string | undefined>()
  const tab = chosenTab ?? (s.favourites.length > 0 ? FAVOURITES : splitKey(current)?.provider ?? s.lists[0]?.id ?? FAVOURITES)
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
  const tabList = tab === FAVOURITES ? undefined : s.lists.find((p) => p.id === tab)
  const groups: ReadonlyArray<ListGroup> = useMemo(() => {
    if (query_ !== "") return searchGroups(s.lists, query_)
    if (tab === FAVOURITES) return [{ rows: favouriteRows(s.lists, s.favourites) }]
    return tabList === undefined ? [] : [{ rows: providerRows(tabList) }]
  }, [query_, tab, s.lists, s.favourites, tabList])
  const rows = groups.flatMap((g) => g.rows)
  const favKeys = useMemo(() => new Set(s.favourites.map((f) => f.key)), [s.favourites])
  useEffect(() => setActive(0), [tab, query_])
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1))

  // At once (the row is there), so a second key press right after the first already goes to the row.
  const focusRow = (i: number) => {
    setActive(i)
    popupRef.current?.querySelector<HTMLElement>(`[data-row-main][data-index="${i}"]`)?.focus()
  }
  const onListKey = (e: KeyboardEvent) => {
    if (rows.length === 0) return
    const target = e.target as HTMLElement
    // Home and End belong to a text field's caret.
    if (target.tagName === "INPUT" && (e.key === "Home" || e.key === "End")) return
    const from = Number(target.closest("[data-index]")?.getAttribute("data-index") ?? activeIndex)
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

  const unavailable = query_ === "" && tabList !== undefined && !isUsable(tabList) ? tabList : undefined
  const failed = query_ === "" && tabList !== undefined && tabList.status === "error" ? tabList : undefined
  const tabs: ReadonlyArray<{ readonly id: string; readonly label: string; readonly provider?: GenericProvider }> = [
    { id: FAVOURITES, label: "Favourites" },
    ...s.lists.map((p) => ({ id: p.id, label: p.label, provider: p }))
  ]
  const panelLabel = query_ !== "" ? "Search results" : tabs.find((t) => t.id === tab)?.label ?? words.panel

  const body = (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={label}
      data-testid={`${noun}-popup`}
      data-picker={source.id}
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
      <Rail noun={noun} railLabel={words.rail} tabs={tabs} tab={query_ === "" ? tab : undefined} horizontal={phone} listId={listId} onTab={(t) => {
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
            placeholder={words.search}
            aria-label={words.searchLabel}
            aria-controls={listId}
            autoComplete="off"
            spellCheck={false}
            data-testid={`${noun}-search`}
            className="h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint sm:text-[14px] [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            aria-label={words.refresh}
            title={words.refresh}
            onClick={() => source.refresh()}
            disabled={s.refreshing || s.load === "loading"}
            data-testid={`${noun}-refresh`}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50 max-sm:size-11"
          >
            {s.refreshing ? <Spinner size={13} /> : <Icon name="reload" size={15} />}
          </button>
        </div>
        <div id={listId} role="tabpanel" aria-label={panelLabel} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 scrollbar-quiet" data-testid={`${noun}-list`} data-mode={query_ !== "" ? "search" : tab === FAVOURITES ? "favourites" : "provider"}>
          {s.load === "loading" || s.load === "idle" ? (
            <Empty noun={noun} title={words.loading}><Spinner size={16} className="mx-auto mt-2" /></Empty>
          ) : s.load === "error" ? (
            <Empty noun={noun} title={words.loadFailed}>
              {s.loadError}
              <button type="button" className="mt-2 block w-full text-voice underline-offset-4 hover:underline" onClick={() => source.retry()}>Try again</button>
            </Empty>
          ) : unavailable !== undefined ? (
            <NotSetUp provider={unavailable} onOpen={() => onClose(false)} />
          ) : (
            <>
              {failed !== undefined && <ProviderProblem provider={failed} source={source} refreshing={s.refreshing} onOpen={() => onClose(false)} />}
              {rows.length === 0 ? (
                query_ !== "" ? <Empty noun={noun} title={words.noMatch[0]}>{words.noMatch[1]}</Empty>
                  : tab === FAVOURITES ? <Empty noun={noun} title={words.noFavourites[0]}>{words.noFavourites[1]}</Empty>
                  : failed !== undefined ? null
                  : <Empty noun={noun} title={words.noRows[0]}>{words.noRows[1]}</Empty>
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
                        const k = `${g.header ?? ""}-${row.key}`
                        return row.kind === "typed" || row.kind === "use"
                          ? <TypedRow key={k} source={source} row={row} index={i} active={i === activeIndex} onSelect={onSelect} onFocusRow={setActive} />
                          : <Row key={k} source={source} row={row} index={i} active={i === activeIndex} selected={row.key === current} favourite={favKeys.has(row.key)} onSelect={onSelect} onFocusRow={setActive} />
                      })
                    ])
                  })()}
                </ul>
              )}
            </>
          )}
        </div>
        {Side === undefined && s.notice !== undefined && (
          <p className={cx("shrink-0 border-t border-line/70 px-3 py-1.5 text-[12px]", s.notice.tone === "error" ? "text-danger" : "text-ink-muted")} role={s.notice.tone === "error" ? "alert" : undefined} data-testid={`${noun}-notice`}>
            {s.notice.message}
          </p>
        )}
      </div>
      {Side !== undefined && <Side phone={phone} />}
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

function Rail({ noun, railLabel, tabs, tab, horizontal, listId, onTab }: {
  readonly noun: string
  readonly railLabel: string
  readonly tabs: ReadonlyArray<{ readonly id: string; readonly label: string; readonly provider?: GenericProvider }>
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
      aria-label={railLabel}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      onKeyDown={onKey}
      data-testid={`${noun}-rail`}
      className={cx("flex shrink-0 gap-1 bg-surface-2/40", horizontal ? "flex-row overflow-x-auto border-b border-line px-2 py-1.5" : "w-12 flex-col items-center py-2")}
    >
      {tabs.map((t) => {
        const trouble = t.provider !== undefined ? providerTrouble(t.provider) : undefined
        const chosen = t.id === tab
        const name = `${t.label}${t.provider !== undefined ? troubleSuffix(t.provider) : ""}`
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

function Empty({ noun, title, children }: { readonly noun: string; readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="px-5 py-7 text-center text-[13px] leading-relaxed text-ink-muted" data-testid={`${noun}-list-empty`}>
      <p className="mb-1 font-medium text-ink">{title}</p>
      {children}
    </div>
  )
}

/** Opens the settings page that configures a provider (its key, its address). */
function SettingsLink({ provider, onOpen, children }: { readonly provider: GenericProvider; readonly onOpen: () => void; readonly children: ReactNode }) {
  const client = useClient()
  return (
    <button
      type="button"
      data-testid="open-provider-settings"
      className="mt-2 inline-flex min-h-8 items-center gap-1 text-voice underline-offset-4 hover:underline max-sm:min-h-11"
      onClick={() => {
        onOpen()
        client.settings(currentSettingsPath(provider.settingsPath.split("/").filter((p) => p !== "")))
      }}
    >
      {children} <Icon name="arrowRight" size={14} />
    </button>
  )
}

/** A provider that is not set up: what is missing, and the link to where it is set up, instead of a list. */
function NotSetUp({ provider, onOpen }: { readonly provider: GenericProvider; readonly onOpen: () => void }) {
  return (
    <div className="px-5 py-7 text-center text-[13px] leading-relaxed text-ink-muted" data-testid="provider-needs-key" data-reason={provider.reason} data-status={provider.status}>
      <p className="mb-1 font-medium text-ink">{provider.notice.title}</p>
      <p>{provider.notice.body}</p>
      {provider.implication !== undefined && <p className="mt-1 text-[12px] text-ink-faint">{provider.implication}</p>}
      <SettingsLink provider={provider} onOpen={onOpen}>{provider.reason === "vault_locked" && provider.linkText === "Open Voice providers" ? "Open Keys & vault" : provider.linkText}</SettingsLink>
    </div>
  )
}

function ProviderProblem({ provider, source, refreshing, onOpen }: {
  readonly provider: GenericProvider
  readonly source: PickerSource
  readonly refreshing: boolean
  readonly onOpen: () => void
}) {
  return (
    <div role="alert" className="m-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-ink" data-testid="provider-error">
      <p>{provider.problem?.message ?? `${provider.label} could not be reached.`}</p>
      {provider.problem?.note !== undefined && provider.rows.length > 0 && <p className="text-[12px] text-ink-muted">{provider.problem.note}</p>}
      <div className="flex flex-wrap items-center gap-x-4">
        {source.retryProvider !== undefined && (
          <button
            type="button"
            data-testid="provider-retry"
            disabled={refreshing}
            onClick={() => source.retryProvider?.(provider.id)}
            className="mt-2 inline-flex min-h-8 items-center gap-1.5 text-voice underline-offset-4 hover:underline disabled:opacity-50 max-sm:min-h-11"
          >
            {refreshing ? <Spinner size={13} /> : <Icon name="reload" size={14} />}
            Retry
          </button>
        )}
        <SettingsLink provider={provider} onOpen={onOpen}>{provider.linkText}</SettingsLink>
      </div>
    </div>
  )
}

const localStateOf = (row: GenericRow, job: JobInfo | undefined): LocalState | undefined => {
  if (row.local === undefined) return undefined
  if (job?.state === "running") return "downloading"
  if (row.local.state === "installed" || job?.state === "succeeded") return "installed"
  return "not_installed"
}

const rowButton = "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 max-sm:size-10"

function Row({ source, row: line, index, active, selected, favourite, onSelect, onFocusRow }: {
  readonly source: PickerSource
  readonly row: Extract<ListRow, { kind: "entry" | "missing" }>
  readonly index: number
  readonly active: boolean
  readonly selected: boolean
  readonly favourite: boolean
  readonly onSelect: (key: string, choice: PickerChoice) => void
  readonly onFocusRow: (index: number) => void
}) {
  const { noun } = source
  const entry = line.kind === "entry" ? line.row : undefined
  const phase = source.useRowPhase(line.key)
  const dl = source.useDownload(line.key, entry)
  const tab = active ? 0 : -1
  const name = line.kind === "entry" ? line.row.name : line.name
  const providerId = line.kind === "entry" ? line.provider.id : line.providerId
  const provider = line.provider
  const providerLabel = provider?.label ?? providerId
  const usable = line.kind === "entry" && isUsable(line.provider)
  const local = entry === undefined ? undefined : localStateOf(entry, dl.job)
  const percent = local === "downloading" && dl.job !== undefined ? percentOf(dl.job) : undefined
  const canChoose = entry !== undefined && (entry.selectable || (entry.local !== undefined && local === "installed"))
  const select = () => {
    if (!usable || entry === undefined) return
    if (local === "not_installed") return void source.download?.(entry.key)
    if (local === "downloading") return
    if (canChoose) onSelect(entry.key, entry.choice)
  }
  const meta = entry === undefined ? missingMeta(provider, providerId) : entry.meta.join(" · ")
  const unlisted = entry !== undefined && !entry.listed
  const Action = source.RowAction
  return (
    <li
      className={cx(
        "group flex flex-wrap items-center gap-x-1 rounded-md pr-1 transition-colors duration-[120ms] hover:bg-surface-2 focus-within:bg-surface-2",
        phase !== undefined && "bg-surface-2"
      )}
      data-testid={`${noun}-row`}
      {...{ [`data-${noun}`]: line.key }}
      data-selected={selected || undefined}
      data-local={local}
      data-preview={phase}
      data-favourite={favourite || undefined}
      data-listed={unlisted ? "false" : undefined}
    >
      <button
        type="button"
        data-row-main=""
        data-index={index}
        tabIndex={tab}
        onFocus={() => onFocusRow(index)}
        onClick={select}
        // Not `disabled`: the arrow keys must still reach the row (its star still works).
        aria-disabled={!usable || (!canChoose && local === undefined) || undefined}
        aria-current={selected ? "true" : undefined}
        title={entry?.title}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left aria-disabled:cursor-default max-sm:h-11"
      >
        <ProviderMark id={providerId} label={providerLabel} />
        <span className={cx("shrink-0 truncate text-[14px] font-medium max-sm:max-w-[45%]", local === "not_installed" || entry === undefined || unlisted ? "text-ink-muted" : "text-ink")}>{name}</span>
        <span className="sr-only">, {providerLabel}{selected ? ", selected" : ""}{local === "not_installed" ? ", not downloaded: press to download" : ""}{unlisted ? ", not in the provider's list" : ""}</span>
        {selected && <Icon name="check" size={14} className="shrink-0 text-you" data-testid={`${noun}-selected`} />}
        {local === "downloading" ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 pr-1 font-mono text-[12px] text-ink-muted tabular-nums" data-testid={`${noun}-download-progress`}>
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
            <span aria-hidden="true">{dl.job?.phase === "unpack" ? "unpacking" : percent !== undefined ? `${percent}%` : "…"}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted" data-testid={`${noun}-meta`}>{meta}</span>
        )}
      </button>
      {local === "downloading" ? (
        <button type="button" tabIndex={tab} className={rowButton} aria-label={`Cancel the download of ${name}`} title="Cancel the download" onClick={() => source.cancelDownload?.(line.key)} data-action="cancel">
          <Icon name="close" size={15} />
        </button>
      ) : local === "not_installed" ? (
        <button
          type="button"
          tabIndex={tab}
          className={rowButton}
          disabled={dl.starting}
          aria-label={`Download ${name} (${formatMb(entry?.local?.sizeMb ?? 0)})`}
          title={`Download (${formatMb(entry?.local?.sizeMb ?? 0)})`}
          onClick={() => source.download?.(line.key)}
          data-action="download"
        >
          {dl.starting ? <Spinner size={13} /> : <Icon name="download" size={16} />}
        </button>
      ) : entry !== undefined && Action !== undefined ? (
        <Action row={entry} local={local} providerReady={line.kind === "entry" && line.provider.status === "ready"} active={active} />
      ) : null}
      <button
        type="button"
        tabIndex={tab}
        aria-pressed={favourite}
        aria-label={`Favourite ${name}`}
        title={favourite ? "Remove from favourites" : "Add to favourites"}
        onClick={() => source.toggleFavourite(line.key, name)}
        data-action="favourite"
        className={cx(
          rowButton,
          favourite ? "text-voice hover:text-voice" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        )}
      >
        <Icon name="star" size={16} fill={favourite ? "currentColor" : "none"} />
      </button>
      {entry?.usedByDevices !== undefined && (entry.usedBy.length > 0 || entry.usedByDevices.length > 0) && (
        <p className="basis-full truncate pb-1.5 pl-9 pr-2 text-[12px] text-ink-muted max-sm:pl-8" data-testid={`${noun}-used-by`}>
          <UsedBy assistants={entry.usedBy} devices={entry.usedByDevices} testId={`${noun}-used-by-text`} plain />
        </p>
      )}
    </li>
  )
}

/**
 * A model by name (docs/MODEL-PICKERS.md §6.3): the last row of a provider's list is a text field (Enter chooses what
 * is typed); in search results a row "Use “text” on <provider>" takes the search's own text. Nothing is sent to the
 * server: the page saves the assistant, and its own checks apply.
 */
function TypedRow({ source, row, index, active, onSelect, onFocusRow }: {
  readonly source: PickerSource
  readonly row: Extract<ListRow, { kind: "typed" | "use" }>
  readonly index: number
  readonly active: boolean
  readonly onSelect: (key: string, choice: PickerChoice) => void
  readonly onFocusRow: (index: number) => void
}) {
  const { noun } = source
  const provider = row.provider
  const tab = active ? 0 : -1
  const [text, setText] = useState("")
  const [problem, setProblem] = useState<string | undefined>()
  const helpId = useId()
  const choose = (value: string) => {
    const t = value.trim()
    if (source.typed === undefined) return
    if (t === "" || !validModelId(t)) return setProblem("A model name is 1 to 100 characters, without line breaks.")
    onSelect(`${provider.id}:${t}`, source.typed(provider.id, t))
  }
  if (row.kind === "use") {
    return (
      <li className="group flex items-center gap-1 rounded-md pr-1 transition-colors duration-[120ms] hover:bg-surface-2 focus-within:bg-surface-2" data-testid={`${noun}-use-row`} data-provider={provider.id}>
        <button type="button" data-row-main="" data-index={index} tabIndex={tab} onFocus={() => onFocusRow(index)} onClick={() => choose(row.text)} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left max-sm:h-11">
          <ProviderMark id={provider.id} label={provider.label} />
          <span className="min-w-0 truncate text-[14px] text-ink">Use <b className="font-medium">“{row.text}”</b> on {provider.label}</span>
          <Icon name="arrowRight" size={14} className="shrink-0 text-ink-muted" />
        </button>
      </li>
    )
  }
  return (
    <li className="mt-1 flex flex-col gap-1 rounded-md border-t border-line/60 px-2 pb-1.5 pt-2" data-testid={`${noun}-typed-row`} data-provider={provider.id}>
      <label htmlFor={`${helpId}-input`} className="text-[13px] font-medium text-ink-muted">Use a model by name…</label>
      <div className="flex items-center gap-2">
        <input
          id={`${helpId}-input`}
          type="text"
          data-row-main=""
          data-index={index}
          tabIndex={tab}
          value={text}
          onFocus={() => onFocusRow(index)}
          onChange={(e) => {
            setText(e.target.value)
            setProblem(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            e.preventDefault()
            choose(text)
          }}
          placeholder={provider.customModel?.placeholder}
          aria-describedby={`${helpId}-help`}
          aria-invalid={problem !== undefined || undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          data-testid={`${noun}-typed-input`}
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 text-base text-ink placeholder:text-ink-faint focus-visible:border-you sm:text-[13px] max-sm:h-11"
        />
        <button
          type="button"
          tabIndex={tab}
          onClick={() => choose(text)}
          disabled={text.trim() === ""}
          data-testid={`${noun}-typed-use`}
          className="inline-flex h-9 shrink-0 items-center rounded-md border border-line px-3 text-[13px] font-medium text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 max-sm:h-11"
        >
          Use
        </button>
      </div>
      {problem !== undefined && <p role="alert" className="text-[12px] text-danger">{problem}</p>}
      <p id={`${helpId}-help`} className="text-[12px] text-ink-faint">{provider.customModel?.help}</p>
    </li>
  )
}
