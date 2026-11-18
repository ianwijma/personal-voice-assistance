/**
 * The notification service's contract tests (docs/NOTIFICATIONS.md): one case per promise of that page, run on the
 * in-memory store (`packages/core/test/NotifyContract.test.ts`) and on SQLite in memory and on a file
 * (`packages/store-sqlite/test/notifyContract.test.ts`), on the test clock. A case's title names the promise.
 *
 * The world of a case is the server's: the household store, the real scheduler engine, the real notification engine
 * and a real module host with small modules whose shared parts keep their `ctx.notify`, over a fixed set of devices
 * whose places (and so the privacy rule) a case may change. "A restart" closes all of it and makes it again on the same
 * store (the file is closed and opened again).
 */
import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { KnownDevice } from "./Devices.ts"
import { makeEventBus } from "./EventBus.ts"
import { type HouseholdStore, type ModuleStore, type Row, StoreError, type StoreTx } from "./HouseholdStore.ts"
import { makeIssueRegistry } from "./Issues.ts"
import { defineModule, ModuleStartError } from "./ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "./ModuleHost.ts"
import {
  type ActionAnswer,
  type ActionPress,
  KEEP_RESOLVED_MS,
  MAX_DND_MS,
  MAX_EXPIRY_MS,
  MAX_LATER_MS,
  MAX_OPEN_PER_MODULE,
  MAX_OPEN_TOTAL,
  type ModuleNotify,
  type ModuleSpeech,
  NOTIFY_MAX_CHARS,
  NOTIFY_OWNER,
  notifications,
  notifyStorage,
  type StoredNotification
} from "./Notify.ts"
import { type DecisionRecord, makeNotifyEngine, type NotifyMessage } from "./NotifyEngine.ts"
import { makePrivacy, type PrivacyPlace } from "./Privacy.ts"
import { makeSchedulerEngine } from "./SchedulerEngine.ts"
import { schedulerStorage } from "./SchedulerJobs.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

/** A store for one case; `reopen` closes it and opens the same data again (in memory: the same store). */
export interface NotifyContractStore {
  readonly store: HouseholdStore
  readonly reopen: Effect.Effect<HouseholdStore, unknown>
}
export type OpenNotifyStore = () => Effect.Effect<NotifyContractStore, unknown, Scope.Scope>

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** The devices of every case: a shared kitchen display (Sam's), Robin's private phone, a public hall screen. */
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
export const CONTRACT_DEVICES: ReadonlyArray<KnownDevice> = [
  contractDevice("kitchen-display", "Kitchen display", "Kitchen", "shared", "p-sam"),
  contractDevice("robins-phone", "Robin's phone", "Bedroom", "private", "p-robin"),
  contractDevice("hall-screen", "Hall screen", "Hall", "public", null)
]
const MEMBERS = new Set(["p-sam", "p-robin", "p-alex"])

const turnOn = (deviceId: string): TurnContext => ({ turnId: 1, conversationId: "c1", source: "voice", assistantId: "jeff", deviceId })

/** A module whose shared part keeps its `ctx.notify` and registers the action handler `answer`. */
const notifyingModule = (id: string, held: Map<string, ModuleNotify>, speakers: Map<string, ModuleSpeech>, presses: Array<ActionPress>, answer: { current: (p: ActionPress) => Effect.Effect<ActionAnswer | void, unknown> }) =>
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
 * The fault-injecting store: the service's own writes to `notifications` (insert, update) fail while `faults.writes`
 * is above 0 (`StoreError` `failed`, each failure counting it down), inside the service's transactions.
 */
export const notifyFaultyStore = (inner: HouseholdStore) => {
  const faults = { writes: 0, failed: 0 }
  const failing = (tx: StoreTx): StoreTx => ({
    ...tx,
    collection: ((c: Parameters<StoreTx["collection"]>[0]) => {
      const col = tx.collection(c)
      if (c.name !== notifications.name) return col
      const fault = () => {
        if (faults.writes <= 0) return
        faults.writes--
        faults.failed++
        throw new StoreError({ reason: "failed", message: "injected: the disk is full" })
      }
      return {
        ...col,
        insert: (v: never, o?: never) => (fault(), col.insert(v, o)),
        update: (id: string, f: never, o?: never) => (fault(), col.update(id, f, o))
      }
    }) as StoreTx["collection"]
  })
  const forCore: HouseholdStore["forCore"] = (owner) => {
    const own = inner.forCore(owner)
    if (owner !== NOTIFY_OWNER) return own
    return { ...own, transaction: (f) => own.transaction((tx) => f(failing(tx))) } satisfies ModuleStore
  }
  return { store: { ...inner, forCore } satisfies HouseholdStore, faults }
}

/** The server's parts on `store`, in a scope of their own (closing it is a server stop). */
export const notifyWorld = (
  store: HouseholdStore,
  o: {
    readonly modules?: ReadonlyArray<string>
    readonly connected?: ReadonlyArray<string>
    /** The known devices (default `CONTRACT_DEVICES`). */
    readonly devices?: ReadonlyArray<KnownDevice>
    /** Where pages' messages go besides the record (the latency test encodes them, as the hub does). */
    readonly outlet?: (deviceId: string, message: NotifyMessage) => void
    /** Keep no record of messages and decisions (the latency test, at the bounds). */
    readonly unrecorded?: boolean
    readonly observe?: Parameters<typeof makeNotifyEngine>[0]["observe"]
    readonly speech?: Parameters<typeof makeNotifyEngine>[0]["speech"]
  } = {}
) =>
  Effect.gen(function*() {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const held = new Map<string, ModuleNotify>()
    const speakers = new Map<string, ModuleSpeech>()
    const presses: Array<ActionPress> = []
    const answer = { current: (p: ActionPress): Effect.Effect<ActionAnswer | void, unknown> => Effect.succeed({ say: `Did ${p.actionId}.` }) }
    const messages: Array<{ readonly deviceId: string; readonly message: NotifyMessage }> = []
    const decisions: Array<DecisionRecord> = []
    const devices = o.devices ?? CONTRACT_DEVICES
    const places = new Map(devices.map((d) => [d.id, { privacy: d.place.privacy, defaultPerson: d.place.defaultPerson }] as const))
    const connected = new Set(o.connected ?? devices.map((d) => d.id))
    const ids = o.modules ?? ["bell"]
    const made = yield* Scope.provide(scope)(Effect.gen(function*() {
      let hostRef: { readonly gateway: import("./Gateway.ts").ExecutionGateway } | undefined
      const scheduler = yield* makeSchedulerEngine({ store, issues: makeIssueRegistry(), retryBaseMs: SECOND, outcomeRetryMs: [100, 200], gateway: () => hostRef?.gateway })
      const notify = yield* makeNotifyEngine({
        store,
        scheduler,
        devices: () => devices,
        connected: (id) => connected.has(id),
        canSpeak: () => true,
        canShow: () => true,
        privacy: makePrivacy((id) => places.get(id), (id) => MEMBERS.has(id)),
        outlet: () => ({
          send: (deviceId, message) => {
            if (o.unrecorded !== true) messages.push({ deviceId, message })
            o.outlet?.(deviceId, message)
          }
        }),
        speech: o.speech ?? (() => undefined),
        ...(o.observe !== undefined ? { observe: o.observe } : {}),
        gateway: () => hostRef?.gateway,
        pageText: (_m, text, max) => String(text).slice(0, max),
        language: () => "en",
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
    const settle = Effect.andThen(made.scheduler.settled, made.notify.settled)
    const advance = (ms: number) => Effect.andThen(Effect.andThen(settle, TestClock.adjust(ms)), Effect.andThen(settle, settle))
    const bell = (id = ids[0]!) => held.get(id)!
    /** `send` as a tool on `deviceId` calls it (a turn there), then delivery has run. */
    const sendOn = (deviceId: string, request: Parameters<ModuleNotify["send"]>[0], module = ids[0]!) =>
      Effect.tap(bell(module).send(request).pipe(Effect.provideService(CurrentTurn, turnOn(deviceId))), () => settle)
    const rows = Effect.gen(function*() {
      const out: Array<Row<StoredNotification>> = []
      let after: Row<StoredNotification> | undefined
      for (;;) {
        const page = yield* store.forCore(NOTIFY_OWNER).collection(notifications).list({ orderBy: { field: "createdAt" }, limit: 12, ...(after !== undefined ? { after } : {}) })
        out.push(...page)
        if (page.length < 12) return out
        after = page[page.length - 1]
      }
    })
    const ringsOn = (deviceId: string) => messages.filter((m) => m.deviceId === deviceId && m.message.type === "notification.ring").map((m) => (m.message as Extract<NotifyMessage, { type: "notification.ring" }>).notification)
    const resolvedOn = (deviceId: string) => messages.filter((m) => m.deviceId === deviceId && m.message.type === "notification.resolved").map((m) => (m.message as Extract<NotifyMessage, { type: "notification.resolved" }>))
    return {
      ...made,
      held,
      speakers,
      presses,
      answer,
      messages,
      decisions,
      places,
      connected,
      settle,
      advance,
      bell,
      sendOn,
      rows,
      ringsOn,
      resolvedOn,
      connect: (deviceId: string) => Effect.suspend(() => (connected.add(deviceId), made.notify.connected(deviceId), settle)),
      stop: Scope.close(scope, Exit.void)
    }
  })

const reasonOf = (exit: Exit.Exit<unknown, unknown>): unknown => (Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { readonly reason?: unknown }).reason : "succeeded")

export const notifyContract = (name: string, open: OpenNotifyStore) =>
  describe(`notification service contract (${name})`, () => {
    const start = (o?: Parameters<typeof notifyWorld>[1]) =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const world = yield* notifyWorld(store, o)
        return { opened, store, world }
      })

    // ---- Sending and delivery

    it.effect("send stores it and delivers it to its origin device only, as a card with stop first", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const sent = yield* world.sendOn("kitchen-display", { title: "Bins out", text: "Paper tonight" })
        assert.strictEqual(sent.notification.state, "open")
        assert.isFalse(sent.deduped)
        const [card] = world.ringsOn("kitchen-display")
        assert.deepStrictEqual(card, {
          id: sent.notification.id,
          title: "Bins out",
          text: "Paper tonight",
          priority: "normal",
          silent: true,
          actions: [{ id: "stop", label: "Stop" }],
          sentAt: sent.notification.sentAt
        })
        assert.deepStrictEqual(world.ringsOn("robins-phone"), [])
        assert.deepStrictEqual(world.ringsOn("hall-screen"), [])
      }))

    it.effect("everywhere: every known device decides on its own; a ring is not silent where the device may make sound", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const sent = yield* world.sendOn("kitchen-display", { title: "Timer", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        assert.strictEqual(world.ringsOn("kitchen-display")[0]?.silent, false)
        assert.strictEqual(world.ringsOn("robins-phone")[0]?.silent, false)
        assert.deepStrictEqual(world.decisions.filter((d) => d.id === sent.notification.id).map((d) => [d.deviceId, d.decision]), [
          ["kitchen-display", { deliver: true, show: true, sound: true }],
          ["robins-phone", { deliver: true, show: true, sound: true }],
          ["hall-screen", { deliver: false, why: "offline" }]
        ])
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [sent.notification.id])
        assert.deepStrictEqual(world.ringsOn("kitchen-display")[0]?.actions.map((a) => a.id), ["stop", "snooze"])
      }))

    it.effect("personal content is delivered only where Privacy.mayReveal says yes for that device, asked when it is delivered", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const sent = yield* world.sendOn("kitchen-display", { title: "Dentist", owner: "p-sam", target: "everywhere" })
        // Shared and Sam's: yes; Robin's private phone: yes (private); the hall: offline now.
        assert.strictEqual(world.ringsOn("kitchen-display").length, 1)
        assert.strictEqual(world.ringsOn("robins-phone").length, 1)
        // The hall screen is made Sam's private screen before it connects: asked then, it gets the card.
        world.places.set("hall-screen", { privacy: "private", defaultPerson: "p-sam" })
        yield* world.connect("hall-screen")
        assert.strictEqual(world.ringsOn("hall-screen")[0]?.id, sent.notification.id)
        // The kitchen display becomes Robin's: a page that says hello there now is not told.
        world.places.set("kitchen-display", { privacy: "shared", defaultPerson: "p-robin" })
        const before = world.ringsOn("kitchen-display").length
        yield* world.connect("kitchen-display")
        assert.strictEqual(world.ringsOn("kitchen-display").length, before)
        assert.deepStrictEqual(world.decisions.at(-1)?.decision, { deliver: false, why: "private" })
      }))

    it.effect("a dedupe key: sending it again while one is live answers that one and delivers nothing new", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const first = yield* world.sendOn("kitchen-display", { title: "Door open", key: "door" })
        const again = yield* world.sendOn("kitchen-display", { title: "Door still open", key: "door" })
        assert.isTrue(again.deduped)
        assert.strictEqual(again.notification.id, first.notification.id)
        assert.strictEqual(again.notification.title, "Door open")
        assert.strictEqual(world.ringsOn("kitchen-display").length, 1)
        // Once it is resolved, the key sends a new one.
        assert.isTrue(yield* world.bell().resolve({ key: "door" }))
        const third = yield* world.sendOn("kitchen-display", { title: "Door open again", key: "door" })
        assert.isFalse(third.deduped)
        assert.notStrictEqual(third.notification.id, first.notification.id)
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
          { title: "Ok", priority: "high" as never },
          { title: "Ok", owner: "Sam!" },
          { title: "Ok", target: "kitchen" as never },
          { title: "Ok", key: "a key with spaces" },
          { title: "Ok", actions: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], handler: "answer" },
          { title: "Ok", actions: [{ id: "stop", label: "Stop" }], handler: "answer" },
          { title: "Ok", actions: [{ id: "snooze", label: "x".repeat(21) }], handler: "answer" },
          { title: "Ok", actions: [{ id: "Snooze", label: "Snooze" }], handler: "answer" },
          { title: "Ok", actions: [{ id: "snooze", label: "Snooze" }] },
          { title: "Ok", actions: [{ id: "snooze", label: "Snooze" }], handler: "nobody" },
          { title: "Ok", priority: "ring", expiresInMs: MAX_EXPIRY_MS.ring + 1 },
          { title: "Ok", expiresInMs: MAX_EXPIRY_MS.normal + 1 },
          { title: "Ok", expiresInMs: 999 },
          { title: "Ok", inMs: MAX_LATER_MS + 1 },
          { title: "Ok", inMs: 1, at: 5 }
        ]
        for (const r of cases) assert.strictEqual(yield* refused(r), "invalid", JSON.stringify(r))
        // `origin` needs a device: code outside a turn sends everywhere or is refused.
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().send({ title: "Ok" }))), "invalid")
        assert.strictEqual((yield* world.bell().send({ title: "Ok", target: "everywhere" })).notification.target, "everywhere")
        assert.strictEqual((yield* world.rows).length, 1)
      }))

    it.effect(`at most ${MAX_OPEN_PER_MODULE} live notifications per module: one more is refused limit; a resolved one frees its place`, () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const sent = []
        for (let i = 0; i < MAX_OPEN_PER_MODULE; i++) sent.push(yield* world.sendOn("kitchen-display", { title: `N${i}` }))
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "One more" }))), "limit")
        // Sent for later counts too: it is live.
        assert.isTrue(yield* world.bell().resolve(sent[0]!.notification.id))
        yield* world.sendOn("kitchen-display", { title: "Later", inMs: HOUR })
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "Still one more" }))), "limit")
      }))

    it.effect(`at most ${MAX_OPEN_TOTAL} live notifications in all, whichever module sends them`, () =>
      Effect.gen(function*() {
        const modules = Array.from({ length: Math.ceil(MAX_OPEN_TOTAL / MAX_OPEN_PER_MODULE) + 1 }, (_, i) => `bell${i}`)
        const { world } = yield* start({ modules })
        let n = 0
        for (const m of modules) {
          for (let i = 0; i < MAX_OPEN_PER_MODULE && n < MAX_OPEN_TOTAL; i++, n++) yield* world.bell(m).send({ title: `N${n}`, target: "everywhere" })
        }
        assert.strictEqual(n, MAX_OPEN_TOTAL)
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell(modules.at(-1)!).send({ title: "One more", target: "everywhere" }))), "limit")
      }))

    it.effect("the worst legal row fits maxChars, so a list reads at most its page", () =>
      Effect.gen(function*() {
        const { world, store } = yield* start()
        // Every free text at its bound with the costliest characters JSON has for it (a quote costs two).
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
        const resolved = { ...row!.value, outcome: "o".repeat(40), finishedAt: 8_640_000_000_000_000, resolvedBy: "d".repeat(64), deviceId: "d".repeat(64), module: "m".repeat(64), sentAt: 8_640_000_000_000_000, expiresAt: 8_640_000_000_000_000, dedupe: "x".repeat(130), liveModule: "m".repeat(64) }
        assert.isAtMost(JSON.stringify(resolved).length, NOTIFY_MAX_CHARS)
      }))

    // ---- Resolve, expiry, retention

    it.effect("resolve by id and by key takes the card down everywhere it was; another module's is not resolved", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ modules: ["bell", "other"] })
        const mine = yield* world.sendOn("kitchen-display", { title: "Mine", key: "k" })
        const theirs = yield* world.sendOn("kitchen-display", { title: "Theirs" }, "other")
        assert.isFalse(yield* world.bell("bell").resolve(theirs.notification.id))
        assert.isTrue(yield* world.bell("bell").resolve({ key: "k" }, "done"))
        assert.isFalse(yield* world.bell("bell").resolve(mine.notification.id))
        yield* world.settle
        assert.deepStrictEqual(world.resolvedOn("kitchen-display"), [{ type: "notification.resolved", id: mine.notification.id, outcome: "done" }])
        const row = (yield* world.rows).find((r) => r.id === mine.notification.id)
        assert.deepStrictEqual([row?.value.state, row?.value.outcome, row?.value.resolvedBy], ["resolved", "done", "module"])
        // The host's outcomes cannot be claimed.
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell("other").resolve(theirs.notification.id, "stop"))), "invalid")
        assert.deepStrictEqual((yield* world.bell("other").list()).map((n) => n.id), [theirs.notification.id])
      }))

    it.effect("expiry: a ring is resolved expired after 15 minutes when it says nothing, a normal one after a day", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        const plain = yield* world.sendOn("kitchen-display", { title: "Plain" })
        yield* world.advance(15 * MINUTE + SECOND)
        const states = new Map((yield* world.rows).map((r) => [r.id, r.value.outcome ?? r.value.state] as const))
        assert.strictEqual(states.get(ring.notification.id), "expired")
        assert.strictEqual(states.get(plain.notification.id), "open")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        assert.isTrue(world.resolvedOn("kitchen-display").some((m) => m.id === ring.notification.id && m.outcome === "expired"))
        yield* world.advance(24 * HOUR)
        assert.strictEqual((yield* world.rows).find((r) => r.id === plain.notification.id)?.value.outcome, "expired")
      }))

    it.effect("retention: a resolved notification is removed a day after it was resolved; live ones stay", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const done = yield* world.sendOn("kitchen-display", { title: "Done soon" })
        yield* world.sendOn("kitchen-display", { title: "Stays", expiresInMs: MAX_EXPIRY_MS.normal })
        yield* world.bell().resolve(done.notification.id)
        yield* world.advance(KEEP_RESOLVED_MS - MINUTE)
        assert.isDefined((yield* world.rows).find((r) => r.id === done.notification.id))
        yield* world.advance(15 * MINUTE)
        assert.deepStrictEqual((yield* world.rows).map((r) => r.value.title), ["Stays"])
      }))

    // ---- Later

    it.effect("sending later: it is scheduled and counted, delivered at its time, and expires counted from then", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const later = yield* world.sendOn("kitchen-display", { title: "Later", priority: "ring", inMs: 10 * MINUTE })
        assert.strictEqual(later.notification.state, "scheduled")
        assert.deepStrictEqual(world.ringsOn("kitchen-display"), [])
        assert.deepStrictEqual((yield* world.bell().list()).map((n) => n.state), ["scheduled"])
        yield* world.advance(10 * MINUTE)
        assert.strictEqual(world.ringsOn("kitchen-display")[0]?.id, later.notification.id)
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        yield* world.advance(14 * MINUTE)
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        yield* world.advance(2 * MINUTE)
        assert.strictEqual((yield* world.rows)[0]?.value.outcome, "expired")
      }))

    // ---- Do not disturb

    it.effect("do not disturb: a ring is delivered silent and nothing rings; clearing it rings again; an end time ends it by itself", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const now = yield* Clock.currentTimeMillis
        assert.deepStrictEqual(yield* world.bell().dnd.set({ until: now + HOUR }), { on: true, until: now + HOUR })
        const ring = yield* world.sendOn("kitchen-display", { title: "Quiet ring", priority: "ring" })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.silent, true)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        assert.deepStrictEqual((yield* world.bell().list()).map((n) => n.id), [ring.notification.id])
        yield* world.bell().dnd.clear
        yield* world.settle
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.silent, false)
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
        // Set with an end time: a job of the service turns it off then.
        yield* world.bell().dnd.set({ until: now + 5 * MINUTE })
        yield* world.settle
        assert.isTrue(world.notify.dnd().on)
        yield* world.advance(5 * MINUTE + SECOND)
        assert.deepStrictEqual(yield* world.bell().dnd.get, { on: false })
        assert.strictEqual(world.ringsOn("kitchen-display").at(-1)?.silent, false)
        // Bounds: not in the past, not more than a week ahead.
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().dnd.set({ until: now - 1 }))), "invalid")
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().dnd.set({ until: now + 2 * MAX_DND_MS }))), "invalid")
      }))

    // ---- Presses

    it.effect("stop is the host's: it resolves the notification and stops it on every device it rang on", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: ["kitchen-display", "robins-phone"] })
        const ring = yield* world.sendOn("kitchen-display", { title: "Both", priority: "ring", target: "everywhere" })
        const answer = yield* world.notify.press({ notificationId: ring.notification.id, actionId: "stop", deviceId: "robins-phone" })
        assert.deepStrictEqual(answer, { ok: true, say: "Done." })
        yield* world.settle
        for (const d of ["kitchen-display", "robins-phone"]) {
          assert.deepStrictEqual(world.resolvedOn(d), [{ type: "notification.resolved", id: ring.notification.id, outcome: "stop" }])
          assert.deepStrictEqual(world.notify.ringingOn(d), [])
        }
        assert.strictEqual((yield* world.rows)[0]?.value.resolvedBy, "robins-phone")
      }))

    it.effect("an action reaches the module's handler with the notification and the device; it resolves unless the handler keeps it open", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Timer", priority: "ring", key: "t1", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.succeed({ say: "Kept.", keepOpen: true })
        assert.deepStrictEqual(yield* world.notify.press({ notificationId: ring.notification.id, actionId: "snooze", deviceId: "kitchen-display" }), { ok: true, say: "Kept." })
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        world.answer.current = () => Effect.succeed({ say: "Snoozed." })
        yield* world.notify.press({ notificationId: ring.notification.id, actionId: "snooze", deviceId: "kitchen-display" })
        assert.deepStrictEqual(world.presses.at(-1), { notificationId: ring.notification.id, actionId: "snooze", key: "t1", deviceId: "kitchen-display" })
        assert.strictEqual((yield* world.rows)[0]?.value.outcome, "snooze")
        // A failing handler changes nothing.
        const two = yield* world.sendOn("kitchen-display", { title: "Two", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        world.answer.current = () => Effect.fail("broken")
        assert.deepStrictEqual(yield* world.notify.press({ notificationId: two.notification.id, actionId: "snooze", deviceId: "kitchen-display" }), { ok: false, say: "That didn't work.", code: "failed" })
        assert.strictEqual((yield* world.rows).find((r) => r.id === two.notification.id)?.value.state, "open")
        // An unknown action, a press on another device than its origin, a notification that has ended.
        assert.strictEqual((yield* world.notify.press({ notificationId: two.notification.id, actionId: "dance", deviceId: "kitchen-display" })).code, "unknown")
        assert.strictEqual((yield* world.notify.press({ notificationId: two.notification.id, actionId: "snooze", deviceId: "hall-screen" })).code, "unknown")
        assert.deepStrictEqual(yield* world.notify.press({ notificationId: ring.notification.id, actionId: "stop", deviceId: "kitchen-display" }), { ok: true, say: "That has ended already." })
      }))

    // ---- Restarts and reconnects

    it.effect("a server restart: a ring that was open rings again on the page that says hello; one sent for later is delivered at its time", () =>
      Effect.gen(function*() {
        const { opened, world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Open ring", priority: "ring", expiresInMs: HOUR, actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" })
        const later = yield* world.sendOn("kitchen-display", { title: "Later", inMs: 30 * MINUTE })
        yield* world.stop
        const store = yield* prepared(yield* opened.reopen)
        const again = yield* notifyWorld(store, { connected: [] })
        yield* again.connect("kitchen-display")
        assert.deepStrictEqual(again.ringsOn("kitchen-display").map((c) => [c.id, c.silent]), [[ring.notification.id, false]])
        assert.deepStrictEqual(again.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
        yield* again.advance(30 * MINUTE)
        assert.isTrue(again.ringsOn("kitchen-display").some((c) => c.id === later.notification.id))
        // The live counters survived the restart (recounted at start).
        assert.deepStrictEqual((yield* again.bell().list()).map((n) => n.id), [ring.notification.id, later.notification.id])
        // Do not disturb survives it too.
        yield* again.bell().dnd.set()
        yield* again.stop
        const third = yield* notifyWorld(yield* prepared(yield* opened.reopen))
        assert.isTrue(third.notify.dnd().on)
      }))

    it.effect("a device that disconnects and reconnects while it rings gets the ring again", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const ring = yield* world.sendOn("kitchen-display", { title: "Ringing", priority: "ring" })
        world.connected.delete("kitchen-display")
        world.notify.disconnected("kitchen-display")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
        yield* world.connect("kitchen-display")
        assert.deepStrictEqual(world.ringsOn("kitchen-display").map((c) => c.id), [ring.notification.id, ring.notification.id])
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
      }))

    // ---- Failure boundaries

    it.effect("a store failure at send: a typed failure, nothing stored, nothing delivered, nothing counted", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = notifyFaultyStore(yield* prepared(opened.store))
        const world = yield* notifyWorld(faulty.store)
        faulty.faults.writes = 1
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "Lost" }))), "failed")
        assert.deepStrictEqual(yield* world.rows, [])
        assert.deepStrictEqual(world.messages, [])
        for (let i = 0; i < MAX_OPEN_PER_MODULE; i++) yield* world.sendOn("kitchen-display", { title: `N${i}` })
        assert.strictEqual(reasonOf(yield* Effect.exit(world.sendOn("kitchen-display", { title: "One more" }))), "limit")
      }))

    it.effect("a store failure at resolve: it stays open and keeps ringing; the next try resolves it", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = notifyFaultyStore(yield* prepared(opened.store))
        const world = yield* notifyWorld(faulty.store)
        const ring = yield* world.sendOn("kitchen-display", { title: "Ring", priority: "ring" })
        faulty.faults.writes = 1
        assert.strictEqual(reasonOf(yield* Effect.exit(world.bell().resolve(ring.notification.id))), "failed")
        assert.strictEqual((yield* world.rows)[0]?.value.state, "open")
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
        assert.deepStrictEqual(world.resolvedOn("kitchen-display"), [])
        // A press of stop while the store fails: not resolved, still ringing; then it works.
        faulty.faults.writes = 1
        yield* world.notify.press({ notificationId: ring.notification.id, actionId: "stop", deviceId: "kitchen-display" })
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display").map((r) => r.id), [ring.notification.id])
        assert.isTrue(yield* world.bell().resolve(ring.notification.id))
        yield* world.settle
        assert.deepStrictEqual(world.notify.ringingOn("kitchen-display"), [])
      }))

    it.effect("a store failure between the decision and the delivery record: nothing is sent, and the delivery is tried again", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = notifyFaultyStore(yield* prepared(opened.store))
        const world = yield* notifyWorld(faulty.store)
        const later = yield* world.sendOn("kitchen-display", { title: "Later", priority: "ring", inMs: MINUTE })
        faulty.faults.writes = 1
        yield* world.advance(MINUTE)
        // Decided (the decision was made for the device), but its record failed: no card was sent.
        assert.isTrue(world.decisions.some((d) => d.id === later.notification.id))
        assert.strictEqual(faulty.faults.failed, 1)
        assert.deepStrictEqual(world.ringsOn("kitchen-display"), [])
        assert.strictEqual((yield* world.rows)[0]?.value.state, "scheduled")
        // The job runs again (back-off) and delivers it.
        yield* world.advance(5 * SECOND)
        yield* world.advance(5 * SECOND)
        assert.deepStrictEqual(world.ringsOn("kitchen-display").map((c) => c.id), [later.notification.id])
      }))
  })
