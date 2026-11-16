import type { AudioClientLink } from "@pva/audio-web"
import type { HostResult, ModuleHost } from "@pva/core"
import {
  type AdminSnapshot,
  type AdminState,
  type ClientMessage,
  CloseCode,
  type ConversationInfo,
  DEVICE_EDITABLE_FIELDS,
  type DeviceHello,
  type DeviceProfile,
  type DeviceProfileInfo,
  engineSummary,
  decodeClientMessage,
  decodeMicFrame,
  encodeServerMessage,
  type ErrorInfo,
  type FrontendRole,
  MAX_PASSWORD_CHARS,
  micSequenceGap,
  PROTOCOL_VERSION,
  type RequestId,
  type ServerMessage,
  type ServerMessageType,
  type Snapshot,
  WAKE_TEST_MAX_MS
} from "@pva/protocol"
import { Effect } from "effect"
import type { AccessPolicy } from "./access.ts"
import type { AdminSessions, SessionEndReason } from "./AdminSessions.ts"
import type { AssistantResult, Assistants } from "./assistants.ts"
import type { Engine } from "./Engine.ts"
import type { EnvMover } from "./envSettings.ts"
import { type FrontendResult, type Frontends, kindOf } from "./frontends.ts"
import type { Jobs } from "./jobs.ts"
import type { Models } from "./models.ts"
import type { Keys } from "./Keys.ts"
import { historyItems } from "./Publisher.ts"
import type { Sections } from "./sections.ts"
import type { VoiceSession } from "./VoiceSession.ts"
import type { VoiceSessions } from "./VoiceSessions.ts"

/**
 * Connections, handshake, roles and ownership, request routing, broadcast and
 * send limits (docs/UI-AND-MODULES.md §2.1, §2.3). Transport-neutral: `http.ts`
 * adapts `ws` sockets to `HubConnection`.
 *
 * Protocol 5 (docs/FRONTENDS-AND-ACTIVATION.md):
 * - **Admin** is per connection and comes only from an admin session: `admin.login` with `PVA_ADMIN_PASSWORD`, or a
 *   valid token in `hello.adminToken` on an admin front end (`AdminSessions`). Every request that changes the
 *   server (settings, modules, engine reload, vault, `.env` moves, jobs, models, front ends, devices, the phrase
 *   tester) from any other connection is answered `admin_required`. Unlocking the vault needs an admin connection
 *   *and* the vault password; typing the vault password no longer grants anything.
 * - **Role-shaped data**: `welcome` carries the voice part of the state only. Admin data (`admin.snapshot`, and the
 *   messages in `ADMIN_ONLY`) goes to admin connections only, `admin.snapshot` right after a successful login or a
 *   valid hello token; it stops at logout or when the session ends.
 * - **Devices**: a voice `hello` with `device` registers it (`Frontends.seen`); each voice connection is sent its
 *   effective profile (`snapshot.device`, then `device.profile` whenever it changes).
 *
 * Protocol 6 (docs/VOICE-SESSIONS.md): every voice device has its own **voice session** (`VoiceSessions`), keyed by
 * `hello.device.id` (else the connection's `clientId`), created at the device's first `audio.claim` or `text.send`.
 * Ownership is per session: one tab of the device owns its audio, its other tabs observe, the last claim *on that
 * device* wins, and a claim on another device takes nothing from this one. A session's messages (state, transcript,
 * turns, replies, wake, conversation) go to its device's connections only (`toSession`); shared ones (engine
 * summary, jobs, …) are broadcast. The device's profile configures its session (`VoiceSession.syncProfile`).
 */

export interface HubConnection {
  readonly id: string
  readonly sendText: (text: string) => void
  readonly sendBinary: (data: Uint8Array) => void
  readonly close: (code: number, reason: string) => void
  /** Bytes queued for sending. */
  readonly bufferedAmount: () => number
}

export interface ConnectionHandlers {
  readonly onText: (text: string) => void
  readonly onBinary: (data: Uint8Array) => void
  readonly onClose: () => void
}

export interface SessionHub {
  /** A new socket. `undefined` when the connection limit is reached (the socket has been closed). */
  readonly accept: (connection: HubConnection) => ConnectionHandlers | undefined
  /**
   * Send to every connection that has completed the handshake; messages in `ADMIN_ONLY` only to admin connections.
   */
  readonly broadcast: (message: ServerMessage) => void
  /** Send to every connection of one voice session's device (its turns, state, replies, conversation). */
  readonly toSession: (key: string, message: ServerMessage) => void
  /** The voice sessions changed (`minor`: only a state or the owner): admin gets `sessions` (throttled when minor). */
  readonly sessionsChanged: (minor: boolean) => void
  /** A voice session was discarded: forget its ownership. */
  readonly sessionDiscarded: (key: string) => void
  /** The effective profile of a session's device. */
  readonly profileOf: (key: string) => DeviceProfile
  readonly closeAll: (code: number, reason: string) => void
  readonly size: () => number
  /** Microphone frames lost between a session's owner tab and the server (sequence gaps), since the session started. */
  readonly micFramesLost: (key: string) => number
  /** The vault changed: send every admin connection its view (`vault`). */
  readonly vaultChanged: () => void
  /**
   * Profiles may have changed (kind defaults, a device, the enabled voices): send `device.profile` to every
   * connection whose effective profile changed, and tell serve mode about the owner's.
   */
  readonly refreshProfiles: () => void
  /**
   * One final transcript of a session, for admin connections with the phrase tester on that follow it (`wake.heard`;
   * `wake.test.deviceId`, else the most recently active session): the phrase it matched, and whether its wake gate
   * accepted it.
   */
  readonly wakeHeard: (key: string, text: string, phrase: string | undefined, accepted: boolean) => void
}

export interface HubOptions {
  readonly engine: Engine
  readonly host: ModuleHost
  readonly sections: Sections
  /** The voice sessions (one per device). */
  readonly sessions: VoiceSessions
  /** Run an effect in the server's scope (requests that do work). */
  readonly run: (effect: Effect.Effect<void>) => void
  /** After a settings section was saved (`path`: its settings page, `<group>/<page>`). */
  readonly onSectionSaved: (sectionId: string, needsReload: boolean, path: string) => void
  readonly server: { readonly name: string; readonly version: string }
  readonly keys: Keys
  readonly access: AccessPolicy
  /** `PVA_ADMIN_PASSWORD` and the admin sessions. */
  readonly admin: AdminSessions
  /** Front-end kinds, devices and profiles (protocol 5 messages). */
  readonly frontends: Frontends
  /** Assistants, device types and devices of protocol 7 (docs/ASSISTANTS.md §5). */
  readonly assistants: Assistants
  /** Settings from outside the UI and "Move to settings". Absent: no `env` in the snapshot, moves refused. */
  readonly env?: EnvMover
  /** Model downloads (jobs). Absent: none offered. */
  readonly models?: Models
  readonly jobs?: Jobs
  readonly helloTimeoutMs?: number
  readonly maxConnections?: number
  readonly observerBufferLimit?: number
  readonly ownerBufferLimit?: number
  /** Requests that do work (settings, modules, reload) running at once, per connection. Default 4. */
  readonly maxPendingPerConnection?: number
  /** The same, over all connections. Default 16. */
  readonly maxPendingTotal?: number
  /** Minor `devices` and `sessions` changes (last seen, connections, owner, state) are sent at most this often. Default 1000 ms. */
  readonly devicesThrottleMs?: number
}

/** Server messages that carry admin data: sent to admin connections only. */
export const ADMIN_ONLY: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
  "module.changed",
  "section.changed",
  "engine",
  "vault",
  "env",
  "job",
  "models",
  "admin.snapshot",
  "frontends",
  "devices",
  "assistants",
  "device.types",
  "sessions",
  "trace",
  "wake.heard"
])

interface Client {
  readonly connection: HubConnection
  helloed: boolean
  closed: boolean
  clientId: string | undefined
  /** `hello.frontend`. */
  role: FrontendRole
  /** `hello.device` (voice connections), when its kind is known. */
  device: DeviceHello | undefined
  /** The voice session this connection belongs to (voice connections, after hello): its device id, else its clientId. */
  sessionKey: string | undefined
  helloTimer: ReturnType<typeof setTimeout> | undefined
  lastSeq: number | undefined
  lastGapErrorAt: number
  warned: Set<string>
  /** Requests of this connection still running. */
  pending: number
  /** This connection as the audio link (one object per connection, so a repeated claim is not a change of owner). */
  link: AudioClientLink | undefined
  /** The admin session token of this connection (it is admin while the session is valid). */
  adminToken: string | undefined
  /** The `device.profile` last sent (JSON), to send only changes. */
  lastProfile: string | undefined
  /** The `device.setup` last sent (JSON; voice connections), to send only changes. */
  lastSetup: string | undefined
  /** The phrase tester is on until then (epoch ms; 0 = off). */
  wakeTestUntil: number
  /** The device whose session the phrase tester follows (`undefined`: the most recently active one). */
  wakeTestDevice: string | undefined
}

/** Who owns a session's audio (per device), and what the hub remembers about it. */
interface Ownership {
  owner: Client | undefined
  /** The last tab that owned this session's audio (`resumeOwner`). */
  lastOwnerClientId: string | undefined
  micLive: boolean
  micFramesLost: number
}

const MIC_GAP_ERROR_INTERVAL_MS = 10_000

const ADMIN_REQUIRED_MESSAGE = "This needs the admin page: log in there with the admin password"

export const makeSessionHub = (options: HubOptions): SessionHub => {
  const clients = new Set<Client>()
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000
  const maxConnections = options.maxConnections ?? 24
  const { keys, access, admin, frontends, assistants } = options
  const observerLimit = options.observerBufferLimit ?? 1_048_576
  const ownerLimit = options.ownerBufferLimit ?? 8_388_608
  const devicesThrottleMs = options.devicesThrottleMs ?? 1_000
  const { sessions } = options
  /** Per session key; created at the first claim on that device, dropped when its session is discarded. */
  const owners = new Map<string, Ownership>()
  const ownershipOf = (key: string): Ownership => {
    let o = owners.get(key)
    if (o === undefined) {
      o = { owner: undefined, lastOwnerClientId: undefined, micLive: false, micFramesLost: 0 }
      owners.set(key, o)
    }
    return o
  }
  const isOwner = (client: Client) => client.sessionKey !== undefined && owners.get(client.sessionKey)?.owner === client
  const sessionOf = (client: Client): VoiceSession | undefined => (client.sessionKey === undefined ? undefined : sessions.get(client.sessionKey))
  /** The conversation an admin connection's snapshot names (admin has no session). */
  const adminConversation: ConversationInfo = { id: globalThis.crypto.randomUUID(), startedAt: Date.now() }
  const maxPendingPerConnection = options.maxPendingPerConnection ?? 4
  const maxPendingTotal = options.maxPendingTotal ?? 16
  let pendingTotal = 0

  const drop = (client: Client, code: number, reason: string) => {
    if (client.closed) return
    client.closed = true
    try {
      client.connection.close(code, reason)
    } catch {
      // already closed
    }
    lost(client)
  }

  /** Over the send limit: close it; it will reconnect for a fresh snapshot. */
  const overLimit = (client: Client) => {
    if (client.connection.bufferedAmount() <= (isOwner(client) ? ownerLimit : observerLimit)) return false
    drop(client, CloseCode.tooSlow, "too far behind")
    return true
  }

  const sendText = (client: Client, text: string) => {
    if (client.closed || overLimit(client)) return
    client.connection.sendText(text)
  }
  const send = (client: Client, message: ServerMessage) => sendText(client, encodeServerMessage(message))

  // ---- Admin access

  /** This connection is admin now (a valid session). An ended session is noticed here too (`onEnd`). */
  const isAdmin = (client: Client) => client.adminToken !== undefined && admin.check(client.adminToken) !== undefined

  const broadcast = (message: ServerMessage) => {
    const text = encodeServerMessage(message)
    const adminOnly = ADMIN_ONLY.has(message.type)
    for (const client of clients) if (client.helloed && (!adminOnly || isAdmin(client))) sendText(client, text)
  }

  /** A session's message: to the connections of its device only. */
  const toSession = (key: string, message: ServerMessage) => {
    const text = encodeServerMessage(message)
    for (const client of clients) if (client.helloed && client.sessionKey === key) sendText(client, text)
  }

  const adminState = (client: Client, endReason?: AdminState["endReason"]): AdminState => {
    const session = client.adminToken === undefined ? undefined : admin.check(client.adminToken)
    const retry = admin.retryAfterMs()
    return {
      enabled: admin.enabled,
      loggedIn: session !== undefined,
      ...(retry > 0 && session === undefined ? { retryAfterMs: retry } : {}),
      ...(session !== undefined ? { expiresAt: session.expiresAt } : {}),
      ...(endReason !== undefined ? { endReason } : {})
    }
  }

  const sendVault = (client: Client) => {
    if (client.helloed && isAdmin(client)) send(client, { type: "vault", vault: keys.info(true) })
  }

  /** A session ended (logout anywhere, expiry, idle): every connection that used it stops being admin. */
  admin.onEnd((token: string, reason: SessionEndReason) => {
    for (const client of clients) {
      if (client.adminToken !== token) continue
      client.adminToken = undefined
      client.wakeTestUntil = 0
      client.wakeTestDevice = undefined
      if (client.helloed) send(client, { type: "admin.state", admin: adminState(client, reason) })
    }
  })

  /** An admin-only request: allowed (and counted as an admin action) on an admin connection, else `admin_required`. */
  const allowed = (client: Client, requestId: RequestId): boolean => {
    if (client.adminToken !== undefined && admin.touch(client.adminToken)) return true
    result(client, requestId, failure("admin_required", admin.enabled ? ADMIN_REQUIRED_MESSAGE : adminDisabledMessage))
    return false
  }
  const adminDisabledMessage = "Admin is disabled: set PVA_ADMIN_PASSWORD in .env (at least 8 characters) and restart the assistant"

  /** A vault request (admin only, checked before); a refusal may have started a wait: show it on this page. */
  const vaultRequest = (client: Client, requestId: RequestId, op: Effect.Effect<HostResult>) =>
    options.run(Effect.map(op, (r) => {
      result(client, requestId, r)
      if (!r.ok) sendVault(client)
    }))

  const result = (client: Client, requestId: RequestId, outcome: HostResult | FrontendResult | AssistantResult) =>
    send(
      client,
      outcome.ok
        ? { type: "result", requestId, ok: true, ...("assistantId" in outcome && outcome.assistantId !== undefined ? { assistantId: outcome.assistantId } : {}) }
        : { type: "result", requestId, ok: false, error: outcome.error }
    )

  const failure = (code: ErrorInfo["code"], message: string): HostResult => ({ ok: false, error: { code, message } })

  /**
   * Runs a request that does work, within the limits: a tab sending requests faster than they complete gets
   * `busy` answers instead of an ever-growing pile of operations (and disk writes) behind it.
   */
  const limited = (
    client: Client,
    requestId: RequestId,
    work: Effect.Effect<HostResult | FrontendResult | AssistantResult, never>,
    after?: (r: HostResult | FrontendResult | AssistantResult) => void
  ) => {
    if (client.pending >= maxPendingPerConnection || pendingTotal >= maxPendingTotal) {
      return result(client, requestId, failure("busy", "Too many changes at once; try again in a moment"))
    }
    client.pending++
    pendingTotal++
    options.run(work.pipe(
      // A request that dies is still answered (exactly one result per request, §2.3).
      Effect.catchCause((cause) =>
        Effect.as(Effect.logError("serve: request failed", cause), failure("internal", "The assistant could not complete that request"))
      ),
      Effect.map((r) => {
        result(client, requestId, r)
        after?.(r)
      }),
      Effect.ensuring(Effect.sync(() => {
        client.pending--
        pendingTotal--
      }))
    ))
  }

  // ---- Devices and profiles

  const profileOf = (client: Client): DeviceProfile => frontends.profile(client.device?.id, client.device?.kind)
  const profileInfo = (client: Client): DeviceProfileInfo => ({
    ...(client.device !== undefined ? { deviceId: client.device.id } : {}),
    profile: profileOf(client),
    editable: client.device !== undefined ? [...DEVICE_EDITABLE_FIELDS] : []
  })

  const live = (id: string) => {
    let connections = 0
    for (const c of clients) if (!c.closed && c.device?.id === id) connections++
    // "Talking now": one of the device's tabs owns its session's audio.
    return { connections, audioOwner: owners.get(id)?.owner !== undefined }
  }
  /** The helloed connections of a session's device. */
  const connectionsOf = (key: string) => {
    let n = 0
    for (const c of clients) if (!c.closed && c.helloed && c.sessionKey === key) n++
    return n
  }
  const connectedDevices = () => new Set([...clients].flatMap((c) => (c.device !== undefined && !c.closed ? [c.device.id] : [])))

  let devicesTimer: ReturnType<typeof setTimeout> | undefined
  let devicesSentAt = -Infinity
  const sendDevices = () => {
    if (devicesTimer !== undefined) clearTimeout(devicesTimer)
    devicesTimer = undefined
    devicesSentAt = performance.now()
    broadcast({ type: "devices", devices: [...assistants.devices(frontends.devices(live))] })
  }
  /** `minor`: only last seen, connections or the audio owner changed (throttled). */
  const devicesChanged = (minor: boolean) => {
    if (![...clients].some((c) => c.helloed && c.adminToken !== undefined)) return
    if (!minor) return sendDevices()
    if (devicesTimer !== undefined) return
    const wait = Math.max(0, devicesSentAt + devicesThrottleMs - performance.now())
    if (wait === 0) return sendDevices()
    devicesTimer = setTimeout(sendDevices, wait)
    devicesTimer.unref?.()
  }

  let sessionsTimer: ReturnType<typeof setTimeout> | undefined
  let sessionsSentAt = -Infinity
  const sendSessions = () => {
    if (sessionsTimer !== undefined) clearTimeout(sessionsTimer)
    sessionsTimer = undefined
    sessionsSentAt = performance.now()
    broadcast({ type: "sessions", sessions: [...sessions.list()] })
  }
  /** `minor`: only a state or an owner changed (throttled like `devices`). */
  const sessionsChanged = (minor: boolean) => {
    if (![...clients].some((c) => c.helloed && c.adminToken !== undefined)) return
    if (!minor) return sendSessions()
    if (sessionsTimer !== undefined) return
    const wait = Math.max(0, sessionsSentAt + devicesThrottleMs - performance.now())
    if (wait === 0) return sendSessions()
    sessionsTimer = setTimeout(sendSessions, wait)
    sessionsTimer.unref?.()
  }

  /** The effective profile of a session's device (a session without a device: the kind defaults). */
  const profileOfKey = (key: string): DeviceProfile => {
    // A key that is no device id (a connection without a device) has no record: the kind defaults.
    const client = [...clients].find((c) => c.sessionKey === key && c.device !== undefined)
    return frontends.profile(key, client?.device?.kind)
  }

  const refreshProfiles = () => {
    for (const client of clients) {
      if (!client.helloed || client.role !== "voice") continue
      const info = profileInfo(client)
      const text = JSON.stringify(info)
      if (text === client.lastProfile) continue
      client.lastProfile = text
      send(client, { type: "device.profile", ...info })
    }
    for (const session of sessions.all()) session.syncProfile()
    refreshSetups()
  }

  /** Send `device.setup` to every voice connection whose setup changed (never to admin connections: it is the voice page's). */
  const refreshSetups = () => {
    for (const client of clients) {
      if (!client.helloed || client.role !== "voice") continue
      const setup = assistants.setupFor(client.device?.id, client.device?.kind)
      const text = JSON.stringify(setup)
      if (text === client.lastSetup) continue
      client.lastSetup = text
      send(client, { type: "device.setup", ...setup })
    }
  }

  /** The admin pages' lists of assistants and device types (admin connections only). */
  const pushAssistants = () => {
    if (![...clients].some((c) => c.helloed && isAdmin(c))) return
    broadcast({ type: "assistants", assistants: [...assistants.infos()] })
    broadcast({ type: "device.types", types: [...assistants.deviceTypes()] })
  }

  /**
   * An assistant, device-type or device change was saved (new messages, `device.pick`): sessions apply their route
   * configuration without a reload (`refreshProfiles` → `syncProfile`), voice connections get their new setup, admin
   * connections the lists.
   */
  const afterAssistantsChange = (r: HostResult | FrontendResult | AssistantResult) => {
    if (!r.ok) return
    refreshProfiles()
    pushAssistants()
    devicesChanged(false)
    sessionsChanged(false)
  }
  /** Remember the device of this connection (background save), then push what changed. */
  const registerDevice = (device: DeviceHello) =>
    options.run(Effect.andThen(frontends.seen(device, connectedDevices()), Effect.sync(() => {
      refreshProfiles()
      devicesChanged(false)
    })))

  /** A profile-changing request finished: push the new profiles and lists. */
  const afterProfileChange = (kinds: boolean) => (r: HostResult | FrontendResult) => {
    if (!r.ok) return
    refreshProfiles()
    if (kinds) broadcast({ type: "frontends", frontends: [...frontends.kinds()] })
    pushAssistants()
    devicesChanged(false)
  }

  // ---- Ownership

  const linkFor = (client: Client): AudioClientLink =>
    client.link ??= {
      sendMessage: (message) => send(client, message),
      sendBinary: (data) => {
        if (client.closed || overLimit(client)) return
        client.connection.sendBinary(data)
      }
    }

  /** To every connection of the session's device: its role there. */
  const announce = (key: string, reason: "claimed" | "released" | "taken_over" | "owner_disconnected" | "resumed", previous?: Client) => {
    const o = owners.get(key)
    for (const client of clients) {
      if (!client.helloed || client.sessionKey !== key) continue
      send(client, {
        type: "session",
        role: o?.owner === client ? "owner" : "observer",
        ownerPresent: o?.owner !== undefined,
        reason: client === previous && reason === "claimed" ? "taken_over" : reason
      })
    }
  }

  const syncOwner = (key: string) => {
    const o = owners.get(key)
    sessions.get(key)?.ownerChanged(o?.owner !== undefined, o?.owner !== undefined && o.micLive)
    devicesChanged(true)
  }

  const becomeOwner = (client: Client, session: VoiceSession) => {
    const o = ownershipOf(session.key)
    o.owner = client
    o.lastOwnerClientId = client.clientId
    o.micLive = true
    client.lastSeq = undefined
    session.web.setOwner(linkFor(client))
    session.web.setMicLive(true)
  }

  const release = (key: string) => {
    const o = owners.get(key)
    if (o === undefined) return
    o.owner = undefined
    o.micLive = false
    const session = sessions.get(key)
    session?.web.setOwner(undefined)
    session?.web.setMicLive(false)
  }

  /** `sessions_full`: the device would start one voice session more than `MAX_VOICE_SESSIONS` allows. */
  const sessionsFull = (): ErrorInfo => ({
    code: "sessions_full",
    message: `The assistant is already talking on ${sessions.size()} device${sessions.size() === 1 ? "" : "s"}; try again when one of them has stopped`
  })

  const lost = (client: Client) => {
    if (client.helloTimer !== undefined) clearTimeout(client.helloTimer)
    if (!clients.delete(client)) return
    if (client.device !== undefined) {
      frontends.left(client.device.id)
      devicesChanged(true)
    }
    const key = client.sessionKey
    if (key === undefined) return
    if (owners.get(key)?.owner === client) {
      release(key)
      announce(key, "owner_disconnected")
      syncOwner(key)
    }
    sessions.connections(key, connectionsOf(key))
  }

  // ---- Snapshots

  /** Protocol 7: the device's setup and the conversations its session has (none before the session exists). */
  const voicePart = (client: Client, session: VoiceSession | undefined): Pick<Snapshot, "setup" | "conversations"> => {
    const setup = assistants.setupFor(client.device?.id, client.device?.kind)
    return {
      setup,
      conversations: session === undefined
        ? []
        : setup.assistants.map((a) => {
          const c = session.conversation.conversation(a.id)
          return { assistantId: a.id, id: c.id, startedAt: c.startedAt, turns: session.conversation.turnsOf(a.id) }
        })
    }
  }

  /** The voice part: of the connection's own session (its device's), or of none yet. */
  const snapshot = (client: Client, endReason?: AdminState["endReason"]): Snapshot => {
    const key = client.sessionKey
    const session = sessionOf(client)
    const o = key === undefined ? undefined : owners.get(key)
    // Whose conversation `history` is (it follows the follow-up holder): the page files it under that assistant.
    const answering = session?.conversation.answering()
    return {
      state: session?.tracker.current().state ?? "idle",
      role: isOwner(client) ? "owner" : "observer",
      ownerPresent: o?.owner !== undefined,
      engine: engineSummary(options.engine.status()),
      ...(answering !== undefined ? { answering } : {}),
      history: session === undefined ? [] : historyItems(Effect.runSync(session.conversation.history())),
      ...(client.role === "voice" ? { device: profileInfo(client) } : {}),
      admin: adminState(client, endReason),
      conversation: key === undefined ? adminConversation : sessions.conversation(key),
      ...(client.role === "voice" ? voicePart(client, session) : {})
    }
  }

  const adminSnapshot = (): AdminSnapshot => ({
    engine: options.engine.status(),
    modules: options.host.modules().map(access.module),
    sections: options.sections.list().map(access.section),
    traces: [...sessions.traces()],
    vault: keys.info(true),
    ...(options.env !== undefined ? { env: options.env.info() } : {}),
    models: options.models?.list() ?? [],
    jobs: options.jobs?.list() ?? [],
    frontends: [...frontends.kinds()],
    devices: [...assistants.devices(frontends.devices(live))],
    sessions: [...sessions.list()],
    assistants: [...assistants.infos()],
    deviceTypes: [...assistants.deviceTypes()]
  })

  const hello = (client: Client, message: ClientMessage) => {
    if (message.type !== "hello") return drop(client, CloseCode.helloTimeout, "the first message must be hello")
    if (client.helloTimer !== undefined) clearTimeout(client.helloTimer)
    if (message.protocol !== PROTOCOL_VERSION) {
      send(client, { type: "error", error: { code: "bad_message", message: "This page is out of date; reload it" } })
      return drop(client, CloseCode.protocolMismatch, "protocol version mismatch")
    }
    client.clientId = message.clientId
    client.role = message.frontend
    // A device of a kind this server does not know is treated like no device (kind defaults, nothing editable).
    if (message.frontend === "voice" && message.device !== undefined && kindOf(message.device.kind) !== undefined) {
      client.device = message.device
    }
    if (message.frontend === "voice") client.sessionKey = client.device?.id ?? message.clientId
    let tokenRefused = false
    if (message.frontend === "admin" && message.adminToken !== undefined) {
      if (admin.check(message.adminToken) !== undefined) client.adminToken = message.adminToken
      else tokenRefused = true
    }
    // Resume when this client was the last owner of its device's session, or when nobody has owned that session's
    // audio (the assistant was restarted under a page that owned it, or the session was discarded: nobody else on
    // the device has claimed since). Admin pages never own the audio. A resume opens the session; when that would
    // be one session too many, the page stays an observer and is told why.
    const key = client.sessionKey
    const o = key === undefined ? undefined : owners.get(key)
    const wantsResume = key !== undefined && message.resumeOwner && o?.owner === undefined &&
      (o?.lastOwnerClientId === undefined || o.lastOwnerClientId === message.clientId)
    const opened = wantsResume ? sessions.open(key, client.device) : undefined
    const resumed = opened !== undefined && opened !== "full" ? opened : undefined
    if (resumed !== undefined) becomeOwner(client, resumed)
    const first = snapshot(client, tokenRefused ? "token" : undefined)
    if (first.device !== undefined) client.lastProfile = JSON.stringify(first.device)
    if (first.setup !== undefined) client.lastSetup = JSON.stringify(first.setup)
    send(client, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      server: options.server,
      connectionId: client.connection.id,
      snapshot: first
    })
    if (client.adminToken !== undefined) send(client, { type: "admin.snapshot", snapshot: adminSnapshot() })
    client.helloed = true
    if (client.device !== undefined) registerDevice(client.device)
    if (key !== undefined) sessions.connections(key, connectionsOf(key))
    if (opened === "full") send(client, { type: "error", error: sessionsFull() })
    if (resumed !== undefined) {
      announce(resumed.key, "resumed")
      syncOwner(resumed.key)
    }
  }

  const requireOwner = (client: Client): boolean => {
    if (isOwner(client)) return true
    warnOnce(client, "not_owner", "Only the tab that owns the audio may send this")
    return false
  }

  const warnOnce = (client: Client, code: "bad_message" | "not_owner", message: string) => {
    if (client.warned.has(code)) return
    client.warned.add(code)
    send(client, { type: "error", error: { code, message } })
  }

  const login = (client: Client, requestId: RequestId, password: string) => {
    if (client.role !== "admin") {
      return result(client, requestId, failure("bad_message", "Log in on the admin page (/admin/), not on the voice page"))
    }
    const outcome = admin.login(password)
    if (!outcome.ok) {
      if (outcome.reason === "disabled") return result(client, requestId, failure("admin_required", outcome.message))
      result(client, requestId, failure("bad_password", outcome.message))
      return send(client, { type: "admin.state", admin: adminState(client) })
    }
    // A fresh session; an earlier one on this connection is ended (its other connections are logged out).
    const previous = client.adminToken
    client.adminToken = outcome.session.token
    if (previous !== undefined && previous !== outcome.session.token) admin.logout(previous)
    send(client, { type: "result", requestId, ok: true, admin: outcome.session })
    send(client, { type: "admin.state", admin: adminState(client) })
    send(client, { type: "admin.snapshot", snapshot: adminSnapshot() })
  }

  const handle = (client: Client, message: ClientMessage) => {
    switch (message.type) {
      case "hello":
        return warnOnce(client, "bad_message", "hello was already received")
      case "audio.claim": {
        if (client.role === "admin" || client.sessionKey === undefined) {
          return send(client, { type: "error", error: { code: "not_owner", message: "The admin page never owns the audio" } })
        }
        const session = sessions.open(client.sessionKey, client.device)
        if (session === "full") return send(client, { type: "error", error: sessionsFull() })
        session.touch()
        const previous = owners.get(session.key)?.owner
        if (previous !== undefined && previous !== client && session.publisher.committedTurn() !== undefined) {
          // The previous owner's turn in flight (another tab of this device) is interrupted (its reply stops there).
          session.conversation.stop()
        }
        becomeOwner(client, session)
        announce(session.key, "claimed", previous !== client ? previous : undefined)
        return syncOwner(session.key)
      }
      case "audio.release": {
        if (!requireOwner(client)) return
        const key = client.sessionKey!
        release(key)
        announce(key, "released")
        return syncOwner(key)
      }
      case "audio.config": {
        // Only the browser's audio facts since protocol 5 (the interrupt mode is a profile field).
        if (!requireOwner(client)) return
        return syncOwner(client.sessionKey!)
      }
      case "mic.state": {
        if (!requireOwner(client)) return
        const key = client.sessionKey!
        ownershipOf(key).micLive = message.live
        if (message.live) client.lastSeq = undefined
        sessions.get(key)?.web.setMicLive(message.live)
        return syncOwner(key)
      }
      case "playback.started":
      case "playback.progress":
      case "playback.finished":
      case "playback.stopped":
        // Without an error from a tab that is not the owner: a tab that just lost the audio answers the reply.stop
        // it was sent, and that count is used (WebAudio takes reports on a reply only from the link it played to).
        if (client.link === undefined) return
        return sessionOf(client)?.web.report(message, client.link)
      case "interrupt": {
        const session = sessionOf(client)
        if (session === undefined) return
        const running = session.publisher.committedTurn()
        if (message.turnId !== undefined && message.turnId !== running) return
        session.conversation.stop()
        return
      }
      case "text.send": {
        // Answered after the session took it or refused it: `ok` only for input that will be handled.
        if (client.sessionKey === undefined) {
          return result(client, message.requestId, failure("bad_message", "Messages are typed on a voice page"))
        }
        if (options.engine.status().state !== "ready") {
          return result(client, message.requestId, failure("engine_failed", "The speech and language engines are not running; see the admin page"))
        }
        const session = sessions.open(client.sessionKey, client.device)
        if (session === "full") return result(client, message.requestId, { ok: false, error: sessionsFull() })
        session.touch()
        // Routed to an assistant of the device (docs/ASSISTANTS.md §2.6 "Typed text"): the one the page names, else
        // the follow-up holder, else who answers without a phrase, … Its conversation is made on first use.
        const requestId = message.requestId
        return options.run(Effect.map(
          session.conversation.sendText(message.text, message.speak && isOwner(client), message.assistantId),
          (outcome) =>
            result(
              client,
              requestId,
              outcome === "accepted"
                ? { ok: true }
                : outcome === "busy"
                ? failure("busy", "The assistant is still taking the previous messages; try again in a moment")
                : outcome === "dropped"
                ? failure("bad_message", "No assistant answers typed messages on this device")
                : failure("engine_failed", "The speech and language engines are not running; see the admin page")
            )
        ))
      }
      case "conversation.new": {
        // This device's conversation only (any of its connections); a device without a session gets a new id too.
        if (client.role !== "voice" || client.sessionKey === undefined) {
          return result(client, message.requestId, failure("bad_message", "A new conversation is started from a voice page"))
        }
        return limited(client, message.requestId, Effect.as(sessions.newConversation(client.sessionKey, message.assistantId), { ok: true } as HostResult))
      }
      case "admin.login":
        return login(client, message.requestId, message.password)
      case "admin.logout": {
        // Ends the session everywhere it was used (`onEnd` sends each of those connections `admin.state`).
        if (client.adminToken !== undefined) admin.logout(client.adminToken)
        return result(client, message.requestId, { ok: true })
      }
      case "device.update": {
        if (client.role !== "voice" || client.device === undefined) {
          return result(client, message.requestId, failure("bad_message", "This page did not say which device it is; reload it"))
        }
        return limited(client, message.requestId, frontends.updateOwn(client.device, message.patch, connectedDevices()), afterProfileChange(false))
      }
      case "frontend.update":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, frontends.updateKind(message.kind, message.patch), afterProfileChange(true))
      case "device.admin.update":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, frontends.updateDevice(message.id, message.name, message.patch), afterProfileChange(false))
      case "device.forget": {
        if (!allowed(client, message.requestId)) return
        const id = message.id
        return limited(client, message.requestId, frontends.forget(id), (r) => {
          if (!r.ok) return
          // A device that is connected now is recorded again as new (kind defaults).
          const again = [...clients].find((c) => c.device?.id === id && !c.closed)?.device
          if (again !== undefined) registerDevice(again)
          afterProfileChange(false)(r)
        })
      }
      case "assistant.create":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, assistants.create(message), afterAssistantsChange)
      case "assistant.save":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, assistants.save(message), afterAssistantsChange)
      case "assistant.delete":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, assistants.remove(message), afterAssistantsChange)
      case "device.save":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, assistants.saveDevice(message), afterAssistantsChange)
      case "device.pick": {
        // The device's own voice page (any of its connections); the server checks that the device lets people pick.
        const device = client.device
        if (client.role !== "voice" || device === undefined) {
          return result(client, message.requestId, failure("bad_message", "This page did not say which device it is; reload it"))
        }
        // The device record is saved in the background at hello: make sure it exists before the pick writes to it.
        return limited(
          client,
          message.requestId,
          Effect.andThen(frontends.seen(device, connectedDevices()), assistants.pick(device.id, message.withoutPhrase)),
          afterAssistantsChange
        )
      }
      case "conversation.read": {
        // Another assistant's conversation on this device, without changing who answers; sent to the requester only.
        if (client.role !== "voice" || client.sessionKey === undefined) {
          return result(client, message.requestId, failure("bad_message", "Conversations are read on a voice page"))
        }
        const assistantId = message.assistantId
        if (!assistants.setupFor(client.device?.id, client.device?.kind).assistants.some((a) => a.id === assistantId)) {
          return result(client, message.requestId, failure("unknown_assistant", `${assistantId} is not one of the assistants on this device`))
        }
        const session = sessionOf(client)
        const info = session === undefined ? sessions.conversation(client.sessionKey) : session.conversation.conversation(assistantId)
        return send(client, {
          type: "conversation.history",
          requestId: message.requestId,
          assistantId,
          id: info.id,
          history: session === undefined ? [] : historyItems(Effect.runSync(session.conversation.history(assistantId)))
        })
      }
      case "wake.test": {
        if (!allowed(client, message.requestId)) return
        const deviceId = message.deviceId
        if (message.on && deviceId !== undefined && !frontends.known(deviceId) && sessions.get(deviceId) === undefined) {
          return result(client, message.requestId, failure("unknown_device", "That device is not known (it may have been forgotten)"))
        }
        client.wakeTestUntil = message.on ? Date.now() + WAKE_TEST_MAX_MS : 0
        client.wakeTestDevice = message.on ? deviceId : undefined
        return result(client, message.requestId, { ok: true })
      }
      case "module.enable":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, options.host.enable(message.moduleId))
      case "module.disable":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, options.host.disable(message.moduleId))
      case "module.configure":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, options.host.configure(message.moduleId, message.patch))
      case "settings.update": {
        if (!allowed(client, message.requestId)) return
        let saved: { reload: boolean; path: string } = { reload: false, path: "" }
        const { sectionId } = message
        return limited(
          client,
          message.requestId,
          Effect.map(options.sections.update(sectionId, message.patch, { confirmWarnings: message.confirmWarnings === true }), (u) => {
            saved = { reload: u.reload, path: u.path }
            return u.result
          }),
          (r) => {
            if (r.ok) options.onSectionSaved(sectionId, saved.reload, saved.path)
          }
        )
      }
      case "engine.reload":
        if (!allowed(client, message.requestId)) return
        return limited(client, message.requestId, options.engine.reload)
      case "vault.setup":
        if (!allowed(client, message.requestId)) return
        return vaultRequest(client, message.requestId, keys.setup(message.password))
      case "vault.unlock":
        if (!allowed(client, message.requestId)) return
        return vaultRequest(client, message.requestId, keys.unlock(message.password))
      case "vault.changePassword":
        if (!allowed(client, message.requestId)) return
        return vaultRequest(client, message.requestId, keys.changePassword(message.oldPassword, message.newPassword))
      case "vault.lock":
        if (!allowed(client, message.requestId)) return
        return vaultRequest(client, message.requestId, keys.lock)
      case "settings.moveFromEnv": {
        if (!allowed(client, message.requestId)) return
        const mover = options.env
        if (mover === undefined) return result(client, message.requestId, failure("internal", "Moving settings is not available here"))
        return limited(
          client,
          message.requestId,
          Effect.map(mover.move(message.keys), (r): HostResult => (r.ok ? { ok: true } : { ok: false, error: r.error })),
          () => broadcast({ type: "env", env: mover.info() })
        )
      }
      case "job.start": {
        if (!allowed(client, message.requestId)) return
        if (options.models === undefined) return result(client, message.requestId, failure("internal", "Downloads are not available here"))
        const started = options.models.download(message.tool, message.target)
        return result(client, message.requestId, started.ok ? { ok: true } : { ok: false, error: started.error })
      }
      case "job.cancel": {
        if (!allowed(client, message.requestId)) return
        const cancelled = options.jobs?.cancel(message.jobId) === true
        return result(client, message.requestId, cancelled ? { ok: true } : failure("invalid_settings", "That job is not running"))
      }
      case "model.delete": {
        if (!allowed(client, message.requestId)) return
        const models = options.models
        if (models === undefined) return result(client, message.requestId, failure("internal", "Models cannot be deleted here"))
        return limited(client, message.requestId, Effect.promise(() => models.remove(message.tool, message.target)))
      }
      case "ping":
        return send(client, { type: "pong", id: message.id })
    }
  }

  return {
    accept: (connection) => {
      if (clients.size >= maxConnections) {
        connection.close(CloseCode.tooManyConnections, "too many connections")
        return undefined
      }
      const client: Client = {
        connection,
        helloed: false,
        closed: false,
        clientId: undefined,
        role: "voice",
        device: undefined,
        sessionKey: undefined,
        helloTimer: undefined,
        lastSeq: undefined,
        lastGapErrorAt: -Infinity,
        warned: new Set(),
        pending: 0,
        link: undefined,
        adminToken: undefined,
        lastProfile: undefined,
        lastSetup: undefined,
        wakeTestUntil: 0,
        wakeTestDevice: undefined
      }
      client.helloTimer = setTimeout(() => {
        if (!client.helloed) drop(client, CloseCode.helloTimeout, "no hello")
      }, helloTimeoutMs)
      client.helloTimer.unref?.()
      clients.add(client)
      return {
        onText: (text) => {
          if (client.closed) return
          const decoded = decodeClientMessage(text)
          if (!client.helloed) {
            if (decoded._tag !== "Ok") return drop(client, CloseCode.helloTimeout, "the first message must be hello")
            return hello(client, decoded.message)
          }
          if (decoded._tag === "Unknown") return
          if (decoded._tag === "Invalid") {
            // A schema error quotes the offending value: never echo a password back.
            const reason = decoded.messageType?.startsWith("vault.") === true || decoded.messageType === "admin.login"
              ? `${decoded.messageType}: a password is missing or longer than ${MAX_PASSWORD_CHARS} characters`
              : decoded.reason
            return warnOnce(client, "bad_message", `Message not understood: ${reason}`)
          }
          try {
            handle(client, decoded.message)
          } catch (error) {
            console.error("serve: error while handling a message", error)
            send(client, { type: "error", error: { code: "internal", message: "The assistant could not handle that message" } })
          }
        },
        onBinary: (data) => {
          if (client.closed) return
          if (!client.helloed) return drop(client, CloseCode.badMessage, "binary data before hello")
          const frame = decodeMicFrame(data)
          if (!frame.ok) return warnOnce(client, "bad_message", `Audio frame not understood: ${frame.error}`)
          if (!isOwner(client)) return
          const session = sessionOf(client)
          if (session === undefined) return
          const gap = micSequenceGap(client.lastSeq, frame.frame.seq)
          client.lastSeq = frame.frame.seq
          if (gap > 0) {
            ownershipOf(session.key).micFramesLost += gap
            const now = performance.now()
            if (now - client.lastGapErrorAt >= MIC_GAP_ERROR_INTERVAL_MS) {
              client.lastGapErrorAt = now
              send(client, { type: "error", error: { code: "mic_gap", message: `${gap} microphone frame(s) were lost on the way` } })
            }
          }
          session.web.micFrame(frame.frame.pcm)
        },
        onClose: () => {
          client.closed = true
          lost(client)
        }
      }
    },
    broadcast,
    toSession,
    sessionsChanged,
    sessionDiscarded: (key) => {
      owners.delete(key)
      devicesChanged(true)
    },
    profileOf: profileOfKey,
    closeAll: (code, reason) => {
      if (devicesTimer !== undefined) clearTimeout(devicesTimer)
      if (sessionsTimer !== undefined) clearTimeout(sessionsTimer)
      for (const client of [...clients]) drop(client, code, reason)
    },
    size: () => clients.size,
    micFramesLost: (key) => owners.get(key)?.micFramesLost ?? 0,
    vaultChanged: () => {
      for (const client of clients) sendVault(client)
    },
    refreshProfiles,
    wakeHeard: (key, text, phrase, accepted) => {
      const at = Date.now()
      const message = encodeServerMessage({ type: "wake.heard", text, ...(phrase !== undefined ? { matched: phrase } : {}), accepted, at })
      const mostRecent = sessions.mostRecent()?.key
      for (const client of clients) {
        if (!client.helloed || client.wakeTestUntil <= at) continue
        if ((client.wakeTestDevice ?? mostRecent) !== key) continue
        if (!isAdmin(client)) {
          client.wakeTestUntil = 0
          continue
        }
        sendText(client, message)
      }
    }
  }
}
