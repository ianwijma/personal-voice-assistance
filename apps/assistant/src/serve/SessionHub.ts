import type { AudioClientLink, WebAudio } from "@pva/audio-web"
import type { EchoGate, HostResult, ModuleHost } from "@pva/core"
import {
  type AdminSnapshot,
  type AdminState,
  type ClientMessage,
  CloseCode,
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
  type InterruptMode,
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
import type { Engine } from "./Engine.ts"
import type { EnvMover } from "./envSettings.ts"
import { type FrontendResult, type Frontends, kindOf } from "./frontends.ts"
import type { Jobs } from "./jobs.ts"
import type { Models } from "./models.ts"
import type { Keys } from "./Keys.ts"
import { historyItems, type Publisher } from "./Publisher.ts"
import type { Sections } from "./sections.ts"
import type { StateTracker } from "./StateTracker.ts"

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
 *   effective profile (`snapshot.device`, then `device.profile` whenever it changes). The audio owner's profile
 *   drives the echo gate's interrupt mode here, and the wake gate and the default voice in serve mode
 *   (`onOwnerProfile`).
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
  /** The audio owner's interrupt mode (from its profile), or undefined without an owner. */
  readonly ownerMode: () => InterruptMode | undefined
  /** The audio owner's effective profile, or undefined without an owner. */
  readonly ownerProfile: () => DeviceProfile | undefined
  readonly closeAll: (code: number, reason: string) => void
  readonly size: () => number
  /** Microphone frames lost between the owner's page and the server (sequence gaps), since start. */
  readonly micFramesLost: () => number
  /** The vault changed: send every admin connection its view (`vault`). */
  readonly vaultChanged: () => void
  /**
   * Profiles may have changed (kind defaults, a device, the enabled voices): send `device.profile` to every
   * connection whose effective profile changed, and tell serve mode about the owner's.
   */
  readonly refreshProfiles: () => void
  /**
   * One final transcript of the audio owner, for admin connections with the phrase tester on (`wake.heard`):
   * the phrase it matched, and whether the wake gate accepted it.
   */
  readonly wakeHeard: (text: string, phrase: string | undefined, accepted: boolean) => void
}

export interface HubOptions {
  readonly web: WebAudio
  readonly engine: Engine
  readonly host: ModuleHost
  readonly sections: Sections
  readonly publisher: Publisher
  readonly tracker: StateTracker
  readonly gate: EchoGate
  /** Run an effect in the server's scope (requests that do work). */
  readonly run: (effect: Effect.Effect<void>) => void
  /** After a settings section was saved (`path`: its settings page, `<group>/<page>`). */
  readonly onSectionSaved: (sectionId: string, needsReload: boolean, path: string) => void
  readonly server: { readonly name: string; readonly version: string }
  readonly keys: Keys
  readonly access: AccessPolicy
  /** `PVA_ADMIN_PASSWORD` and the admin sessions. */
  readonly admin: AdminSessions
  /** Front-end kinds, devices and profiles. */
  readonly frontends: Frontends
  /** The audio owner's effective profile changed (or the owner did: undefined = none). */
  readonly onOwnerProfile?: (profile: DeviceProfile | undefined) => void
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
  /** Minor `devices` changes (last seen, connections, audio owner) are sent at most this often. Default 1000 ms. */
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
  /** The phrase tester is on until then (epoch ms; 0 = off). */
  wakeTestUntil: number
}

const MIC_GAP_ERROR_INTERVAL_MS = 10_000

const ADMIN_REQUIRED_MESSAGE = "This needs the admin page: log in there with the admin password"

export const makeSessionHub = (options: HubOptions): SessionHub => {
  const clients = new Set<Client>()
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000
  const maxConnections = options.maxConnections ?? 8
  const { keys, access, admin, frontends } = options
  const observerLimit = options.observerBufferLimit ?? 1_048_576
  const ownerLimit = options.ownerBufferLimit ?? 8_388_608
  const devicesThrottleMs = options.devicesThrottleMs ?? 1_000
  let owner: Client | undefined
  let micFramesLost = 0
  let lastOwnerClientId: string | undefined
  let micLive = false
  const maxPendingPerConnection = options.maxPendingPerConnection ?? 4
  const maxPendingTotal = options.maxPendingTotal ?? 16
  let pendingTotal = 0
  /** The owner profile serve mode was last told about (JSON; "" = no owner). */
  let notifiedOwnerProfile: string | undefined

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
    if (client.connection.bufferedAmount() <= (client === owner ? ownerLimit : observerLimit)) return false
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

  const result = (client: Client, requestId: RequestId, outcome: HostResult | FrontendResult) =>
    send(client, outcome.ok ? { type: "result", requestId, ok: true } : { type: "result", requestId, ok: false, error: outcome.error })

  const failure = (code: ErrorInfo["code"], message: string): HostResult => ({ ok: false, error: { code, message } })

  /**
   * Runs a request that does work, within the limits: a tab sending requests faster than they complete gets
   * `busy` answers instead of an ever-growing pile of operations (and disk writes) behind it.
   */
  const limited = (
    client: Client,
    requestId: RequestId,
    work: Effect.Effect<HostResult | FrontendResult, never>,
    after?: (r: HostResult | FrontendResult) => void
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
    let audioOwner = false
    for (const c of clients) {
      if (c.closed || c.device?.id !== id) continue
      connections++
      if (c === owner) audioOwner = true
    }
    return { connections, audioOwner }
  }
  const connectedDevices = () => new Set([...clients].flatMap((c) => (c.device !== undefined && !c.closed ? [c.device.id] : [])))

  let devicesTimer: ReturnType<typeof setTimeout> | undefined
  let devicesSentAt = -Infinity
  const sendDevices = () => {
    if (devicesTimer !== undefined) clearTimeout(devicesTimer)
    devicesTimer = undefined
    devicesSentAt = performance.now()
    broadcast({ type: "devices", devices: [...frontends.devices(live)] })
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

  const ownerProfile = () => (owner === undefined ? undefined : profileOf(owner))

  /** Tell serve mode about the owner's profile when it changed; the echo gate's mode follows it here. */
  const syncOwnerProfile = () => {
    const profile = ownerProfile()
    options.gate.setMode(profile === undefined ? "instant" : profile.interruptMode)
    const key = profile === undefined ? "" : JSON.stringify(profile)
    if (key === notifiedOwnerProfile) return
    notifiedOwnerProfile = key
    options.onOwnerProfile?.(profile)
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
    syncOwnerProfile()
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

  const announce = (reason: "claimed" | "released" | "taken_over" | "owner_disconnected" | "resumed", previous?: Client) => {
    for (const client of clients) {
      if (!client.helloed) continue
      send(client, {
        type: "session",
        role: client === owner ? "owner" : "observer",
        ownerPresent: owner !== undefined,
        reason: client === previous && reason === "claimed" ? "taken_over" : reason
      })
    }
  }

  const syncOwner = () => {
    options.tracker.setOwner(owner !== undefined, owner !== undefined && micLive)
    syncOwnerProfile()
    devicesChanged(true)
  }

  const becomeOwner = (client: Client) => {
    owner = client
    lastOwnerClientId = client.clientId
    micLive = true
    client.lastSeq = undefined
    options.web.setOwner(linkFor(client))
    options.web.setMicLive(true)
  }

  const lost = (client: Client) => {
    if (client.helloTimer !== undefined) clearTimeout(client.helloTimer)
    if (!clients.delete(client)) return
    if (client.device !== undefined) {
      frontends.left(client.device.id)
      devicesChanged(true)
    }
    if (owner === client) {
      owner = undefined
      micLive = false
      options.web.setOwner(undefined)
      options.web.setMicLive(false)
      announce("owner_disconnected")
      syncOwner()
    }
  }

  // ---- Snapshots

  const snapshot = (client: Client, endReason?: AdminState["endReason"]): Snapshot => ({
    state: options.tracker.current().state,
    role: client === owner ? "owner" : "observer",
    ownerPresent: owner !== undefined,
    engine: engineSummary(options.engine.status()),
    history: historyItems(Effect.runSync(options.engine.history)),
    ...(client.role === "voice" ? { device: profileInfo(client) } : {}),
    admin: adminState(client, endReason)
  })

  const adminSnapshot = (): AdminSnapshot => ({
    engine: options.engine.status(),
    modules: options.host.modules().map(access.module),
    sections: options.sections.list().map(access.section),
    traces: options.publisher.traces(),
    vault: keys.info(true),
    ...(options.env !== undefined ? { env: options.env.info() } : {}),
    models: options.models?.list() ?? [],
    jobs: options.jobs?.list() ?? [],
    frontends: [...frontends.kinds()],
    devices: [...frontends.devices(live)]
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
    let tokenRefused = false
    if (message.frontend === "admin" && message.adminToken !== undefined) {
      if (admin.check(message.adminToken) !== undefined) client.adminToken = message.adminToken
      else tokenRefused = true
    }
    // Resume when this client was the last owner, or when nobody has owned the audio since this process
    // started (the assistant was restarted under a page that owned it: nobody else has claimed since).
    // Admin pages never own the audio.
    const resume = message.frontend === "voice" && message.resumeOwner && owner === undefined &&
      (lastOwnerClientId === undefined || lastOwnerClientId === message.clientId)
    if (resume) becomeOwner(client)
    const first = snapshot(client, tokenRefused ? "token" : undefined)
    if (first.device !== undefined) client.lastProfile = JSON.stringify(first.device)
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
    if (resume) {
      announce("resumed")
      syncOwner()
    }
  }

  const requireOwner = (client: Client): boolean => {
    if (client === owner) return true
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
        if (client.role === "admin") {
          return send(client, { type: "error", error: { code: "not_owner", message: "The admin page never owns the audio" } })
        }
        const previous = owner
        if (previous !== undefined && previous !== client && options.publisher.committedTurn() !== undefined) {
          // The previous owner's turn in flight is interrupted (its reply stops there).
          options.engine.send({ _tag: "Interrupt" })
        }
        becomeOwner(client)
        announce("claimed", previous !== client ? previous : undefined)
        return syncOwner()
      }
      case "audio.release": {
        if (!requireOwner(client)) return
        owner = undefined
        micLive = false
        options.web.setOwner(undefined)
        options.web.setMicLive(false)
        announce("released")
        return syncOwner()
      }
      case "audio.config": {
        // Only the browser's audio facts since protocol 5 (the interrupt mode is a profile field).
        if (!requireOwner(client)) return
        return syncOwner()
      }
      case "mic.state": {
        if (!requireOwner(client)) return
        micLive = message.live
        if (message.live) client.lastSeq = undefined
        options.web.setMicLive(message.live)
        return syncOwner()
      }
      case "playback.started":
      case "playback.progress":
      case "playback.finished":
      case "playback.stopped":
        // Without an error from a tab that is not the owner: a tab that just lost the audio answers the reply.stop
        // it was sent, and that count is used (WebAudio takes reports on a reply only from the link it played to).
        if (client.link === undefined) return
        return options.web.report(message, client.link)
      case "interrupt": {
        const running = options.publisher.committedTurn()
        if (message.turnId !== undefined && message.turnId !== running) return
        options.engine.send({ _tag: "Interrupt" })
        return
      }
      case "text.send": {
        // Answered after the engine took it or refused it: `ok` only for input that will be handled.
        const outcome = options.engine.status().state !== "ready"
          ? "not_running"
          : options.engine.send({ _tag: "TextInput", text: message.text, speak: message.speak && client === owner })
        return result(
          client,
          message.requestId,
          outcome === "accepted"
            ? { ok: true }
            : outcome === "busy"
            ? failure("busy", "The assistant is still taking the previous messages; try again in a moment")
            : failure("engine_failed", "The speech and language engines are not running; see the admin page")
        )
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
      case "wake.test":
        if (!allowed(client, message.requestId)) return
        client.wakeTestUntil = message.on ? Date.now() + WAKE_TEST_MAX_MS : 0
        return result(client, message.requestId, { ok: true })
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
        helloTimer: undefined,
        lastSeq: undefined,
        lastGapErrorAt: -Infinity,
        warned: new Set(),
        pending: 0,
        link: undefined,
        adminToken: undefined,
        lastProfile: undefined,
        wakeTestUntil: 0
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
          if (client !== owner) return
          const gap = micSequenceGap(client.lastSeq, frame.frame.seq)
          client.lastSeq = frame.frame.seq
          if (gap > 0) {
            micFramesLost += gap
            const now = performance.now()
            if (now - client.lastGapErrorAt >= MIC_GAP_ERROR_INTERVAL_MS) {
              client.lastGapErrorAt = now
              send(client, { type: "error", error: { code: "mic_gap", message: `${gap} microphone frame(s) were lost on the way` } })
            }
          }
          options.web.micFrame(frame.frame.pcm)
        },
        onClose: () => {
          client.closed = true
          lost(client)
        }
      }
    },
    broadcast,
    ownerMode: () => ownerProfile()?.interruptMode,
    ownerProfile,
    closeAll: (code, reason) => {
      if (devicesTimer !== undefined) clearTimeout(devicesTimer)
      for (const client of [...clients]) drop(client, code, reason)
    },
    size: () => clients.size,
    micFramesLost: () => micFramesLost,
    vaultChanged: () => {
      for (const client of clients) sendVault(client)
    },
    refreshProfiles,
    wakeHeard: (text, phrase, accepted) => {
      const at = Date.now()
      const message = encodeServerMessage({ type: "wake.heard", text, ...(phrase !== undefined ? { matched: phrase } : {}), accepted, at })
      for (const client of clients) {
        if (!client.helloed || client.wakeTestUntil <= at) continue
        if (!isAdmin(client)) {
          client.wakeTestUntil = 0
          continue
        }
        sendText(client, message)
      }
    }
  }
}
