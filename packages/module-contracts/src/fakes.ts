/**
 * Small in-memory fakes of every contract (`@pva/module-contracts/fakes`), for the tests of the modules that consume
 * them. Each `makeFake…` returns the service (or contribution) and what the test reads or drives: what was called, and
 * setters for the provider's state. They keep each contract's rules that a consumer can observe (dedupe keys, the
 * snapshot-first stream, the transport's refusals, the bounds) and nothing else; they are not the provider.
 *
 * Give one to the module under test through the test kit (`@pva/core/testing`, `startTestModule({ provide: [...] })`),
 * which publishes it from a stand-in module of the provider's id, so `host.service` and `host.contributions` find it
 * exactly as they find the real one, switching off and back on included.
 */
import { CurrentJob, CurrentTurn } from "@pva/core"
import { Effect, Queue, Stream } from "effect"
import { type BriefingRequest, type BriefingSection, BriefingSectionError, type BriefingSectionResult } from "./briefing.ts"
import { type CalendarEvent, CalendarError, type CalendarProvider, type CalendarSource, type NewEvent } from "./calendar.ts"
import { isLine, type JsonObject } from "./common.ts"
import {
  HA_LIMITS,
  type HaArea,
  type HaChange,
  type HaConnection,
  type HaEntity,
  type HaPerson,
  type HaServiceCall,
  HomeAssistantError,
  type HomeAssistantService,
  REFUSED_DOMAINS,
  SECURITY_COVER_CLASSES
} from "./homeAssistant.ts"
import { type AddItemRequest, type AddItemResult, type ListInfo, type ListItem, type ListRef, LISTS_LIMITS, ListsError, type ListsService } from "./lists.ts"
import { type McpCallResult, McpError, type McpService, type McpToolInfo } from "./mcp.ts"
import { PlaybackError, type PlaybackService, type PlaybackState } from "./playback.ts"
import { type StartTimerRequest, type TimerInfo, TIMERS_LIMITS, TimersError, type TimersService } from "./timers.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Lists

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")
const KEY = /^[A-Za-z0-9_.:@/-]{1,100}$/

/** A lists provider with a default shopping and to-do list (`lists`), keeping the dedupe-key rules of `Lists`. */
export const makeFakeLists = (options: { readonly lists?: ReadonlyArray<Omit<ListInfo, "openItems">> } = {}) => {
  const lists = options.lists ?? [{ id: "shopping", name: "Shopping", kind: "shopping" }, { id: "todo", name: "To do", kind: "todo" }]
  const items: Array<ListItem & { readonly source: AddItemRequest["source"] }> = []
  const calls: Array<{ readonly op: keyof ListsService; readonly arg: unknown }> = []
  let next = 1
  const info = (l: Omit<ListInfo, "openItems">): ListInfo => ({ ...l, openItems: items.filter((i) => i.listId === l.id && i.status === "open").length })
  const resolve = (ref: ListRef) =>
    "kind" in ref ? lists.find((l) => l.kind === ref.kind) : "id" in ref ? lists.find((l) => l.id === ref.id) : lists.find((l) => norm(l.name) === norm(ref.name))
  const invalid = (message: string) => new ListsError({ reason: "invalid", message })
  const service: ListsService = {
    addItem: (request) =>
      Effect.suspend((): Effect.Effect<AddItemResult, ListsError> => {
        calls.push({ op: "addItem", arg: request })
        if (!isLine(request.text, LISTS_LIMITS.textChars) || request.text.trim() === "") return Effect.fail(invalid("The item needs a short text."))
        if (request.note !== undefined && !isLine(request.note, LISTS_LIMITS.noteChars)) return Effect.fail(invalid("The note is too long."))
        const key = request.dedupeKey
        if (key !== undefined && (!KEY.test(key) || !key.startsWith(`${request.source.module}:`))) {
          return Effect.fail(invalid("A dedupe key is the module's id, a colon and its own id."))
        }
        const list = resolve(request.list)
        if (list === undefined) return Effect.fail(new ListsError({ reason: "unknown_list", message: "There is no such list." }))
        const fields = { text: request.text.trim(), ...(request.quantity !== undefined ? { quantity: request.quantity } : {}), ...(request.note !== undefined ? { note: request.note } : {}) }
        const at = key !== undefined ? items.findIndex((i) => i.dedupeKey === key) : items.findIndex((i) => i.listId === list.id && i.status === "open" && norm(i.text) === norm(request.text))
        if (at >= 0) {
          const old = items[at]!
          const outcome = key === undefined ? "merged" : old.status === "done" ? "reopened" : "updated"
          const item = { ...old, ...fields, status: "open" as const }
          items[at] = item
          return Effect.succeed({ outcome, item, list: info(lists.find((l) => l.id === item.listId)!) })
        }
        if (items.filter((i) => i.listId === list.id && i.status === "open").length >= LISTS_LIMITS.itemsPerList) {
          return Effect.fail(new ListsError({ reason: "limit", message: `${list.name} is full.` }))
        }
        const item = { id: `item-${next++}`, listId: list.id, status: "open" as const, source: request.source, ...fields, ...(key !== undefined ? { dedupeKey: key } : {}) }
        items.push(item)
        return Effect.succeed({ outcome: "added" as const, item, list: info(list) })
      }),
    completeByKey: (key) =>
      Effect.sync(() => {
        calls.push({ op: "completeByKey", arg: key })
        const at = items.findIndex((i) => i.dedupeKey === key && i.status === "open")
        if (at < 0) return undefined
        items[at] = { ...items[at]!, status: "done" }
        return items[at]
      }),
    removeByKey: (key) =>
      Effect.sync(() => {
        calls.push({ op: "removeByKey", arg: key })
        const at = items.findIndex((i) => i.dedupeKey === key)
        if (at < 0) return false
        items.splice(at, 1)
        return true
      }),
    find: (ref) =>
      Effect.sync(() => {
        calls.push({ op: "find", arg: ref })
        const list = resolve(ref)
        return list === undefined ? undefined : info(list)
      })
  }
  return { service, items, calls }
}

// ---------------------------------------------------------------------------------------------------------------------
// Timers

/** A timers provider that records the timers it started; `knownDevices` (default: any) is what `unknown_device` checks. */
export const makeFakeTimers = (options: { readonly now?: () => number; readonly knownDevices?: ReadonlyArray<string> } = {}) => {
  const started: Array<TimerInfo & { readonly source: StartTimerRequest["source"] }> = []
  let next = 1
  const service: TimersService = {
    start: (request) =>
      Effect.gen(function*() {
        const { durationMs, label } = request
        if (!Number.isInteger(durationMs) || durationMs < TIMERS_LIMITS.minMs || durationMs > TIMERS_LIMITS.maxMs) {
          return yield* new TimersError({ reason: "invalid", message: "A timer runs from one second to a day." })
        }
        if (label !== undefined && !isLine(label, TIMERS_LIMITS.labelChars)) return yield* new TimersError({ reason: "invalid", message: "That label is too long." })
        const deviceId = request.ringOn?.deviceId ?? (yield* CurrentTurn)?.deviceId ?? (yield* CurrentJob)?.deviceId
        if (deviceId === undefined) return yield* new TimersError({ reason: "no_device", message: "I don't know where to ring it." })
        if (options.knownDevices !== undefined && !options.knownDevices.includes(deviceId)) {
          return yield* new TimersError({ reason: "unknown_device", message: "I don't know that device." })
        }
        if (started.length >= TIMERS_LIMITS.running) return yield* new TimersError({ reason: "limit", message: "There are too many timers running." })
        const timer = { id: `timer-${next++}`, durationMs, dueAt: (options.now ?? Date.now)() + durationMs, ringOn: { deviceId }, source: request.source, ...(label !== undefined ? { label } : {}) }
        started.push(timer)
        return timer
      })
  }
  return { service, started }
}

// ---------------------------------------------------------------------------------------------------------------------
// Home Assistant

/** A Home Assistant transport over entities the test sets; `respond` answers `callService` (default: no response). */
export const makeFakeHomeAssistant = (
  options: {
    readonly entities?: ReadonlyArray<HaEntity>
    readonly areas?: ReadonlyArray<HaArea>
    readonly people?: ReadonlyArray<HaPerson>
    readonly connection?: HaConnection
    readonly respond?: (call: HaServiceCall) => Effect.Effect<JsonObject | undefined, HomeAssistantError>
  } = {}
) => {
  const entities = new Map<string, HaEntity>((options.entities ?? []).map((e) => [e.entityId, e]))
  let areas = [...(options.areas ?? [])]
  let people = [...(options.people ?? [])]
  let connection: HaConnection = options.connection ?? "connected"
  const subscribers = new Set<Queue.Enqueue<HaChange, any>>()
  const calls: Array<HaServiceCall> = []
  const snapshot = (reason: "subscribed" | "reconnected" | "overflow"): HaChange => ({ _tag: "snapshot", reason, connection, entities: [...entities.values()], areas, people })
  const send = (change: HaChange) => {
    for (const q of subscribers) Queue.offerUnsafe(q, change)
  }
  const fail = (reason: HomeAssistantError["reason"], message: string) => Effect.fail(new HomeAssistantError({ reason, message }))
  const service: HomeAssistantService = {
    connection: () => connection,
    entities: () => [...entities.values()],
    entity: (id) => entities.get(id),
    areas: () => areas,
    people: () => people,
    changes: Stream.callback<HaChange>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerUnsafe(queue, snapshot("subscribed"))
          subscribers.add(queue)
        }),
        () => Effect.sync(() => void subscribers.delete(queue))
      ), { bufferSize: HA_LIMITS.queue, strategy: "dropping" }),
    callService: (call) =>
      Effect.suspend(() => {
        calls.push(call)
        if (connection !== "connected") return fail("not_connected", "Home Assistant isn't connected.")
        if (REFUSED_DOMAINS.includes(call.domain)) return fail("refused", "I can't do that through Home Assistant.")
        const ids = call.target?.entityIds ?? []
        for (const id of ids) {
          const entity = entities.get(id)
          if (entity === undefined) return fail("unknown_entity", "Home Assistant doesn't have that.")
          if (entity.domain === "cover" && SECURITY_COVER_CLASSES.includes(entity.deviceClass ?? "")) return fail("refused", "I can't open or close that.")
        }
        for (const id of call.target?.areaIds ?? []) if (!areas.some((a) => a.id === id)) return fail("unknown_entity", "Home Assistant doesn't have that area.")
        return (options.respond?.(call) ?? Effect.succeed(undefined)).pipe(Effect.map((response) => (response === undefined ? {} : { response })))
      })
  }
  return {
    service,
    calls,
    /** Add or change an entity: subscribers get `changed`. */
    set: (entity: HaEntity) => {
      const previous = entities.get(entity.entityId)
      entities.set(entity.entityId, entity)
      send({ _tag: "changed", entity, previous })
    },
    remove: (entityId: string) => {
      if (entities.delete(entityId)) send({ _tag: "removed", entityId })
    },
    setPeople: (next: ReadonlyArray<HaPerson>) => void (people = [...next]),
    setAreas: (next: ReadonlyArray<HaArea>) => void (areas = [...next]),
    /** The socket dropped (`reconnecting`) or came back (`connected`); coming back sends a fresh snapshot, as the real one does. */
    setConnection: (next: HaConnection) => {
      connection = next
      send({ _tag: "connection", connection: next })
      if (next === "connected") send(snapshot("reconnected"))
    },
    /** As if a subscriber fell behind: every subscriber gets a snapshot with `reason: "overflow"`. */
    overflow: () => send(snapshot("overflow"))
  }
}

/** An entity for `makeFakeHomeAssistant`. */
export const haEntity = (entityId: string, state: string, extra: Partial<Omit<HaEntity, "entityId" | "state">> = {}): HaEntity => ({
  entityId,
  domain: entityId.split(".")[0] ?? "",
  name: entityId,
  aliases: [],
  attributes: {},
  attributesCut: false,
  lastChanged: 0,
  state,
  ...extra
})

// ---------------------------------------------------------------------------------------------------------------------
// Playback

/** A playback provider over rooms the test sets (`rooms`: room → state); rooms are compared case-insensitively. */
export const makeFakePlayback = (rooms: Readonly<Record<string, Omit<PlaybackState, "room">>> = {}) => {
  const state = new Map(Object.entries(rooms).map(([room, s]) => [norm(room), { ...s }]))
  const calls: Array<{ readonly op: "pause" | "resume" | "changeVolume"; readonly room: string; readonly change?: unknown }> = []
  const noPlayer = () => Effect.fail(new PlaybackError({ reason: "no_player", message: "Nothing plays music there." }))
  const service: PlaybackService = {
    inRoom: (room) => {
      const s = state.get(norm(room))
      return s === undefined ? undefined : { room, ...s }
    },
    pause: (room) =>
      Effect.suspend(() => {
        calls.push({ op: "pause", room })
        const s = state.get(norm(room))
        if (s === undefined) return noPlayer()
        if (s.state !== "playing") return Effect.succeed(false)
        state.set(norm(room), { ...s, state: "paused" })
        return Effect.succeed(true)
      }),
    resume: (room) =>
      Effect.suspend(() => {
        calls.push({ op: "resume", room })
        const s = state.get(norm(room))
        if (s === undefined) return noPlayer()
        if (s.state !== "paused") return Effect.succeed(false)
        state.set(norm(room), { ...s, state: "playing" })
        return Effect.succeed(true)
      }),
    changeVolume: (room, change) =>
      Effect.suspend(() => {
        calls.push({ op: "changeVolume", room, change })
        const s = state.get(norm(room))
        if (s === undefined) return noPlayer()
        const level = "to" in change ? change.to : (s.volume ?? 0.5) + change.by
        if (!Number.isFinite(level) || ("to" in change ? change.to < 0 || change.to > 1 : change.by < -1 || change.by > 1)) {
          return Effect.fail(new PlaybackError({ reason: "invalid", message: "That volume is out of range." }))
        }
        const volume = Math.min(1, Math.max(0, level))
        state.set(norm(room), { ...s, volume })
        return Effect.succeed(volume)
      })
  }
  return { service, calls }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mcp

/** One fake MCP server: its tools and how it answers a call. */
export interface FakeMcpServer {
  readonly tools: ReadonlyArray<McpToolInfo>
  readonly call?: (name: string, args: JsonObject) => McpCallResult
  /** Answers every request with this failure (a server that is down, or refuses the token). */
  readonly fails?: McpError["reason"]
}

/** An MCP transport whose servers are keyed by URL; `opened` and `called` record what the consumer did. */
export const makeFakeMcp = (servers: Readonly<Record<string, FakeMcpServer>>) => {
  const opened: Array<{ readonly name: string; readonly url: string; readonly closed: boolean }> = []
  const called: Array<{ readonly url: string; readonly name: string; readonly args: JsonObject }> = []
  const service: McpService = {
    open: (options) =>
      Effect.gen(function*() {
        const server = servers[options.url]
        if (server === undefined) return yield* new McpError({ reason: "unreachable", message: `I couldn't reach ${options.name}.` })
        if (server.fails !== undefined) return yield* new McpError({ reason: server.fails, message: `${options.name} refused.` })
        if (options.token !== undefined) yield* options.token()
        const record = { name: options.name, url: options.url, closed: false }
        opened.push(record)
        yield* Effect.addFinalizer(() => Effect.sync(() => void (opened[opened.indexOf(record)] = { ...record, closed: true })))
        const closed = () => opened.some((o) => o.url === options.url && o.name === options.name && o.closed)
        return {
          server: { name: options.name, version: "1.0.0", protocolVersion: "2025-11-25" },
          listTools: () => (closed() ? Effect.fail(new McpError({ reason: "closed", message: "The connection is closed." })) : Effect.succeed({ tools: server.tools, left: 0 })),
          callTool: (name, args) =>
            Effect.suspend(() => {
              if (closed()) return Effect.fail(new McpError({ reason: "closed", message: "The connection is closed." }))
              if (!server.tools.some((t) => t.name === name)) return Effect.fail(new McpError({ reason: "unknown_tool", message: `${options.name} has no such tool.` }))
              called.push({ url: options.url, name, args })
              return Effect.succeed(server.call?.(name, args) ?? { isError: false, text: "", truncated: false })
            })
        }
      })
  }
  return { service, opened, called }
}

// ---------------------------------------------------------------------------------------------------------------------
// Calendar providers

/** A calendar provider over fixed sources and events; writable sources accept `add` and `remove`. */
export const makeFakeCalendarProvider = (options: {
  readonly id: string
  readonly label?: string
  readonly sources: ReadonlyArray<CalendarSource>
  readonly events?: ReadonlyArray<CalendarEvent>
}) => {
  const events = [...(options.events ?? [])]
  const added: Array<{ readonly sourceId: string; readonly eventRef: string; readonly event: NewEvent }> = []
  const startOf = (e: CalendarEvent) => ("at" in e.start ? e.start.at : Date.parse(`${e.start.date}T00:00:00Z`))
  const source = (id: string) => options.sources.find((s) => s.id === id)
  const unknown = () => new CalendarError({ reason: "unknown_source", message: "I don't know that calendar." })
  let next = 1
  const provider: CalendarProvider = {
    id: options.id,
    label: options.label ?? options.id,
    sources: () => Effect.succeed(options.sources),
    events: (sourceId, window) =>
      Effect.suspend(() => {
        if (source(sourceId) === undefined) return Effect.fail(unknown())
        const inWindow = events.filter((e) => e.sourceId === sourceId && startOf(e) >= window.from && startOf(e) < window.to).sort((a, b) => startOf(a) - startOf(b))
        return Effect.succeed({ events: inWindow.slice(0, 500), cut: inWindow.length > 500 })
      }),
    add: (sourceId, event) =>
      Effect.suspend(() => {
        const s = source(sourceId)
        if (s === undefined) return Effect.fail(unknown())
        if (!s.writable) return Effect.fail(new CalendarError({ reason: "read_only", message: `${s.label} is read-only.` }))
        const eventRef = `${options.id}-${next++}`
        const stored: CalendarEvent = { sourceId, uid: eventRef, title: event.title, start: event.start, end: event.end, status: "confirmed", owner: s.owner, repeats: false, ...(event.location !== undefined ? { location: event.location } : {}) }
        events.push(stored)
        added.push({ sourceId, eventRef, event })
        return Effect.succeed({ eventRef, event: stored })
      }),
    remove: (sourceId, eventRef) =>
      Effect.sync(() => {
        const at = events.findIndex((e) => e.sourceId === sourceId && e.uid === eventRef)
        if (at < 0) return false
        events.splice(at, 1)
        return true
      })
  }
  return { provider, events, added }
}

// ---------------------------------------------------------------------------------------------------------------------
// Briefing sections

/** A briefing section answering `result` (or what `gather` makes of the request); `requests` records every call. */
export const makeFakeBriefingSection = (options: {
  readonly id: string
  readonly title?: string
  readonly result?: BriefingSectionResult
  readonly gather?: (request: BriefingRequest) => Effect.Effect<BriefingSectionResult, BriefingSectionError>
}) => {
  const requests: Array<BriefingRequest> = []
  const section: BriefingSection = {
    id: options.id,
    title: options.title ?? options.id,
    gather: (request) =>
      Effect.suspend(() => {
        requests.push(request)
        if (options.gather !== undefined) return options.gather(request)
        return options.result === undefined ? Effect.fail(new BriefingSectionError({ reason: "failed", message: `I couldn't get ${options.id}.` })) : Effect.succeed(options.result)
      })
  }
  return { section, requests }
}
