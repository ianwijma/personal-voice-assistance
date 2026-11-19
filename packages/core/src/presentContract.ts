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
import { makePresentEngine, type MediaOutcome, type PresentDecisionRecord, type PresentMessage } from "./PresentEngine.ts"
import { makePrivacy, type PrivacyPlace } from "./Privacy.ts"
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
const prepared = (store: HouseholdStore) => Effect.as(store.prepare([], [presentStorage]), store)

/** A store whose synchronous reads of `presentations` fail while `faults.reads` is above 0 (each failure counts it down). */
export const presentFaultyStore = (inner: HouseholdStore) => {
  const faults = { reads: 0, writes: 0, failed: 0 }
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
      transaction: (f) => own.transaction((tx) => {
        fault("writes")
        return f(tx)
      })
    }
  }
  return { store: { ...inner, reader, forCore } satisfies HouseholdStore, faults }
}

/** One page (tab) of a device in the world. */
interface Tab {
  readonly id: string
  readonly deviceId: string
  readonly messages: Array<PresentMessage>
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
      const present = yield* makePresentEngine({
        store,
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
              }
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
      return { present, host }
    }))
    const settle = Effect.gen(function*() {
      for (let i = 0; i < 3; i++) yield* made.present.settled
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
    const open = (deviceId: string) =>
      Effect.gen(function*() {
        const tab: Tab = { id: `tab-${++tabSeq}`, deviceId, messages: [] }
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
    for (const id of o.connected ?? devices.map((d) => d.id)) tabs.set(`tab-${++tabSeq}`, { id: `tab-${tabSeq}`, deviceId: id, messages: [] })
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
        assert.deepStrictEqual(h.outcome, { devices: [{ deviceId: "kitchen-display", shown: true }], note: "Shown on \"Kitchen display\"." })
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
        assert.strictEqual(out.content, "{\"items\":2}\n[Screen: Shown on \"Kitchen display\".]")
        yield* world.settle
        assert.deepStrictEqual(world.shownOn("kitchen-display").map((p) => p.content.kind), ["list"])
        const none = yield* world.toolOn("office-speaker", { forModel: "Two things.", present: checklist() })
        assert.strictEqual(none.content, "Two things.\n[Screen: Not shown: \"Office speaker\" has no display; say it instead.]")
        const plain = yield* world.toolOn("kitchen-display", { forModel: "x", other: 1 })
        assert.strictEqual(plain.content, "{\"forModel\":\"x\",\"other\":1}")
      }))

    it.effect("a tool's presentation that is not valid or passes a bound is not shown, and the note says why (never a silent drop)", () =>
      Effect.gen(function*() {
        const { world } = yield* start()
        const bad = yield* world.toolOn("kitchen-display", { forModel: "x", present: { kind: "card", title: "", spoken: "s" } })
        assert.match(bad.content, /\[Screen: Not shown: the presentation was not valid \(title must be text\); say it instead\.\]$/)
        for (let i = 0; i < MAX_LIVE_PER_MODULE; i++) yield* world.showOn("kitchen-display", card(`C${i}`), { lifetime: "pinned", expiresInMs: HOUR }, "board", { room: "Kitchen" }).pipe(Effect.ignore)
        const over = yield* world.toolOn("kitchen-display", { forModel: "x", present: card() })
        assert.match(over.content, /Not shown: too much is on screen/)
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
        assert.deepStrictEqual((yield* world.rows).map((r) => [r.id, r.value.ended === true]), [[first.id, true], [second.id, false]])
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
        assert.strictEqual(onHall.outcome.note, "Not shown: \"Hall screen\" may not show this person's things; say it instead.")
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

    it.effect("an image is fetched once, off the turn's path: shown loading, then with its hash; a refusal shows it without the image", () =>
      Effect.gen(function*() {
        const fetched: Array<string> = []
        const hash = "a".repeat(64)
        const { world } = yield* start({ media: (url) => Effect.sync(() => (fetched.push(url), url.endsWith("/no.png") ? { refused: "type" as const } : { hash })) })
        const image = (url: string): Presentation => ({ kind: "image", url, alt: "A heron", credit: "Wikimedia Commons, CC BY-SA", spoken: "A heron." })
        const h = yield* world.showOn("kitchen-display", image("https://example.org/heron.png"), { lifetime: "pinned", key: "pic" })
        const tab = world.firstTab("kitchen-display")!
        const shows = tab.messages.filter((m) => m.type !== "present.dismiss").map((m) => (m.presentation.content as { image: unknown }).image)
        assert.deepStrictEqual(shows, [{ state: "loading" }, { state: "ready", hash }])
        assert.isTrue(world.present.holdsHash(hash))
        // The same key and address again keeps what was fetched.
        yield* world.showOn("kitchen-display", image("https://example.org/heron.png"), { lifetime: "pinned", key: "pic" })
        assert.deepStrictEqual(fetched, ["https://example.org/heron.png"])
        yield* world.showOn("robins-phone", image("https://example.org/no.png"))
        assert.deepStrictEqual((world.shownOn("robins-phone")[0]?.content as { image: unknown }).image, { state: "failed" })
        assert.isTrue(yield* h.dismiss)
        yield* world.settle
        assert.isFalse(world.present.holdsHash(hash))
      }))
  })
