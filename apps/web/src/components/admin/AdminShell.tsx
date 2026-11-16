"use client"
import { type RefObject, useEffect, useMemo, useRef, useState } from "react"
import { openChecklistItems } from "@/lib/setupChecklist.ts"
import {
  buildSettingsTree,
  formatSettingsHash,
  listedPages,
  type NavGroup,
  type NavPage,
  parentPath,
  parseSettingsHash,
  resolveSettingsPath,
  samePath,
  type SettingsPath
} from "@/lib/settingsTree.ts"
import { modulesInOrder } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { clientPage, settingsPages } from "@/ui/adminRegistry.ts"
import { useClient, useClientState } from "../context.tsx"
import { ReloadBar } from "../settings/ReloadBar.tsx"
import { ServerPage } from "../settings/ServerPage.tsx"
import { type NavBadges, SettingsCategoryList, SettingsNavList, SettingsPageList } from "../settings/SettingsNav.tsx"
import { Toasts } from "../Toasts.tsx"
import { Icon } from "../ui/Icon.tsx"
import { useDialog } from "../ui/Panel.tsx"
import { Button } from "../ui/controls.tsx"
import { AdminHeader } from "./AdminHeader.tsx"

const WIDE = "(min-width: 1024px)"

/** List + page from 1024 px; a drill-down below (phones and tablets, docs/SETTINGS-UI.md §3.1). */
const useWide = () => {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE).matches)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return wide
}

/**
 * The path lives in the URL hash (`/admin/#settings/speech/engine`), so a deep link opens a page and the browser's
 * back gesture goes up a level. Store → hash: each navigation pushes an entry. Hash → store: a deep link at load,
 * back and forward. No hash = the top (the first category on a wide screen, the category list on a phone).
 */
const useSettingsHash = () => {
  const client = useClient()
  useEffect(() => {
    let applying = false
    const fromHash = () => {
      const path = parseSettingsHash(window.location.hash) ?? []
      const ui = client.store.get().ui
      applying = true
      if (!samePath(path, ui.settingsPath)) client.settings(path)
      applying = false
    }
    fromHash()
    window.addEventListener("hashchange", fromHash)
    let last = client.store.get().ui
    const unsubscribe = client.store.subscribe(() => {
      const ui = client.store.get().ui
      if (ui.settingsPath === last.settingsPath && ui.settingsLeave === last.settingsLeave) return
      last = ui
      // A held navigation from back/forward ("Leave without saving?") keeps the hash where it went until decided.
      if (ui.settingsLeave !== undefined && applying) return
      const inHash = parseSettingsHash(window.location.hash) ?? []
      if (!samePath(inHash, ui.settingsPath)) {
        const hash = ui.settingsPath.length === 0 ? "" : formatSettingsHash(ui.settingsPath)
        window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${hash}`)
      }
    })
    const onUnload = (e: BeforeUnloadEvent) => {
      if (client.store.get().ui.settingsDirty) e.preventDefault()
    }
    window.addEventListener("beforeunload", onUnload)
    return () => {
      window.removeEventListener("hashchange", fromHash)
      window.removeEventListener("beforeunload", onUnload)
      unsubscribe()
    }
  }, [client])
}

/** The admin page after login: header, then the two-level settings screen (docs/SETTINGS-UI.md §3.1) as the page. */
export function AdminShell() {
  useSettingsHash()
  const client = useClient()
  const wide = useWide()
  const sections = useClientState((s) => s.sections)
  const modules = useClientState(modulesInOrder, shallowEqual)
  const frontends = useClientState((s) => s.frontends)
  const devices = useClientState((s) => s.devices)
  const assistants = useClientState((s) => s.assistants)
  const path = useClientState((s) => s.ui.settingsPath)
  const leave = useClientState((s) => s.ui.settingsLeave)
  const marks = useClientState(
    (s) => ({
      vaultLocked: s.vault.state === "locked",
      openItems: openChecklistItems(s),
      engineProblems: s.engine.problems.length > 0,
      dirty: s.ui.settingsDirty
    }),
    shallowEqual
  )
  const tree = useMemo(
    () => buildSettingsTree({ sections, modules, clientPages: settingsPages, frontends, devices, assistants }),
    [sections, modules, frontends, devices, assistants]
  )
  const { group, page } = resolveSettingsPath(tree, path, wide)
  const badges: NavBadges = { ...marks, dirtyPage: marks.dirty && page !== undefined ? `${page.group}/${page.id}` : undefined }
  const go = (to: SettingsPath) => client.settings(to)
  const parent = parentPath(tree, path, wide)
  const up = parent === undefined ? undefined : () => client.settings(parent)

  // Move focus to the new level's heading, so keyboard and screen-reader users follow the navigation: on a wide screen
  // the page column's visible title (the next Tab reaches the page's first control), on a phone the header's title.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    headingRef.current?.focus({ preventScroll: true })
  }, [group?.slug, page?.id])

  // Phone levels: the categories, a category's pages, a page.
  const level: "list" | "pages" | "page" = wide ? "page" : group === undefined ? "list" : page === undefined ? "pages" : "page"
  const backTo = up === undefined || group === undefined
    ? undefined
    : parent!.length === 0
    ? "Admin"
    : group.title
  const title = level === "list" ? "Admin" : level === "pages" ? group?.title ?? "Admin" : page?.title ?? "Admin"

  return (
    <div className="fixed inset-0 flex flex-col bg-bg pt-[env(safe-area-inset-top)]" data-testid="settings" data-level={level} style={{ height: "100dvh" }}>
      <button
        type="button"
        data-testid="skip-to-settings"
        onClick={() => (wide ? headingRef.current : contentRef.current)?.focus()}
        className="label fixed left-2 top-2 z-[80] -translate-y-24 rounded-md border border-you bg-surface px-3 py-2.5 text-ink focus:translate-y-[env(safe-area-inset-top)]"
      >
        Skip to settings
      </button>
      <AdminHeader
        back={!wide && backTo !== undefined ? { label: backTo, onClick: up! } : undefined}
        // On a page the full title is the page's own heading (wrapping); the header carries titles only for the lists.
        title={wide || level === "page" ? undefined : title}
        headingRef={headingRef}
      />
      <ReloadBar tree={tree} />
      {wide ? (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[260px] shrink-0 flex-col overflow-hidden border-r border-line">
            <SettingsNavList tree={tree} group={group} page={page} badges={badges} go={go} />
          </aside>
          <PageColumn group={group} page={page} up={up} titleRef={headingRef} />
        </div>
      ) : level === "list" ? (
        <div ref={contentRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] outline-none scrollbar-quiet">
          <SettingsCategoryList tree={tree} badges={badges} go={go} />
        </div>
      ) : level === "pages" && group !== undefined ? (
        <div ref={contentRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] pt-3 outline-none scrollbar-quiet">
          <SettingsPageList group={group} badges={badges} go={go} />
        </div>
      ) : (
        <PageColumn group={group} page={page} up={undefined} contentRef={contentRef} titleRef={headingRef} />
      )}
      <Toasts className="bottom-[calc(88px+env(safe-area-inset-bottom))]" />
      {leave !== undefined && <LeaveDialog loggingOut={leave === "close"} onStay={() => {
        client.store.dispatch({ type: "local/ui", patch: { settingsLeave: undefined } })
        // Back/forward already moved the hash: put it back where the page is.
        if (leave === "close") return
        const ui = client.store.get().ui
        const inHash = parseSettingsHash(window.location.hash) ?? []
        if (!samePath(inHash, ui.settingsPath)) {
          window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${formatSettingsHash(ui.settingsPath)}`)
        }
      }} onDiscard={() => {
        if (leave !== "close") return client.settings(leave, { discard: true })
        // Log out (held by the header's Log out button). The page's drafts stay, so the dirty flag stays until logging
        // out has worked (the session ends and the page goes); a failure leaves draft and guard in agreement.
        client.store.dispatch({ type: "local/ui", patch: { settingsLeave: undefined } })
        void client.adminLogout().then((result) => { // continuation(none): only reports its own failure
          if (!result.ok) client.store.dispatch({ type: "local/toast", message: result.error?.message ?? "Logging out failed.", tone: "error" })
        })
      }} />}
    </div>
  )
}

/** The page column: header, then the page (server data or a client page), scrolling on its own; max 680 px. */
function PageColumn({ group, page, up, titleRef, contentRef }: {
  readonly group: NavGroup | undefined
  readonly page: NavPage | undefined
  readonly up: (() => void) | undefined
  /** Wide screens: the visible title takes focus after a navigation. */
  readonly titleRef?: RefObject<HTMLHeadingElement | null>
  /** Phones: what "Skip to settings" focuses. */
  readonly contentRef?: RefObject<HTMLDivElement | null>
}) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [group?.slug, page?.id])
  if (page === undefined) return <div className="flex-1" />
  const Client = page.source.kind === "client" ? clientPage(page.group, page.source.id) : undefined
  const listedCount = group === undefined ? 0 : listedPages(group).length
  return (
    <div
      ref={(el) => {
        scroller.current = el
        if (contentRef !== undefined) contentRef.current = el
      }}
      tabIndex={contentRef !== undefined ? -1 : undefined}
      className="min-h-0 flex-1 overflow-y-auto outline-none scrollbar-quiet"
      data-testid="settings-page"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-5 pt-6 sm:px-8">
        <div className="mb-6 flex flex-col gap-1">
          {page.backLabel !== undefined && group !== undefined ? (
            <a href={formatSettingsHash([group.slug])} className="label mb-1 hidden min-h-8 items-center gap-1 self-start text-[10px] text-voice hover:underline lg:inline-flex" data-testid="page-back">
              <Icon name="back" size={14} /> {page.backLabel}
            </a>
          ) : up !== undefined && !page.listed && group !== undefined ? (
            <button type="button" onClick={up} className="label mb-1 hidden min-h-8 items-center gap-1 self-start text-[10px] text-voice hover:underline lg:inline-flex" data-testid="page-up">
              <Icon name="back" size={14} /> {group.title}
            </button>
          ) : (
            <div className="hidden items-center gap-2 lg:flex">
              {group !== undefined && listedCount > 1 && <span className="label text-[10px] text-ink-faint">{group.title}</span>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <h2
              ref={titleRef}
              tabIndex={titleRef !== undefined ? -1 : undefined}
              id="page-title"
              data-testid="page-title"
              className="self-start break-words rounded-sm text-[20px] font-medium leading-tight text-ink outline-offset-4"
            >
              {page.title}
            </h2>
            {page.chip !== undefined && (
              <span className={`label rounded-sm border px-1 text-[10px] leading-[16px] ${page.chip.tone === "ok" ? "border-ok/50 text-ok" : "border-line text-ink-faint"}`} data-testid="page-chip">{page.chip.text}</span>
            )}
          </div>
          {page.description !== undefined && <p className="text-[14px] text-ink-muted">{page.description}</p>}
        </div>
        {page.source.kind === "client"
          ? <div className={`flex flex-1 flex-col ${page.backLabel !== undefined ? "" : "pb-10"}`} data-testid={`page-${page.group}-${page.source.id === "device" || page.source.id === "frontend" || page.source.id === "assistant" ? page.source.id : page.id}`}>{Client !== undefined && <Client />}</div>
          : <ServerPage key={`${page.group}/${page.id}`} page={page} />}
      </div>
    </div>
  )
}

function LeaveDialog({ onStay, onDiscard, loggingOut }: { readonly onStay: () => void; readonly onDiscard: () => void; readonly loggingOut: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, true, onStay, "[data-stay]", { inertBackground: true })
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-bg/70 p-4 sm:items-center" data-testid="leave-dialog">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-text" className="w-full max-w-[400px] rounded-lg border border-line bg-surface p-5 shadow-panel">
        <h2 id="leave-title" className="text-[16px] font-medium text-ink">Leave without saving?</h2>
        <p id="leave-text" className="mt-1 text-[14px] text-ink-muted">The changes on this page are not saved yet.{loggingOut ? " Discarding them logs you out." : ""}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="md" variant="quiet" className="max-sm:h-11" onClick={onDiscard}>{loggingOut ? "Discard and log out" : "Discard changes"}</Button>
          <Button size="md" variant="primary" className="max-sm:h-11" onClick={onStay} data-stay="">Stay</Button>
        </div>
      </div>
    </div>
  )
}

