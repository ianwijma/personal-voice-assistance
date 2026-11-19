/**
 * The Presenter's contract tests (docs/PRESENTING.md): one case per promise of that page, run on the in-memory store
 * (`packages/core/test/present/PresentContract.test.ts`) and on SQLite in memory and on a file
 * (`packages/store-sqlite/test/presentContract.test.ts`), on the test clock. A case's title names the promise.
 *
 * The world of a case is the server's: the household store, the real Presenter and a real module host (its gateway and
 * page boundary too) with small modules whose shared parts keep their `ctx.present` and whose instances have a tool that
 * returns `{ forModel, present }`, over a fixed set of devices whose places (the privacy rule) and outputs a case may
 * change, each with the pages (tabs) a case opens. "A restart" closes all of it and makes it again on the same store.
 */
import { assert, describe, it } from "@effect/vitest"
import { type DevicePresentOutputs, MAX_PINNED_PER_DEVICE, PRESENT_KIND_VERSIONS, type PresentationWire } from "@pva/protocol"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { KnownDevice } from "./Devices.ts"
import { makeEventBus } from "./EventBus.ts"
import { type HouseholdStore, type Row, StoreError } from "./HouseholdStore.ts"
import { makeIssueRegistry } from "./Issues.ts"
import { isModuleStopped } from "./ModuleApi.ts"
import { defineModule, ModuleStartError } from "./ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "./ModuleHost.ts"
import { makeTool } from "./Module.ts"
import { contractDevice } from "./notifyContract.ts"
import {
  MAX_LIVE_PER_MODULE,
  MAX_LIVE_TOTAL,
  MAX_NOTE_CHARS,
  type ModulePresent,
  type Presentation,
  PRESENT_DEFAULT_EXPIRY_MS,
  PRESENT_MAX_CHARS,
  PRESENT_OWNER,
  PRESENT_PAGE,
  type PresentAnswer,
  presentations,
  type PresentPress,
  presentStorage,
  type PresentResult,
  type StoredPresentation
} from "./Present.ts"
import { IMAGE_SENTENCE, makePresentEngine, type MediaOutcome, type PresentDecisionRecord, type PresentMessage, SPOKEN_PREFIX } from "./PresentEngine.ts"
import { makePrivacy, type PrivacyPlace } from "./Privacy.ts"
import { makeSchedulerEngine } from "./SchedulerEngine.ts"
import { schedulerStorage } from "./SchedulerJobs.ts"
import { CurrentTurn, makeConnectionRef, type TurnContext } from "./TurnContext.ts"

/** A store for one case; `reopen` closes it and opens the same data again (in memory: the same store). */
export interface PresentContractStore {
  readonly store: HouseholdStore
  readonly reopen: Effect.Effect<HouseholdStore, unknown>
}
export type OpenPresentStore = () => Effect.Effect<PresentContractStore, unknown, Scope.Scope>

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** A shared kitchen display (Sam's), a second kitchen screen, Robin's private phone, a public hall screen, a speaker. */
export const PRESENT_DEVICES: ReadonlyArray<KnownDevice> = [
  contractDevice("kitchen-display", "Kitchen display", "Kitchen", "shared", "p-sam"),
  contractDevice("kitchen-tablet", "Kitchen tablet", "Kitchen", "shared", null),
  contractDevice("robins-phone", "Robin's phone", "Bedroom", "private", "p-robin"),
  contractDevice("hall-screen", "Hall screen", "Hall", "public", null),
  contractDevice("office-speaker", "Office speaker", "Office", "shared", null)
]
const MEMBERS = new Set(["p-sam", "p-robin", "p-alex"])
/** A page of this build on a touch screen: every kind. */
export const SCREEN: DevicePresentOutputs = { display: true, kinds: { ...PRESENT_KIND_VERSIONS }, touch: true }
const SPEAKER: DevicePresentOutputs = { display: false, kinds: {}, touch: false }

const turnOn = (deviceId: string): TurnContext => ({ turnId: 1, conversationId: "c1", source: "voice", assistantId: "jeff", deviceId })

/** A module whose shared part keeps its `ctx.present` and registers the press handler `answer`; its tool returns `result`. */
const boardModule = (
  id: string,
  held: Map<string, ModulePresent>,
  presses: Array<PresentPress>,
  answer: { current: (p: PresentPress) => Effect.Effect<PresentAnswer | void, unknown> },
  result: { current: unknown }
) =>
  defineModule({
    apiVersion: 2,
    id,
    name: `Board ${id}`,
    description: "Test",
    shared: (ctx) =>
      Effect.gen(function*() {
        held.set(id, ctx.present)
        yield* ctx.present.handle("answer", { run: (p) => Effect.suspend(() => (presses.push(p), answer.current(p))) }).pipe(Effect.mapError((e) => new ModuleStartError({ message: e.message })))
        return { value: undefined }
      }),
    start: () =>
      Effect.succeed({
        tools: [makeTool({ name: `${id.replace(/-/g, "_")}_show`, description: "Show", parameters: Schema.Struct({}), execute: () => Effect.sync(() => result.current) })]
      })
  })

/** The store with the service's collection prepared. */
export const presentPrepared = (store: HouseholdStore) => Effect.as(store.prepare([], [schedulerStorage, presentStorage]), store)
const prepared = presentPrepared

/** A store whose synchronous reads of `presentations` fail while `faults.reads` is above 0 (each failure counts it down). */
export const presentFaultyStore = (inner: HouseholdStore) => {
  const faults = { reads: 0, writes: 0, failed: 0 }
  /** A wait before the service's next transaction begins (as a busy store's retry wait is), taken by that transaction. */
  const gate: { wait: Deferred.Deferred<void> | undefined } = { wait: undefined }
  const fault = (k: "reads" | "writes") => {
    if (faults[k] <= 0) return
    faults[k]--
    faults.failed++
    throw new StoreError({ reason: "failed", message: `injected: ${k} fail` })
  }
  const reader: HouseholdStore["reader"] = (owner, c) => {
    const r = inner.reader(owner, c)
    if (r === undefined || owner !== PRESENT_OWNER || c.name !== presentations.name) return r
    return { ...r, get: (id, scope) => (fault("reads"), r.get(id, scope)), list: (q) => (fault("reads"), r.list(q)) }
  }
  const forCore: HouseholdStore["forCore"] = (owner) => {
    const own = inner.forCore(owner)
    if (owner !== PRESENT_OWNER) return own
    return {
      ...own,
      transaction: (f) =>
        Effect.suspend(() => {
          const run = own.transaction((tx) => {
            fault("writes")
            return f(tx)
          })
          const wait = gate.wait
          gate.wait = undefined
          return wait === undefined ? run : Effect.andThen(Deferred.await(wait), run)
        })
    }
  }
  return { store: { ...inner, reader, forCore } satisfies HouseholdStore, faults, gate }
}

/** One page (tab) of a device in the world. */
interface Tab {
  readonly id: string
  readonly deviceId: string
  readonly messages: Array<PresentMessage>
  /** The kinds this tab's own page declared (G11); absent: the device's outputs alone decide. */
  kinds?: Readonly<Record<string, number>> | undefined
  readonly declares: boolean
}

/** The server's parts on `store`, in a scope of their own (closing it is a server stop). */
export const presentWorld = (
  store: HouseholdStore,
  o: {
    readonly modules?: ReadonlyArray<string>
    /** The devices with one page open at the start (default every device). */
    readonly connected?: ReadonlyArray<string>
    readonly devices?: ReadonlyArray<KnownDevice>
    /** A device's outputs (default: the office speaker has no display; the rest are this build's touch screens). */
    readonly outputs?: Map<string, DevicePresentOutputs>
    /** The image cache (default: none). */
    readonly media?: (url: string) => Effect.Effect<MediaOutcome>
    /** Where pages' messages go besides the record (the latency test encodes them, as the hub does). */
    readonly outlet?: (deviceId: string, message: PresentMessage) => void
    /** Keep no record of messages and decisions (the latency test). */
    readonly unrecorded?: boolean
    readonly observe?: Parameters<typeof makePresentEngine>[0]["observe"]
  } = {}
) =>
  Effect.gen(function*() {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const held = new Map<string, ModulePresent>()
    const presses: Array<PresentPress> = []
    const answer = { current: (p: PresentPress): Effect.Effect<PresentAnswer | void, unknown> => Effect.succeed({ say: `Did ${p.action}.` }) }
    const result: { current: unknown } = { current: "nothing" }
    const decisions: Array<PresentDecisionRecord> = []
    const devices = o.devices ?? PRESENT_DEVICES
    const places = new Map<string, PrivacyPlace>(devices.map((d) => [d.id, { privacy: d.place.privacy, defaultPerson: d.place.defaultPerson }] as const))
    const outputs = o.outputs ?? new Map(devices.map((d) => [d.id, d.id === "office-speaker" ? SPEAKER : SCREEN] as const))
    const tabs = new Map<string, Tab>()
    let tabSeq = 0
    const issues = makeIssueRegistry()
    const ids = o.modules ?? ["board"]
    let hostRef: { readonly gateway: import("./Gateway.ts").ExecutionGateway; readonly pageText: (m: string, t: unknown, max: number) => string } | undefined
    const made = yield* Scope.provide(scope)(Effect.gen(function*() {
      const scheduler = yield* makeSchedulerEngine({ store, issues, retryBaseMs: SECOND, outcomeRetryMs: [100, 200], gateway: () => hostRef?.gateway })
      const present = yield* makePresentEngine({
        store,
        scheduler,
        writeRetryMs: [100, 200],
        devices: () => devices,
        outputs: (d) => outputs.get(d.id) ?? SCREEN,
        privacy: makePrivacy((id) => places.get(id), (id) => MEMBERS.has(id)),
        outlet: () => ({
          connections: (deviceId) =>
            [...tabs.values()].filter((t) => t.deviceId === deviceId).map((t) => ({
              id: t.id,
              send: (message: PresentMessage) => {
                if (o.unrecorded !== true) t.messages.push(message)
                o.outlet?.(deviceId, message)
              },
              ...(t.declares ? { kinds: () => t.kinds } : {})
            }))
        }),
        ...(o.media !== undefined ? { media: () => ({ fetch: o.media! }) } : {}),
        ...(o.observe !== undefined ? { observe: o.observe } : {}),
        gateway: () => hostRef?.gateway,
        pageText: (m, text, max) => hostRef?.pageText(m, text, max) ?? String(text).slice(0, max),
        language: () => "en",
        issues,
        onDecision: (r) => void (o.unrecorded !== true && decisions.push(r))
      })
      const host = yield* makeModuleHost({
        catalog: ids.map((id) => boardModule(id, held, presses, answer, result)),
        persistence: readOnlyPersistence({ modules: Object.fromEntries(ids.map((id) => [id, { enabled: true }])), secrets: {} }),
        env: {},
        household: { store, events: makeEventBus() },
        present,
        graceMs: 0
      })
      hostRef = host
      yield* host.startEnabled
      return { present, host, scheduler }
    }))
    const settle = Effect.gen(function*() {
      for (let i = 0; i < 3; i++) {
        yield* made.scheduler.settled
        yield* made.present.settled
      }
    })
    const advance = (ms: number) => Effect.andThen(Effect.andThen(settle, TestClock.adjust(ms)), settle)
    const board = (id = ids[0]!) => held.get(id)!
    /** `show` as a tool on `deviceId` calls it (a turn there), then reconciliation has run. */
    const showOn = (deviceId: string, presentation: Presentation, options?: Parameters<ModulePresent["show"]>[2], module = ids[0]!, target: Parameters<ModulePresent["show"]>[0] = "origin") =>
      Effect.tap(board(module).show(target, presentation, options).pipe(Effect.provideService(CurrentTurn, turnOn(deviceId))), () => settle)
    /** The module's tool, returning `value`, called as the model's tool loop calls it in a turn on `deviceId`. */
    const toolOn = (deviceId: string, value: PresentResult | unknown, module = ids[0]!) =>
      Effect.gen(function*() {
        result.current = value
        const out = yield* made.host.snapshot().registry.run({ id: "t1", name: `${module.replace(/-/g, "_")}_show`, input: {} }).pipe(Effect.provideService(CurrentTurn, turnOn(deviceId)))
        return out
      })
    const rows = Effect.gen(function*() {
      const out: Array<Row<StoredPresentation>> = []
      let after: Row<StoredPresentation> | undefined
      for (;;) {
        const page = yield* store.forCore(PRESENT_OWNER).collection(presentations).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: PRESENT_PAGE, ...(after !== undefined ? { after } : {}) })
        out.push(...page)
        if (page.length < PRESENT_PAGE) return out
        after = page[page.length - 1]
      }
    })
    /** Open a page of the device; `kinds`: what its own page declares (absent: the device's outputs decide). */
    const open = (deviceId: string, o2: { readonly kinds?: Readonly<Record<string, number>> | undefined } = {}) =>
      Effect.gen(function*() {
        const tab: Tab = { id: `tab-${++tabSeq}`, deviceId, messages: [], declares: "kinds" in o2, kinds: o2.kinds }
        tabs.set(tab.id, tab)
        made.present.reconcile(deviceId)
        yield* settle
        return tab
      })
    const close = (tab: Tab) =>
      Effect.suspend(() => {
        tabs.delete(tab.id)
        made.present.reconcile(tab.deviceId)
        return settle
      })
    for (const id of o.connected ?? devices.map((d) => d.id)) tabs.set(`tab-${++tabSeq}`, { id: `tab-${tabSeq}`, deviceId: id, messages: [], declares: false })
    // The pages that are open at the start say hello.
    made.present.reconcileAll()
    const tabsOf = (deviceId: string) => [...tabs.values()].filter((t) => t.deviceId === deviceId)
    const firstTab = (deviceId: string) => tabsOf(deviceId)[0]
    /** What a tab holds now, after every message it got: id → presentation. */
    const holds = (tab: Tab | undefined) => {
      const m = new Map<string, PresentationWire>()
      for (const msg of tab?.messages ?? []) {
        if (msg.type === "present.dismiss") m.delete(msg.id)
        else m.set(msg.presentation.id, msg.presentation)
      }
      return m
    }
    const shownOn = (deviceId: string) => [...holds(firstTab(deviceId)).values()]
    const pressOn = (deviceId: string, presentationId: string, action: string, extra: { item?: string; done?: boolean } = {}, tab = firstTab(deviceId)) =>
      Effect.tap(made.present.press({ presentationId, action, ...extra, deviceId, ...(tab !== undefined ? { connection: makeConnectionRef(tab.id) } : {}) }), () => settle)
    return {
      ...made,
      held,
      presses,
      answer,
      decisions,
      places,
      outputs,
      issues,
      tabs,
      settle,
      advance,
      board,
      showOn,
      toolOn,
      /** What the modules' tools return from now on (the latency test's turns call them through the registry). */
      toolResult: (value: unknown) => void (result.current = value),
      rows,
      open,
      close,
      tabsOf,
      firstTab,
      holds,
      shownOn,
      pressOn,
      stop: Scope.close(scope, Exit.void)
    }
  })

const reasonOf = (exit: Exit.Exit<unknown, unknown>): unknown => (Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { readonly reason?: unknown }).reason : "succeeded")

const card = (title = "Bins out", extra: Partial<Presentation> = {}): Presentation => ({ kind: "card", title, text: "Paper tonight", spoken: `${title}.`, ...extra } as Presentation)
const checklist = (handler = "answer"): Presentation => ({
  kind: "list",
  title: "Shopping",
  style: "checklist",
  items: [{ id: "milk", text: "Milk" }, { id: "eggs", text: "Eggs", done: true }],
  spoken: "Milk and eggs.",
  handler,
  buttons: [{ id: "clear", label: "Clear ticked" }]
})

/** The worst legal row: every text at its bound with the costliest characters (each `"` costs two in JSON). */
export const worstPresentationRow = (): StoredPresentation => {
  const t = (n: number) => "\"".repeat(n)
  return {
    module: "m".repeat(64),
    key: "k".repeat(64),
    part: Number.MAX_SAFE_INTEGER,
    lifetime: "transient",
    target: { room: t(80) },
    owner: "p".repeat(40),
    content: { kind: "list", title: t(60), style: "checklist", items: Array.from({ length: 12 }, (_, i) => ({ id: `${i}`.padEnd(40, "x"), text: t(80), done: false })) },
    showId: "s".repeat(64),
    spoken: t(300),
    buttons: Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`.padEnd(32, "x"), label: t(20) })),
    handler: "h".repeat(64),
    shownAt: 8_640_000_000_000_000,
    expiresAt: 8_640_000_000_000_000,
    ended: true
  }
}

export const presentContract = (name: string, open: OpenPresentStore) =>
  describe(`presentation contract (${name})`, () => {
    const start = (o?: Parameters<typeof presentWorld>[1]) =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const world = yield* presentWorld(store, o)
        yield* world.settle
        return { opened, store, world }
      })

    // ---- Showing

    it.effect("show puts it on the origin device's page now, its texts through the page boundary, with the host's words; the note says where", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", card())
        assert.deepStrictEqual(h.outcome, { devices: [{ deviceId: "kitchen-display", shown: true }], note: "Showing on \"Kitchen display\"." })
        const [p] = world.shownOn("kitchen-display")
        assert.strictEqual(p?.id, h.id)
        assert.deepStrictEqual(p?.content, { kind: "card", title: "Bins out", text: "Paper tonight", facts: [] })
        assert.strictEqual(p?.lifetime, "transient")
        assert.strictEqual(p?.texts.region, "On screen")
        assert.strictEqual(p?.v, 1)
        assert.deepStrictEqual(world.shownOn("hall-screen"), [])
        assert.strictEqual((yield* world.rows).length, 1)
      }))

    it.effect("a tool's { forModel, present }: the model gets forModel and the note; the page gets it once the writer ran", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const out = yield* world.toolOn("kitchen-display", { forModel: { items: 2 }, present: checklist() })
        assert.isFalse(out.isError)
        assert.strictEqual(out.content, "{\"items\":2}\n[Screen: Showing on \"Kitchen display\".]")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.content.kind), ["list"])
        const none = yield* world.toolOn("office-speaker", { forModel: "Two things.", present: checklist() })
        // G6: nothing shown on the asking device for a reason other than privacy: the note carries the spoken fallback.
        assert.strictEqual(none.content, "Two things.\n[Screen: Not showing it: \"Office speaker\" has no display. Say this instead: Milk and eggs.]")
        const plain = yield* world.toolOn("kitchen-display", { forModel: "x", other: 1 })
        assert.strictEqual(plain.content, "{\"forModel\":\"x\",\"other\":1}")
      }))

    it.effect("a tool's presentation that is not valid or passes a bound is not shown, and the note says why (never a silent drop)", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const bad = yield* world.toolOn("kitchen-display", { forModel: "x", present: { kind: "card", title: "", spoken: "s" } })
        assert.match(bad.content, /\[Screen: Not showing it: the presentation was not valid \(title must be text\)\.\]$/)
        for (let i = 0; i < MAX_LIVE_PER_MODULE; i++) yield* world.showOn("kitchen-display", card(`C${i}`), { lifetime: "pinned", expiresInMs: HOUR }, "board", { room: "Kitchen" }).pipe(Effect.ignore)
        const over = yield* world.toolOn("kitchen-display", { forModel: "x", present: card() })
        assert.match(over.content, /Not showing it: too much is on screen \(.*\)\. Say this instead: Bins out\.\]$/)
      }))

    it.effect("every bound of a presentation is refused invalid", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const refused = (p: unknown, options?: unknown) => Effect.map(Effect.exit(world.showOn("kitchen-display", p as Presentation, options as never)), reasonOf)
        const long = (n: number) => "x".repeat(n)
        const cases: ReadonlyArray<readonly [unknown, unknown?]> = [
          [{ kind: "card", title: long(61), spoken: "s" }],
          [{ kind: "card", title: "a\nb", spoken: "s" }],
          [{ kind: "card", title: "t", text: long(301), spoken: "s" }],
          [{ kind: "card", title: "t", facts: Array.from({ length: 7 }, () => ({ label: "l", value: "v" })), spoken: "s" }],
          [{ kind: "card", title: "t", facts: [{ label: long(31), value: "v" }], spoken: "s" }],
          [{ kind: "card", title: "t", spoken: "" }],
          [{ kind: "card", title: "t", spoken: long(301) }],
          [{ kind: "card", title: "t", spoken: "s", extra: 1 }],
          [{ kind: "table", title: "t", spoken: "s" }],
          [{ kind: "list", title: "t", items: Array.from({ length: 13 }, (_, i) => ({ id: `i${i}`, text: "x" })), spoken: "s" }],
          [{ kind: "list", title: "t", items: [{ id: "a", text: long(81) }], spoken: "s" }],
          [{ kind: "list", title: "t", items: [{ id: "a", text: "x" }, { id: "a", text: "y" }], spoken: "s" }],
          [{ kind: "timer", label: "t", endsAt: Date.UTC(2030, 0, 1), spoken: "s" }],
          [{ kind: "image", url: "http://example.org/a.png", alt: "a", credit: "c", spoken: "s" }],
          [{ kind: "image", url: "https://example.org/a.png", alt: "a", credit: "", spoken: "s" }],
          [{ kind: "weather", place: "Utrecht", now: { temperature: "12°", condition: "Rain", icon: "volcano" }, spoken: "s" }],
          [{ kind: "card", title: "t", spoken: "s", buttons: [{ id: "a", label: "A" }] }],
          [{ kind: "card", title: "t", spoken: "s", handler: "answer", buttons: Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, label: "B" })) }],
          [{ kind: "card", title: "t", spoken: "s", handler: "answer", buttons: [{ id: "tick", label: "T" }] }],
          [{ kind: "card", title: "t", spoken: "s", handler: "nobody" }],
          [{ kind: "card", title: "t", spoken: "s", sensitivity: { personal: "Not An Id" } }],
          [{ kind: "card", title: "t", spoken: "s" }, { expiresInMs: 6 * MINUTE }],
          [{ kind: "card", title: "t", spoken: "s" }, { lifetime: "pinned", expiresInMs: 25 * HOUR }],
          [{ kind: "card", title: "t", spoken: "s" }, { expiresInMs: 2_999 }],
          [{ kind: "card", title: "t", spoken: "s" }, { key: "no spaces" }]
        ]
        for (const [p, options] of cases) assert.strictEqual(yield* refused(p, options), "invalid", JSON.stringify(p))
        // A target the server cannot show on.
        const target = (t: unknown) => Effect.map(Effect.exit(world.board().show(t as never, card())), reasonOf)
        assert.strictEqual(yield* target("origin"), "invalid")
        assert.strictEqual(yield* target({ device: "nowhere-at-all" }), "invalid")
        assert.strictEqual(yield* target({ room: "Attic" }), "invalid")
        assert.deepStrictEqual(yield* world.rows, [])
      }))

    it.effect("the live bounds: per module, in all, and pinned per device, each refused limit", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ modules: ["b1", "b2", "b3", "b4", "b5"] })
        const pinned = { lifetime: "pinned" as const, expiresInMs: HOUR }
        for (let i = 0; i < MAX_PINNED_PER_DEVICE; i++) yield* world.showOn("kitchen-display", card(`P${i}`), pinned, i < 4 ? "b1" : "b2")
        assert.strictEqual(reasonOf(yield* Effect.exit(world.showOn("kitchen-display", card("P9"), pinned, "b3"))), "limit")
        // Per module: b1 has 4; four more on other devices make 8.
        for (let i = 0; i < 4; i++) yield* world.showOn("robins-phone", card(`R${i}`), pinned, "b1")
        assert.strictEqual(reasonOf(yield* Effect.exit(world.showOn("hall-screen", card("one more"), pinned, "b1"))), "limit")
        // In all: 16 so far; b2 to b5 fill it to the total bound.
        let n = 16
        for (const m of ["b2", "b3", "b4", "b5"]) {
          for (let i = 0; n < MAX_LIVE_TOTAL && (yield* world.rows).filter((r) => r.value.module === m).length < MAX_LIVE_PER_MODULE; i++) {
            const where = ["robins-phone", "hall-screen", "kitchen-tablet"][i % 3]!
            yield* world.showOn(where, card(`${m}-${i}`), { lifetime: "pinned", expiresInMs: HOUR }, m, { device: where }).pipe(Effect.ignore)
            n = (yield* world.rows).length
          }
        }
        assert.strictEqual((yield* world.rows).length, MAX_LIVE_TOTAL)
        assert.strictEqual(reasonOf(yield* Effect.exit(world.showOn("robins-phone", card("too many"), {}, "b5"))), "limit")
      }))

    it.effect("the worst legal row fits the collection's maxChars, so one read lists PRESENT_PAGE rows", () =>
      Effect.gen(function*() {
        const { store } = yield* start()
        const row = worstPresentationRow()
        assert.isTrue(JSON.stringify(row).length <= PRESENT_MAX_CHARS, `${JSON.stringify(row).length}`)
        yield* store.forCore(PRESENT_OWNER).transaction((t) => void t.collection(presentations).insert(row, { id: "worst" }))
        assert.strictEqual(PRESENT_PAGE, 5)
      }))

    // ---- Lifetimes

    it.effect("a device shows one transient at a time: a newer one ends the one it would share a device with", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const first = yield* world.showOn("kitchen-display", card("First"))
        const second = yield* world.showOn("kitchen-display", card("Second"), undefined, "board", { room: "Kitchen" })
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.id), [second.id])
        assert.deepStrictEqual(world.shownOn("kitchen-tablet").map((p) => p.id), [second.id])
        assert.isTrue(world.firstTab("kitchen-display")!.messages.some((m) => m.type === "present.dismiss" && m.id === first.id))
        // The first is marked ended in the same transaction (an update) and removed ten seconds later, off the caller's path.
        assert.deepStrictEqual(new Map((yield* world.rows).map((r) => [r.id, r.value.ended === true])), new Map([[first.id, true], [second.id, false]]))
        yield* world.advance(10 * SECOND)
        assert.deepStrictEqual((yield* world.rows).map((r) => r.id), [second.id])
      }))

    it.effect("a dismissed presentation is marked ended at once (never shown again, its handle answers false) and its row removed ten seconds later; a restart removes it too", () =>
      Effect.gen(function*() {
        const { world, opened } = yield* start()
        const h = yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" })
        assert.isTrue(yield* h.dismiss)
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        assert.deepStrictEqual((yield* world.rows).map((r) => r.value.ended), [true])
        assert.isFalse(yield* h.dismiss)
        // A restart before the removal: the ended row is not shown and is removed.
        yield* world.stop
        const store = yield* prepared(yield* opened.reopen)
        const next = yield* presentWorld(store)
        yield* next.settle
        assert.deepStrictEqual(next.shownOn("kitchen-display"), [])
        assert.deepStrictEqual(yield* next.rows, [])
      }))

    it.effect("a transient one ends on time (30 s by default): taken down from every page and removed", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", card())
        yield* world.advance(PRESENT_DEFAULT_EXPIRY_MS.transient - SECOND)
        assert.strictEqual(world.shownOn("kitchen-display").length, 1)
        yield* world.advance(SECOND)
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        assert.deepStrictEqual(yield* world.rows, [])
        assert.isFalse(yield* h.dismiss)
      }))

    it.effect("pinned ones stay side by side with a transient one, come back to a page that reconnects, and survive a restart; transient ones do not", () =>
      Effect.gen(function*() {
        const { world, opened } = yield* start()
        const a = yield* world.showOn("kitchen-display", card("A"), { lifetime: "pinned" })
        const t = yield* world.showOn("kitchen-display", card("T"))
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.lifetime), ["pinned", "transient"])
        // A page that goes and comes back gets its pinned ones again (and the live transient).
        yield* world.close(world.firstTab("kitchen-display")!)
        const again = yield* world.open("kitchen-display")
        assert.deepStrictEqual([...world.holds(again).keys()].sort(), [a.id, t.id].sort())
        // A restart: the pinned one is read back, the transient one is gone.
        yield* world.stop
        const store = yield* prepared(yield* opened.reopen)
        const next = yield* presentWorld(store)
        yield* next.settle
        assert.deepStrictEqual(next.shownOn("kitchen-display").map((p) => p.id), [a.id])
        assert.deepStrictEqual((yield* next.rows).map((r) => r.id), [a.id])
      }))

    it.effect("update and dismiss through the handle reach every page that holds it; after its end the handle answers undefined and false", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const second = yield* world.open("kitchen-display")
        const h = yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        const updated = yield* h.update({ ...checklist(), items: [{ id: "milk", text: "Milk", done: true }] } as Presentation)
        yield* world.settle
        assert.deepStrictEqual(updated?.devices, [{ deviceId: "kitchen-display", shown: true }])
        for (const tab of world.tabsOf("kitchen-display")) {
          assert.isTrue(tab.messages.some((m) => m.type === "present.update"))
          assert.deepStrictEqual((world.holds(tab).get(h.id)?.content as { items: unknown }).items, [{ id: "milk", text: "Milk", done: true }])
        }
        assert.strictEqual(reasonOf(yield* Effect.exit(h.update(card()))), "invalid")
        assert.isTrue(yield* h.dismiss)
        yield* world.settle
        assert.strictEqual(world.holds(second).size, 0)
        assert.strictEqual(world.holds(world.firstTab("kitchen-display")).size, 0)
        assert.isFalse(yield* h.dismiss)
        assert.isUndefined(yield* h.update(checklist()))
      }))

    it.effect("showing a key again replaces it in place (the same id, present.update)", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const a = yield* world.showOn("kitchen-display", card("Old"), { key: "k", lifetime: "pinned" })
        const b = yield* world.showOn("kitchen-display", card("New"), { key: "k", lifetime: "pinned" })
        assert.strictEqual(a.id, b.id)
        const tab = world.firstTab("kitchen-display")!
        assert.deepStrictEqual(tab.messages.map((m) => m.type), ["present.show", "present.update"])
        assert.strictEqual((yield* world.rows).length, 1)
      }))

    it.effect("a part that stops withdraws its transient presentations; its pinned ones stay; its handle dies with ModuleStopped", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const pinned = yield* world.showOn("kitchen-display", card("Pinned"), { lifetime: "pinned" })
        const transient = yield* world.showOn("robins-phone", card("Transient"))
        yield* world.host.disable("board")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("robins-phone"), [])
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.id), [pinned.id])
        // Its row is removed by maintenance, ten seconds later.
        yield* world.advance(10 * SECOND)
        assert.deepStrictEqual((yield* world.rows).map((r) => r.id), [pinned.id])
        const exit = yield* Effect.exit(transient.dismiss)
        assert.isTrue(Exit.isFailure(exit) && isModuleStopped(Cause.squash(exit.cause)))
        // Started again, it replaces its pinned one by its key, or shows anew.
        yield* world.host.enable("board")
        yield* world.settle
        yield* world.showOn("kitchen-display", card("Again"))
        assert.strictEqual(world.shownOn("kitchen-display").length, 2)
      }))

    // ---- The decision, asked at the moment of showing

    it.effect("personal content: shown where the privacy rule allows, not elsewhere; a change of privacy while shown withdraws it", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const robin = { sensitivity: { personal: "p-robin" } } as Partial<Presentation>
        const onPhone = yield* world.showOn("robins-phone", card("Dentist", robin))
        assert.deepStrictEqual(onPhone.outcome.devices, [{ deviceId: "robins-phone", shown: true }])
        const onHall = yield* world.showOn("hall-screen", card("Dentist", robin))
        assert.deepStrictEqual(onHall.outcome.devices, [{ deviceId: "hall-screen", shown: false, why: "private" }])
        // After a privacy refusal the note carries nothing of the content (G6).
        assert.strictEqual(onHall.outcome.note, "Not showing it: \"Hall screen\" may not show this person's things.")
        assert.deepStrictEqual(world.shownOn("hall-screen"), [])
        // The phone becomes shared with someone else as its default person: withdrawn from the page, not just not sent again.
        world.places.set("robins-phone", { privacy: "shared", defaultPerson: "p-sam" })
        world.present.reconcileAll()
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("robins-phone"), [])
        assert.isTrue(world.firstTab("robins-phone")!.messages.some((m) => m.type === "present.dismiss" && m.id === onPhone.id))
      }))

    it.effect("a declaration that takes the display away withdraws what was shown; a kind a page does not draw is not sent", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" })
        world.outputs.set("kitchen-display", { display: false, kinds: {}, touch: false })
        world.present.reconcile("kitchen-display")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        world.outputs.set("kitchen-display", { display: true, kinds: { card: 1 }, touch: true })
        world.present.reconcile("kitchen-display")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.id), [h.id])
        const list = yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        assert.deepStrictEqual(list.outcome.devices, [{ deviceId: "kitchen-display", shown: false, why: "cannot-show-kind" }])
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.id), [h.id])
      }))

    // ---- Reconciliation

    it.effect("two tabs of a device both hold it; a room target reaches every device of the room, each with its own decision", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const second = yield* world.open("kitchen-display")
        const h = yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" }, "board", { room: "kitchen" })
        assert.deepStrictEqual(h.outcome.devices.map((d) => d.deviceId).sort(), ["kitchen-display", "kitchen-tablet"])
        assert.deepStrictEqual([...world.holds(second).keys()], [h.id])
        assert.deepStrictEqual(world.shownOn("kitchen-tablet").map((p) => p.id), [h.id])
        assert.deepStrictEqual(world.shownOn("robins-phone"), [])
      }))

    it.effect("a pass that fails is repeated: by the next trigger, or a minute later", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = presentFaultyStore(yield* prepared(opened.store))
        const world = yield* presentWorld(faulty.store)
        yield* world.settle
        faulty.faults.reads = 1
        const h = yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" })
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        yield* world.advance(MINUTE)
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.id), [h.id])
        assert.isAtLeast(faulty.faults.failed, 1)
      }))

    it.effect("a transient that ended while a page was away is gone when it comes back", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        yield* world.showOn("kitchen-display", card())
        yield* world.close(world.firstTab("kitchen-display")!)
        yield* world.advance(PRESENT_DEFAULT_EXPIRY_MS.transient)
        const back = yield* world.open("kitchen-display")
        assert.strictEqual(world.holds(back).size, 0)
      }))

    // ---- Presses

    it.effect("a tick and a button from a page that holds it reach the module's handler as the press; the answer is shown", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        assert.isTrue(world.shownOn("kitchen-display")[0]!.interactive)
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "tick", { item: "milk", done: true }), { ok: true, say: "Did tick." })
        assert.deepStrictEqual(world.presses.at(-1), { presentationId: h.id, deviceId: "kitchen-display", action: "tick", item: "milk", done: true })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "clear"), { ok: true, say: "Did clear." })
        world.answer.current = () => Effect.void
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "clear"), { ok: true, say: "Done." })
        world.answer.current = () => Effect.fail("nope")
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "clear"), { ok: false, say: "That didn't work.", code: "failed" })
      }))

    it.effect("a press from a page that does not hold it, of an item or button it does not have, or where it may not be pressed, is refused", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        const before = world.presses.length
        assert.deepStrictEqual(yield* world.pressOn("hall-screen", h.id, "clear"), { ok: false, say: "I can't do that right now.", code: "unknown" })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "tick", { item: "bread", done: true }), { ok: false, say: "I can't do that right now.", code: "unknown" })
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "other"), { ok: false, say: "I can't do that right now.", code: "unknown" })
        // A page without touch is sent it without its controls, and a press from it is refused.
        world.outputs.set("kitchen-display", { ...SCREEN, touch: false })
        world.present.reconcile("kitchen-display")
        yield* world.settle
        assert.isFalse(world.shownOn("kitchen-display")[0]!.interactive)
        assert.strictEqual((yield* world.pressOn("kitchen-display", h.id, "clear")).code, "unknown")
        assert.strictEqual(world.presses.length, before)
      }))

    it.effect("two presses at once run the handler once; the second is told it is being handled", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        const gate = yield* Deferred.make<void>()
        world.answer.current = () => Effect.as(Deferred.await(gate), { say: "ok" })
        const first = yield* Effect.forkChild(world.pressOn("kitchen-display", h.id, "clear"))
        yield* Effect.yieldNow
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "clear"), { ok: false, say: "That is being handled already.", code: "busy" })
        yield* Deferred.succeed(gate, undefined)
        assert.deepStrictEqual(yield* Fiber.join(first), { ok: true, say: "ok" })
        assert.strictEqual(world.presses.length, 1)
      }))

    it.effect("a press while the module is down answers \"I can't do that right now\" and changes nothing", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const h = yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        yield* world.host.disable("board")
        yield* world.settle
        assert.deepStrictEqual(yield* world.pressOn("kitchen-display", h.id, "clear"), { ok: false, say: "I can't do that right now.", code: "not_running" })
        assert.strictEqual(world.presses.length, 0)
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.id), [h.id])
      }))

    // ---- Images

    it.effect("an image is fetched once some page is to show it, off the turn's path: loading, then this page's own address; a refusal shows it without the image", () =>
      Effect.gen(function*() {
        const fetched: Array<string> = []
        const hash = "a".repeat(64)
        const { world } = yield* start({ media: (url) => Effect.sync(() => (fetched.push(url), url.endsWith("/no.png") ? { refused: "type" as const } : { hash })) })
        const image = (url: string): Presentation => ({ kind: "image", url, alt: "A heron", credit: "Wikimedia Commons, CC BY-SA", spoken: "A heron." })
        const second = yield* world.open("kitchen-display")
        const h = yield* world.showOn("kitchen-display", image("https://example.org/heron.png"), { lifetime: "pinned", key: "pic" })
        assert.strictEqual(h.outcome.note, "Showing on \"Kitchen display\". Its image is being fetched; if that fails it shows without it.")
        const tab = world.firstTab("kitchen-display")!
        const shows = tab.messages.filter((m) => m.type !== "present.dismiss").map((m) => (m.presentation.content as { image: { state: string; token?: string } }).image)
        assert.deepStrictEqual(shows.map((x) => x.state), ["loading", "ready"])
        // G9: each page is given an address of its own, never the hash; each serves only for its own connection.
        const mine = shows[1]!.token!
        const theirs = (world.holds(second).get(h.id)!.content as { image: { token?: string } }).image.token!
        assert.match(mine, /^[A-Za-z0-9_-]{32}$/)
        assert.notStrictEqual(mine, theirs)
        assert.isFalse(JSON.stringify(tab.messages).includes(hash))
        assert.strictEqual(world.present.mediaFor(mine), hash)
        assert.strictEqual(world.present.mediaFor(theirs), hash)
        assert.isUndefined(world.present.mediaFor("b".repeat(32)))
        // A page that goes: its address stops working at once.
        yield* world.close(second)
        assert.isUndefined(world.present.mediaFor(theirs))
        // The same key and address again keeps what was fetched; the earlier handle no longer acts on it (another show).
        const again = yield* world.showOn("kitchen-display", image("https://example.org/heron.png"), { lifetime: "pinned", key: "pic" })
        assert.deepStrictEqual(fetched, ["https://example.org/heron.png"])
        assert.isFalse(yield* h.dismiss)
        yield* world.showOn("robins-phone", image("https://example.org/no.png"))
        assert.deepStrictEqual((world.shownOn("robins-phone")[0]?.content as { image: unknown }).image, { state: "failed" })
        assert.isTrue(yield* again.dismiss)
        yield* world.settle
        assert.isUndefined(world.present.mediaFor(mine))
      }))

    // ---- Review round 1: eligibility at once, removal following; reconciliation that withdraws first; writes derived
    // inside their transaction; the whole collection at start; accepted work done or reported

    const faultyStart = () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = presentFaultyStore(yield* prepared(opened.store))
        const world = yield* presentWorld(faulty.store, { media: () => Effect.succeed({ hash: "c".repeat(64) }) })
        yield* world.settle
        return { opened, faulty, world }
      })

    it.effect("a1: personal content no longer allowed is withdrawn even when the read of another item fails in that pass", () =>
      Effect.gen(function*() {
        const { faulty, world } = yield* faultyStart()
        const mine = yield* world.showOn("robins-phone", card("Dentist", { sensitivity: { personal: "p-robin" } } as Partial<Presentation>), { lifetime: "pinned" })
        const other = yield* world.showOn("robins-phone", card("Bins"), { lifetime: "pinned" })
        // The household card is changed (its content must be read again) while permission for the personal one is revoked.
        yield* other.update(card("Bins, changed"))
        world.places.set("robins-phone", { privacy: "shared", defaultPerson: "p-sam" })
        faulty.faults.reads = 5
        world.present.reconcile("robins-phone")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("robins-phone").map((p) => p.id), [other.id])
        assert.isTrue(world.firstTab("robins-phone")!.messages.some((m) => m.type === "present.dismiss" && m.id === mine.id))
      }))

    it.effect("a2: an update that waited on a busy store does not overwrite the replacement shown meanwhile under the same key", () =>
      Effect.gen(function*() {
        const { faulty, world } = yield* faultyStart()
        const h = yield* world.showOn("kitchen-display", card("Old"), { lifetime: "pinned", key: "same" })
        const wait = yield* Deferred.make<void>()
        faulty.gate.wait = wait
        const updating = yield* Effect.forkChild(h.update(card("Old update")).pipe(Effect.provideService(CurrentTurn, turnOn("kitchen-display"))))
        yield* Effect.yieldNow
        // Meanwhile the module shows the same key as a list on another device.
        const replaced = yield* world.showOn("robins-phone", checklist(), { lifetime: "pinned", key: "same" })
        yield* Deferred.succeed(wait, undefined)
        assert.isUndefined(yield* Fiber.join(updating))
        yield* world.settle
        assert.strictEqual(replaced.id, h.id)
        const [row] = yield* world.rows
        assert.strictEqual(row?.value.content.kind, "list")
        assert.deepStrictEqual(row?.value.target, { device: "robins-phone" })
        assert.deepStrictEqual(world.present.live().map((v) => [v.kind, v.target]), [["list", { device: "robins-phone" }]])
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        assert.strictEqual(world.shownOn("robins-phone")[0]?.content.kind, "list")
      }))

    it.effect("a3: start-up reads the whole collection: a live pinned row behind many ended rows is shown after a restart", () =>
      Effect.gen(function*() {
        const { world, opened } = yield* start()
        for (let i = 0; i < 145; i++) {
          yield* world.showOn("kitchen-display", card(`T${i}`))
          yield* TestClock.adjust(1)
        }
        const pinned = yield* world.showOn("kitchen-display", card("Pinned"), { lifetime: "pinned" })
        assert.isAbove((yield* world.rows).length, 130)
        yield* world.stop
        const store = yield* prepared(yield* opened.reopen)
        const next = yield* presentWorld(store)
        yield* next.settle
        assert.isTrue(next.present.loaded())
        assert.deepStrictEqual(next.shownOn("kitchen-display").map((p) => p.id), [pinned.id])
        assert.deepStrictEqual((yield* next.rows).map((r) => r.id), [pinned.id])
      }))

    it.effect("a4: two accepted results for a new key share one stable id: one presentation, the later content", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const first = { forModel: "1", present: card("First"), show: { lifetime: "pinned" as const, key: "same" } }
        const second = { forModel: "2", present: card("Second"), show: { lifetime: "pinned" as const, key: "same" } }
        yield* world.toolOn("kitchen-display", first)
        yield* world.toolOn("kitchen-display", second)
        yield* world.settle
        assert.strictEqual((yield* world.rows).length, 1)
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => (p.content as { title: string }).title), ["Second"])
      }))

    it.effect("a5: a stopped part's transient and an ended one leave the pages at once although the store refuses their removal; removal follows when it can", () =>
      Effect.gen(function*() {
        const { faulty, world } = yield* faultyStart()
        yield* world.showOn("robins-phone", card("Stops"), { expiresInMs: 5 * MINUTE })
        yield* world.showOn("hall-screen", card("Ends"), { expiresInMs: 3 * SECOND })
        faulty.faults.writes = 100
        yield* world.advance(3 * SECOND)
        assert.deepStrictEqual(world.shownOn("hall-screen"), [])
        yield* world.host.disable("board")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("robins-phone"), [])
        assert.strictEqual((yield* world.rows).length, 2)
        faulty.faults.writes = 0
        yield* world.advance(MINUTE)
        assert.deepStrictEqual(yield* world.rows, [])
      }))

    it.effect("a6: an accepted result whose write fails is written again until it can be, and then shown (the note said \"Showing on\")", () =>
      Effect.gen(function*() {
        const { faulty, world } = yield* faultyStart()
        faulty.faults.writes = 10
        const out = yield* world.toolOn("kitchen-display", { forModel: "Result", present: card(), show: { lifetime: "pinned" } })
        assert.strictEqual(out.content, "Result\n[Screen: Showing on \"Kitchen display\".]")
        yield* world.advance(5 * SECOND)
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        assert.isTrue(world.issues.all().some((i) => i.id === "core.present.write"))
        faulty.faults.writes = 0
        yield* world.advance(MINUTE)
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => (p.content as { title: string }).title), ["Bins out"])
        assert.isFalse(world.issues.all().some((i) => i.id === "core.present.write"))
      }))

    it.effect("a6: an accepted transient that could not be written before its end is dropped, not shown late", () =>
      Effect.gen(function*() {
        const { faulty, world } = yield* faultyStart()
        faulty.faults.writes = 1_000
        yield* world.toolOn("kitchen-display", { forModel: "x", present: card(), show: { expiresInMs: 3 * SECOND } })
        yield* world.advance(MINUTE)
        faulty.faults.writes = 0
        yield* world.advance(MINUTE)
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        assert.deepStrictEqual(yield* world.rows, [])
      }))

    it.effect("a7: an image whose outcome could not be written is written again", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = presentFaultyStore(yield* prepared(opened.store))
        let fetches = 0
        const gate = yield* Deferred.make<void>()
        const world = yield* presentWorld(faulty.store, { media: () => Effect.as(Effect.andThen(Effect.sync(() => fetches++), Deferred.await(gate)), { hash: "d".repeat(64) }) })
        yield* world.settle
        const image: Presentation = { kind: "image", url: "https://example.org/a.png", alt: "A", credit: "C", spoken: "A." }
        const h = yield* world.showOn("kitchen-display", image, { lifetime: "pinned" })
        assert.strictEqual(fetches, 1)
        // The fetch completes while the store refuses the outcome's write.
        faulty.faults.writes = 1
        yield* Deferred.succeed(gate, undefined)
        yield* world.settle
        assert.strictEqual((world.shownOn("kitchen-display")[0]!.content as { image: { state: string } }).image.state, "loading")
        yield* world.advance(MINUTE)
        assert.strictEqual((world.shownOn("kitchen-display")[0]!.content as { image: { state: string } }).image.state, "ready")
        assert.strictEqual(fetches, 1)
        void h
      }))

    it.effect("a7: an image row left loading by a restart is fetched again and resolved", () =>
      Effect.gen(function*() {
        const { world, opened } = yield* start({ media: () => Effect.never })
        yield* world.showOn("kitchen-display", { kind: "image", url: "https://example.org/a.png", alt: "A", credit: "C", spoken: "A." }, { lifetime: "pinned" })
        yield* world.stop
        const store = yield* prepared(yield* opened.reopen)
        let fetches = 0
        const next = yield* presentWorld(store, { media: () => Effect.sync(() => (fetches++, { refused: "fetch" as const })) })
        yield* next.settle
        assert.strictEqual(fetches, 1)
        assert.deepStrictEqual((next.shownOn("kitchen-display")[0]!.content as { image: unknown }).image, { state: "failed" })
      }))

    it.effect("an image is not fetched while no device of its target would show it; it is when one does", () =>
      Effect.gen(function*() {
        let fetches = 0
        const { world } = yield* start({ connected: ["kitchen-display"], media: () => Effect.sync(() => (fetches++, { hash: "f".repeat(64) })) })
        const image: Presentation = { kind: "image", url: "https://example.org/a.png", alt: "A", credit: "C", spoken: "A." }
        const offline = yield* world.showOn("hall-screen", image, { lifetime: "pinned" }, "board", { device: "hall-screen" })
        assert.deepStrictEqual(offline.outcome.devices, [{ deviceId: "hall-screen", shown: false, why: "offline" }])
        yield* world.showOn("office-speaker", image, { lifetime: "pinned" }, "board", { device: "office-speaker" })
        yield* world.settle
        assert.strictEqual(fetches, 0)
        yield* world.open("hall-screen")
        assert.strictEqual(fetches, 1)
        assert.strictEqual((world.shownOn("hall-screen")[0]!.content as { image: { state: string } }).image.state, "ready")
      }))

    it.effect("a10: queued transients for one device that replace one another are counted once", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        for (let i = 0; i < MAX_LIVE_PER_MODULE - 1; i++) yield* world.showOn("robins-phone", card(`P${i}`), { lifetime: "pinned" }, "board", { device: "robins-phone" })
        const one = yield* world.toolOn("kitchen-display", { forModel: "1", present: card("One") })
        const two = yield* world.toolOn("kitchen-display", { forModel: "2", present: card("Two") })
        assert.match(one.content, /Showing on/)
        assert.match(two.content, /Showing on/)
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => (p.content as { title: string }).title), ["Two"])
      }))

    it.effect("a11: removal of ended rows that fails is tried again until it succeeds", () =>
      Effect.gen(function*() {
        const { faulty, world } = yield* faultyStart()
        const h = yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" })
        assert.isTrue(yield* h.dismiss)
        faulty.faults.writes = 1
        yield* world.advance(10 * SECOND)
        assert.strictEqual((yield* world.rows).length, 1)
        yield* world.advance(2 * MINUTE)
        assert.deepStrictEqual(yield* world.rows, [])
      }))

    it.effect("a12: the whole note stays within its maximum, image sentence and spoken fallback included", () =>
      Effect.gen(function*() {
        const long = (i: number) => contractDevice(`room-device-${String(i).padStart(2, "0")}`, `${"N".repeat(38)}${i}`, "Lounge", "shared", null)
        const devices = [...Array.from({ length: 12 }, (_, i) => long(i)), contractDevice("speaker-in-lounge", "S".repeat(40), "Lounge", "shared", null)]
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const outputs = new Map(devices.map((d, i) => [d.id, i % 2 === 0 && i < 12 ? SCREEN : SPEAKER] as const))
        const world = yield* presentWorld(store, { devices, outputs })
        yield* world.settle
        const h = yield* world.showOn("speaker-in-lounge", { kind: "image", url: "https://example.org/a.png", alt: "A", credit: "C", spoken: "\"".repeat(300) }, { lifetime: "pinned" }, "board", { room: "Lounge" })
        assert.isAtMost(h.outcome.note.length, MAX_NOTE_CHARS)
        assert.isTrue(h.outcome.note.endsWith(IMAGE_SENTENCE))
        assert.include(h.outcome.note, SPOKEN_PREFIX)
      }))

    it.effect("G11: what a connection is sent is limited to the kinds its own page declared: an older tab beside a newer one gets none", () =>
      Effect.gen(function*() {
        const { world } = yield* start({ connected: [] })
        const old = yield* world.open("kitchen-display", { kinds: undefined })
        const modern = yield* world.open("kitchen-display", { kinds: { ...PRESENT_KIND_VERSIONS } })
        const cardsOnly = yield* world.open("kitchen-display", { kinds: { card: 1 } })
        yield* world.showOn("kitchen-display", checklist(), { lifetime: "pinned" })
        yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" })
        assert.deepStrictEqual(old.messages, [])
        assert.deepStrictEqual([...world.holds(modern).values()].map((p) => p.content.kind).sort(), ["card", "list"])
        assert.deepStrictEqual([...world.holds(cardsOnly).values()].map((p) => p.content.kind), ["card"])
        // A press from a tab that was not sent it is refused.
        const list = [...world.holds(modern).values()].find((p) => p.content.kind === "list")!
        assert.strictEqual((yield* world.pressOn("kitchen-display", list.id, "clear", {}, old)).code, "unknown")
      }))

    it.effect("until everything stored has been read nothing is claimed: a show is refused busy, a page is sent nothing", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const faulty = presentFaultyStore(yield* prepared(opened.store))
        const world = yield* presentWorld(faulty.store)
        yield* world.settle
        const h = yield* world.showOn("kitchen-display", card(), { lifetime: "pinned" })
        yield* world.stop
        // The start-up read fails: not loaded; shows are refused; pages are sent nothing; a minute later it is read.
        const reads = faulty.store.forCore
        let failing = true
        const broken: HouseholdStore = {
          ...faulty.store,
          forCore: (owner) => {
            const c = reads(owner)
            return owner !== PRESENT_OWNER ? c : { ...c, collection: ((col: never) => {
              const handle = c.collection(col)
              return { ...handle, list: (q: never) => (failing ? Effect.fail(new StoreError({ reason: "failed", message: "injected" })) : handle.list(q)) }
            }) as never }
          }
        }
        const next = yield* presentWorld(broken)
        yield* next.settle
        assert.isFalse(next.present.loaded())
        assert.strictEqual(reasonOf(yield* Effect.exit(next.showOn("kitchen-display", card("Later")))), "busy")
        assert.deepStrictEqual(next.firstTab("kitchen-display")!.messages, [])
        failing = false
        yield* next.advance(MINUTE)
        assert.isTrue(next.present.loaded())
        assert.deepStrictEqual(next.shownOn("kitchen-display").map((p) => p.id), [h.id])
      }))
  })
