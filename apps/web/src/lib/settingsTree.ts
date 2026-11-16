import {
  type AssistantInfo,
  type Condition,
  type DeviceListInfo,
  type DeviceTypeInfo,
  evaluateCondition,
  type ModuleInfo,
  type SettingField,
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
  { slug: "assistants", title: "Assistants", description: "Who answers, and how: prompt, language model, hearing, voice and modules." },
  { slug: "devices", title: "Devices", description: "Where people talk, and which assistants answer there." },
  { slug: "shared", title: "Shared settings", description: "Shared settings are what you have. An assistant chooses what it uses." },
  { slug: "keys", title: "Keys & vault", description: "Where the keys are kept, and the vault that protects them.", server: "access" },
  { slug: "diagnostics", title: "Diagnostics", description: "Why it misbehaves.", server: "diagnostics" },
  { slug: "about", title: "About", description: "Version and connection." },
  { slug: "other", title: "Other", description: "Settings this page does not know where to put.", server: "general" }
]

/** The server groups whose pages are regrouped under Shared settings (docs/ASSISTANTS.md §2.4, §7.1). */
const SHARED_SERVER_GROUPS: ReadonlySet<string> = new Set(["agents", "speech", "voices", "modules"])

const groupOfServer = (group: SettingsGroup | undefined): string =>
  SHARED_SERVER_GROUPS.has(group ?? "general") ? "shared" : settingsGroups.find((g) => g.server === (group ?? "general"))?.slug ?? "other"

/** A page of the client itself (the registry's `settingsPages`). */
export interface ClientPageRef {
  readonly group: string
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly order: number
  /**
   * A page shown once per item of server data (`assistant`, `device`, `device-type`: one per assistant, device or
   * device type): not a page of its own; the tree places one page per item and the page reads its item from the path.
   */
  readonly perItem?: boolean
  /** False: reachable by its path only, not listed in the navigation (the wizard, the shared pages' extra parts). */
  readonly listed?: boolean
  /** An unlisted page that has its own back link to its category list, with this name ("Assistants"). */
  readonly backLabel?: string
  /** An unlisted page that keeps this listed page of its category marked current in the navigation. */
  readonly under?: string
  /** Wider than the usual page column (the Overview grid). */
  readonly wide?: boolean
}

export type PageSource =
  /** Settings from the server: sections (their fields placed here) and modules (switch, status, form, tools). */
  | { readonly kind: "server"; readonly sections: ReadonlyArray<SettingsSection>; readonly moduleIds: ReadonlyArray<string> }
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
  /** A chip after the title ("On" / "Off" on an assistant's page). */
  readonly chip?: { readonly text: string; readonly tone: "ok" | "off" }
  /** The page has its own back link to its category list, with this name ("Assistants"). */
  readonly backLabel?: string
  /** The listed page that stays marked current in the navigation while this one is open. */
  readonly under?: string
  /** A client page shown after the server content of this page (the speech models list under the Deepgram key). */
  readonly extra?: string
  readonly wide?: boolean
  /** Shown in the navigation. False for a device's page: reached from the device list, not listed itself. */
  readonly listed: boolean
  /** Only admin pages may change it. */
  readonly protected: boolean
  /** It has secret fields (a key icon while the vault is locked). */
  readonly hasSecrets: boolean
  /** Its saved values have problems, or its module is in error. */
  readonly hasErrors: boolean
  /** The server's `group/page` of the sections and modules placed here (`EngineStatus.reloadPendingFor` names them so). */
  readonly origins: ReadonlyArray<string>
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
  /** Admin: one (unlisted) defaults page per device type, one (unlisted) page per device. */
  readonly deviceTypes?: ReadonlyArray<Pick<DeviceTypeInfo, "kind" | "title">>
  readonly devices?: ReadonlyArray<Pick<DeviceListInfo, "id" | "name">>
  /** Admin: one listed page per assistant (after "All assistants"). */
  readonly assistants?: ReadonlyArray<Pick<AssistantInfo, "id" | "name" | "purpose" | "on">>
}

/**
 * The path of a device type's defaults page (`#settings/devices/type.web-voice`). The dot keeps it apart from device
 * pages: a `DeviceId` is letters, digits, `-` and `_` only, so no device (not even one called `type-web-voice`) has it.
 */
export const typePageId = (kind: string): string => `type.${kind}`

/** Whether a Devices path part is a device type's defaults page (`typePageId`), not a device. */
export const isTypePageId = (id: string | undefined): boolean => id?.startsWith("type.") === true

/** Every non-secret value of every section, by key (keys are global): what page and field conditions are judged on. */
export const savedValues = (sections: ReadonlyArray<SettingsSection>): ReadonlyMap<string, SettingValue> => {
  const values = new Map<string, SettingValue>()
  for (const s of sections) for (const [key, value] of Object.entries(s.form.values)) values.set(key, value)
  return values
}

// ---- Shared settings (docs/ASSISTANTS.md §2.4)

export interface SharedPageDef {
  readonly id: string
  readonly title: string
  readonly description: string
}

/** The pages of Shared settings in the mock-up's order. A page is listed only when something is placed on it. */
export const SHARED_PAGES: ReadonlyArray<SharedPageDef> = [
  { id: "home", title: "Home", description: "Where the house is. Modules and every assistant's prompt use these." },
  { id: "modules", title: "Modules", description: "The shared settings of each module. Every assistant with the module switched on uses them, unless it has its own." },
  { id: "accounts", title: "Language model accounts", description: "The language models this house can use. Each assistant picks one account and a model." },
  { id: "routing", title: "Routing", description: "Who a sentence is for, when no wake phrase was said. Used only on devices that let TypeSafe decide." },
  { id: "speech", title: "Speech recognition models", description: "The speech recognition engines and models this house has. Each assistant picks one on its Hearing tab." },
  { id: "providers", title: "Voice providers", description: "Where speech is made. Each assistant speaks with one voice of one provider." },
  { id: "limits", title: "Limits", description: "How much the assistant does at once, and how long it remembers." }
]

/**
 * Keys that moved onto the assistant (docs/ASSISTANTS.md §4.3): the server's sections may still carry them, but
 * nothing reads them any more, so the admin does not show them.
 */
export const ASSISTANT_OWNED_KEYS: ReadonlySet<string> = new Set([
  "LLM_PROVIDER",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MAX_TOKENS",
  "ANTHROPIC_EFFORT",
  "ANTHROPIC_THINKING",
  "ANTHROPIC_TIMEOUT_MS",
  "ANTHROPIC_WARM_UP",
  "SYSTEM_PROMPT",
  "MAX_TOOL_ROUNDS",
  "CONVERSATION_IDLE_MINUTES",
  "ASSISTANT_VOICE"
])
const isAssistantOwned = (key: string) => ASSISTANT_OWNED_KEYS.has(key) || key.startsWith("STT_") || key.startsWith("DEEPGRAM_EOT_")

/** The shared page a key of a section belongs on, by its key; `undefined`: by the section's own page. */
const SHARED_KEY_PAGE: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "accounts",
  ANTHROPIC_BASE_URL: "accounts",
  MAX_VOICE_SESSIONS: "limits",
  SESSION_DISCARD_MINUTES: "limits",
  DEEPGRAM_API_KEY: "speech",
  DEEPGRAM_MODEL: "speech"
}
const sharedPageOfKey = (key: string): string | undefined =>
  SHARED_KEY_PAGE[key] ?? (key.startsWith("OPENROUTER_") || key.startsWith("HOME_MODEL_") ? "accounts" : key.startsWith("HOME_") ? "home" : key.startsWith("TYPESAFE_") ? "routing" : undefined)

/** A field as shown on a shared page: always visible and plain (its switch, `LLM_PROVIDER`, no longer decides). */
const plain = (f: SettingField): SettingField => {
  const { visibleWhen: _v, advanced: _a, ...rest } = f as SettingField & { visibleWhen?: unknown; advanced?: unknown }
  return rest as SettingField
}

const sharedPageOfModule = (m: ModuleInfo): string =>
  m.kind === "agent" ? "accounts" : m.kind === "decider" ? "routing" : "modules"

/** Build the navigation from the server's sections and modules and the client's pages. */
export const buildSettingsTree = (input: TreeInput): ReadonlyArray<NavGroup> => {
  const pages = new Map<string, Array<NavPage>>()
  const add = (page: NavPage) => {
    const list = pages.get(page.group) ?? []
    list.push(page)
    pages.set(page.group, list)
  }

  // Sections and modules of the shared server groups are regrouped onto the shared pages (by key, so a server that
  // places them differently still lands them right); the rest keep their own category. Those sharing a page id within
  // a category are stacked on one page (in server order).
  const shared = new Map<string, { sections: Array<SettingsSection>; moduleIds: Array<string>; origins: Set<string> }>()
  const sharedPage = (id: string) => {
    const page = shared.get(id) ?? { sections: [], moduleIds: [], origins: new Set<string>() }
    shared.set(id, page)
    return page
  }
  const byPage = new Map<string, Array<SettingsSection>>()
  for (const s of input.sections) {
    const group = groupOfServer(s.group)
    if (group !== "shared") {
      const key = `${group}/${s.page?.id ?? s.id}`
      byPage.set(key, [...(byPage.get(key) ?? []), s])
      continue
    }
    const origin = `${s.group ?? "general"}/${s.page?.id ?? s.id}`
    // The fields go where their key says, else with their section's own page (a section a newer server adds).
    const own = s.group === "voices" || s.id === "voice-providers" ? "providers" : s.id === "home" ? "home" : s.id === "routing" ? "routing" : undefined
    const placed = new Map<string, Array<SettingField>>()
    for (const f of s.form.fields) {
      if (isAssistantOwned(f.key)) continue
      const dest = sharedPageOfKey(f.key) ?? own ?? `x-${s.page?.id ?? s.id}`
      placed.set(dest, [...(placed.get(dest) ?? []), sharedPageOfKey(f.key) !== undefined ? plain(f) : f])
    }
    for (const [dest, fields] of placed) {
      const page = sharedPage(dest)
      const { visibleWhen: _hidden, ...rest } = s
      page.sections.push({ ...rest, form: { ...s.form, fields } })
      page.origins.add(origin)
    }
  }
  for (const m of input.modules) {
    const page = sharedPage(sharedPageOfModule(m))
    page.moduleIds.push(m.id)
    page.origins.add(`${m.group ?? "modules"}/${m.id}`)
  }

  // The values pages and fields are judged on come from every section as the server sent it.
  const values = savedValues(input.sections)
  const holds = (condition: Condition | undefined) => condition === undefined || evaluateCondition(condition, (key) => values.get(key))
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
      source: { kind: "server", sections, moduleIds: [] },
      inUse: sections.every((s) => holds(s.visibleWhen)),
      listed: true,
      protected: sections.some((s) => s.protected === true),
      hasSecrets: sections.some((s) => s.form.fields.some((f) => f.type === "secret")),
      hasErrors: sections.some((s) => s.form.errors.length > 0),
      origins: [`${first.group ?? "general"}/${first.page?.id ?? first.id}`]
    })
  }

  const modulesById = new Map(input.modules.map((m) => [m.id, m]))
  const extraOf = (id: string) => input.clientPages.find((c) => c.group === "shared" && c.id === `${id}-extra`)
  const sharedOrder = [...SHARED_PAGES.map((p) => p.id), ...[...shared.keys()].filter((k) => !SHARED_PAGES.some((p) => p.id === k))]
  sharedOrder.forEach((id, i) => {
    const page = shared.get(id)
    const def = SHARED_PAGES.find((p) => p.id === id)
    const extra = extraOf(id)
    // "Modules" stays listed with nothing in it ("No modules"); the other pages exist when something is placed on them.
    if (page === undefined && !(id === "modules")) return
    if (page === undefined && def === undefined) return
    const sections = page?.sections ?? []
    const moduleIds = page?.moduleIds ?? []
    if (sections.length === 0 && moduleIds.length === 0 && extra === undefined && id !== "modules") return
    const forms = moduleIds.flatMap((m) => modulesById.get(m)?.settings ?? [])
    const placedSection = sections[0]
    add({
      group: "shared",
      id,
      title: def?.title ?? placedSection?.page?.title ?? placedSection?.title ?? id.replace(/^x-/, ""),
      description: def?.description ?? placedSection?.page?.description ?? placedSection?.description ?? "",
      order: i,
      source: { kind: "server", sections, moduleIds },
      inUse: true,
      ...(extra !== undefined ? { extra: extra.id } : {}),
      listed: true,
      protected: sections.some((s) => s.protected === true) || moduleIds.some((m) => modulesById.get(m)?.protected === true),
      hasSecrets: sections.some((s) => s.form.fields.some((f) => f.type === "secret")) || forms.some((f) => f.fields.some((x) => x.type === "secret")),
      hasErrors: sections.some((s) => s.form.errors.length > 0) || moduleIds.some((m) => modulesById.get(m)?.state === "error" || (modulesById.get(m)?.settings.errors.length ?? 0) > 0),
      origins: [...(page?.origins ?? [])]
    })
  })

  const perItem = (page: string) => input.clientPages.find((c) => c.perItem === true && c.id === page)
  const assistantPage = perItem("assistant")
  if (assistantPage !== undefined) {
    ;(input.assistants ?? []).forEach((a, i) => {
      add({
        group: assistantPage.group,
        id: a.id,
        title: a.name,
        ...(a.purpose !== "" ? { description: a.purpose } : {}),
        chip: a.on ? { text: "On", tone: "ok" } : { text: "Off", tone: "off" },
        backLabel: "Assistants",
        order: assistantPage.order + i,
        source: { kind: "client", id: assistantPage.id },
        inUse: true,
        listed: true,
        protected: false,
        hasSecrets: false,
        hasErrors: false,
        origins: []
      })
    })
  }
  const typePage = perItem("device-type")
  if (typePage !== undefined) {
    ;(input.deviceTypes ?? []).forEach((t, i) => {
      add({
        group: typePage.group,
        id: typePageId(t.kind),
        title: `Every ${t.title.toLowerCase().replace(/s$/, "")}`,
        order: typePage.order + i,
        source: { kind: "client", id: typePage.id },
        inUse: true,
        listed: false,
        protected: false,
        hasSecrets: false,
        hasErrors: false,
        origins: []
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
        order: devicePage.order + 100 + i,
        source: { kind: "client", id: devicePage.id },
        inUse: true,
        listed: false,
        protected: false,
        hasSecrets: false,
        hasErrors: false,
        origins: []
      })
    })
  }

  for (const c of input.clientPages) {
    if (c.perItem === true) continue
    // A client page that only completes a shared page is not a page of its own.
    if (c.group === "shared" && c.id.endsWith("-extra")) continue
    add({
      group: c.group,
      id: c.id,
      title: c.title,
      ...(c.description !== undefined ? { description: c.description } : {}),
      order: c.order,
      source: { kind: "client", id: c.id },
      inUse: true,
      listed: c.listed !== false,
      ...(c.backLabel !== undefined ? { backLabel: c.backLabel } : {}),
      ...(c.under !== undefined ? { under: c.under } : {}),
      ...(c.wide === true ? { wide: true } : {}),
      protected: false,
      hasSecrets: false,
      hasErrors: false,
      origins: []
    })
  }

  // An empty category is hidden.
  return settingsGroups.flatMap((g) => {
    const list = [...(pages.get(g.slug) ?? [])].sort((a, b) => a.order - b.order)
    return list.length === 0 ? [] : [{ slug: g.slug, title: g.title, description: g.description, pages: list }]
  })
}

// ---- Paths and deep links

/** `[]` = the top (the category list on a phone), `[category]`, `[category, page]`, `[category, page, tab]` (an assistant's tab). */
export type SettingsPath = ReadonlyArray<string>

const HASH = "#settings"

/** `#settings/speech/engine` → `["speech", "engine"]`; `#settings` → `[]`; anything else → undefined. */
export const parseSettingsHash = (hash: string): SettingsPath | undefined => {
  if (hash !== HASH && !hash.startsWith(`${HASH}/`)) return undefined
  return hash.slice(HASH.length).split("/").filter((p) => p.length > 0).map((p) => decodeURIComponent(p)).slice(0, 3)
}

export const formatSettingsHash = (path: SettingsPath): string =>
  [HASH, ...path.slice(0, 3).map((p) => encodeURIComponent(p))].join("/")

/**
 * A settings path the server still names by its old category (`voices/providers`: a voice provider's `settingsPath`),
 * as the page it moved to under Shared settings. Other paths are unchanged.
 */
export const currentSettingsPath = (path: ReadonlyArray<string>): SettingsPath => {
  const moved: Readonly<Record<string, string>> = { voices: "providers", speech: "speech", "language-model": "accounts", agents: "accounts", modules: "modules" }
  const page = path[0] === undefined ? undefined : moved[path[0]]
  return page === undefined ? path : ["shared", page]
}

export const samePath = (a: SettingsPath, b: SettingsPath) => a.length === b.length && a.every((x, i) => x === b[i])

/** The same category and page: a tab of one page is not another page (its edits stay across tabs). */
export const samePage = (a: SettingsPath, b: SettingsPath) => a[0] === b[0] && a[1] === b[1]

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

/** "Shared settings › Language model accounts" for the `reloadPendingFor` paths (server `group/page`) that the tree knows. */
export const describeServerPaths = (tree: ReadonlyArray<NavGroup>, paths: ReadonlyArray<string>): ReadonlyArray<{ readonly label: string; readonly path: SettingsPath }> => {
  const out: Array<{ label: string; path: SettingsPath }> = []
  for (const p of paths) {
    for (const group of tree) {
      const page = group.pages.find((x) => x.origins.includes(p))
      if (page === undefined) continue
      if (!out.some((o) => o.path[0] === group.slug && o.path[1] === page.id)) out.push({ label: `${group.title} › ${page.title}`, path: [group.slug, page.id] })
      break
    }
  }
  return out
}

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
  const leaving = to === "close" ? ui.settingsOpen : !ui.settingsOpen || !samePage(to, ui.settingsPath)
  if (ui.settingsDirty && leaving && !discard) return { settingsLeave: to }
  if (to === "close") return { settingsOpen: false, settingsDirty: false, settingsLeave: undefined }
  return { settingsOpen: true, settingsPath: to, settingsLeave: undefined, ...(leaving ? { settingsDirty: false } : {}) }
}
