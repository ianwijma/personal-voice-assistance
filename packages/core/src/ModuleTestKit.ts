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
  changeReplyVolume,
  NO_REPLY_VOLUMES,
  type ReplyVolumes,
  replyVolumeOf,
  ringingWithoutWake,
  STOP_ACTION,
  type DeviceCapabilities,
  type DevicePrivacy,
  devicePresentFrom,
  type HealthIssue,
  homeValuesOf,
  linkedModuleDefaults,
  type ModuleInfo,
  PRESENT_KIND_VERSIONS,
  type PresentationWire,
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
import { makeToolRegistry, offeredActions, withoutOffTools } from "./ToolRegistry.ts"
import { type ConnectionRef, CurrentTurn, makeConnectionRef, type Principal, type TurnContext, type TurnSource } from "./TurnContext.ts"
import { connectStoreToBus, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import { makeIssueRegistry } from "./Issues.ts"
import { makeMemoryHouseholdStore } from "./MemoryHouseholdStore.ts"
import { makeSchedulerEngine } from "./SchedulerEngine.ts"
import { schedulerStorage } from "./SchedulerJobs.ts"
import { type DndState, type Notification, notifications as notificationRows, NOTIFY_OWNER, notifyStorage, type PressAnswer, type StoredNotification } from "./Notify.ts"
import { presentStorage, type PresentPressAnswer } from "./Present.ts"
import { makePresentEngine, type MediaPort, type PresentDecisionRecord, type PresentMessage } from "./PresentEngine.ts"
import { type DecisionRecord, makeNotifyEngine, notificationView, type NotifyMessage, type SpeechPort } from "./NotifyEngine.ts"
import { deviceOutputsFrom } from "./Notify.ts"
import { notifyLanguageOf } from "./NotifyTexts.ts"
import { decideUtterance, type Taken } from "./PhraseDecision.ts"
import { type CommandSlot, type KeptReply, keptReplyText, makeCommandSlot, type PhraseOutcome, type PhrasePorts, type PhraseTrace, runTaken } from "./PhraseRunner.ts"
import { type CommandSet, hostCommandSet, phraseLanguageOf } from "./Phrases.ts"
import { makePhraseSets } from "./PhraseSets.ts"
import { Playback } from "./Playback.ts"
import { DeviceControl, SessionControl } from "./SessionControl.ts"
import { type EchoGate, makeEchoGate } from "./EchoGate.ts"
import type { RouteTarget } from "./RouteGate.ts"
import type { RegisteredAction } from "./Actions.ts"

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
  /** P7: "while ringing" (`place.ringingWithoutWake`): `false` switches the ringing window off. Default on. */
  readonly ringingWithoutWake?: boolean
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
export const makeTestPeople = (input: TestHouseholdInput = {}, live?: { readonly connected: (deviceId: string) => boolean }) => {
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
      place: { ...BUILT_IN_PLACE, room, privacy: d.privacy ?? "shared", defaultPerson, ...(d.ringingWithoutWake !== undefined ? { ringingWithoutWake: d.ringingWithoutWake } : {}) },
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
  // A device's connection is live state, not household data: with `live`, the Devices service reads it there (the kit's
  // notification service reads the same), so a test that disconnects a device sees it disconnected everywhere.
  const devicesService = makeDevices(() =>
    live === undefined ? [...devices.values()] : [...devices.values()].map((d) => {
      const on = live.connected(d.id)
      return on === d.connected ? d : { ...d, connected: on, visible: on }
    })
  )
  const connections = new Map([...devices.keys()].map((id) => [testConnectionOf(id).id, id] as const))
  return {
    people: peopleService,
    privacy,
    devices: devicesService,
    /** The core services as the host gets them (`ModuleHostOptions.coreServices`). */
    coreServices: [People.of(peopleService), Privacy.of(privacy), Devices.of(devicesService)] as ReadonlyArray<ProvidedService>,
    assistantsOn: (deviceId: string) => assistantsOf.get(deviceId) ?? [],
    isMember: (id: string) => people.has(id),
    /**
     * The device a connection of the kit's belongs to (`testConnectionOf`), or `undefined`; with `live`, `undefined` too
     * while that device is disconnected (serve mode's lookup of a closed connection).
     */
    deviceOfConnection: (connection: ConnectionRef) => {
      const id = connections.get(connection.id)
      return id !== undefined && (live === undefined || live.connected(id)) ? id : undefined
    }
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
  readonly outcome?: "spoken" | "stopped" | "failed"
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
 *
 * `owned` (a phrase run, review round 2, a5): the work is the caller's, as `runTaken` is its caller's in serve mode, so
 * interrupting the caller interrupts it too; its clean-up is given the moments `letRun` gives (it is not waited for
 * beyond them). Without it (lifecycle requests) the work goes on as a request already made does.
 */
const driven = <A, E>(what: string, effect: Effect.Effect<A, E>, options: { readonly owned?: boolean } = {}): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    // Detached: a wait that is given up must not hold the test's own fiber when it ends.
    const fiber = yield* Effect.forkDetach(effect)
    if (options.owned === true) {
      return yield* follow(what, fiber).pipe(Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => fiber.interruptUnsafe()), letRun(fiber))))
    }
    return yield* follow(what, fiber)
  })

/** `driven`'s wait: the clock moved to the next timer until `fiber` is done, within `KIT_WAIT_CAP_MS`. */
const follow = <A, E>(what: string, fiber: Fiber.Fiber<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
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
  /**
   * P10: the image cache the Presenter fetches images through (a fake: tests never reach the network). Default: none,
   * so an image presentation is shown without its image (`unavailable`), as serve mode shows one it could not fetch.
   */
  readonly media?: MediaPort
}

/**
 * P10: what a kit device's page declares when the test gives it no `capabilities`: this build's voice page on a tablet
 * (a display with touch, every presentation kind, a speaker, a microphone), so the Presenter decides for it as serve
 * mode decides for this build's page. A test that gives `capabilities` models any other device.
 */
export const KIT_PAGE_CAPABILITIES: DeviceCapabilities = {
  v: 1,
  display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 1, touch: "coarse", colour: true },
  present: { kinds: { ...PRESENT_KIND_VERSIONS } },
  speaker: { media: ["speech", "audio"] },
  microphone: { farField: false }
}

export const DEFAULT_TEST_START = Date.UTC(2026, 10, 18, 9, 0, 0)

/** How a test says a phrase on a device (`kit.phrases.say`). */
export interface KitPhraseInput {
  /** The device (default: the household's first). */
  readonly device?: string
  /** The assistant whose wake phrase starts it (default: the device's first). */
  readonly assistant?: string
  /**
   * After the wake phrase (default `true`; a follow-up window behaves the same), or without it (`false`: the device
   * answers nobody without a phrase in the kit, so only the ringing window can take it).
   */
  readonly wake?: boolean
  /** The text of a reply this utterance cut short (it was playing when the utterance began): said again after "louder". */
  readonly interrupting?: string
  /** Whose reply `interrupting` is (default: the addressed assistant). */
  readonly interruptedBy?: string
  /** The utterance was cancelled before its final (the page's Stop, a new conversation): nothing takes it. */
  readonly cancelled?: boolean
}

/** What one phrase came to: not taken (it would go on to the assistant as a turn), or what took it and what happened. */
export type KitPhraseResult =
  | { readonly taken: false }
  | { readonly taken: true; readonly by: "ringing" | "control" | "command"; readonly outcome: PhraseOutcome }

/** One line the kit's device said for a phrase (a canned reply in serve mode). */
export interface KitSpoken {
  readonly deviceId: string
  readonly assistant: string | undefined
  readonly text: string
}

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
    // P9: which devices have a page connected now (live state: the kit's Devices and notification service read this one).
    const deviceInputs = input.devices ?? DEFAULT_TEST_HOUSEHOLD.devices
    const connectedNow = new Set(deviceInputs.filter((d) => d.connected !== false).map((d) => d.id))
    const people = makeTestPeople(input, { connected: (id) => connectedNow.has(id) })
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
    yield* store.prepare(catalog.map((m) => ({ id: m.id, storage: m.storage })), [schedulerStorage, notifyStorage, presentStorage]).pipe(Effect.orDie)
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
    const declaredOf = new Map(deviceList.map((d) => [d.id, d.capabilities] as const))
    const pageMessages: Array<{ readonly deviceId: string; readonly message: NotifyMessage }> = []
    const decisions: Array<DecisionRecord> = []
    const announced: Array<KitAnnouncement> = []
    /** A reply is being spoken on the device: announcements wait for it, and one that is playing is cut (as serve mode's lease does). */
    const replying = new Map<string, Deferred.Deferred<void>>()
    /** The announcement being played on a device: its cut, by a reply or by the device's page going. */
    const playing = new Map<string, Deferred.Deferred<"reply" | "disconnected">>()
    /**
     * P7: whether the device is audible, by serve mode's own rule (`EchoGate.audible`: playing, or within `ECHO_TAIL_MS`
     * of the end of what played): every reply, announcement and canned line the kit plays starts and ends on it.
     */
    const audibleGates = new Map<string, EchoGate>()
    const audibleGate = (deviceId: string) => {
      let gate = audibleGates.get(deviceId)
      if (gate === undefined) {
        gate = makeEchoGate()
        audibleGates.set(deviceId, gate)
      }
      return gate
    }
    /** A reply starts (`true`) or ends on the device: announcements wait for it, one playing is cut (as serve mode's lease). */
    const setReplying = (deviceId: string, on: boolean) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.sync(() => {
        const d = replying.get(deviceId)
        if (on && d === undefined) replying.set(deviceId, Deferred.makeUnsafe<void>())
        if (on) audibleGate(deviceId).playbackStarted(at)
        if (on) {
          const cut = playing.get(deviceId)
          if (cut !== undefined) Deferred.doneUnsafe(cut, Effect.succeed("reply" as const))
        }
        if (!on && d !== undefined) {
          replying.delete(deviceId)
          audibleGate(deviceId).playbackEnded(at)
          Deferred.doneUnsafe(d, Effect.void)
        }
      }))
    const speechMs = options.speechMs ?? 2_000
    /** Each connected device's voice session, as serve mode's: done when its page goes (`disconnect`). */
    const sessions = new Map<string, Deferred.Deferred<void>>()
    const sessionOf = (deviceId: string) => {
      let d = sessions.get(deviceId)
      if (d === undefined) {
        d = Deferred.makeUnsafe<void>()
        sessions.set(deviceId, d)
      }
      return d
    }
    const speech: SpeechPort = {
      // The call has its session's lifetime for its whole wait (behind a reply, for quiet): when the page goes, a
      // waiting announcement fails as serve mode's does ("the voice session ended"); one already playing fails with
      // the audio client's disconnect (below).
      speak: (deviceId, text, o) => {
        const session = sessionOf(deviceId)
        let playingNow = false
        const ended = Effect.andThen(Deferred.await(session), Effect.suspend(() => (playingNow ? Effect.never : Effect.fail(new Error("the voice session ended")))))
        return Deferred.isDoneUnsafe(session) ? Effect.fail(new Error("the voice session ended")) : Effect.raceFirst(Effect.gen(function*() {
          for (;;) {
            const reply = replying.get(deviceId)
            if (reply !== undefined) {
              yield* Deferred.await(reply)
              continue
            }
            const gate = o.gate()
            if (gate === "wait") {
              yield* Effect.yieldNow
              continue
            }
            if (gate !== "go") return { skipped: gate } as const
            const record: { -readonly [K in keyof KitAnnouncement]: KitAnnouncement[K] } = { deviceId, text, cue: o.cue, startedAt: yield* Clock.currentTimeMillis }
            announced.push(record)
            const cut = Deferred.makeUnsafe<"reply" | "disconnected">()
            playing.set(deviceId, cut)
            playingNow = true
            audibleGate(deviceId).playbackStarted(record.startedAt)
            const how = yield* Effect.raceFirst(Effect.as(Effect.sleep(speechMs), "played" as const), Deferred.await(cut)).pipe(
              Effect.onInterrupt(() => Effect.sync(() => void (record.outcome = "stopped"))),
              Effect.ensuring(Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.sync(() => {
                if (playing.get(deviceId) === cut) playing.delete(deviceId)
                // P7: the device is audible until its echo tail is over (the ringing window stays closed meanwhile).
                audibleGate(deviceId).playbackEnded(at)
              })))
            )
            if (how === "reply") {
              record.outcome = "stopped"
              return yield* Effect.fail(new Error("superseded"))
            }
            if (how === "disconnected") {
              // Serve mode's audio fails the same way when the page that played it goes.
              record.outcome = "failed"
              return yield* Effect.fail(new Error("audio client disconnected"))
            }
            record.outcome = "spoken"
            return "spoken" as const
          }
        }), ended)
      }
    }
    const notify = yield* makeNotifyEngine({
      store,
      scheduler: engine,
      devices: () => people.devices.list(),
      // A kit device's outputs as serve mode computes them, from what it was given as its declaration (none: a page that
      // never declared, which speaks and shows); the kit has no owner overrides.
      outputs: (d) => deviceOutputsFrom({ capabilities: { noDisplay: false, noSpeaker: false, excludeKinds: [] } }, declaredOf.get(d.id)),
      privacy: people.privacy,
      // One page per connected device, as a tab of it.
      outlet: () => ({
        connections: (deviceId) => (connectedNow.has(deviceId) ? [{ id: testConnectionOf(deviceId).id, send: (message) => void pageMessages.push({ deviceId, message }) }] : [])
      }),
      speech: () => speech,
      gateway: () => hostRef?.gateway,
      pageText: (moduleId, text, max) => hostRef?.pageText(moduleId, text, max) ?? String(text).slice(0, max),
      language: () => notifyLanguageOf(home.HOME_LANGUAGE),
      issues,
      onDecision: (record) => void decisions.push(record)
    }).pipe(Scope.provide(lifetime))

    // P10: the real Presenter on the same store, clock and gateway; one page per connected device records what it is sent.
    const presentMessages: Array<{ readonly deviceId: string; readonly message: PresentMessage }> = []
    const presentDecisions: Array<PresentDecisionRecord> = []
    /** What each device's page holds now, replayed from what it was sent. */
    const presentPages = new Map<string, Map<string, PresentationWire>>()
    const recordPresent = (deviceId: string, message: PresentMessage) => {
      presentMessages.push({ deviceId, message })
      let page = presentPages.get(deviceId)
      if (page === undefined) {
        page = new Map()
        presentPages.set(deviceId, page)
      }
      if (message.type === "present.dismiss") page.delete(message.id)
      else page.set(message.presentation.id, message.presentation)
    }
    const present = yield* makePresentEngine({
      store,
      scheduler: engine,
      devices: () => people.devices.list(),
      outputs: (d) => devicePresentFrom({ capabilities: { noDisplay: false, noSpeaker: false, excludeKinds: [] } }, declaredOf.get(d.id) ?? KIT_PAGE_CAPABILITIES),
      privacy: people.privacy,
      outlet: () => ({
        connections: (deviceId) => (connectedNow.has(deviceId) ? [{ id: testConnectionOf(deviceId).id, send: (message) => recordPresent(deviceId, message) }] : [])
      }),
      ...(options.media !== undefined ? { media: () => options.media } : {}),
      gateway: () => hostRef?.gateway,
      pageText: (moduleId, text, max) => hostRef?.pageText(moduleId, text, max) ?? String(text).slice(0, max),
      language: () => notifyLanguageOf(home.HOME_LANGUAGE),
      issues,
      onDecision: (record) => void presentDecisions.push(record)
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
        : principal._tag === "presentation"
        ? { assistantId: undefined, deviceId: principal.presentation.deviceId, connection: principal.presentation.connection, person: principal.presentation.person }
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
    // ---- P7: the kit's session and reply volume: what the phrase controls act on, and what modules get as the core's
    // `SessionControl` and `DeviceControl` (serve mode's are the voice sessions' and `makeReplyVolumes`).
    const language = () => phraseLanguageOf(home.HOME_LANGUAGE)
    const outcomes: Array<{ readonly deviceId: string; readonly text: string; readonly outcome: PhraseOutcome }> = []
    const spoken: Array<KitSpoken> = []
    const sessionCalls: Array<{ readonly deviceId: string; readonly call: "stop" | "cancel" }> = []
    const phraseTraces: Array<PhraseTrace & { readonly deviceId: string }> = []
    const lastReplies = new Map<string, KeptReply>()
    let volumes: ReplyVolumes = NO_REPLY_VOLUMES
    const volumeSends: Array<{ readonly deviceId: string; readonly volume: number }> = []
    const slots = new Map<string, CommandSlot>()
    const slotOf = (deviceId: string) => {
      let slot = slots.get(deviceId)
      if (slot === undefined) {
        slot = makeCommandSlot()
        slots.set(deviceId, slot)
      }
      return slot
    }
    let conversations = 0
    const firstAssistant = (deviceId: string) => people.assistantsOn(deviceId)[0]
    /** A reply as the kit keeps it: serve mode's rule (`keptReplyText`) over its sentences as clauses. */
    const kept = (assistant: string, text: string): KeptReply => ({ assistant, text: keptReplyText(text.split(/(?<=[.!?])\s+/)) })
    /**
     * A canned line the kit speaks (a command's answer, the interrupted reply said again, a repeat): it plays and finishes
     * at once, and leaves the device audible for serve mode's echo tail (review round 2, a6), as a real reply's end does.
     */
    const kitSay = (deviceId: string, assistant: string | undefined, text: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.sync(() => {
          spoken.push({ deviceId, assistant, text })
          lastReplies.set(deviceId, kept(assistant ?? firstAssistant(deviceId) ?? "jeff", text))
          const gate = audibleGate(deviceId)
          gate.playbackStarted(at)
          // Still audible when a reply of the device plays on (an announcement or `replying`): it ends with that.
          if (!replying.has(deviceId) && !playing.has(deviceId)) gate.playbackEnded(at)
          return "done" as const
        }))
    const kitVolume = (deviceId: string, change: "louder" | "quieter" | { readonly to: number }) =>
      Effect.sync(() => {
        const t = changeReplyVolume(volumes, deviceId, change)
        volumes = t.volumes
        volumeSends.push(...t.sends)
        return t.change
      })
    /** Cancellations per device (stop, cancel, a new conversation): a pending settlement compares them with its start's (b1). */
    const cancellations = new Map<string, number>()
    const cancelledOn = (deviceId: string) => void cancellations.set(deviceId, (cancellations.get(deviceId) ?? 0) + 1)
    const kitStopReply = (deviceId: string) =>
      Effect.suspend(() => {
        cancelledOn(deviceId)
        sessionCalls.push({ deviceId, call: "stop" })
        const was = replying.has(deviceId)
        return Effect.as(setReplying(deviceId, false), was)
      })
    const kitCancel = (deviceId: string) =>
      Effect.suspend(() => {
        cancelledOn(deviceId)
        sessionCalls.push({ deviceId, call: "cancel" })
        const was = replying.has(deviceId)
        return Effect.as(setReplying(deviceId, false), was)
      })
    const kitServices: ReadonlyArray<ProvidedService> = [
      SessionControl.of({
        stopReply: (deviceId) => Effect.zipWith(kitStopReply(deviceId), notify.stopSpeech(deviceId), (a, b) => a || b),
        cancelPending: kitCancel,
        repeatLast: (deviceId) =>
          Effect.suspend(() => {
            const last = lastReplies.get(deviceId)
            return last === undefined ? Effect.succeed(false) : Effect.as(kitSay(deviceId, last.assistant, last.text), true)
          }),
        newConversation: (deviceId) =>
          Effect.sync(() => {
            if (!deviceIds.has(deviceId)) return undefined
            cancelledOn(deviceId)
            return `kit-conversation-${++conversations}`
          })
      }),
      DeviceControl.of({ replyVolume: (deviceId) => replyVolumeOf(volumes, deviceId), changeReplyVolume: kitVolume })
    ]
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
      present,
      coreServices: [...people.coreServices, ...kitServices],
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

    const settle = Effect.andThen(Effect.andThen(Effect.andThen(engine.settled, notify.settled), present.settled), Effect.repeat(Effect.yieldNow, { times: 20 }))

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
    const offeredParts = (assistantId: string | undefined) => {
      const assistant = assistants.find((a) => a.id === assistantId)
      return (host.snapshot().assistantParts.get(assistantId ?? "") ?? []).flatMap((p) => {
        const choice = assistant === undefined ? undefined : choiceOf(assistant, p.moduleId)
        return choice === undefined ? [] : [withoutOffTools(p.module, choice.offTools ?? [])]
      })
    }
    const offeredFor = (t: TurnContext) => makeToolRegistry(offeredParts(t.assistantId), { gateway: host.gateway })

    // ---- P7: phrase commands, on the real decision, matcher, sets, runner and gateway (the helpers serve mode uses)
    let phraseTurns = 1000
    const actionsOf = (assistant: string) => offeredActions(offeredParts(assistant), host.gateway)
    const phraseSets = yield* makePhraseSets({
      language,
      assistants: () => assistants.map((a) => ({ id: a.id, name: a.id })),
      inputKey: (assistant) => `${host.snapshot().version}|${language()}|${running}`,
      actionsOf
    }, { yieldStep: Effect.yieldNow }).pipe(Scope.provide(lifetime))
    const isPublished = (assistant: string, action: RegisteredAction) => actionsOf(assistant).includes(action)
    /** The decision for one final, with the route the kit stands in for: the wake phrase's assistant, or nobody; once the sets are ready. */
    const decidePhrase = (text: string, as: KitPhraseInput): Effect.Effect<{ readonly deviceId: string; readonly taken: Taken | undefined }> =>
      Effect.gen(function*() {
        yield* phraseSets.settled
        const at = yield* Clock.currentTimeMillis
        const deviceId = as.device ?? deviceList[0]?.id ?? "kitchen-display"
        const assistant = as.assistant ?? firstAssistant(deviceId) ?? "jeff"
        const wake = as.wake !== false
        const route: RouteTarget = wake ? { assistant, by: "phrase", phrase: "hey jeff" } : { by: "dropped", reason: "asleep" }
        // Closed while a reply, an announcement or a canned line is audible there, or in its echo tail (its own line may
        // be what was heard), when the utterance interrupted a reply (`interrupting`: one was playing as it began), and by
        // the device's setting.
        const audible = replying.has(deviceId) || playing.has(deviceId) || audibleGate(deviceId).audible(at) || as.interrupting !== undefined
        const open = !audible && ringingWithoutWake(people.devices.get(deviceId)?.place)
        const d = decideUtterance({
          final: { _tag: "EndOfTurn", text },
          language: language(),
          ringing: open ? notify.ringingOn(deviceId) : undefined,
          wakeAtStart: () => wake,
          gates: (final) => [{ events: [final], target: route }],
          commandsFor: (a) => phraseSets.ready(a ?? assistant) ?? hostCommandSet(language()),
          ...(as.cancelled === true ? { cancelled: true } : {})
        })
        return { deviceId, taken: d.taken }
      })
    const phrasePorts = (deviceId: string, as: KitPhraseInput): PhrasePorts => {
      const cancelledAtStart = cancellations.get(deviceId) ?? 0
      return {
      deviceId,
      language,
      notify: () => notify,
      slot: slotOf(deviceId),
      session: {
        replyActive: () => replying.has(deviceId) || as.interrupting !== undefined,
        announcementActive: () => playing.has(deviceId),
        stopReply: kitStopReply(deviceId),
        stopAnnouncement: notify.stopSpeech(deviceId),
        cancelPending: kitCancel(deviceId),
        lastReply: () => lastReplies.get(deviceId),
        interruptedReply: Effect.sync(() => (as.interrupting === undefined ? undefined : kept(as.interruptedBy ?? as.assistant ?? firstAssistant(deviceId) ?? "jeff", as.interrupting))),
        replyCancelled: () => (cancellations.get(deviceId) ?? 0) !== cancelledAtStart,
        answering: () => firstAssistant(deviceId),
        say: (assistant, text) => kitSay(deviceId, assistant, text)
      },
      volume: (direction) => kitVolume(deviceId, direction),
      playback: () => host.service(Playback),
      room: () => people.devices.get(deviceId)?.room,
      gateway: () => host.gateway,
      turn: (assistant) => turn({ device: deviceId, assistant, source: "phrase", turnId: ++phraseTurns }),
      isPublished,
      pageText: (moduleId, text, max) => host.pageText(moduleId, text, max),
      trace: (t) => void phraseTraces.push({ ...t, deviceId })
      }
    }
    const runPhrase = (taken: Taken, deviceId: string, as: KitPhraseInput, text: string) =>
      Effect.andThen(Effect.andThen(settle, driven(`the phrase "${text}"`, runTaken(taken, phrasePorts(deviceId, as)), { owned: true })), (outcome) => {
        outcomes.push({ deviceId, text, outcome })
        return Effect.as(settle, outcome)
      })

    let pendingPresses = 0
    const pressesByDevice = new Map<string, number>()
    const admitPress = <A>(deviceId: string, work: Effect.Effect<A>, busy: () => A): Effect.Effect<A> => Effect.suspend(() => {
      const count = pressesByDevice.get(deviceId) ?? 0
      if (count >= 4 || pendingPresses >= 16) return Effect.succeed(busy())
      pressesByDevice.set(deviceId, count + 1)
      pendingPresses++
      return work.pipe(Effect.ensuring(Effect.sync(() => {
        pendingPresses--
        const left = (pressesByDevice.get(deviceId) ?? 1) - 1
        if (left === 0) pressesByDevice.delete(deviceId)
        else pressesByDevice.set(deviceId, left)
      })))
    })
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
       * P7: phrase commands as serve mode runs them (docs/PHRASES.md "Testing"): the real decision (`decideUtterance`),
       * the real matcher over the assistant's set as serve mode builds it (its registry's actions: the modules it has on,
       * without what it switched off or the risk policy refuses, the host's controls first), and the real runner through
       * the gateway, the notification service and the volume step.
       */
      phrases: {
        /**
         * Say `text` on a device as its recogniser's final transcript: after the wake phrase (the default), or without
         * it (only the ringing window can take it then: open while the kit's notification service says something rings
         * there, the device's "while ringing" is on, and no reply or announcement is audible there). The sets are made
         * ready first, as a final in serve mode comes after their preparation.
         */
        say: (text: string, as: KitPhraseInput = {}): Effect.Effect<KitPhraseResult> =>
          checked(`after saying "${text}"`, Effect.flatMap(Effect.andThen(settle, decidePhrase(text, as)), (d) => {
            if (d.taken === undefined) return Effect.succeed<KitPhraseResult>({ taken: false })
            const taken = d.taken
            const by = taken.by === "ringing" ? "ringing" as const : taken.match.kind === "control" ? "control" as const : "command" as const
            return Effect.map(runPhrase(taken, d.deviceId, as, text), (outcome): KitPhraseResult => ({ taken: true, by, outcome }))
          })),
        /**
         * The decision alone, as serve mode takes it at the final (nothing runs): what would take `text`, if anything. With
         * `run`, a test can change something between the decision and the run (serve mode runs it a moment later).
         */
        decide: (text: string, as: KitPhraseInput = {}): Effect.Effect<Taken | undefined> => Effect.map(decidePhrase(text, as), (d) => d.taken),
        /** Run what took an utterance (from `decide`) on the device, as serve mode does. */
        run: (taken: Taken, as: KitPhraseInput = {}): Effect.Effect<PhraseOutcome> =>
          checked("after running a phrase", runPhrase(taken, as.device ?? deviceList[0]?.id ?? "kitchen-display", as, taken.by === "phrase" ? taken.text : taken.match.kind === "stop" ? taken.match.phrase : taken.match.label)),
        /** What every taken phrase came to, in order. */
        answered: outcomes as ReadonlyArray<{ readonly deviceId: string; readonly text: string; readonly outcome: PhraseOutcome }>,
        /** Every line the kit's devices said for phrases, in order (canned replies in serve mode). */
        spoken: spoken as ReadonlyArray<KitSpoken>,
        /** Every taken utterance's execution trace (serve mode publishes it in admin's latency list). */
        traces: phraseTraces as ReadonlyArray<PhraseTrace & { readonly deviceId: string }>,
        /** A reply was spoken on the device (what "repeat" says again), kept by serve mode's rule (2,000 characters, whole sentences). */
        replied: (deviceId: string, text: string, assistant?: string) => void lastReplies.set(deviceId, kept(assistant ?? firstAssistant(deviceId) ?? "jeff", text)),
        /** The device's reply volume now (`REPLY_VOLUME`; what serve mode would send as `output.volume`). */
        volume: (deviceId: string): number => replyVolumeOf(volumes, deviceId),
        /** Every `output.volume` serve mode would send, in order (to every voice page of the device). */
        volumeSends: volumeSends as ReadonlyArray<{ readonly deviceId: string; readonly volume: number }>,
        /** The assistant's set once ready, as serve mode prepares it (with its conflicts, which serve mode names on the Health page). */
        commandsFor: (assistant?: string): Effect.Effect<CommandSet> =>
          Effect.map(phraseSets.settled, () => phraseSets.ready(assistant ?? assistants[0]?.id ?? "jeff") ?? hostCommandSet(language())),
        /** What the session control was asked to do (stop, cancel): the kit has no conversation, so it records the calls. */
        sessionCalls: sessionCalls as ReadonlyArray<{ readonly deviceId: string; readonly call: "stop" | "cancel" }>
      },
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
            const page = yield* store.forCore(NOTIFY_OWNER).collection(notificationRows).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 12, ...(after !== undefined ? { after } : {}) }).pipe(Effect.orDie)
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
        /**
         * Press an action of a notification on a device (default the first), as that device's page's button does (its
         * connection must hold the card); the test clock is driven while the module's handler runs.
         */
        press: (notificationId: string, actionId: string, as: { readonly device?: string } = {}): Effect.Effect<PressAnswer> => {
          const deviceId = as.device ?? deviceList[0]?.id ?? "kitchen-display"
          const work = checked(
            `after pressing ${actionId}`,
            Effect.andThen(
              Effect.andThen(settle, driven(`the press of ${actionId}`, notify.press({ notificationId, actionId, deviceId, connection: testConnectionOf(deviceId) }))),
              (a) => Effect.as(settle, a)
            )
          )
          return actionId === STOP_ACTION ? work : admitPress(deviceId, work, notify.busyAnswer)
        },
        /**
         * A reply starts on the device (`true`) or has ended: announcements there wait for it, and one being spoken is
         * cut (`stopped`, why "a reply"), as serve mode's output lease does.
         */
        replying: (deviceId: string, on: boolean) => Effect.andThen(setReplying(deviceId, on), settle),
        /** A page of the device says hello (it is given what is open for it), or its page goes; `Devices` sees the same. */
        connect: (deviceId: string) =>
          Effect.suspend(() => {
            connectedNow.add(deviceId)
            // A new session: announcements from now on wait in it, not in the one that ended.
            if (sessions.get(deviceId) !== undefined && Deferred.isDoneUnsafe(sessions.get(deviceId)!)) sessions.delete(deviceId)
            notify.reconcile(deviceId)
            present.reconcile(deviceId)
            return settle
          }),
        disconnect: (deviceId: string) =>
          Effect.suspend(() => {
            connectedNow.delete(deviceId)
            // As serve mode: the connection is gone (`deviceOfConnection`, tool calls made with it), and what was being
            // spoken there fails with the audio client's disconnect.
            const cut = playing.get(deviceId)
            if (cut !== undefined) Deferred.doneUnsafe(cut, Effect.succeed("disconnected" as const))
            // The session ends: a waiting announcement fails; the reply that was being spoken there is retired, so the
            // next session does not wait for it.
            Deferred.doneUnsafe(sessionOf(deviceId), Effect.void)
            replying.delete(deviceId)
            notify.reconcile(deviceId)
            // As the real page: one that lost its connection shows nothing from the server until its next welcome.
            presentPages.delete(deviceId)
            present.reconcile(deviceId)
            return settle
          }),
        /** Do not disturb now (`known: false` until it was read: it counts as on). */
        dnd: (): DndState & { readonly known: boolean } => notify.dnd(),
        /** Let deliveries and the scheduler finish what is due now. */
        settle: settle
      },
      /**
       * P10: the Presenter as the module's tests see it: the real service on the kit's store, clock and gateway, one
       * page per connected device (docs/PRESENTING.md "Testing"). `connect` and `disconnect` are the same as `notify`'s.
       */
      present: {
        /** The service itself (`live`, `held`, `expireNow`). */
        engine: present,
        /** What a device's page holds now (default the first device), in the order it was given them. */
        shown: (deviceId?: string): ReadonlyArray<PresentationWire> => [...(presentPages.get(deviceId ?? deviceList[0]?.id ?? "kitchen-display")?.values() ?? [])],
        /** What the pages were sent, in order (`present.show`, `present.update`, `present.dismiss`), per device. */
        messages: presentMessages as ReadonlyArray<{ readonly deviceId: string; readonly message: PresentMessage }>,
        /** Every decision, in order: where something would show, and why not. */
        decisions: presentDecisions as ReadonlyArray<PresentDecisionRecord>,
        /**
         * Press on a presentation as a device's page does (default the first device; its connection must hold it): a
         * button by its id, or `tick` with `item` and `done`. The test clock is driven while the module's handler runs.
         */
        press: (presentationId: string, action: string, as: { readonly device?: string; readonly item?: string; readonly done?: boolean } = {}): Effect.Effect<PresentPressAnswer> => {
          const deviceId = as.device ?? deviceList[0]?.id ?? "kitchen-display"
          return Effect.suspend(() => {
            const revision = presentPages.get(deviceId)?.get(presentationId)?.revision ?? "missing"
            return admitPress(deviceId, checked(`after pressing ${action}`, Effect.gen(function*() {
              yield* settle
              const answer = yield* driven(`the press of ${action}`, present.press({
                presentationId,
                revision,
                action,
                ...(as.item !== undefined ? { item: as.item } : {}),
                ...(as.done !== undefined ? { done: as.done } : {}),
                deviceId,
                connection: testConnectionOf(deviceId)
              }))
              yield* settle
              return answer
            })), present.busyAnswer)
          })
        },
        settle
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
