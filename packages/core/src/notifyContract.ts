/**
 * The notification service's contract tests (docs/NOTIFICATIONS.md): one case per promise of that page, run on the
 * in-memory store (`packages/core/test/NotifyContract.test.ts`) and on SQLite in memory and on a file
 * (`packages/store-sqlite/test/notifyContract.test.ts`), on the test clock. A case's title names the promise; a case
 * written for a review finding names it (`a5`: docs/../pva-review p9-r1a finding 5).
 *
 * The world of a case is the server's: the household store, the real scheduler engine, the real notification engine
 * and a real module host (its page boundary too) with small modules whose shared parts keep their `ctx.notify`, over a
 * fixed set of devices whose places (and so the privacy rule) a case may change, each with the pages (tabs) a case
 * opens. "A restart" closes all of it and makes it again on the same store (the file is closed and opened again).
 */
import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { KnownDevice } from "./Devices.ts"
import { makeEventBus } from "./EventBus.ts"
import type { ExecutionGateway } from "./Gateway.ts"
import { type HostTx, type HouseholdStore, type ModuleStore, type Row, StoreError, type StoreTx } from "./HouseholdStore.ts"
import { makeIssueRegistry } from "./Issues.ts"
import { defineModule, ModuleStartError } from "./ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "./ModuleHost.ts"
import {
  type ActionAnswer,
  type ActionPress,
  CLAIM_RELEASE_MS,
  type DeviceOutputs,
  KEEP_RESOLVED_MS,
  DUE_HANDLER,
  HOURLY_CRON,
  HOURLY_HANDLER,
  MAINTENANCE_ROWS,
  MAX_DND_MS,
  MAX_EXPIRY_MS,
  MAX_OPEN_PER_MODULE,
  MAX_OPEN_TOTAL,
  type ModuleNotify,
  type ModuleSpeech,
  NOTIFY_ACTION_TIMEOUT_MS,
  NOTIFY_MAX_CHARS,
  NOTIFY_OWNER,
  notifications,
  notifyDnd,
  notifyStorage,
  type StoredNotification
} from "./Notify.ts"
import { type DecisionRecord, makeNotifyEngine, type NotifyMessage } from "./NotifyEngine.ts"
import { makePrivacy, type PrivacyPlace } from "./Privacy.ts"
import { SCHEDULER_OWNER } from "./Scheduler.ts"
import { makeSchedulerEngine } from "./SchedulerEngine.ts"
import { jobs, schedulerStorage } from "./SchedulerJobs.ts"
import { CurrentTurn, makeConnectionRef, type TurnContext } from "./TurnContext.ts"

/** A store for one case; `reopen` closes it and opens the same data again (in memory: the same store). */
export interface NotifyContractStore {
  readonly store: HouseholdStore
  readonly reopen: Effect.Effect<HouseholdStore, unknown>
}
export type OpenNotifyStore = () => Effect.Effect<NotifyContractStore, unknown, Scope.Scope>

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
/** The test clock's start in the wall-clock cases (a whole hour). */
const WALL_START = Date.UTC(2026, 10, 19, 9)

/** A known device of the cases. */
export const contractDevice = (id: string, name: string, room: string, privacy: PrivacyPlace["privacy"], defaultPerson: string | null): KnownDevice => ({
  id,
  name,
  kind: "web-voice",
  room,
  place: { room, privacy, alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson },
  capabilities: { v: 1 },
  declared: undefined,
  connected: true,
  visible: true,
  lastInteractionAt: undefined,
  lastSeen: 0
})
/** A shared kitchen display (Sam's), Robin's private phone, a public hall screen. */
export const CONTRACT_DEVICES: ReadonlyArray<KnownDevice> = [
  contractDevice("kitchen-display", "Kitchen display", "Kitchen", "shared", "p-sam"),
  contractDevice("robins-phone", "Robin's phone", "Bedroom", "private", "p-robin"),
  contractDevice("hall-screen", "Hall screen", "Hall", "public", null)
]
const MEMBERS = new Set(["p-sam", "p-robin", "p-alex"])

const turnOn = (deviceId: string): TurnContext => ({ turnId: 1, conversationId: "c1", source: "voice", assistantId: "jeff", deviceId })

/** A module whose shared part keeps its `ctx.notify` and `ctx.speech`, and registers the action handler `answer`. */
const notifyingModule = (
  id: string,
  held: Map<string, ModuleNotify>,
  speakers: Map<string, ModuleSpeech>,
  presses: Array<ActionPress>,
  answer: { current: (p: ActionPress) => Effect.Effect<ActionAnswer | void, unknown> }
) =>
  defineModule({
    apiVersion: 2,
    id,
    name: `Notifying ${id}`,
    description: "Test",
    shared: (ctx) =>
      Effect.gen(function*() {
        held.set(id, ctx.notify)
        speakers.set(id, ctx.speech)
        yield* ctx.notify.handle("answer", { run: (p) => Effect.suspend(() => (presses.push(p), answer.current(p))) }).pipe(Effect.mapError((e) => new ModuleStartError({ message: e.message })))
        return { value: undefined }
      }),
    start: () => Effect.succeed({})
  })

/** The store with the scheduler's and the service's collections prepared. */
const prepared = (store: HouseholdStore) => Effect.as(store.prepare([], [schedulerStorage, notifyStorage]), store)

/**
 * The fault-injecting store. While its counter is above 0 (each failure counts it down), it fails, with `StoreError`
 * `failed`: `writes`, the service's writes to `notifications` (insert, update) inside its transactions; `counts`, its
 * writes to the open counters; `reads`, the synchronous reads of `notifications` (`reader`: reconciliation, presses,
 * the maintenance sweep); `dnd`, the reads of do not disturb; `jobs`, the scheduler's job inserts (the maintenance job).
 */
export const notifyFaultyStore = (inner: HouseholdStore) => {
  /** `skipReads`: reads let through before `reads` starts failing. */
  const faults = { writes: 0, counts: 0, reads: 0, skipReads: 0, dnd: 0, jobs: 0, failed: 0 }
  /**
   * A wait before one of the service's transactions (as a busy store's retry wait is): `wait` is taken by the
   * transaction after `skip` more have gone through, which then waits for it before it begins.
   */
  const gate: { skip: number; wait: Deferred.Deferred<void> | undefined } = { skip: 0, wait: undefined }
  const fault = (k: "writes" | "counts" | "reads" | "dnd" | "jobs") => {
    if (k === "reads" && faults.reads > 0 && faults.skipReads > 0) {
      faults.skipReads--
      return
    }
    if (faults[k] <= 0) return
    faults[k]--
    faults.failed++
    throw new StoreError({ reason: "failed", message: `injected: ${k} fail` })
  }
  const failing = (tx: StoreTx): StoreTx => ({
    ...tx,
    collection: ((c: Parameters<StoreTx["collection"]>[0]) => {
      const col = tx.collection(c)
      const kind = c.name === notifications.name ? "writes" : c.name === "notify_counts" ? "counts" : undefined
      if (kind === undefined) return col
      return {
        ...col,
        insert: (v: never, o?: never) => (fault(kind), col.insert(v, o)),
        update: (id: string, f: never, o?: never) => (fault(kind), col.update(id, f, o))
      }
    }) as StoreTx["collection"]
  })
  const forCore: HouseholdStore["forCore"] = (owner) => {
    const own = inner.forCore(owner)
    if (owner !== NOTIFY_OWNER) return own
    return {
      ...own,
      collection: ((c: Parameters<ModuleStore["collection"]>[0]) => {
        const col = own.collection(c)
        if (c.name !== notifyDnd.name) return col
        return {
          ...col,
          get: (id: string, o?: never) =>
            Effect.suspend(() => {
              if (faults.dnd <= 0) return col.get(id, o)
              faults.dnd--
              faults.failed++
              return Effect.fail(new StoreError({ reason: "failed", message: "injected: dnd fail" }))
            })
        }
      }) as ModuleStore["collection"],
      transaction: (f) =>
        Effect.suspend(() => {
          const run = own.transaction((tx) => f(failing(tx)))
          if (gate.wait === undefined) return run
          if (gate.skip > 0) {
            gate.skip--
            return run
          }
          const wait = gate.wait
          gate.wait = undefined
          return Effect.andThen(Deferred.await(wait), run)
        })
    } satisfies ModuleStore
  }
  const reader: HouseholdStore["reader"] = (owner, c) => {
    const r = inner.reader(owner, c)
    if (r === undefined || owner !== NOTIFY_OWNER || c.name !== notifications.name) return r
    return { ...r, get: (id, scope) => (fault("reads"), r.get(id, scope)), list: (q) => (fault("reads"), r.list(q)) }
  }
  const wrapHost = (htx: HostTx): HostTx => ({
    ...htx,
    forCore: (owner) => {
      const t = htx.forCore(owner)
      if (owner !== SCHEDULER_OWNER) return t
      return {
        ...t,
        collection: ((c: Parameters<StoreTx["collection"]>[0]) => {
          const col = t.collection(c)
          if (c.name !== jobs.name) return col
          return { ...col, insert: (v: never, o?: never) => (fault("jobs"), col.insert(v, o)) }
        }) as StoreTx["collection"]
      }
    }
  })
  return { store: { ...inner, forCore, reader, transaction: (f) => inner.transaction((htx) => f(wrapHost(htx))) } satisfies HouseholdStore, faults, gate }
}

/** One page (tab) of a device in the world. */
interface Tab {
  readonly id: string
  readonly deviceId: string
  readonly messages: Array<NotifyMessage>
}

/** The server's parts on `store`, in a scope of their own (closing it is a server stop). */
export const notifyWorld = (
  store: HouseholdStore,
  o: {
    readonly modules?: ReadonlyArray<string>
    /** The devices with one page open at the start (default every device). */
    readonly connected?: ReadonlyArray<string>
    /** The known devices (default `CONTRACT_DEVICES`). */
    readonly devices?: ReadonlyArray<KnownDevice>
    /** A device's outputs (default: speaks and shows). */
    readonly outputs?: (d: KnownDevice) => DeviceOutputs
    /** Where pages' messages go besides the record (the latency test encodes them, as the hub does). */
    readonly outlet?: (deviceId: string, message: NotifyMessage) => void
    /** Keep no record of messages and decisions (the latency test, at the bounds). */
    readonly unrecorded?: boolean
    readonly observe?: Parameters<typeof makeNotifyEngine>[0]["observe"]
    readonly speech?: Parameters<typeof makeNotifyEngine>[0]["speech"]
    /** The wall clock's offset from the test clock (ms), shared with the case: a correction moves it alone. */
    readonly wall?: { offset: number }
  } = {}
) =>
  Effect.gen(function*() {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const held = new Map<string, ModuleNotify>()
    const speakers = new Map<string, ModuleSpeech>()
    const presses: Array<ActionPress> = []
    const answer = { current: (p: ActionPress): Effect.Effect<ActionAnswer | void, unknown> => Effect.succeed({ say: `Did ${p.actionId}.` }) }
    const decisions: Array<DecisionRecord> = []
    const devices = o.devices ?? CONTRACT_DEVICES
    const places = new Map(devices.map((d) => [d.id, { privacy: d.place.privacy, defaultPerson: d.place.defaultPerson }] as const))
    const tabs = new Map<string, Tab>()
    let tabSeq = 0
    const issues = makeIssueRegistry()
    const ids = o.modules ?? ["bell"]
    let hostRef: { readonly gateway: ExecutionGateway; readonly pageText: (m: string, t: unknown, max: number) => string } | undefined
    const wall = o.wall ?? { offset: 0 }
    const made = yield* Scope.provide(scope)(Effect.gen(function*() {
      const scheduler = yield* makeSchedulerEngine({ store, issues, retryBaseMs: SECOND, outcomeRetryMs: [100, 200], gateway: () => hostRef?.gateway })
      const notify = yield* makeNotifyEngine({
        store,
        scheduler,
        devices: () => devices,
        outputs: o.outputs ?? (() => ({ speak: true, show: true })),
        privacy: makePrivacy((id) => places.get(id), (id) => MEMBERS.has(id)),
        outlet: () => ({
          connections: (deviceId) =>
            [...tabs.values()].filter((t) => t.deviceId === deviceId).map((t) => ({
              id: t.id,
              send: (message: NotifyMessage) => {
                if (o.unrecorded !== true) t.messages.push(message)
                o.outlet?.(deviceId, message)
              }
            }))
        }),
        speech: o.speech ?? (() => undefined),
        ...(o.observe !== undefined ? { observe: o.observe } : {}),
        now: Effect.map(Clock.currentTimeMillis, (t) => t + wall.offset),
        gateway: () => hostRef?.gateway,
        // The host's own page boundary (secrets replaced, cut at whole characters).
        pageText: (m, text, max) => hostRef?.pageText(m, text, max) ?? String(text).slice(0, max),
        language: () => "en",
        issues,
        outcomeRetryMs: [100, 200],
        onDecision: (r) => void (o.unrecorded !== true && decisions.push(r))
      })
      const host = yield* makeModuleHost({
        catalog: ids.map((id) => notifyingModule(id, held, speakers, presses, answer)),
        persistence: readOnlyPersistence({ modules: Object.fromEntries(ids.map((id) => [id, { enabled: true }])), secrets: {} }),
        env: {},
        household: { store, events: makeEventBus() },
        scheduler,
        notify,
        graceMs: 0
      })
      hostRef = host
      yield* host.startEnabled
      return { scheduler, notify, host }
    }))
    const settle = Effect.gen(function*() {
      for (let i = 0; i < 3; i++) {
        yield* made.scheduler.settled
        yield* made.notify.settled
      }
    })
    const advance = (ms: number) => Effect.andThen(Effect.andThen(settle, TestClock.adjust(ms)), settle)
    const bell = (id = ids[0]!) => held.get(id)!
    /** `send` as a tool on `deviceId` calls it (a turn there), then delivery has run. */
    const sendOn = (deviceId: string, request: Parameters<ModuleNotify["send"]>[0], module = ids[0]!) =>
      Effect.tap(bell(module).send(request).pipe(Effect.provideService(CurrentTurn, turnOn(deviceId))), () => settle)
    const rows = Effect.gen(function*() {
      const out: Array<Row<StoredNotification>> = []
      let after: Row<StoredNotification> | undefined
      for (;;) {
        const page = yield* store.forCore(NOTIFY_OWNER).collection(notifications).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 12, ...(after !== undefined ? { after } : {}) })
        out.push(...page)
        if (page.length < 12) return out
        after = page[page.length - 1]
      }
    })
    /** Open a page of the device: it is given what is open for it. */
    const open = (deviceId: string) =>
      Effect.gen(function*() {
        const tab: Tab = { id: `tab-${++tabSeq}`, deviceId, messages: [] }
        tabs.set(tab.id, tab)
        made.notify.reconcile(deviceId)
        yield* settle
        return tab
      })
    const close = (tab: Tab) =>
      Effect.suspend(() => {
        tabs.delete(tab.id)
        made.notify.reconcile(tab.deviceId)
        return settle
      })
    for (const id of o.connected ?? devices.map((d) => d.id)) tabs.set(`tab-${++tabSeq}`, { id: `tab-${tabSeq}`, deviceId: id, messages: [] })
    const tabsOf = (deviceId: string) => [...tabs.values()].filter((t) => t.deviceId === deviceId)
    const firstTab = (deviceId: string) => tabsOf(deviceId)[0]
    /** What a tab holds now, after applying every message it got: id → card. */
    const holds = (tab: Tab | undefined) => {
      const m = new Map<string, Extract<NotifyMessage, { type: "notification.ring" }>["notification"]>()
      for (const msg of tab?.messages ?? []) {
        if (msg.type === "notification.ring") m.set(msg.notification.id, msg.notification)
        else m.delete(msg.id)
      }
      return m
    }
    const ringsOn = (deviceId: string) => (firstTab(deviceId)?.messages ?? []).filter((m) => m.type === "notification.ring").map((m) => (m as Extract<NotifyMessage, { type: "notification.ring" }>).notification)
    const resolvedOn = (deviceId: string) => (firstTab(deviceId)?.messages ?? []).filter((m): m is Extract<NotifyMessage, { type: "notification.resolved" }> => m.type === "notification.resolved")
    /** A press from the device's first page (its connection). */
    const pressOn = (deviceId: string, notificationId: string, actionId: string, tab = firstTab(deviceId)) =>
      Effect.tap(made.notify.press({ notificationId, actionId, deviceId, ...(tab !== undefined ? { connection: makeConnectionRef(tab.id) } : {}) }), () => settle)
    return {
      ...made,
      held,
      speakers,
      presses,
      answer,
      decisions,
      places,
      issues,
      tabs,
      settle,
      advance,
      bell,
      sendOn,
      rows,
      open,
      close,
      tabsOf,
      firstTab,
      holds,
      ringsOn,
      resolvedOn,
      pressOn,
      wall,
      stop: Scope.close(scope, Exit.void)
    }
  })

const reasonOf = (exit: Exit.Exit<unknown, unknown>): unknown => (Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { readonly reason?: unknown }).reason : "succeeded")

/** The live jobs of `core.notify`. */
const notifyJobs = (world: Effect.Success<ReturnType<typeof notifyWorld>>) =>
  Effect.map(world.scheduler.listAll({ limit: 20 }), (page) => page.jobs.map((j) => j.job).filter((j) => j.module === NOTIFY_OWNER && (j.state === "scheduled" || j.state === "running")))

export const notifyContract = (name: string, open: OpenNotifyStore) =>
  describe(`notification service contract (${name})`, () => {
    const start = (o?: Parameters<typeof notifyWorld>[1]) =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const world = yield* notifyWorld(store, o)
        yield* world.settle
        return { opened, store, world }
      })
    const startFaulty = (o?: Parameters<typeof notifyWorld>[1], before?: (faults: ReturnType<typeof notifyFaultyStore>["faults"]) => void) =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = notifyFaultyStore(yield* prepared(opened.store))
        before?.(faulty.faults)
        const world = yield* notifyWorld(faulty.store, o)
        yield* world.settle
        return { world, faults: faulty.faults, gate: faulty.gate, opened }
      })

    // ---- Sending and delivery

    it.effect("send stores it and delivers it now to its origin device only: a card with stop first, show and sound, the service's own texts", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const sent = yield* world.sendOn("kitchen-display", { title: "Bins out", text: "Paper tonight" })
        assert.strictEqual(sent.notification.state, "open")
        assert.isFalse(sent.deduped)
        assert.deepStrictEqual(world.ringsOn("kitchen-display"), [{
          id: sent.notification.id,
          title: "Bins out",
          text: "Paper tonight",
          priority: "normal",
          show: true,
          sound: false,
          actions: [{ id: "stop", label: "Stop" }],
          sentAt: sent.notification.sentAt,
          texts: { region: "Notifications", startAudio: "Start audio to hear it." }
        }])
        assert.deepStrictEqual(world.ringsOn("robins-phone"), [])
        assert.deepStrictEqual(world.ringsOn("hall-screen"), [])
      }))

    it.effect("D1: there is no sending later; at and inMs are refused as unknown fields", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        for (const later of [{ inMs: 1_000 }, { at: 5 }]) {
          assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "Later", ...later } as never))), "invalid")
        }
        assert.deepStrictEqual(yield* world.rows, [])
      }))

    it.effect("everywhere: every connected device decides on its own; a ring sounds where the device may make sound", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const sent = yield* world.sendOn("kitchen-display", { title: "Timer", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        assert.strictEqual(world.ringsOn("kitchen-display")[0]?.sound, true)
        assert.strictEqual(world.ringsOn("robins-phone")[0]?.sound, true)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [sent.notification.id])
        assert.deepStrictEqual(world.ringsOn("kitchen-display")[0]?.actions.map((a) => a.id), ["stop", "snooze"])
        // The hall has no page: nothing is sent there, and a page that opens there later gets it.
        assert.deepStrictEqual(world.ringsOn("hall-screen"), [])
        const hall = yield* world.open("hall-screen")
        assert.deepStrictEqual([...world.holds(hall).keys()], [sent.notification.id])
      }))

    it.effect("a16: a device with a speaker and no display gets the cue and no card (show false, sound true); one with neither gets nothing", () =>
      Effect.gen(function*() {
        const { world } = yield* start({
          outputs: (d) => (d.id === "kitchen-display" ? { speak: true, show: false } : d.id === "robins-phone" ? { speak: false, show: false } : { speak: true, show: true })
        })
        const sent = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring", target: "everywhere" })
        assert.deepStrictEqual(world.ringsOn("kitchen-display").map((c) => [c.show, c.sound]), [[false, true]])
        assert.deepStrictEqual(world.ringsOn("robins-phone"), [])
        assert.deepStrictEqual(world.decisions.filter((d) => d.id === sent.notification.id && d.deviceId === "robins-phone").at(-1)?.decision, { deliver: false, why: "cannot-show" })
      }))

    it.effect("personal content is held only where Privacy.mayReveal says yes for that device, asked at each reconciliation", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const sent = yield* world.sendOn("kitchen-display", { title: "Dentist", owner: "p-sam", target: "everywhere" })
        assert.strictEqual(world.ringsOn("kitchen-display").length, 1)
        assert.strictEqual(world.ringsOn("robins-phone").length, 1)
        world.places.set("hall-screen", { privacy: "private", defaultPerson: "p-sam" })
        const hall = yield* world.open("hall-screen")
        assert.isTrue(world.holds(hall).has(sent.notification.id))
      }))

    it.effect("a2: a withdrawal reaches every page of the device that holds the card, not only the one that said hello", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display"] })
        const a = world.firstTab("kitchen-display")!
        const b = yield* world.open("kitchen-display")
        const sent = yield* world.sendOn("kitchen-display", { title: "Dentist", owner: "p-sam" })
        assert.isTrue(world.holds(a).has(sent.notification.id) && world.holds(b).has(sent.notification.id))
        // The kitchen becomes Robin's; a third page says hello: every page that holds the card has it withdrawn.
        world.places.set("kitchen-display", { privacy: "shared", defaultPerson: "p-robin" })
        const c = yield* world.open("kitchen-display")
        for (const tab of [a, b, c]) assert.isFalse(world.holds(tab).has(sent.notification.id), tab.id)
        assert.deepStrictEqual(a.messages.at(-1), { type: "notification.resolved", id: sent.notification.id, outcome: "withdrawn" })
        // And resolving it later finds nothing left to take down anywhere.
        yield* world.bell().resolve(sent.notification.id)
        yield* world.settle
        for (const tab of [a, b, c]) assert.isFalse(world.holds(tab).has(sent.notification.id))
      }))

    it.effect("a4: a notification resolved while a reconciliation pass is under way rings nowhere afterwards", () =>
      Effect.gen(function*() {
        const devices = Array.from({ length: 64 }, (_, i) => contractDevice(`device-${String(i).padStart(2, "0")}-xxxxxxxx`, `D${i}`, "Room", "shared", null))
        const { world } = yield* start({ devices })
        const sent = yield* world.bell().send({ title: "Ring", priority: "ring", target: "everywhere" })
        // Some devices' passes have run, most have not.
        for (let i = 0; i < 30; i++) yield* Effect.yieldNow
        assert.isTrue(yield* world.bell().resolve(sent.notification.id))
        yield* world.settle
        for (const d of devices) {
          assert.deepStrictEqual(world.notify.ringingOn(d.id), [], d.id)
          assert.isFalse(world.holds(world.firstTab(d.id)).has(sent.notification.id), d.id)
        }
      }))

    it.effect("a dedupe key: sending it again while one is open answers that one and delivers nothing new", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const first = yield* world.sendOn("kitchen-display", { title: "Door open", key: "door" })
        const again = yield* world.sendOn("kitchen-display", { title: "Door still open", key: "door" })
        assert.isTrue(again.deduped)
        assert.strictEqual(again.notification.id, first.notification.id)
        assert.strictEqual(world.ringsOn("kitchen-display").length, 1)
        assert.isTrue(yield* world.bell().resolve({ key: "door" }))
        const third = yield* world.sendOn("kitchen-display", { title: "Door open again", key: "door" })
        assert.isFalse(third.deduped)
      }))

    it.effect("D6/a17: list pages only with views list returned; a view from send is refused as a cursor", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const one = yield* world.sendOn("kitchen-display", { title: "One" })
        yield* TestClock.adjust(1)
        yield* world.sendOn("kitchen-display", { title: "Two" })
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().list({ after: one.notification }))), "invalid")
        const [first] = yield* world.bell().list({ limit: 1 })
        assert.deepStrictEqual((yield* world.bell().list({ after: first! })).map((n) => n.title), ["Two"])
      }))

    // ---- Bounds

    it.effect("every bound is a typed refusal (invalid), and nothing is stored", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const refused = (r: Parameters<ModuleNotify["send"]>[0]) => Effect.map(Effect.exit(world.sendOn("kitchen-display", r)), reasonOf)
        const cases: ReadonlyArray<Parameters<ModuleNotify["send"]>[0]> = [
          { title: "x".repeat(61) },
          { title: "two\nlines" },
          { title: " " },
          { title: "Ok", text: "y".repeat(201) },
          { title: "Ok", text: "bell\u0007" },
          { title: "Ok", priority: "critical" as never },
          { title: "Ok", owner: "Sam!" },
          { title: "Ok", target: "kitchen" as never },
          { title: "Ok", key: "a key with spaces" },
          { title: "Ok", actions: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], handler: "answer" },
          { title: "Ok", actions: [{ id: "stop", label: "Stop" }], handler: "answer" },
          { title: "Ok", actions: [{ id: "snooze", label: "x".repeat(21) }], handler: "answer" },
          { title: "Ok", actions: [{ id: "snooze", label: "Snooze" }] },
          { title: "Ok", actions: [{ id: "snooze", label: "Snooze" }], handler: "nobody" },
          { title: "Ok", priority: "ring", expiresInMs: MAX_EXPIRY_MS.ring + 1 },
          { title: "Ok", expiresInMs: MAX_EXPIRY_MS.normal + 1 },
          { title: "Ok", expiresInMs: 999 }
        ]
        for (const r of cases) assert.strictEqual(yield* refused(r), "invalid", JSON.stringify(r))
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().send({ title: "Ok" }))), "invalid")
        assert.strictEqual((yield* world.bell().send({ title: "Ok", target: "everywhere" })).notification.target, "everywhere")
        assert.strictEqual((yield* world.rows).length, 1)
      }))

    it.effect(`at most ${MAX_OPEN_PER_MODULE} open notifications per module; at most ${MAX_OPEN_TOTAL} in all`, () =>
      Effect.gen(function*() {
        const modules = Array.from({ length: Math.ceil(MAX_OPEN_TOTAL / MAX_OPEN_PER_MODULE) + 1 }, (_, i) => `bell${i}`)
        const { world } = yield* start({ modules })
        const first = []
        for (let i = 0; i < MAX_OPEN_PER_MODULE; i++) first.push(yield* world.bell("bell0").send({ title: `N${i}`, target: "everywhere" }))
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell("bell0").send({ title: "One more", target: "everywhere" }))), "limit")
        assert.isTrue(yield* world.bell("bell0").resolve(first[0]!.notification.id))
        yield* world.bell("bell0").send({ title: "In its place", target: "everywhere" })
        let n = MAX_OPEN_PER_MODULE
        for (const m of modules.slice(1)) for (let i = 0; i < MAX_OPEN_PER_MODULE && n < MAX_OPEN_TOTAL; i++, n++) yield* world.bell(m).send({ title: `N${n}`, target: "everywhere" })
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell(modules.at(-1)!).send({ title: "One more", target: "everywhere" }))), "limit")
      }))

    it.effect("the worst legal row (with a claim) fits maxChars", () =>
      Effect.gen(function*() {
        const { world, store } = yield* start()
        const quote = "\""
        const r = yield* world.sendOn("kitchen-display", {
          title: quote.repeat(60),
          text: quote.repeat(200),
          priority: "ring",
          owner: "p".repeat(40),
          key: "k".repeat(64),
          actions: [{ id: "a".repeat(32), label: quote.repeat(20) }, { id: "b".repeat(32), label: quote.repeat(20) }],
          handler: "answer"
        })
        const row = yield* store.forCore(NOTIFY_OWNER).collection(notifications).get(r.notification.id)
        const worst = {
          ...row!.value,
          claim: { action: "a".repeat(32), by: "d".repeat(64), at: 8_640_000_000_000_000 },
          outcome: "o".repeat(40),
          finishedAt: 8_640_000_000_000_000,
          resolvedBy: "d".repeat(64),
          deviceId: "d".repeat(64),
          module: "m".repeat(64),
          sentAt: 8_640_000_000_000_000,
          expiresAt: 8_640_000_000_000_000,
          dedupe: "x".repeat(130),
          liveModule: "m".repeat(64)
        }
        assert.isAtMost(JSON.stringify(worst).length, NOTIFY_MAX_CHARS)
      }))

    // ---- Resolve, the maintenance job

    it.effect("resolve by id and by key takes the card down; another module's is not resolved; the host's outcomes cannot be claimed", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ modules: ["bell", "other"] })
        const mine = yield* world.sendOn("kitchen-display", { title: "Mine", key: "k" })
        const theirs = yield* world.sendOn("kitchen-display", { title: "Theirs" }, "other")
        assert.isFalse(yield* world.bell("bell").resolve(theirs.notification.id))
        assert.isTrue(yield* world.bell("bell").resolve({ key: "k" }, "done"))
        assert.isFalse(yield* world.bell("bell").resolve(mine.notification.id))
        yield* world.settle
        assert.deepStrictEqual(world.resolvedOn("kitchen-display"), [{ type: "notification.resolved", id: mine.notification.id, outcome: "done" }])
        for (const o of ["stop", "expired", "withdrawn"]) assert.strictEqual(reasonOf(yield* Effect.exit(world.bell("other").resolve(theirs.notification.id, o))), "invalid")
      }))

    // ---- Maintenance (D2b): a one-shot job planned for the next thing that is due, and an hourly safety net

    /** The `due` job's time as the scheduler has it (`undefined`: none live). */
    const dueJobAt = (world: Effect.Success<ReturnType<typeof notifyWorld>>) => Effect.map(notifyJobs(world), (live) => live.find((j) => j.handler === DUE_HANDLER)?.dueAt)

    it.effect("D2b: two jobs at most: hourly by key always, and due (by key) only while something is due; also after a restart", () =>
      Effect.gen(function*() {
        const { opened, world } = yield* start()
        const t0 = yield* Clock.currentTimeMillis
        // Nothing is due: the hourly job alone.
        assert.deepStrictEqual((yield* notifyJobs(world)).map((j) => [j.handler, j.key, j.cron]), [[HOURLY_HANDLER, HOURLY_HANDLER, HOURLY_CRON]])
        assert.isUndefined(world.notify.plannedAt())
        const ring = yield* world.sendOn("kitchen-display", { title: "A", priority: "ring" })
        assert.strictEqual(world.notify.plannedAt(), ring.notification.expiresAt)
        yield* world.bell().dnd.set({ until: t0 + 5 * MINUTE })
        yield* world.settle
        assert.strictEqual(world.notify.plannedAt(), t0 + 5 * MINUTE)
        const live = yield* notifyJobs(world)
        assert.deepStrictEqual(live.map((j) => [j.handler, j.key, j.dueAt]).sort(), [[DUE_HANDLER, DUE_HANDLER, t0 + 5 * MINUTE], [HOURLY_HANDLER, HOURLY_HANDLER, t0 + HOUR]])
        yield* world.stop
        // A restart plans at start: the same two jobs, the due one at the same time.
        const again = yield* notifyWorld(yield* prepared(yield* opened.reopen))
        yield* again.settle
        assert.strictEqual(again.notify.plannedAt(), t0 + 5 * MINUTE)
        assert.deepStrictEqual((yield* notifyJobs(again)).map((j) => j.handler).sort(), [DUE_HANDLER, HOURLY_HANDLER])
        // When it all has ended and been cleaned up, the due job goes.
        yield* again.bell().dnd.clear
        yield* again.bell().resolve(ring.notification.id)
        yield* again.settle
        const resolvedAt = (yield* again.rows)[0]!.value.finishedAt!
        assert.strictEqual(again.notify.plannedAt(), resolvedAt + KEEP_RESOLVED_MS)
        yield* again.advance(KEEP_RESOLVED_MS)
        assert.deepStrictEqual(yield* again.rows, [])
        assert.isUndefined(again.notify.plannedAt())
        assert.deepStrictEqual((yield* notifyJobs(again)).map((j) => j.handler), [HOURLY_HANDLER])
      }))

    it.effect("a15: an hourly job that cannot be scheduled at start is a Health issue, and is scheduled at the next send", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty(undefined, (f) => (f.jobs = 1))
        assert.isFalse(world.notify.maintenanceScheduled())
        assert.deepStrictEqual(world.issues.all().map((i) => i.id), ["core.notify.maintenance"])
        assert.strictEqual(faults.jobs, 0)
        // Sending works meanwhile, and schedules it.
        yield* world.sendOn("kitchen-display", { title: "Works", priority: "ring" })
        assert.strictEqual(world.ringsOn("kitchen-display").length, 1)
        assert.isTrue(world.notify.maintenanceScheduled())
        assert.deepStrictEqual(world.issues.all(), [])
        assert.deepStrictEqual((yield* notifyJobs(world)).map((j) => j.handler).sort(), [DUE_HANDLER, HOURLY_HANDLER])
      }))

    it.effect("expiry on time: the due job resolves a notification at its expiry exactly (a minute, 15 minutes for a ring, a day for a normal one)", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const short = yield* world.sendOn("kitchen-display", { title: "Short", priority: "ring", expiresInMs: MINUTE })
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        const plain = yield* world.sendOn("kitchen-display", { title: "Plain" })
        const state = (id: string) => Effect.map(world.rows, (rows) => rows.find((r) => r.id === id)?.value.outcome ?? "open")
        yield* world.advance(MINUTE - 1)
        assert.strictEqual(yield* state(short.notification.id), "open")
        yield* world.advance(1)
        assert.strictEqual(yield* state(short.notification.id), "expired")
        assert.strictEqual(world.notify.plannedAt(), ring.notification.expiresAt)
        yield* world.advance(15 * MINUTE - MINUTE - 1)
        assert.strictEqual(yield* state(ring.notification.id), "open")
        yield* world.advance(1)
        assert.strictEqual(yield* state(ring.notification.id), "expired")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        assert.isTrue(world.resolvedOn("kitchen-display").some((m) => m.id === ring.notification.id && m.outcome === "expired"))
        yield* world.advance(plain.notification.expiresAt - (yield* Clock.currentTimeMillis) - 1)
        assert.strictEqual(yield* state(plain.notification.id), "open")
        yield* world.advance(1)
        assert.strictEqual(yield* state(plain.notification.id), "expired")
      }))

    it.effect("D2b: plan() runs after each kind of change: send, resolve, a press's outcome, do not disturb, a device marked for another pass", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        const t0 = yield* Clock.currentTimeMillis
        const later = yield* world.sendOn("kitchen-display", { title: "Later", expiresInMs: 2 * HOUR })
        assert.strictEqual(world.notify.plannedAt(), t0 + 2 * HOUR)
        assert.strictEqual(yield* dueJobAt(world), t0 + 2 * HOUR)
        // send: an earlier expiry moves it earlier.
        const sooner = yield* world.sendOn("kitchen-display", { title: "Sooner", expiresInMs: HOUR, actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        assert.strictEqual(yield* dueJobAt(world), t0 + HOUR)
        // do not disturb with an earlier end; clearing it moves it back.
        yield* world.bell().dnd.set({ until: t0 + 10 * MINUTE })
        yield* world.settle
        assert.strictEqual(yield* dueJobAt(world), t0 + 10 * MINUTE)
        yield* world.bell().dnd.clear
        yield* world.settle
        assert.strictEqual(yield* dueJobAt(world), t0 + HOUR)
        // a device marked for another pass: a minute from now.
        faults.reads = 1
        yield* world.open("robins-phone")
        assert.strictEqual(yield* dueJobAt(world), t0 + MINUTE)
        yield* world.advance(MINUTE)
        assert.strictEqual(yield* dueJobAt(world), t0 + HOUR)
        // a press's outcome (resolved): the next is the later one.
        assert.isTrue((yield* world.pressOn("kitchen-display", sooner.notification.id, "snooze")).ok)
        const doneAt = (yield* world.rows).find((r) => r.id === sooner.notification.id)!.value.finishedAt!
        assert.strictEqual(yield* dueJobAt(world), t0 + 2 * HOUR)
        // resolve: retention of the two resolved rows comes after the last expiry is gone.
        yield* world.bell().resolve(later.notification.id)
        yield* world.settle
        assert.strictEqual(yield* dueJobAt(world), doneAt + KEEP_RESOLVED_MS)
        assert.deepStrictEqual(world.issues.all(), [])
      }))

    it.effect("D2b: two changes at once plan once each, in turn: the job ends at the earliest", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const t0 = yield* Clock.currentTimeMillis
        yield* Effect.all([
          world.bell().send({ title: "One", target: "everywhere", expiresInMs: 3 * HOUR }),
          world.bell().send({ title: "Two", target: "everywhere", expiresInMs: HOUR }),
          world.bell().dnd.set({ until: t0 + 2 * HOUR })
        ], { concurrency: "unbounded" })
        yield* world.settle
        assert.strictEqual(world.notify.plannedAt(), t0 + HOUR)
        assert.strictEqual(yield* dueJobAt(world), t0 + HOUR)
        assert.strictEqual((yield* notifyJobs(world)).length, 2)
      }))

    it.effect("D2b: a lost plan (the due job could not be written) is a Health issue; the hourly job does the work within the hour and plans again", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        faults.jobs = 1
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring", expiresInMs: 10 * MINUTE })
        assert.deepStrictEqual(world.issues.all().map((i) => i.id), ["core.notify.plan"])
        assert.isUndefined(yield* dueJobAt(world))
        // Its expiry passes with no due job: still open until the hourly job, at the top of the hour.
        yield* world.advance(HOUR - SECOND - (yield* Clock.currentTimeMillis) % HOUR)
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        yield* world.advance(SECOND)
        assert.strictEqual((yield* world.rows)[0]?.value.outcome, "expired")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        // And it planned again (retention of the resolved row): the issue is gone.
        assert.deepStrictEqual(world.issues.all(), [])
        assert.strictEqual(yield* dueJobAt(world), (yield* world.rows)[0]!.value.finishedAt! + KEEP_RESOLVED_MS)
        assert.strictEqual(ring.notification.id, (yield* world.rows)[0]!.id)
      }))

    it.effect("a7: a wall-clock correction (the wall clock alone moves): forwards, the next run resolves what expired; backwards, nothing expires early", () =>
      Effect.gen(function*() {
        // A real date, so that a wall clock moved back is still a time after 1970.
        yield* TestClock.setTime(WALL_START)
        const wall = { offset: 0 }
        const { world } = yield* start({ wall })
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        wall.offset = -3 * HOUR
        yield* world.notify.maintainNow
        yield* world.settle
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        wall.offset = 3 * HOUR
        yield* world.notify.planNow
        // Planned for now (or earlier) by the wall clock: the expiry has passed.
        assert.isAtMost(world.notify.plannedAt()!, (yield* Clock.currentTimeMillis) + 3 * HOUR)
        yield* world.notify.maintainNow
        yield* world.settle
        assert.strictEqual((yield* world.rows)[0]?.value.outcome, "expired")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        assert.strictEqual(ring.notification.id, (yield* world.rows)[0]!.id)
      }))

    it.effect(`a11: expiry needs no per-notification job: a maintenance run that fails is repeated (at the latest by the hourly job)`, () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring", expiresInMs: MINUTE })
        faults.reads = 1_000
        yield* world.advance(5 * MINUTE)
        assert.strictEqual((yield* world.rows).find((r) => r.id === ring.notification.id)?.value.state, "open")
        faults.reads = 0
        yield* world.advance(HOUR)
        assert.strictEqual((yield* world.rows).find((r) => r.id === ring.notification.id)?.value.outcome, "expired")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
      }))

    it.effect(`a7: retention: one run removes exactly ${MAINTENANCE_ROWS} resolved rows past the day, at most a page per transaction; the next run the rest; open ones stay`, () =>
      Effect.gen(function*() {
        const modules = Array.from({ length: 14 }, (_, i) => `m${i}`)
        const removals: Array<number> = []
        // A real date, so that a wall clock moved back is still a time after 1970.
        yield* TestClock.setTime(WALL_START)
        const wall = { offset: 0 }
        const { world } = yield* start({ modules, wall, observe: (e) => void (e.kind === "retention" && removals.push(e.removed)) })
        // 130 resolved rows (more than one run, many pages), and one that stays open.
        for (let i = 0; i < 130; i++) {
          const m = modules[i % 13]!
          const r = yield* world.bell(m).send({ title: `R${i}`, target: "everywhere" })
          yield* world.bell(m).resolve(r.notification.id)
        }
        yield* world.bell("m13").send({ title: "Stays", target: "everywhere", expiresInMs: MAX_EXPIRY_MS.normal })
        yield* world.settle
        // Isolated runs: the wall clock alone moves past the day, so no job fires; each run is called once.
        wall.offset = KEEP_RESOLVED_MS - MINUTE
        yield* world.notify.maintainNow
        assert.strictEqual((yield* world.rows).length, 131)
        removals.length = 0
        wall.offset = KEEP_RESOLVED_MS + MINUTE
        yield* world.notify.maintainNow
        assert.strictEqual((yield* world.rows).length, 131 - MAINTENANCE_ROWS)
        assert.strictEqual(removals.reduce((a, b) => a + b, 0), MAINTENANCE_ROWS)
        assert.isAtMost(Math.max(...removals), 12)
        yield* world.notify.maintainNow
        assert.deepStrictEqual((yield* world.rows).map((r) => r.value.title), ["Stays"])
      }))

    it.effect("retention on time: the due job removes a resolved row exactly a day after it was resolved", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const n = yield* world.sendOn("kitchen-display", { title: "Gone soon" })
        yield* world.bell().resolve(n.notification.id)
        yield* world.advance(KEEP_RESOLVED_MS - 1)
        assert.strictEqual((yield* world.rows).length, 1)
        yield* world.advance(1)
        assert.deepStrictEqual(yield* world.rows, [])
      }))

    // ---- Do not disturb

    it.effect("do not disturb: a ring is held silent; clearing it rings again; an end time ends it on time", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const now = yield* Clock.currentTimeMillis
        assert.deepStrictEqual(yield* world.bell().dnd.set({ until: now + HOUR }), { on: true, until: now + HOUR })
        const ring = yield* world.sendOn("kitchen-display", { title: "Quiet ring", priority: "ring" })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, false)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        yield* world.bell().dnd.clear
        yield* world.settle
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, true)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
        // a12: clear and set again at once: no job of its own to cancel; the newest state is what holds.
        yield* world.bell().dnd.set({ until: now + 2 * MINUTE })
        yield* world.bell().dnd.clear
        yield* world.bell().dnd.set({ until: now + 5 * MINUTE })
        yield* world.settle
        yield* world.advance(5 * MINUTE - 1)
        assert.isTrue((yield* world.bell().dnd.get).on)
        yield* world.advance(1)
        assert.deepStrictEqual(world.notify.dnd(), { on: false, known: true })
        assert.deepStrictEqual(yield* world.bell().dnd.get, { on: false })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, true)
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().dnd.set({ until: now - 1 }))), "invalid")
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().dnd.set({ until: now + 2 * MAX_DND_MS }))), "invalid")
      }))

    it.effect("a3: do not disturb that could not be read counts as on (nothing sounds) until it has been read", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty(undefined, (f) => (f.dnd = 1))
        assert.deepStrictEqual(world.notify.dnd(), { on: true, known: false })
        yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, false)
        assert.strictEqual(faults.dnd, 0)
        // Planned a minute later: the due run reads it (off), and it rings now.
        yield* world.advance(MINUTE)
        assert.deepStrictEqual(world.notify.dnd(), { on: false, known: true })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, true)
      }))

    it.effect("a2 (round 2): a read of do not disturb that fails after start makes it unknown (on) and silences the holders; a later read restores it", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        assert.deepStrictEqual(world.notify.dnd(), { on: false, known: true })
        yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, true)
        faults.dnd = 1
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().dnd.get)), "failed")
        yield* world.settle
        assert.deepStrictEqual(world.notify.dnd(), { on: true, known: false })
        // The card it held is sent again silent; a new ring is silent too.
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, false)
        yield* world.sendOn("kitchen-display", { title: "Another", priority: "ring" })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.sound, false)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        // A maintenance read that fails does the same; a later successful read restores it and reconciles again.
        faults.dnd = 1
        yield* world.notify.maintainNow
        assert.deepStrictEqual(world.notify.dnd(), { on: true, known: false })
        assert.deepStrictEqual(yield* world.bell().dnd.get, { on: false })
        yield* world.settle
        assert.deepStrictEqual(world.notify.dnd(), { on: false, known: true })
        assert.strictEqual(world.notify.ringingOn("kitchen-display").length, 2)
      }))

    // ---- Presses

    it.effect("stop is the host's: it resolves the notification on every device and page that held it; stopRinging and onRingingChanged say so", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const changes: Array<string> = []
        world.notify.onRingingChanged((d) => changes.push(d))
        const tab2 = yield* world.open("robins-phone")
        const ring = yield* world.sendOn("kitchen-display", { title: "Both", priority: "ring", target: "everywhere" })
        assert.deepStrictEqual([...new Set(changes)].sort(), ["kitchen-display", "robins-phone"])
        assert.deepStrictEqual(yield* world.pressOn("robins-phone", ring.notification.id, "stop"), { ok: true, say: "Done." })
        for (const tab of [world.firstTab("kitchen-display")!, world.firstTab("robins-phone")!, tab2]) assert.isFalse(world.holds(tab).has(ring.notification.id))
        assert.deepStrictEqual(world.notify.ringingOn("robins-phone"), [])
        assert.strictEqual((yield* world.rows)[0]?.value.resolvedBy, "robins-phone")
        // stopRinging (P7's "stop"): every ring held on the device, resolved.
        const two = yield* world.sendOn("kitchen-display", { title: "Two", priority: "ring" })
        const three = yield* world.sendOn("kitchen-display", { title: "Three", priority: "ring" })
        changes.length = 0
        assert.strictEqual(yield* world.notify.stopRinging("kitchen-display"), 2)
        yield* world.settle
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        assert.isTrue(changes.includes("kitchen-display"))
        assert.deepStrictEqual((yield* world.rows).filter((r) => [two.notification.id, three.notification.id].includes(r.id)).map((r) => r.value.outcome), ["stop", "stop"])
      }))

    it.effect("an action reaches the module's handler with the notification and the device; it resolves unless the handler keeps it open; a failing handler changes nothing", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Timer", priority: "ring", key: "t1", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.succeed({ say: "Kept.", keepOpen: true })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", ring.notification.id, "snooze"), { ok: true, say: "Kept." })
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        assert.isUndefined((yield* world.rows)[0]?.value.claim)
        world.answer.current = () => Effect.succeed({ say: "Snoozed." })
        yield* world.pressOn("kitchen-display", ring.notification.id, "snooze")
        assert.deepStrictEqual(world.presses.at(-1), { notificationId: ring.notification.id, actionId: "snooze", key: "t1", deviceId: "kitchen-display" })
        assert.strictEqual((yield* world.rows)[0]?.value.outcome, "snooze")
        const two = yield* world.sendOn("kitchen-display", { title: "Two", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.fail("broken")
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", two.notification.id, "snooze"), { ok: false, say: "That didn't work.", code: "failed" })
        const after = (yield* world.rows).find((r) => r.id === two.notification.id)!
        assert.strictEqual(after.value.state, "open")
        assert.isUndefined(after.value.claim)
        assert.strictEqual((yield* world.pressOn("kitchen-display", two.notification.id, "dance")).code, "unknown")
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", ring.notification.id, "stop"), { ok: false, say: "I can't do that right now.", code: "unknown" })
      }))

    it.effect("a long handler answer is cut at the real page boundary", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const n = yield* world.sendOn("kitchen-display", { title: "Long", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.succeed({ say: `${"word ".repeat(200)}end` })
        const a = yield* world.pressOn("kitchen-display", n.notification.id, "snooze")
        assert.isTrue(a.ok)
        assert.isAtMost(a.say.length, 300)
        assert.notInclude(a.say, "end")
      }))

    it.effect(`the handler's time limit: one that runs past ${NOTIFY_ACTION_TIMEOUT_MS} ms fails, its claim is released, the notification stays open`, () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const n = yield* world.sendOn("kitchen-display", { title: "Slow", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.never
        const fiber = yield* Effect.forkChild(world.pressOn("kitchen-display", n.notification.id, "snooze"))
        yield* world.settle
        yield* TestClock.adjust(NOTIFY_ACTION_TIMEOUT_MS + 1)
        assert.deepStrictEqual(yield* Fiber.join(fiber), { ok: false, say: "That didn't work.", code: "failed" })
        const row = (yield* world.rows)[0]!
        assert.strictEqual(row.value.state, "open")
        assert.isUndefined(row.value.claim)
      }))

    it.effect("a5: two presses at once, from two devices or two pages: one claims it, the other is told it is being handled", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const tab2 = yield* world.open("kitchen-display")
        const n = yield* world.sendOn("kitchen-display", { title: "Both", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        const release = yield* Deferred.make<void>()
        let entries = 0
        world.answer.current = () => Effect.andThen(Effect.sync(() => void entries++), Effect.as(Deferred.await(release), { say: "Handled." }))
        const first = yield* Effect.forkChild(world.pressOn("kitchen-display", n.notification.id, "snooze"))
        yield* world.settle
        assert.deepStrictEqual(yield* world.pressOn("robins-phone", n.notification.id, "snooze"), { ok: false, say: "That is being handled already.", code: "busy" })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "snooze", tab2), { ok: false, say: "That is being handled already.", code: "busy" })
        assert.strictEqual(entries, 1)
        yield* Deferred.succeed(release, undefined)
        assert.deepStrictEqual(yield* Fiber.join(first), { ok: true, say: "Handled." })
        assert.strictEqual(entries, 1)
      }))

    it.effect("stop wins over a module action under way: it resolves at once, and the action's outcome is dropped", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const n = yield* world.sendOn("kitchen-display", { title: "Race", priority: "ring", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        const release = yield* Deferred.make<void>()
        world.answer.current = () => Effect.as(Deferred.await(release), { say: "Snoozed." })
        const action = yield* Effect.forkChild(world.pressOn("kitchen-display", n.notification.id, "snooze"))
        yield* world.settle
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "stop"), { ok: true, say: "Done." })
        yield* Deferred.succeed(release, undefined)
        assert.deepStrictEqual(yield* Fiber.join(action), { ok: false, say: "That has ended already.", code: "unknown" })
        assert.strictEqual((yield* world.rows)[0]?.value.outcome, "stop")
      }))

    it.effect("a6: an outcome that cannot be written is a failure; the claim holds until the maintenance job releases it, then the press runs the handler again", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        const n = yield* world.sendOn("kitchen-display", { title: "Write", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        let calls = 0
        world.answer.current = () =>
          Effect.sync(() => {
            calls++
            // The claim was written; every write of the outcome (and its retries) fails.
            faults.writes = 10
            return { say: "Done it." }
          })
        const fiber = yield* Effect.forkChild(world.pressOn("kitchen-display", n.notification.id, "snooze"))
        yield* world.settle
        yield* TestClock.adjust(5 * SECOND)
        assert.deepStrictEqual(yield* Fiber.join(fiber), { ok: false, say: "That didn't work.", code: "failed" })
        faults.writes = 0
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "snooze"), { ok: false, say: "That is being handled already.", code: "busy" })
        yield* world.advance(CLAIM_RELEASE_MS + MINUTE)
        world.answer.current = () => Effect.sync(() => (calls++, { say: "Done it." }))
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "snooze"), { ok: true, say: "Done it." })
        assert.strictEqual(calls, 2)
      }))

    it.effect("a7: a press is admitted only from a device whose page holds the notification, and only while the decision allows it there; stop too", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const n = yield* world.sendOn("kitchen-display", { title: "Sam's", owner: "p-sam", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        assert.isFalse(world.holds(world.firstTab("hall-screen")).has(n.notification.id))
        for (const action of ["snooze", "stop"]) assert.deepStrictEqual(yield* world.pressOn("hall-screen", n.notification.id, action), { ok: false, say: "I can't do that right now.", code: "unknown" })
        assert.deepStrictEqual(world.presses, [])
        // A press must come from a page that holds it: the kitchen's press naming Robin's phone's page is refused.
        assert.strictEqual((yield* world.pressOn("kitchen-display", n.notification.id, "snooze", world.firstTab("robins-phone"))).code, "unknown")
        assert.deepStrictEqual(world.presses, [])
        // Held on the kitchen display; then the kitchen becomes Robin's: a press with the id it learned is refused, and the card goes.
        assert.isTrue(world.holds(world.firstTab("kitchen-display")).has(n.notification.id))
        world.places.set("kitchen-display", { privacy: "shared", defaultPerson: "p-robin" })
        assert.strictEqual((yield* world.pressOn("kitchen-display", n.notification.id, "stop")).code, "unknown")
        assert.isFalse(world.holds(world.firstTab("kitchen-display")).has(n.notification.id))
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
      }))

    it.effect("a9: a press whose read fails is a failure that changes nothing (never 'it has ended')", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        const n = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        faults.reads = 1
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "stop"), { ok: false, say: "I can't do that right now.", code: "failed" })
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [n.notification.id])
        assert.deepStrictEqual(world.resolvedOn("kitchen-display"), [])
      }))

    it.effect("a1 (round 2): a claim held by a run alive here is never taken over or released because the wall clock moved, forwards or backwards, maintenance or not", () =>
      Effect.gen(function*() {
        // A real date, so that a wall clock moved back is still a time after 1970.
        yield* TestClock.setTime(WALL_START)
        const wall = { offset: 0 }
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"], wall })
        const n = yield* world.sendOn("kitchen-display", { title: "Both", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        const release = yield* Deferred.make<void>()
        let entries = 0
        world.answer.current = () => Effect.andThen(Effect.sync(() => void entries++), Effect.as(Deferred.await(release), { say: "Handled." }))
        const first = yield* Effect.forkChild(world.pressOn("kitchen-display", n.notification.id, "snooze"))
        yield* world.settle
        for (const offset of [MINUTE, CLAIM_RELEASE_MS * 10, -HOUR]) {
          wall.offset = offset
          yield* world.notify.maintainNow
          yield* world.settle
          assert.isDefined((yield* world.rows)[0]?.value.claim, `offset ${offset}`)
          assert.deepStrictEqual(yield* world.pressOn("robins-phone", n.notification.id, "snooze"), { ok: false, say: "That is being handled already.", code: "busy" })
        }
        assert.strictEqual(entries, 1)
        yield* Deferred.succeed(release, undefined)
        assert.deepStrictEqual(yield* Fiber.join(first), { ok: true, say: "Handled." })
        assert.strictEqual(entries, 1)
      }))

    it.effect("a1 (round 2): a claim no run here holds (its outcome could not be written) is released when stale, or when dated in the future after the clock moved back", () =>
      Effect.gen(function*() {
        // A real date, so that a wall clock moved back is still a time after 1970.
        yield* TestClock.setTime(WALL_START)
        const wall = { offset: 0 }
        const { world, faults } = yield* startFaulty({ wall })
        const n = yield* world.sendOn("kitchen-display", { title: "Write", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.sync(() => ((faults.writes = 10), { say: "Done it." }))
        const fiber = yield* Effect.forkChild(world.pressOn("kitchen-display", n.notification.id, "snooze"))
        yield* world.settle
        yield* TestClock.adjust(5 * SECOND)
        assert.strictEqual((yield* Fiber.join(fiber)).code, "failed")
        faults.writes = 0
        assert.isDefined((yield* world.rows)[0]?.value.claim)
        // Not stale yet by the wall clock: kept.
        yield* world.notify.maintainNow
        assert.isDefined((yield* world.rows)[0]?.value.claim)
        // The wall clock moves back an hour: the claim is in the future, so no run can be holding it: released.
        wall.offset = -HOUR
        yield* world.notify.maintainNow
        assert.isUndefined((yield* world.rows)[0]?.value.claim)
        world.answer.current = () => Effect.succeed({ say: "Again." })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "snooze"), { ok: true, say: "Again." })
      }))

    it.effect("a3 (round 2): stopRinging finishes every ring it found even when its caller is interrupted while the store is busy", () =>
      Effect.gen(function*() {
        const { world, gate } = yield* startFaulty()
        const one = yield* world.sendOn("kitchen-display", { title: "One", priority: "ring" })
        const two = yield* world.sendOn("kitchen-display", { title: "Two", priority: "ring" })
        const busy = yield* Deferred.make<void>()
        gate.skip = 1
        gate.wait = busy
        const caller = yield* Effect.forkChild(world.notify.stopRinging("kitchen-display"))
        yield* world.settle
        assert.isUndefined(gate.wait, "the second stop waits on the busy store")
        yield* Fiber.interrupt(caller)
        yield* Deferred.succeed(busy, undefined)
        yield* world.settle
        const states = new Map((yield* world.rows).map((r) => [r.id, r.value.outcome ?? r.value.state] as const))
        assert.deepStrictEqual([states.get(one.notification.id), states.get(two.notification.id)], ["stop", "stop"])
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
      }))

    it.effect("a4 (round 2): the ringing signal is told for each step that succeeded although a later step of the pass failed, once, and for removals outside a pass", () =>
      Effect.gen(function*() {
        const modules = ["m0", "m1"]
        const { world, faults } = yield* startFaulty({ modules, connected: [] })
        for (let i = 0; i < 12; i++) yield* world.bell(modules[i % 2]).send({ title: `R${i}`, priority: "ring", target: "everywhere" })
        const changes: Array<string> = []
        world.notify.onRingingChanged((d) => changes.push(d))
        // The first page (12 rows) is read and sent; the next read fails.
        faults.skipReads = 1
        faults.reads = 1
        const tab = yield* world.open("kitchen-display")
        assert.strictEqual(world.holds(tab).size, 12)
        assert.strictEqual(faults.reads, 0)
        assert.deepStrictEqual(changes, ["kitchen-display"])
        // The retry changes nothing: nothing more is told.
        world.notify.reconcile("kitchen-display")
        yield* world.settle
        assert.deepStrictEqual(changes, ["kitchen-display"])
        // The page closes: told (nothing rings there now).
        yield* world.close(tab)
        assert.deepStrictEqual(changes, ["kitchen-display", "kitchen-display"])
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
      }))

    it.effect("a5 (round 2): every action outcome (kept open, a failing handler) repeats a failed pass of another device", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty({ connected: ["kitchen-display"] })
        const n = yield* world.sendOn("kitchen-display", { title: "Both", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        faults.reads = 1
        const phone = yield* world.open("robins-phone")
        assert.strictEqual(world.holds(phone).size, 0)
        world.answer.current = () => Effect.succeed({ say: "Kept.", keepOpen: true })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "snooze"), { ok: true, say: "Kept." })
        assert.isTrue(world.holds(phone).has(n.notification.id))
        faults.reads = 1
        const phone2 = yield* world.open("robins-phone")
        assert.isFalse(world.holds(phone2).has(n.notification.id))
        world.answer.current = () => Effect.fail("broken")
        assert.strictEqual((yield* world.pressOn("kitchen-display", n.notification.id, "snooze")).code, "failed")
        assert.isTrue(world.holds(phone2).has(n.notification.id))
      }))

    it.effect("a8 (round 2): a press that waited on a busy store is admitted against the state when its transaction runs; stop too", () =>
      Effect.gen(function*() {
        const { world, gate } = yield* startFaulty()
        for (const action of ["snooze", "stop"]) {
          world.places.set("kitchen-display", { privacy: "shared", defaultPerson: "p-sam" })
          const n = yield* world.sendOn("kitchen-display", { title: `Sam's ${action}`, owner: "p-sam", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
          assert.isTrue(world.holds(world.firstTab("kitchen-display")).has(n.notification.id))
          const busy = yield* Deferred.make<void>()
          gate.wait = busy
          const press = yield* Effect.forkChild(world.notify.press({ notificationId: n.notification.id, actionId: action, deviceId: "kitchen-display", connection: makeConnectionRef(world.firstTab("kitchen-display")!.id) }))
          yield* world.settle
          // Meanwhile the kitchen becomes Robin's: the card is withdrawn.
          world.places.set("kitchen-display", { privacy: "shared", defaultPerson: "p-robin" })
          world.notify.reconcile("kitchen-display")
          yield* world.settle
          assert.isFalse(world.holds(world.firstTab("kitchen-display")).has(n.notification.id))
          yield* Deferred.succeed(busy, undefined)
          assert.deepStrictEqual(yield* Fiber.join(press), { ok: false, say: "I can't do that right now.", code: "unknown" })
          assert.strictEqual((yield* world.rows).find((r) => r.id === n.notification.id)?.value.state, "open")
        }
        assert.deepStrictEqual(world.presses, [])
      }))

    // ---- Restarts, reconnects, failed passes

    it.effect("a server restart: a ring that was open rings again on the page that says hello; counters and do not disturb survive", () =>
      Effect.gen(function*() {
        const { opened, world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Open ring", priority: "ring", expiresInMs: HOUR })
        yield* world.stop
        const again = yield* notifyWorld(yield* prepared(yield* opened.reopen), { connected: [] })
        yield* again.settle
        const tab = yield* again.open("kitchen-display")
        assert.deepStrictEqual([...again.holds(tab).values()].map((c) => [c.id, c.sound]), [[ring.notification.id, true]])
        assert.deepStrictEqual((yield* again.bell().list()).map((n) => n.id), [ring.notification.id])
        yield* again.bell().dnd.set()
        yield* again.stop
        const third = yield* notifyWorld(yield* prepared(yield* opened.reopen))
        yield* third.settle
        assert.deepStrictEqual(third.notify.dnd(), { on: true, known: true })
      }))

    it.effect("a device whose page closes and opens again while it rings gets the ring again", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Ringing", priority: "ring" })
        yield* world.close(world.firstTab("kitchen-display")!)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        const tab = yield* world.open("kitchen-display")
        assert.isTrue(world.holds(tab).has(ring.notification.id))
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
      }))

    it.effect("a10: a pass that fails is repeated by the maintenance job, with no hello or change needed", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        faults.reads = 1
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        assert.deepStrictEqual(world.ringsOn("kitchen-display"), [])
        yield* world.advance(MINUTE)
        assert.deepStrictEqual(world.ringsOn("kitchen-display").map((c) => c.id), [ring.notification.id])
      }))

    // ---- Failure boundaries

    it.effect("a store failure at send (the row, or a counter): a typed failure, nothing stored, nothing delivered, nothing counted", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        faults.writes = 1
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "Lost" }))), "failed")
        faults.counts = 1
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "Lost too" }))), "failed")
        assert.deepStrictEqual(yield* world.rows, [])
        assert.deepStrictEqual(world.ringsOn("kitchen-display"), [])
        for (let i = 0; i < MAX_OPEN_PER_MODULE; i++) yield* world.sendOn("kitchen-display", { title: `N${i}` })
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "One more" }))), "limit")
      }))

    it.effect("a store failure at resolve (the row, or a counter): it stays open and keeps ringing; the next try resolves it", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        for (const k of ["writes", "counts"] as const) {
          faults[k] = 1
          assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().resolve(ring.notification.id))), "failed")
          yield* world.settle
          assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
          assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
          faults[k] = 1
          assert.deepStrictEqual(yield* world.pressOn("kitchen-display", ring.notification.id, "stop"), { ok: false, say: "I can't do that right now.", code: "failed" })
        }
        assert.isTrue(yield* world.bell().resolve(ring.notification.id))
        yield* world.settle
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
      }))

    it.effect("a store failure at the claim: nothing runs, nothing changes", () =>
      Effect.gen(function*() {
        const { world, faults } = yield* startFaulty()
        const n = yield* world.sendOn("kitchen-display", { title: "Claim", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        faults.writes = 1
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", n.notification.id, "snooze"), { ok: false, say: "I can't do that right now.", code: "failed" })
        assert.deepStrictEqual(world.presses, [])
        assert.isUndefined((yield* world.rows)[0]?.value.claim)
      }))
  })
