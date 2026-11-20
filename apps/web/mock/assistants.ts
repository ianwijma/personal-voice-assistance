/**
 * The mock's assistants, device types and device settings (protocol 7, docs/ASSISTANTS.md §5): held in memory, with the
 * rev check, the validation of `@pva/protocol` and the sample data of the admin mock-up (Jeff, T3, Keuken). The server
 * (`server.ts`) does the access check and the pushes; this module answers the messages.
 */
import {
  type Assignment,
  type Assistant,
  type AssistantBody,
  type AssistantInfo,
  assistantUsedOn,
  BUILT_IN_VOICE_NODE_SETTINGS,
  BUILT_IN_WEB_VOICE_SETTINGS,
  type DeviceOwn,
  type DeviceSettings,
  type DeviceSettingsPatch,
  type DeviceTarget,
  type DeviceTypeDefinition,
  type DeviceTypeInfo,
  type ErrorInfo,
  type FieldError,
  type Issue,
  effectiveDeviceSettings,
  hearerOf,
  MAX_ASSISTANTS,
  makeAssistantId,
  type ModuleInfo,
  type ModuleOffer,
  removeAssistantFromSettings,
  validateAssistant,
  validateDeviceSettings,
  VOICE_NODE_DEVICE_TYPE,
  VOICE_NODE_KIND,
  WEB_VOICE_DEVICE_TYPE,
  WEB_VOICE_KIND
} from "@pva/protocol"

export interface AssistantResult {
  readonly ok: boolean
  readonly error?: ErrorInfo
  readonly assistantId?: string
}

const OK: AssistantResult = { ok: true }

/**
 * The server's `withPlacement` (apps/assistant/src/serve/assistants.ts): the assistant added to the list; one already
 * in it (a device following its type, placed on the type first) gets the phrase instead of a second entry.
 */
export const withPlacement = (list: ReadonlyArray<Assignment>, id: string, phrase: string | undefined): ReadonlyArray<Assignment> => {
  const existing = list.find((x) => x.assistant === id)
  if (existing === undefined) return [...list, { assistant: id, phrases: phrase !== undefined ? [phrase] : [] }]
  if (phrase === undefined || existing.phrases.includes(phrase)) return list
  return list.map((x) => (x === existing ? { ...x, phrases: [...x.phrases, phrase] } : x))
}
const fail = (code: ErrorInfo["code"], message: string, extra: { readonly fieldErrors?: ReadonlyArray<FieldError>; readonly warnings?: ReadonlyArray<FieldError> } = {}): AssistantResult => ({
  ok: false,
  error: { code, message, ...extra }
})
const fieldErrorsOf = (issues: ReadonlyArray<Issue>): ReadonlyArray<FieldError> => issues.map((i) => ({ key: i.path, message: i.message }))
const SPECIFIC = ["duplicate_phrase", "unknown_assistant", "limit_reached"] as const
const refusal = (issues: ReadonlyArray<Issue>): AssistantResult => {
  const specific = issues.find((i) => (SPECIFIC as ReadonlyArray<string>).includes(i.code))
  return fail((specific?.code ?? "invalid_settings") as ErrorInfo["code"], (specific ?? issues[0])?.message ?? "Some settings are not valid.", { fieldErrors: fieldErrorsOf(issues) })
}

const clone = <T>(x: T): T => structuredClone(x)

const hearingOf = (model: string, language: "auto" | "en" | "nl", early: number, final: number, minSpeech: number, threshold: number) => ({
  engine: "sherpa" as const,
  model,
  language,
  eagerSilenceMs: early,
  finalSilenceMs: final,
  minSpeechMs: minSpeech,
  agc: true,
  agcMaxGainDb: 30,
  vadThreshold: threshold,
  deepgram: { eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 5000 }
})

/** The admin mock-up's three assistants (docs/mockups/assistants/admin.html), on the modules the mock has. */
export const seedAssistants = (): Array<Assistant> => [
  {
    id: "jeff",
    rev: 0,
    name: "Jeff",
    purpose: "Everyday questions and the house.",
    handles: "General questions, the weather and the time, and switching things in the house on and off.",
    on: true,
    prompt: "You are Jeff, the voice assistant of our house. Answer in one or two short sentences: your replies are spoken. When a question is about the house, use Home Assistant. If you are not sure what was meant, ask one short question.",
    toolRounds: 5,
    followUpSeconds: 8,
    newConversationAfter: 10,
    replyEarly: true,
    confirmActions: "off",
    llm: { account: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off", maxTokens: 1024, giveUpMs: 5000, warmUp: true, useModules: true, freshSessionAfterMinutes: 30 },
    hearing: hearingOf("parakeet-v2", "en", 250, 600, 100, 0.5),
    voice: { provider: "sherpa", voiceId: "en_US-lessac-medium" },
    modules: { clock: { on: true, offTools: [] }, weather: { on: true, offTools: [] }, "home-assistant": { on: true, offTools: [] }, notes: { on: false, offTools: [] } }
  },
  {
    id: "t3",
    rev: 0,
    name: "T3",
    purpose: "Talks to my T3 Code instance: starts and checks coding work.",
    handles: "Anything about coding work: starting, checking or messaging threads in T3 Code.",
    on: true,
    prompt: "You are T3. You talk to my T3 Code instance: start coding work, check on it and read back what it says. Keep spoken replies short. When a thread is still running, say so and offer to check again later.",
    toolRounds: 8,
    followUpSeconds: 30,
    newConversationAfter: "never",
    replyEarly: false,
    confirmActions: "off",
    llm: { account: "claude-subscription", model: "claude-sonnet-5-5", effort: "medium", thinking: "adaptive", maxTokens: 2048, giveUpMs: 8000, warmUp: true, useModules: true, freshSessionAfterMinutes: 30 },
    hearing: hearingOf("parakeet-v2", "en", 250, 600, 100, 0.5),
    voice: { provider: "sherpa", voiceId: "kokoro-af_heart" },
    modules: { clock: { on: true, offTools: [], own: { locale: "en-US" } }, notes: { on: true, offTools: [] } }
  },
  {
    id: "keuken",
    rev: 0,
    name: "Keuken",
    purpose: "Dutch kitchen helper: timers, recipes, shopping list.",
    handles: "Cooking and the kitchen, usually in Dutch: timers, recipes and the shopping list.",
    on: true,
    prompt: "Je bent Keuken, de hulp in onze keuken. Antwoord kort en in het Nederlands. Je zet timers, helpt met recepten stap voor stap en houdt de boodschappenlijst bij.",
    toolRounds: 5,
    followUpSeconds: 0,
    newConversationAfter: 30,
    replyEarly: true,
    confirmActions: "off",
    llm: { account: "home-model", model: "qwen3-14b", effort: "low", thinking: "off", maxTokens: 768, giveUpMs: 6000, warmUp: true, useModules: true, freshSessionAfterMinutes: 30 },
    hearing: hearingOf("nemotron-320", "nl", 300, 800, 120, 0.45),
    voice: { provider: "sherpa", voiceId: "nl_NL-pim-medium" },
    modules: { clock: { on: true, offTools: [] }, notes: { on: true, offTools: [] } }
  }
]

/** The sample devices' own settings: the kitchen iPad has its own list; the others follow the type's defaults. */
const seedTypeSettings = (): DeviceSettings => ({
  ...BUILT_IN_WEB_VOICE_SETTINGS,
  assistants: [{ assistant: "jeff", phrases: [] }, { assistant: "t3", phrases: ["Hey T3", "Hey tee three"] }],
  withoutPhrase: { mode: "assistant", assistant: "jeff" },
  voicePage: { pick: true },
  captions: { captions: true, speakTyped: true } // as the built-in (and the old `speakReplies`): the voice page speaks replies to typed text
})

const LONG_PHRASE = "hello my personal voice assistant please"

/** `longPhrase`: the scenario with a living-room tablet whose list holds a six-word phrase (the UI must not cut or jump on it). */
const seedDeviceOwn = (longPhrase = false): Map<string, { own: DeviceOwn; rev: number }> =>
  new Map([
    ...(longPhrase ? [["d-living-room-0003", { rev: 0, own: { assistants: [{ assistant: "t3", phrases: [LONG_PHRASE, "hey computer", "ok house"] }, { assistant: "jeff", phrases: [] }] } }] as [string, { own: DeviceOwn; rev: number }]] : []),
    ["d-kitchen-ipad-0001", { rev: 0, own: { assistants: [{ assistant: "jeff", phrases: ["Hey Jeff"] }, { assistant: "keuken", phrases: ["Hé keuken", "Hey keuken"], followUpSeconds: 15 }], captions: { captions: false, speakTyped: false } } }]
  ])

/** The person the sample phone belongs to (mock/server.ts seeds Members with Sam and Robin). */
export const SAM_ID = "p-sam00001"

/** The device types the mock knows (the real server's `DEVICE_TYPES`); the voice-node one is listed only when the server says so. */
const DEFS: ReadonlyArray<DeviceTypeDefinition> = [WEB_VOICE_DEVICE_TYPE, VOICE_NODE_DEVICE_TYPE]
const defOf = (kind: string): DeviceTypeDefinition => DEFS.find((d) => d.kind === kind) ?? WEB_VOICE_DEVICE_TYPE

/** A type's saved defaults. `saved: false`: never saved (the voice-node type before its first pairing seeds it, §3.4). */
interface TypeState {
  settings: DeviceSettings
  rev: number
  saved: boolean
}
const seedTypes = (): Map<string, TypeState> =>
  new Map([
    [WEB_VOICE_KIND, { settings: seedTypeSettings(), rev: 0, saved: true }],
    [VOICE_NODE_KIND, { settings: clone(BUILT_IN_VOICE_NODE_SETTINGS), rev: 0, saved: false }]
  ])

export interface Known {
  readonly id: string
  readonly name: string
}

export interface AssistantsMock {
  readonly reset: (longPhrase?: boolean) => void
  readonly assistants: () => ReadonlyArray<Assistant>
  readonly infos: (devices: ReadonlyArray<Known>) => Array<AssistantInfo>
  readonly deviceTypes: () => Array<DeviceTypeInfo>
  /** Voice key → the devices (and the type's defaults) whose effective voice is their own, as the real server lists them. */
  readonly voiceUsers: (devices: ReadonlyArray<Known>) => ReadonlyMap<string, Array<{ target: DeviceTarget; name: string }>>
  /** A device's protocol 7 fields. */
  readonly deviceFields: (id: string) => { own: DeviceOwn; settings: DeviceSettings; hearer: string | null; rev: number }
  readonly create: (message: { assistant: AssistantBody; copyOf?: string | undefined; placements?: ReadonlyArray<{ target: DeviceTarget; phrase?: string | undefined }> | undefined }, devices: ReadonlyArray<Known>) => AssistantResult
  readonly save: (message: { assistant: Assistant }) => AssistantResult
  readonly remove: (message: { id: string; rev: number }, devices: ReadonlyArray<Known>) => AssistantResult
  readonly saveDevice: (message: { target: DeviceTarget; rev: number; settings: DeviceSettingsPatch; saveAnyway?: boolean | undefined }) => AssistantResult
  /** Another admin changed an assistant: the fields of `patch` are set and the rev goes up. */
  readonly touch: (id: string, patch: Partial<AssistantBody>) => boolean
  /** A device was forgotten: its own settings go. */
  readonly forgetDevice: (id: string) => void
  /**
   * Protocol 12, the first `node.pair.create` (docs/VOICE-NODES.md §3.4): while the voice-node type was never saved, its
   * defaults become the browsers' assistants without their follow-up values, the browsers' matching, nobody without a
   * phrase. Nothing when the browsers have no assistant. True when it seeded.
   */
  readonly seedNodeType: () => boolean
  /** Set a type's defaults as if the owner had saved them (scenario data). */
  readonly setTypeSettings: (kind: string, settings: Partial<DeviceSettings>) => void
  /** Protocol 11: people removed from Members are no device's default person any more. True when something changed. */
  readonly clearDefaultPeople: (known: ReadonlySet<string>) => boolean
}

/** What the server knows about modules that the assistants' checks need (mock/server.ts gives it). */
export interface ModuleCatalog {
  readonly modules: () => ReadonlyArray<ModuleInfo>
  /** The tool names a capability module has when it runs (known also while nobody has it switched on). */
  readonly toolNames: (moduleId: string) => ReadonlyArray<string>
  /** `ModuleHost.checkOwn`: the module's own fields refuse a value (field errors keyed by the field). */
  readonly checkOwn: (moduleId: string, own: Readonly<Record<string, unknown>>) => ReadonlyArray<{ readonly field: string; readonly message: string }>
  /** The problem of a language-model account that is not set up (OpenRouter without a key, the home model without an address). */
  readonly accountProblem: (account: string) => string | undefined
  /** A remembered device's kind (default: a browser). */
  readonly kindOf?: (deviceId: string) => string | undefined
  /** Whether the voice-node type is listed (the node scenarios). */
  readonly nodeTypeListed?: () => boolean
  /** Protocol 11: whether a person id is in Members (a `place.defaultPerson` must be, as on the server). */
  readonly isPerson?: (id: string) => boolean
}

export const createAssistantsMock = (catalog: ModuleCatalog): AssistantsMock => {
  const modules = catalog.modules
  let assistants = seedAssistants()
  let types = seedTypes()
  let deviceOwn = seedDeviceOwn()
  const typeOf = (kind: string): TypeState => types.get(kind) ?? types.get(WEB_VOICE_KIND)!
  const listedDefs = (): ReadonlyArray<DeviceTypeDefinition> => DEFS.filter((d) => d.kind === WEB_VOICE_KIND || catalog.nodeTypeListed?.() === true)
  const listed = (kind: string) => listedDefs().some((d) => d.kind === kind)
  const kindOfDevice = (id: string): string => catalog.kindOf?.(id) ?? WEB_VOICE_KIND

  /** The capability modules the assistants can switch on (running or not: a module runs while one assistant has it on). */
  const offers = (): Record<string, ModuleOffer> =>
    Object.fromEntries(
      modules().filter((m) => m.kind === "capability").map((m) => [
        m.id,
        { overridable: m.settings.fields.filter((f) => f.overridable === true && f.type !== "secret").map((f) => f.key), tools: [...catalog.toolNames(m.id)] } satisfies ModuleOffer
      ])
    )

  /** `validateAssistant` as the real server uses it, plus the module fields' own checks of `own` values (`modules.<id>.own.<field>`). */
  const issues = (body: AssistantBody & { readonly id?: string }): ReadonlyArray<Issue> => {
    const out = [...validateAssistant(body, { others: assistants, modules: offers() })]
    for (const [moduleId, choice] of Object.entries(body.modules)) {
      const allowed = offers()[moduleId]?.overridable ?? []
      const own = Object.fromEntries(Object.entries(choice.own ?? {}).filter(([k]) => allowed.includes(k)))
      for (const e of catalog.checkOwn(moduleId, own)) out.push({ code: "invalid", path: `modules.${moduleId}.own.${e.field}`, message: e.message })
    }
    return out
  }

  const effective = (own: DeviceOwn | undefined, kind: string = WEB_VOICE_KIND): DeviceSettings => effectiveDeviceSettings(defOf(kind).builtIn, typeOf(kind).settings, own)

  const mock: AssistantsMock = {
    reset: (longPhrase = false) => {
      assistants = seedAssistants()
      types = seedTypes()
      deviceOwn = seedDeviceOwn(longPhrase)
    },
    assistants: () => assistants,
    voiceUsers: (devices) => {
      const out = new Map<string, Array<{ target: DeviceTarget; name: string }>>()
      const add = (settings: DeviceSettings, target: DeviceTarget, name: string) => {
        if (settings.voice.from !== "device") return
        const key = `${settings.voice.voice.provider}:${settings.voice.voice.voiceId}`
        out.set(key, [...(out.get(key) ?? []), { target, name }])
      }
      for (const def of listedDefs()) add(typeOf(def.kind).settings, { kind: "type", type: def.kind }, `Every ${def.one}`)
      for (const d of devices) add(effective(deviceOwn.get(d.id)?.own, kindOfDevice(d.id)), { kind: "device", id: d.id }, d.name)
      return out
    },
    infos: (devices) => {
      const entries = [
        ...listedDefs().map((def) => ({ target: { kind: "type", type: def.kind } as DeviceTarget, settings: typeOf(def.kind).settings })),
        ...devices.map((d) => ({ target: { kind: "device", id: d.id } as DeviceTarget, settings: effective(deviceOwn.get(d.id)?.own, kindOfDevice(d.id)) }))
      ]
      const nameOf = (t: DeviceTarget) => (t.kind === "type" ? defOf(t.type).title : devices.find((d) => d.id === t.id)?.name ?? t.id)
      return assistants.map((a) => {
        const usedOn = assistantUsedOn(a.id, entries)
        const used = a.on && usedOn.length > 0
        const problems = [
          ...(usedOn.length === 0 ? ["Not used on any device."] : []),
          ...usedOn.filter((u) => u.reach === "unreachable").map((u) => `Cannot be reached on ${nameOf(u.target)}: no wake phrase and not the one that answers without a phrase.`)
        ]
        const state = used ? "ready" : "unused"
        // As the real server (WP-13b): an account that is not set up fails its instance with this problem.
        const accountProblem = used ? catalog.accountProblem(a.llm.account) : undefined
        return {
          ...clone(a),
          usedOn: [...usedOn],
          resources: { llm: accountProblem !== undefined ? "failed" : state, voice: state },
          problems: accountProblem !== undefined ? [...problems, `Language model (${a.llm.account}): ${accountProblem}`] : problems
        }
      })
    },
    deviceTypes: () =>
      listedDefs().map((def) => ({
        kind: def.kind,
        title: def.title,
        one: def.one,
        many: def.many,
        description: def.description,
        keys: [...def.keys],
        settings: clone(typeOf(def.kind).settings),
        rev: typeOf(def.kind).rev,
        ...(def.followUpUnset !== undefined ? { followUpUnset: def.followUpUnset } : {})
      })),
    deviceFields: (id) => {
      const record = deviceOwn.get(id)
      const settings = effective(record?.own, kindOfDevice(id))
      return { own: clone(record?.own ?? {}), settings: clone(settings), hearer: hearerOf(settings), rev: record?.rev ?? 0 }
    },
    create: ({ assistant, copyOf, placements }, devices) => {
      if (assistants.length >= MAX_ASSISTANTS) return fail("limit_reached", `There can be at most ${MAX_ASSISTANTS} assistants.`)
      if (copyOf !== undefined && !assistants.some((a) => a.id === copyOf)) return fail("unknown_assistant", `There is no assistant ${copyOf} to start from.`)
      const found = issues(assistant)
      if (found.length > 0) return refusal(found)
      const id = makeAssistantId(assistant.name, assistants.map((a) => a.id))
      // Placements (the wizard's Where step): the assistant is appended to each target's list, with its phrase. A device
      // that followed its type's defaults gets its own list (the type's, then this). Refused as a whole if a phrase clashes.
      const known = new Set([...assistants.map((a) => a.id), id])
      const nextTypes = new Map([...types].map(([k, t]) => [k, t.settings]))
      const nextOwn = new Map(deviceOwn)
      for (const p of placements ?? []) {
        const phrase = p.phrase === undefined || p.phrase.trim() === "" ? undefined : p.phrase.trim()
        if (p.target.kind === "type") {
          const kind = p.target.type
          if (!listed(kind)) return fail("unknown_device", `No device type ${kind}.`)
          const next = { ...nextTypes.get(kind)!, assistants: withPlacement(nextTypes.get(kind)!.assistants, id, phrase) }
          nextTypes.set(kind, next)
          const v = validateDeviceSettings(next, known)
          if (v.errors.length > 0) return refusal(v.errors)
          continue
        }
        const target = p.target
        if (!devices.some((d) => d.id === target.id)) return fail("unknown_device", "That device is not known.")
        const kind = kindOfDevice(target.id)
        const record = nextOwn.get(target.id) ?? { own: {}, rev: 0 }
        const list = effectiveDeviceSettings(defOf(kind).builtIn, nextTypes.get(kind)!, record.own).assistants
        const own = { ...record.own, assistants: withPlacement(list, id, phrase) } as DeviceOwn
        const v = validateDeviceSettings(effectiveDeviceSettings(defOf(kind).builtIn, nextTypes.get(kind)!, own), known)
        if (v.errors.length > 0) return refusal(v.errors)
        nextOwn.set(target.id, { own, rev: record.rev + 1 })
      }
      for (const [kind, next] of nextTypes) {
        const t = typeOf(kind)
        if (next !== t.settings) types.set(kind, { settings: next, rev: t.rev + 1, saved: true })
      }
      deviceOwn = nextOwn
      assistants = [...assistants, { ...clone(assistant), id, rev: 0 }]
      return { ok: true, assistantId: id }
    },
    save: ({ assistant }) => {
      const current = assistants.find((a) => a.id === assistant.id)
      if (current === undefined) return fail("unknown_assistant", `There is no assistant ${assistant.id}.`)
      const found = issues(assistant)
      if (found.length > 0) return refusal(found)
      if (assistant.rev !== current.rev) return fail("stale", `${current.name} changed since this page read it; reload it.`)
      assistants = assistants.map((a) => (a.id === assistant.id ? { ...clone(assistant), rev: current.rev + 1 } : a))
      return OK
    },
    remove: ({ id, rev }, devices) => {
      const current = assistants.find((a) => a.id === id)
      if (current === undefined) return fail("unknown_assistant", `There is no assistant ${id}.`)
      if (rev !== current.rev) return fail("stale", `${current.name} changed since this page read it; reload it.`)
      assistants = assistants.filter((a) => a.id !== id)
      for (const [kind, t] of types) types.set(kind, { ...t, settings: removeAssistantFromSettings(t.settings, id) as DeviceSettings, rev: t.rev + 1 })
      for (const d of devices) {
        const record = deviceOwn.get(d.id)
        if (record === undefined) continue
        deviceOwn.set(d.id, { own: removeAssistantFromSettings(record.own, id, typeOf(kindOfDevice(d.id)).settings.assistants), rev: record.rev + 1 })
      }
      return OK
    },
    saveDevice: ({ target, rev, settings, saveAnyway }) => {
      const patch = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as Record<string, unknown>
      const known = new Set(assistants.map((a) => a.id))
      // As the server: a default person must be in Members.
      const person = settings.place?.defaultPerson
      if (person !== undefined && person !== null && catalog.isPerson !== undefined && !catalog.isPerson(person)) {
        return refusal([{ code: "invalid", path: "place.defaultPerson", message: "That person is not in Members (any more): pick another, or nobody." }])
      }
      if (target.kind === "type") {
        if (!listed(target.type)) return fail("unknown_device", `No device type ${target.type}.`)
        const t = typeOf(target.type)
        const type = defOf(target.type)
        if (rev !== t.rev) return fail("stale", "The defaults changed since this page read them; reload them.")
        if (Object.values(patch).some((v) => v === null)) return fail("bad_message", "A type's defaults have no value to go back to.")
        const next = { ...t.settings, ...patch } as DeviceSettings
        // As the server (§6.1): the type goes to the check, so a voice node that answers without a phrase warns.
        const v = validateDeviceSettings(next, known, { type })
        if (v.errors.length > 0) return refusal(v.errors)
        const before = new Set(validateDeviceSettings(t.settings, known, { type }).warnings.map((w) => w.path))
        const fresh = v.warnings.filter((w) => !before.has(w.path))
        if (fresh.length > 0 && saveAnyway !== true) return fail("invalid_settings", `${fresh[0]!.message} Save anyway to keep it.`, { warnings: fieldErrorsOf(fresh) })
        types.set(target.type, { settings: next, rev: t.rev + 1, saved: true })
        return OK
      }
      const kind = kindOfDevice(target.id)
      const type = defOf(kind)
      const record = deviceOwn.get(target.id) ?? { own: {}, rev: 0 }
      if (rev !== record.rev) return fail("stale", "The device changed since this page read it; reload it.")
      const own: Record<string, unknown> = { ...record.own }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete own[k]
        else own[k] = v
      }
      const v = validateDeviceSettings(effective(own as DeviceOwn, kind), known, { type })
      if (v.errors.length > 0) return refusal(v.errors)
      const before = new Set(validateDeviceSettings(effective(record.own, kind), known, { type }).warnings.map((w) => w.path))
      const fresh = v.warnings.filter((w) => !before.has(w.path))
      if (fresh.length > 0 && saveAnyway !== true) return fail("invalid_settings", `${fresh[0]!.message} Save anyway to keep it.`, { warnings: fieldErrorsOf(fresh) })
      deviceOwn.set(target.id, { own: own as DeviceOwn, rev: record.rev + 1 })
      return OK
    },
    touch: (id, patch) => {
      const current = assistants.find((a) => a.id === id)
      if (current === undefined) return false
      assistants = assistants.map((a) => (a.id === id ? { ...a, ...clone(patch), rev: a.rev + 1 } : a))
      return true
    },
    forgetDevice: (id) => {
      deviceOwn.delete(id)
    },
    seedNodeType: () => {
      const t = typeOf(VOICE_NODE_KIND)
      if (t.saved) return false
      const web = typeOf(WEB_VOICE_KIND).settings
      if (web.assistants.length === 0) return false
      const settings: DeviceSettings = {
        ...clone(BUILT_IN_VOICE_NODE_SETTINGS),
        assistants: web.assistants.map(({ followUpSeconds: _gone, ...a }) => clone(a)),
        matching: web.matching,
        withoutPhrase: { mode: "nobody" }
      }
      types.set(VOICE_NODE_KIND, { settings, rev: t.rev + 1, saved: true })
      return true
    },
    setTypeSettings: (kind, settings) => {
      const t = typeOf(kind)
      types.set(kind, { settings: { ...t.settings, ...clone(settings) }, rev: t.rev + 1, saved: true })
    },
    clearDefaultPeople: (known) => {
      let changed = false
      const gone = (p: string | null) => p !== null && !known.has(p)
      for (const [kind, t] of types) {
        if (!gone(t.settings.place.defaultPerson)) continue
        types.set(kind, { ...t, settings: { ...t.settings, place: { ...t.settings.place, defaultPerson: null } }, rev: t.rev + 1 })
        changed = true
      }
      for (const [id, record] of deviceOwn) {
        const place = record.own.place
        if (place === undefined || !gone(place.defaultPerson)) continue
        deviceOwn.set(id, { own: { ...record.own, place: { ...place, defaultPerson: null } }, rev: record.rev + 1 })
        changed = true
      }
      return changed
    }
  }
  return mock
}
