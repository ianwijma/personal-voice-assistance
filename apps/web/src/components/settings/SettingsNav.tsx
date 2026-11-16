"use client"
import type { ReactNode } from "react"
import type { NavGroup, NavPage, SettingsPath } from "@/lib/settingsTree.ts"
import { Icon } from "../ui/Icon.tsx"
import { cx } from "../ui/controls.tsx"

export interface NavBadges {
  readonly vaultLocked: boolean
  /** Open items in the Overview checklist. */
  readonly openItems: number
  /** Engine problems (shown on Overview and Diagnostics). */
  readonly engineProblems: boolean
  readonly dirtyPage: string | undefined
}

type MarkKind = "dirty" | "todo" | "error" | "lock"

/** What each mark means: its title, hidden text and legend entry. */
const MARK_TEXT: Record<MarkKind, string> = {
  dirty: "Unsaved changes",
  todo: "Something to set up",
  error: "A problem",
  lock: "Locked: unlock the keys to change"
}

/**
 * One mark, told apart by shape, not only by colour: a filled dot (unsaved), a hollow ring (to set up), "!" (a
 * problem) and a padlock (the keys are locked). Each has a title and hidden text.
 */
function Mark({ kind }: { readonly kind: MarkKind }) {
  const shape =
    kind === "dirty" ? <span aria-hidden="true" className="block size-2 rounded-full bg-voice" />
    : kind === "todo" ? <span aria-hidden="true" className="block size-2.5 rounded-full border-2 border-warn" />
    : kind === "error" ? <span aria-hidden="true" className="label block text-[11px] leading-none text-danger">!</span>
    : <Icon name="lock" size={14} className="block text-ink-faint" />
  return (
    <span className="inline-flex size-3.5 items-center justify-center" title={MARK_TEXT[kind]} data-mark={kind}>
      {shape}
      <span className="sr-only">({MARK_TEXT[kind].toLowerCase()})</span>
    </span>
  )
}

/** The marks after a page or category name (docs/SETTINGS-UI.md §3.1): unsaved edits, to set up, errors, key, padlock. */
function Marks({ dirty, error, padlock, dot }: { readonly dirty?: boolean; readonly error?: boolean; readonly padlock?: boolean; readonly dot?: boolean }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      {dirty === true && <Mark kind="dirty" />}
      {dot === true && <Mark kind="todo" />}
      {error === true && <Mark kind="error" />}
      {padlock === true && <Mark kind="lock" />}
    </span>
  )
}

/** Every kind of mark shown anywhere in the list now, in the order they appear after a name. */
const shownMarks = (tree: ReadonlyArray<NavGroup>, b: NavBadges): ReadonlyArray<MarkKind> => {
  const all = tree.map((g) => groupMarks(g, b))
  const kinds: Array<MarkKind> = []
  if (all.some((m) => m.dirty)) kinds.push("dirty")
  if (all.some((m) => m.dot)) kinds.push("todo")
  if (all.some((m) => m.error)) kinds.push("error")
  if (all.some((m) => m.padlock)) kinds.push("lock")
  return kinds
}

const groupMarks = (g: NavGroup, b: NavBadges) => ({
  dirty: b.dirtyPage !== undefined && g.pages.some((p) => `${g.slug}/${p.id}` === b.dirtyPage),
  error: g.pages.some((p) => p.hasErrors) || ((g.slug === "overview" || g.slug === "diagnostics") && b.engineProblems),
  // A logged-in admin may change everything; protected pages (and pages with keys) wait for the keys to be unlocked.
  padlock: b.vaultLocked && g.pages.some((p) => p.protected || p.hasSecrets),
  dot: g.slug === "overview" && b.openItems > 0
})

const pageMarks = (p: NavPage, b: NavBadges) => ({
  dirty: b.dirtyPage === `${p.group}/${p.id}`,
  error: p.hasErrors,
  padlock: b.vaultLocked && (p.protected || p.hasSecrets)
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
        // The current row: filled, with an amber edge; hover only lifts the text and a faint tint, so it never
        // looks like a second current row.
        current
          ? "bg-surface-2 text-ink shadow-[inset_2px_0_0_var(--color-voice)]"
          : muted
          ? "text-ink-faint hover:bg-surface-2/30 hover:text-ink"
          : "text-ink-muted hover:bg-surface-2/30 hover:text-ink"
      )}
    >
      {children}
    </button>
  )
}

/**
 * What the marks mean: every mark shown in the list has an entry (visible text, since a `title` does not work on
 * touch). Hidden from screen readers: each mark already says what it means.
 */
function MarksLegend({ tree, badges, className }: { readonly tree: ReadonlyArray<NavGroup>; readonly badges: NavBadges; readonly className?: string }) {
  const kinds = shownMarks(tree, badges)
  if (kinds.length === 0) return null
  return (
    <p className={cx("flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-muted", className)} aria-hidden="true" data-testid="marks-legend">
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5" data-legend={k}>
          <Mark kind={k} />
          {MARK_TEXT[k]}
        </span>
      ))}
    </p>
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
    <>
    <nav aria-label="Settings categories" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4 scrollbar-quiet" data-testid="settings-nav">
      {tree.map((g) => {
        const open = g.slug === group?.slug
        const listed = g.pages.filter((p) => p.listed)
        const { inUse, notInUse } = splitPages(listed)
        return (
          <div key={g.slug} className="flex flex-col gap-0.5">
            <Row current={open && listed.length <= 1} level={0} onClick={() => go([g.slug])} testId={`nav-${g.slug}`}>
              <span className="truncate">{g.title}</span>
              <Marks {...groupMarks(g, badges)} />
            </Row>
            {open && listed.length > 1 && (
              <div className="mb-1 flex flex-col gap-0.5">
                {inUse.map((p) => (
                  <Row key={p.id} current={p.id === page?.id || p.id === page?.under} level={1} onClick={() => go([g.slug, p.id])} testId={`nav-${g.slug}-${p.id}`}>
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
    {/* Outside the scrolling list, so the last line of the legend is never cut off. */}
    <MarksLegend tree={tree} badges={badges} className="shrink-0 border-t border-line/60 px-6 py-3" />
    </>
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
      <MarksLegend tree={tree} badges={badges} className="border-t border-line/60 px-5 py-4" />
    </nav>
  )
}

/** The phone's second level: a category's pages. */
export function SettingsPageList({ group, badges, go }: { readonly group: NavGroup; readonly badges: NavBadges; readonly go: (path: SettingsPath) => void }) {
  const { inUse, notInUse } = splitPages(group.pages.filter((p) => p.listed))
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
