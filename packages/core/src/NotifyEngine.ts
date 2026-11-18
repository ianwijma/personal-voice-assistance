import type { ServerMessageOf } from "@pva/protocol"
import { sameRoom } from "@pva/protocol"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Schema, Scope } from "effect"
import type { KnownDevice } from "./Devices.ts"
import { asPrincipal, type ExecutionGateway } from "./Gateway.ts"
import type { HouseholdStore, Row, StoreFailure, StoreTx, TxCollection, TxResult } from "./HouseholdStore.ts"
import { isModuleStopped } from "./ModuleApi.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import {
  type ActionAnswer,
  type ActionPress,
  DEFAULT_EXPIRY_MS,
  decideDelivery,
  type Delivery,
  type DndState,
  KEEP_RESOLVED_MS,
  lineProblem,
  MAX_ANSWER_CHARS,
  MAX_DND_MS,
  MAX_EXPIRY_MS,
  MAX_LATER_MS,
  MAX_NOTIFICATION_ACTIONS,
  MAX_NOTIFICATION_LABEL_CHARS,
  MAX_NOTIFICATION_TEXT_CHARS,
  MAX_NOTIFICATION_TITLE_CHARS,
  MAX_NOTIFY_PAGE,
  MAX_OPEN_PER_MODULE,
  MAX_OPEN_TOTAL,
  MAX_SPEECH_CHARS,
  MAX_SPEECH_QUEUE,
  type ModuleNotify,
  type ModuleSpeech,
  type NotDelivered,
  type Notification,
  NOTIFICATION_ACTION_ID,
  notifications,
  type NotifyActionHandler,
  notifyCounts,
  notifyDnd,
  NotifyError,
  type NotifyHook,
  NOTIFY_ACTION_TIMEOUT_MS,
  NOTIFY_HANDLER_NAME,
  NOTIFY_KEY,
  NOTIFY_OWNER,
  NOTIFY_TEXT,
  type NotifyListQuery,
  type NotifyRequest,
  type PressAnswer,
  type PressRequest,
  type RingingNotification,
  type SendResult,
  type SpeechDelivery,
  type SpeechDeviceOutcome,
  SpeechError,
  type SpeechHandle,
  type SpeechOptions,
  type SpeechTarget,
  STOP_ACTION,
  type StoredNotification
} from "./Notify.ts"
import { notifyText, type NotifyLanguage } from "./NotifyTexts.ts"
import type { PrivacyService } from "./Privacy.ts"
import type { PartRunner } from "./Scheduler.ts"
import type { SchedulerEngine } from "./SchedulerEngine.ts"
import { CurrentJob, CurrentPrincipal, CurrentTurn, type Principal } from "./TurnContext.ts"

/**
 * The notification service (docs/NOTIFICATIONS.md; the contract is `Notify.ts`). One per server: serve mode makes it on
 * the household store and the scheduler engine before the module host, and the module test kit on its in-memory store
 * and test clock. Nothing of it runs on a turn's path except `send` (one synchronous transaction and an enqueue),
 * `resolve` and `say` (an enqueue): delivery to pages runs in its own fiber, a step at a time, announcements in one
 * fiber per device.
 */

/** A message for the voice connections of one device. */
export type NotifyMessage = ServerMessageOf<"notification.ring"> | ServerMessageOf<"notification.resolved">

/** Where messages for a device go (serve mode: every voice connection of the device). */
export interface NotifyOutlet {
  readonly send: (deviceId: string, message: NotifyMessage) => void
}

/**
 * The voice of a device, for announcements (serve mode: its voice session). `quiet` completes once nothing is being
 * spoken or heard there (no reply plays, no turn runs, the person is not speaking); `play` speaks `text` with the
 * synthesis and the output path replies use, returns when it has been played, and silences it at once when
 * interrupted. A reply that starts while it plays takes the speaker (the announcement fails, the reply is intact).
 */
export interface SpeechPort {
  readonly quiet: (deviceId: string) => Effect.Effect<void>
  readonly play: (deviceId: string, text: string, options: { readonly cue: boolean }) => Effect.Effect<void, unknown>
}

/** One decision the engine made, for the test kit and the latency test ("to which devices it would go, and why not"). */
export interface DecisionRecord {
  readonly kind: "notification" | "announcement"
  /** The notification's or the announcement's id. */
  readonly id: string
  readonly deviceId: string
  readonly decision: Delivery
}

export interface NotifyEngineOptions {
  /** The household store, prepared with `notifyStorage` (and `schedulerStorage`). */
  readonly store: HouseholdStore
  /** The scheduler: the service's own jobs (`forCore("core.notify")`): sending later, expiry, the end of do not disturb, retention. */
  readonly scheduler: SchedulerEngine
  /** The known devices (`Devices.list`): rooms, places, capabilities. */
  readonly devices: () => ReadonlyArray<KnownDevice>
  /** A voice page of the device is connected now. */
  readonly connected: (deviceId: string) => boolean
  /** It may make sound now (serve mode: `DeviceFacts.speakerAllowed`). */
  readonly canSpeak: (device: KnownDevice) => boolean
  /** It can show a card. */
  readonly canShow: (device: KnownDevice) => boolean
  /** The privacy rule, asked at each delivery for the device that would show or speak it. */
  readonly privacy: PrivacyService
  /** Late-bound: the voice pages (the hub). Absent: nothing is sent. */
  readonly outlet: () => NotifyOutlet | undefined
  /** Late-bound: the devices' voices. Absent: announcements are `failed`. */
  readonly speech: () => SpeechPort | undefined
  /** Late-bound: the execution gateway that admits a press's notification principal. Absent: not checked (tests). */
  readonly gateway: () => ExecutionGateway | undefined
  /** The page boundary (`ModuleHost.pageText`): a module's text on its way to a page. */
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
  /** The household's language now. */
  readonly language: () => NotifyLanguage
  readonly log?: (line: string) => void
  /** Ids (tests). Default random. */
  readonly newId?: () => string
  /** Every decision made (must not throw). */
  readonly onDecision?: (record: DecisionRecord) => void
  /** Measurements (the latency test): one delivery pass's wall time and its size. Must not throw. */
  readonly observe?: (event: { readonly kind: "pass"; readonly ms: number; readonly notifications: number; readonly devices: number }) => void
}

export interface NotifyEngine extends NotifyHook {
  /** A voice connection of `deviceId` said hello: what is open for the device is delivered to it (`send`: that connection only). */
  readonly connected: (deviceId: string, send?: (message: NotifyMessage) => void) => void
  /** The device's last voice connection closed: nothing rings there any more. */
  readonly disconnected: (deviceId: string) => void
  /** A press of a card's button (or, later, a ringing phrase), through the gateway. */
  readonly press: (request: PressRequest) => Effect.Effect<PressAnswer>
  /** P7: the notifications ringing on a device now (delivered with their cue), oldest first. */
  readonly ringingOn: (deviceId: string) => ReadonlyArray<RingingNotification>
  /** P7: the host's "stop" for what rings on a device: each is resolved (`stop`). How many. */
  readonly stopRinging: (deviceId: string) => Effect.Effect<number>
  /** P7: stop the announcement being spoken on a device and those waiting there. Whether there was one. */
  readonly stopSpeech: (deviceId: string) => Effect.Effect<boolean>
  /** P7: called (synchronously, never throwing into the engine) when what rings on a device changed. */
  readonly onRingingChanged: (listener: (deviceId: string) => void) => () => void
  /** Do not disturb as the engine holds it now (the committed row). */
  readonly dnd: () => DndState
  /** Tests: completes once nothing is waiting to be delivered (after at most a few thousand yields). */
  readonly settled: Effect.Effect<void>
}

// ---------------------------------------------------------------------------------------------------------------------

const randomId = () => `n-${crypto.randomUUID().replace(/-/g, "")}`
const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const OUTCOME = /^[A-Za-z0-9_.-]{1,40}$/
/** A sweep never reads more than this many rows (a corrupt store cannot make it unbounded). */
const SWEEP_ROWS = 20 * MAX_NOTIFY_PAGE
/** Resolved rows one retention run removes at most (more: the next run, ten minutes later). */
const RETENTION_ROWS = 10 * MAX_NOTIFY_PAGE
const RETENTION_CRON = "*/10 * * * *"

type Fields = Omit<StoredNotification, "dedupe" | "liveModule">

const withIndexes = (f: Fields): StoredNotification => {
  const live = f.state !== "resolved"
  const { ...out } = f as StoredNotification
  return {
    ...out,
    ...(live && f.key !== undefined ? { dedupe: `${f.module}|${f.key}` } : {}),
    ...(live ? { liveModule: f.module } : {})
  }
}

const fieldsOf = (v: StoredNotification): Fields => {
  const { dedupe: _d, liveModule: _l, ...rest } = v
  return rest
}

/** A stored notification as `send`, `list` and the test kit show it. */
export const notificationView = (row: Row<StoredNotification>): Notification => {
  const v = row.value
  return {
    id: row.id,
    module: v.module,
    state: v.state,
    ...(v.key !== undefined ? { key: v.key } : {}),
    title: v.title,
    ...(v.text !== undefined ? { text: v.text } : {}),
    priority: v.priority,
    ...(v.owner !== undefined ? { owner: v.owner } : {}),
    target: v.target,
    ...(v.deviceId !== undefined ? { deviceId: v.deviceId } : {}),
    actions: v.actions.map((a) => ({ id: a.id, label: a.label })),
    ...(v.handler !== undefined ? { handler: v.handler } : {}),
    sentAt: v.sentAt,
    expiresAt: v.expiresAt,
    ...(v.outcome !== undefined ? { outcome: v.outcome } : {}),
    ...(v.finishedAt !== undefined ? { resolvedAt: v.finishedAt } : {}),
    ...(v.resolvedBy !== undefined ? { resolvedBy: v.resolvedBy } : {})
  }
}

const notifyFailure = (e: StoreFailure | unknown): NotifyError => {
  if (e instanceof NotifyError) return e
  const reason = (e as { readonly reason?: unknown }).reason
  const message = (e as { readonly message?: unknown }).message
  return new NotifyError({ reason: reason === "busy" ? "busy" : reason === "read-only" || reason === "unavailable" ? "unavailable" : "failed", message: typeof message === "string" ? message : "the store failed" })
}

const invalid = (message: string) => new NotifyError({ reason: "invalid", message })

interface Shown {
  readonly id: string
  readonly module: string
  readonly title: string
  readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly sound: boolean
  readonly ring: boolean
  readonly sentAt: number
}

interface PublishedHandler {
  readonly moduleId: string
  readonly name: string
  readonly handler: NotifyActionHandler
  readonly runner: PartRunner
}

interface SpeechItem {
  readonly handleId: string
  readonly deviceId: string
  readonly text: string
  readonly cue: boolean
  readonly owner: string | undefined
  readonly done: Deferred.Deferred<SpeechDeviceOutcome>
}

interface DeviceQueue {
  readonly items: Array<SpeechItem>
  current: { readonly item: SpeechItem; readonly fiber: Fiber.Fiber<SpeechDeviceOutcome> } | undefined
  running: boolean
}

/** What a device gets for one notification now: its card (silent or not), or why not. */
interface Planned {
  readonly deviceId: string
  readonly decision: Delivery
}

export const makeNotifyEngine = (options: NotifyEngineOptions): Effect.Effect<NotifyEngine, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const context = yield* Effect.context<never>()
    const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.runForkWith(context)(Effect.forkIn(effect, scope))
    const log = options.log ?? (() => undefined)
    const newId = options.newId ?? randomId
    const core = options.store.forCore(NOTIFY_OWNER)
    const jobs = options.scheduler.forCore(NOTIFY_OWNER)
    const lang = () => options.language()
    const decided = (record: DecisionRecord) => {
      try {
        options.onDecision?.(record)
      } catch {
        // Observers must not break delivery.
      }
    }

    /** One transaction of the service's own collections. */
    const tx = <X>(f: (t: { readonly n: TxCollection<StoredNotification>; readonly tx: StoreTx }) => TxResult<X>): Effect.Effect<X, NotifyError> =>
      core.transaction<X>((stx) => f({ n: stx.collection(notifications), tx: stx })).pipe(Effect.mapError(notifyFailure))

    // ---- Do not disturb: the committed row, mirrored after each commit

    let dndNow: DndState = { on: false }
    const loadDnd = Effect.map(core.collection(notifyDnd).get("house"), (row) => {
      dndNow = row === undefined || !row.value.on ? { on: false } : { on: true, ...(row.value.until !== undefined ? { until: row.value.until } : {}) }
    }).pipe(Effect.catch((e) => Effect.sync(() => log(`Notifications: do not disturb could not be read (${notifyFailure(e).message}); it is off`))))

    // ---- What is shown where (memory: rebuilt as pages say hello)

    const shown = new Map<string, Map<string, Shown>>()
    const listeners = new Set<(deviceId: string) => void>()
    const ringingChanged = (deviceId: string) => {
      for (const l of listeners) {
        try {
          l(deviceId)
        } catch {
          // A listener that throws is ignored.
        }
      }
    }
    const shownOn = (deviceId: string) => {
      let m = shown.get(deviceId)
      if (m === undefined) {
        m = new Map()
        shown.set(deviceId, m)
      }
      return m
    }
    const isRinging = (s: Shown | undefined) => s !== undefined && s.ring && s.sound

    const cardOf = (id: string, v: StoredNotification, sound: boolean): NotifyMessage => {
      const text = v.text === undefined ? undefined : options.pageText(v.module, v.text, MAX_NOTIFICATION_TEXT_CHARS)
      return {
        type: "notification.ring",
        notification: {
          id,
          title: options.pageText(v.module, v.title, MAX_NOTIFICATION_TITLE_CHARS),
          ...(text !== undefined && text !== "" ? { text } : {}),
          priority: v.priority,
          silent: !sound,
          actions: [
            { id: STOP_ACTION, label: notifyText(lang(), "stop") },
            ...v.actions.map((a) => ({ id: a.id, label: options.pageText(v.module, a.label, MAX_NOTIFICATION_LABEL_CHARS) || a.id }))
          ],
          sentAt: v.sentAt
        }
      }
    }

    const sendTo = (deviceId: string, message: NotifyMessage, via?: (message: NotifyMessage) => void) => {
      try {
        if (via !== undefined) via(message)
        else options.outlet()?.send(deviceId, message)
      } catch (e) {
        log(`Notifications: a message to ${deviceId} could not be sent (${String(e)})`)
      }
    }

    const targetsOf = (v: StoredNotification): ReadonlyArray<KnownDevice> => {
      const all = options.devices()
      return v.target === "everywhere" ? all : all.filter((d) => d.id === v.deviceId)
    }

    const deviceFacts = (d: KnownDevice) => ({ connected: options.connected(d.id), canSpeak: options.canSpeak(d), canShow: options.canShow(d) })

    /** THE decision for one notification on one device, now: privacy asked for that device at this moment. */
    const decideNotification = (id: string, v: StoredNotification, d: KnownDevice): Delivery => {
      const decision = decideDelivery({
        kind: "notification",
        priority: v.priority,
        personal: v.owner !== undefined,
        mayReveal: v.owner === undefined ? true : options.privacy.mayReveal(v.owner, d.id),
        dnd: dndNow.on,
        device: deviceFacts(d)
      })
      decided({ kind: "notification", id, deviceId: d.id, decision })
      return decision
    }

    /** Send what was decided, and remember it (a device whose card should go gets `resolved`). */
    const apply = (id: string, v: StoredNotification, plan: ReadonlyArray<Planned>, via?: (message: NotifyMessage) => void) => {
      for (const p of plan) {
        const here = shownOn(p.deviceId)
        const before = here.get(id)
        if (p.decision.deliver) {
          sendTo(p.deviceId, cardOf(id, v, p.decision.sound), via)
          const next: Shown = { id, module: v.module, title: v.title, actions: v.actions, sound: p.decision.sound, ring: v.priority === "ring", sentAt: v.sentAt }
          here.set(id, next)
          if (isRinging(before) !== isRinging(next)) ringingChanged(p.deviceId)
        } else if (before !== undefined && p.decision.why !== "offline") {
          // It was shown and may not be any more (do not disturb, the privacy rule): take the card down there.
          here.delete(id)
          sendTo(p.deviceId, { type: "notification.resolved", id, outcome: "withdrawn" }, via)
          if (isRinging(before)) ringingChanged(p.deviceId)
        }
      }
    }

    /** It ended: every device it was shown on is told, and nothing rings for it any more. */
    const ended = (id: string, outcome: string) => {
      for (const [deviceId, here] of shown) {
        const before = here.get(id)
        if (before === undefined) continue
        here.delete(id)
        sendTo(deviceId, { type: "notification.resolved", id, outcome })
        if (isRinging(before)) ringingChanged(deviceId)
      }
    }

    // ---- The delivery fiber: coalesced work, one step at a time

    const pendingIds = new Set<string>()
    const pendingDevices: Array<{ readonly deviceId: string; readonly send?: (message: NotifyMessage) => void }> = []
    let pendingAll = false
    let working = false
    const wake = yield* Queue.sliding<void>(1)
    const kick = () => void Queue.offerUnsafe(wake, undefined)

    const deliverOne = (id: string) =>
      Effect.gen(function*() {
        const row = yield* core.collection(notifications).get(id)
        if (row === undefined || row.value.state !== "open") return
        const started = performance.now()
        const targets = targetsOf(row.value)
        apply(id, row.value, targets.map((d) => ({ deviceId: d.id, decision: decideNotification(id, row.value, d) })))
        options.observe?.({ kind: "pass", ms: performance.now() - started, notifications: 1, devices: targets.length })
      })

    /** Every open notification, oldest first, page by page (bounded), handed to `each`; a yield between pages. */
    const eachOpen = (each: (row: Row<StoredNotification>) => void) =>
      Effect.gen(function*() {
        let after: Row<StoredNotification> | undefined
        for (let read = 0; read < SWEEP_ROWS;) {
          const page = yield* core.collection(notifications).list({ where: { state: "open" }, orderBy: { field: "sentAt" }, limit: MAX_NOTIFY_PAGE, ...(after !== undefined ? { after } : {}) })
          for (const row of page) each(row)
          read += page.length
          if (page.length < MAX_NOTIFY_PAGE) return
          after = page[page.length - 1]
          yield* Effect.yieldNow
        }
      })

    const deliverToDevice = (deviceId: string, via?: (message: NotifyMessage) => void) =>
      Effect.gen(function*() {
        const device = options.devices().find((d) => d.id === deviceId)
        if (device === undefined) return
        let count = 0
        let ms = 0
        yield* eachOpen((row) => {
          const v = row.value
          if (v.target !== "everywhere" && v.deviceId !== deviceId) return
          const started = performance.now()
          apply(row.id, v, [{ deviceId, decision: decideNotification(row.id, v, device) }], via)
          ms += performance.now() - started
          count++
        })
        options.observe?.({ kind: "pass", ms, notifications: count, devices: 1 })
      })

    const deliverAll = Effect.gen(function*() {
      let count = 0
      let ms = 0
      yield* eachOpen((row) => {
        const started = performance.now()
        const targets = targetsOf(row.value)
        apply(row.id, row.value, targets.map((d) => ({ deviceId: d.id, decision: decideNotification(row.id, row.value, d) })))
        ms += performance.now() - started
        count++
      })
      options.observe?.({ kind: "pass", ms, notifications: count, devices: options.devices().length })
    })

    const step: Effect.Effect<boolean> = Effect.gen(function*() {
      if (pendingAll) {
        pendingAll = false
        pendingIds.clear()
        yield* deliverAll
        return true
      }
      const device = pendingDevices.shift()
      if (device !== undefined) {
        yield* deliverToDevice(device.deviceId, device.send)
        return true
      }
      const id = pendingIds.values().next()
      if (id.done !== true) {
        pendingIds.delete(id.value)
        yield* deliverOne(id.value)
        return true
      }
      return false
    }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => (log(`Notifications: a delivery step failed (${Cause.pretty(cause).split("\n")[0]}); the next page hello or change delivers again`), true)))
    )

    const loop = Effect.gen(function*() {
      for (;;) {
        yield* Queue.take(wake)
        working = true
        while (yield* step) yield* Effect.yieldNow
        working = false
      }
    })

    const enqueueId = (id: string) => {
      pendingIds.add(id)
      kick()
    }
    const enqueueAll = () => {
      pendingAll = true
      kick()
    }

    // ---- Rows

    /** Resolve a live row (one transaction); after the commit its cards go and its jobs are cancelled. False: not live. */
    const resolveRow = (id: string, outcome: string, by: string, onlyModule?: string): Effect.Effect<boolean, NotifyError> =>
      Effect.gen(function*() {
        const at = yield* Clock.currentTimeMillis
        const done = yield* tx(({ n, tx: t }) => {
          const row = n.get(id) as Row<StoredNotification> | undefined
          if (row === undefined || row.value.state === "resolved") return false
          if (onlyModule !== undefined && row.value.module !== onlyModule) return false
          n.update(id, (v: StoredNotification) => withIndexes({ ...fieldsOf(v), state: "resolved", outcome, finishedAt: at, resolvedBy: by }), { expectRev: row.rev })
          bump(t, row.value.module, -1)
          t.afterCommit(() => {
            ended(id, outcome)
            fork(Effect.ignore(Effect.andThen(jobs.cancel({ key: `x:${id}` }), jobs.cancel({ key: `d:${id}` }))))
          })
          return true
        })
        return done
      })

    /** The live counters: `total` and `m:<module>`, in the running transaction. */
    const bump = (t: StoreTx, module: string, delta: number) => {
      const c = t.collection(notifyCounts)
      for (const key of ["total", `m:${module}`]) {
        const row = c.get(key)
        const live = Math.max(0, (row?.value.live ?? 0) + delta)
        if (row === undefined) c.insert({ live }, { id: key })
        else c.update(key, () => ({ live }))
      }
    }

    // ---- Action handlers (registrations of a module's part)

    const published = new Map<string, PublishedHandler>()
    /** Handlers registered by a part that has not closed (staged or published): what `send` accepts by name. */
    const known = new Map<string, number>()

    // ---- Requests

    const originDevice = Effect.gen(function*() {
      const turn = yield* CurrentTurn
      if (turn?.deviceId !== undefined) return turn.deviceId
      const job = yield* CurrentJob
      if (job?.deviceId !== undefined) return job.deviceId
      const principal = yield* CurrentPrincipal
      if (principal?._tag === "notification") return principal.notification.deviceId
      return undefined
    })

    const requestProblem = (moduleId: string, r: NotifyRequest): string | undefined => {
      if (typeof r !== "object" || r === null) return "a notification is an object"
      const titleWrong = lineProblem(r.title, MAX_NOTIFICATION_TITLE_CHARS, "title")
      if (titleWrong !== undefined) return titleWrong
      if (r.text !== undefined && (typeof r.text !== "string" || r.text.length > MAX_NOTIFICATION_TEXT_CHARS || !NOTIFY_TEXT.test(r.text))) {
        return `text is at most ${MAX_NOTIFICATION_TEXT_CHARS} characters, without control characters`
      }
      if (r.priority !== undefined && r.priority !== "normal" && r.priority !== "ring") return "priority is normal or ring: nothing may send above ring"
      if (r.owner !== undefined && (typeof r.owner !== "string" || !PERSON_ID.test(r.owner))) return "owner is a Members id"
      if (r.target !== undefined && r.target !== "origin" && r.target !== "everywhere") return "target is origin or everywhere"
      if (r.key !== undefined && (typeof r.key !== "string" || !NOTIFY_KEY.test(r.key))) return `key must match ${NOTIFY_KEY}`
      if (r.expiresInMs !== undefined) {
        const max = MAX_EXPIRY_MS[r.priority ?? "normal"]
        if (!Number.isInteger(r.expiresInMs) || r.expiresInMs < 1_000 || r.expiresInMs > max) return `expiresInMs is a whole number of ms from 1000 to ${max}`
      }
      const actions = r.actions ?? []
      if (!Array.isArray(actions) || actions.length > MAX_NOTIFICATION_ACTIONS) return `at most ${MAX_NOTIFICATION_ACTIONS} actions (stop is the host's, on top)`
      const ids = new Set<string>()
      for (const a of actions) {
        if (typeof a !== "object" || a === null || typeof a.id !== "string" || !NOTIFICATION_ACTION_ID.test(a.id)) return `an action id must match ${NOTIFICATION_ACTION_ID}`
        if (a.id === STOP_ACTION) return "stop is the host's action: it is on every notification already"
        if (ids.has(a.id)) return `the action ${a.id} is named twice`
        ids.add(a.id)
        const labelWrong = lineProblem(a.label, MAX_NOTIFICATION_LABEL_CHARS, `the label of ${a.id}`)
        if (labelWrong !== undefined) return labelWrong
      }
      if (actions.length > 0 && r.handler === undefined) return "actions need a handler (notify.handle)"
      if (r.handler !== undefined) {
        if (typeof r.handler !== "string" || !NOTIFY_HANDLER_NAME.test(r.handler)) return `handler must match ${NOTIFY_HANDLER_NAME}`
        if (!known.has(`${moduleId}/${r.handler}`)) return `${moduleId} has no action handler "${r.handler}" (register it in shared with notify.handle)`
      }
      if (r.at !== undefined && r.inMs !== undefined) return "give at or inMs, not both"
      if (r.at !== undefined && (!Number.isInteger(r.at) || r.at < 0)) return "at is a time in epoch ms"
      if (r.inMs !== undefined && (!Number.isInteger(r.inMs) || r.inMs < 0 || r.inMs > MAX_LATER_MS)) return `inMs is a whole number of ms from 0 to ${MAX_LATER_MS}`
      return undefined
    }

    const send = (moduleId: string) => (request: NotifyRequest): Effect.Effect<SendResult, NotifyError> =>
      Effect.gen(function*() {
        const problem = requestProblem(moduleId, request)
        if (problem !== undefined) return yield* invalid(problem)
        const deviceId = yield* originDevice
        const target = request.target ?? "origin"
        if (target === "origin" && deviceId === undefined) return yield* invalid("this call has no origin device (a turn, a job or a press made for one): send it everywhere instead")
        const now = yield* Clock.currentTimeMillis
        const due = request.at ?? (request.inMs !== undefined ? now + request.inMs : now)
        if (due > now + MAX_LATER_MS) return yield* invalid(`a notification is sent at most ${MAX_LATER_MS / 3_600_000} hours ahead`)
        const later = due > now
        const priority = request.priority ?? "normal"
        const sentAt = later ? due : now
        const fields: Fields = {
          module: moduleId,
          state: later ? "scheduled" : "open",
          ...(request.key !== undefined ? { key: request.key } : {}),
          title: request.title,
          ...(request.text !== undefined && request.text !== "" ? { text: request.text } : {}),
          priority,
          ...(request.owner !== undefined ? { owner: request.owner } : {}),
          target,
          ...(target === "origin" && deviceId !== undefined ? { deviceId } : {}),
          actions: (request.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
          ...(request.handler !== undefined ? { handler: request.handler } : {}),
          sentAt,
          expiresAt: sentAt + (request.expiresInMs ?? DEFAULT_EXPIRY_MS[priority])
        }
        const id = newId()
        // The service's jobs: prepared outside, written in the same transaction as the row (both or neither).
        const expiry = yield* jobs.prepare({ handler: "expire", key: `x:${id}`, payload: { id }, at: fields.expiresAt, origin: {} }).pipe(Effect.mapError(notifyFailure))
        const deliver = later ? yield* jobs.prepare({ handler: "deliver", key: `d:${id}`, payload: { id }, at: due, origin: {} }).pipe(Effect.mapError(notifyFailure)) : undefined
        const out = yield* tx(({ n, tx: t }): { readonly _tag: "deduped"; readonly row: Row<StoredNotification> } | { readonly _tag: "limit"; readonly message: string } | { readonly _tag: "sent"; readonly row: Row<StoredNotification> } => {
          if (fields.key !== undefined) {
            const same = (n.list({ where: { dedupe: `${moduleId}|${fields.key}` }, limit: 1 }) as ReadonlyArray<Row<StoredNotification>>)[0]
            if (same !== undefined) return { _tag: "deduped", row: same }
          }
          const counts = t.collection(notifyCounts)
          if ((counts.get(`m:${moduleId}`)?.value.live ?? 0) >= MAX_OPEN_PER_MODULE) return { _tag: "limit", message: `${moduleId} has ${MAX_OPEN_PER_MODULE} live notifications already` }
          if ((counts.get("total")?.value.live ?? 0) >= MAX_OPEN_TOTAL) return { _tag: "limit", message: `${MAX_OPEN_TOTAL} notifications are live already` }
          const row = n.insert(withIndexes(fields), { id }) as Row<StoredNotification>
          bump(t, moduleId, 1)
          expiry.writeIn(t)
          deliver?.writeIn(t)
          if (!later) t.afterCommit(() => enqueueId(id))
          return { _tag: "sent", row }
        })
        if (out._tag === "limit") return yield* new NotifyError({ reason: "limit", message: out.message })
        const view = notificationView(out.row)
        rows.set(view, out.row)
        return { notification: view, deduped: out._tag === "deduped" }
      })

    /** The row behind a view `list` or `send` returned (for `after`). */
    const rows = new WeakMap<Notification, Row<StoredNotification>>()

    const list = (moduleId: string) => (query: NotifyListQuery = {}): Effect.Effect<ReadonlyArray<Notification>, NotifyError> =>
      Effect.gen(function*() {
        const limit = query.limit ?? MAX_NOTIFY_PAGE
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTIFY_PAGE) return yield* invalid(`limit is 1 to ${MAX_NOTIFY_PAGE}`)
        const after = query.after === undefined ? undefined : rows.get(query.after)
        if (query.after !== undefined && after === undefined) return yield* invalid("after must be a notification list or send returned")
        const page = yield* core.collection(notifications).list({ where: { liveModule: moduleId }, orderBy: { field: "sentAt" }, limit, ...(after !== undefined ? { after } : {}) }).pipe(
          Effect.mapError(notifyFailure)
        )
        return page.map((row) => {
          const view = notificationView(row)
          rows.set(view, row)
          return view
        })
      })

    const resolve = (moduleId: string) => (target: string | { readonly key: string }, outcome = "resolved"): Effect.Effect<boolean, NotifyError> =>
      Effect.gen(function*() {
        if (typeof outcome !== "string" || !OUTCOME.test(outcome) || outcome === STOP_ACTION || outcome === "expired") return yield* invalid("outcome is 1 to 40 letters, digits and _ . -, not stop or expired (the host's)")
        if (typeof target === "object" && target !== null) {
          if (typeof target.key !== "string" || !NOTIFY_KEY.test(target.key)) return yield* invalid(`key must match ${NOTIFY_KEY}`)
          const same = yield* core.collection(notifications).list({ where: { dedupe: `${moduleId}|${target.key}` }, limit: 1 }).pipe(Effect.mapError(notifyFailure))
          return same[0] === undefined ? false : yield* resolveRow(same[0].id, outcome, "module", moduleId)
        }
        if (typeof target !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(target)) return false
        return yield* resolveRow(target, outcome, "module", moduleId)
      })

    // ---- Do not disturb

    const dndGet: Effect.Effect<DndState, NotifyError> = Effect.gen(function*() {
      const row = yield* core.collection(notifyDnd).get("house").pipe(Effect.mapError(notifyFailure))
      return row === undefined || !row.value.on ? { on: false } : { on: true, ...(row.value.until !== undefined ? { until: row.value.until } : {}) } satisfies DndState
    })

    const dndWrite = (state: DndState) =>
      Effect.gen(function*() {
        const at = yield* Clock.currentTimeMillis
        const end = state.on && state.until !== undefined
          ? yield* jobs.prepare({ handler: "dnd-end", key: "dnd", payload: { until: state.until }, at: state.until, origin: {} }).pipe(Effect.mapError(notifyFailure))
          : undefined
        yield* tx(({ tx: t }) => {
          const d = t.collection(notifyDnd)
          const value = { on: state.on, ...(state.on && state.until !== undefined ? { until: state.until } : {}), setAt: at }
          if (d.get("house") === undefined) d.insert(value, { id: "house" })
          else d.update("house", () => value)
          end?.writeIn(t)
          t.afterCommit(() => {
            dndNow = state.on ? { on: true, ...(state.until !== undefined ? { until: state.until } : {}) } : { on: false }
            if (end === undefined) fork(Effect.ignore(jobs.cancel({ key: "dnd" })))
            // What rings follows do not disturb: every open notification is delivered again, silent or not.
            enqueueAll()
          })
        })
        return dndNow
      })

    const dndSet = (o: { readonly until?: number } = {}) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        if (o.until !== undefined && (!Number.isInteger(o.until) || o.until <= now || o.until > now + MAX_DND_MS)) return yield* invalid(`until is a time after now, at most ${MAX_DND_MS / 3_600_000} hours ahead`)
        return yield* dndWrite(o.until === undefined ? { on: true } : { on: true, until: o.until })
      })

    // ---- Presses

    const answer = (ok: boolean, key: Parameters<typeof notifyText>[1], code?: PressAnswer["code"]): PressAnswer => ({ ok, say: notifyText(lang(), key), ...(code !== undefined ? { code } : {}) })

    const press = (request: PressRequest): Effect.Effect<PressAnswer> =>
      Effect.gen(function*() {
        const row = yield* core.collection(notifications).get(request.notificationId).pipe(Effect.orElseSucceed(() => undefined))
        if (row === undefined || row.value.state !== "open") {
          // Ended meanwhile (or never here): the card goes from this device; nothing else changes.
          const here = shown.get(request.deviceId)
          if (here?.has(request.notificationId) === true) ended(request.notificationId, row?.value.outcome ?? "resolved")
          else sendTo(request.deviceId, { type: "notification.resolved", id: request.notificationId })
          return answer(request.actionId === STOP_ACTION, "over", request.actionId === STOP_ACTION ? undefined : "unknown")
        }
        const v = row.value
        if (v.target !== "everywhere" && v.deviceId !== request.deviceId) return answer(false, "cantNow", "unknown")
        if (request.actionId === STOP_ACTION) {
          // The host's: always works, whatever the module is doing.
          yield* resolveRow(row.id, STOP_ACTION, request.deviceId).pipe(Effect.orElseSucceed(() => false))
          return answer(true, "done")
        }
        if (!v.actions.some((a) => a.id === request.actionId) || v.handler === undefined) return answer(false, "cantNow", "unknown")
        const entry = published.get(`${v.module}/${v.handler}`)
        if (entry === undefined) return answer(false, "cantNow", "not_running")
        const principal: Principal = {
          _tag: "notification",
          notification: {
            notificationId: row.id,
            deviceId: request.deviceId,
            ...(request.connection !== undefined ? { connection: request.connection } : {}),
            ...(request.person !== undefined ? { person: request.person } : {})
          }
        }
        const pressInfo: ActionPress = { notificationId: row.id, actionId: request.actionId, ...(v.key !== undefined ? { key: v.key } : {}), deviceId: request.deviceId }
        const body = asPrincipal(
          principal,
          Effect.gen(function*() {
            const gateway = options.gateway()
            if (gateway !== undefined) {
              const admitted = yield* gateway.principal
              if ("refused" in admitted) return yield* Effect.fail(new NotifyError({ reason: "invalid", message: `Not run: ${admitted.refused}` }))
            }
            return yield* Effect.suspend(() => entry.handler.run(pressInfo))
          })
        ).pipe(Effect.timeoutOrElse({ duration: NOTIFY_ACTION_TIMEOUT_MS, orElse: () => Effect.fail(new NotifyError({ reason: "failed", message: "the handler did not finish in time" })) }))
        const exit = yield* Effect.exit(entry.runner.inFlight(() => body))
        if (Exit.isFailure(exit)) {
          const stopped = exit.cause.reasons.some((r) => (Cause.isFailReason(r) && isModuleStopped(r.error)) || (Cause.isDieReason(r) && isModuleStopped(r.defect)))
          log(`Notifications: the action ${request.actionId} of ${v.module} ${stopped ? "could not run: its module stopped" : `failed: ${Cause.pretty(exit.cause).split("\n")[0]}`}`)
          return stopped ? answer(false, "cantNow", "not_running") : answer(false, "failed", "failed")
        }
        const said = exit.value as ActionAnswer | void
        if (said?.keepOpen !== true) yield* resolveRow(row.id, request.actionId, request.deviceId).pipe(Effect.orElseSucceed(() => false))
        const text = said?.say === undefined ? "" : options.pageText(v.module, said.say, MAX_ANSWER_CHARS)
        return { ok: true, say: text === "" ? notifyText(lang(), "done") : text }
      })

    // ---- Speech

    const queues = new Map<string, DeviceQueue>()
    const queueOf = (deviceId: string) => {
      let q = queues.get(deviceId)
      if (q === undefined) {
        q = { items: [], current: undefined, running: false }
        queues.set(deviceId, q)
      }
      return q
    }

    const decideAnnouncement = (id: string, d: KnownDevice, owner: string | undefined): Delivery => {
      const decision = decideDelivery({
        kind: "announcement",
        priority: "normal",
        personal: owner !== undefined,
        mayReveal: owner === undefined ? true : options.privacy.mayReveal(owner, d.id),
        dnd: dndNow.on,
        device: deviceFacts(d)
      })
      decided({ kind: "announcement", id, deviceId: d.id, decision })
      return decision
    }

    const finish = (item: SpeechItem, outcome: SpeechDeviceOutcome) => void Deferred.doneUnsafe(item.done, Effect.succeed(outcome))

    /** One announcement on its device: wait until nothing is spoken there, decide again (now), then play it. */
    const speakItem = (item: SpeechItem): Effect.Effect<SpeechDeviceOutcome> =>
      Effect.gen(function*() {
        const port = options.speech()
        if (port === undefined) return { deviceId: item.deviceId, outcome: "failed", why: "no speech here" } satisfies SpeechDeviceOutcome
        yield* port.quiet(item.deviceId)
        const device = options.devices().find((d) => d.id === item.deviceId)
        const decision: Delivery = device === undefined ? { deliver: false, why: "offline" } : decideAnnouncement(item.handleId, device, item.owner)
        if (!decision.deliver) return { deviceId: item.deviceId, outcome: "skipped", why: decision.why } satisfies SpeechDeviceOutcome
        const exit = yield* Effect.exit(port.play(item.deviceId, item.text, { cue: item.cue }))
        if (Exit.isSuccess(exit)) return { deviceId: item.deviceId, outcome: "spoken" } satisfies SpeechDeviceOutcome
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
        const message = String((Cause.squash(exit.cause) as { readonly message?: unknown })?.message ?? "")
        // A reply took the speaker: the announcement was cut, the reply plays.
        if (message === "superseded") return { deviceId: item.deviceId, outcome: "stopped", why: "a reply" } satisfies SpeechDeviceOutcome
        return { deviceId: item.deviceId, outcome: "failed", why: message.slice(0, 200) || "the audio failed" } satisfies SpeechDeviceOutcome
      })

    const runQueue = (deviceId: string, q: DeviceQueue): Effect.Effect<void> =>
      Effect.gen(function*() {
        for (;;) {
          const item = q.items.shift()
          if (item === undefined) {
            q.running = false
            return
          }
          const fiber = yield* Effect.forkChild(speakItem(item))
          q.current = { item, fiber }
          const exit = yield* Fiber.await(fiber)
          q.current = undefined
          finish(item, Exit.isSuccess(exit) ? exit.value : { deviceId, outcome: "stopped" })
        }
      }).pipe(Effect.ensuring(Effect.sync(() => {
        q.running = false
        q.current = undefined
      })))

    const startQueue = (deviceId: string) => {
      const q = queueOf(deviceId)
      if (q.running) return
      q.running = true
      fork(runQueue(deviceId, q))
    }

    const stopItems = (match: (item: SpeechItem) => boolean): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        let any = false
        for (const [deviceId, q] of queues) {
          for (let i = q.items.length - 1; i >= 0; i--) {
            const item = q.items[i]!
            if (!match(item)) continue
            q.items.splice(i, 1)
            finish(item, { deviceId, outcome: "stopped" })
            any = true
          }
          const current = q.current
          if (current !== undefined && match(current.item)) {
            any = true
            yield* Fiber.interrupt(current.fiber)
          }
        }
        return any
      })

    const say = (_moduleId: string) => (target: SpeechTarget, text: string, o: SpeechOptions = {}): Effect.Effect<SpeechHandle, SpeechError> =>
      Effect.gen(function*() {
        if (typeof text !== "string" || text.trim() === "" || text.length > MAX_SPEECH_CHARS || !NOTIFY_TEXT.test(text)) {
          return yield* new SpeechError({ reason: "invalid", message: `an announcement is 1 to ${MAX_SPEECH_CHARS} characters of text, without control characters` })
        }
        if (o.owner !== undefined && (typeof o.owner !== "string" || !PERSON_ID.test(o.owner))) return yield* new SpeechError({ reason: "invalid", message: "owner is a Members id" })
        const all = options.devices()
        const devices = target === "everywhere"
          ? all
          : typeof target === "object" && target !== null && "device" in target
          ? all.filter((d) => d.id === target.device)
          : typeof target === "object" && target !== null && "room" in target && typeof target.room === "string"
          ? all.filter((d) => d.room !== undefined && sameRoom(d.room, target.room))
          : undefined
        if (devices === undefined) return yield* new SpeechError({ reason: "invalid", message: "target is { device }, { room } or \"everywhere\"" })
        if (devices.length === 0) return yield* new SpeechError({ reason: "no-device", message: "the target names no known device" })
        const id = newId()
        const items: Array<SpeechItem> = []
        const deliveries: Array<SpeechDelivery> = []
        const skipped: Array<SpeechDeviceOutcome> = []
        for (const d of devices) {
          const decision = decideAnnouncement(id, d, o.owner)
          if (!decision.deliver) {
            deliveries.push({ deviceId: d.id, queued: false, why: decision.why })
            skipped.push({ deviceId: d.id, outcome: "skipped", why: decision.why })
            continue
          }
          const q = queueOf(d.id)
          if (q.items.length >= MAX_SPEECH_QUEUE) {
            deliveries.push({ deviceId: d.id, queued: false, why: "busy" satisfies NotDelivered })
            skipped.push({ deviceId: d.id, outcome: "skipped", why: "busy" })
            continue
          }
          const item: SpeechItem = { handleId: id, deviceId: d.id, text, cue: o.cue === true, owner: o.owner, done: Deferred.makeUnsafe<SpeechDeviceOutcome>() }
          q.items.push(item)
          items.push(item)
          deliveries.push({ deviceId: d.id, queued: true })
          startQueue(d.id)
        }
        const done: SpeechHandle["done"] = Effect.flatMap(CurrentTurn, (turn) =>
          turn !== undefined
            ? Effect.fail(new SpeechError({ reason: "in-turn", message: "a tool or action of a turn cannot wait for an announcement: the reply it belongs to is what the announcement waits for" }))
            : Effect.map(Effect.forEach(items, (i) => Deferred.await(i.done)), (spoken) => [...spoken, ...skipped]))
        return {
          id,
          deliveries,
          done,
          stop: Effect.asVoid(stopItems((i) => i.handleId === id))
        } satisfies SpeechHandle
      })

    // ---- The service's jobs (core.notify): sending later, expiry, the end of do not disturb, retention

    const IdPayload = Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(64)) })
    yield* jobs.handle("deliver", {
      payload: IdPayload,
      idempotent: true,
      run: ({ id }) =>
        Effect.gen(function*() {
          const row = yield* core.collection(notifications).get(id)
          if (row === undefined || row.value.state !== "scheduled") return
          // The decision first (privacy and do not disturb now), then the delivery record, then the messages: a
          // failure to write the record sends nothing, and the job is run again.
          const next = withIndexes({ ...fieldsOf(row.value), state: "open" })
          const plan = targetsOf(next).map((d) => ({ deviceId: d.id, decision: decideNotification(id, next, d) }))
          const committed = yield* tx(({ n }) => n.update(id, () => next, { expectRev: row.rev }) as Row<StoredNotification>)
          apply(id, committed.value, plan)
        })
    }).pipe(Effect.orDie)
    yield* jobs.handle("expire", {
      payload: IdPayload,
      idempotent: true,
      run: ({ id }) => Effect.asVoid(resolveRow(id, "expired", "expiry"))
    }).pipe(Effect.orDie)
    yield* jobs.handle("dnd-end", {
      payload: Schema.Struct({ until: Schema.Finite }),
      idempotent: true,
      run: ({ until }) =>
        Effect.gen(function*() {
          const now = yield* dndGet
          if (now.on && now.until === until) yield* dndWrite({ on: false })
        })
    }).pipe(Effect.orDie)
    yield* jobs.handle("retention", {
      payload: Schema.Struct({}),
      idempotent: true,
      run: () =>
        Effect.gen(function*() {
          const cutoff = (yield* Clock.currentTimeMillis) - KEEP_RESOLVED_MS
          for (let removed = 0; removed < RETENTION_ROWS;) {
            // Oldest resolved first; one bounded transaction per page, a yield between.
            const gone = yield* tx(({ n }) => {
              const page = n.list({ where: { state: "resolved" }, orderBy: { field: "finishedAt" }, limit: MAX_NOTIFY_PAGE }) as ReadonlyArray<Row<StoredNotification>>
              const old = page.filter((r) => (r.value.finishedAt ?? 0) < cutoff)
              for (const r of old) n.remove(r.id)
              return { old: old.length, full: old.length === page.length && page.length === MAX_NOTIFY_PAGE }
            })
            removed += gone.old
            if (!gone.full) return
            yield* Effect.yieldNow
          }
        })
    }).pipe(Effect.orDie)
    yield* jobs.schedule({ handler: "retention", key: "retention", cron: RETENTION_CRON, origin: {} }).pipe(
      Effect.catch((e) => Effect.sync(() => log(`Notifications: the retention job could not be scheduled (${e.message})`)))
    )

    // ---- Start: do not disturb, the live counters recounted, the delivery fiber

    yield* loadDnd
    yield* Effect.gen(function*() {
      const perModule = new Map<string, number>()
      let total = 0
      for (const state of ["scheduled", "open"] as const) {
        let after: Row<StoredNotification> | undefined
        for (let read = 0; read < SWEEP_ROWS;) {
          const page = yield* core.collection(notifications).list({ where: { state }, orderBy: { field: "sentAt" }, limit: MAX_NOTIFY_PAGE, ...(after !== undefined ? { after } : {}) })
          for (const row of page) {
            perModule.set(row.value.module, (perModule.get(row.value.module) ?? 0) + 1)
            total++
          }
          read += page.length
          if (page.length < MAX_NOTIFY_PAGE) break
          after = page[page.length - 1]
        }
      }
      yield* core.transaction((t) => {
        const c = t.collection(notifyCounts)
        for (const row of c.list({ limit: 100 })) if (row.id !== "total" && !perModule.has(row.id.slice(2))) c.update(row.id, () => ({ live: 0 }))
        const put = (key: string, live: number) => (c.get(key) === undefined ? c.insert({ live }, { id: key }) : c.update(key, () => ({ live })))
        put("total", total)
        for (const [m, n] of perModule) put(`m:${m}`, n)
      })
    }).pipe(Effect.catch((e) => Effect.sync(() => log(`Notifications: the live counters could not be recounted (${notifyFailure(e).message})`))))
    yield* Effect.forkIn(loop, scope)

    // ---- The module host's side

    const forPart: NotifyHook["forPart"] = (part: PartHandle, runner: PartRunner) => {
      const moduleId = part.moduleId
      const handle = (name: string, handler: NotifyActionHandler): Effect.Effect<void, NotifyError> =>
        Effect.suspend(() => {
          if (typeof name !== "string" || !NOTIFY_HANDLER_NAME.test(name)) return Effect.fail(invalid(`an action handler's name must match ${NOTIFY_HANDLER_NAME}`))
          if (typeof handler !== "object" || handler === null || typeof handler.run !== "function") return Effect.fail(invalid("an action handler has a run function"))
          const key = `${moduleId}/${name}`
          const entry: PublishedHandler = { moduleId, name, handler, runner }
          const registered = part.register({
            kind: "notify-action-handler",
            validate: () => ((known.get(key) ?? 0) > 1 ? `${moduleId} registers the action handler "${name}" twice` : undefined),
            publish: () => void published.set(key, entry),
            withdraw: () => void (published.get(key) === entry && published.delete(key))
          })
          if (!registered.ok) return Effect.fail(new NotifyError({ reason: "invalid", message: registered.reason }))
          known.set(key, (known.get(key) ?? 0) + 1)
          return Scope.addFinalizer(part.scope, Effect.sync(() => {
            const n = (known.get(key) ?? 1) - 1
            if (n <= 0) known.delete(key)
            else known.set(key, n)
          }))
        })
      const notify: ModuleNotify = {
        send: send(moduleId),
        resolve: resolve(moduleId),
        list: list(moduleId),
        handle,
        dnd: { get: dndGet, set: dndSet, clear: dndWrite({ on: false }) }
      }
      const speech: ModuleSpeech = { say: say(moduleId) }
      return { notify, speech }
    }

    const engine: NotifyEngine = {
      forPart,
      connected: (deviceId, via) => {
        pendingDevices.push(via === undefined ? { deviceId } : { deviceId, send: via })
        kick()
      },
      disconnected: (deviceId) => {
        const here = shown.get(deviceId)
        shown.delete(deviceId)
        if (here !== undefined && [...here.values()].some(isRinging)) ringingChanged(deviceId)
      },
      press,
      ringingOn: (deviceId) =>
        [...(shown.get(deviceId)?.values() ?? [])]
          .filter(isRinging)
          .sort((a, b) => a.sentAt - b.sentAt)
          .map((s) => ({ id: s.id, module: s.module, title: s.title, actions: s.actions })),
      stopRinging: (deviceId) =>
        Effect.gen(function*() {
          const ids = [...(shown.get(deviceId)?.values() ?? [])].filter(isRinging).map((s) => s.id)
          let n = 0
          for (const id of ids) if (yield* resolveRow(id, STOP_ACTION, deviceId).pipe(Effect.orElseSucceed(() => false))) n++
          return n
        }),
      stopSpeech: (deviceId) => stopItems((i) => i.deviceId === deviceId),
      onRingingChanged: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      dnd: () => dndNow,
      settled: Effect.gen(function*() {
        for (let i = 0; i < 5_000 && (working || pendingAll || pendingIds.size > 0 || pendingDevices.length > 0); i++) yield* Effect.yieldNow
      })
    }
    return engine
  })

