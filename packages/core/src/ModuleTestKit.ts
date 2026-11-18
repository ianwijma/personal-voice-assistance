/**
 * The module test kit (docs/MODULES.md, "Testing"; docs/MODULES-PLAN.md §4 P11): one module definition started in the
 * **real** module host, with the real execution gateway, the real scheduler engine on the in-memory household store,
 * and the core's real `People`, `Privacy` and `Devices` rules over a test household; handles to run a tool, an action,
 * a job or a route of it as a given turn, and to stop and restart it. Exported from `@pva/core/testing` only.
 *
 * Run it inside `it.effect` (the test clock): `startTestModule` sets the clock to `startAt` first, and `advance(ms)`
 * moves it and lets the scheduler run what came due. Everything it makes lives in the test's scope.
 */
import { BUILT_IN_PLACE, type DeviceCapabilities, type DevicePrivacy, type HealthIssue, type ModuleInfo, type RouteTokenInfo, type SettingValue } from "@pva/protocol"
import { Clock, Effect, Exit, Fiber, type Schema } from "effect"
import { TestClock } from "effect/testing"
import type { ActionRunResult, ContributionKey, ProvidedContribution, ProvidedService, ServiceKey } from "./ModuleApi.ts"
import { type KnownDevice, Devices, makeDevices } from "./Devices.ts"
import type { HouseholdStore, ModuleStore } from "./HouseholdStore.ts"
import { defineModule, type ModuleDefinition } from "./ModuleDefinition.ts"
import { makeModuleHost, type ModuleHost, readOnlyPersistence } from "./ModuleHost.ts"
import type { Registrar, StartedPart } from "./ModuleRegistrations.ts"
import { matchRoutePath, type RouteResponse, RouteTokenError, type RouteTokens, type RouteTokenStore } from "./ModuleRoutes.ts"
import { type Diet, EMPTY_DIET, effectiveDiet, findPerson, People, type PeopleService, type Person, peopleError } from "./People.ts"
import { makePrivacy, Privacy } from "./Privacy.ts"
import type { JobRow, ModuleScheduler, SchedulerHook } from "./Scheduler.ts"
import { makeToolRegistry } from "./ToolRegistry.ts"
import { CurrentTurn, type Principal, type TurnContext, type TurnSource } from "./TurnContext.ts"
import { connectStoreToBus, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import { makeIssueRegistry } from "./Issues.ts"
import { makeMemoryHouseholdStore } from "./MemoryHouseholdStore.ts"
import { makeSchedulerEngine } from "./SchedulerEngine.ts"
import { schedulerStorage } from "./SchedulerJobs.ts"

// ---------------------------------------------------------------------------------------------------------------------
// The household

export interface TestPerson {
  /** A Members id (`/^[a-z0-9][a-z0-9_-]{0,39}$/`): "p-sam". */
  readonly id: string
  readonly name: string
  readonly aliases?: ReadonlyArray<string>
  readonly diet?: Partial<Diet>
}

export interface TestDevice {
  /** A device id (`/^[A-Za-z0-9_-]{8,64}$/`): "kitchen-display". */
  readonly id: string
  readonly name: string
  readonly room?: string
  /** Default `shared`. */
  readonly privacy?: DevicePrivacy
  /** A person id of the household, or nobody (default). */
  readonly defaultPerson?: string | null
  /** The assistants on the device (default: every assistant of the household). */
  readonly assistants?: ReadonlyArray<string>
  readonly capabilities?: DeviceCapabilities
  readonly connected?: boolean
  readonly kind?: string
}

/** An assistant and the modules it has on. The module under test and every `provide` stand-in are on unless listed off. */
export interface TestAssistant {
  readonly id: string
  /** Per module: `false` switches it off for this assistant; `own` are its own values of `overridable` fields. */
  readonly modules?: Readonly<Record<string, false | { readonly own?: Readonly<Record<string, unknown>>; readonly offTools?: ReadonlyArray<string> }>>
}

export interface TestHouseholdInput {
  readonly people?: ReadonlyArray<TestPerson>
  readonly devices?: ReadonlyArray<TestDevice>
  readonly assistants?: ReadonlyArray<TestAssistant>
  readonly householdDiet?: Partial<Diet>
  /** The Home section's values (`host.view().home`): `HOME_LANGUAGE`, `HOME_TIME_ZONE`, `HOME_UNITS`, … */
  readonly home?: Readonly<Record<string, SettingValue>>
}

/**
 * The household a test gets when it names none: Sam and Robin; a shared kitchen display whose default person is Sam,
 * Robin's private phone, and a public hall screen; one assistant, `jeff`, on all three. English, Amsterdam.
 */
export const DEFAULT_TEST_HOUSEHOLD: Required<Omit<TestHouseholdInput, "householdDiet">> = {
  people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }],
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null }
  ],
  assistants: [{ id: "jeff" }],
  home: { HOME_LANGUAGE: "en-GB", HOME_TIME_ZONE: "Europe/Amsterdam", HOME_UNITS: "metric", HOME_LOCATION: "Utrecht" }
}

/**
 * The core's own services over a test household, built from the same rules serve mode uses: `People` (`findPerson`,
 * `effectiveDiet`; a diet change is kept in memory), `Privacy` (`makePrivacy`: the device's saved place and Members) and
 * `Devices` (`makeDevices`). `setPrivacy` and `setDefaultPerson` change a device's place for later calls.
 */
export const makeTestPeople = (input: TestHouseholdInput = {}) => {
  const people = new Map<string, Person>(
    (input.people ?? DEFAULT_TEST_HOUSEHOLD.people).map((p) => [p.id, { id: p.id, name: p.name, aliases: [...(p.aliases ?? [])], pronunciation: "", diet: { ...EMPTY_DIET, ...p.diet } }])
  )
  let householdDiet: Diet = { ...EMPTY_DIET, ...input.householdDiet }
  const devices = new Map<string, KnownDevice>()
  const assistantsOf = new Map<string, ReadonlyArray<string>>()
  const allAssistants = (input.assistants ?? DEFAULT_TEST_HOUSEHOLD.assistants).map((a) => a.id)
  for (const d of input.devices ?? DEFAULT_TEST_HOUSEHOLD.devices) {
    const room = d.room?.trim() ?? ""
    devices.set(d.id, {
      id: d.id,
      name: d.name,
      kind: d.kind ?? "web-voice",
      room: room === "" ? undefined : room,
      place: { ...BUILT_IN_PLACE, room, privacy: d.privacy ?? "shared", defaultPerson: d.defaultPerson ?? null },
      capabilities: d.capabilities ?? { v: 1 },
      declared: undefined,
      connected: d.connected ?? true,
      visible: d.connected ?? true,
      lastInteractionAt: undefined,
      lastSeen: 0
    })
    assistantsOf.set(d.id, d.assistants ?? allAssistants)
  }
  const list = () => [...people.values()]
  const peopleService: PeopleService = {
    list,
    get: (id) => people.get(id),
    find: (spoken) => findPerson(list(), spoken),
    householdDiet: () => householdDiet,
    dietOf: (id) => effectiveDiet(id === undefined ? undefined : people.get(id), householdDiet),
    setDiet: (owner, change) =>
      Effect.suspend(() => {
        if (owner === "household") {
          householdDiet = { ...householdDiet, ...change }
          return Effect.void
        }
        const person = people.get(owner.person)
        if (person === undefined) return Effect.fail(peopleError("unknown_person", "That person is not in Members."))
        people.set(person.id, { ...person, diet: { ...person.diet, ...change } })
        return Effect.void
      })
  }
  const privacy = makePrivacy((id) => devices.get(id)?.place, (id) => people.has(id))
  const devicesService = makeDevices(() => [...devices.values()])
  const setPlace = (deviceId: string, change: Partial<KnownDevice["place"]>) => {
    const d = devices.get(deviceId)
    if (d === undefined) throw new Error(`No test device ${deviceId}`)
    devices.set(deviceId, { ...d, place: { ...d.place, ...change } })
  }
  return {
    people: peopleService,
    privacy,
    devices: devicesService,
    /** The core services as the host gets them (`ModuleHostOptions.coreServices`). */
    coreServices: [People.of(peopleService), Privacy.of(privacy), Devices.of(devicesService)] as ReadonlyArray<ProvidedService>,
    assistantsOn: (deviceId: string) => assistantsOf.get(deviceId) ?? [],
    isMember: (id: string) => people.has(id),
    setPrivacy: (deviceId: string, privacy: DevicePrivacy) => setPlace(deviceId, { privacy }),
    setDefaultPerson: (deviceId: string, person: string | null) => setPlace(deviceId, { defaultPerson: person }),
    removePerson: (id: string) => void people.delete(id)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Turns

/** What a test turn says about itself; everything else comes from the household's device. */
export interface TestTurnInput {
  /** The device (default: the household's first). */
  readonly device?: string
  /** The answering assistant (default: the device's first). */
  readonly assistant?: string
  /** Who is speaking: a person id, `null` for nobody; default the device's default person (as serve mode does). */
  readonly person?: string | null
  /** Default: the device's room. */
  readonly room?: string
  readonly source?: TurnSource
  readonly turnId?: number
  readonly conversationId?: string
}

/**
 * A `CurrentTurn` as serve mode makes it, from a device of a test household: its id, name and room, its default
 * person (`how: "device-default"`), its first assistant. `makeTestTurn` without a household builds one from the input
 * alone (device `kitchen-display`, assistant `jeff`).
 */
export const makeTestTurn = (input: TestTurnInput & { readonly deviceName?: string } = {}): TurnContext => ({
  turnId: input.turnId ?? 1,
  conversationId: input.conversationId ?? "conversation-1",
  assistantId: input.assistant ?? "jeff",
  deviceId: input.device ?? "kitchen-display",
  ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
  ...(input.room !== undefined ? { room: input.room } : {}),
  ...(input.person !== undefined && input.person !== null ? { person: { id: input.person, how: "device-default" as const } } : {}),
  source: input.source ?? "voice"
})

// ---------------------------------------------------------------------------------------------------------------------
// Stand-ins for the modules a module uses

/** A stand-in for another module: its id, and the (fake) services and contributions its `shared` part provides. */
export interface ProvidedModule {
  readonly moduleId: string
  readonly services?: ReadonlyArray<ProvidedService>
  readonly contributions?: ReadonlyArray<ProvidedContribution>
}

/** `provide("lists", { services: [Lists.of(fake.service)] })`. */
export const provide = (moduleId: string, parts: Omit<ProvidedModule, "moduleId">): ProvidedModule => ({ moduleId, ...parts })

const standIn = (p: ProvidedModule): ModuleDefinition<{}> =>
  defineModule({
    apiVersion: 2,
    id: p.moduleId,
    name: `${p.moduleId} (test stand-in)`,
    description: "A stand-in of the test kit.",
    shared: () => Effect.succeed({ value: undefined, services: p.services ?? [], contributions: p.contributions ?? [] }),
    start: () => Effect.succeed({})
  })

// ---------------------------------------------------------------------------------------------------------------------
// Route tokens in memory

const makeMemoryRouteTokens = (): RouteTokenStore & { readonly secretsOf: (moduleId: string) => ReadonlyArray<{ readonly name: string; readonly secret: string; readonly id: string }> } => {
  const kept = new Map<string, Array<{ readonly info: RouteTokenInfo; readonly secret: string }>>()
  let next = 1
  return {
    forModule: (moduleId): RouteTokens => {
      const mine = () => {
        let list = kept.get(moduleId)
        if (list === undefined) kept.set(moduleId, (list = []))
        return list
      }
      return {
        mint: (name, label) =>
          Effect.suspend(() => {
            if (mine().length >= 20) return Effect.fail(new RouteTokenError({ reason: "limit", message: "This module holds 20 tokens already." }))
            const id = (next++).toString(16).padStart(8, "0")
            const info: RouteTokenInfo = { id, moduleId, name, label, createdAt: 0 }
            const secret = `test-token-${moduleId}-${id}`
            mine().push({ info, secret })
            return Effect.succeed({ token: info, secret })
          }),
        list: Effect.sync(() => mine().map((t) => t.info)),
        revoke: (id) =>
          Effect.sync(() => {
            const list = mine()
            const at = list.findIndex((t) => t.info.id === id)
            if (at < 0) return false
            list.splice(at, 1)
            return true
          })
      }
    },
    secretsOf: (moduleId) => (kept.get(moduleId) ?? []).map((t) => ({ name: t.info.name, secret: t.secret, id: t.info.id }))
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the kit observes of the module's scheduler use

/** A use of `ctx.scheduler` the kit saw: where a handler was registered, and every refusal of a schedule. */
export type SchedulerUse =
  | { readonly kind: "handle"; readonly part: "shared" | "instance"; readonly name: string; readonly payload: Schema.Codec<unknown, unknown> }
  | { readonly kind: "scheduled"; readonly call: "schedule" | "prepare"; readonly handler: string; readonly payload: unknown }
  | { readonly kind: "refused"; readonly call: "schedule" | "prepare"; readonly cron: string | undefined; readonly message: string }

const observedScheduler = (hook: SchedulerHook, uses: Array<SchedulerUse>): SchedulerHook => ({
  forPart: (part, runner) => {
    const inner = hook.forPart(part, runner)
    const watch = <A, E extends { readonly reason?: unknown; readonly message?: unknown }>(call: "schedule" | "prepare", cron: string | undefined, effect: Effect.Effect<A, E>) =>
      Effect.tapError(effect, (e) =>
        Effect.sync(() => {
          if (e.reason === "invalid") uses.push({ kind: "refused", call, cron, message: String(e.message) })
        }))
    const scheduler: ModuleScheduler = {
      ...inner,
      handle: (name, handler) =>
        Effect.tap(inner.handle(name, handler), () => Effect.sync(() => void uses.push({ kind: "handle", part: part.kind, name, payload: handler.payload as Schema.Codec<unknown, unknown> }))),
      schedule: (request) =>
        Effect.tap(watch("schedule", (request as { readonly cron?: string }).cron, inner.schedule(request)), () =>
          Effect.sync(() => void uses.push({ kind: "scheduled", call: "schedule", handler: request.handler, payload: request.payload ?? null }))),
      prepare: (request) =>
        Effect.tap(watch("prepare", (request as { readonly cron?: string }).cron, inner.prepare(request)), () =>
          Effect.sync(() => void uses.push({ kind: "scheduled", call: "prepare", handler: request.handler, payload: request.payload ?? null })))
    }
    return scheduler
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// startTestModule

export interface StartTestModuleOptions {
  /** Its saved shared settings (what the owner set on the module's page). */
  readonly settings?: Readonly<Record<string, unknown>>
  /** Its secrets (secret fields), as the key vault gives them. */
  readonly secrets?: Readonly<Record<string, string>>
  /** Stand-ins for the modules it uses: their fake services and contributions (`provide`). */
  readonly provide?: ReadonlyArray<ProvidedModule>
  /** Real modules to run beside it (a provider under test together with its consumer). */
  readonly others?: ReadonlyArray<ModuleDefinition<any>>
  readonly household?: TestHouseholdInput
  /** The test clock's start (epoch ms). Default 2026-11-18 09:00 UTC (a Wednesday, 10:00 in Amsterdam). */
  readonly startAt?: number
  /** Start it at once (default true). With `false`, call `start()`. */
  readonly started?: boolean
  /** Extra registrars (`ModuleHostOptions.registrars`), for the conformance check. */
  readonly registrars?: ReadonlyArray<Registrar>
  readonly graceMs?: number
}

export const DEFAULT_TEST_START = Date.UTC(2026, 10, 18, 9, 0, 0)

/** What one tool call answered, as the model receives it. */
export interface TestToolResult {
  readonly ok: boolean
  /** The text the model gets (JSON for structured results; "Not run: …" for a refusal). */
  readonly content: string
  /** `content` parsed as JSON when it is JSON, else the text. */
  readonly value: unknown
}

export interface TestRouteRequest {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Under `/api/modules/<id>/`: "hook/kitchen". */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  /** The caller: an admin session, a route token's secret, its address (default `192.168.1.20`, on the LAN). */
  readonly as?: { readonly admin?: boolean; readonly token?: string; readonly address?: string }
}

const isLanAddress = (address: string) =>
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === "::1" || /^f[cd]/i.test(address) || /^fe80:/i.test(address)

/**
 * Start `definition` in the real module host, as serve mode runs it: demanded by the test household's assistants (the
 * module and every stand-in on for each, unless an assistant switches it off), with the gateway's access checks,
 * `localPrincipal: false`, the core services over the household, the scheduler engine on the in-memory store, and
 * in-memory route tokens. Inside `it.effect`.
 */
export const startTestModule = <S extends Readonly<Record<string, unknown>>>(definition: ModuleDefinition<any>, options: StartTestModuleOptions = {}) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(options.startAt ?? DEFAULT_TEST_START)
    const id = definition.id
    const standIns = (options.provide ?? []).map(standIn)
    const catalog: ReadonlyArray<ModuleDefinition<any>> = [...standIns, ...(options.others ?? []), definition]
    const input = options.household ?? {}
    const home = { ...DEFAULT_TEST_HOUSEHOLD.home, ...input.home }
    const people = makeTestPeople(input)
    const assistants = input.assistants ?? DEFAULT_TEST_HOUSEHOLD.assistants
    const deviceList = input.devices ?? DEFAULT_TEST_HOUSEHOLD.devices

    // The household store and bus, and the scheduler engine, exactly as makeTestHousehold and makeTestScheduler make them.
    const store: HouseholdStore = makeMemoryHouseholdStore()
    yield* store.prepare(catalog.map((m) => ({ id: m.id, storage: m.storage })), [schedulerStorage]).pipe(Effect.orDie)
    const events: Array<HouseholdEvent> = []
    const recording = { bus: makeEventBus({ observe: (event) => void events.push(event) }), events }
    connectStoreToBus(store, recording.bus)
    const issues = makeIssueRegistry()
    let hostRef: ModuleHost | undefined
    const engine = yield* makeSchedulerEngine({
      store,
      issues,
      modules: () => catalog.map((m) => ({ id: m.id, name: m.name })),
      timeZone: () => (typeof home.HOME_TIME_ZONE === "string" ? home.HOME_TIME_ZONE : undefined),
      gateway: () => hostRef?.gateway,
      pageText: (moduleId, text, max) => hostRef?.pageText(moduleId, text, max) ?? String(text).slice(0, max)
    })
    const schedulerUses: Array<SchedulerUse> = []
    const tokens = makeMemoryRouteTokens()

    // Who has which module on: every assistant has the module and the stand-ins on unless it says otherwise.
    let running = options.started ?? true
    const choiceOf = (assistant: TestAssistant, moduleId: string) => {
      const c = assistant.modules?.[moduleId]
      return c === false ? undefined : c ?? {}
    }
    const demand = () =>
      new Map(catalog.map((m) => [
        m.id,
        m.id === id && !running ? [] : assistants.flatMap((a) => {
          const c = choiceOf(a, m.id)
          return c === undefined ? [] : [{ assistantId: a.id, ...(c.own !== undefined ? { own: c.own } : {}) }]
        })
      ]))
    const assistantIds = new Set(assistants.map((a) => a.id))
    const deviceIds = new Set(deviceList.map((d) => d.id))
    const principalProblem = (principal: Principal): string | undefined => {
      const parts = principal._tag === "turn"
        ? { assistantId: principal.turn.assistantId, deviceId: principal.turn.deviceId, person: principal.turn.person }
        : principal._tag === "job"
        ? { assistantId: principal.job.assistantId, deviceId: principal.job.deviceId, person: principal.job.person }
        : principal._tag === "notification"
        ? { assistantId: undefined, deviceId: principal.notification.deviceId, person: principal.notification.person }
        : undefined
      if (parts === undefined) return undefined
      if (parts.assistantId !== undefined && !assistantIds.has(parts.assistantId)) return `the assistant "${parts.assistantId}" does not exist.`
      if (parts.person !== undefined && !people.isMember(parts.person.id)) return "the person is not in Members."
      if (parts.deviceId === undefined) return undefined
      if (!deviceIds.has(parts.deviceId)) return `the device "${parts.deviceId}" is not known.`
      if (parts.assistantId !== undefined && !people.assistantsOn(parts.deviceId).includes(parts.assistantId)) {
        return `the assistant "${parts.assistantId}" is not on the device "${parts.deviceId}".`
      }
      if (principal._tag === "turn" && parts.person !== undefined && people.devices.get(parts.deviceId)?.place.defaultPerson !== parts.person.id) {
        return `the person is not the default person of the device "${parts.deviceId}".`
      }
      return undefined
    }
    const host = yield* makeModuleHost({
      catalog,
      persistence: readOnlyPersistence({
        modules: { [id]: { enabled: true, ...(options.settings !== undefined ? { settings: options.settings } : {}) } },
        secrets: options.secrets !== undefined ? { [id]: options.secrets } : {}
      }),
      env: {},
      demand,
      household: { store, events: recording.bus },
      scheduler: observedScheduler(engine, schedulerUses),
      coreServices: people.coreServices,
      routeTokens: tokens,
      issues,
      localPrincipal: false,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.registrars !== undefined ? { registrars: options.registrars } : {}),
      access: {
        moduleOn: (assistantId, moduleId) => {
          const a = assistants.find((x) => x.id === assistantId)
          return a !== undefined && choiceOf(a, moduleId) !== undefined && (moduleId !== id || running)
        },
        toolOff: (assistantId, moduleId, toolName) => {
          const a = assistants.find((x) => x.id === assistantId)
          const c = a === undefined ? undefined : choiceOf(a, moduleId)
          return c?.offTools?.includes(toolName) ?? false
        },
        principalProblem
      },
      view: {
        vaultLocked: () => false,
        home: () => home,
        devices: () => people.devices.list().map((d) => ({ id: d.id, name: d.name, kind: d.kind, connections: d.connected ? 1 : 0 }))
      }
    })
    hostRef = host
    yield* host.startEnabled

    const settle = Effect.andThen(engine.settled, Effect.repeat(Effect.yieldNow, { times: 20 }))

    const turn = (t: TestTurnInput = {}): TurnContext => {
      const deviceId = t.device ?? deviceList[0]?.id
      const device = deviceId === undefined ? undefined : people.devices.get(deviceId)
      const person = t.person === undefined ? device?.place.defaultPerson ?? null : t.person
      return makeTestTurn({
        ...t,
        ...(deviceId !== undefined ? { device: deviceId } : {}),
        ...(device !== undefined ? { deviceName: device.name } : {}),
        assistant: t.assistant ?? (deviceId === undefined ? assistants[0]?.id : people.assistantsOn(deviceId)[0]) ?? "jeff",
        person,
        ...(t.room ?? device?.room) !== undefined ? { room: (t.room ?? device?.room)! } : {}
      })
    }
    const asTurn = (t: TurnContext | TestTurnInput | undefined) => (t !== undefined && "turnId" in t && "source" in t && "conversationId" in t ? (t as TurnContext) : turn(t as TestTurnInput | undefined))
    let calls = 0

    const harness = {
      host,
      moduleId: id,
      /** The household store (`forModule(id)` is what the module's `ctx.store` reads), the bus's recorded events. */
      store,
      moduleStore: (): ModuleStore => store.forModule(id),
      events: recording.events as ReadonlyArray<HouseholdEvent>,
      scheduler: engine,
      people,
      /** What the kit saw of the module's scheduler use (`checkModule` reads it). */
      schedulerUses: schedulerUses as ReadonlyArray<SchedulerUse>,
      /** The `CurrentTurn` serve mode would make for a turn on a device of the household. */
      turn,
      /** The module's line on the admin page now. */
      info: (): ModuleInfo | undefined => host.modules().find((m) => m.id === id),
      issues: (): ReadonlyArray<HealthIssue> => host.issues.all().filter((i) => i.module === id),
      /** Run every module's `health()` now (as "Check again" does) and answer the module's issues. */
      checkHealth: Effect.map(host.checkHealth, () => host.issues.all().filter((i) => i.module === id)),
      /** The tools the turn's assistant is offered (names), as its registry has them. */
      toolNames: (as?: TestTurnInput) => {
        const t = turn(as)
        return makeToolRegistry((host.snapshot().assistantParts.get(t.assistantId!) ?? []).map((p) => p.module), { gateway: host.gateway }).specs.map((s) => s.name)
      },
      /**
       * Call a tool as the model's tool loop does, through the assistant's registry and the real gateway, as the turn
       * (`TurnContext`, or a `TestTurnInput` resolved against the household; default the first device's).
       */
      tool: (name: string, input: unknown, as?: TurnContext | TestTurnInput) =>
        Effect.gen(function*() {
          const t = asTurn(as)
          const parts = host.snapshot().assistantParts.get(t.assistantId ?? "") ?? []
          const registry = makeToolRegistry(parts.map((p) => p.module), { gateway: host.gateway })
          const result = yield* registry.run({ id: `kit-${++calls}`, name, input }).pipe(Effect.provideService(CurrentTurn, t))
          let value: unknown = result.content
          try {
            value = JSON.parse(result.content)
          } catch {
            // Plain text.
          }
          return { ok: !result.isError, content: result.content, value } satisfies TestToolResult
        }),
      /** Run one of the module's actions with its values in tool input form, as `host.actions.run` does (routines). */
      action: (actionId: string, params: Readonly<Record<string, unknown>> = {}, as?: TurnContext | TestTurnInput): Effect.Effect<ActionRunResult> =>
        host.actions.run({ moduleId: id, actionId, params }).pipe(Effect.provideService(CurrentTurn, asTurn(as))),
      /** Run `effect` as a turn: what a tool's code would see (`CurrentTurn`), for calling services directly. */
      asTurn: <A, E, R>(effect: Effect.Effect<A, E, R>, as?: TurnContext | TestTurnInput) => Effect.provideService(effect, CurrentTurn, asTurn(as)),
      /** A service published now (the module's own, a stand-in's, or the core's). */
      service: <T>(key: ServiceKey<T>): T | undefined => host.service(key),
      /** The contributions under `key` that a turn's assistant sees (default the first device's turn). */
      contributions: <T>(key: ContributionKey<T>, as?: TurnContext | TestTurnInput) => host.contributions(key).pipe(Effect.provideService(CurrentTurn, asTurn(as))),
      /** The module's live and finished jobs (the admin list, filtered to it). */
      jobs: Effect.gen(function*() {
        const out: Array<JobRow> = []
        let cursor: string | undefined
        for (let i = 0; i < 100; i++) {
          const page = yield* engine.listAll(cursor === undefined ? {} : { cursor })
          out.push(...page.jobs.filter((j) => j.job.module === id).map((j) => j.job))
          if (page.next === undefined) break
          cursor = page.next
        }
        return out as ReadonlyArray<JobRow>
      }),
      /** Now, on the test clock (epoch ms). */
      now: Clock.currentTimeMillis,
      /** Move the test clock by `ms` and let the scheduler run what came due (handlers run through the gateway). */
      advance: (ms: number) => Effect.andThen(Effect.andThen(settle, TestClock.adjust(ms)), settle),
      /** Move the clock to a job's due time and let it run. */
      runJob: (jobId: string) =>
        Effect.gen(function*() {
          const job = (yield* harness.jobs).find((j) => j.id === jobId)
          if (job === undefined) return yield* Effect.die(new Error(`No job ${jobId} of ${id}`))
          const now = yield* Clock.currentTimeMillis
          yield* harness.advance(Math.max(0, job.dueAt - now))
        }),
      /**
       * Call one of the module's routes, with the guards it declares checked against `as` (an admin session, a token's
       * secret minted by the module, a LAN address), its body mode and its time limit; the handler runs in its shared
       * part's scope like the server runs it. Rate limits and the same-site check of the server are not part of it.
       */
      route: (request: TestRouteRequest) =>
        Effect.gen(function*() {
          const method = request.method ?? "GET"
          const segments = request.path === "" ? [] : request.path.split("/")
          const mine = host.routes().filter((r) => r.moduleId === id)
          const matching = mine.filter((r) => matchRoutePath(r.route, segments) !== undefined)
          if (matching.length === 0) return { status: 404 } satisfies RouteResponse
          const published = matching.find((r) => r.route.method === method)
          if (published === undefined) return { status: 405 } satisfies RouteResponse
          const route = published.route
          const address = request.as?.address ?? "192.168.1.20"
          for (const guard of route.guards ?? []) {
            if (guard === "lan" && !isLanAddress(address)) return { status: 403 } satisfies RouteResponse
            if (guard === "admin" && request.as?.admin !== true) return { status: 401 } satisfies RouteResponse
            if (guard === "token" && !tokens.secretsOf(id).some((t) => t.name === route.token && t.secret === request.as?.token)) return { status: 401 } satisfies RouteResponse
          }
          const mode = route.body ?? (method === "GET" || method === "DELETE" ? "none" : "json")
          if (mode === "none" && request.body !== undefined) return { status: 413 } satisfies RouteResponse
          const limit = route.bodyLimitBytes ?? 8 * 1024
          if (request.body !== undefined && new TextEncoder().encode(JSON.stringify(request.body)).length > limit) return { status: 413 } satisfies RouteResponse
          const tokenUsed = tokens.secretsOf(id).find((t) => t.secret === request.as?.token)
          const req = {
            method,
            path: request.path,
            params: matchRoutePath(route, segments)!,
            query: Object.assign(Object.create(null), request.query ?? {}),
            queryAll: Object.assign(Object.create(null), Object.fromEntries(Object.entries(request.query ?? {}).map(([k, v]) => [k, [v]]))),
            headers: Object.assign(Object.create(null), Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => k !== "authorization"))),
            body: mode === "bytes" && typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body,
            address,
            ...(tokenUsed !== undefined ? { token: { id: tokenUsed.id, name: tokenUsed.name, label: "test" } } : {})
          }
          const fiber = yield* Effect.forkIn(Effect.suspend(() => route.handler(req)), published.scope)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(route.timeoutMs ?? 5_000))
          if (exit._tag === "None") {
            yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach)
            return { status: 504 } satisfies RouteResponse
          }
          if (Exit.isFailure(exit.value)) return { status: Exit.hasInterrupts(exit.value) ? 503 : 500 } satisfies RouteResponse
          return exit.value.value
        }),
      /** The route tokens of the module (minted by it, or by `mintRouteToken`), with their secrets, to call its token routes. */
      routeTokens: () => tokens.secretsOf(id),
      /** Mint a route token as the owner does on the module's page ("Web addresses"); its `secret` is the bearer token. */
      mintRouteToken: (name: string, label = "test caller") => tokens.forModule(id).mint(name, label),
      /** Switch the module off for every assistant (its parts close) and wait until it has stopped. */
      stop: Effect.suspend(() => {
        running = false
        return host.refresh
      }),
      /** Switch it on again and wait until it runs (or failed). */
      start: Effect.suspend(() => {
        running = true
        return host.refresh
      }),
      /** Stop it, then start it again: a new shared part and new instances, as after a restart of the server. */
      restart: Effect.suspend(() => {
        running = false
        return Effect.andThen(host.refresh, Effect.suspend(() => {
          running = true
          return host.refresh
        }))
      }),
      /** Change its saved settings as the owner would on its page (a module that runs is stopped and started again). */
      configure: (patch: Readonly<Record<string, SettingValue | null>>) => host.configure(id, patch as never)
    }
    return harness
  })

export type ModuleHarness = Effect.Success<ReturnType<typeof startTestModule>>

// ---------------------------------------------------------------------------------------------------------------------
// The scaffold's check

/**
 * Every module of `catalog` is accepted by the real host and is off for an installation that has not chosen it: with
 * demand and no assistant that has it on (serve mode), and with no saved switch (the CLI modes), nothing of it runs.
 */
export const expectOffByDefault = (catalog: ReadonlyArray<ModuleDefinition<any>>) =>
  Effect.gen(function*() {
    const problems: Array<string> = []
    for (const def of catalog) if (def.enabledByDefault) problems.push(`${def.id}: enabledByDefault must be false`)
    // The CLI modes: no saved switch, no demand.
    const cli = yield* makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, localPrincipal: true })
    yield* cli.startEnabled
    for (const m of cli.modules()) {
      if (m.enabled || m.state !== "disabled") problems.push(`${m.id}: in the CLI modes it is ${m.enabled ? "on" : "off"} and ${m.state}, not off and disabled`)
      if (m.error !== undefined) problems.push(`${m.id}: ${m.error}`)
    }
    if (cli.snapshot().parts.length > 0) problems.push(`the CLI modes run ${cli.snapshot().parts.map((p) => p.moduleId).join(", ")}`)
    // Serve mode: demand from assistants that have none of them on.
    const serve = yield* makeModuleHost({
      catalog,
      persistence: readOnlyPersistence(),
      env: {},
      demand: () => new Map(catalog.map((d) => [d.id, []])),
      localPrincipal: false,
      access: { moduleOn: () => false, toolOff: () => false }
    })
    yield* serve.startEnabled
    for (const m of serve.modules()) if (m.state !== "disabled") problems.push(`${m.id}: in serve mode it is ${m.state} with no assistant that has it on`)
    for (const i of serve.issues.all()) if (i.severity === "error") problems.push(`${i.module ?? "?"}: ${i.title}${i.detail !== "" ? `: ${i.detail}` : ""}`)
    if (problems.length > 0) return yield* Effect.die(new Error(`Not off by default:\n- ${problems.join("\n- ")}`))
  })

/** A started part's raw value and instance, as a registrar receives them (the conformance check reads tools from it). */
export const recordParts = (into: Array<StartedPart>): Registrar => (part) => {
  into.push(part)
  return []
}
