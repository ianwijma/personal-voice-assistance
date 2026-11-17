import {
  applicableOwn,
  type Assistant,
  type AssistantBody,
  type AssistantInfo,
  assistantUsedOn,
  type ClientMessageOf,
  DEVICE_TYPES,
  type DeviceInfo,
  type DeviceListInfo,
  type DeviceOwn,
  type DeviceTypeInfo,
  DeviceSettings,
  type DeviceSettingsKey,
  type DeviceSettingsPatch,
  type DeviceSetup,
  deviceSetupFrom,
  type DeviceTarget,
  deviceTypeOf,
  type EngineState,
  type ErrorInfo,
  type FieldError,
  type Issue,
  makeAssistantId,
  MAX_ASSISTANTS,
  type ModuleInfo,
  type ModuleOffer,
  effectiveDeviceSettings,
  TYPESAFE_GIVE_UP_MS,
  validateAssistant,
  validateDeviceSettings,
  WAKE_PHRASES_MAX,
  type WithoutPhrase
} from "@pva/protocol"
import { Effect, Schema, Semaphore } from "effect"
import { deviceListInfos, deviceSettingsFrom, deviceTypeInfos, typeSettingsFrom } from "./devices.ts"
import { EntitySaveError, type SettingsStore, SettingsStoreError } from "./SettingsStore.ts"
import type { VoiceSessions } from "./VoiceSessions.ts"

/**
 * The server half of the assistants and devices messages (docs/ASSISTANTS.md §5.2 to §5.4): validation, the entity
 * saves of the settings store (`stale`, existence, limits and environment locks are the store's), the delete and
 * pick rules of §2.6 and §5.3, and the data of the pushes (`assistants`, `device.types`, `device.setup`).
 *
 * Who may send what, and who gets which push, is the hub's business (`SessionHub`); this module only computes and
 * stores. It does not start or stop anything: after a successful change the hub refreshes the sessions' route
 * configuration and sends the pushes.
 */

export type AssistantResult = { readonly ok: true; readonly assistantId?: string; readonly rev?: number } | { readonly ok: false; readonly error: ErrorInfo }

export interface AssistantsOptions {
  readonly store: SettingsStore
  readonly sessions: VoiceSessions
  /** The modules, their fields (`overridable`) and, while one runs, its tools (module host). */
  readonly modules: () => ReadonlyArray<Pick<ModuleInfo, "id" | "state" | "tools" | "settings">>
  /**
   * The module's check of an assistant's own values (`ModuleHost.checkOwn`): overridable fields only, never a secret,
   * values the field accepts. Without it no own value is accepted.
   */
  readonly checkOwn?: (moduleId: string, own: Readonly<Record<string, unknown>>) => ReadonlyArray<FieldError>
  readonly engineState: () => EngineState
  /** TypeSafe is set up (shows "Whichever fits" on the voice page; `device.pick` accepts `"typesafe"`). */
  readonly canAuto: () => boolean
  /** An assistant's hearing problems (its recogniser failed; the memory of several local speech models). WP-11. */
  readonly hearingProblems?: (assistantId: string) => ReadonlyArray<string>
  /**
   * The save-time memory warning (docs/ASSISTANTS.md §9): a change that loads local speech models needing more than
   * 75 % of the free memory asks for "Save anyway". `place`: `device:<id>` or `type:<kind>` with its new settings.
   */
  readonly speechMemoryWarning?: (change: {
    readonly place?: { readonly place: string; readonly settings: DeviceSettings }
    readonly assistant?: Assistant
  }) => string | undefined
}

export interface Assistants {
  /** `assistants`: the assistants in effect, with where they are used and their problems. */
  readonly infos: () => ReadonlyArray<AssistantInfo>
  /** `device.types`. */
  readonly deviceTypes: () => ReadonlyArray<DeviceTypeInfo>
  /** `devices`: the protocol 5 entries with the protocol 7 fields added. */
  readonly devices: (base: ReadonlyArray<DeviceInfo>) => ReadonlyArray<DeviceListInfo>
  /** A voice connection's setup (`device.setup`, `snapshot.setup`). `kind`: the kind its hello named. */
  readonly setupFor: (deviceId: string | undefined, kind?: string) => DeviceSetup
  readonly create: (message: ClientMessageOf<"assistant.create">) => Effect.Effect<AssistantResult>
  readonly save: (message: ClientMessageOf<"assistant.save">) => Effect.Effect<AssistantResult>
  readonly remove: (message: ClientMessageOf<"assistant.delete">) => Effect.Effect<AssistantResult>
  readonly saveDevice: (message: ClientMessageOf<"device.save">) => Effect.Effect<AssistantResult>
  /** `device.pick` of the device `deviceId` (a remembered device). */
  readonly pick: (deviceId: string, withoutPhrase: ClientMessageOf<"device.pick">["withoutPhrase"]) => Effect.Effect<AssistantResult>
}

const OK: AssistantResult = { ok: true }
/** A `device.save` that went through: the revision it made (the page waits for it). */
const savedAt = (saved: { readonly rev: number }): AssistantResult => ({ ok: true, rev: saved.rev })

const fail = (
  code: ErrorInfo["code"],
  message: string,
  extra: { readonly fieldErrors?: ReadonlyArray<FieldError>; readonly warnings?: ReadonlyArray<FieldError> } = {}
): AssistantResult => ({ ok: false, error: { code, message, ...extra } })

const fieldErrorsOf = (issues: ReadonlyArray<Issue>): ReadonlyArray<FieldError> => issues.map((i) => ({ key: i.path, message: i.message }))

/** Codes a refusal can carry over from validation; everything else is `invalid_settings`. */
const SPECIFIC = ["duplicate_phrase", "unknown_assistant", "limit_reached"] as const

const refusal = (issues: ReadonlyArray<Issue>): AssistantResult => {
  const specific = issues.find((i) => (SPECIFIC as ReadonlyArray<string>).includes(i.code))
  return fail(
    (specific?.code ?? "invalid_settings") as ErrorInfo["code"],
    (specific ?? issues[0])?.message ?? "Some settings are not valid.",
    { fieldErrors: fieldErrorsOf(issues) }
  )
}

const entityFailure = (e: EntitySaveError | SettingsStoreError): AssistantResult =>
  e instanceof EntitySaveError ? fail(e.code, e.message) : fail("internal", e.message)

const isStorableSettings = Schema.is(DeviceSettings)

/**
 * What the stored schema refuses and `validateDeviceSettings` does not check, for a settings value the server put
 * together itself (placements add phrases up): more than `WAKE_PHRASES_MAX` phrases for one assignment, and, as a last
 * guard, anything else `DeviceSettings` would refuse (the store would drop the entry on the next start, the pushes
 * would not encode).
 */
const storableIssues = (settings: DeviceSettings): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = []
  settings.assistants.forEach((a, i) => {
    if (a.phrases.length > WAKE_PHRASES_MAX) {
      issues.push({ code: "limit_reached", path: `assistants.${i}.phrases`, message: `At most ${WAKE_PHRASES_MAX} wake phrases for one assistant on a device.` })
    }
  })
  if (issues.length === 0 && !isStorableSettings(settings)) issues.push({ code: "invalid", path: "assistants", message: "These settings could not be saved." })
  return issues
}

const targetKey = (t: DeviceTarget) => (t.kind === "type" ? `type:${t.type}` : `device:${t.id}`)

export const makeAssistants = (options: AssistantsOptions): Assistants => {
  const { store, sessions } = options

  /** The assistants in effect (the environment applied). */
  const inEffect = () => store.assistantsInEffect().map((e) => e.assistant)
  const knownIds = (): ReadonlySet<string> => new Set(store.assistants().map((a) => a.id))

  /** The running modules' tools (a module that does not run has no known tools: its `offTools` are not checked). */
  const moduleOffers = (): Record<string, ModuleOffer> =>
    Object.fromEntries(
      options.modules().filter((m) => m.state === "running").map((m) => [
        m.id,
        { overridable: m.settings.fields.flatMap((f) => (f.overridable === true && f.type !== "secret" ? [f.key] : [])), tools: m.tools.map((t) => t.name) } satisfies ModuleOffer
      ])
    )

  /**
   * `validateAssistant` (tools of the running modules), and each module's own values checked by the module's fields
   * (`checkOwn`: overridable fields only, never a secret, a value the field accepts), running or not.
   */
  const assistantIssues = (body: AssistantBody & { readonly id?: string }): ReadonlyArray<Issue> => {
    // Own values are the module's to judge (below), so `validateAssistant` sees the choices without them.
    const withoutOwn = { ...body, modules: Object.fromEntries(Object.entries(body.modules).map(([id, { own: _own, ...choice }]) => [id, choice])) }
    const issues = [...validateAssistant(withoutOwn, { others: store.assistants(), modules: moduleOffers() })]
    const known = new Set(options.modules().map((m) => m.id))
    for (const [moduleId, choice] of Object.entries(body.modules)) {
      if (!known.has(moduleId)) continue
      const own = choice.own ?? {}
      if (Object.keys(own).length === 0) continue
      const problems = options.checkOwn?.(moduleId, own) ?? Object.keys(own).map((key) => ({ key, message: `${key} cannot be set per assistant.` }))
      for (const p of problems) {
        issues.push({ code: "invalid", path: p.key === null ? `modules.${moduleId}.own` : `modules.${moduleId}.own.${p.key}`, message: p.message })
      }
    }
    return issues
  }

  const setupFor: Assistants["setupFor"] = (deviceId, kind) =>
    deviceSetupFrom(
      deviceSettingsFrom(store.settings(), deviceId, kind),
      new Map(inEffect().map((a) => [a.id, a])),
      { ...(deviceId !== undefined ? { deviceId } : {}), canAuto: options.canAuto() }
    )

  // ---- The assistants push

  const infos: Assistants["infos"] = () => {
    const file = store.settings()
    const entries = [
      ...DEVICE_TYPES.map((t) => ({ target: { kind: "type", type: t.kind } as DeviceTarget, settings: typeSettingsFrom(file, t.kind) })),
      ...Object.keys(file.devices).map((id) => ({ target: { kind: "device", id } as DeviceTarget, settings: deviceSettingsFrom(file, id) }))
    ]
    const nameOf = (t: DeviceTarget) => (t.kind === "type" ? deviceTypeOf(t.type)?.title ?? t.type : file.devices[t.id]?.name ?? t.id)
    const engine = options.engineState()
    const engineResource = engine === "failed" ? "failed" : engine === "ready" ? "ready" : "starting"
    return inEffect().map((assistant) => {
      const usedOn = assistantUsedOn(assistant.id, entries)
      const used = assistant.on && usedOn.length > 0
      const problems = [
        ...(usedOn.length === 0 ? ["Not used on any device."] : []),
        ...usedOn.filter((u) => u.reach === "unreachable").map((u) => `Cannot be reached on ${nameOf(u.target)}: no wake phrase and not the one that answers without a phrase.`)
      ]
      const resource = used ? engineResource : "unused"
      problems.push(...(options.hearingProblems?.(assistant.id) ?? []))
      return { ...assistant, usedOn: [...usedOn], resources: { llm: resource, voice: resource }, problems }
    })
  }

  // ---- Device validation shared by device.save, placements and pick

  /** The refusal for a settings value that does not hold together, else `undefined`. New "cannot be reached" warnings need `saveAnyway`. */
  const settingsRefusal = (
    next: DeviceSettings,
    before: DeviceSettings,
    saveAnyway: boolean
  ): AssistantResult | undefined => {
    const ids = knownIds()
    const records = { assistants: new Map(inEffect().map((a) => [a.id, a])) }
    const checked = validateDeviceSettings(next, ids, records)
    if (checked.errors.length > 0) return refusal(checked.errors)
    if (saveAnyway) return undefined
    const old = new Set(validateDeviceSettings(before, ids, records).warnings.map((w) => w.path))
    const fresh = checked.warnings.filter((w) => !old.has(w.path))
    if (fresh.length === 0) return undefined
    return fail("invalid_settings", `${fresh[0]!.message} Save anyway to keep it.`, { warnings: fieldErrorsOf(fresh) })
  }

  /** The memory warning as a refusal that `saveAnyway` overrides. */
  const memoryRefusal = (
    change: Parameters<NonNullable<AssistantsOptions["speechMemoryWarning"]>>[0],
    saveAnyway: boolean,
    key: string
  ): AssistantResult | undefined => {
    if (saveAnyway) return undefined
    const warning = options.speechMemoryWarning?.(change)
    return warning === undefined ? undefined : fail("invalid_settings", `${warning} Save anyway to keep it.`, { warnings: [{ key, message: warning }] })
  }

  const ownWith = (own: DeviceOwn, patch: DeviceSettingsPatch, keys: ReadonlyArray<DeviceSettingsKey>): DeviceOwn => {
    const out: Record<string, unknown> = { ...own }
    for (const key of keys) {
      const value = patch[key]
      if (value === undefined) continue
      if (value === null) delete out[key]
      else out[key] = value
    }
    return out as DeviceOwn
  }

  /**
   * A type's new defaults checked on every device of the type: a device follows the sections it has no own value
   * for, so its own `withoutPhrase` may name an assistant the new defaults drop from its list. Only problems the
   * device did not have before count.
   */
  const inheritorsRefusal = (kind: string, next: DeviceSettings): AssistantResult | undefined => {
    const file = store.settings()
    const type = deviceTypeOf(kind)
    if (type === undefined) return undefined
    const ids = knownIds()
    for (const [id, record] of Object.entries(file.devices)) {
      if (record.kind !== kind) continue
      const own = applicableOwn(type, record.own)
      const old = new Set(validateDeviceSettings(effectiveDeviceSettings(type.builtIn, file.deviceTypes[kind], own), ids).errors.map((e) => e.path))
      const fresh = validateDeviceSettings(effectiveDeviceSettings(type.builtIn, next, own), ids).errors.filter((e) => !old.has(e.path))
      if (fresh.length === 0) continue
      return fail("invalid_settings", `${record.name || id} follows these defaults and would no longer hold together: ${fresh[0]!.message} Change that device first.`)
    }
    return undefined
  }

  const saveDevice: Assistants["saveDevice"] = (message) =>
    Effect.suspend(() => {
      const file = store.settings()
      const { target, patch } = { target: message.target, patch: message.settings }
      const saveAnyway = message.saveAnyway === true
      if (target.kind === "type") {
        const type = deviceTypeOf(target.type)
        if (type === undefined) return Effect.succeed(fail("unknown_device", `There is no device type ${target.type}.`))
        const issues: Array<Issue> = []
        for (const key of Object.keys(patch) as Array<DeviceSettingsKey>) {
          if (!type.keys.includes(key)) issues.push({ code: "invalid", path: key, message: `${key} does not apply to ${type.many}.` })
          else if (patch[key] === null) issues.push({ code: "invalid", path: key, message: "Defaults cannot be reset; only a device can follow them." })
        }
        if (issues.length > 0) return Effect.succeed(refusal(issues))
        const before = typeSettingsFrom(file, target.type)
        const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as DeviceSettings
        const refused = settingsRefusal(next, before, saveAnyway) ?? memoryRefusal({ place: { place: `type:${target.type}`, settings: next } }, saveAnyway, "assistants")
        if (refused !== undefined) return Effect.succeed(refused)
        const inherited = inheritorsRefusal(target.type, next)
        if (inherited !== undefined) return Effect.succeed(inherited)
        return store.saveDeviceType(target.type, message.rev, next).pipe(
          Effect.map(savedAt),
          Effect.catch((e) => Effect.succeed(entityFailure(e)))
        )
      }
      const record = file.devices[target.id]
      if (record === undefined) return Effect.succeed(fail("unknown_device", "That device is not known (it may have been forgotten)."))
      const type = deviceTypeOf(record.kind)
      const keys = type?.keys ?? []
      const own = ownWith(record.own, patch, keys)
      const kindDefaults = file.deviceTypes[record.kind]
      const effective = (o: DeviceOwn) =>
        effectiveDeviceSettings((type ?? deviceTypeOf(record.kind)!).builtIn, kindDefaults, type === undefined ? undefined : applicableOwn(type, o))
      const refused = settingsRefusal(effective(own), effective(record.own), saveAnyway) ??
        memoryRefusal({ place: { place: `device:${target.id}`, settings: effective(own) } }, saveAnyway, "assistants")
      if (refused !== undefined) return Effect.succeed(refused)
      return store.saveDevice(target.id, message.rev, { ...(message.name !== undefined ? { name: message.name } : {}), own }).pipe(
        Effect.map(savedAt),
        Effect.catch((e) => Effect.succeed(entityFailure(e)))
      )
    })

  // ---- Assistants

  /** `settings` with the assistant added to its list; one already in it (a device following the type's new entry) gets the phrase. */
  const withPlacement = (settings: DeviceSettings, id: string, phrase: string | undefined): DeviceSettings => {
    const existing = settings.assistants.find((x) => x.assistant === id)
    if (existing === undefined) return { ...settings, assistants: [...settings.assistants, { assistant: id, phrases: phrase !== undefined ? [phrase] : [] }] }
    if (phrase === undefined || existing.phrases.includes(phrase)) return settings
    return { ...settings, assistants: settings.assistants.map((x) => (x === existing ? { ...x, phrases: [...x.phrases, phrase] } : x)) }
  }

  /** The placements of a created assistant (§5.2, wizard step 6) checked before anything is created, in the order they will be applied. */
  const placementIssues = (id: string, placements: NonNullable<ClientMessageOf<"assistant.create">["placements"]>): AssistantResult | undefined => {
    const file = store.settings()
    const ids = new Set([...knownIds(), id])
    const current = new Map<string, DeviceSettings>()
    for (const p of placements) {
      const key = targetKey(p.target)
      let settings = current.get(key)
      if (settings === undefined) {
        if (p.target.kind === "type") {
          if (deviceTypeOf(p.target.type) === undefined) return fail("unknown_device", `There is no device type ${p.target.type}.`)
          settings = typeSettingsFrom(file, p.target.type)
        } else {
          const record = file.devices[p.target.id]
          if (record === undefined) return fail("unknown_device", "A device in the placements is not known (it may have been forgotten).")
          settings = deviceSettingsFrom(file, p.target.id)
          // A device without a list of its own follows the type's, which an earlier placement may have changed.
          const typeNow = current.get(targetKey({ kind: "type", type: record.kind }))
          if (record.own.assistants === undefined && typeNow !== undefined) settings = { ...settings, assistants: typeNow.assistants }
        }
      }
      const next = withPlacement(settings, id, p.phrase)
      const checked = validateDeviceSettings(next, ids)
      if (checked.errors.length > 0) return refusal(checked.errors)
      const unstorable = storableIssues(next)
      if (unstorable.length > 0) return refusal(unstorable)
      current.set(key, next)
    }
    return undefined
  }

  const place = (id: string, p: { readonly target: DeviceTarget; readonly phrase?: string | undefined }): Effect.Effect<AssistantResult> =>
    Effect.suspend(() => {
      const file = store.settings()
      if (p.target.kind === "type") {
        const kind = p.target.type
        return store.saveDeviceType(kind, file.deviceTypes[kind]?.rev ?? 0, withPlacement(typeSettingsFrom(file, kind), id, p.phrase)).pipe(
          Effect.as(OK),
          Effect.catch((e) => Effect.succeed(entityFailure(e)))
        )
      }
      const deviceId = p.target.id
      const record = file.devices[deviceId]
      if (record === undefined) return Effect.succeed(fail("unknown_device", "That device is not known."))
      const next = withPlacement(deviceSettingsFrom(file, deviceId), id, p.phrase)
      return store.saveDevice(deviceId, record.rev, { own: { ...record.own, assistants: next.assistants } }).pipe(
        Effect.as(OK),
        Effect.catch((e) => Effect.succeed(entityFailure(e)))
      )
    })

  const create: Assistants["create"] = (message) =>
    Effect.suspend(() => {
      const body = message.assistant
      if (store.assistants().length >= MAX_ASSISTANTS) return Effect.succeed(fail("limit_reached", `There can be at most ${MAX_ASSISTANTS} assistants.`))
      if (message.copyOf !== undefined && !knownIds().has(message.copyOf)) {
        return Effect.succeed(fail("unknown_assistant", `There is no assistant ${message.copyOf} to start from.`))
      }
      const issues = assistantIssues(body)
      if (issues.length > 0) return Effect.succeed(refusal(issues))
      const placements = message.placements ?? []
      const predicted = makeAssistantId(body.name, store.assistants().map((a) => a.id))
      const refused = placementIssues(predicted, placements)
      if (refused !== undefined) return Effect.succeed(refused)
      return Effect.gen(function*() {
        const created = yield* store.createAssistant(body)
        for (const p of placements) {
          const placed = yield* place(created.id, p)
          if (!placed.ok) {
            return fail(placed.error.code, `${created.name} was created, but it could not be placed: ${placed.error.message}`)
          }
        }
        return { ok: true, assistantId: created.id } satisfies AssistantResult
      }).pipe(Effect.catch((e) => Effect.succeed(entityFailure(e))))
    })

  /** §2.2: a switched-on assistant on a TypeSafe device whose Handles becomes empty asks "Save anyway" (once). */
  const handlesRefusal = (a: Assistant, saveAnyway: boolean): AssistantResult | undefined => {
    if (saveAnyway || !a.on || a.handles.trim() !== "") return undefined
    const before = store.assistants().find((x) => x.id === a.id)
    if (before !== undefined && before.on && before.handles.trim() === "") return undefined
    const file = store.settings()
    const lists = [
      ...DEVICE_TYPES.map((t) => typeSettingsFrom(file, t.kind)),
      ...Object.keys(file.devices).map((id) => deviceSettingsFrom(file, id))
    ]
    if (!lists.some((s) => s.withoutPhrase.mode === "typesafe" && s.assistants.some((x) => x.assistant === a.id))) return undefined
    const message = `${a.name} has no Handles text, so TypeSafe can only go by its name and purpose.`
    return fail("invalid_settings", `${message} Save anyway to keep it.`, { warnings: [{ key: "handles", message }] })
  }

  const save: Assistants["save"] = (message) =>
    Effect.suspend(() => {
      if (!knownIds().has(message.assistant.id)) return Effect.succeed(fail("unknown_assistant", `There is no assistant ${message.assistant.id}.`))
      const issues = assistantIssues(message.assistant)
      if (issues.length > 0) return Effect.succeed(refusal(issues))
      const memory = memoryRefusal({ assistant: message.assistant }, message.saveAnyway === true, "hearing.model") ??
        handlesRefusal(message.assistant, message.saveAnyway === true)
      if (memory !== undefined) return Effect.succeed(memory)
      return store.saveAssistantRecord(message.assistant).pipe(
        Effect.as(OK),
        Effect.catch((e) => Effect.succeed(entityFailure(e)))
      )
    })

  /** §2.6 "When an assistant is deleted": its conversations end on every device (their agents are told). */
  const endConversations = (id: string): Effect.Effect<void> =>
    Effect.forEach(
      sessions.all(),
      (session) =>
        Effect.suspend(() => {
          if (session.conversation.dispatcher.get(id) === undefined) return Effect.void
          session.conversation.stop(id)
          return Effect.asVoid(session.conversation.newConversation(id))
        }),
      { discard: true }
    )

  const remove: Assistants["remove"] = (message) =>
    store.deleteAssistantRecord(message.id, message.rev).pipe(
      Effect.andThen(endConversations(message.id)),
      Effect.as(OK),
      Effect.catch((e) => Effect.succeed(entityFailure(e)))
    )

  // ---- Voice page: who answers without a phrase

  const pick: Assistants["pick"] = (deviceId, requested) =>
    Effect.suspend(() => {
      const file = store.settings()
      const record = file.devices[deviceId]
      if (record === undefined) return Effect.succeed(fail("unknown_device", "This device is not known yet; reload the page."))
      const effective = deviceSettingsFrom(file, deviceId)
      const assistants = new Map(inEffect().map((a) => [a.id, a]))
      const setup = deviceSetupFrom(effective, assistants, { deviceId, canAuto: options.canAuto() })
      if (!setup.canPick) return Effect.succeed(fail("not_allowed", "This device does not let people pick the assistant."))
      let withoutPhrase: WithoutPhrase
      if (requested === "") withoutPhrase = { mode: "nobody" }
      else if (requested === "typesafe") {
        if (!setup.canAuto) return Effect.succeed(fail("not_allowed", "Choosing whichever fits needs TypeSafe, which is not set up."))
        const wp = effective.withoutPhrase
        withoutPhrase = wp.mode === "typesafe"
          ? wp
          : { mode: "typesafe", fallback: effective.assistants[0]?.assistant ?? null, giveUpMs: TYPESAFE_GIVE_UP_MS.default }
      } else {
        if (!assistants.has(requested) || !effective.assistants.some((a) => a.assistant === requested)) {
          return Effect.succeed(fail("unknown_assistant", `${requested} is not one of the assistants on this device.`))
        }
        withoutPhrase = { mode: "assistant", assistant: requested }
      }
      return store.saveDevice(deviceId, record.rev, { own: { ...record.own, withoutPhrase } }).pipe(
        Effect.as(OK),
        Effect.catch((e) => Effect.succeed(entityFailure(e)))
      )
    })

  /**
   * The changes check against the committed settings and then save them, so two at once must not interleave: both
   * would check the same state (two creates named "Desk" would both pass the unique-name check). One at a time.
   */
  const serial = Semaphore.makeUnsafe(1)
  const one = <A extends ReadonlyArray<unknown>>(f: (...args: A) => Effect.Effect<AssistantResult>) => (...args: A) => serial.withPermit(f(...args))

  return {
    deviceTypes: () => deviceTypeInfos(store.settings()),
    devices: (base) => deviceListInfos(store.settings(), base),
    infos,
    setupFor, create: one(create),
    save: one(save),
    remove: one(remove),
    saveDevice: one(saveDevice),
    pick: one(pick)
  }
}
