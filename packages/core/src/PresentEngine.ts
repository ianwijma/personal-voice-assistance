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
  presentLifetime,
  sameRoom,
  selectPresentations,
  type ServerMessageOf,
  TICK_ACTION
} from "@pva/protocol"
import { Cause, Clock, Deferred, Effect, Exit, Queue, Schema, Scope } from "effect"
import type { KnownDevice } from "./Devices.ts"
import { asPrincipal, type ExecutionGateway } from "./Gateway.ts"
import { HOUSEHOLD_SCOPE, type HouseholdStore, type Row, type StoreFailure, type TxCollection, type TxResult } from "./HouseholdStore.ts"
import type { IssueRegistry } from "./Issues.ts"
import { isModuleStopped } from "./ModuleApi.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import type { NotifyLanguage } from "./NotifyTexts.ts"
import {
  isPresentResult,
  MAX_LIVE_PER_MODULE,
  MAX_LIVE_TOTAL,
  MAX_NOTE_CHARS,
  MAX_NOTE_SPOKEN_CHARS,
  MAX_PINNED_PER_DEVICE,
  MAX_PRESS_ANSWER_CHARS,
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
  type StoredPresentation
} from "./Present.ts"
import { presentPageTexts, presentText, type PresentTextKey } from "./PresentTexts.ts"
import type { PrivacyService } from "./Privacy.ts"
import { quotedName } from "./PromptText.ts"
import type { PartRunner } from "./Scheduler.ts"
import type { SchedulerEngine } from "./SchedulerEngine.ts"
import { CurrentJob, CurrentPrincipal, CurrentTurn, type Principal } from "./TurnContext.ts"

/**
 * The Presenter (docs/PRESENTING.md; the contract is `Present.ts`). One per server: serve mode makes it on the household
 * store and the scheduler before the module host, and the module test kit on its in-memory store and test clock.
 *
 * - **What is shown is decided from the current state at once** (review round 1, G1): an in-memory index of the live
 *   presentations (everything but their content) is the truth of what is eligible. A presentation that ends, is
 *   dismissed or replaced, or whose part stopped leaves the index at that moment and its holders are reconciled at
 *   once, whether or not its row could be marked or removed yet. Durable removal is separate work (`doomed`), repeated
 *   until it succeeds.
 * - **Reconciliation** (`reconcile`) is the only sender of `present.show`, `present.update` and `present.dismiss`. A pass
 *   over a device is one synchronous step that first withdraws, from each connection, what it holds and may not hold
 *   now (the index and the decision alone, no store read), and only then reads the content of what stays or is added;
 *   a failed read affects only those items and is repeated (G2). What each connection may hold is also limited to the
 *   kinds that connection declared (G11).
 * - **Writes are derived inside their transaction** (G3): an update re-reads the entry and its row in the attempt that
 *   succeeds and the index follows what it committed; a key has one stable id across queued and committed shows.
 * - **Maintenance** (the notification service's pattern): one one-shot scheduler job `core.present/due`, planned by
 *   `plan()` for the next thing due (an end, removal of what left the index, failed work to repeat; none when nothing
 *   is), planned again after every change, at the end of every run and at start; plus `core.present/hourly`, a safety
 *   net counting in UTC. The Presenter has no timer of its own.
 * - **A press** is admitted only for a connection that holds the presentation and while the decision still lets it be
 *   pressed there; it is claimed (one at a time per presentation) before the module's handler runs.
 */

export type PresentMessage = ServerMessageOf<"present.show"> | ServerMessageOf<"present.update"> | ServerMessageOf<"present.dismiss">

/** One voice connection of a device (serve mode: the hub's). `id` is stable while it is open. */
export interface PresentConnection {
  readonly id: string
  readonly send: (message: PresentMessage) => void
  /**
   * The presentation kinds this connection's own page declared (its hello, then `device.caps`), kind → version;
   * `undefined` when it declared none (an older page). Absent (tests, the kit): the device's outputs alone decide.
   */
  readonly kinds?: () => Readonly<Record<string, number>> | undefined
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
  /** The household store, prepared with `presentStorage` (and `schedulerStorage`). */
  readonly store: HouseholdStore
  /** The scheduler: the service's two jobs (`forCore("core.present")`). */
  readonly scheduler: SchedulerEngine
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
  /** The page boundary (`ModuleHost.pageText`): a module's text on its way to a page (or into a note). */
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
  /** Pauses before writing an accepted presentation again when the store fails, before maintenance takes it over. Default 100, 400, 1600 ms. */
  readonly writeRetryMs?: ReadonlyArray<number>
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
   * validation, the bounds from memory, the decision for the origin device and one enqueue) and the model gets
   * `forModel` with the note of what the server decided. Anything else is returned unchanged.
   */
  readonly fromResult: (moduleId: string | undefined, principal: Principal | undefined, value: unknown) => Effect.Effect<unknown>
  /**
   * The image a page's address names (`/media/<token>`): its content hash while the connection the token was made for
   * is open and holds a presentation with that image; else `undefined`.
   */
  readonly mediaFor: (token: string) => string | undefined
  /** The answer to a press refused because too much is pending at once (the hub's bound), in the household's language. */
  readonly busyAnswer: () => PresentPressAnswer
  /** The live presentations, oldest first (tests and the kit). */
  readonly live: () => ReadonlyArray<PresentView>
  /** What each open connection of a device holds now, by connection (tests and the kit). */
  readonly held: (deviceId: string) => ReadonlyArray<{ readonly connection: string; readonly ids: ReadonlyArray<string> }>
  /** Run the maintenance work now (tests; the `due` and `hourly` jobs do the same). */
  readonly maintainNow: Effect.Effect<void>
  /** Plan again now and wait for it (tests). */
  readonly planNow: Effect.Effect<void>
  /** When the `due` job is planned for (as far as this process knows); `undefined`: nothing is due. */
  readonly plannedAt: () => number | undefined
  /** Whether everything stored has been read (G4): until then nothing is shown or withdrawn. */
  readonly loaded: () => boolean
  /** Tests: completes once nothing is waiting to be written, fetched or reconciled. */
  readonly settled: Effect.Effect<void>
}

// ---------------------------------------------------------------------------------------------------------------------

const randomId = () => `p-${crypto.randomUUID().replace(/-/g, "")}`
const ISSUE_SOURCE = "core.present"
/** Failed work (a pass, a write, an image outcome, the start-up read) is tried again this soon by maintenance. */
export const PRESENT_RETRY_MS = 60_000
/** What left the index is removed from the store this long after, together (an update on a caller's path, no removal). */
export const PRESENT_PURGE_AFTER_MS = 10_000
export const PRESENT_DUE_HANDLER = "due"
export const PRESENT_HOURLY_HANDLER = "hourly"
const HOURLY_CRON = "0 * * * *"

/** A page's image address token: 24 random bytes, base64url (32 characters). */
const newToken = () => {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_")
}

/** What the engine keeps in memory of a live presentation (everything but the content). */
interface Entry {
  readonly id: string
  readonly showId: string
  /** The committed row's rev: a page holding another rev is sent the content again. */
  readonly rev: number
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

/** What one connection holds of one presentation. */
interface Held {
  /** The rev, the form and the language it was sent with: anything else is sent again. */
  readonly sig: string
  readonly hash: string | undefined
  /** This connection's address for its image (`/media/<token>`). */
  readonly token: string | undefined
}

interface HeldBy {
  readonly connId: string
  readonly deviceId: string
  readonly send: (message: PresentMessage) => void
  readonly items: Map<string, Held>
}

interface PublishedHandler {
  readonly moduleId: string
  readonly handler: PresentPressHandler
  readonly runner: PartRunner
}

/** A show from a tool's result, accepted and waiting for the writer (it holds its place in the bounds meanwhile). */
interface PendingShow {
  readonly entry: Omit<Entry, "rev">
  readonly content: StoredContent
  readonly spoken: string
  readonly buttons: ReadonlyArray<{ readonly id: string; readonly label: string }>
  /** Its quick retries failed: maintenance writes it again. */
  failed: boolean
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

/** A presentation's content as it is stored (an image's address kept; what was fetched for the same address kept). */
const storedContentOf = (p: Presentation, before?: StoredContent): StoredContent => {
  switch (p.kind) {
    case "card":
      return { kind: "card", title: p.title, ...(p.text !== undefined && p.text !== "" ? { text: p.text } : {}), facts: (p.facts ?? []).map((f) => ({ label: f.label, value: f.value })) }
    case "list":
      return { kind: "list", title: p.title, style: p.style ?? "bullets", items: p.items.map((i) => ({ id: i.id, text: i.text, done: i.done === true })) }
    case "timer":
      return { kind: "timer", label: p.label, endsAt: p.endsAt }
    case "image": {
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

const entryOf = (row: Row<StoredPresentation>): Entry => {
  const v = row.value
  return {
    id: row.id,
    showId: v.showId,
    rev: row.rev,
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
  }
}

const WHY_WORDS: Readonly<Record<NotShownWhy, string>> = {
  offline: "is not connected",
  private: "may not show this person's things",
  "no-display": "has no display",
  "cannot-show-kind": "cannot show this kind of thing"
}

const cut = (text: string, max: number) => (text.length <= max ? text : max <= 1 ? "" : `${text.slice(0, max - 1)}…`)
const list = (xs: ReadonlyArray<string>) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)

/** The sentence that adds the presentation's `spoken` text to a note (G6). */
export const SPOKEN_PREFIX = " Say this instead: "
/** The sentence a note ends with while the image is still to be fetched. */
export const IMAGE_SENTENCE = " Its image is being fetched; if that fails it shows without it."

/**
 * The note for the model: what the server decided, in words true when the call answers ("Showing on …"), never what the
 * eye saw (review round 1, G5). The exact sentences:
 *
 * - every device of the target shows it: `Showing on "A".` (`"A" and "B"`, `"A", "B" and "C"`);
 * - some do: `Showing on "A"; not on "B" (has no display).`;
 * - none does: `Not showing it: "A" has no display.`;
 * - and when the asking device does not show it for a reason other than privacy (G6): ` Say this instead: <spoken>`;
 * - and while its image is still to be fetched (shown somewhere): ` Its image is being fetched; if that fails it shows without it.`
 *
 * The whole note is at most `MAX_NOTE_CHARS`: the device part is cut first, the spoken text is at most
 * `MAX_NOTE_SPOKEN_CHARS`.
 */
export const noteOf = (devices: ReadonlyArray<ShownOn>, nameOf: (deviceId: string) => string, extra: { readonly spoken?: string; readonly image?: boolean } = {}): string => {
  const shown = devices.filter((d) => d.shown).map((d) => quotedName(nameOf(d.deviceId)))
  const not = devices.filter((d) => !d.shown)
  const tail = `${extra.spoken !== undefined ? `${SPOKEN_PREFIX}${cut(extra.spoken, MAX_NOTE_SPOKEN_CHARS)}` : ""}${extra.image === true && shown.length > 0 ? IMAGE_SENTENCE : ""}`
  let head: string
  if (shown.length === 0) head = `Not showing it: ${list(not.map((d) => `${quotedName(nameOf(d.deviceId))} ${WHY_WORDS[d.why ?? "offline"]}`))}.`
  else if (not.length === 0) head = `Showing on ${list(shown)}.`
  else head = `Showing on ${list(shown)}; not on ${list(not.map((d) => `${quotedName(nameOf(d.deviceId))} (${WHY_WORDS[d.why ?? "offline"]})`))}.`
  return `${cut(head, MAX_NOTE_CHARS - tail.length)}${tail}`
}

/** A note for a presentation the server did not take (`reason`), with the fallback when it may be said (G6). */
export const refusedNote = (reason: string, spoken?: string): string => {
  const tail = spoken !== undefined ? `${SPOKEN_PREFIX}${cut(spoken, MAX_NOTE_SPOKEN_CHARS)}` : ""
  return `${cut(`Not showing it: ${reason}.`, MAX_NOTE_CHARS - tail.length)}${tail}`
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
    const jobs = options.scheduler.forCore(PRESENT_OWNER)
    const lang = () => options.language()
    const wallNow: Effect.Effect<number> = options.now ?? Clock.currentTimeMillis
    const writeRetryMs = options.writeRetryMs ?? [100, 400, 1_600]
    const decided = (record: PresentDecisionRecord) => {
      try {
        options.onDecision?.(record)
      } catch {
        // Observers must not break showing.
      }
    }
    const issues = new Map<string, { readonly id: string; readonly severity: "warning"; readonly title: string; readonly detail: string }>()
    const setIssue = (key: string, issue: { readonly title: string; readonly detail: string } | undefined) => {
      if (issue === undefined && !issues.has(key)) return
      if (issue === undefined) issues.delete(key)
      else issues.set(key, { id: `core.present.${key}`, severity: "warning", ...issue })
      options.issues?.set(ISSUE_SOURCE, [...issues.values()])
    }

    /** One transaction of the service's collection; `after` runs after its commit with what it returned. */
    const tx = <X>(f: (p: TxCollection<StoredPresentation>) => TxResult<X>, after?: (x: X) => void): Effect.Effect<X, PresentError> =>
      core.transaction<X>((t) => {
        const out = f(t.collection(presentations))
        if (after !== undefined) t.afterCommit(() => after(out as X))
        return out
      }).pipe(Effect.mapError(failure))
    const reader = () => {
      const r = options.store.reader(PRESENT_OWNER, presentations)
      if (r === undefined) throw new PresentError({ reason: "unavailable", message: "the presentation data is not usable here" })
      return r
    }

    // ---- The index of live presentations (the truth of what is eligible), and what waits for durable removal

    const index = new Map<string, Entry>()
    const byKey = new Map<string, string>()
    /** Keys of accepted shows not written yet, with their reserved id (one stable id per key: G3). */
    const pendingKeys = new Map<string, string>()
    const keyOf = (module: string, key: string) => `${module}|${key}`
    /** Ids that left the index, with the show whose row is to be removed and when (G1: removal follows). */
    const doomed = new Map<string, { readonly showId: string; readonly at: number }>()
    const put = (e: Entry) => {
      const before = index.get(e.id)
      if (before?.key !== undefined && byKey.get(keyOf(before.module, before.key)) === e.id) byKey.delete(keyOf(before.module, before.key))
      index.set(e.id, e)
      if (e.key !== undefined) byKey.set(keyOf(e.module, e.key), e.id)
      doomed.delete(e.id)
    }
    const drop = (id: string) => {
      const e = index.get(id)
      if (e === undefined) return
      index.delete(id)
      if (e.key !== undefined && byKey.get(keyOf(e.module, e.key)) === id) byKey.delete(keyOf(e.module, e.key))
    }
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
    /** Page image addresses: token → the connection, the presentation and the image it names. */
    const tokens = new Map<string, { readonly connId: string; readonly id: string; readonly hash: string }>()
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
    const forget = (h: Held | undefined) => {
      if (h?.token !== undefined) tokens.delete(h.token)
    }
    /** The device's connections now, with their bookkeeping; what closed connections held (and their addresses) is dropped. */
    const heldOf = (deviceId: string): ReadonlyArray<{ readonly by: HeldBy; readonly conn: PresentConnection }> => {
      const conns = connectionsOf(deviceId)
      const open = new Set(conns.map((c) => c.id))
      for (const [cid, by] of held) {
        if (by.deviceId === deviceId && !open.has(cid)) {
          for (const h of by.items.values()) forget(h)
          held.delete(cid)
        }
      }
      return conns.map((conn) => {
        let by = held.get(conn.id)
        if (by === undefined || by.deviceId !== deviceId) {
          by = { connId: conn.id, deviceId, send: conn.send, items: new Map() }
          held.set(conn.id, by)
        }
        return { by, conn }
      })
    }
    const holders = (id: string) => {
      const ids = new Set<string>()
      for (const by of held.values()) if (by.items.has(id)) ids.add(by.deviceId)
      return ids
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
    /** Whether a connection's own page draws a kind (G11): its own declaration, when the outlet knows it. */
    const draws = (conn: PresentConnection, kind: PresentKindName) => {
      if (conn.kinds === undefined) return true
      const v = conn.kinds()?.[kind]
      return typeof v === "number" && v >= PRESENT_KIND_VERSIONS[kind]
    }

    /** The wire form of a row for one connection (every module text through the page boundary; its own image address). */
    const wireOf = (id: string, v: StoredPresentation, interactive: boolean, now: number, token: string | undefined): PresentationWire => {
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
          image: c.hash !== undefined && token !== undefined ? { state: "ready", token } : c.failed !== undefined ? { state: "failed" } : { state: "loading" }
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
     * One device, in one synchronous step (G2). First, from the index and the decision alone: what applies to the device
     * now, what it shows of that, and each connection's share of it (the kinds its own page draws); everything a
     * connection holds outside its share is withdrawn. Then the content of what a connection lacks or holds in another
     * form is read, item by item: a failed read affects that item only, and the pass reports it (`false`) to be repeated.
     */
    const syncDevice = (deviceId: string, now: number): boolean => {
      if (!loaded) return true
      const started = performance.now()
      const conns = heldOf(deviceId)
      if (conns.length === 0) return true
      const device = deviceOf(deviceId)
      const candidates = device === undefined
        ? []
        : [...index.values()].filter((e) => e.expiresAt > now && applies(e.target, device)).map((e) => ({ id: e.id, lifetime: e.lifetime, shownAt: e.shownAt, decision: decide(e, device, true) }))
      const chosen = selectPresentations(candidates)
      const shares = conns.map(({ by, conn }) => ({ by, share: chosen.filter((c) => draws(conn, index.get(c.id)!.kind)) }))
      // Withdrawals first: they need no read, so a failing store never keeps on a page what may not be there.
      for (const { by, share } of shares) {
        const keep = new Set(share.map((c) => c.id))
        for (const [id, h] of [...by.items]) {
          if (keep.has(id)) continue
          by.items.delete(id)
          forget(h)
          send(by, { type: "present.dismiss", id })
        }
      }
      // Then what stays or is added: the content read now, per item.
      const language = lang()
      const rows = new Map<string, Row<StoredPresentation> | "failed" | undefined>()
      let ok = true
      let read = 0
      for (const { by, share } of shares) {
        for (const c of share) {
          const e = index.get(c.id)!
          const sig = `${e.rev}|${c.decision.interactive}|${language}`
          const before = by.items.get(c.id)
          if (before?.sig === sig) continue
          if (!rows.has(c.id)) {
            try {
              read++
              const row = reader().get(c.id, HOUSEHOLD_SCOPE)
              rows.set(c.id, row !== undefined && row.value.showId === e.showId && row.value.ended !== true ? row : undefined)
            } catch {
              rows.set(c.id, "failed")
            }
          }
          const row = rows.get(c.id)
          if (row === "failed") {
            ok = false
            continue
          }
          if (row === undefined) continue
          const content = row.value.content
          const hash = content.kind === "image" ? content.hash : undefined
          // An image is fetched only once some page is to show it (not for a target nobody would show it on).
          if (content.kind === "image" && hash === undefined && content.failed === undefined) fetchImage(c.id, content.url)
          let token = before?.hash === hash ? before?.token : undefined
          if (hash !== undefined && token === undefined) {
            forget(before)
            token = newToken()
            tokens.set(token, { connId: by.connId, id: c.id, hash })
          } else if (hash === undefined) forget(before)
          send(by, { type: before === undefined ? "present.show" : "present.update", presentation: wireOf(c.id, row.value, c.decision.interactive, now, token) })
          by.items.set(c.id, { sig, hash, token: hash === undefined ? undefined : token })
        }
      }
      options.observe?.({ kind: "step", ms: performance.now() - started, rows: read, connections: conns.length })
      return ok
    }

    // ---- The reconciliation fiber: coalesced devices, one pass at a time

    const dirty = new Set<string>()
    const failedPasses = new Set<string>()
    let all = false
    let working = false
    const wake = yield* Queue.sliding<void>(1)
    const kick = () => void Queue.offerUnsafe(wake, undefined)
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
    /** Reconcile whoever holds it and the devices of its target (old and new). */
    const touch = (id: string, ...targets: ReadonlyArray<Entry["target"] | undefined>) => {
      for (const d of holders(id)) dirty.add(d)
      for (const t of targets) if (t !== undefined) for (const d of targetDevices(t)) dirty.add(d.id)
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
          if (Exit.isFailure(exit) || exit.value === false) {
            const first = failedPasses.size === 0
            failedPasses.add(next.value)
            if (first) requestPlan()
            log(`Presentations: reconciling ${next.value} did not finish (a store read failed); repeated by the next trigger or maintenance`)
          } else if (failedPasses.delete(next.value) && failedPasses.size === 0) requestPlan()
          yield* Effect.yieldNow
        }
        working = false
      }
    })

    // ---- Leaving the index (G1): at once, whatever the store does; removal follows

    /** It is no longer eligible from now: out of the index, its holders reconciled; its row removed at `removeAt`. */
    const doom = (e: Entry, removeAt: number) => {
      drop(e.id)
      doomed.set(e.id, { showId: e.showId, at: removeAt })
      touch(e.id)
      requestPlan()
    }

    // ---- Parts

    const openParts = new Map<string, Set<number>>()
    const partOpen = (moduleId: string, part: number) => openParts.get(moduleId)?.has(part) === true
    const partClosed = (moduleId: string, partId: number) =>
      Effect.gen(function*() {
        const open = openParts.get(moduleId)
        open?.delete(partId)
        if (open !== undefined && open.size === 0) openParts.delete(moduleId)
        const now = yield* wallNow
        // A transient presentation belongs to the part that made it: no longer eligible once it stops. Pinned ones stay.
        for (const e of [...index.values()]) if (e.part === partId && e.module === moduleId && e.lifetime === "transient") doom(e, now + PRESENT_PURGE_AFTER_MS)
        // Accepted shows of that part that were not written yet no longer apply.
        for (const s of [...pending]) if (s.entry.part === partId && s.entry.module === moduleId) dropPending(s)
      })

    // ---- Bounds, from the index and the accepted shows

    const pending: Array<PendingShow> = []
    const releaseKey = (s: PendingShow) => {
      const e = s.entry
      if (e.key === undefined) return
      const k = keyOf(e.module, e.key)
      if (pendingKeys.get(k) === e.id && !pending.some((x) => x !== s && x.entry.id === e.id)) pendingKeys.delete(k)
    }
    const dropPending = (s: PendingShow) => {
      const at = pending.indexOf(s)
      if (at >= 0) pending.splice(at, 1)
      releaseKey(s)
      if (!pending.some((x) => x.failed)) setIssue("write", undefined)
    }

    /**
     * Why one more presentation would pass a bound, or `undefined` (G3). `id`: its own (a key's stable id: the shows of
     * that id are counted once). A transient one ends the transient ones it would share a device with, committed or
     * queued: those do not count against it.
     */
    const boundProblem = (module: string, lifetime: "transient" | "pinned", target: Entry["target"], id: string, now: number): string | undefined => {
      const devices = targetDevices(target)
      const ends = (e: Pick<Entry, "lifetime" | "target">) => lifetime === "transient" && e.lifetime === "transient" && devices.some((d) => applies(e.target, d))
      const every = new Map<string, Pick<Entry, "module" | "lifetime" | "target">>()
      for (const e of index.values()) if (e.id !== id && e.expiresAt > now && !ends(e)) every.set(e.id, e)
      for (const s of pending) if (s.entry.id !== id && s.entry.expiresAt > now && !ends(s.entry)) every.set(s.entry.id, s.entry)
      const all = [...every.values()]
      if (all.length >= MAX_LIVE_TOTAL) return `${MAX_LIVE_TOTAL} presentations are live already`
      if (all.filter((e) => e.module === module).length >= MAX_LIVE_PER_MODULE) return `${module} has ${MAX_LIVE_PER_MODULE} live presentations already`
      if (lifetime === "pinned") {
        for (const d of devices) {
          if (all.filter((e) => e.lifetime === "pinned" && applies(e.target, d)).length >= MAX_PINNED_PER_DEVICE) return `${quotedName(d.name)} shows ${MAX_PINNED_PER_DEVICE} pinned presentations already`
        }
      }
      return undefined
    }

    /** The live transient presentations that would share a device with `target` now (a device shows one at a time). */
    const overlapping = (target: Entry["target"], except: string): ReadonlyArray<Entry> => {
      const devices = targetDevices(target)
      return [...index.values()].filter((e) => e.id !== except && e.lifetime === "transient" && devices.some((d) => applies(e.target, d)))
    }

    /** What was decided for each device of the target now, and the note for the model (G5, G6). */
    const outcomeOf = (e: Pick<Entry, "id" | "kind" | "owner" | "target">, o: { readonly asking?: string | undefined; readonly spoken: string; readonly module: string; readonly image: boolean }): ShowOutcome => {
      const devices = targetDevices(e.target)
      const shownOn: Array<ShownOn> = devices.map((d) => {
        const decision = decide(e, d, connectionsOf(d.id).length > 0)
        return decision.show ? { deviceId: d.id, shown: true } : { deviceId: d.id, shown: false, why: decision.why }
      })
      const names = new Map(devices.map((d) => [d.id, d.name] as const))
      const asking = o.asking === undefined ? undefined : shownOn.find((s) => s.deviceId === o.asking)
      const fallback = asking !== undefined && !asking.shown && asking.why !== "private"
      return {
        devices: shownOn,
        note: noteOf(shownOn, (id) => names.get(id) ?? id, { ...(fallback ? { spoken: options.pageText(o.module, o.spoken, MAX_NOTE_SPOKEN_CHARS) } : {}), image: o.image })
      }
    }

    // ---- Images: fetched once some page is to show one; the outcome written on the row, retried until it is

    const fetching = new Set<string>()
    /** Outcomes not written yet (the write failed): maintenance writes them. */
    const imageOutcomes = new Map<string, { readonly url: string; readonly showId: string; readonly outcome: MediaOutcome }>()
    const writeImage = (id: string, w: { readonly url: string; readonly showId: string; readonly outcome: MediaOutcome }) =>
      tx((p) => {
        const row = p.get(id)
        if (row === undefined || row.value.ended === true || row.value.showId !== w.showId || row.value.content.kind !== "image" || row.value.content.url !== w.url) return undefined
        const { hash: _h, failed: _f, ...content } = row.value.content
        p.update(id, (v) => ({ ...v, content: { ...content, ...("hash" in w.outcome ? { hash: w.outcome.hash } : { failed: w.outcome.refused }) } }), { expectRev: row.rev })
        return p.get(id)
      }, (row) => {
        imageOutcomes.delete(id)
        if (row !== undefined && index.get(id)?.showId === row.value.showId) {
          put(entryOf(row))
          touch(id)
        }
      })
    const fetchImage = (id: string, url: string) => {
      const key = `${id} ${url}`
      const e = index.get(id)
      if (fetching.has(key) || imageOutcomes.has(id) || e === undefined) return
      fetching.add(key)
      fork(Effect.gen(function*() {
        const media = options.media?.()
        const outcome: MediaOutcome = media === undefined ? { refused: "unavailable" } : yield* media.fetch(url)
        if ("refused" in outcome) log(`Presentations: an image was not kept (${outcome.refused})`)
        const w = { url, showId: e.showId, outcome }
        const exit = yield* Effect.exit(writeImage(id, w))
        if (Exit.isFailure(exit)) {
          imageOutcomes.set(id, w)
          requestPlan()
          log("Presentations: an image's outcome could not be written; maintenance writes it again")
        }
      }).pipe(Effect.ensuring(Effect.sync(() => fetching.delete(key)))))
    }

    // ---- Maintenance (the notification service's pattern): `due`, one-shot, planned for the next thing due; `hourly`

    let plannedAt: number | undefined | "unknown" = "unknown"
    let planning = false
    let planAgain = false
    let lastRun: "succeeded" | "failed" | undefined
    const planIdle: Array<Deferred.Deferred<void>> = []
    /** When maintenance is next needed, from memory only: an end, a removal, failed work to repeat (a minute from now). */
    const nextDue = (now: number): number | undefined => {
      let next: number | undefined
      const consider = (t: number) => void (next = next === undefined ? t : Math.min(next, t))
      for (const e of index.values()) consider(e.expiresAt)
      for (const d of doomed.values()) consider(d.at)
      for (const s of pending) consider(s.failed ? now + PRESENT_RETRY_MS : s.entry.expiresAt)
      if (!loaded || failedPasses.size > 0 || imageOutcomes.size > 0) consider(now + PRESENT_RETRY_MS)
      return next
    }
    const planOnce: Effect.Effect<void, unknown> = Effect.gen(function*() {
      const ran = lastRun
      lastRun = undefined
      const now = yield* wallNow
      const next = nextDue(now)
      if (next === undefined) {
        if (plannedAt !== undefined) {
          plannedAt = "unknown"
          yield* jobs.cancel({ key: PRESENT_DUE_HANDLER })
          plannedAt = undefined
        }
        return
      }
      const at = next > now ? next : ran === "failed" ? now + PRESENT_RETRY_MS : now
      const known = typeof plannedAt === "number" ? plannedAt : undefined
      if (at === known) return
      plannedAt = "unknown"
      yield* jobs.schedule({ handler: PRESENT_DUE_HANDLER, key: PRESENT_DUE_HANDLER, at, origin: {} })
      plannedAt = at
    })
    function requestPlan(): void {
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
              log(`Presentations: maintenance could not be planned (${Cause.pretty(exit.cause).split("\n")[0]}); planned again at the next change, and the hourly job runs meanwhile`)
              setIssue("plan", { title: "Presentations' maintenance could not be planned", detail: "Ends, removals and retries may be up to an hour late until it can be planned again." })
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
    let hourly = false
    let schedulingHourly = false
    const ensureHourly = () => {
      if (hourly || schedulingHourly) return
      schedulingHourly = true
      fork(jobs.schedule({ handler: PRESENT_HOURLY_HANDLER, key: PRESENT_HOURLY_HANDLER, cron: HOURLY_CRON, timeZone: "UTC", origin: {} }).pipe(
        Effect.match({
          onSuccess: () => {
            hourly = true
            setIssue("hourly", undefined)
          },
          onFailure: (e) => {
            log(`Presentations: the hourly maintenance job could not be scheduled (${e.message}); tried again at the next change`)
            setIssue("hourly", { title: "Presentations have no hourly maintenance yet", detail: "Its job could not be scheduled; it is tried again with the next change." })
          }
        }),
        Effect.ensuring(Effect.sync(() => void (schedulingHourly = false)))
      ))
    }

    /** Remove the rows of what left the index (due now), a page per transaction; each removed only if it is still that show. */
    const removeDoomed = (now: number): Effect.Effect<void, PresentError> =>
      Effect.gen(function*() {
        const due = [...doomed].filter(([, d]) => d.at <= now)
        for (let i = 0; i < due.length; i += PRESENT_PAGE) {
          const page = due.slice(i, i + PRESENT_PAGE)
          yield* tx((p) => {
            for (const [id, d] of page) {
              const row = p.get(id)
              if (row !== undefined && row.value.showId === d.showId) p.remove(id)
            }
          }, () => {
            for (const [id, d] of page) if (doomed.get(id)?.showId === d.showId) doomed.delete(id)
          })
          yield* Effect.yieldNow
        }
      })

    /** The maintenance work: the start-up read if it failed, ends, removals, accepted writes and image outcomes, failed passes. */
    const maintain: Effect.Effect<void> = Effect.gen(function*() {
      lastRun = undefined
      let failedSome = false
      if (!loaded) {
        yield* load
        if (!loaded) failedSome = true
      }
      const now = yield* wallNow
      // Ended: no longer eligible from their end (a pass after it already left them out); removed now.
      for (const e of [...index.values()]) if (e.expiresAt <= now) doom(e, now)
      for (const s of [...pending]) if (s.entry.expiresAt <= now || !partOpen(s.entry.module, s.entry.part)) dropPending(s)
      if (Exit.isFailure(yield* Effect.exit(removeDoomed(now)))) failedSome = true
      for (const s of [...pending]) if (s.failed && pending.includes(s)) yield* writePending(s)
      if (pending.some((s) => s.failed)) failedSome = true
      for (const [id, w] of [...imageOutcomes]) if (Exit.isFailure(yield* Effect.exit(writeImage(id, w)))) failedSome = true
      if (failedPasses.size > 0) {
        for (const d of failedPasses) dirty.add(d)
        kick()
      }
      lastRun = failedSome ? "failed" : "succeeded"
    }).pipe(Effect.ensuring(Effect.sync(() => {
      if (lastRun === undefined) lastRun = "failed"
      ensureHourly()
      requestPlan()
    })))

    // ---- Start-up (G4): the whole collection, in bounded steps with real yields

    const load: Effect.Effect<void> = Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.gen(function*() {
        const live: Array<Row<StoredPresentation>> = []
        let after: Row<StoredPresentation> | undefined
        for (;;) {
          const page = yield* core.collection(presentations).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: PRESENT_PAGE, ...(after !== undefined ? { after } : {}) })
          const now = yield* wallNow
          for (const row of page) {
            const v = row.value
            // No part survives a restart: transient rows go; so do ended and expired ones (removed below, a page at a time).
            if (v.lifetime === "transient" || v.ended === true || v.expiresAt <= now) doomed.set(row.id, { showId: v.showId, at: now })
            else live.push(row)
          }
          if (page.length < PRESENT_PAGE) break
          after = page[page.length - 1]
          yield* Effect.yieldNow
        }
        return live
      }))
      if (Exit.isFailure(exit)) {
        setIssue("load", { title: "Presentations could not be read", detail: "Nothing is shown or withdrawn until the stored presentations can be read; tried again every minute." })
        log(`Presentations: the stored presentations could not be read (${Cause.pretty(exit.cause).split("\n")[0]}); tried again in a minute`)
        return
      }
      for (const row of exit.value) if (!index.has(row.id)) put(entryOf(row))
      loaded = true
      setIssue("load", undefined)
      // What was read and must go is removed off this step (maintenance repeats a failed removal).
      const now = yield* wallNow
      yield* Effect.ignore(removeDoomed(now))
      enqueueAll()
    })

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

    /** The key's stable id (committed or reserved by an accepted show), else `undefined`. */
    const keyId = (module: string, key: string | undefined) => (key === undefined ? undefined : byKey.get(keyOf(module, key)) ?? pendingKeys.get(keyOf(module, key)))

    type Written = { readonly row: Row<StoredPresentation>; readonly ended: ReadonlyArray<Entry>; readonly before: Entry | undefined } | { readonly limit: string }
    /**
     * Insert (or replace, by its key's id) one presentation inside the caller's transaction, the bounds checked against the
     * state in this attempt; earlier transients that share a device with it are marked ended (an update). Synchronous.
     */
    const writeShow = (p: TxCollection<StoredPresentation>, e: Omit<Entry, "rev">, content: (prior: StoredContent | undefined) => StoredContent, spoken: string, buttons: PendingShow["buttons"], now: number): Written => {
      const problem = boundProblem(e.module, e.lifetime, e.target, e.id, now)
      if (problem !== undefined) return { limit: problem }
      const prior = p.get(e.id)
      const value: StoredPresentation = {
        module: e.module,
        ...(e.key !== undefined ? { key: e.key } : {}),
        part: e.part,
        lifetime: e.lifetime,
        target: e.target,
        ...(e.owner !== undefined ? { owner: e.owner } : {}),
        content: content(prior?.value.ended === true ? undefined : prior?.value.content),
        spoken,
        buttons,
        ...(e.handler !== undefined ? { handler: e.handler } : {}),
        shownAt: e.shownAt,
        expiresAt: e.expiresAt,
        showId: e.showId
      }
      const row = prior !== undefined ? p.update(e.id, () => value) : p.insert(value, { id: e.id })
      const ended = e.lifetime === "transient" ? overlapping(e.target, e.id) : []
      for (const old of ended) {
        const r = p.get(old.id)
        if (r !== undefined && r.value.showId === old.showId) p.update(old.id, (v) => ({ ...v, ended: true as const }))
      }
      return { row, ended, before: index.get(e.id) }
    }
    /** After a show's commit: the index follows what was committed; what it ended leaves the index. */
    const afterShow = (w: Exclude<Written, { readonly limit: string }>, now: number) => {
      for (const old of w.ended) doom(old, now + PRESENT_PURGE_AFTER_MS)
      const e = entryOf(w.row)
      put(e)
      touch(e.id, e.target, w.before?.target)
      requestPlan()
    }

    /** The entry for a show accepted now (its id: the key's stable one when the module shows that key again). */
    const newEntry = (module: string, part: number, target: Entry["target"], presentation: Presentation, o: ShowOptions | undefined, now: number): Omit<Entry, "rev"> => {
      const { lifetime, expiresAt } = presentLifetime(presentation, o, now)
      return {
        id: keyId(module, o?.key) ?? newId(),
        showId: newId(),
        module,
        key: o?.key,
        part,
        lifetime,
        target,
        owner: ownerOf(presentation.sensitivity),
        kind: presentation.kind,
        handler: presentation.handler,
        shownAt: now,
        expiresAt
      }
    }

    const published = new Map<string, PublishedHandler>()
    const known = new Map<string, number>()
    const handlerProblem = (moduleId: string, presentation: Presentation) =>
      presentation.handler !== undefined && !known.has(`${moduleId}/${presentation.handler}`) ? `${moduleId} has no press handler "${presentation.handler}" (register it in shared with present.handle)` : undefined
    const requestProblem = (moduleId: string, presentation: Presentation, o: ShowOptions | undefined, now: number): string | undefined =>
      presentationProblem(presentation, now) ?? showOptionsProblem(o, (presentation as { kind?: PresentKindName }).kind) ?? handlerProblem(moduleId, presentation)

    const partOf = (moduleId: string): number | undefined => {
      const open = openParts.get(moduleId)
      return open === undefined || open.size === 0 ? undefined : Math.max(...open)
    }

    const show = (moduleId: string, partId: number) => (target: PresentTarget, presentation: Presentation, o?: ShowOptions): Effect.Effect<PresentHandle, PresentError> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        const problem = requestProblem(moduleId, presentation, o, now)
        if (problem !== undefined) return yield* invalid(problem)
        if (!loaded) return yield* new PresentError({ reason: "busy", message: "the stored presentations are still being read; try again" })
        const origin = yield* originDevice(undefined)
        const resolved = resolveTarget(target, origin)
        if (typeof resolved === "string") return yield* invalid(resolved)
        const buttons = (presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label }))
        let committed: Entry | undefined
        const out = yield* tx((p) => {
          // The entry (and the key's id) is derived in the attempt that commits.
          const e = newEntry(moduleId, partId, resolved, presentation, o, now)
          return writeShow(p, e, (prior) => storedContentOf(presentation, prior), presentation.spoken, buttons, now)
        }, (w) => {
          if ("limit" in w) return
          afterShow(w, now)
          committed = entryOf(w.row)
        })
        if ("limit" in out) return yield* new PresentError({ reason: "limit", message: out.limit })
        const e = committed ?? entryOf(out.row)
        const c = out.row.value.content
        return handleOf(moduleId, e, outcomeOf(e, { asking: origin, spoken: presentation.spoken, module: moduleId, image: c.kind === "image" && c.hash === undefined && c.failed === undefined }))
      })

    const handleOf = (moduleId: string, e: Entry, outcome: ShowOutcome): PresentHandle => ({
      id: e.id,
      ...(e.key !== undefined ? { key: e.key } : {}),
      outcome,
      update: (presentation) => update(moduleId, e.id, e.showId, presentation),
      dismiss: dismiss(moduleId, e.id, e.showId)
    })

    /** G3: the entry and its row are read again in the attempt that commits; a replaced or ended show changes nothing. */
    const update = (moduleId: string, id: string, showId: string, presentation: Presentation): Effect.Effect<ShowOutcome | undefined, PresentError> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        const problem = presentationProblem(presentation, now) ?? handlerProblem(moduleId, presentation)
        if (problem !== undefined) return yield* invalid(problem)
        const asking = yield* originDevice(undefined)
        const out = yield* tx((p): { readonly row: Row<StoredPresentation> } | { readonly invalid: string } | undefined => {
          const e = index.get(id)
          const row = p.get(id)
          if (e === undefined || row === undefined || row.value.ended === true || e.showId !== showId || row.value.showId !== showId || row.value.module !== moduleId || e.expiresAt <= now) return undefined
          if (presentation.kind !== row.value.content.kind) return { invalid: `an update keeps the kind (${row.value.content.kind}); show a new presentation for another` }
          if (ownerOf(presentation.sensitivity) !== row.value.owner) return { invalid: "an update keeps the sensitivity; show a new presentation for another" }
          const content = storedContentOf(presentation, row.value.content)
          const { handler: _h, ...rest } = row.value
          const next = p.update(id, () => ({
            ...rest,
            content,
            spoken: presentation.spoken,
            buttons: (presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label })),
            ...(presentation.handler !== undefined ? { handler: presentation.handler } : {})
          }), { expectRev: row.rev })
          return { row: next }
        }, (w) => {
          if (w === undefined || "invalid" in w) return
          const e = entryOf(w.row)
          put(e)
          touch(id, e.target)
        })
        if (out === undefined) return undefined
        if ("invalid" in out) return yield* invalid(out.invalid)
        const e = entryOf(out.row)
        const c = out.row.value.content
        return outcomeOf(e, { asking, spoken: presentation.spoken, module: moduleId, image: c.kind === "image" && c.hash === undefined && c.failed === undefined })
      })

    /** G1: no longer eligible at once; the row is marked ended (or removed later by maintenance if that fails). */
    const dismiss = (moduleId: string, id: string, showId: string): Effect.Effect<boolean, PresentError> =>
      Effect.gen(function*() {
        const e = index.get(id)
        if (e === undefined || e.module !== moduleId || e.showId !== showId) return false
        const now = yield* wallNow
        doom(e, now + PRESENT_PURGE_AFTER_MS)
        yield* Effect.ignore(tx((p) => {
          const row = p.get(id)
          if (row !== undefined && row.value.showId === showId && row.value.ended !== true) p.update(id, (v) => ({ ...v, ended: true as const }))
        }))
        return true
      })

    // ---- Accepted shows (way 1): written off the turn's path, retried until written or no longer applying (G5)

    const work: Array<PendingShow> = []
    let writing = false
    const workWake = yield* Queue.sliding<void>(1)
    const writePending = (s: PendingShow): Effect.Effect<void> =>
      Effect.gen(function*() {
        for (let attempt = 0;; attempt++) {
          if (!pending.includes(s)) return
          const now = yield* wallNow
          if (s.entry.expiresAt <= now || !partOpen(s.entry.module, s.entry.part)) return dropPending(s)
          // Its own reservation (the same id) does not count against it in `writeShow`'s bounds.
          const exit = yield* Effect.exit(tx((p): Written | "gone" => {
            if (!pending.includes(s)) return "gone"
            return writeShow(p, s.entry, (prior) => (s.content.kind === "image" && prior?.kind === "image" && prior.url === s.content.url ? { ...s.content, ...(prior.hash !== undefined ? { hash: prior.hash } : {}) } : s.content), s.spoken, s.buttons, now)
          }, (w) => {
            if (w === "gone") return
            dropPending(s)
            if (!("limit" in w)) afterShow(w, now)
          }))
          if (Exit.isSuccess(exit)) {
            if (exit.value !== "gone" && "limit" in exit.value) log(`Presentations: a presentation of ${s.entry.module} passed a bound while it waited (${exit.value.limit}); not shown`)
            s.failed = false
            if (!pending.some((x) => x.failed)) setIssue("write", undefined)
            return
          }
          const pause = writeRetryMs[attempt]
          if (pause === undefined || s.failed) {
            s.failed = true
            setIssue("write", { title: "A presentation could not be shown yet", detail: "The store refused it; it is written again every minute until it is written or has ended." })
            log(`Presentations: a presentation of ${s.entry.module} could not be written (${Cause.pretty(exit.cause).split("\n")[0]}); maintenance writes it again`)
            requestPlan()
            return
          }
          yield* Effect.sleep(pause)
        }
      })
    const workLoop = Effect.gen(function*() {
      for (;;) {
        yield* Queue.take(workWake)
        writing = true
        for (let s = work.shift(); s !== undefined; s = work.shift()) {
          yield* writePending(s)
          yield* Effect.yieldNow
        }
        writing = false
      }
    })

    const fromResult: PresentEngine["fromResult"] = (moduleId, principal, value) =>
      Effect.gen(function*() {
        if (!isPresentResult(value)) return value
        const forModel = value.forModel
        const presentation = value.present
        const o = value.show
        if (moduleId === undefined) return withScreenNote(forModel, refusedNote("this tool belongs to no module"))
        const now = yield* wallNow
        const problem = requestProblem(moduleId, presentation, o, now)
        if (problem !== undefined) {
          log(`Presentations: a presentation of ${moduleId} was refused (${problem})`)
          return withScreenNote(forModel, refusedNote(`the presentation was not valid (${problem.slice(0, 200)})`))
        }
        const spoken = options.pageText(moduleId, presentation.spoken, MAX_NOTE_SPOKEN_CHARS)
        const part = partOf(moduleId)
        if (part === undefined) return withScreenNote(forModel, refusedNote("this module cannot show things (it is not a version 2 module, or it is stopping)", spoken))
        if (!loaded) return withScreenNote(forModel, refusedNote("the screen's data is still being read", spoken))
        const origin = yield* originDevice(principal)
        if (origin === undefined || deviceOf(origin) === undefined) return withScreenNote(forModel, refusedNote("there is no device to show it on", spoken))
        const e = newEntry(moduleId, part, { device: origin }, presentation, o, now)
        const bound = boundProblem(moduleId, e.lifetime, e.target, e.id, now)
        if (bound !== undefined) return withScreenNote(forModel, refusedNote(`too much is on screen (${bound})`, spoken))
        const outcome = outcomeOf(e, { asking: origin, spoken: presentation.spoken, module: moduleId, image: presentation.kind === "image" })
        // Accepted: its key's id reserved, its place held in the bounds, one enqueue; written and shown off the turn's path.
        if (e.key !== undefined) pendingKeys.set(keyOf(moduleId, e.key), e.id)
        const s: PendingShow = { entry: e, content: storedContentOf(presentation), spoken: presentation.spoken, buttons: (presentation.buttons ?? []).map((b) => ({ id: b.id, label: b.label })), failed: false }
        pending.push(s)
        work.push(s)
        void Queue.offerUnsafe(workWake, undefined)
        return withScreenNote(forModel, outcome.note)
      })

    // ---- Presses

    const answer = (ok: boolean, key: PresentTextKey, code?: PresentPressAnswer["code"]): PresentPressAnswer => ({ ok, say: presentText(lang(), key), ...(code !== undefined ? { code } : {}) })
    const claims = new Set<string>()

    const press = (request: PresentPressRequest): Effect.Effect<PresentPressAnswer> =>
      Effect.gen(function*() {
        const now = yield* wallNow
        type Admitted = { readonly row: Row<StoredPresentation>; readonly entry: PublishedHandler } | PresentPressAnswer
        const admitted = ((): Admitted => {
          const conns = heldOf(request.deviceId)
          const holds = conns.some(({ by, conn }) => by.items.has(request.presentationId) && (request.connection === undefined || conn.id === request.connection.id))
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
          if (row === undefined || row.value.showId !== e.showId || row.value.ended === true) return answer(false, "over", "unknown")
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

    const jobRun = (safetyNet: boolean) => () =>
      Effect.suspend(() => {
        plannedAt = safetyNet ? "unknown" : undefined
        return maintain
      })
    yield* jobs.handle(PRESENT_DUE_HANDLER, { payload: Schema.Struct({}), idempotent: true, timeoutMs: 50_000, run: jobRun(false) }).pipe(Effect.orDie)
    yield* jobs.handle(PRESENT_HOURLY_HANDLER, { payload: Schema.Struct({}), idempotent: true, timeoutMs: 50_000, run: jobRun(true) }).pipe(Effect.orDie)
    yield* load
    yield* Effect.forkIn(loop, scope)
    yield* Effect.forkIn(workLoop, scope)
    ensureHourly()
    requestPlan()

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
      // in flight had their grace period): no longer eligible at that moment, removed by maintenance.
      Effect.runSync(Scope.addFinalizer(part.scope, partClosed(moduleId, part.id)))
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
      mediaFor: (token) => {
        const t = tokens.get(token)
        if (t === undefined) return undefined
        const by = held.get(t.connId)
        if (by === undefined || by.items.get(t.id)?.token !== token) return undefined
        if (!connectionsOf(by.deviceId).some((c) => c.id === t.connId)) return undefined
        return t.hash
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
      maintainNow: maintain,
      planNow,
      plannedAt: () => (typeof plannedAt === "number" ? plannedAt : undefined),
      loaded: () => loaded,
      settled: Effect.gen(function*() {
        for (let i = 0; i < 5_000 && (working || writing || planning || all || dirty.size > 0 || work.length > 0 || fetching.size > 0); i++) yield* Effect.yieldNow
      })
    }
    return engine
  })
