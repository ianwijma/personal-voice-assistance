import {
  type Condition,
  type DeviceInfo,
  evaluateCondition,
  type FrontendKindInfo,
  type ModuleInfo,
  type SettingsGroup,
  type SettingsSection,
  type SettingValue
} from "@pva/protocol"

/**
 * The settings screen's navigation (docs/SETTINGS-UI.md §2, §3.1), as pure
 * functions: the category list, the pages in each category built from the
 * server's data (sections and modules place themselves with `group` / `page` /
 * `order`), deep-link paths (`#settings/<category>/<page>`), going back a
 * level, and the "leave without saving?" guard. The UI hard-codes only the
 * categories and their order; the client's own pages come from the registry.
 */

/** A category of the settings screen. `server`: the `SettingsGroup` whose sections and modules it shows. */
export interface GroupMeta {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly server?: SettingsGroup
}

/** The categories, in order. `other` collects sections of an unknown group (a newer server) and is shown only when non-empty. */
export const settingsGroups: ReadonlyArray<GroupMeta> = [
  { slug: "overview", title: "Overview", description: "What is set up, and what still needs doing." },
  { slug: "frontends", title: "Front ends", description: "The defaults for each kind of voice front end." },
  { slug: "devices", title: "Devices", description: "Every phone, tablet or computer that used the voice assistant." },
  { slug: "language-model", title: "Language model", description: "Who answers you.", server: "agents" },
  { slug: "speech", title: "Speech recognition", description: "How the assistant hears you.", server: "speech" },
  { slug: "voices", title: "Voices", description: "How the assistant sounds.", server: "voices" },
  { slug: "modules", title: "Modules", description: "What the assistant can do. Changes apply from the next turn.", server: "modules" },
  { slug: "keys", title: "Keys & vault", description: "Where the keys are kept, and the vault that protects them.", server: "access" },
  { slug: "diagnostics", title: "Diagnostics", description: "Why it misbehaves.", server: "diagnostics" },
  { slug: "about", title: "About", description: "Version and connection." },
  { slug: "other", title: "Other", description: "Settings this page does not know where to put.", server: "general" }
]

const groupOfServer = (group: SettingsGroup | undefined): string =>
  settingsGroups.find((g) => g.server === (group ?? "general"))?.slug ?? "other"

/** A page of the client itself (the registry's `settingsPages`). */
export interface ClientPageRef {
  readonly group: string
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly order: number
  /**
   * A page shown once per item of server data (`frontend`: one per front-end kind, `device`: one per device): not a
   * page of its own; the tree places one page per item and the page reads its item from the path.
   */
  readonly perItem?: boolean
}

export type PageSource =
  | { readonly kind: "sections"; readonly sections: ReadonlyArray<SettingsSection> }
  | { readonly kind: "module"; readonly moduleId: string }
  | { readonly kind: "client"; readonly id: string }

export interface NavPage {
  readonly group: string
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly order: number
  readonly source: PageSource
  /** False for a page whose `visibleWhen` does not hold (listed under "Not in use", e.g. "Set up Deepgram"). */
  readonly inUse: boolean
  /** Shown in the navigation. False for a device's page: reached from the device list, not listed itself. */
  readonly listed: boolean
  /** Only admin pages may change it. */
  readonly protected: boolean
  /** It has secret fields (a key icon while the vault is locked). */
  readonly hasSecrets: boolean
  /** Its saved values have problems, or its module is in error. */
  readonly hasErrors: boolean
}

export interface NavGroup {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly pages: ReadonlyArray<NavPage>
}

export interface TreeInput {
  readonly sections: ReadonlyArray<SettingsSection>
  readonly modules: ReadonlyArray<ModuleInfo>
  readonly clientPages: ReadonlyArray<ClientPageRef>
  /** Admin: one Front ends page per kind, one (unlisted) Devices page per device. */
  readonly frontends?: ReadonlyArray<FrontendKindInfo>
  readonly devices?: ReadonlyArray<DeviceInfo>
}

/** Every non-secret value of every section, by key (keys are global): what page and field conditions are judged on. */
export const savedValues = (sections: ReadonlyArray<SettingsSection>): ReadonlyMap<string, SettingValue> => {
  const values = new Map<string, SettingValue>()
  for (const s of sections) for (const [key, value] of Object.entries(s.form.values)) values.set(key, value)
  return values
}

const holds = (condition: Condition | undefined, values: ReadonlyMap<string, unknown>) =>
  condition === undefined || evaluateCondition(condition, (key) => values.get(key))

/** The module's category: by `group` when the server says, else by kind. */
export const moduleGroup = (m: ModuleInfo): string =>
  m.group !== undefined ? groupOfServer(m.group) : m.kind === "agent" || m.kind === "decider" ? "language-model" : "modules"

/** Build the navigation from the server's sections and modules and the client's pages. */
export const buildSettingsTree = (input: TreeInput): ReadonlyArray<NavGroup> => {
  const values = savedValues(input.sections)
  const pages = new Map<string, Array<NavPage>>()
  const add = (page: NavPage) => {
    const list = pages.get(page.group) ?? []
    list.push(page)
    pages.set(page.group, list)
  }

  // Sections: those sharing a page id within a group are stacked on one page (in server order).
  const byPage = new Map<string, Array<SettingsSection>>()
  for (const s of input.sections) {
    const key = `${groupOfServer(s.group)}/${s.page?.id ?? s.id}`
    byPage.set(key, [...(byPage.get(key) ?? []), s])
  }
  let index = 0
  for (const [key, sections] of byPage) {
    const first = sections[0]!
    const [group, id] = key.split("/") as [string, string]
    add({
      group,
      id,
      title: first.page?.title ?? first.title,
      ...(first.page?.description ?? first.description) !== undefined ? { description: (first.page?.description ?? first.description)! } : {},
      order: first.order ?? 1000 + index++,
      source: { kind: "sections", sections },
      inUse: sections.every((s) => holds(s.visibleWhen, values)),
      listed: true,
      protected: sections.some((s) => s.protected === true),
      hasSecrets: sections.some((s) => s.form.fields.some((f) => f.type === "secret")),
      hasErrors: sections.some((s) => s.form.errors.length > 0)
    })
  }

  // Modules: one page each, after the sections, in catalog order.
  input.modules.forEach((m, i) => {
    add({
      group: moduleGroup(m),
      id: m.id,
      title: m.name,
      description: m.description,
      order: 500 + i,
      source: { kind: "module", moduleId: m.id },
      inUse: true,
      listed: true,
      protected: m.protected === true,
      hasSecrets: m.settings.fields.some((f) => f.type === "secret"),
      hasErrors: m.state === "error" || m.settings.errors.length > 0
    })
  })

  const perItem = (page: string) => input.clientPages.find((c) => c.perItem === true && c.id === page)
  const frontendPage = perItem("frontend")
  if (frontendPage !== undefined) {
    ;(input.frontends ?? []).forEach((k, i) => {
      add({
        group: frontendPage.group,
        id: k.id,
        title: k.title,
        description: k.description,
        order: frontendPage.order + i,
        source: { kind: "client", id: frontendPage.id },
        inUse: true,
        listed: true,
        protected: false,
        hasSecrets: false,
        hasErrors: false
      })
    })
  }
  const devicePage = perItem("device")
  if (devicePage !== undefined) {
    ;(input.devices ?? []).forEach((d, i) => {
      add({
        group: devicePage.group,
        id: d.id,
        title: d.name,
        order: devicePage.order + i,
        source: { kind: "client", id: devicePage.id },
        inUse: true,
        listed: false,
        protected: false,
        hasSecrets: false,
        hasErrors: false
      })
    })
  }

  for (const c of input.clientPages) {
    if (c.perItem === true) continue
    add({
      group: c.group,
      id: c.id,
      title: c.title,
      ...(c.description !== undefined ? { description: c.description } : {}),
      order: c.order,
      source: { kind: "client", id: c.id },
      inUse: true,
      listed: true,
      protected: false,
      hasSecrets: false,
      hasErrors: false
    })
  }

  // An empty category is hidden, except Modules ("No modules").
  return settingsGroups.flatMap((g) => {
    const list = [...(pages.get(g.slug) ?? [])].sort((a, b) => a.order - b.order)
    return list.length === 0 && g.slug !== "modules" ? [] : [{ slug: g.slug, title: g.title, description: g.description, pages: list }]
  })
}

// ---- Paths and deep links

/** `[]` = the top (the category list on a phone), `[category]`, `[category, page]`. */
export type SettingsPath = ReadonlyArray<string>

const HASH = "#settings"

/** `#settings/speech/engine` → `["speech", "engine"]`; `#settings` → `[]`; anything else → undefined. */
export const parseSettingsHash = (hash: string): SettingsPath | undefined => {
  if (hash !== HASH && !hash.startsWith(`${HASH}/`)) return undefined
  return hash.slice(HASH.length).split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p)).slice(0, 2)
}

export const formatSettingsHash = (path: SettingsPath): string =>
  [HASH, ...path.slice(0, 2).map((p) => encodeURIComponent(p))].join("/")

export const samePath = (a: SettingsPath, b: SettingsPath) => a.length === b.length && a.every((x, i) => x === b[i])

export interface Resolved {
  readonly group: NavGroup | undefined
  readonly page: NavPage | undefined
}

/** The pages a category lists in the navigation. */
export const listedPages = (group: NavGroup): ReadonlyArray<NavPage> => group.pages.filter((p) => p.listed)

/**
 * What a path shows. On a wide screen (list + page) there is always a page: the category's first page, or the
 * first category. On a narrow one (drill-down) `[]` is the category list, `[category]` its page list (or its only
 * page), `[category, page]` the page. An unknown category or page resolves like its parent.
 */
export const resolveSettingsPath = (tree: ReadonlyArray<NavGroup>, path: SettingsPath, wide: boolean): Resolved => {
  const group = tree.find((g) => g.slug === path[0])
  if (group === undefined) {
    if (!wide) return { group: undefined, page: undefined }
    const first = tree[0]
    return { group: first, page: first === undefined ? undefined : listedPages(first)[0] }
  }
  const page = group.pages.find((p) => p.id === path[1])
  if (page !== undefined) return { group, page }
  const listed = listedPages(group)
  if (wide || listed.length === 1) return { group, page: listed[0] }
  return { group, page: undefined }
}

/**
 * One level up (the back button, Esc on a phone): `undefined` = close the settings. On a wide screen the list is
 * always in view, so up from anywhere is closing.
 */
export const parentPath = (tree: ReadonlyArray<NavGroup>, path: SettingsPath, wide: boolean): SettingsPath | undefined => {
  const { group, page } = resolveSettingsPath(tree, path, wide)
  if (group === undefined) return undefined
  // An unlisted page (a device) goes back to the list it was opened from, on any screen.
  if (page !== undefined && !page.listed) return [group.slug]
  if (wide) return undefined
  return page !== undefined && listedPages(group).length > 1 ? [group.slug] : []
}

/** "Speech recognition › Engine" for the `reloadPendingFor` paths (server groups) that the tree knows. */
export const describeServerPaths = (tree: ReadonlyArray<NavGroup>, paths: ReadonlyArray<string>): ReadonlyArray<{ readonly label: string; readonly path: SettingsPath }> =>
  paths.flatMap((p) => {
    const [server, id] = p.split("/") as [string, string | undefined]
    const slug = groupOfServer(server as SettingsGroup)
    const group = tree.find((g) => g.slug === slug)
    const page = group?.pages.find((x) => x.id === id)
    return group === undefined || page === undefined ? [] : [{ label: `${group.title} › ${page.title}`, path: [group.slug, page.id] }]
  })

// ---- Leaving a page with unsaved edits

export interface SettingsUi {
  readonly settingsOpen: boolean
  readonly settingsPath: SettingsPath
  /** The current page has unsaved edits. */
  readonly settingsDirty: boolean
  /** A navigation waiting for "Leave without saving?". */
  readonly settingsLeave?: SettingsPath | "close" | undefined
}

/**
 * The UI change for a navigation request: applied at once, or held for confirmation when the page has unsaved
 * edits (`discard`: the user confirmed). Closing keeps the last path, so the settings reopen where they were.
 */
export const navigateSettings = (ui: SettingsUi, to: SettingsPath | "close", discard = false): Partial<SettingsUi> => {
  const leaving = to === "close" ? ui.settingsOpen : !ui.settingsOpen || !samePath(to, ui.settingsPath)
  if (ui.settingsDirty && leaving && !discard) return { settingsLeave: to }
  if (to === "close") return { settingsOpen: false, settingsDirty: false, settingsLeave: undefined }
  return { settingsOpen: true, settingsPath: to, settingsLeave: undefined, ...(leaving ? { settingsDirty: false } : {}) }
}
