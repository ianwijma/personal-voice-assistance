import { MAX_NOTIFICATION_CARDS, sameRoom, type ServerMessageOf } from "@pva/protocol"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Schema, Scope } from "effect"
import type { KnownDevice } from "./Devices.ts"
import { asPrincipal, type ExecutionGateway } from "./Gateway.ts"
import { HOUSEHOLD_SCOPE, type HouseholdStore, type Row, type StoreFailure, type StoreTx, type TxCollection, type TxResult } from "./HouseholdStore.ts"
import type { IssueRegistry } from "./Issues.ts"
import { isModuleStopped } from "./ModuleApi.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import {
  type ActionAnswer,
  type ActionPress,
  CLAIM_RELEASE_MS,
  decideDelivery,
  DEFAULT_EXPIRY_MS,
  type Delivery,
  type DeviceOutputs,
  type DndState,
  KEEP_RESOLVED_MS,
  lineProblem,
  DUE_HANDLER,
  HOURLY_CRON,
  HOURLY_HANDLER,
  MAINTENANCE_ROWS,
  RETRY_AFTER_MS,
  MAX_ANSWER_CHARS,
  MAX_DND_MS,
  MAX_EXPIRY_MS,
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
  NOTIFY_ACTION_TIMEOUT_MS,
  NOTIFY_HANDLER_NAME,
  NOTIFY_KEY,
  NOTIFY_OWNER,
  NOTIFY_TEXT,
  notifyCounts,
  notifyDnd,
  NotifyError,
  type NotifyHook,
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
import { notifyText, type NotifyLanguage, type NotifyTextKey } from "./NotifyTexts.ts"
import type { PrivacyService } from "./Privacy.ts"
import type { PartRunner } from "./Scheduler.ts"
import type { SchedulerEngine } from "./SchedulerEngine.ts"
import { CurrentJob, CurrentPrincipal, CurrentTurn, type Principal } from "./TurnContext.ts"

/**
 * The notification service (docs/NOTIFICATIONS.md; the contract is `Notify.ts`). One per server: serve mode makes it on
 * the household store and the scheduler engine before the module host, and the module test kit on its in-memory store
 * and test clock. Nothing of it runs on a turn's path except `send` (one synchronous transaction and an enqueue),
 * `resolve` and `say` (an enqueue).
 *
 * - **Reconciliation** (`reconcile`) is the only thing that sends `notification.ring` and `notification.resolved`.
 *   Per connection it keeps what was sent; a pass over a device reads a page of open rows, decides and sends in one
 *   synchronous step (the store's synchronous reader), yields, and ends with a step that reads every card the device's
 *   connections hold that the pass did not see, again deciding and sending in the same step. So no send rests on a row
 *   or a decision from before a wait. Passes run one at a time in one fiber; a pass that fails marks its device, and
 *   the next trigger or the maintenance work repeats it.
 * - **Maintenance** has two jobs under `core.notify`: `due`, one-shot, which `plan()` keeps set to the next thing that is
 *   due (an expiry, do not disturb's end, retention, a stale claim, a failed pass; none when nothing is), and `hourly`,
 *   the safety net that repairs a lost plan within the hour.
 * - **A press** is admitted only for a connection (or device) that holds the notification and that the decision still
 *   allows; a module action is claimed on the row in one transaction first.
 */

/** A message for one voice connection. */
export type NotifyMessage = ServerMessageOf<"notification.ring"> | ServerMessageOf<"notification.resolved">

/** One voice connection of a device (serve mode: the hub's). `id` is stable while it is open. */
export interface NotifyConnection {
  readonly id: string
  readonly send: (message: NotifyMessage) => void
}

/** The voice pages (serve mode: the hub). */
export interface NotifyOutlet {
  /** The device's voice connections that said hello, now. */
  readonly connections: (deviceId: string) => ReadonlyArray<NotifyConnection>
}

/** What the port's gate answers just before audio starts: play now, wait for quiet again, or why it is not spoken. */
export type SpeechGateAnswer = "go" | "wait" | NotDelivered

/**
 * The voice of a device, for announcements (serve mode: its voice session). `speak` makes the voice ready first, then
 * waits until nothing is spoken or heard there and asks `gate()` in the same synchronous step as it takes the output
 * (never from a reply: a reply that holds it means "wait again"); it answers `spoken` when the line was played, or the
 * gate's reason. Interrupting it silences it at once. A reply that starts while it plays takes the speaker (it fails
 * with an `AudioError` "superseded").
 */
export interface SpeechPort {
  readonly speak: (deviceId: string, text: string, options: { readonly cue: boolean; readonly gate: () => SpeechGateAnswer }) => Effect.Effect<"spoken" | { readonly skipped: NotDelivered }, unknown>
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
  /** The scheduler: the service's one job (`forCore("core.notify")`). */
  readonly scheduler: SchedulerEngine
  /** The known devices (`Devices.list`): rooms, places. */
  readonly devices: () => ReadonlyArray<KnownDevice>
  /** A device's effective outputs now (serve mode: `DeviceFacts.outputsOf`, from `deviceOutputsFrom`). */
  readonly outputs: (device: KnownDevice) => DeviceOutputs
  /** The privacy rule, asked at each delivery for the device that would show or speak it. */
  readonly privacy: PrivacyService
  /** Late-bound: the voice pages (the hub). Absent: nobody is connected. */
  readonly outlet: () => NotifyOutlet | undefined
  /** Late-bound: the devices' voices. Absent: announcements are `failed`. */
  readonly speech: () => SpeechPort | undefined
  /** Late-bound: the execution gateway that admits a press's notification principal. Absent: not checked (tests). */
  readonly gateway: () => ExecutionGateway | undefined
  /** The page boundary (`ModuleHost.pageText`): a module's text on its way to a page or a voice. */
  readonly pageText: (moduleId: string, text: unknown, max: number) => string
  /** The household's language now. */
  readonly language: () => NotifyLanguage
  /** Where the service's own Health issue goes (the maintenance job could not be scheduled). */
  readonly issues?: IssueRegistry
  readonly log?: (line: string) => void
  /** Ids (tests). Default random. */
  readonly newId?: () => string
  /** Every decision made (must not throw). */
  readonly onDecision?: (record: DecisionRecord) => void
  /**
   * Measurements (tests): one reconciliation step's wall time and its size; one retention transaction and how many rows
   * it removed. Must not throw.
   */
  readonly observe?: (
    event: { readonly kind: "step"; readonly ms: number; readonly rows: number; readonly connections: number } | { readonly kind: "retention"; readonly removed: number }
  ) => void
  /**
   * The wall clock (epoch ms) for what is stored and compared with stored times: sending, expiry, do not disturb's end,
   * durable claims, retention. Default `wallNow`. Monotonic waits (a handler's time limit, retries) never
   * use it. Tests move it independently of monotonic time.
   */
  readonly now?: Effect.Effect<number>
  /** Pauses before writing a press's outcome again when the store fails. Default 100, 400, 1600 ms. */
  readonly outcomeRetryMs?: ReadonlyArray<number>
}

export interface NotifyEngine extends NotifyHook {
  /** Reconcile a device: it said hello, left, changed its declaration or its outputs (one trigger; passes are queued). */
  readonly reconcile: (deviceId: string) => void
  /** Reconcile every device that has a connection or holds a card. */
  readonly reconcileAll: () => void
  /** A press of a card's button (or, later, a ringing phrase), admitted only where the notification is held. */
  readonly press: (request: PressRequest) => Effect.Effect<PressAnswer>
  /** P7: the notifications ringing on a device now (held with their cue by one of its connections), oldest first. */
  readonly ringingOn: (deviceId: string) => ReadonlyArray<RingingNotification>
  /**
   * P7: the host's "stop" for what rings on a device: each is resolved (`stop`). How many. Fails (`busy` or `failed`)
   * when a ring it found could not be stopped (the store failed, or another action of it was under way), after trying
   * every one: a zero is "nothing rang any more", never a failure.
   */
  readonly stopRinging: (deviceId: string) => Effect.Effect<number, NotifyError>
  /** P7 and the page's Stop: stop the announcement being spoken (or about to be) on a device, at once. Whether there was one. */
  readonly stopSpeech: (deviceId: string) => Effect.Effect<boolean>
  /** P7: called (synchronously, never throwing into the engine) when what rings on a device changed. */
  readonly onRingingChanged: (listener: (deviceId: string) => void) => () => void
  /** Do not disturb as the engine holds it now (`known: false`: not read yet, so it counts as on). */
  readonly dnd: () => DndState & { readonly known: boolean }
  /** Whether the hourly safety-net job is scheduled. */
  readonly maintenanceScheduled: () => boolean
  /** When the `due` job is planned for (as far as this process knows); `undefined`: nothing is due. */
  readonly plannedAt: () => number | undefined
  /** Plan again now and wait for it (tests; every state change does this by itself). */
  readonly planNow: Effect.Effect<void>
  /** Run the maintenance work now (tests; the `due` and `hourly` jobs do the same). */
  readonly maintainNow: Effect.Effect<void, NotifyError>
  /** The answer to a press refused because too much is pending at once (the hub's admission bound), in the household's language. */
  readonly busyAnswer: () => PressAnswer
  /** Tests: completes once nothing is waiting to be reconciled (after at most a few thousand yields). */
  readonly settled: Effect.Effect<void>
}

// ---------------------------------------------------------------------------------------------------------------------

const randomId = () => `n-${crypto.randomUUID().replace(/-/g, "")}`
const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const OUTCOME = /^[A-Za-z0-9_.-]{1,40}$/
/** A sweep never reads more than this many rows (a corrupt store cannot make it unbounded). */
const SWEEP_ROWS = 20 * MAX_NOTIFY_PAGE
const ISSUE_SOURCE = "core.notify"

type Fields = Omit<StoredNotification, "dedupe" | "liveModule">

const withIndexes = (f: Fields): StoredNotification => {
  const { dedupe: _d, liveModule: _l, ...rest } = f as StoredNotification
  const live = f.state === "open"
  return { ...rest, ...(live && f.key !== undefined ? { dedupe: `${f.module}|${f.key}` } : {}), ...(live ? { liveModule: f.module } : {}) }
}

const fieldsOf = (v: StoredNotification): Fields => {
  const { dedupe: _d, liveModule: _l, ...rest } = v
  return rest
}

const withoutClaim = (f: Fields): Fields => {
  const { claim: _c, ...rest } = f
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

/** What one connection holds of one notification (what it was sent last). */
interface Held {
  /** The message it was sent, as JSON (an unchanged card is not sent again). */
  readonly fp: string
  readonly module: string
  readonly title: string
  readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly ring: boolean
  readonly sound: boolean
  readonly sentAt: number
}

interface HeldBy {
  readonly deviceId: string
  readonly send: (message: NotifyMessage) => void
  readonly cards: Map<string, Held>
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
    const outcomeRetryMs = options.outcomeRetryMs ?? [100, 400, 1_600]
    const wallNow: Effect.Effect<number> = options.now ?? Clock.currentTimeMillis
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

    /** The synchronous reader of `notifications` (throws when the store fails a read). */
    const reader = () => {
      const r = options.store.reader(NOTIFY_OWNER, notifications)
      if (r === undefined) throw new NotifyError({ reason: "unavailable", message: "the notification data is not usable here" })
      return r
    }
    const readRow = (id: string): Row<StoredNotification> | undefined => reader().get(id, HOUSEHOLD_SCOPE)

    // ---- Do not disturb: the committed row; until it has been read, it counts as on (silence is the safe side)

    let dndNow: DndState & { readonly known: boolean } = { on: true, known: false }
    const dndOf = (row: Row<{ readonly on: boolean; readonly until?: number }> | undefined): DndState =>
      row === undefined || !row.value.on ? { on: false } : { on: true, ...(row.value.until !== undefined ? { until: row.value.until } : {}) }
    /**
     * THE read of do not disturb: a successful read updates the engine's state (and reconciles every device when it
     * changed); a failed read, at start or later, makes it unknown, which counts as on (silence is the safe side), and
     * reconciles every device. A later successful read restores it.
     */
    const readDnd: Effect.Effect<DndState, NotifyError> = Effect.gen(function*() {
      const exit = yield* Effect.exit(core.collection(notifyDnd).get("house"))
      const before = dndNow
      if (Exit.isFailure(exit)) {
        dndNow = { on: true, known: false }
        if (before.known || !before.on) enqueueAll()
        requestPlan()
        log("Notifications: do not disturb could not be read; it counts as on until it can be read")
        return yield* Effect.failCause(Cause.map(exit.cause, notifyFailure))
      }
      const state = dndOf(exit.value)
      dndNow = { ...state, known: true }
      if (!before.known || before.on !== state.on) enqueueAll()
      if (!before.known) requestPlan()
      return state
    })
    const loadDnd = Effect.ignore(readDnd)

    // ---- What every connection holds

    const held = new Map<string, HeldBy>()
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
    const isRinging = (h: Held) => h.ring && h.sound
    const ringingKey = (deviceId: string) => {
      const ids = new Set<string>()
      for (const by of held.values()) if (by.deviceId === deviceId) for (const [id, h] of by.cards) if (isRinging(h)) ids.add(id)
      return [...ids].sort().join(",")
    }
    /** What rings on each device as last told to the listeners: a change against it is told, whenever it happens. */
    const reported = new Map<string, string>()
    const reportRinging = (deviceId: string) => {
      const key = ringingKey(deviceId)
      if ((reported.get(deviceId) ?? "") === key) return
      if (key === "") reported.delete(deviceId)
      else reported.set(deviceId, key)
      ringingChanged(deviceId)
    }
    const connectionsOf = (deviceId: string): ReadonlyArray<{ readonly id: string; readonly send: (m: NotifyMessage) => void }> => {
      try {
        return options.outlet()?.connections(deviceId) ?? []
      } catch {
        return []
      }
    }
    const deviceOf = (deviceId: string) => options.devices().find((d) => d.id === deviceId)
    const send = (by: HeldBy, message: NotifyMessage) => {
      try {
        by.send(message)
      } catch (e) {
        log(`Notifications: a message to ${by.deviceId} could not be sent (${String(e)})`)
      }
    }

    const cardOf = (id: string, v: StoredNotification, d: Extract<Delivery, { deliver: true }>): NotifyMessage => {
      const text = v.text === undefined ? undefined : options.pageText(v.module, v.text, MAX_NOTIFICATION_TEXT_CHARS)
      return {
        type: "notification.ring",
        notification: {
          id,
          title: options.pageText(v.module, v.title, MAX_NOTIFICATION_TITLE_CHARS),
          ...(text !== undefined && text !== "" ? { text } : {}),
          priority: v.priority,
          show: d.show,
          sound: d.sound,
          actions: [
            { id: STOP_ACTION, label: notifyText(lang(), "stop") },
            ...v.actions.map((a) => ({ id: a.id, label: options.pageText(v.module, a.label, MAX_NOTIFICATION_LABEL_CHARS) || a.id }))
          ],
          sentAt: v.sentAt,
          texts: { region: notifyText(lang(), "region"), startAudio: notifyText(lang(), "startAudio") }
        }
      }
    }

    const targets = (v: StoredNotification, deviceId: string) => v.target === "everywhere" || v.deviceId === deviceId

    /** THE decision for one notification on one device, now: privacy asked for that device at this moment. */
    const decideNotification = (id: string, v: StoredNotification, d: KnownDevice, connected: boolean): Delivery => {
      const outputs = options.outputs(d)
      const decision = decideDelivery({
        kind: "notification",
        priority: v.priority,
        personal: v.owner !== undefined,
        mayReveal: v.owner === undefined ? true : options.privacy.mayReveal(v.owner, d.id),
        dnd: dndNow.on,
        device: { connected, canSpeak: outputs.speak, canShow: outputs.show }
      })
      decided({ kind: "notification", id, deviceId: d.id, decision })
      return decision
    }

    /** What the device's connections should hold of the row now, and make them hold it. Synchronous. */
    /** Withdraw from one connection the cards it holds (other than `adding`) that are no longer open or allowed, read now. */
    const makeRoom = (deviceId: string, by: HeldBy, adding: string, device: KnownDevice | undefined, connected: boolean) => {
      for (const hid of [...by.cards.keys()]) {
        if (hid === adding) continue
        const row = readRow(hid)
        const v = row?.value
        const allowed = v !== undefined && v.state === "open" && device !== undefined && targets(v, deviceId) && decideNotification(hid, v, device, connected).deliver
        if (allowed) continue
        by.cards.delete(hid)
        send(by, { type: "notification.resolved", id: hid, outcome: v?.state === "resolved" ? v.outcome ?? "resolved" : "withdrawn" })
      }
    }

    const syncRow = (deviceId: string, bys: ReadonlyArray<HeldBy>, id: string, row: Row<StoredNotification> | undefined, device: KnownDevice | undefined) => {
      const v = row?.value
      const decision = v === undefined || v.state !== "open" || device === undefined || !targets(v, deviceId) ? undefined : decideNotification(id, v, device, bys.length > 0)
      for (const by of bys) {
        const before = by.cards.get(id)
        if (decision?.deliver === true && v !== undefined) {
          const message = cardOf(id, v, decision)
          const fp = JSON.stringify(message)
          if (before?.fp === fp) continue
          // At the page's bound, what it holds that has ended (or is no longer allowed) is withdrawn first, read now:
          // the page never holds more than the bound, so it never has to drop a live card to make room.
          if (before === undefined && by.cards.size >= MAX_NOTIFICATION_CARDS) makeRoom(deviceId, by, id, device, bys.length > 0)
          if (before === undefined && by.cards.size >= MAX_NOTIFICATION_CARDS) continue
          send(by, message)
          by.cards.set(id, { fp, module: v.module, title: v.title, actions: v.actions, ring: v.priority === "ring", sound: decision.sound, sentAt: v.sentAt })
        } else if (before !== undefined) {
          by.cards.delete(id)
          send(by, { type: "notification.resolved", id, outcome: v?.state === "resolved" ? v.outcome ?? "resolved" : "withdrawn" })
        }
      }
    }

    /** The device's connections now, with their bookkeeping; what closed connections held is dropped. */
    const heldOf = (deviceId: string): ReadonlyArray<HeldBy> => {
      const conns = connectionsOf(deviceId)
      const open = new Set(conns.map((c) => c.id))
      let dropped = false
      for (const [cid, by] of held) {
        if (by.deviceId === deviceId && !open.has(cid)) {
          held.delete(cid)
          dropped = true
        }
      }
      if (dropped) reportRinging(deviceId)
      return conns.map((c) => {
        let by = held.get(c.id)
        if (by === undefined || by.deviceId !== deviceId) {
          by = { deviceId, send: c.send, cards: new Map() }
          held.set(c.id, by)
        }
        return by
      })
    }

    /** One pass over a device: pages of open rows (read, decide, send in one step each), then what is held but unseen. */
    const passDevice = (deviceId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        const seen = new Set<string>()
        let after: Row<StoredNotification> | undefined
        for (let read = 0; read < SWEEP_ROWS;) {
          const last = yield* Effect.try(() => {
            const started = performance.now()
            const bys = heldOf(deviceId)
            if (bys.length === 0) return true
            try {
            const device = deviceOf(deviceId)
            const page = reader().list({ where: { state: "open" }, orderBy: { field: "sentAt" }, limit: MAX_NOTIFY_PAGE, scope: HOUSEHOLD_SCOPE, ...(after !== undefined ? { after } : {}) })
            for (const row of page) {
              if (!targets(row.value, deviceId)) continue
              seen.add(row.id)
              syncRow(deviceId, bys, row.id, row, device)
            }
            read += page.length
            after = page[page.length - 1]
            options.observe?.({ kind: "step", ms: performance.now() - started, rows: page.length, connections: bys.length })
            return page.length < MAX_NOTIFY_PAGE
            } finally {
              // What this step changed (the capacity clean-up too) is told now, also when a read in it failed.
              reportRinging(deviceId)
            }
          })
          if (last) break
          yield* Effect.yieldNow
        }
        // The cards held but not seen open in the pass: each read again now, decided and sent in this one step.
        yield* Effect.try(() => {
          const bys = heldOf(deviceId)
          const device = deviceOf(deviceId)
          const ids = new Set<string>()
          for (const by of bys) for (const id of by.cards.keys()) if (!seen.has(id)) ids.add(id)
          try {
            for (const id of ids) syncRow(deviceId, bys, id, readRow(id), device)
          } finally {
            reportRinging(deviceId)
          }
        })
      })

    // ---- The reconciliation fiber: coalesced devices, one pass at a time

    const dirty = new Set<string>()
    /** Devices whose last pass failed: repeated at the next trigger and by the maintenance job. */
    const failed = new Set<string>()
    /** Devices whose failed pass is being repeated: when it succeeds, the retry it planned is no longer needed. */
    const retrying = new Set<string>()
    let all = false
    let working = false
    const wake = yield* Queue.sliding<void>(1)
    const kick = () => {
      for (const id of failed) {
        dirty.add(id)
        retrying.add(id)
      }
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
    /** Every device that has a connection, or whose closed connections still hold something. */
    const everyDevice = () => {
      const ids = new Set<string>()
      for (const d of options.devices()) if (connectionsOf(d.id).length > 0) ids.add(d.id)
      for (const by of held.values()) ids.add(by.deviceId)
      return ids
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
          const exit = yield* Effect.exit(passDevice(next.value))
          if (Exit.isSuccess(exit)) {
            // Failed work drained: plan again, so a retry job that is no longer needed goes.
            if (retrying.delete(next.value)) requestPlan()
          } else {
            retrying.delete(next.value)
            failed.add(next.value)
            requestPlan()
            log(`Notifications: reconciling ${next.value} failed (${Cause.pretty(exit.cause).split("\n")[0]}); the next trigger or the maintenance job repeats it`)
          }
          yield* Effect.yieldNow
        }
        working = false
      }
    })

    /** The devices that hold a notification (to be reconciled when it changes). */
    const holdersOf = (id: string) => {
      const ids = new Set<string>()
      for (const by of held.values()) if (by.cards.has(id)) ids.add(by.deviceId)
      return ids
    }

    // ---- Rows

    /** Resolve an open row in the running transaction; after the commit, its holders are reconciled. */
    const resolveIn = (t: { readonly n: TxCollection<StoredNotification>; readonly tx: StoreTx }, row: Row<StoredNotification>, outcome: string, by: string, at: number) => {
      t.n.update(row.id, (v) => withIndexes({ ...withoutClaim(fieldsOf(v)), state: "resolved", outcome, finishedAt: at, resolvedBy: by }), { expectRev: row.rev })
      bump(t.tx, row.value.module, -1)
      t.tx.afterCommit(() => {
        for (const d of holdersOf(row.id)) dirty.add(d)
        kick()
        requestPlan()
      })
    }

    /** After a press's outcome that did not resolve (kept open, claim released): its holders reconciled, failed work repeated. */
    const afterOutcome = (t: StoreTx, id: string) =>
      t.afterCommit(() => {
        for (const d of holdersOf(id)) dirty.add(d)
        kick()
        requestPlan()
      })

    /** Resolve an open row (one transaction). False: not open (or not this module's). */
    const resolveRow = (id: string, outcome: string, by: string, onlyModule?: string): Effect.Effect<boolean, NotifyError> =>
      Effect.gen(function*() {
        const at = yield* wallNow
        return yield* tx((t) => {
          const row = t.n.get(id)
          if (row === undefined || row.value.state !== "open") return false
          if (onlyModule !== undefined && row.value.module !== onlyModule) return false
          resolveIn(t, row, outcome, by, at)
          return true
        })
      })

    /** The open counters: `total` and `m:<module>`, in the running transaction. */
    const bump = (t: StoreTx, module: string, delta: number) => {
      const c = t.collection(notifyCounts)
      for (const key of ["total", `m:${module}`]) {
        const row = c.get(key)
        const live = Math.max(0, (row?.value.live ?? 0) + delta)
        if (row === undefined) c.insert({ live }, { id: key })
        else c.update(key, () => ({ live }))
      }
    }

    // ---- Maintenance (D2b): a one-shot `due` job planned for the next thing that is due, and an hourly safety net

    /** Claims held by a press running in this process: notification id → the claim's `at`. Never released by wall time. */
    const alive = new Map<string, number>()
    /** A claim no run here holds is released once it is old by wall time, or dated in the future (the clock moved back). */
    const staleClaim = (id: string, claim: { readonly at: number } | undefined, now: number) =>
      claim !== undefined && alive.get(id) !== claim.at && (claim.at + CLAIM_RELEASE_MS <= now || claim.at > now)

    const issues = new Map<string, { readonly id: string; readonly severity: "warning"; readonly title: string; readonly detail: string }>()
    const setIssue = (key: string, issue: { readonly title: string; readonly detail: string } | undefined) => {
      if (issue === undefined) issues.delete(key)
      else issues.set(key, { id: `core.notify.${key}`, severity: "warning", ...issue })
      options.issues?.set(ISSUE_SOURCE, [...issues.values()])
    }

    let scheduled = false
    let scheduling = false
    /** The hourly safety net, scheduled by key; tried again at the next send or hello while it is not. */
    const ensureMaintenance = (): void => {
      if (scheduled || scheduling) return
      scheduling = true
      fork(
        // In UTC, whatever the household's zone: it counts elapsed hours, so the night the clocks go back cannot put
        // two hours between runs (module jobs keep the household's zone).
        jobs.schedule({ handler: HOURLY_HANDLER, key: HOURLY_HANDLER, cron: HOURLY_CRON, timeZone: "UTC", origin: {} }).pipe(
          Effect.match({
            onSuccess: () => {
              scheduled = true
              setIssue("maintenance", undefined)
            },
            onFailure: (e) => {
              log(`Notifications: the hourly maintenance job could not be scheduled (${e.message}); tried again at the next send or hello`)
              setIssue("maintenance", {
                title: "Notifications have no hourly maintenance yet",
                detail: "Its job could not be scheduled. It is tried again with the next notification or page; sending, stopping and the planned maintenance work meanwhile."
              })
            }
          }),
          Effect.ensuring(Effect.sync(() => void (scheduling = false)))
        )
      )
    }

    /**
     * What the `due` job is set to: a time, `undefined` (none: this process made it so), or `"unknown"` (at start, after
     * a schedule or cancel that failed, at the hourly run): never taken as proof that no job is stored.
     */
    let plannedAt: number | undefined | "unknown" = "unknown"
    let planning = false
    let planAgain = false
    /**
     * How the last maintenance run ended, kept apart: `"succeeded"` (whatever is overdue when it plans became due since,
     * or is the rest past its bound: planned for now) or `"failed"` (what is overdue is work that failed: a minute later,
     * never a tight loop); `undefined` once planned.
     */
    let lastRun: "succeeded" | "failed" | undefined
    const planIdle: Array<Deferred.Deferred<void>> = []

    /**
     * When maintenance is next needed: the earliest of the next expiry, the end of do not disturb (or a retry soon while
     * it is unknown), the time the oldest resolved row leaves retention, the time a stale claim may be released, and a
     * minute from now while a device needs another pass. Bounded reads: the open rows (at most the total bound, a page
     * at a time with the synchronous reader) and the first resolved row by `finishedAt`.
     */
    const nextDue = (now: number): number | undefined => {
      const r = reader()
      let next: number | undefined
      const consider = (t: number) => void (next = next === undefined ? t : Math.min(next, t))
      let after: Row<StoredNotification> | undefined
      for (let read = 0; read < SWEEP_ROWS;) {
        const page = r.list({ where: { state: "open" }, orderBy: { field: "sentAt" }, limit: MAX_NOTIFY_PAGE, scope: HOUSEHOLD_SCOPE, ...(after !== undefined ? { after } : {}) })
        for (const row of page) {
          consider(row.value.expiresAt)
          const claim = row.value.claim
          if (claim !== undefined && alive.get(row.id) !== claim.at) consider(claim.at > now ? now : claim.at + CLAIM_RELEASE_MS)
        }
        read += page.length
        if (page.length < MAX_NOTIFY_PAGE) break
        after = page[page.length - 1]
      }
      const oldest = r.list({ where: { state: "resolved" }, orderBy: { field: "finishedAt" }, limit: 1, scope: HOUSEHOLD_SCOPE })[0]
      if (oldest !== undefined) consider((oldest.value.finishedAt ?? 0) + KEEP_RESOLVED_MS)
      if (!dndNow.known) consider(now + RETRY_AFTER_MS)
      else if (dndNow.on && dndNow.until !== undefined) consider(dndNow.until)
      if (failed.size > 0) consider(now + RETRY_AFTER_MS)
      return next
    }

    /** Make the `due` job match `nextDue`: none, scheduled, or moved. Idempotent. */
    const planOnce: Effect.Effect<void, unknown> = Effect.gen(function*() {
      const ran = lastRun
      lastRun = undefined
      const now = yield* wallNow
      const next = yield* Effect.try(() => nextDue(now))
      if (next === undefined) {
        // Nothing due: the stored job is made to match, also one this process never planned (a restart, a failed cancel).
        if (plannedAt !== undefined) {
          plannedAt = "unknown"
          yield* jobs.cancel({ key: DUE_HANDLER })
          plannedAt = undefined
        }
        return
      }
      const at = next > now ? next : ran === "failed" ? now + RETRY_AFTER_MS : now
      const known = typeof plannedAt === "number" ? plannedAt : undefined
      if (at === known || (known !== undefined && next <= now && known <= now + RETRY_AFTER_MS && ran === undefined)) return
      plannedAt = "unknown"
      yield* jobs.schedule({ handler: DUE_HANDLER, key: DUE_HANDLER, at, origin: {} })
      plannedAt = at
    })

    /** `plan()`, serialised: one at a time in the service's own fiber; a request while one runs plans once more after it. */
    const requestPlan = (): void => {
      if (planning) {
        planAgain = true
        return
      }
      planning = true
      fork(
        Effect.gen(function*() {
          do {
            planAgain = false
            const exit = yield* Effect.exit(planOnce)
            if (Exit.isFailure(exit)) {
              log(`Notifications: maintenance could not be planned (${Cause.pretty(exit.cause).split("\n")[0]}); planned again at the next change, and the hourly job runs meanwhile`)
              setIssue("plan", {
                title: "Notifications' maintenance could not be planned",
                detail: "Expiry, the end of do not disturb and clean-up may be up to an hour late until it can be planned again (at the next change, or by the hourly job)."
              })
            } else setIssue("plan", undefined)
          } while (planAgain)
        }).pipe(Effect.ensuring(Effect.sync(() => {
          planning = false
          for (const d of planIdle.splice(0)) Deferred.doneUnsafe(d, Effect.void)
        })))
      )
    }
    const planNow: Effect.Effect<void> = Effect.suspend(() => {
      const d = Deferred.makeUnsafe<void>()
      planIdle.push(d)
      requestPlan()
      return Deferred.await(d)
    })

    /** The maintenance work: do not disturb's end, expiry and stale claims, retention, then every device reconciled. */
    const maintain: Effect.Effect<void, NotifyError> = Effect.gen(function*() {
      lastRun = undefined
      const now = yield* wallNow
      // A failed read makes do not disturb unknown (on) and plans a retry; the rest of the work goes on.
      const dnd = yield* Effect.exit(readDnd)
      if (Exit.isSuccess(dnd) && dnd.value.on && dnd.value.until !== undefined && dnd.value.until <= now) yield* dndWrite({ on: false }, dnd.value)
      // Open rows past their expiry, or with a stale claim: found with the reader, acted on in transactions of a page.
      const due: Array<string> = []
      const r = yield* Effect.try({ try: reader, catch: notifyFailure })
      let after: Row<StoredNotification> | undefined
      for (let read = 0; read < MAINTENANCE_ROWS;) {
        const page = yield* Effect.try({ try: () => r.list({ where: { state: "open" }, orderBy: { field: "sentAt" }, limit: MAX_NOTIFY_PAGE, scope: HOUSEHOLD_SCOPE, ...(after !== undefined ? { after } : {}) }), catch: notifyFailure })
        for (const row of page) if (row.value.expiresAt <= now || staleClaim(row.id, row.value.claim, now)) due.push(row.id)
        read += page.length
        if (page.length < MAX_NOTIFY_PAGE) break
        after = page[page.length - 1]
        yield* Effect.yieldNow
      }
      for (let i = 0; i < due.length; i += MAX_NOTIFY_PAGE) {
        const ids = due.slice(i, i + MAX_NOTIFY_PAGE)
        yield* tx((t) => {
          for (const id of ids) {
            const row = t.n.get(id)
            if (row === undefined || row.value.state !== "open") continue
            if (row.value.expiresAt <= now) resolveIn(t, row, "expired", "expiry", now)
            else if (staleClaim(id, row.value.claim, now)) {
              t.n.update(id, (v) => withIndexes(withoutClaim(fieldsOf(v))), { expectRev: row.rev })
              afterOutcome(t.tx, id)
            }
          }
        })
        yield* Effect.yieldNow
      }
      // Retention: the oldest resolved rows first, a page per transaction.
      const cutoff = now - KEEP_RESOLVED_MS
      for (let removed = 0; removed < MAINTENANCE_ROWS;) {
        const gone = yield* tx(({ n }) => {
          const page = n.list({ where: { state: "resolved" }, orderBy: { field: "finishedAt" }, limit: MAX_NOTIFY_PAGE })
          const old = page.filter((row) => (row.value.finishedAt ?? 0) <= cutoff)
          for (const row of old) n.remove(row.id)
          options.observe?.({ kind: "retention", removed: old.length })
          return { old: old.length, more: old.length === page.length && page.length === MAX_NOTIFY_PAGE }
        })
        removed += gone.old
        if (!gone.more) break
        yield* Effect.yieldNow
      }
      enqueueAll()
      lastRun = "succeeded"
    }).pipe(Effect.ensuring(Effect.sync(() => {
      // A run that failed is tried again a minute later (or by the hourly job), never in a tight loop.
      if (lastRun === undefined) lastRun = "failed"
      requestPlan()
    })))

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
      const extra = Object.keys(r).filter((k) => !["title", "text", "priority", "owner", "target", "key", "expiresInMs", "actions", "handler"].includes(k))
      if (extra.length > 0) return `unknown field ${extra[0]} (a notification is sent now: a module that wants it later schedules its own job and sends from its handler)`
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
      return undefined
    }

    const sendNotification = (moduleId: string) => (request: NotifyRequest): Effect.Effect<SendResult, NotifyError> =>
      Effect.gen(function*() {
        const problem = requestProblem(moduleId, request)
        if (problem !== undefined) return yield* invalid(problem)
        const deviceId = yield* originDevice
        const target = request.target ?? "origin"
        if (target === "origin" && deviceId === undefined) return yield* invalid("this call has no origin device (a turn, a job or a press made for one): send it everywhere instead")
        ensureMaintenance()
        const now = yield* wallNow
        const priority = request.priority ?? "normal"
        const fields: Fields = {
          module: moduleId,
          state: "open",
          ...(request.key !== undefined ? { key: request.key } : {}),
          title: request.title,
          ...(request.text !== undefined && request.text !== "" ? { text: request.text } : {}),
          priority,
          ...(request.owner !== undefined ? { owner: request.owner } : {}),
          target,
          ...(target === "origin" && deviceId !== undefined ? { deviceId } : {}),
          actions: (request.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
          ...(request.handler !== undefined ? { handler: request.handler } : {}),
          sentAt: now,
          expiresAt: now + (request.expiresInMs ?? DEFAULT_EXPIRY_MS[priority])
        }
        const id = newId()
        const out = yield* tx(({ n, tx: t }): { readonly _tag: "deduped" | "sent"; readonly row: Row<StoredNotification> } | { readonly _tag: "limit"; readonly message: string } => {
          if (fields.key !== undefined) {
            const same = n.list({ where: { dedupe: `${moduleId}|${fields.key}` }, limit: 1 })[0]
            if (same !== undefined) return { _tag: "deduped", row: same }
          }
          const counts = t.collection(notifyCounts)
          if ((counts.get(`m:${moduleId}`)?.value.live ?? 0) >= MAX_OPEN_PER_MODULE) return { _tag: "limit", message: `${moduleId} has ${MAX_OPEN_PER_MODULE} open notifications already` }
          if ((counts.get("total")?.value.live ?? 0) >= MAX_OPEN_TOTAL) return { _tag: "limit", message: `${MAX_OPEN_TOTAL} notifications are open already` }
          const row = n.insert(withIndexes(fields), { id })
          bump(t, moduleId, 1)
          t.afterCommit(() => {
            if (target === "everywhere") enqueueAll()
            else enqueue(deviceId!)
            requestPlan()
          })
          return { _tag: "sent", row }
        })
        if (out._tag === "limit") return yield* new NotifyError({ reason: "limit", message: out.message })
        return { notification: notificationView(out.row), deduped: out._tag === "deduped" }
      })

    /** The rows `list` returned (a view continues a list only when `list` returned it). */
    const listed = new WeakMap<Notification, Row<StoredNotification>>()

    const list = (moduleId: string) => (query: NotifyListQuery = {}): Effect.Effect<ReadonlyArray<Notification>, NotifyError> =>
      Effect.gen(function*() {
        const limit = query.limit ?? MAX_NOTIFY_PAGE
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTIFY_PAGE) return yield* invalid(`limit is 1 to ${MAX_NOTIFY_PAGE}`)
        const after = query.after === undefined ? undefined : listed.get(query.after)
        if (query.after !== undefined && after === undefined) return yield* invalid("after must be a notification list returned")
        const page = yield* core.collection(notifications).list({ where: { liveModule: moduleId }, orderBy: { field: "sentAt" }, limit, ...(after !== undefined ? { after } : {}) }).pipe(
          Effect.mapError(notifyFailure)
        )
        return page.map((row) => {
          const view = notificationView(row)
          listed.set(view, row)
          return view
        })
      })

    const resolve = (moduleId: string) => (target: string | { readonly key: string }, outcome = "resolved"): Effect.Effect<boolean, NotifyError> =>
      Effect.gen(function*() {
        if (typeof outcome !== "string" || !OUTCOME.test(outcome) || outcome === STOP_ACTION || outcome === "expired" || outcome === "withdrawn") {
          return yield* invalid("outcome is 1 to 40 letters, digits and _ . -, not stop, expired or withdrawn (the host's)")
        }
        if (typeof target === "object" && target !== null) {
          if (typeof target.key !== "string" || !NOTIFY_KEY.test(target.key)) return yield* invalid(`key must match ${NOTIFY_KEY}`)
          const at = yield* wallNow
          return yield* tx((t) => {
            const row = t.n.list({ where: { dedupe: `${moduleId}|${target.key}` }, limit: 1 })[0]
            if (row === undefined || row.value.state !== "open") return false
            resolveIn(t, row, outcome, "module", at)
            return true
          })
        }
        if (typeof target !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(target)) return false
        return yield* resolveRow(target, outcome, "module", moduleId)
      })

    // ---- Do not disturb

    const dndGet: Effect.Effect<DndState, NotifyError> = readDnd

    /** Write do not disturb; `expected` (the maintenance job's end): only if it is still that state. */
    const dndWrite = (state: DndState, expected?: DndState): Effect.Effect<DndState, NotifyError> =>
      Effect.gen(function*() {
        const at = yield* wallNow
        const wrote = yield* tx(({ tx: t }) => {
          const d = t.collection(notifyDnd)
          const current = d.get("house")
          if (expected !== undefined) {
            const now = dndOf(current)
            if (now.on !== expected.on || now.until !== expected.until) return false
          }
          const value = { on: state.on, ...(state.on && state.until !== undefined ? { until: state.until } : {}), setAt: at }
          if (current === undefined) d.insert(value, { id: "house" })
          else d.update("house", () => value)
          t.afterCommit(() => {
            dndNow = { ...(state.on ? { on: true, ...(state.until !== undefined ? { until: state.until } : {}) } : { on: false }), known: true }
            // What rings follows do not disturb: every device is reconciled; its end moves the plan.
            enqueueAll()
            requestPlan()
          })
          return true
        })
        return wrote ? (state.on ? { on: true, ...(state.until !== undefined ? { until: state.until } : {}) } : { on: false }) : yield* dndGet
      })

    const dndSet = (o: { readonly until?: number } = {}) =>
      Effect.gen(function*() {
        const now = yield* wallNow
        if (o.until !== undefined && (!Number.isInteger(o.until) || o.until <= now || o.until > now + MAX_DND_MS)) return yield* invalid(`until is a time after now, at most ${MAX_DND_MS / 3_600_000} hours ahead`)
        ensureMaintenance()
        return yield* dndWrite(o.until === undefined ? { on: true } : { on: true, until: o.until })
      })

    // ---- Presses

    const answer = (ok: boolean, key: NotifyTextKey, code?: PressAnswer["code"]): PressAnswer => ({ ok, say: notifyText(lang(), key), ...(code !== undefined ? { code } : {}) })

    type Admission = { readonly _tag: "answer"; readonly answer: PressAnswer } | { readonly _tag: "admitted"; readonly row: Row<StoredNotification> }

    /**
     * A press is admitted only for a connection (or, without one, one of the device's connections) that holds the
     * notification, of a row that is open and that the decision allows on the device now. Synchronous: no wait between
     * the read and the answer. A read that fails is a failure, never "it has ended".
     */
    const holdsCard = (request: PressRequest, bys: ReadonlyArray<HeldBy>) =>
      bys.some((by) => by.cards.has(request.notificationId) && (request.connection === undefined || held.get(request.connection.id) === by))

    /** Admission against the state at this moment (synchronous): the card is held there and the decision allows it. */
    const allowedNow = (request: PressRequest, row: Row<StoredNotification>): boolean => {
      const bys = heldOf(request.deviceId)
      if (!holdsCard(request, bys)) return false
      const device = deviceOf(request.deviceId)
      const decision = device === undefined ? undefined : decideNotification(row.id, row.value, device, bys.length > 0)
      return decision?.deliver === true && targets(row.value, request.deviceId)
    }

    const admit = (request: PressRequest): Admission => {
      const bys = heldOf(request.deviceId)
      const holds = holdsCard(request, bys)
      let row: Row<StoredNotification> | undefined
      try {
        row = readRow(request.notificationId)
      } catch {
        return { _tag: "answer", answer: answer(false, "cantNow", "failed") }
      }
      if (row === undefined || row.value.state !== "open") {
        if (holds) enqueue(request.deviceId)
        return { _tag: "answer", answer: holds ? answer(request.actionId === STOP_ACTION, "over", request.actionId === STOP_ACTION ? undefined : "unknown") : answer(false, "cantNow", "unknown") }
      }
      if (!holds) return { _tag: "answer", answer: answer(false, "cantNow", "unknown") }
      const device = deviceOf(request.deviceId)
      const decision = device === undefined ? undefined : decideNotification(row.id, row.value, device, bys.length > 0)
      if (decision?.deliver !== true || !targets(row.value, request.deviceId)) {
        enqueue(request.deviceId)
        return { _tag: "answer", answer: answer(false, "cantNow", "unknown") }
      }
      return { _tag: "admitted", row }
    }

    /** Write a press's outcome, a few times when the store fails; `false` when it could not be written. */
    const writeOutcome = <X>(write: Effect.Effect<X, NotifyError>): Effect.Effect<{ readonly ok: true; readonly value: X } | { readonly ok: false }> =>
      Effect.gen(function*() {
        for (let attempt = 0;; attempt++) {
          const exit = yield* Effect.exit(write)
          if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value }
          const pause = outcomeRetryMs[attempt]
          if (pause === undefined) return { ok: false as const }
          yield* Effect.sleep(pause)
        }
      })

    const press = (request: PressRequest): Effect.Effect<PressAnswer> =>
      Effect.gen(function*() {
        const admitted = admit(request)
        if (admitted._tag === "answer") return admitted.answer
        const row = admitted.row
        const v = row.value
        if (request.actionId === STOP_ACTION) {
          // The host's: needs no handler and wins over a module action under way (its outcome is then dropped).
          const at = yield* wallNow
          const stopped = yield* Effect.exit(tx((t): "stopped" | "over" | "refused" => {
            const now = t.n.get(row.id)
            if (now === undefined || now.value.state !== "open") return "over"
            // Admitted again against this moment: a wait on a busy store may have changed what the device holds.
            if (!allowedNow(request, now)) return "refused"
            resolveIn(t, now, STOP_ACTION, request.deviceId, at)
            return "stopped"
          }))
          if (Exit.isFailure(stopped)) return answer(false, "cantNow", "failed")
          if (stopped.value === "refused") {
            enqueue(request.deviceId)
            return answer(false, "cantNow", "unknown")
          }
          return stopped.value === "stopped" ? answer(true, "done") : answer(true, "over")
        }
        if (!v.actions.some((a) => a.id === request.actionId) || v.handler === undefined) return answer(false, "cantNow", "unknown")
        const entry = published.get(`${v.module}/${v.handler}`)
        if (entry === undefined) return answer(false, "cantNow", "not_running")
        // The claim: one module action at a time per notification, in one transaction, before any module code runs.
        const claimAt = yield* wallNow
        const claimed = yield* Effect.exit(tx((t): "claimed" | "busy" | "over" | "refused" => {
          const now = t.n.get(row.id)
          if (now === undefined || now.value.state !== "open") return "over"
          // A claim of a run alive here is never taken over, whatever the wall clock says; one no run here holds only
          // when it is stale (old, or dated in the future).
          if (alive.has(row.id) || (now.value.claim !== undefined && !staleClaim(row.id, now.value.claim, claimAt))) return "busy"
          // Admitted again against this moment: a wait on a busy store may have changed what the device holds.
          if (!allowedNow(request, now)) return "refused"
          t.n.update(row.id, (x) => withIndexes({ ...fieldsOf(x), claim: { action: request.actionId, by: request.deviceId, at: claimAt } }), { expectRev: now.rev })
          // Recorded before the commit returns, so nothing in this process sees the claim without its run.
          alive.set(row.id, claimAt)
          t.tx.onRollback(() => void (alive.get(row.id) === claimAt && alive.delete(row.id)))
          return "claimed"
        }))
        if (Exit.isFailure(claimed)) {
          if (alive.get(row.id) === claimAt) alive.delete(row.id)
          return answer(false, "cantNow", "failed")
        }
        if (claimed.value === "busy") return answer(false, "handling", "busy")
        if (claimed.value === "over") return answer(false, "over", "unknown")
        if (claimed.value === "refused") {
          enqueue(request.deviceId)
          return answer(false, "cantNow", "unknown")
        }
        return yield* runClaimed(request, row, claimAt)
      })

    /** A claimed module action: its handler under the time limit, then its outcome; the claim is alive here meanwhile. */
    const runClaimed = (request: PressRequest, row: Row<StoredNotification>, claimAt: number): Effect.Effect<PressAnswer> =>
      Effect.gen(function*() {
        const v = row.value
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
              const admittedBy = yield* gateway.principal
              if ("refused" in admittedBy) return yield* Effect.fail(new NotifyError({ reason: "invalid", message: `Not run: ${admittedBy.refused}` }))
            }
            return yield* Effect.suspend(() => entry.handler.run(pressInfo))
          })
        ).pipe(Effect.timeoutOrElse({ duration: NOTIFY_ACTION_TIMEOUT_MS, orElse: () => Effect.fail(new NotifyError({ reason: "failed", message: "the handler did not finish in time" })) }))
        const exit = yield* Effect.exit(entry.runner.inFlight(() => body))
        /** The row is still ours: open, with this press's claim. */
        const mine = (now: Row<StoredNotification> | undefined): now is Row<StoredNotification> =>
          now !== undefined && now.value.state === "open" && now.value.claim?.at === claimAt && now.value.claim.by === request.deviceId && now.value.claim.action === request.actionId
        if (Exit.isFailure(exit)) {
          const stopped = exit.cause.reasons.some((r) => (Cause.isFailReason(r) && isModuleStopped(r.error)) || (Cause.isDieReason(r) && isModuleStopped(r.defect)))
          log(`Notifications: the action ${request.actionId} of ${v.module} ${stopped ? "could not run: its module stopped" : `failed: ${Cause.pretty(exit.cause).split("\n")[0]}`}`)
          // Nothing changes: the claim is released (or, if that cannot be written, by the maintenance job).
          yield* writeOutcome(tx((t) => {
            const now = t.n.get(row.id)
            if (mine(now)) t.n.update(row.id, (x) => withIndexes(withoutClaim(fieldsOf(x))), { expectRev: now.rev })
            afterOutcome(t.tx, row.id)
          }))
          return stopped ? answer(false, "cantNow", "not_running") : answer(false, "failed", "failed")
        }
        const said = exit.value as ActionAnswer | void
        const at = yield* wallNow
        const wrote = yield* writeOutcome(tx((t): "written" | "dropped" => {
          const now = t.n.get(row.id)
          // `stop` won meanwhile (or the claim was released and taken again): this outcome is dropped.
          if (!mine(now)) return "dropped"
          if (said?.keepOpen === true) {
            t.n.update(row.id, (x) => withIndexes(withoutClaim(fieldsOf(x))), { expectRev: now.rev })
            afterOutcome(t.tx, row.id)
          } else resolveIn(t, now, request.actionId, request.deviceId, at)
          return "written"
        }))
        if (!wrote.ok) return answer(false, "failed", "failed")
        if (wrote.value === "dropped") return answer(false, "over", "unknown")
        const text = said?.say === undefined ? "" : options.pageText(v.module, said.say, MAX_ANSWER_CHARS)
        return { ok: true, say: text === "" ? notifyText(lang(), "done") : text }
      }).pipe(
        // The run is over: its claim is no longer alive here. One left on the row (its outcome could not be written)
        // becomes a durable claim, released by maintenance when it is stale; the plan and the holders follow.
        Effect.ensuring(Effect.sync(() => {
          if (alive.get(row.id) === claimAt) alive.delete(row.id)
          for (const d of holdersOf(row.id)) dirty.add(d)
          kick()
          requestPlan()
        }))
      )

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
      const outputs = options.outputs(d)
      const decision = decideDelivery({
        kind: "announcement",
        priority: "normal",
        personal: owner !== undefined,
        mayReveal: owner === undefined ? true : options.privacy.mayReveal(owner, d.id),
        dnd: dndNow.on,
        device: { connected: connectionsOf(d.id).length > 0, canSpeak: outputs.speak, canShow: outputs.show }
      })
      decided({ kind: "announcement", id, deviceId: d.id, decision })
      return decision
    }

    const finish = (item: SpeechItem, outcome: SpeechDeviceOutcome) => void Deferred.doneUnsafe(item.done, Effect.succeed(outcome))

    /** One announcement on its device: the port makes the voice ready, waits for quiet, and asks the gate last. */
    const speakItem = (item: SpeechItem): Effect.Effect<SpeechDeviceOutcome> =>
      Effect.gen(function*() {
        const port = options.speech()
        if (port === undefined) return { deviceId: item.deviceId, outcome: "failed", why: "no speech here" } satisfies SpeechDeviceOutcome
        const gate = (): "go" | NotDelivered => {
          const device = deviceOf(item.deviceId)
          if (device === undefined) return "offline"
          const d = decideAnnouncement(item.handleId, device, item.owner)
          return d.deliver ? "go" : d.why
        }
        const exit = yield* Effect.exit(port.speak(item.deviceId, item.text, { cue: item.cue, gate }))
        if (Exit.isSuccess(exit)) {
          return exit.value === "spoken"
            ? { deviceId: item.deviceId, outcome: "spoken" } satisfies SpeechDeviceOutcome
            : { deviceId: item.deviceId, outcome: "skipped", why: exit.value.skipped } satisfies SpeechDeviceOutcome
        }
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
          if (item === undefined) return
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

    /**
     * Stop every matched announcement in one synchronous step: the waiting ones are finished `stopped` at once, the ones
     * being spoken are interrupted by the service (in its own scope: the caller need not stay). Whether any matched.
     */
    const stopItems = (match: (item: SpeechItem) => boolean): boolean => {
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
          finish(current.item, { deviceId, outcome: "stopped" })
          fork(Fiber.interrupt(current.fiber))
        }
      }
      return any
    }

    const say = (moduleId: string) => (target: SpeechTarget, text: string, o: SpeechOptions = {}): Effect.Effect<SpeechHandle, SpeechError> =>
      Effect.gen(function*() {
        if (typeof text !== "string" || text.trim() === "" || text.length > MAX_SPEECH_CHARS || !NOTIFY_TEXT.test(text)) {
          return yield* new SpeechError({ reason: "invalid", message: `an announcement is 1 to ${MAX_SPEECH_CHARS} characters of text, without control characters` })
        }
        if (o.owner !== undefined && (typeof o.owner !== "string" || !PERSON_ID.test(o.owner))) return yield* new SpeechError({ reason: "invalid", message: "owner is a Members id" })
        const devicesNow = options.devices()
        const devices = target === "everywhere"
          ? devicesNow
          : typeof target === "object" && target !== null && "device" in target
          ? devicesNow.filter((d) => d.id === target.device)
          : typeof target === "object" && target !== null && "room" in target && typeof target.room === "string"
          ? devicesNow.filter((d) => d.room !== undefined && sameRoom(d.room, target.room))
          : undefined
        if (devices === undefined) return yield* new SpeechError({ reason: "invalid", message: "target is { device }, { room } or \"everywhere\"" })
        if (devices.length === 0) return yield* new SpeechError({ reason: "no-device", message: "the target names no known device" })
        // The module's text passes the page boundary before it is spoken.
        const line = options.pageText(moduleId, text, MAX_SPEECH_CHARS)
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
          // The bound counts every announcement not yet finished there: waiting, waiting for quiet, or being spoken.
          if (q.items.length + (q.current !== undefined ? 1 : 0) >= MAX_SPEECH_QUEUE) {
            deliveries.push({ deviceId: d.id, queued: false, why: "busy" })
            skipped.push({ deviceId: d.id, outcome: "skipped", why: "busy" })
            continue
          }
          const item: SpeechItem = { handleId: id, deviceId: d.id, text: line, cue: o.cue === true, owner: o.owner, done: Deferred.makeUnsafe<SpeechDeviceOutcome>() }
          q.items.push(item)
          items.push(item)
          deliveries.push({ deviceId: d.id, queued: true })
          startQueue(d.id)
        }
        const done: SpeechHandle["done"] = Effect.flatMap(CurrentTurn, (turn) =>
          turn !== undefined
            ? Effect.fail(new SpeechError({ reason: "in-turn", message: "a tool or action of a turn cannot wait for an announcement: the reply it belongs to is what the announcement waits for" }))
            : Effect.map(Effect.forEach(items, (i) => Deferred.await(i.done)), (spoken) => [...spoken, ...skipped]))
        return { id, deliveries, done, stop: Effect.sync(() => void stopItems((i) => i.handleId === id)) } satisfies SpeechHandle
      })

    // ---- The job, do not disturb, the counters, the fiber

    yield* jobs.handle(DUE_HANDLER, {
      payload: Schema.Struct({}),
      idempotent: true,
      timeoutMs: 50_000,
      // This job has run: whatever it leaves due is planned afresh (maintenance plans at its end).
      run: () => Effect.suspend(() => {
        plannedAt = undefined
        return maintain
      })
    }).pipe(Effect.orDie)
    yield* jobs.handle(HOURLY_HANDLER, {
      payload: Schema.Struct({}),
      idempotent: true,
      timeoutMs: 50_000,
      run: () => Effect.suspend(() => {
        // The safety net does not trust what this process believes is planned.
        plannedAt = "unknown"
        return maintain
      })
    }).pipe(Effect.orDie)
    yield* loadDnd
    yield* Effect.gen(function*() {
      const perModule = new Map<string, number>()
      let total = 0
      let after: Row<StoredNotification> | undefined
      for (let read = 0; read < SWEEP_ROWS;) {
        const page = yield* core.collection(notifications).list({ where: { state: "open" }, orderBy: { field: "sentAt" }, limit: MAX_NOTIFY_PAGE, ...(after !== undefined ? { after } : {}) })
        for (const row of page) {
          perModule.set(row.value.module, (perModule.get(row.value.module) ?? 0) + 1)
          total++
        }
        read += page.length
        if (page.length < MAX_NOTIFY_PAGE) break
        after = page[page.length - 1]
      }
      yield* core.transaction((t) => {
        const c = t.collection(notifyCounts)
        for (const row of c.list({ limit: 100 })) if (row.id !== "total" && !perModule.has(row.id.slice(2))) c.update(row.id, () => ({ live: 0 }))
        const put = (key: string, live: number) => (c.get(key) === undefined ? c.insert({ live }, { id: key }) : c.update(key, () => ({ live })))
        put("total", total)
        for (const [m, n] of perModule) put(`m:${m}`, n)
      })
    }).pipe(Effect.catch((e) => Effect.sync(() => log(`Notifications: the open counters could not be recounted (${notifyFailure(e).message})`))))
    yield* Effect.forkIn(loop, scope)
    ensureMaintenance()
    requestPlan()

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
        send: sendNotification(moduleId),
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
      reconcile: (deviceId) => {
        ensureMaintenance()
        enqueue(deviceId)
      },
      reconcileAll: enqueueAll,
      press,
      ringingOn: (deviceId) => {
        const out = new Map<string, Held & { readonly id: string }>()
        for (const by of held.values()) if (by.deviceId === deviceId) for (const [id, h] of by.cards) if (isRinging(h)) out.set(id, { ...h, id })
        return [...out.values()].sort((a, b) => a.sentAt - b.sentAt).map((h) => ({ id: h.id, module: h.module, title: h.title, actions: h.actions }))
      },
      stopRinging: (deviceId) =>
        // What rings is recorded in one synchronous step and stopped by work the service owns: a caller that is
        // interrupted (or leaves) does not leave part of it undone. Each card is still admitted on its own.
        Effect.uninterruptible(Effect.gen(function*() {
          const ids = engine.ringingOn(deviceId).map((r) => r.id)
          const work = Effect.gen(function*() {
            let n = 0
            let failed: NotifyError | undefined
            for (const id of ids) {
              const a = yield* press({ notificationId: id, actionId: STOP_ACTION, deviceId })
              if (a.ok && a.code === undefined) n++
              // `unknown`: it ended meanwhile (resolved elsewhere), so it no longer rings; `busy`, `failed`: it still does.
              else if (a.code === "busy" || a.code === "failed") failed ??= new NotifyError({ reason: a.code, message: a.say })
            }
            if (failed !== undefined) return yield* failed
            return n
          })
          return yield* Effect.forkIn(work, scope)
        })).pipe(Effect.flatMap((fiber) => Fiber.join(fiber))),
      stopSpeech: (deviceId) => Effect.sync(() => stopItems((i) => i.deviceId === deviceId && queues.get(deviceId)?.current?.item === i)),
      onRingingChanged: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      dnd: () => dndNow,
      maintenanceScheduled: () => scheduled,
      plannedAt: () => (typeof plannedAt === "number" ? plannedAt : undefined),
      planNow,
      maintainNow: maintain,
      busyAnswer: () => answer(false, "tooMany", "busy"),
      settled: Effect.gen(function*() {
        for (let i = 0; i < 5_000 && (working || all || dirty.size > 0); i++) yield* Effect.yieldNow
      })
    }
    return engine
  })
