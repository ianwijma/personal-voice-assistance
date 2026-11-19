import {
  decidePresentation,
  type DevicePresentOutputs,
  MAX_FACT_LABEL_CHARS,
  MAX_FACT_VALUE_CHARS,
  MAX_IMAGE_ALT_CHARS,
  MAX_IMAGE_CAPTION_CHARS,
  MAX_IMAGE_CREDIT_CHARS,
  MAX_LIST_ITEM_CHARS,
  MAX_PRESENT_LABEL_CHARS,
  MAX_PRESENT_TEXT_CHARS,
  MAX_PRESENT_TITLE_CHARS,
  MAX_TIMER_LABEL_CHARS,
  MAX_WEATHER_CONDITION_CHARS,
  MAX_WEATHER_DAY_LABEL_CHARS,
  MAX_WEATHER_PLACE_CHARS,
  MAX_WEATHER_VALUE_CHARS,
  type NotShownWhy,
  type PresentationWire,
  type PresentContent,
  type PresentDecision,
  PRESENT_KIND_VERSIONS,
  type PresentKindName,
  sameRoom,
  selectPresentations,
  type ServerMessageOf,
  TICK_ACTION
} from "@pva/protocol"
import { Cause, Clock, Effect, Exit, Queue, Scope } from "effect"
import type { KnownDevice } from "./Devices.ts"
import { asPrincipal, type ExecutionGateway } from "./Gateway.ts"
import { HOUSEHOLD_SCOPE, type HouseholdStore, type Row, type StoreFailure, type TxCollection, type TxResult } from "./HouseholdStore.ts"
import type { IssueRegistry } from "./Issues.ts"
import { isModuleStopped } from "./ModuleApi.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import type { NotifyLanguage } from "./NotifyTexts.ts"
import {
  PRESENT_DEFAULT_EXPIRY_MS,
  isPresentResult,
  PRESENT_MAX_EXPIRY_MS,
  MAX_LIVE_PER_MODULE,
  MAX_LIVE_TOTAL,
  MAX_NOTE_CHARS,
  MAX_PINNED_PER_DEVICE,
  MAX_PRESS_ANSWER_CHARS,
  PRESENT_MIN_EXPIRY_MS,
  type ModulePresent,
  type Presentation,
  presentationProblem,
  presentations,
  type PresentAnswer,
  PresentError,
  type PresentHandle,
  type PresentHook,
  PRESENT_ACTION_TIMEOUT_MS,
  PRESENT_HANDLER_NAME,
  PRESENT_OWNER,
  PRESENT_PAGE,
  type PresentPress,
  type PresentPressAnswer,
  type PresentPressHandler,
  type PresentPressRequest,
  type PresentSensitivity,
  type PresentTarget,
  type ShowOptions,
  showOptionsProblem,
  type ShowOutcome,
  type ShownOn,
  type StoredContent,
  type StoredPresentation,
  TIMER_GRACE_MS
} from "./Present.ts"
import { presentPageTexts, presentText, type PresentTextKey } from "./PresentTexts.ts"
import type { PrivacyService } from "./Privacy.ts"
import { quotedName } from "./PromptText.ts"
import type { PartRunner } from "./Scheduler.ts"
import { CurrentJob, CurrentPrincipal, CurrentTurn, type Principal } from "./TurnContext.ts"

/**
 * The Presenter (docs/PRESENTING.md; the contract is `Present.ts`). One per server: serve mode makes it on the household
 * store before the module host, and the module test kit on its in-memory store and test clock. On a turn's path it costs
 * only what `fromResult` does (a validation, the decision for the turn's device and one enqueue) or, for a module that
 * calls `ctx.present.show` itself, one synchronous transaction and an enqueue.
 *
 * - **An index** of the live presentations (id → module, key, part, lifetime, target, owner, kind, handler, times) is
 *   kept in memory, loaded from the store at start and changed only in the commit hooks of the engine's own
 *   transactions, so the bounds, the targets and the next end are read without the store; the content is read from the
 *   store with its synchronous reader in the step that sends it.
 * - **Reconciliation** (`reconcile`) is the only sender of `present.show`, `present.update` and `present.dismiss`. A pass
 *   over a device is one synchronous step: what applies to it now (the index), each decided now (`decidePresentation`,
 *   the privacy rule asked for that device), what it shows of them (`selectPresentations`), each row read now, and every
 *   connection of the device made to hold exactly that. Passes run one at a time in one fiber, yielding between devices;
 *   a pass that fails marks its device for the next trigger and a retry a minute later.
 * - **Ends**: one fiber sleeps until the earliest end among the live ones and removes what has ended (a page of rows per
 *   transaction); a part that stops removes its transient presentations; dismissing removes the row.
 * - **A press** is admitted only for a connection that holds the presentation and while the decision still lets it be
 *   pressed there; it is claimed (one at a time per presentation) before the module's handler runs through the gateway.
 */

export type PresentMessage = ServerMessageOf<"present.show"> | ServerMessageOf<"present.update"> | ServerMessageOf<"present.dismiss">

/** One voice connection of a device (serve mode: the hub's). `id` is stable while it is open. */
export interface PresentConnection {
  readonly id: string
  readonly send: (message: PresentMessage) => void
}

/** The voice pages (serve mode: the hub). */
export interface PresentOutlet {
  /** The device's voice connections that said hello, now. */
  readonly connections: (deviceId: string) => ReadonlyArray<PresentConnection>
}

/** Why an image is not there: refused (its type, its size, too many fetches at once, the cache full, an address the server may not fetch) or the fetch failed. */
export type MediaRefusal = "type" | "size" | "busy" | "full" | "fetch" | "blocked" | "unavailable"
export type MediaOutcome = { readonly hash: string } | { readonly refused: MediaRefusal }

/** The image cache (serve mode: `/media`): fetch an address once, check it and keep it; never fails. */
export interface MediaPort {
  readonly fetch: (url: string) => Effect.Effect<MediaOutcome>
}

/** One decision the engine made, for the test kit ("where it would show, and why not"). */
export interface PresentDecisionRecord {
  readonly id: string
  readonly deviceId: string
  readonly decision: PresentDecision
}

/** A live presentation as the kit and the tests see it. */
export interface PresentView {
  readonly id: string
  readonly module: string
  readonly key?: string
  readonly kind: PresentKindName
  readonly lifetime: "transient" | "pinned"
  readonly target: { readonly device: string } | { readonly room: string }
  readonly owner?: string
  readonly shownAt: number
  readonly expiresAt: number
}

export interface PresentEngineOptions {
  /** The household store, prepared with `presentStorage`. */
  readonly store: HouseholdStore
  /** The known devices (`Devices.list`): names, rooms. */
  readonly devices: () => ReadonlyArray<KnownDevice>
  /** A device's presentation outputs now (serve mode: `DeviceFacts.presentOf`, from `devicePresentFrom`). */
  readonly outputs: (device: KnownDevice) => DevicePresentOutputs
  /** The privacy rule, asked at each decision for the device that would show it. */
  readonly privacy: PrivacyService
  /** Late-bound: the voice pages (the hub). Absent: nobody is connected. */
  readonly outlet: () => PresentOutlet | undefined
  /** Late-bound: the image cache. Absent: an image is shown without it (`unavailable`). */
  readonly media?: () => MediaPort | undefined
  /** Late-bound: the execution gateway that admits a press's principal. Absent: not checked (tests). */
  readonly gateway: () => ExecutionGateway | undefined
  /** The page boundary (`ModuleHost.pageText`): a module's text on its way to a page. */
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
  /** The household's language now. */
  readonly language: () => NotifyLanguage
  readonly issues?: IssueRegistry
  readonly log?: (line: string) => void
  /** Ids (tests). Default random. */
  readonly newId?: () => string
  /** Every decision made (must not throw). */
  readonly onDecision?: (record: PresentDecisionRecord) => void
  /** Measurements (tests): one reconciliation step's wall time. Must not throw. */
  readonly observe?: (event: { readonly kind: "step"; readonly ms: number; readonly rows: number; readonly connections: number }) => void
  /** The wall clock (epoch ms) for what is stored and compared with stored times. Default `Clock.currentTimeMillis`. */
  readonly now?: Effect.Effect<number>
}

export interface PresentEngine extends PresentHook {
  /** Reconcile a device: it said hello, left, changed its declaration or its outputs (one trigger; passes are queued). */
  readonly reconcile: (deviceId: string) => void
  /** Reconcile every device that has a connection or holds something. */
  readonly reconcileAll: () => void
  /** A tick or a button pressed on a page, admitted only where the presentation is held and may be pressed. */
  readonly press: (request: PresentPressRequest) => Effect.Effect<PresentPressAnswer>
  /**
   * The gateway's split of a tool's or action's result: a `{ forModel, present }` is handed to the Presenter (a
   * validation, the decision for the origin device and one enqueue) and the model gets `forModel` with the note of what
   * the server did. Anything else is returned unchanged.
   */
  readonly fromResult: (moduleId: string | undefined, principal: Principal | undefined, value: unknown) => Effect.Effect<unknown>
  /** Whether an open connection holds an image with this content hash now (`/media` serves only those). */
  readonly holdsHash: (hash: string) => boolean
  /** The answer to a press refused because too much is pending at once (the hub's bound), in the household's language. */
  readonly busyAnswer: () => PresentPressAnswer
  /** The live presentations, oldest first (tests and the kit). */
  readonly live: () => ReadonlyArray<PresentView>
  /** What each open connection of a device holds now, by connection (tests and the kit). */
  readonly held: (deviceId: string) => ReadonlyArray<{ readonly connection: string; readonly ids: ReadonlyArray<string> }>
  /** Remove what has ended now (tests; the engine's own fiber does it on time). */
  readonly expireNow: Effect.Effect<void>
  /** Tests: completes once nothing is waiting to be written, fetched or reconciled. */
  readonly settled: Effect.Effect<void>
}

// ---------------------------------------------------------------------------------------------------------------------

const randomId = () => `p-${crypto.randomUUID().replace(/-/g, "")}`
const ISSUE_SOURCE = "core.present"
/** A read of every live row never reads more than this many (a corrupt store cannot make it unbounded). */
const SWEEP_ROWS = 4 * MAX_LIVE_TOTAL
const RETRY_AFTER_MS = 60_000
/** Rows marked ended (dismissed, or ended by a newer transient) are removed this long after the first of them, together. */
const PURGE_AFTER_MS = 10_000

/** What the engine keeps in memory of a live presentation (everything but the content). */
interface Entry {
  readonly id: string
  readonly module: string
  readonly key: string | undefined
  readonly part: number
  readonly lifetime: "transient" | "pinned"
  readonly target: { readonly device: string } | { readonly room: string }
  readonly owner: string | undefined
  readonly kind: PresentKindName
  readonly handler: string | undefined
  readonly shownAt: number
  readonly expiresAt: number
}

/** What one connection holds of one presentation (what it was sent last). */
interface Held {
  /** The wire form without `serverNow`, as JSON: an unchanged presentation is not sent again. */
  readonly fp: string
  readonly hash: string | undefined
}

interface HeldBy {
  readonly deviceId: string
  readonly send: (message: PresentMessage) => void
  readonly items: Map<string, Held>
}

interface PublishedHandler {
  readonly moduleId: string
  readonly handler: PresentPressHandler
  readonly runner: PartRunner
}

/** A show from a tool's result, waiting for the engine's writer (it holds its place in the bounds meanwhile). */
interface PendingShow {
  readonly entry: Entry
  readonly content: StoredContent
  readonly spoken: string
  readonly buttons: ReadonlyArray<{ readonly id: string; readonly label: string }>
}

const failure = (e: StoreFailure | unknown): PresentError => {
  if (e instanceof PresentError) return e
  const reason = (e as { readonly reason?: unknown }).reason
  const message = (e as { readonly message?: unknown }).message
  return new PresentError({
    reason: reason === "busy" ? "busy" : reason === "read-only" || reason === "unavailable" ? "unavailable" : "failed",
    message: typeof message === "string" ? message : "the store failed"
  })
}
const invalid = (message: string) => new PresentError({ reason: "invalid", message })

const ownerOf = (s: PresentSensitivity | undefined): string | undefined => (s === undefined || s === "household" ? undefined : s.personal)

/** A presentation's content as it is stored (an image's address kept; its hash once fetched). */
const storedContentOf = (p: Presentation, before?: StoredContent): StoredContent => {
  switch (p.kind) {
    case "card":
      return { kind: "card", title: p.title, ...(p.text !== undefined && p.text !== "" ? { text: p.text } : {}), facts: (p.facts ?? []).map((f) => ({ label: f.label, value: f.value })) }
    case "list":
      return { kind: "list", title: p.title, style: p.style ?? "bullets", items: p.items.map((i) => ({ id: i.id, text: i.text, done: i.done === true })) }
    case "timer":
      return { kind: "timer", label: p.label, endsAt: p.endsAt }
    case "image": {
      // The same address keeps what was fetched for it.
      const kept = before?.kind === "image" && before.url === p.url ? { ...(before.hash !== undefined ? { hash: before.hash } : {}), ...(before.failed !== undefined ? { failed: before.failed } : {}) } : {}
      return { kind: "image", url: p.url, alt: p.alt, credit: p.credit, ...(p.caption !== undefined && p.caption !== "" ? { caption: p.caption } : {}), ...kept }
    }
    case "weather":
      return {
        kind: "weather",
        place: p.place,
        now: { temperature: p.now.temperature, condition: p.now.condition, icon: p.now.icon },
        days: (p.days ?? []).map((d) => ({ label: d.label, high: d.high, low: d.low, icon: d.icon }))
      }
  }
}

const entryOf = (id: string, v: StoredPresentation): Entry => ({
  id,
  module: v.module,
  key: v.key,
  part: v.part,
  lifetime: v.lifetime,
  target: v.target,
  owner: v.owner,
  kind: v.content.kind,
  handler: v.handler,
  shownAt: v.shownAt,
  expiresAt: v.expiresAt
})

const WHY_WORDS: Readonly<Record<NotShownWhy, string>> = {
  offline: "is not connected",
  private: "may not show this person's things",
  "no-display": "has no display",
  "cannot-show-kind": "cannot show this kind of thing"
}

/** The note for the model: what the server did, never what the eye saw. English: the model words the reply itself. */
export const noteOf = (devices: ReadonlyArray<ShownOn>, nameOf: (deviceId: string) => string): string => {
  const shown = devices.filter((d) => d.shown).map((d) => quotedName(nameOf(d.deviceId)))
  const not = devices.filter((d) => !d.shown)
  const list = (xs: ReadonlyArray<string>) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)
  let note: string
  if (shown.length === 0) {
    note = not.length === 1
      ? `Not shown: ${quotedName(nameOf(not[0]!.deviceId))} ${WHY_WORDS[not[0]!.why ?? "offline"]}; say it instead.`
      : `Not shown: ${list(not.map((d) => `${quotedName(nameOf(d.deviceId))} ${WHY_WORDS[d.why ?? "offline"]}`))}; say it instead.`
  } else if (not.length === 0) note = `Shown on ${list(shown)}.`
  else note = `Shown on ${list(shown)}; not shown on ${list(not.map((d) => `${quotedName(nameOf(d.deviceId))} (${WHY_WORDS[d.why ?? "offline"]})`))}.`
  return note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS - 1)}…` : note
}

/** A tool result for the model with the note after it: `forModel` as the registry would encode it, then `[Screen: …]`. */
export const withScreenNote = (forModel: unknown, note: string): string => {
  const text = typeof forModel === "string" ? forModel : forModel === undefined ? "ok" : JSON.stringify(forModel)
  return `${text}\n[Screen: ${note}]`
}

export const makePresentEngine = (options: PresentEngineOptions): Effect.Effect<PresentEngine, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const context = yield* Effect.context<never>()
    const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.runForkWith(context)(Effect.forkIn(effect, scope))
    const log = options.log ?? (() => undefined)
    const newId = options.newId ?? randomId
    const core = options.store.forCore(PRESENT_OWNER)
    const lang = () => options.language()
    const wallNow: Effect.Effect<number> = options.now ?? Clock.currentTimeMillis
    const decided = (record: PresentDecisionRecord) => {
      try {
        options.onDecision?.(record)
      } catch {
        // Observers must not break showing.
      }
    }
    const issues = new Map<string, { readonly id: string; readonly severity: "warning"; readonly title: string; readonly detail: string }>()
    const setIssue = (key: string, issue: { readonly title: string; readonly detail: string } | undefined) => {
      if (issue === undefined ? !issues.has(key) : false) return
      if (issue === undefined) issues.delete(key)
      else issues.set(key, { id: `core.present.${key}`, severity: "warning", ...issue })
      options.issues?.set(ISSUE_SOURCE, [...issues.values()])
    }

    /** One transaction of the service's collection. */
    const tx = <X>(f: (p: TxCollection<StoredPresentation>) => TxResult<X>, after?: (x: X) => void): Effect.Effect<X, PresentError> =>
      core.transaction<X>((t) => {
        const out = f(t.collection(presentations))
        if (after !== undefined) t.afterCommit(() => after(out as X))
        return out
      }).pipe(Effect.mapError(failure))
    /** The synchronous reader (throws when the store fails a read). */
    const reader = () => {
      const r = options.store.reader(PRESENT_OWNER, presentations)
      if (r === undefined) throw new PresentError({ reason: "unavailable", message: "the presentation data is not usable here" })
      return r
    }

    // ---- The index of live presentations

    const index = new Map<string, Entry>()
    const byKey = new Map<string, string>()
    const keyOf = (module: string, key: string) => `${module}|${key}`
    const put = (e: Entry) => {
      const before = index.get(e.id)
      if (before?.key !== undefined) byKey.delete(keyOf(before.module, before.key))
      index.set(e.id, e)
      if (e.key !== undefined) byKey.set(keyOf(e.module, e.key), e.id)
      wakeEnds()
    }
    const drop = (id: string) => {
      const e = index.get(id)
      if (e === undefined) return
      index.delete(id)
      if (e.key !== undefined && byKey.get(keyOf(e.module, e.key)) === id) byKey.delete(keyOf(e.module, e.key))
    }
    /** Loaded from the store (at start; again a minute later while that fails). */
    let loaded = false

    const devicesNow = () => {
      try {
        return options.devices()
      } catch {
        return []
      }
    }
    const deviceOf = (deviceId: string) => devicesNow().find((d) => d.id === deviceId)
    const applies = (target: Entry["target"], d: KnownDevice) => ("device" in target ? target.device === d.id : sameRoom(d.room, target.room))
    const targetDevices = (target: Entry["target"]) => devicesNow().filter((d) => applies(target, d))

    // ---- What every connection holds

    const held = new Map<string, HeldBy>()
    const connectionsOf = (deviceId: string): ReadonlyArray<PresentConnection> => {
      try {
        return options.outlet()?.connections(deviceId) ?? []
      } catch {
        return []
      }
    }
    const send = (by: HeldBy, message: PresentMessage) => {
      try {
        by.send(message)
      } catch (e) {
        log(`Presentations: a message to ${by.deviceId} could not be sent (${String(e)})`)
      }
    }
    /** The device's connections now, with their bookkeeping; what closed connections held is dropped. */
    const heldOf = (deviceId: string): ReadonlyArray<HeldBy> => {
      const conns = connectionsOf(deviceId)
      const open = new Set(conns.map((c) => c.id))
      for (const [cid, by] of held) if (by.deviceId === deviceId && !open.has(cid)) held.delete(cid)
      return conns.map((c) => {
        let by = held.get(c.id)
        if (by === undefined || by.deviceId !== deviceId) {
          by = { deviceId, send: c.send, items: new Map() }
          held.set(c.id, by)
        }
        return by
      })
    }

    /** THE decision for one presentation on one device, now: the privacy rule asked for that device at this moment. */
    const decide = (e: Pick<Entry, "id" | "kind" | "owner">, d: KnownDevice, connected: boolean): PresentDecision => {
      const decision = decidePresentation({
        kind: e.kind,
        personal: e.owner !== undefined,
        mayReveal: e.owner === undefined ? true : options.privacy.mayReveal(e.owner, d.id),
        device: { connected, ...options.outputs(d) }
      })
      decided({ id: e.id, deviceId: d.id, decision })
      return decision
    }

    /** The wire form of a row for a device that may show it (every module text through the page boundary). */
    const wireOf = (id: string, v: StoredPresentation, interactive: boolean, now: number): PresentationWire => {
      const t = (text: string, max: number) => options.pageText(v.module, text, max)
      const c = v.content
      const content: PresentContent = c.kind === "card"
        ? { kind: "card", title: t(c.title, MAX_PRESENT_TITLE_CHARS), ...(c.text !== undefined ? { text: t(c.text, MAX_PRESENT_TEXT_CHARS) } : {}), facts: c.facts.map((f) => ({ label: t(f.label, MAX_FACT_LABEL_CHARS), value: t(f.value, MAX_FACT_VALUE_CHARS) })) }
        : c.kind === "list"
        ? { kind: "list", title: t(c.title, MAX_PRESENT_TITLE_CHARS), style: c.style, items: c.items.map((i) => ({ id: i.id, text: t(i.text, MAX_LIST_ITEM_CHARS), done: i.done })) }
        : c.kind === "timer"
        ? { kind: "timer", label: t(c.label, MAX_TIMER_LABEL_CHARS), endsAt: c.endsAt }
        : c.kind === "image"
        ? {
          kind: "image",
          alt: t(c.alt, MAX_IMAGE_ALT_CHARS),
          credit: t(c.credit, MAX_IMAGE_CREDIT_CHARS),
          ...(c.caption !== undefined ? { caption: t(c.caption, MAX_IMAGE_CAPTION_CHARS) } : {}),
          image: c.hash !== undefined ? { state: "ready", hash: c.hash } : c.failed !== undefined ? { state: "failed" } : { state: "loading" }
        }
        : {
          kind: "weather",
          place: t(c.place, MAX_WEATHER_PLACE_CHARS),
          now: { temperature: t(c.now.temperature, MAX_WEATHER_VALUE_CHARS), condition: t(c.now.condition, MAX_WEATHER_CONDITION_CHARS), icon: c.now.icon },
          days: c.days.map((d) => ({ label: t(d.label, MAX_WEATHER_DAY_LABEL_CHARS), high: t(d.high, MAX_WEATHER_VALUE_CHARS), low: t(d.low, MAX_WEATHER_VALUE_CHARS), icon: d.icon }))
        }
      return {
        id,
        lifetime: v.lifetime,
        shownAt: v.shownAt,
        serverNow: now,
        v: PRESENT_KIND_VERSIONS[c.kind],
        content,
        buttons: v.buttons.map((b) => ({ id: b.id, label: t(b.label, MAX_PRESENT_LABEL_CHARS) || b.id })),
        interactive: interactive && v.handler !== undefined,
        texts: presentPageTexts(lang())
      }
    }

    /**
     * One device, in one synchronous step: what applies to it now, decided now, what it shows of that, each row read
     * now, and every connection of it made to hold exactly that. Throws when the store fails a read.
     */
    const syncDevice = (deviceId: string, now: number) => {
      const started = performance.now()
      const bys = heldOf(deviceId)
      if (bys.length === 0) return
      const device = deviceOf(deviceId)
      const candidates = device === undefined
        ? []
        : [...index.values()].filter((e) => e.expiresAt > now && applies(e.target, device)).map((e) => ({ id: e.id, lifetime: e.lifetime, shownAt: e.shownAt, decision: decide(e, device, true) }))
      const chosen = selectPresentations(candidates)
      const want = new Map<string, { readonly message: PresentationWire; readonly fp: string; readonly hash: string | undefined }>()
      const r = chosen.length > 0 ? reader() : undefined
      for (const c of chosen) {
        const row = r!.get(c.id, HOUSEHOLD_SCOPE)
        if (row === undefined) continue
        const wire = wireOf(c.id, row.value, c.decision.interactive, now)
        const { serverNow: _now, ...rest } = wire
        want.set(c.id, { message: wire, fp: JSON.stringify(rest), hash: wire.content.kind === "image" && wire.content.image.state === "ready" ? wire.content.image.hash : undefined })
      }
      for (const by of bys) {
        // Withdrawals first: a page never holds more than it should, even for a moment.
        for (const id of [...by.items.keys()]) {
          if (want.has(id)) continue
          by.items.delete(id)
          send(by, { type: "present.dismiss", id })
        }
        for (const [id, w] of want) {
          const before = by.items.get(id)
          if (before?.fp === w.fp) continue
          send(by, { type: before === undefined ? "present.show" : "present.update", presentation: w.message })
          by.items.set(id, { fp: w.fp, hash: w.hash })
        }
      }
      options.observe?.({ kind: "step", ms: performance.now() - started, rows: want.size, connections: bys.length })
    }

    // ---- The reconciliation fiber: coalesced devices, one pass at a time

    const dirty = new Set<string>()
    const failed = new Set<string>()
    /** When the failed passes are tried again without a trigger (a minute after the first failure since the last retry). */
    let retryAt: number | undefined
    let all = false
    let working = false
    const wake = yield* Queue.sliding<void>(1)
    const kick = () => {
      for (const id of failed) dirty.add(id)
      failed.clear()
      void Queue.offerUnsafe(wake, undefined)
    }
    const enqueue = (deviceId: string) => {
      dirty.add(deviceId)
      kick()
    }
    const enqueueAll = () => {
      all = true
      kick()
    }
    const everyDevice = () => {
      const ids = new Set<string>()
      for (const d of devicesNow()) if (connectionsOf(d.id).length > 0) ids.add(d.id)
      for (const by of held.values()) ids.add(by.deviceId)
      return ids
    }
    /** The devices to reconcile after a change of `e` (its target's devices and whoever holds it). */
    const touch = (id: string, target: Entry["target"] | undefined) => {
      for (const by of held.values()) if (by.items.has(id)) dirty.add(by.deviceId)
      if (target !== undefined) for (const d of targetDevices(target)) dirty.add(d.id)
      kick()
    }

    const loop = Effect.gen(function*() {
      for (;;) {
        yield* Queue.take(wake)
        working = true
        while (all || dirty.size > 0) {
          if (all) {
            all = false
            for (const id of everyDevice()) dirty.add(id)
          }
          const next = dirty.values().next()
          if (next.done === true) continue
          dirty.delete(next.value)
          const now = yield* wallNow
          const exit = yield* Effect.exit(Effect.try(() => syncDevice(next.value, now)))
          if (Exit.isFailure(exit)) {
            failed.add(next.value)
            if (retryAt === undefined) retryAt = now + RETRY_AFTER_MS
            wakeEnds()
            log(`Presentations: reconciling ${next.value} failed (${Cause.pretty(exit.cause).split("\n")[0]}); the next trigger or a minute repeats it`)
          }
          yield* Effect.yieldNow
        }
        working = false
      }
    })

    // ---- Parts and their transient presentations

    /** The open parts of each module (a part is open from `forPart` until its scope closes). */
    const openParts = new Map<string, Set<number>>()
    const work: Array<Effect.Effect<void>> = []
    let writing = false
    const workWake = yield* Queue.sliding<void>(1)
    const queueWork = (w: Effect.Effect<void>) => {
      work.push(w)
      void Queue.offerUnsafe(workWake, undefined)
    }
    const workLoop = Effect.gen(function*() {
      for (;;) {
        yield* Queue.take(workWake)
        writing = true
        for (let w = work.shift(); w !== undefined; w = work.shift()) {
          yield* w
          yield* Effect.yieldNow
        }
        writing = false
      }
    })

    /** Remove rows by id in transactions of a page; after each commit, the index follows and their devices are reconciled. */
    const removeRows = (ids: ReadonlyArray<string>, still: (e: Entry) => boolean): Effect.Effect<void, PresentError> =>
      Effect.gen(function*() {
        for (let i = 0; i < ids.length; i += PRESENT_PAGE) {
          const page = ids.slice(i, i + PRESENT_PAGE)
          yield* tx((p) => {
            const gone: Array<Entry> = []
            for (const id of page) {
              const e = index.get(id)
              if (e === undefined || !still(e)) continue
              if (p.get(id) !== undefined) p.remove(id)
              gone.push(e)
            }
            return gone
          }, (gone) => {
            for (const e of gone) {
              drop(e.id)
              touch(e.id, e.target)
            }
          })
          yield* Effect.yieldNow
        }
      })

    const partClosed = (moduleId: string, partId: number) => {
      const open = openParts.get(moduleId)
      open?.delete(partId)
      if (open !== undefined && open.size === 0) openParts.delete(moduleId)
      // A transient presentation belongs to the part that made it: withdrawn when that part stops. Pinned ones stay.
      queueWork(Effect.gen(function*() {
        const ids = [...index.values()].filter((e) => e.part === partId && e.module === moduleId && e.lifetime === "transient").map((e) => e.id)
        const exit = yield* Effect.exit(removeRows(ids, (e) => e.part === partId && e.lifetime === "transient"))
        if (Exit.isFailure(exit)) {
          log(`Presentations: the transient presentations of a stopped part of ${moduleId} could not be removed; they end by themselves`)
        }
      }))
    }

    // ---- Ends: one fiber, sleeping until the earliest end

    const endsWake = yield* Queue.sliding<void>(1)
    function wakeEnds() {
      void Queue.offerUnsafe(endsWake, undefined)
    }
    /** Rows marked ended, removed together `PURGE_AFTER_MS` after the first (never on a caller's path). */
    const tombstones = new Set<string>()
    let purgeAt: number | "soon" | undefined
    function entombed(id: string) {
      tombstones.add(id)
      if (purgeAt === undefined) purgeAt = "soon"
      wakeEnds()
    }
    const purge: Effect.Effect<void, PresentError> = Effect.gen(function*() {
      const ids = [...tombstones]
      for (let i = 0; i < ids.length; i += PRESENT_PAGE) {
        const page = ids.slice(i, i + PRESENT_PAGE)
        yield* tx((p) => {
          for (const id of page) {
            const row = p.get(id)
            if (row !== undefined && row.value.ended === true && !index.has(id)) p.remove(id)
          }
        }, () => {
          for (const id of page) tombstones.delete(id)
        })
        yield* Effect.yieldNow
      }
    })
    let sweeping = false
    const sweepEnded: Effect.Effect<void, PresentError> = Effect.gen(function*() {
      const now = yield* wallNow
      const ended = [...index.values()].filter((e) => e.expiresAt <= now).map((e) => e.id)
      yield* removeRows(ended, (e) => e.expiresAt <= now)
    })
    const endsLoop = Effect.gen(function*() {
      for (;;) {
        const now = yield* wallNow
        let next: number | undefined
        for (const e of index.values()) next = next === undefined ? e.expiresAt : Math.min(next, e.expiresAt)
        if (!loaded && (next === undefined || next > now + RETRY_AFTER_MS)) next = now + RETRY_AFTER_MS
        if (purgeAt === "soon") purgeAt = now + PURGE_AFTER_MS
        if (typeof purgeAt === "number") next = next === undefined ? purgeAt : Math.min(next, purgeAt)
        if (retryAt !== undefined && failed.size > 0) next = next === undefined ? retryAt : Math.min(next, retryAt)
        if (next === undefined) yield* Queue.take(endsWake)
        else if (next > now) yield* Effect.raceFirst(Effect.asVoid(Effect.sleep(next - now)), Queue.take(endsWake))
        sweeping = true
        if (!loaded) yield* load
        // Failed passes are repeated a minute later (a trigger repeats them sooner), never in a tight loop.
        const at = yield* wallNow
        if (retryAt !== undefined && at >= retryAt) {
          retryAt = undefined
          if (failed.size > 0) kick()
        }
        const exit = yield* Effect.exit(Effect.andThen(sweepEnded, Effect.suspend(() => {
          if (typeof purgeAt !== "number" || purgeAt > at) return Effect.void
          purgeAt = undefined
          return Effect.tap(purge, () => Effect.sync(() => {
            if (tombstones.size > 0 && purgeAt === undefined) purgeAt = "soon"
          }))
        })))
        sweeping = false
        if (Exit.isFailure(exit)) {
          log("Presentations: what has ended could not be removed; tried again in a minute")
          yield* Effect.sleep(RETRY_AFTER_MS).pipe(Effect.raceFirst(Queue.take(endsWake)))
        }
        yield* Effect.yieldNow
      }
    })

    /** Read every live row into the index; transient rows of an earlier process (whose parts are gone) are removed. */
    const load: Effect.Effect<void> = Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.gen(function*() {
        const rows: Array<Row<StoredPresentation>> = []
        let after: Row<StoredPresentation> | undefined
        for (let read = 0; read < SWEEP_ROWS;) {
          const page = yield* core.collection(presentations).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: PRESENT_PAGE, ...(after !== undefined ? { after } : {}) })
          rows.push(...page)
          read += page.length
          if (page.length < PRESENT_PAGE) break
          after = page[page.length - 1]
        }
        const now = yield* wallNow
        const stale = rows.filter((r) => r.value.lifetime === "transient" || r.value.ended === true || r.value.expiresAt <= now).map((r) => r.id)
        for (let i = 0; i < stale.length; i += PRESENT_PAGE) {
          const page = stale.slice(i, i + PRESENT_PAGE)
          yield* core.transaction((t) => {
            const p = t.collection(presentations)
            for (const id of page) if (p.get(id) !== undefined) p.remove(id)
          })
        }
        const gone = new Set(stale)
        return rows.filter((r) => !gone.has(r.id))
      }))
      if (Exit.isFailure(exit)) {
        setIssue("load", { title: "Presentations could not be read", detail: "Pinned presentations come back once the store can be read; it is tried again every minute." })
        log(`Presentations: the stored presentations could not be read (${Cause.pretty(exit.cause).split("\n")[0]}); tried again in a minute`)
        return
      }
      for (const row of exit.value) if (!index.has(row.id)) put(entryOf(row.id, row.value))
      loaded = true
      setIssue("load", undefined)
      enqueueAll()
    })

    // ---- Bounds, from the index (and the shows waiting for the writer)

    const pending: Array<PendingShow> = []
    /** Why one more presentation would pass a bound, or `undefined`. `replacing`: the id a key replaces. */
    const boundProblem = (module: string, lifetime: "transient" | "pinned", target: Entry["target"], replacing: string | undefined, now: number): string | undefined => {
      // A transient one ends the transient ones it would share a device with: those do not count against it.
      const ending = new Set(lifetime === "transient" ? overlapping(target, replacing).map((e) => e.id) : [])
      const live = [...index.values()].filter((e) => e.id !== replacing && !ending.has(e.id) && e.expiresAt > now)
      const waiting = pending.map((p) => p.entry).filter((e) => e.id !== replacing)
      const every = [...live, ...waiting]
      if (every.length >= MAX_LIVE_TOTAL) return `${MAX_LIVE_TOTAL} presentations are live already`
      if (every.filter((e) => e.module === module).length >= MAX_LIVE_PER_MODULE) return `${module} has ${MAX_LIVE_PER_MODULE} live presentations already`
      if (lifetime === "pinned") {
        for (const d of targetDevices(target)) {
          // A pinned presentation another of the same key replaces is not counted.
          const pinnedThere = every.filter((e) => e.lifetime === "pinned" && applies(e.target, d)).length
          if (pinnedThere >= MAX_PINNED_PER_DEVICE) return `${quotedName(d.name)} shows ${MAX_PINNED_PER_DEVICE} pinned presentations already`
        }
      }
      return undefined
    }

    /** The live transient presentations that would share a device with `target` now (a device shows one at a time). */
    const overlapping = (target: Entry["target"], except: string | undefined): ReadonlyArray<Entry> => {
      const devices = targetDevices(target)
      return [...index.values()].filter((e) => e.id !== except && e.lifetime === "transient" && devices.some((d) => applies(e.target, d)))
    }

    /**
     * What was decided for each device of the target now, and the note for the model; an image not fetched yet says that
     * it may be shown without the image (the fetch's outcome is not known when the call answers).
     */
    const outcomeOf = (e: Pick<Entry, "id" | "kind" | "owner" | "target">, imagePending = false): ShowOutcome => {
      const devices = targetDevices(e.target)
      const shownOn: Array<ShownOn> = devices.map((d) => {
        const decision = decide(e, d, connectionsOf(d.id).length > 0)
        return decision.show ? { deviceId: d.id, shown: true } : { deviceId: d.id, shown: false, why: decision.why }
      })
      const names = new Map(devices.map((d) => [d.id, d.name] as const))
      const note = noteOf(shownOn, (id) => names.get(id) ?? id)
      return { devices: shownOn, note: imagePending && shownOn.some((d) => d.shown) ? `${note} The image is being fetched; if it cannot be, it shows without it.` : note }
    }

    // ---- Images: fetched once by the cache, off the turn's path, the outcome written on the row

    const fetching = new Set<string>()
    const fetchImage = (id: string, url: string) => {
      const key = `${id} ${url}`
      if (fetching.has(key)) return
      fetching.add(key)
      fork(Effect.gen(function*() {
        const media = options.media?.()
        const outcome: MediaOutcome = media === undefined ? { refused: "unavailable" } : yield* media.fetch(url)
        // Written only if the row still shows that address (an update may have changed it meanwhile).
        const exit = yield* Effect.exit(tx((p) => {
          const row = p.get(id)
          if (row === undefined || row.value.ended === true || row.value.content.kind !== "image" || row.value.content.url !== url) return false
          const { hash: _h, failed: _f, ...content } = row.value.content
          p.update(id, (v) => ({ ...v, content: { ...content, ...("hash" in outcome ? { hash: outcome.hash } : { failed: outcome.refused }) } }), { expectRev: row.rev })
          return true
        }, (wrote) => {
          if (wrote) touch(id, index.get(id)?.target)
        }))
        if (Exit.isFailure(exit)) log(`Presentations: an image's outcome could not be written; it shows without it`)
        if ("refused" in outcome) log(`Presentations: an image was not kept (${outcome.refused})`)
      }).pipe(Effect.ensuring(Effect.sync(() => fetching.delete(key)))))
    }

    // ---- Showing

    const originDevice = (principal: Principal | undefined): Effect.Effect<string | undefined> =>
      Effect.gen(function*() {
        if (principal !== undefined) {
          if (principal._tag === "turn") return principal.turn.deviceId
          if (principal._tag === "job") return principal.job.deviceId
          if (principal._tag === "notification") return principal.notification.deviceId
          if (principal._tag === "presentation") return principal.presentation.deviceId
          return undefined
        }
        const turn = yield* CurrentTurn
        if (turn?.deviceId !== undefined) return turn.deviceId
        const job = yield* CurrentJob
        if (job?.deviceId !== undefined) return job.deviceId
        const p = yield* CurrentPrincipal
        if (p?._tag === "notification") return p.notification.deviceId
        if (p?._tag === "presentation") return p.presentation.deviceId
        return undefined
      })

    const resolveTarget = (target: PresentTarget, origin: string | undefined): Entry["target"] | string => {
      if (target === "origin") return origin === undefined ? "this call has no origin device (a turn, a job or a press made for one): name a device or a room" : { device: origin }
      if (typeof target === "object" && target !== null && "device" in target && typeof target.device === "string") {
        return deviceOf(target.device) === undefined ? `there is no device "${target.device.slice(0, 64)}"` : { device: target.device }
      }
      if (typeof target === "object" && target !== null && "room" in target && typeof target.room === "string" && target.room.trim() !== "" && target.room.length <= 80) {
        return targetDevices({ room: target.room }).length === 0 ? "no device is in that room" : { room: target.room.trim() }
      }
      return "target is \"origin\", { device } or { room }"
    }

    /** Insert (or replace by key) one presentation; earlier transients that share a device with it end. Synchronous. */
    const writeShow = (p: TxCollection<StoredPresentation>, e: Entry, content: StoredContent, spoken: string, buttons: PendingShow["buttons"], now: number): { readonly removed: ReadonlyArray<Entry> } | { readonly limit: string } => {
      const replacing = e.key === undefined ? undefined : byKey.get(keyOf(e.module, e.key))
      const problem = boundProblem(e.module, e.lifetime, e.target, replacing ?? e.id, now)
      if (problem !== undefined) return { limit: problem }
      const value: StoredPresentation = {
        module: e.module,
        ...(e.key !== undefined ? { key: e.key } : {}),
        part: e.part,
        lifetime: e.lifetime,
        target: e.target,
        ...(e.owner !== undefined ? { owner: e.owner } : {}),
        content,
        spoken,
        buttons,
        ...(e.handler !== undefined ? { handler: e.handler } : {}),
        shownAt: e.shownAt,
        expiresAt: e.expiresAt
      }
      // A key shown again replaces its row whole (an ended mark too).
      if (p.get(e.id) !== undefined) p.update(e.id, () => value)
      else p.insert(value, { id: e.id })
      // Ended, not removed: an update in the caller's transaction (the removal comes later, off its path).
      const removed = e.lifetime === "transient" ? overlapping(e.target, e.id) : []
      for (const old of removed) if (p.get(old.id) !== undefined) p.update(old.id, (v) => ({ ...v, ended: true as const }))
      return { removed }
    }

    const afterShow = (e: Entry, removed: ReadonlyArray<Entry>, content: StoredContent, before: Entry | undefined) => {
      for (const old of removed) {
        drop(old.id)
        touch(old.id, old.target)
        entombed(old.id)
      }
      put(e)
      touch(e.id, e.target)
      if (before !== undefined && JSON.stringify(before.target) !== JSON.stringify(e.target)) touch(e.id, before.target)
      if (content.kind === "image" && content.hash === undefined && content.failed === undefined) fetchImage(e.id, content.url)
    }

    /** The entry for a new show (its id: the key's when the module shows that key again). */
    const newEntry = (module: string, part: number, target: Entry["target"], presentation: Presentation, o: ShowOptions | undefined, now: number): Entry => {
      const lifetime = o?.lifetime ?? (presentation.kind === "timer" ? "pinned" : "transient")
      const timerEnd = presentation.kind === "timer" && lifetime === "pinned" && o?.expiresInMs === undefined
        ? Math.min(now + PRESENT_MAX_EXPIRY_MS.pinned, Math.max(now + PRESENT_MIN_EXPIRY_MS, presentation.endsAt + TIMER_GRACE_MS))
        : undefined
      const id = (o?.key !== undefined ? byKey.get(keyOf(module, o.key)) : undefined) ?? newId()
      return {
        id,
        module,
        key: o?.key,
        part,
        lifetime,
        target,
        owner: ownerOf(presentation.sensitivity),
        kind: presentation.kind,
        handler: presentation.handler,
        shownAt: now,
        expiresAt: timerEnd ?? now + (o?.expiresInMs ?? PRESENT_DEFAULT_EXPIRY_MS[lifetime])
      }
    }

    const published = new Map<string, PublishedHandler>()
    /** Handlers registered by a part that has not closed (staged or published): what `show` accepts by name. */
    const known = new Map<string, number>()

    const requestProblem = (moduleId: string, presentation: Presentation, o: ShowOptions | undefined, now: number): string | undefined =>
      presentationProblem(presentation, now) ??
        showOptionsProblem(o, (presentation as { kind?: PresentKindName }).kind) ??
        (presentation.handler !== undefined && !known.has(`${moduleId}/${presentation.handler}`) ? `${moduleId} has no press handler "${presentation.handler}" (register it in shared with present.handle)` : undefined)

    /** The newest open part of a module (what a tool's presentation belongs to), or `undefined`. */
    const partOf = (moduleId: string): number | undefined => {
      const open = openParts.get(moduleId)
      return open === undefined || open.size === 0 ? undefined : Math.max(...open)
    }

    const show = (moduleId: string, partId: number) => (target: PresentTarget, presentation: Presentation, o?: ShowOptions): Effect.Effect<PresentHandle, PresentError> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        const problem = requestProblem(moduleId, presentation, o, now)
        if (problem !== undefined) return yield* invalid(problem)
        if (!loaded) return yield* new PresentError({ reason: "busy", message: "the stored presentations could not be read yet; try again" })
        const resolved = resolveTarget(target, yield* originDevice(undefined))
        if (typeof resolved === "string") return yield* invalid(resolved)
        const e = newEntry(moduleId, partId, resolved, presentation, o, now)
        const before = index.get(e.id)
        const spoken = presentation.spoken
        const buttons = (presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label }))
        const out = yield* tx((p) => {
          // Showing a key again keeps what was fetched for the same image address.
          const prior = p.get(e.id)
          const kept = storedContentOf(presentation, prior?.value.content)
          const w = writeShow(p, e, kept, spoken, buttons, now)
          return "limit" in w ? w : { ...w, content: kept }
        }, (w) => {
          if (!("limit" in w)) afterShow(e, w.removed, w.content, before)
        })
        if ("limit" in out) return yield* new PresentError({ reason: "limit", message: out.limit })
        return handleOf(moduleId, e, outcomeOf(e, out.content.kind === "image" && out.content.hash === undefined && out.content.failed === undefined))
      })

    const handleOf = (moduleId: string, e: Entry, outcome: ShowOutcome): PresentHandle => ({
      id: e.id,
      ...(e.key !== undefined ? { key: e.key } : {}),
      outcome,
      update: (presentation) => update(moduleId, e.id, presentation),
      dismiss: dismiss(moduleId, e.id)
    })

    const update = (moduleId: string, id: string, presentation: Presentation): Effect.Effect<ShowOutcome | undefined, PresentError> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        const problem = presentationProblem(presentation, now) ??
          (presentation.handler !== undefined && !known.has(`${moduleId}/${presentation.handler}`) ? `${moduleId} has no press handler "${presentation.handler}"` : undefined)
        if (problem !== undefined) return yield* invalid(problem)
        const e = index.get(id)
        if (e === undefined || e.module !== moduleId || e.expiresAt <= now) return undefined
        if (presentation.kind !== e.kind) return yield* invalid(`an update keeps the kind (${e.kind}); show a new presentation for another`)
        if (ownerOf(presentation.sensitivity) !== e.owner) return yield* invalid("an update keeps the sensitivity; show a new presentation for another")
        const next: Entry = { ...e, handler: presentation.handler }
        const wrote = yield* tx((p) => {
          const row = p.get(id)
          if (row === undefined || row.value.ended === true) return undefined
          const content = storedContentOf(presentation, row.value.content)
          const { handler: _h, ...rest } = row.value
          p.update(id, () => ({
            ...rest,
            content,
            spoken: presentation.spoken,
            buttons: (presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label })),
            ...(presentation.handler !== undefined ? { handler: presentation.handler } : {})
          }), { expectRev: row.rev })
          return content
        }, (content) => {
          if (content === undefined) return
          put(next)
          touch(id, next.target)
          if (content.kind === "image" && content.hash === undefined && content.failed === undefined) fetchImage(id, content.url)
        })
        return wrote === undefined ? undefined : outcomeOf(next)
      })

    const dismiss = (moduleId: string, id: string): Effect.Effect<boolean, PresentError> =>
      Effect.gen(function*() {
        const e = index.get(id)
        if (e === undefined || e.module !== moduleId) return false
        return yield* tx((p) => {
          const row = p.get(id)
          if (row === undefined || row.value.ended === true) return false
          // Ended, not removed: an update in the caller's transaction (the removal comes later, off its path).
          p.update(id, (v) => ({ ...v, ended: true as const }), { expectRev: row.rev })
          return true
        }, (gone) => {
          drop(id)
          if (gone) {
            touch(id, e.target)
            entombed(id)
          }
        })
      })

    /** The writer's side of a tool's show: the same transaction as `show`, with the bounds checked again. */
    const writePending = (s: PendingShow): Effect.Effect<void> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        const exit = yield* Effect.exit(tx((p) => {
          // Its own reservation no longer counts once it is being written.
          const at = pending.indexOf(s)
          if (at >= 0) pending.splice(at, 1)
          const prior = p.get(s.entry.id)
          const content = prior === undefined ? s.content : { ...s.content, ...(s.content.kind === "image" && prior.value.content.kind === "image" && prior.value.content.url === s.content.url ? { ...(prior.value.content.hash !== undefined ? { hash: prior.value.content.hash } : {}) } : {}) } as StoredContent
          const w = writeShow(p, s.entry, content, s.spoken, s.buttons, now)
          return "limit" in w ? w : { ...w, content }
        }, (w) => {
          if (!("limit" in w)) afterShow(s.entry, w.removed, w.content, undefined)
        }))
        const at = pending.indexOf(s)
        if (at >= 0) pending.splice(at, 1)
        if (Exit.isFailure(exit)) {
          setIssue("write", { title: "A presentation could not be shown", detail: "The store refused it; the model was told it was shown. It is not tried again." })
          log(`Presentations: a presentation of ${s.entry.module} could not be written (${Cause.pretty(exit.cause).split("\n")[0]})`)
        } else if ("limit" in exit.value) log(`Presentations: a presentation of ${s.entry.module} passed a bound while it waited (${exit.value.limit}); not shown`)
        else setIssue("write", undefined)
      })

    const fromResult: PresentEngine["fromResult"] = (moduleId, principal, value) =>
      Effect.gen(function*() {
        if (!isPresentResult(value)) return value
        const forModel = value.forModel
        const presentation = value.present
        const o = value.show
        const not = (why: string) => withScreenNote(forModel, `Not shown: ${why}; say it instead.`)
        if (moduleId === undefined) return not("this tool belongs to no module")
        const now = yield* wallNow
        const problem = presentationProblem(presentation, now) ?? showOptionsProblem(o, (presentation as { kind?: PresentKindName }).kind) ??
          (presentation.handler !== undefined && !known.has(`${moduleId}/${presentation.handler}`) ? `${moduleId} has no press handler "${presentation.handler}"` : undefined)
        if (problem !== undefined) {
          log(`Presentations: a presentation of ${moduleId} was refused (${problem})`)
          return not(`the presentation was not valid (${problem.slice(0, 200)})`)
        }
        const part = partOf(moduleId)
        if (part === undefined) return not("this module cannot show things (it is not a version 2 module, or it is stopping)")
        if (!loaded) return not("the screen's data could not be read yet")
        const origin = yield* originDevice(principal)
        if (origin === undefined || deviceOf(origin) === undefined) return not("there is no device to show it on")
        const e = newEntry(moduleId, part, { device: origin }, presentation, o, now)
        const bound = boundProblem(moduleId, e.lifetime, e.target, e.key !== undefined ? byKey.get(keyOf(moduleId, e.key)) ?? e.id : e.id, now)
        if (bound !== undefined) return not(`too much is on screen (${bound})`)
        const outcome = outcomeOf(e, presentation.kind === "image")
        // One enqueue: the writer stores it and reconciliation shows it, off the turn's path.
        const s: PendingShow = { entry: e, content: storedContentOf(presentation), spoken: presentation.spoken, buttons: (presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label })) }
        pending.push(s)
        queueWork(writePending(s))
        return withScreenNote(forModel, outcome.note)
      })

    // ---- Presses

    const answer = (ok: boolean, key: PresentTextKey, code?: PresentPressAnswer["code"]): PresentPressAnswer => ({ ok, say: presentText(lang(), key), ...(code !== undefined ? { code } : {}) })
    const claims = new Set<string>()

    const press = (request: PresentPressRequest): Effect.Effect<PresentPressAnswer> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        // Admission, against this moment (synchronous): the connection holds it, it is live, the decision lets it be
        // pressed there now, and the action is one it offers.
        type Admitted = { readonly row: Row<StoredPresentation>; readonly entry: PublishedHandler } | PresentPressAnswer
        const admitted = ((): Admitted => {
          const bys = heldOf(request.deviceId)
          const holds = bys.some((by) => by.items.has(request.presentationId) && (request.connection === undefined || held.get(request.connection.id) === by))
          if (!holds) return answer(false, "cantNow", "unknown")
          const e = index.get(request.presentationId)
          if (e === undefined || e.expiresAt <= now) {
            enqueue(request.deviceId)
            return answer(false, "over", "unknown")
          }
          const device = deviceOf(request.deviceId)
          const decision = device === undefined || !applies(e.target, device) ? undefined : decide(e, device, true)
          if (decision?.show !== true || !decision.interactive) {
            enqueue(request.deviceId)
            return answer(false, "cantNow", "unknown")
          }
          let row: Row<StoredPresentation> | undefined
          try {
            row = reader().get(request.presentationId, HOUSEHOLD_SCOPE)
          } catch {
            return answer(false, "cantNow", "failed")
          }
          if (row === undefined) return answer(false, "over", "unknown")
          const v = row.value
          if (request.action === TICK_ACTION) {
            const ok = v.content.kind === "list" && v.content.style === "checklist" && typeof request.done === "boolean" && v.content.items.some((i) => i.id === request.item)
            if (!ok) return answer(false, "cantNow", "unknown")
          } else if (!v.buttons.some((b) => b.id === request.action)) return answer(false, "cantNow", "unknown")
          if (v.handler === undefined) return answer(false, "cantNow", "unknown")
          const entry = published.get(`${v.module}/${v.handler}`)
          if (entry === undefined) return answer(false, "cantNow", "not_running")
          if (claims.has(row.id)) return answer(false, "handling", "busy")
          claims.add(row.id)
          return { row, entry }
        })()
        if ("ok" in admitted) return admitted
        const { row, entry } = admitted
        return yield* runClaimed(request, row, entry).pipe(Effect.ensuring(Effect.sync(() => {
          claims.delete(row.id)
          enqueue(request.deviceId)
        })))
      })

    const runClaimed = (request: PresentPressRequest, row: Row<StoredPresentation>, entry: PublishedHandler): Effect.Effect<PresentPressAnswer> =>
      Effect.gen(function*() {
        const v = row.value
        const principal: Principal = {
          _tag: "presentation",
          presentation: {
            presentationId: row.id,
            deviceId: request.deviceId,
            ...(request.connection !== undefined ? { connection: request.connection } : {}),
            ...(request.person !== undefined ? { person: request.person } : {})
          }
        }
        const info: PresentPress = {
          presentationId: row.id,
          ...(v.key !== undefined ? { key: v.key } : {}),
          deviceId: request.deviceId,
          action: request.action,
          ...(request.action === TICK_ACTION ? { item: request.item!, done: request.done! } : {})
        }
        const body = asPrincipal(
          principal,
          Effect.gen(function*() {
            const gateway = options.gateway()
            if (gateway !== undefined) {
              const admittedBy = yield* gateway.principal
              if ("refused" in admittedBy) return yield* Effect.fail(new PresentError({ reason: "invalid", message: `Not run: ${admittedBy.refused}` }))
            }
            return yield* Effect.suspend(() => entry.handler.run(info))
          })
        ).pipe(Effect.timeoutOrElse({ duration: PRESENT_ACTION_TIMEOUT_MS, orElse: () => Effect.fail(new PresentError({ reason: "failed", message: "the handler did not finish in time" })) }))
        const exit = yield* Effect.exit(entry.runner.inFlight(() => body))
        if (Exit.isFailure(exit)) {
          const stopped = exit.cause.reasons.some((r) => (Cause.isFailReason(r) && isModuleStopped(r.error)) || (Cause.isDieReason(r) && isModuleStopped(r.defect)))
          log(`Presentations: the press ${request.action} on a presentation of ${v.module} ${stopped ? "could not run: its module stopped" : `failed: ${Cause.pretty(exit.cause).split("\n")[0]}`}`)
          return stopped ? answer(false, "cantNow", "not_running") : answer(false, "failed", "failed")
        }
        const said = exit.value as PresentAnswer | void
        const text = said?.say === undefined ? "" : options.pageText(v.module, said.say, MAX_PRESS_ANSWER_CHARS)
        return { ok: true, say: text === "" ? presentText(lang(), "done") : text }
      })

    // ---- Start

    yield* load
    yield* Effect.forkIn(loop, scope)
    yield* Effect.forkIn(workLoop, scope)
    yield* Effect.forkIn(endsLoop, scope)

    // ---- The module host's side

    const forPart: PresentHook["forPart"] = (part: PartHandle, runner: PartRunner) => {
      const moduleId = part.moduleId
      let open = openParts.get(moduleId)
      if (open === undefined) {
        open = new Set()
        openParts.set(moduleId, open)
      }
      open.add(part.id)
      // The part's transient presentations end with it (its scope closes after its module was withdrawn and its calls
      // in flight had their grace period).
      Effect.runSync(Scope.addFinalizer(part.scope, Effect.sync(() => partClosed(moduleId, part.id))))
      const handle = (name: string, handler: PresentPressHandler): Effect.Effect<void, PresentError> =>
        Effect.suspend(() => {
          if (typeof name !== "string" || !PRESENT_HANDLER_NAME.test(name)) return Effect.fail(invalid(`a press handler's name must match ${PRESENT_HANDLER_NAME}`))
          if (typeof handler !== "object" || handler === null || typeof handler.run !== "function") return Effect.fail(invalid("a press handler has a run function"))
          const key = `${moduleId}/${name}`
          const entry: PublishedHandler = { moduleId, handler, runner }
          const registered = part.register({
            kind: "present-press-handler",
            validate: () => ((known.get(key) ?? 0) > 1 ? `${moduleId} registers the press handler "${name}" twice` : undefined),
            publish: () => void published.set(key, entry),
            withdraw: () => void (published.get(key) === entry && published.delete(key))
          })
          if (!registered.ok) return Effect.fail(invalid(registered.reason))
          known.set(key, (known.get(key) ?? 0) + 1)
          return Scope.addFinalizer(part.scope, Effect.sync(() => {
            const n = (known.get(key) ?? 1) - 1
            if (n <= 0) known.delete(key)
            else known.set(key, n)
          }))
        })
      return { show: show(moduleId, part.id), handle } satisfies ModulePresent
    }

    const engine: PresentEngine = {
      forPart,
      reconcile: enqueue,
      reconcileAll: enqueueAll,
      press,
      fromResult,
      holdsHash: (hash) => {
        for (const by of held.values()) for (const h of by.items.values()) if (h.hash === hash) return true
        return false
      },
      busyAnswer: () => answer(false, "tooMany", "busy"),
      live: () =>
        [...index.values()].sort((a, b) => a.shownAt - b.shownAt || (a.id < b.id ? -1 : 1)).map((e) => ({
          id: e.id,
          module: e.module,
          ...(e.key !== undefined ? { key: e.key } : {}),
          kind: e.kind,
          lifetime: e.lifetime,
          target: e.target,
          ...(e.owner !== undefined ? { owner: e.owner } : {}),
          shownAt: e.shownAt,
          expiresAt: e.expiresAt
        })),
      held: (deviceId) => [...held.entries()].filter(([, by]) => by.deviceId === deviceId).map(([connection, by]) => ({ connection, ids: [...by.items.keys()] })),
      expireNow: Effect.ignore(sweepEnded),
      settled: Effect.gen(function*() {
        for (let i = 0; i < 5_000 && (working || writing || sweeping || all || dirty.size > 0 || work.length > 0 || pending.length > 0 || fetching.size > 0); i++) yield* Effect.yieldNow
      })
    }
    return engine
  })
