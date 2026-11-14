"use client"
import type { ReactNode } from "react"
import type { NavGroup, NavPage, SettingsPath } from "@/lib/settingsTree.ts"
import { Icon } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"

export interface NavBadges {
  readonly admin: boolean
  readonly vaultLocked: boolean
  /** Open items in the Overview checklist. */
  readonly openItems: number
  /** Engine problems (shown on Overview and Diagnostics). */
  readonly engineProblems: boolean
  readonly dirtyPage: string | undefined
}

/** The marks after a page or category name (docs/SETTINGS-UI.md §3.1): unsaved edits, errors, padlock, key. */
function Marks({ dirty, error, padlock, keyIcon, dot }: { readonly dirty?: boolean; readonly error?: boolean; readonly padlock?: boolean; readonly keyIcon?: boolean; readonly dot?: boolean }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      {dirty === true && <span className="size-1.5 rounded-full bg-voice" title="Unsaved changes" data-mark="dirty" />}
      {dot === true && <span className="size-1.5 rounded-full bg-warn" title="Something to set up" data-mark="todo" />}
      {error === true && <span className="label text-[11px] text-danger" title="A problem" data-mark="error">!</span>}
      {keyIcon === true && <Icon name="key" size={14} className="text-ink-faint" aria-label="Keys locked" data-mark="key" />}
      {padlock === true && <Icon name="lock" size={14} className="text-ink-faint" aria-label="Protected" data-mark="lock" />}
    </span>
  )
}

const groupMarks = (g: NavGroup, b: NavBadges) => ({
  dirty: b.dirtyPage !== undefined && g.pages.some((p) => `${g.slug}/${p.id}` === b.dirtyPage),
  error: g.pages.some((p) => p.hasErrors) || ((g.slug === "overview" || g.slug === "diagnostics") && b.engineProblems),
  padlock: !b.admin && g.pages.some((p) => p.protected),
  keyIcon: b.vaultLocked && g.pages.some((p) => p.hasSecrets),
  dot: g.slug === "overview" && b.openItems > 0
})

const pageMarks = (p: NavPage, b: NavBadges) => ({
  dirty: b.dirtyPage === `${p.group}/${p.id}`,
  error: p.hasErrors,
  padlock: !b.admin && p.protected,
  keyIcon: b.vaultLocked && p.hasSecrets
})

function Row({ children, current, onClick, level, testId, muted = false }: {
  readonly children: ReactNode
  readonly current: boolean
  readonly onClick: () => void
  readonly level: 0 | 1
  readonly testId: string
  readonly muted?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      data-testid={testId}
      className={cx(
        "flex w-full items-center rounded-md text-left transition-colors duration-[120ms]",
        level === 0 ? "min-h-10 px-3 text-[14px]" : "min-h-9 pl-6 pr-3 text-[13px]",
        current ? "bg-surface-2 text-ink" : muted ? "text-ink-faint hover:bg-surface-2/60 hover:text-ink" : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
      )}
    >
      {children}
    </button>
  )
}

/** Pages in use first; pages not in use under "Not in use" as "Set up …". */
const splitPages = (pages: ReadonlyArray<NavPage>) => ({ inUse: pages.filter((p) => p.inUse), notInUse: pages.filter((p) => !p.inUse) })

/** The wide screen's category list: the current category expanded to its pages (an accordion). */
export function SettingsNavList({ tree, group, page, badges, go }: {
  readonly tree: ReadonlyArray<NavGroup>
  readonly group: NavGroup | undefined
  readonly page: NavPage | undefined
  readonly badges: NavBadges
  readonly go: (path: SettingsPath) => void
}) {
  return (
    <nav aria-label="Settings categories" className="flex flex-col gap-0.5" data-testid="settings-nav">
      {tree.map((g) => {
        const open = g.slug === group?.slug
        const { inUse, notInUse } = splitPages(g.pages)
        return (
          <div key={g.slug} className="flex flex-col gap-0.5">
            <Row current={open && g.pages.length <= 1} level={0} onClick={() => go([g.slug])} testId={`nav-${g.slug}`}>
              <span className="truncate">{g.title}</span>
              <Marks {...groupMarks(g, badges)} />
            </Row>
            {open && g.pages.length > 1 && (
              <div className="mb-1 flex flex-col gap-0.5">
                {inUse.map((p) => (
                  <Row key={p.id} current={p.id === page?.id} level={1} onClick={() => go([g.slug, p.id])} testId={`nav-${g.slug}-${p.id}`}>
                    <span className="truncate">{p.title}</span>
                    <Marks {...pageMarks(p, badges)} />
                  </Row>
                ))}
                {notInUse.length > 0 && <span className="label mt-1 pl-6 text-[10px] text-ink-faint">Not in use</span>}
                {notInUse.map((p) => (
                  <Row key={p.id} current={p.id === page?.id} level={1} muted onClick={() => go([g.slug, p.id])} testId={`nav-${g.slug}-${p.id}`}>
                    <span className="truncate">Set up {p.title}</span>
                    <Marks {...pageMarks(p, badges)} />
                  </Row>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

function DrillRow({ children, onClick, testId, muted = false }: { readonly children: ReactNode; readonly onClick: () => void; readonly testId: string; readonly muted?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className={cx("flex min-h-14 w-full items-center gap-2 px-5 text-left text-[15px] transition-colors duration-[120ms] active:bg-surface-2", muted ? "text-ink-muted" : "text-ink")}
      >
        {children}
        <Icon name="chevron" size={16} className="shrink-0 text-ink-faint" />
      </button>
    </li>
  )
}

/** The phone's first level: the categories, 56 px rows. */
export function SettingsCategoryList({ tree, badges, go }: { readonly tree: ReadonlyArray<NavGroup>; readonly badges: NavBadges; readonly go: (path: SettingsPath) => void }) {
  return (
    <nav aria-label="Settings categories" data-testid="settings-nav">
      <ul className="flex flex-col divide-y divide-line/60">
        {tree.map((g) => (
          <DrillRow key={g.slug} onClick={() => go([g.slug])} testId={`nav-${g.slug}`}>
            <span className="min-w-0 flex-1 truncate">{g.title}</span>
            <Marks {...groupMarks(g, badges)} />
          </DrillRow>
        ))}
      </ul>
    </nav>
  )
}

/** The phone's second level: a category's pages. */
export function SettingsPageList({ group, badges, go }: { readonly group: NavGroup; readonly badges: NavBadges; readonly go: (path: SettingsPath) => void }) {
  const { inUse, notInUse } = splitPages(group.pages)
  return (
    <nav aria-label={`${group.title} pages`} data-testid="settings-pages">
      <p className="px-5 pb-3 pt-1 text-[13px] text-ink-muted">{group.description}</p>
      <ul className="flex flex-col divide-y divide-line/60 border-y border-line/60">
        {inUse.map((p) => (
          <DrillRow key={p.id} onClick={() => go([group.slug, p.id])} testId={`nav-${group.slug}-${p.id}`}>
            <span className="min-w-0 flex-1 truncate">{p.title}</span>
            <Marks {...pageMarks(p, badges)} />
          </DrillRow>
        ))}
        {inUse.length === 0 && notInUse.length === 0 && <li className="px-5 py-4 text-[14px] text-ink-faint">Nothing here yet.</li>}
      </ul>
      {notInUse.length > 0 && (
        <>
          <p className="label px-5 pb-2 pt-5 text-[10px] text-ink-faint">Not in use</p>
          <ul className="flex flex-col divide-y divide-line/60 border-y border-line/60">
            {notInUse.map((p) => (
              <DrillRow key={p.id} onClick={() => go([group.slug, p.id])} testId={`nav-${group.slug}-${p.id}`} muted>
                <span className="min-w-0 flex-1 truncate">Set up {p.title}</span>
                <Marks {...pageMarks(p, badges)} />
              </DrillRow>
            ))}
          </ul>
        </>
      )}
    </nav>
  )
}
