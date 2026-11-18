/**
 * The module test kit (docs/MODULES.md, "Testing"; docs/MODULES-PLAN.md §4 P11): one module definition started in the
 * **real** module host, with the real execution gateway and its risk policy, the real scheduler engine on the
 * in-memory household store, and the core's real `Privacy` rule over a test household that is **fixed for the test**
 * (its people, devices, default people and places do not change while it runs); handles to run a tool, an action or a
 * job of it as a given turn, and to stop and restart it. It does not imitate the HTTP router: routes are tested by the
 * first module that has one, in the app's serve tests. Exported from `@pva/core/testing` only.
 *
 * Run it inside `it.effect` (the test clock): `startTestModule` sets the clock to `startAt` first, and `advance(ms)`
 * moves it and lets the scheduler run what came due. Where the kit waits on the module's own code (a start, a stop, a
 * restart, a settings change, a health check, closing the test's modules), it **drives the test clock** until the wait
 * is over: from one pending timer to the next, at most `KIT_WAIT_CAP_MS` of test-clock time, after which it fails the
 * test naming what did not finish (it never hangs, and never waits for the unfinished work). Everything it makes lives
 * in the test's scope; when that closes, the kit stops the modules (driving the clock the same way).
 *
 * A stub's method called without a programmed answer (`stubService`) fails the test: the kit asserts it after the
 * start, after each of its calls and lifecycle steps, and when the test's scope closes.
 */
import {
  BUILT_IN_PLACE,
  type DeviceCapabilities,
  type DevicePrivacy,
  type HealthIssue,
  homeValuesOf,
  linkedModuleDefaults,
  type ModuleInfo,
  type SettingsPatch,
  type SettingValue
} from "@pva/protocol"
import { Clock, Deferred, Effect, Exit, Fiber, type Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { ActionRunResult, ContributionKey, ModuleHostApi, ProvidedContribution, ProvidedService, ServiceKey } from "./ModuleApi.ts"
import { type KnownDevice, Devices, makeDevices } from "./Devices.ts"
import type { HouseholdStore, ModuleStore, Row } from "./HouseholdStore.ts"
import { defineModule, type ModuleDefinition } from "./ModuleDefinition.ts"
import { makeModuleHost, type ModuleHost, readOnlyPersistence } from "./ModuleHost.ts"
import type { Registrar, StartedPart } from "./ModuleRegistrations.ts"
import { takeUnprogrammedStubCalls, UnprogrammedStubCall } from "./ModuleStubs.ts"
import { type Diet, EMPTY_DIET, effectiveDiet, findPerson, People, type PeopleService, type Person, peopleError } from "./People.ts"
import { makePrivacy, Privacy } from "./Privacy.ts"
import { defaultRiskPolicy } from "./RiskPolicy.ts"
import type { JobRow, ModuleScheduler, SchedulerHook } from "./Scheduler.ts"
import { NOT_ONE_LINE } from "./SettingsExtra.ts"
import { makeToolRegistry, withoutOffTools } from "./ToolRegistry.ts"
import { type ConnectionRef, CurrentTurn, makeConnectionRef, type Principal, type TurnContext, type TurnSource } from "./TurnContext.ts"
import { connectStoreToBus, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import { makeIssueRegistry } from "./Issues.ts"
import { makeMemoryHouseholdStore } from "./MemoryHouseholdStore.ts"
import { makeSchedulerEngine } from "./SchedulerEngine.ts"
import { schedulerStorage } from "./SchedulerJobs.ts"
import { type DndState, type Notification, notifications as notificationRows, NOTIFY_OWNER, notifyStorage, type PressAnswer, type StoredNotification } from "./Notify.ts"
import { type DecisionRecord, makeNotifyEngine, notificationView, type NotifyMessage, type SpeechPort } from "./NotifyEngine.ts"
import { notifyLanguageOf } from "./NotifyTexts.ts"

// ---------------------------------------------------------------------------------------------------------------------
// The household

export interface TestPerson {
  /** A Members id (`/^[a-z0-9][a-z0-9_-]{0,39}$/`): "p-sam". */
  readonly id: string
  readonly name: string
  readonly aliases?: ReadonlyArray<string>
  /** As the server keeps a diet (`dietProblem`): the kit refuses one the server would have cleaned up. */
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
 * The household a test gets when it names none: Sam, Robin and Alex; a shared kitchen display whose default person is
 * Sam, Robin's private phone, and a public hall screen. Alex is nobody's default person, so Alex's personal content is
 * revealed on no shared device. One assistant, `jeff`, on all three devices. English, Amsterdam.
 */
export const DEFAULT_TEST_HOUSEHOLD: Required<Omit<TestHouseholdInput, "householdDiet">> = {
  people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }, { id: "p-alex", name: "Alex" }],
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null }
  ],
  assistants: [{ id: "jeff" }],
  home: { HOME_LANGUAGE: "en-GB", HOME_TIME_ZONE: "Europe/Amsterdam", HOME_UNITS: "metric", HOME_LOCATION: "Utrecht" }
}

/**
 * Why a diet list is not as the server keeps one, or `undefined`: the server (Members, `People.setDiet`) keeps each
 * item as one line, trimmed, single-spaced, 1 to 60 characters, without repeats ignoring case, at most 30 items. Its
 * cleaning lives in the app, not in the core, so the kit cannot apply it: it takes only diets that are already clean.
 */
export const dietProblem = (list: ReadonlyArray<string>): string | undefined => {
  if (list.length > 30) return "a diet has at most 30 items"
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== "string" || NOT_ONE_LINE.test(item)) return `"${String(item)}" is not one line of text`
    if (item !== item.replace(/\s+/gu, " ").trim() || item === "" || item.length > 60) return `"${item}" is not trimmed, single-spaced and 1 to 60 characters`
    if (seen.has(item.toLowerCase())) return `"${item}" is in the list twice`
    seen.add(item.toLowerCase())
  }
  return undefined
}

const cleanDiet = (diet: Partial<Diet> | undefined, whose: string): Diet => {
  const out = { ...EMPTY_DIET, ...diet }
  for (const k of Object.keys(EMPTY_DIET) as Array<keyof Diet>) {
    const problem = dietProblem(out[k])
    if (problem !== undefined) throw new Error(`The test kit's household: ${whose}'s ${k}: ${problem} (the kit takes diets as the server keeps them)`)
  }
  return out
}

/** The connection the kit's turns on a device come in on: one per device, the same for every turn of the test. */
export const testConnectionOf = (deviceId: string): ConnectionRef => makeConnectionRef(`kit-connection-${deviceId}`)

/**
 * The core's own services over a test household that does not change while the test runs: `People` (`findPerson`,
 * `effectiveDiet`; `setDiet` is refused, because the household is fixed), `Privacy` (`makePrivacy`: the core's rule
 * over the devices' places and Members) and `Devices` (`makeDevices`). Throws when the household is not one serve
 * mode could have (a default person who is not a member, a diet the server would have cleaned).
 */
export const makeTestPeople = (input: TestHouseholdInput = {}) => {
  const people = new Map<string, Person>(
    (input.people ?? DEFAULT_TEST_HOUSEHOLD.people).map((p) => [p.id, { id: p.id, name: p.name, aliases: [...(p.aliases ?? [])], pronunciation: "", diet: cleanDiet(p.diet, p.name) }])
  )
  const householdDiet: Diet = cleanDiet(input.householdDiet, "the household")
  const devices = new Map<string, KnownDevice>()
  const assistantsOf = new Map<string, ReadonlyArray<string>>()
  const allAssistants = (input.assistants ?? DEFAULT_TEST_HOUSEHOLD.assistants).map((a) => a.id)
  for (const d of input.devices ?? DEFAULT_TEST_HOUSEHOLD.devices) {
    const room = d.room?.trim() ?? ""
    const defaultPerson = d.defaultPerson ?? null
    if (defaultPerson !== null && !people.has(defaultPerson)) throw new Error(`The test kit's household: the default person of ${d.id} (${defaultPerson}) is not one of its people`)
    devices.set(d.id, {
      id: d.id,
      name: d.name,
      kind: d.kind ?? "web-voice",
      room: room === "" ? undefined : room,
      place: { ...BUILT_IN_PLACE, room, privacy: d.privacy ?? "shared", defaultPerson },
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
    setDiet: () => Effect.fail(peopleError("not_saved", "The test kit's household is fixed for a test; give the diets to startTestModule."))
  }
  const privacy = makePrivacy((id) => devices.get(id)?.place, (id) => people.has(id))
  const devicesService = makeDevices(() => [...devices.values()])
  const connections = new Map([...devices.keys()].map((id) => [testConnectionOf(id).id, id] as const))
  return {
    people: peopleService,
    privacy,
    devices: devicesService,
    /** The core services as the host gets them (`ModuleHostOptions.coreServices`). */
    coreServices: [People.of(peopleService), Privacy.of(privacy), Devices.of(devicesService)] as ReadonlyArray<ProvidedService>,
    assistantsOn: (deviceId: string) => assistantsOf.get(deviceId) ?? [],
    isMember: (id: string) => people.has(id),
    /** The device a connection of the kit's belongs to (`testConnectionOf`), or `undefined`. */
    deviceOfConnection: (connection: ConnectionRef) => connections.get(connection.id)
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
  /**
   * Who is speaking: `null` for nobody. Through the harness (`kit.turn`, `kit.tool(…, as)`), the default is the
   * device's default person, as serve mode does; `makeTestTurn` alone has no household and gives no person unless
   * named. Any person but the device's default is refused by the gateway, as in serve mode.
   */
  readonly person?: string | null
  readonly source?: TurnSource
  /** Default 1: every turn the kit makes has the same id unless given; a multi-turn test gives each its own. */
  readonly turnId?: number
  /** Default "conversation-1", the same for every turn unless given. */
  readonly conversationId?: string
}

/**
 * A synthetic `CurrentTurn` from the input alone (device `kitchen-display`, assistant `jeff`, with that device's
 * connection, `testConnectionOf`): no person, room or device name unless given, because it knows no household. For a
 * turn of the test household, as serve mode makes it, use `harness.turn` (or pass a `TestTurnInput` to a handle).
 */
export const makeTestTurn = (input: TestTurnInput & { readonly deviceName?: string; readonly room?: string } = {}): TurnContext => {
  const deviceId = input.device ?? "kitchen-display"
  return {
    turnId: input.turnId ?? 1,
    conversationId: input.conversationId ?? "conversation-1",
    assistantId: input.assistant ?? "jeff",
    deviceId,
    ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
    ...(input.room !== undefined ? { room: input.room } : {}),
    ...(input.person !== undefined && input.person !== null ? { person: { id: input.person, how: "device-default" as const } } : {}),
    connection: testConnectionOf(deviceId),
    source: input.source ?? "voice"
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stand-ins for the modules a module uses

/** A stand-in for another module: its id, and the services (stubs, `stubService`) and contributions its `shared` part provides. */
export interface ProvidedModule {
  readonly moduleId: string
  readonly services?: ReadonlyArray<ProvidedService>
  readonly contributions?: ReadonlyArray<ProvidedContribution>
}

/** `provide("lists", { services: [Lists.of(stub.service)] })`. */
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
// What the kit observes of the module's scheduler use

/**
 * A use of `ctx.scheduler` the kit saw, with the module that made it: where a handler was registered, a job written
 * (its payload as stored, a copy), and every refusal of a `schedule`, `prepare` or `reschedule` by the real engine,
 * with the engine's own reason and message.
 */
export type SchedulerUse =
  | { readonly kind: "handle"; readonly moduleId: string; readonly part: "shared" | "instance"; readonly name: string; readonly payload: Schema.Codec<unknown, unknown> }
  | { readonly kind: "scheduled"; readonly moduleId: string; readonly call: "schedule" | "prepare"; readonly handler: string; readonly payload: unknown }
  | { readonly kind: "refused"; readonly moduleId: string; readonly call: "schedule" | "prepare" | "reschedule"; readonly reason: string; readonly message: string }

/** One announcement the kit's speech played: where, what, when it started, and how it ended (absent: still playing). */
export interface KitAnnouncement {
  readonly deviceId: string
  readonly text: string
  readonly cue: boolean
  readonly startedAt: number
  readonly outcome?: "spoken" | "stopped"
}

/** A JSON copy of a payload as the scheduler stores it (an absent payload is `{}`). */
const storedForm = (payload: unknown): unknown => {
  if (payload === undefined) return {}
  try {
    const text = JSON.stringify(payload)
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

const observedScheduler = (hook: SchedulerHook, uses: Array<SchedulerUse>): SchedulerHook => ({
  forPart: (part, runner) => {
    const inner = hook.forPart(part, runner)
    const moduleId = part.moduleId
    const watch = <A, E extends { readonly reason?: unknown; readonly message?: unknown }>(call: "schedule" | "prepare" | "reschedule", effect: Effect.Effect<A, E>) =>
      Effect.tapError(effect, (e) => Effect.sync(() => void uses.push({ kind: "refused", moduleId, call, reason: String(e.reason), message: String(e.message) })))
    const scheduler: ModuleScheduler = {
      ...inner,
      handle: (name, handler) =>
        Effect.tap(inner.handle(name, handler), () =>
          Effect.sync(() => void uses.push({ kind: "handle", moduleId, part: part.kind, name, payload: handler.payload as Schema.Codec<unknown, unknown> }))),
      schedule: (request) => {
        const payload = storedForm(request.payload)
        return Effect.tap(watch("schedule", inner.schedule(request)), () =>
          Effect.sync(() => void uses.push({ kind: "scheduled", moduleId, call: "schedule", handler: request.handler, payload })))
      },
      prepare: (request) => {
        const payload = storedForm(request.payload)
        return Effect.tap(watch("prepare", inner.prepare(request)), () =>
          Effect.sync(() => void uses.push({ kind: "scheduled", moduleId, call: "prepare", handler: request.handler, payload })))
      },
      reschedule: (id, when) => watch("reschedule", inner.reschedule(id, when))
    }
    return scheduler
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Waiting on the module's code under the test clock

/**
 * The most test-clock time one wait of the kit may take (a start with every `others` module, a stop with its grace
 * periods and finalizers, a restart, a settings change, a health check, closing the test's modules): 10 minutes.
 */
export const KIT_WAIT_CAP_MS = 10 * 60_000

/** The earliest pending timer of the test clock, in ms from now; `undefined` when none is pending, `null` when unknown. */
const nextTimer = TestClock.testClockWith((clock) =>
  Effect.sync((): number | undefined | null => {
    // The test clock keeps its pending sleeps sorted latest first; it has no public reader for them.
    const sleeps = (clock as unknown as { readonly sleeps?: unknown }).sleeps
    if (!Array.isArray(sleeps)) return null
    const earliest = (sleeps as ReadonlyArray<{ readonly timestamp?: unknown }>).at(-1)?.timestamp
    return typeof earliest === "number" ? Math.max(1, earliest - clock.currentTimeMillisUnsafe()) : undefined
  })
)

/** Let `fiber` run as far as it can without the test clock moving: fibers first, then a few real event-loop turns. */
const letRun = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Effect.gen(function*() {
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) yield* Effect.yieldNow
    for (let turn = 0; turn < 20 && fiber.pollUnsafe() === undefined; turn++) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
      for (let i = 0; i < 50 && fiber.pollUnsafe() === undefined; i++) yield* Effect.yieldNow
    }
  })

/**
 * Run `effect`, which waits on module code, and drive the test clock until it has finished: while it has not, move the
 * clock to the next pending timer. A wait that has not finished after `KIT_WAIT_CAP_MS` of test-clock time, or that
 * waits on nothing the clock can move, fails the test naming `what`; the unfinished work is interrupted without being
 * waited for. A wait that finishes at once never sees the clock move.
 */
const driven = <A, E>(what: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    // Detached: a wait that is given up must not hold the test's own fiber when it ends.
    const fiber = yield* Effect.forkDetach(effect)
    const startedAt = yield* Clock.currentTimeMillis
    for (;;) {
      yield* letRun(fiber)
      if (fiber.pollUnsafe() !== undefined) return yield* Fiber.join(fiber)
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt
      const next = yield* nextTimer
      const step = next === null ? 1_000 : next
      if (step === undefined || elapsed + step > KIT_WAIT_CAP_MS) {
        fiber.interruptUnsafe()
        const why = step === undefined ? "it waits on nothing the test clock can move" : `${KIT_WAIT_CAP_MS / 60_000} minutes of test-clock time passed`
        return yield* Effect.die(new Error(`The test kit gave up waiting for ${what}: ${why} (it moved the clock ${elapsed} ms). Some code of a module under test does not finish.`))
      }
      yield* TestClock.adjust(step)
    }
  })

/** The host's shortest distance between two restarts a module asks for. */
const RESTART_INTERVAL_MS = 5_000

/** The most pages of the scheduler's job list `jobs` reads before it fails (each page holds every module's jobs). */
const MAX_JOB_LIST_PAGES = 1_000

/** A stub's method was called without an answer: the test fails with it, whatever the module did with the error. */
const failOnUnprogrammedStubs = (when: string) =>
  Effect.suspend(() => {
    const calls = takeUnprogrammedStubCalls()
    if (calls.length === 0) return Effect.void
    const first = calls[0]!
    return Effect.die(Object.assign(new UnprogrammedStubCall(first.service, first.method), {
      message: `${first.message} (found ${when}${calls.length > 1 ? `; ${calls.length - 1} more unprogrammed call${calls.length > 2 ? "s" : ""}` : ""})`
    }))
  })

/** `effect`, then the unprogrammed stub calls it made fail the test (also when `effect` failed). */
const checked = <A, E, R>(when: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.exit(effect), (exit) => Effect.andThen(failOnUnprogrammedStubs(when), exit))

/** Every string a value holds, its keys included, decoded: a string that is JSON is parsed and walked too. */
const stringsOf = (value: unknown, out: Array<string> = [], seen = new Set<object>(), depth = 0): Array<string> => {
  if (depth > 64) return out
  if (typeof value === "string") {
    out.push(value)
    const t = value.trim()
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith("\"")) {
      try {
        stringsOf(JSON.parse(t), out, seen, depth + 1)
      } catch {
        // Not JSON: the text itself was taken.
      }
    }
    return out
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return out
  seen.add(value)
  if (value instanceof Error) stringsOf(value.message, out, seen, depth + 1)
  const entries = value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value].map((v, i) => [i, v] as const) : Object.entries(value)
  for (const [k, v] of entries) {
    if (typeof k === "string") out.push(k)
    else stringsOf(k, out, seen, depth + 1)
    stringsOf(v, out, seen, depth + 1)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// startTestModule

export interface StartTestModuleOptions {
  /** Its saved shared settings (what the owner set on the module's page). */
  readonly settings?: Readonly<Record<string, unknown>>
  /** Its secrets (secret fields), as the key vault gives them. */
  readonly secrets?: Readonly<Record<string, string>>
  /** Stand-ins for the modules it uses: their services (stubs) and contributions (`provide`). */
  readonly provide?: ReadonlyArray<ProvidedModule>
  /** Real modules to run beside it (a provider under test together with its consumer). */
  readonly others?: ReadonlyArray<ModuleDefinition<any>>
  /** The household, fixed for the test (default `DEFAULT_TEST_HOUSEHOLD`). */
  readonly household?: TestHouseholdInput
  /** The test clock's start (epoch ms). Default 2026-11-18 09:00 UTC (a Wednesday, 10:00 in Amsterdam). */
  readonly startAt?: number
  /** Start it at once (default true). With `false`, call `start()`. */
  readonly started?: boolean
  /** Extra registrars (`ModuleHostOptions.registrars`), for the conformance check. */
  readonly registrars?: ReadonlyArray<Registrar>
  readonly graceMs?: number
  /** P9: how long one announcement takes to play on the kit's speech (test-clock ms). Default 2,000. */
  readonly speechMs?: number
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

/**
 * Start `definition` in the real module host, as serve mode runs it: demanded by the test household's assistants (the
 * module and every stand-in on for each, unless an assistant switches it off), with the gateway's access checks and
 * serve mode's risk policy (`defaultRiskPolicy`), `localPrincipal: false`, the core services over the household, and
 * the scheduler engine on the in-memory store. Inside `it.effect`.
 */
export const startTestModule = (definition: ModuleDefinition<any>, options: StartTestModuleOptions = {}) =>
  Effect.gen(function*() {
    // Unprogrammed calls nobody reported yet (a stub called outside any kit) fail here, never cleared silently.
    yield* failOnUnprogrammedStubs("before the test kit started (a stub was called outside a kit; read them with takeUnprogrammedStubCalls)")
    yield* TestClock.setTime(options.startAt ?? DEFAULT_TEST_START)
    const id = definition.id
    // The module's own host handles, as its parts receive them: `restart` asks the host for a real restart through the
    // newest live one (the host has no other call that restarts one module with its demand kept).
    const partHosts: Array<ModuleHostApi> = []
    const observed: ModuleDefinition<any> = {
      ...definition,
      ...(definition.shared !== undefined
        ? {
          shared: (ctx: Parameters<NonNullable<ModuleDefinition<any>["shared"]>>[0]) => {
            partHosts.push(ctx.host)
            return definition.shared!(ctx)
          }
        }
        : {}),
      start: (ctx: Parameters<ModuleDefinition<any>["start"]>[0]) => {
        // A version 1 module's context has no `host`.
        const own = (ctx as { readonly host?: ModuleHostApi }).host
        if (own !== undefined) partHosts.push(own)
        return definition.start(ctx)
      }
    }
    const standIns = (options.provide ?? []).map(standIn)
    const catalog: ReadonlyArray<ModuleDefinition<any>> = [...standIns, ...(options.others ?? []), observed]
    const input = options.household ?? {}
    const home = { ...DEFAULT_TEST_HOUSEHOLD.home, ...input.home }
    const people = makeTestPeople(input)
    const assistants = input.assistants ?? DEFAULT_TEST_HOUSEHOLD.assistants
    const deviceList = input.devices ?? DEFAULT_TEST_HOUSEHOLD.devices

    // Everything the modules run in lives in a scope of the kit's, closed when the test's scope closes: the kit drives
    // the clock through the modules' stops and finalizers there, and then asserts the stubs, so neither hangs nor hides.
    const lifetime = yield* Scope.make()
    yield* Effect.addFinalizer(() =>
      Effect.andThen(driven(`the modules of the test to stop (${id})`, Scope.close(lifetime, Exit.void)), failOnUnprogrammedStubs("when the test's scope closed"))
    )
    // The household store and bus, and the scheduler engine, exactly as makeTestHousehold and makeTestScheduler make them.
    const store: HouseholdStore = makeMemoryHouseholdStore()
    yield* store.prepare(catalog.map((m) => ({ id: m.id, storage: m.storage })), [schedulerStorage, notifyStorage]).pipe(Effect.orDie)
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
    }).pipe(Scope.provide(lifetime))
    const schedulerUses: Array<SchedulerUse> = []

    // P9: the real notification service on the same store, clock and gateway; pages and voices are recorders.
    const connectedNow = new Set(deviceList.filter((d) => d.connected !== false).map((d) => d.id))
    const declaredOf = new Map(deviceList.map((d) => [d.id, d.capabilities] as const))
    const pageMessages: Array<{ readonly deviceId: string; readonly message: NotifyMessage }> = []
    const decisions: Array<DecisionRecord> = []
    const announced: Array<KitAnnouncement> = []
    const replying = new Map<string, Deferred.Deferred<void>>()
    const speechMs = options.speechMs ?? 2_000
    const speech: SpeechPort = {
      quiet: (deviceId) => Effect.suspend(() => {
        const d = replying.get(deviceId)
        return d === undefined ? Effect.void : Deferred.await(d)
      }),
      play: (deviceId, text, o) =>
        Effect.gen(function*() {
          const record: { -readonly [K in keyof KitAnnouncement]: KitAnnouncement[K] } = { deviceId, text, cue: o.cue, startedAt: yield* Clock.currentTimeMillis }
          announced.push(record)
          yield* Effect.sleep(speechMs).pipe(Effect.onInterrupt(() => Effect.sync(() => void (record.outcome = "stopped"))))
          record.outcome = "spoken"
        })
    }
    const notify = yield* makeNotifyEngine({
      store,
      scheduler: engine,
      devices: () => people.devices.list(),
      connected: (deviceId) => connectedNow.has(deviceId),
      // A kit device judged by the capabilities it was given; one given none is a page that never declared (it can do both).
      canSpeak: (d) => {
        const c = declaredOf.get(d.id)
        return c === undefined || c.speaker?.media.includes("speech") === true
      },
      canShow: (d) => {
        const c = declaredOf.get(d.id)
        return c === undefined || c.display !== undefined
      },
      privacy: people.privacy,
      outlet: () => ({ send: (deviceId, message) => void pageMessages.push({ deviceId, message }) }),
      speech: () => speech,
      gateway: () => hostRef?.gateway,
      pageText: (moduleId, text, max) => hostRef?.pageText(moduleId, text, max) ?? String(text).slice(0, max),
      language: () => notifyLanguageOf(home.HOME_LANGUAGE),
      onDecision: (record) => void decisions.push(record)
    }).pipe(Scope.provide(lifetime))

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
    /** Serve mode's `principalProblem` (`serveMode.ts`), over the fixed household. */
    const principalProblem = (principal: Principal): string | undefined => {
      const parts = principal._tag === "turn"
        ? { assistantId: principal.turn.assistantId, deviceId: principal.turn.deviceId, connection: principal.turn.connection, person: principal.turn.person }
        : principal._tag === "job"
        ? { assistantId: principal.job.assistantId, deviceId: principal.job.deviceId, connection: undefined, person: principal.job.person }
        : principal._tag === "notification"
        ? { assistantId: undefined, deviceId: principal.notification.deviceId, connection: principal.notification.connection, person: principal.notification.person }
        : undefined
      if (parts === undefined) return undefined
      if (parts.assistantId !== undefined && !assistantIds.has(parts.assistantId)) return `the assistant "${parts.assistantId}" does not exist.`
      if (parts.person !== undefined && !people.isMember(parts.person.id)) return "the person is not in Members."
      if (parts.deviceId === undefined) return undefined
      if (!deviceIds.has(parts.deviceId)) return `the device "${parts.deviceId}" is not known.`
      if (parts.assistantId !== undefined && !people.assistantsOn(parts.deviceId).includes(parts.assistantId)) {
        return `the assistant "${parts.assistantId}" is not on the device "${parts.deviceId}".`
      }
      if (parts.connection !== undefined && people.deviceOfConnection(parts.connection) !== parts.deviceId) return `the request did not come from the device "${parts.deviceId}".`
      if (principal._tag === "turn" && parts.person !== undefined && people.devices.get(parts.deviceId)?.place.defaultPerson !== parts.person.id) {
        return `the person is not the default person of the device "${parts.deviceId}".`
      }
      return undefined
    }
    // Home-linked defaults exactly as serve mode resolves them (`linkedModuleDefaults` over the Home values).
    const homeDefaults = (moduleId: string) => linkedModuleDefaults(homeValuesOf((key) => home[key]))[moduleId]
    const host = yield* makeModuleHost({
      catalog,
      defaults: homeDefaults,
      persistence: readOnlyPersistence({
        modules: { [id]: { enabled: true, ...(options.settings !== undefined ? { settings: options.settings } : {}) } },
        secrets: options.secrets !== undefined ? { [id]: options.secrets } : {}
      }),
      env: {},
      demand,
      household: { store, events: recording.bus },
      scheduler: observedScheduler(engine, schedulerUses),
      notify,
      coreServices: people.coreServices,
      issues,
      localPrincipal: false,
      gatewayHooks: { riskPolicy: defaultRiskPolicy },
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
    }).pipe(Scope.provide(lifetime))
    hostRef = host
    yield* checked("after the start", driven(`the start of ${id}${(options.others ?? []).length > 0 ? " and the modules beside it" : ""}`, host.startEnabled))

    const settle = Effect.andThen(Effect.andThen(engine.settled, notify.settled), Effect.repeat(Effect.yieldNow, { times: 20 }))

    /** The turn serve mode would make on a device of the household (default its first device). */
    const turn = (t: TestTurnInput = {}): TurnContext => {
      const deviceId = t.device ?? deviceList[0]?.id
      const device = deviceId === undefined ? undefined : people.devices.get(deviceId)
      const person = t.person === undefined ? device?.place.defaultPerson ?? null : t.person
      return makeTestTurn({
        ...t,
        ...(deviceId !== undefined ? { device: deviceId } : {}),
        ...(device !== undefined ? { deviceName: device.name } : {}),
        ...(device?.room !== undefined ? { room: device.room } : {}),
        assistant: t.assistant ?? (deviceId === undefined ? assistants[0]?.id : people.assistantsOn(deviceId)[0]) ?? "jeff",
        person
      })
    }
    /** A whole `TurnContext` is used as given (the gateway checks it like serve mode); a `TestTurnInput` is built by `turn`. */
    const asTurn = (t: TurnContext | TestTurnInput | undefined) => (t !== undefined && "turnId" in t && "source" in t && "conversationId" in t ? (t as TurnContext) : turn(t as TestTurnInput | undefined))
    let calls = 0
    /** Every part the turn's assistant runs, whole: what the gateway gets a call for (it refuses a switched-off tool). */
    const registryFor = (t: TurnContext) => makeToolRegistry((host.snapshot().assistantParts.get(t.assistantId ?? "") ?? []).map((p) => p.module), { gateway: host.gateway })
    /**
     * The registry serve mode makes for the model (`modulesFor` in serve mode): the assistant's parts of the modules it
     * has on, each without the tools it switched off (`withoutOffTools`, the function serve mode uses), the risk
     * policy applied by the gateway's `offers`.
     */
    const offeredFor = (t: TurnContext) => {
      const assistant = assistants.find((a) => a.id === t.assistantId)
      const parts = (host.snapshot().assistantParts.get(t.assistantId ?? "") ?? []).flatMap((p) => {
        const choice = assistant === undefined ? undefined : choiceOf(assistant, p.moduleId)
        return choice === undefined ? [] : [withoutOffTools(p.module, choice.offTools ?? [])]
      })
      return makeToolRegistry(parts, { gateway: host.gateway })
    }

    const harness = {
      host,
      moduleId: id,
      /** The household store (`forModule(id)` is what the module's `ctx.store` reads), the bus's recorded events. */
      store,
      moduleStore: (): ModuleStore => store.forModule(id),
      events: recording.events as ReadonlyArray<HouseholdEvent>,
      scheduler: engine,
      people,
      /** What the kit saw of every module's scheduler use (`checkModule` reads the module's own). */
      schedulerUses: schedulerUses as ReadonlyArray<SchedulerUse>,
      /** The `CurrentTurn` serve mode would make for a turn on a device of the household. */
      turn,
      /** The module's line on the admin page now. */
      info: (): ModuleInfo | undefined => host.modules().find((m) => m.id === id),
      issues: (): ReadonlyArray<HealthIssue> => host.issues.all().filter((i) => i.module === id),
      /** Run every module's `health()` now (as "Check again" does) and answer the module's issues; one that never answers times out. */
      checkHealth: checked("after the health check", Effect.map(driven(`the health checks (${id})`, host.checkHealth), () => host.issues.all().filter((i) => i.module === id))),
      /**
       * The tools the turn's model is sent (names): what serve mode offers, the modules the assistant has on without
       * the tools it switched off, and without those the risk policy refuses.
       */
      toolNames: (as?: TurnContext | TestTurnInput) => offeredFor(asTurn(as)).specs.map((s) => s.name),
      /**
       * Call a tool as the model's tool loop does, through the assistant's registry and the real gateway, as the turn
       * (`TurnContext`, or a `TestTurnInput` resolved against the household; default the first device's). A tool the
       * assistant switched off is called too, and the gateway refuses it, as it does on every path.
       */
      tool: (name: string, input: unknown, as?: TurnContext | TestTurnInput) =>
        checked(
          `after the tool ${name}`,
          Effect.gen(function*() {
            const t = asTurn(as)
            const result = yield* registryFor(t).run({ id: `kit-${++calls}`, name, input }).pipe(Effect.provideService(CurrentTurn, t))
            let value: unknown = result.content
            try {
              value = JSON.parse(result.content)
            } catch {
              // Plain text.
            }
            return { ok: !result.isError, content: result.content, value } satisfies TestToolResult
          })
        ),
      /** Run one of the module's actions with its values in tool input form, as `host.actions.run` does (routines). */
      action: (actionId: string, params: Readonly<Record<string, unknown>> = {}, as?: TurnContext | TestTurnInput): Effect.Effect<ActionRunResult> =>
        checked(`after the action ${actionId}`, host.actions.run({ moduleId: id, actionId, params }).pipe(Effect.provideService(CurrentTurn, asTurn(as)))),
      /** Run `effect` as a turn: what a tool's code would see (`CurrentTurn`), for calling services directly. */
      asTurn: <A, E, R>(effect: Effect.Effect<A, E, R>, as?: TurnContext | TestTurnInput) => checked("after asTurn", Effect.provideService(effect, CurrentTurn, asTurn(as))),
      /** A service published now (the module's own, a stand-in's, or the core's). */
      service: <T>(key: ServiceKey<T>): T | undefined => host.service(key),
      /** The contributions under `key` that a turn's assistant sees (default the first device's turn). */
      contributions: <T>(key: ContributionKey<T>, as?: TurnContext | TestTurnInput) => checked("after reading contributions", host.contributions(key).pipe(Effect.provideService(CurrentTurn, asTurn(as)))),
      /**
       * The module's live and finished jobs: the scheduler's whole job list, every module's, read to its end and
       * filtered to this module, so other modules' jobs never hide one of its own. Past `MAX_JOB_LIST_PAGES` pages it
       * fails instead of answering part of the list.
       */
      jobs: Effect.gen(function*() {
        const out: Array<JobRow> = []
        let cursor: string | undefined
        for (let page = 0;; page++) {
          if (page === MAX_JOB_LIST_PAGES) return yield* Effect.die(new Error(`The test kit read ${MAX_JOB_LIST_PAGES} pages of jobs and the list goes on: it does not answer part of it`))
          const got = yield* engine.listAll(cursor === undefined ? {} : { cursor }).pipe(Effect.orDie)
          out.push(...got.jobs.filter((j) => j.job.module === id).map((j) => j.job))
          if (got.next === undefined) return out as ReadonlyArray<JobRow>
          cursor = got.next
        }
      }),
      /** Now, on the test clock (epoch ms). */
      now: Clock.currentTimeMillis,
      /** Move the test clock by `ms` and let the scheduler run what came due (handlers run through the gateway). */
      advance: (ms: number) => checked(`after advancing the clock ${ms} ms`, Effect.andThen(Effect.andThen(settle, TestClock.adjust(ms)), settle)),
      /** Move the clock to a job's due time and let it run (and anything else due by then, as the engine does). */
      runJob: (jobId: string) =>
        Effect.gen(function*() {
          const job = (yield* harness.jobs).find((j) => j.id === jobId)
          if (job === undefined) return yield* Effect.die(new Error(`No job ${jobId} of ${id}`))
          const now = yield* Clock.currentTimeMillis
          yield* harness.advance(Math.max(0, job.dueAt - now))
        }),
      /** Switch the module off for every assistant (its parts close) and wait until it has stopped. */
      stop: checked(
        "after the stop",
        Effect.suspend(() => {
          running = false
          return driven(`the stop of ${id}`, host.refresh)
        })
      ),
      /** Switch it on again and wait until it runs (or failed). */
      start: checked(
        "after the start",
        Effect.suspend(() => {
          running = true
          return driven(`the start of ${id}`, host.refresh)
        })
      ),
      /**
       * One real restart of the module, its demand kept: the host's own restart (`requestRestart`, through the module's
       * newest live part), which withdraws it, closes its parts and starts a new shared part and new instances once. Its
       * jobs, rows and settings stay. The same engine and host go on (this is not a restart of the server).
       */
      restart: checked(
        "after the restart",
        Effect.gen(function*() {
          const live = partHosts.at(-1)
          if (live === undefined || harness.info()?.state !== "running") return yield* Effect.die(new Error(`${id} is not running, so it cannot be restarted (start it first)`))
          const before = partHosts.length
          yield* driven(
            `the restart of ${id}`,
            Effect.gen(function*() {
              yield* live.requestRestart("restarted by the test")
              yield* host.refresh
              // A restart within the host's interval of the last one is held for it: let the interval pass.
              if (partHosts.length === before) {
                yield* Effect.sleep(RESTART_INTERVAL_MS + 1)
                yield* host.refresh
              }
            })
          )
        })
      ),
      /** Change its saved settings and secrets as the owner would on its page (a module that runs is started again with them). */
      configure: (values: SettingsPatch["values"], secrets: SettingsPatch["secrets"] = {}) =>
        checked("after the settings change", driven(`the settings change of ${id}`, host.configure(id, { values, secrets }))),
      /**
       * P9: the notification service as the module's tests see it: the real service on the kit's store, clock and
       * gateway, with the pages and the devices' voices recorded (docs/NOTIFICATIONS.md "Testing").
       */
      notify: {
        /** The service itself (`ringingOn`, `stopRinging`, `stopSpeech`: what P7 calls). */
        engine: notify,
        /** Every notification of the module, live and resolved (until retention removes it), oldest first. */
        all: Effect.gen(function*() {
          const out: Array<Notification> = []
          let after: Row<StoredNotification> | undefined
          for (;;) {
            const page = yield* store.forCore(NOTIFY_OWNER).collection(notificationRows).list({ orderBy: { field: "createdAt" }, limit: 12, ...(after !== undefined ? { after } : {}) }).pipe(Effect.orDie)
            for (const row of page) if (row.value.module === id) out.push(notificationView(row))
            if (page.length < 12) return out as ReadonlyArray<Notification>
            after = page[page.length - 1]
          }
        }),
        /** What the voice pages were sent, in order (`notification.ring`, `notification.resolved`), per device. */
        messages: pageMessages as ReadonlyArray<{ readonly deviceId: string; readonly message: NotifyMessage }>,
        /** Every delivery decision, in order: to which devices something went, and why not. */
        decisions: decisions as ReadonlyArray<DecisionRecord>,
        /** What was announced where, with when it started and how it ended. */
        announced: announced as ReadonlyArray<KitAnnouncement>,
        /** Press an action of a notification on a device (default the first), as a page's button does; the clock is driven. */
        press: (notificationId: string, actionId: string, as: { readonly device?: string } = {}): Effect.Effect<PressAnswer> =>
          checked(
            `after pressing ${actionId}`,
            Effect.andThen(
              notify.press({ notificationId, actionId, deviceId: as.device ?? deviceList[0]?.id ?? "kitchen-display", connection: testConnectionOf(as.device ?? deviceList[0]?.id ?? "kitchen-display") }),
              (a) => Effect.as(settle, a)
            )
          ),
        /** A reply is being spoken on the device (`true`) or has ended: announcements there wait for it. */
        replying: (deviceId: string, on: boolean) =>
          Effect.suspend(() => {
            const d = replying.get(deviceId)
            if (on && d === undefined) replying.set(deviceId, Deferred.makeUnsafe<void>())
            if (!on && d !== undefined) {
              replying.delete(deviceId)
              Deferred.doneUnsafe(d, Effect.void)
            }
            return settle
          }),
        /** A page of the device says hello (it gets what is open for it) or its last one goes. */
        connect: (deviceId: string) =>
          Effect.suspend(() => {
            connectedNow.add(deviceId)
            notify.connected(deviceId)
            return settle
          }),
        disconnect: (deviceId: string) =>
          Effect.sync(() => {
            connectedNow.delete(deviceId)
            notify.disconnected(deviceId)
          }),
        /** Do not disturb now. */
        dnd: (): DndState => notify.dnd(),
        /** Let deliveries and the scheduler finish what is due now. */
        settle: settle
      },
      /**
       * Fail the test when the value of a secret given to the kit (`options.secrets`, four characters or more) is in
       * any string of `values` (what the test passes: tool results, action outcomes, spoken lines, rows it read), each
       * decoded: an object's keys and values, and a string that is JSON parsed and walked as well, so an escaped secret
       * is found. It also looks at every event on the bus and the module's admin line and Health issues. It reads no
       * collection of its own: a test passes the rows its module wrote.
       */
      expectNoSecrets: (...values: ReadonlyArray<unknown>) =>
        Effect.suspend(() => {
          const needles = Object.values(options.secrets ?? {}).filter((v) => v.length >= 4)
          if (needles.length === 0) return Effect.void
          const places: ReadonlyArray<readonly [string, unknown]> = [
            ...values.map((v, i) => [`value ${i + 1}`, v] as const),
            ["the events", recording.events],
            ["the admin page", { info: harness.info(), issues: harness.issues() }]
          ]
          const leaks = places.filter(([, v]) => stringsOf(v).some((t) => needles.some((n) => t.includes(n)))).map(([where]) => where)
          return leaks.length === 0 ? Effect.void : Effect.die(new Error(`A secret's value appears in ${leaks.join(", ")}`))
        })
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
    const cli = yield* makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, localPrincipal: true, gatewayHooks: { riskPolicy: defaultRiskPolicy } })
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
      gatewayHooks: { riskPolicy: defaultRiskPolicy },
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
