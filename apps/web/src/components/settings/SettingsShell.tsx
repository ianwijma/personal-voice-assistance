"use client"
import { type ComponentType, useEffect, useMemo, useRef, useState } from "react"
import { openChecklistItems } from "@/lib/setupChecklist.ts"
import {
  buildSettingsTree,
  formatSettingsHash,
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
import { settingsPages } from "@/ui/registry.ts"
import { useClient, useClientState } from "../context.tsx"
import { Icon } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"
import { useDialog } from "../ui/Panel.tsx"
import { ReloadBar } from "./ReloadBar.tsx"
import { ServerPage } from "./ServerPage.tsx"
import { type NavBadges, SettingsCategoryList, SettingsNavList, SettingsPageList } from "./SettingsNav.tsx"

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
 * The settings path lives in the URL hash (`#settings/speech/engine`), so a deep link opens a page and the
 * browser's back gesture goes up a level. Store → hash: each navigation pushes an entry; closing from the screen
 * goes back past the entries it pushed. Hash → store: a deep link at load, back and forward.
 */
const useSettingsHash = () => {
  const client = useClient()
  useEffect(() => {
    let pushed = 0
    let applying = false
    // Closing went back past our entries; if the page was opened on a settings link, that entry is a settings
    // hash too: drop it instead of reopening.
    let closing = false
    const fromHash = () => {
      const path = parseSettingsHash(window.location.hash)
      const ui = client.store.get().ui
      applying = true
      if (path !== undefined) {
        if (!ui.settingsOpen || !samePath(path, ui.settingsPath)) client.settings(path)
      } else if (ui.settingsOpen) {
        client.settings("close")
      }
      applying = false
    }
    fromHash()
    const onHash = () => {
      pushed = Math.max(0, pushed - 1)
      if (closing) {
        closing = false
        if (parseSettingsHash(window.location.hash) !== undefined) {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
        }
        return
      }
      fromHash()
    }
    window.addEventListener("hashchange", onHash)
    let last = client.store.get().ui
    const unsubscribe = client.store.subscribe(() => {
      const ui = client.store.get().ui
      if (ui.settingsOpen === last.settingsOpen && ui.settingsPath === last.settingsPath && ui.settingsLeave === last.settingsLeave) return
      const wasOpen = last.settingsOpen
      last = ui
      const inHash = parseSettingsHash(window.location.hash)
      const url = (hash: string) => `${window.location.pathname}${window.location.search}${hash}`
      if (ui.settingsOpen) {
        // A held navigation from back/forward ("Leave without saving?") keeps the hash where it went until decided.
        if (ui.settingsLeave !== undefined && applying) return
        if (inHash === undefined || !samePath(inHash, ui.settingsPath)) {
          window.history.pushState(null, "", url(formatSettingsHash(ui.settingsPath)))
          pushed++
        }
      } else if (wasOpen && inHash !== undefined) {
        if (pushed > 0) {
          const steps = pushed
          pushed = 0
          closing = true
          window.history.go(-steps)
        } else {
          window.history.replaceState(null, "", url(""))
        }
      }
    })
    const onUnload = (e: BeforeUnloadEvent) => {
      if (client.store.get().ui.settingsDirty) e.preventDefault()
    }
    window.addEventListener("beforeunload", onUnload)
    return () => {
      window.removeEventListener("hashchange", onHash)
      window.removeEventListener("beforeunload", onUnload)
      unsubscribe()
    }
  }, [client])
}

/** The settings screen: a full-screen layer opened from the gear button or "O". */
export function SettingsShell() {
  useSettingsHash()
  const open = useClientState((s) => s.ui.settingsOpen)
  return open ? <SettingsScreen /> : null
}

/** A client page by category and id (ids are unique within a category only: Speech › Models, Voices › Models). */
const clientPage = (group: string, id: string): ComponentType | undefined =>
  settingsPages.find((p) => p.group === group && p.id === id)?.component

function SettingsScreen() {
  const client = useClient()
  const wide = useWide()
  const sections = useClientState((s) => s.sections)
  const modules = useClientState(modulesInOrder, shallowEqual)
  const path = useClientState((s) => s.ui.settingsPath)
  const leave = useClientState((s) => s.ui.settingsLeave)
  const marks = useClientState(
    (s) => ({
      admin: s.vault.admin,
      vaultLocked: s.vault.state === "locked",
      openItems: openChecklistItems(s),
      engineProblems: s.engine.problems.length > 0,
      dirty: s.ui.settingsDirty
    }),
    shallowEqual
  )
  const tree = useMemo(() => buildSettingsTree({ sections, modules, clientPages: settingsPages }), [sections, modules])
  const { group, page } = resolveSettingsPath(tree, path, wide)
  const badges: NavBadges = { ...marks, dirtyPage: marks.dirty && page !== undefined ? `${page.group}/${page.id}` : undefined }
  const ref = useRef<HTMLDivElement>(null)
  const go = (to: SettingsPath) => client.settings(to)
  const up = () => {
    const parent = parentPath(tree, path, wide)
    client.settings(parent ?? "close")
  }
  useDialog(ref, true, up, "[data-initial-focus]")

  // Move focus to the new level's heading on a phone, so a screen reader follows the drill-down.
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!wide) headingRef.current?.focus({ preventScroll: true })
  }, [wide, group?.slug, page?.id])

  // Phone levels: the categories, a category's pages, a page.
  const level: "list" | "pages" | "page" = wide ? "page" : group === undefined ? "list" : page === undefined ? "pages" : "page"
  const back = wide || level === "list"
    ? undefined
    : level === "pages" || (group !== undefined && group.pages.length <= 1)
    ? "Settings"
    : group?.title ?? "Settings"
  const title = level === "list" ? "Settings" : level === "pages" ? group?.title ?? "Settings" : page?.title ?? "Settings"

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      data-testid="settings"
      data-level={level}
      className="fixed inset-0 z-50 flex flex-col bg-bg pt-[env(safe-area-inset-top)] animate-[pva-fade-in_160ms_var(--ease-out)]"
      style={{ height: "100dvh" }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-2 pr-2 sm:pl-4">
        {back !== undefined ? (
          <button
            type="button"
            onClick={up}
            className="inline-flex h-10 min-w-0 items-center gap-1 rounded-md pl-1 pr-2 text-[14px] text-voice transition-colors hover:bg-surface-2"
            data-testid="settings-back"
            aria-label={`Back to ${back}`}
          >
            <Icon name="back" size={20} className="shrink-0" />
            <span className="max-w-[9rem] truncate">{back}</span>
          </button>
        ) : (
          <span className="label pl-3 text-ink-muted">Settings</span>
        )}
        <h2 id="settings-title" ref={headingRef} tabIndex={-1} data-initial-focus="" className={cx("min-w-0 flex-1 truncate text-[15px] font-medium text-ink outline-none", wide && "sr-only")}>
          {wide ? `Settings: ${page?.title ?? ""}` : back === undefined ? "" : title}
        </h2>
        <button
          type="button"
          aria-label="Close settings"
          onClick={() => client.settings("close")}
          className="ml-auto inline-flex size-10 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={20} />
        </button>
      </header>
      <ReloadBar tree={tree} />
      {wide ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[260px] shrink-0 overflow-y-auto border-r border-line px-3 py-4 scrollbar-quiet">
            <SettingsNavList tree={tree} group={group} page={page} badges={badges} go={go} />
          </aside>
          <PageColumn group={group} page={page} />
        </div>
      ) : level === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] scrollbar-quiet">
          <SettingsCategoryList tree={tree} badges={badges} go={go} />
        </div>
      ) : level === "pages" && group !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] pt-3 scrollbar-quiet">
          <SettingsPageList group={group} badges={badges} go={go} />
        </div>
      ) : (
        <PageColumn group={group} page={page} />
      )}
      {leave !== undefined && <LeaveDialog onStay={() => {
        client.store.dispatch({ type: "local/ui", patch: { settingsLeave: undefined } })
        // Back/forward already moved the hash: put it back where the page is.
        const ui = client.store.get().ui
        const inHash = parseSettingsHash(window.location.hash)
        if (inHash === undefined || !samePath(inHash, ui.settingsPath)) {
          window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${formatSettingsHash(ui.settingsPath)}`)
        }
      }} onDiscard={() => client.settings(leave, { discard: true })} />}
    </div>
  )
}

/** The page column: header, then the page (server data or a client page), scrolling on its own; max 640 px. */
function PageColumn({ group, page }: { readonly group: NavGroup | undefined; readonly page: NavPage | undefined }) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [group?.slug, page?.id])
  if (page === undefined) return <div className="flex-1" />
  const Client = page.source.kind === "client" ? clientPage(page.group, page.source.id) : undefined
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scrollbar-quiet" data-testid="settings-page">
      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-5 pt-6 sm:px-8">
        <div className="mb-6 flex flex-col gap-1">
          <div className="hidden items-center gap-2 lg:flex">
            {group !== undefined && group.pages.length > 1 && <span className="label text-[10px] text-ink-faint">{group.title}</span>}
          </div>
          <h3 className="hidden text-[20px] font-medium leading-tight text-ink lg:block">{page.title}</h3>
          {page.description !== undefined && <p className="text-[14px] text-ink-muted">{page.description}</p>}
        </div>
        {page.source.kind === "client"
          ? <div className="flex-1 pb-10" data-testid={`page-${page.group}-${page.id}`}>{Client !== undefined && <Client />}</div>
          : <ServerPage key={`${page.group}/${page.id}`} page={page} />}
      </div>
    </div>
  )
}

function LeaveDialog({ onStay, onDiscard }: { readonly onStay: () => void; readonly onDiscard: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, true, onStay, "[data-stay]")
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-bg/70 p-4 sm:items-center" data-testid="leave-dialog">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-text" className="w-full max-w-[400px] rounded-lg border border-line bg-surface p-5 shadow-panel">
        <h2 id="leave-title" className="text-[16px] font-medium text-ink">Leave without saving?</h2>
        <p id="leave-text" className="mt-1 text-[14px] text-ink-muted">The changes on this page are not saved yet.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="md" variant="quiet" onClick={onDiscard}>Discard changes</Button>
          <Button size="md" variant="primary" onClick={onStay} data-stay="">Stay</Button>
        </div>
      </div>
    </div>
  )
}
