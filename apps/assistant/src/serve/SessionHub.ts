import type { AudioClientLink, WebAudio } from "@pva/audio-web"
import type { EchoGate, HostResult, ModuleHost } from "@pva/core"
import {
  type ClientMessage,
  CloseCode,
  decodeClientMessage,
  decodeMicFrame,
  encodeServerMessage,
  type ErrorInfo,
  type InterruptMode,
  MAX_PASSWORD_CHARS,
  micSequenceGap,
  PROTOCOL_VERSION,
  type RequestId,
  type ServerMessage,
  type Snapshot
} from "@pva/protocol"
import { Effect } from "effect"
import type { AccessPolicy } from "./access.ts"
import type { Engine } from "./Engine.ts"
import type { Keys } from "./Keys.ts"
import { historyItems, type Publisher } from "./Publisher.ts"
import type { Sections } from "./sections.ts"
import type { StateTracker } from "./StateTracker.ts"

/**
 * Connections, handshake, roles and ownership, request routing, broadcast and
 * send limits (docs/UI-AND-MODULES.md §2.1, §2.3). Transport-neutral: `http.ts`
 * adapts `ws` sockets to `HubConnection`.
 *
 * Admin access (§1.6) is per connection: typing the vault password on a page
 * (`vault.setup`, `vault.unlock`, `vault.changePassword`) gives that connection
 * admin access until it disconnects, a page locks the vault, or 15 minutes pass
 * without an admin action. Requests that change a protected module or section
 * from any other connection are answered `locked`. While no vault exists every
 * connection counts as admin (there is no password to ask for).
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
  /** Send to every tab that has completed the handshake. */
  readonly broadcast: (message: ServerMessage) => void
  readonly ownerMode: () => InterruptMode | undefined
  readonly closeAll: (code: number, reason: string) => void
  readonly size: () => number
  /** Microphone frames lost between the owner's page and the server (sequence gaps), since start. */
  readonly micFramesLost: () => number
  /** The vault changed: send every page its view (`vault`). Locking ends every page's admin access. */
  readonly vaultChanged: () => void
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
  /** After a settings section was saved. */
  readonly onSectionSaved: (sectionId: string, needsReload: boolean) => void
  readonly server: { readonly name: string; readonly version: string }
  readonly keys: Keys
  readonly access: AccessPolicy
  /** Admin access ends after this long without an admin action. Default 15 minutes. */
  readonly adminIdleMs?: number
  readonly helloTimeoutMs?: number
  readonly maxConnections?: number
  readonly observerBufferLimit?: number
  readonly ownerBufferLimit?: number
}

interface Client {
  readonly connection: HubConnection
  helloed: boolean
  closed: boolean
  clientId: string | undefined
  helloTimer: ReturnType<typeof setTimeout> | undefined
  lastSeq: number | undefined
  lastGapErrorAt: number
  warned: Set<string>
  /** This connection as the audio link (one object per connection, so a repeated claim is not a change of owner). */
  link: AudioClientLink | undefined
  /** Admin access granted by the vault password on this connection. */
  admin: boolean
  adminTimer: ReturnType<typeof setTimeout> | undefined
}

const MIC_GAP_ERROR_INTERVAL_MS = 10_000

export const makeSessionHub = (options: HubOptions): SessionHub => {
  const clients = new Set<Client>()
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000
  const maxConnections = options.maxConnections ?? 8
  const adminIdleMs = options.adminIdleMs ?? 15 * 60_000
  const { keys, access } = options
  const observerLimit = options.observerBufferLimit ?? 1_048_576
  const ownerLimit = options.ownerBufferLimit ?? 8_388_608
  let owner: Client | undefined
  let micFramesLost = 0
  let ownerMode: InterruptMode = "confirm"
  let lastOwnerClientId: string | undefined
  let micLive = false

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

  const broadcast = (message: ServerMessage) => {
    const text = encodeServerMessage(message)
    for (const client of clients) if (client.helloed) sendText(client, text)
  }

  const warnOnce = (client: Client, code: "bad_message" | "not_owner", message: string) => {
    if (client.warned.has(code)) return
    client.warned.add(code)
    send(client, { type: "error", error: { code, message } })
  }

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
    options.gate.setMode(owner === undefined ? "instant" : ownerMode)
  }

  const becomeOwner = (client: Client, mode: InterruptMode) => {
    owner = client
    ownerMode = mode
    lastOwnerClientId = client.clientId
    micLive = true
    client.lastSeq = undefined
    options.web.setOwner(linkFor(client))
    options.web.setMicLive(true)
  }

  const lost = (client: Client) => {
    if (client.helloTimer !== undefined) clearTimeout(client.helloTimer)
    endAdmin(client, false)
    if (!clients.delete(client)) return
    if (owner === client) {
      owner = undefined
      micLive = false
      options.web.setOwner(undefined)
      options.web.setMicLive(false)
      announce("owner_disconnected")
      syncOwner()
    }
  }

  // ---- Admin access

  const isAdmin = (client: Client) => keys.state() === "none" || (client.admin && keys.state() === "unlocked")
  const sendVault = (client: Client) => {
    if (client.helloed) send(client, { type: "vault", vault: keys.info(isAdmin(client)) })
  }
  /** Start or extend this connection's admin access (each admin action restarts the idle timer). */
  const touchAdmin = (client: Client) => {
    if (keys.state() === "none") return
    const wasAdmin = client.admin
    client.admin = true
    if (client.adminTimer !== undefined) clearTimeout(client.adminTimer)
    client.adminTimer = setTimeout(() => endAdmin(client, true), adminIdleMs)
    client.adminTimer.unref?.()
    if (!wasAdmin) sendVault(client)
  }
  function endAdmin(client: Client, announce: boolean) {
    if (client.adminTimer !== undefined) clearTimeout(client.adminTimer)
    client.adminTimer = undefined
    if (!client.admin) return
    client.admin = false
    if (announce) sendVault(client)
  }

  const lockedMessage = () =>
    keys.state() === "locked"
      ? "The keys are locked: unlock them with the password in Options → Keys & access to change this."
      : "Protected: type the password in Options → Keys & access to change this."

  /** A request that changes a protected item: allowed for admin connections (and extends their access). */
  const allowed = (client: Client, requestId: RequestId, isProtected: boolean): boolean => {
    if (!isProtected) return true
    if (isAdmin(client)) {
      touchAdmin(client)
      return true
    }
    result(client, requestId, failure("locked", lockedMessage()))
    return false
  }

  /** A vault request answered on this connection; success with the password grants it admin access. */
  const vaultRequest = (client: Client, requestId: RequestId, op: Effect.Effect<HostResult>, grants: boolean) =>
    options.run(Effect.map(op, (r) => {
      if (r.ok && grants && !client.closed) touchAdmin(client)
      result(client, requestId, r)
      // A refusal may have started a wait (too many attempts): show it on this page.
      if (!r.ok) sendVault(client)
    }))

  const result = (client: Client, requestId: RequestId, outcome: HostResult) =>
    send(client, outcome.ok ? { type: "result", requestId, ok: true } : { type: "result", requestId, ok: false, error: outcome.error })

  const failure = (code: ErrorInfo["code"], message: string): HostResult => ({ ok: false, error: { code, message } })

  const snapshot = (client: Client): Snapshot => ({
    state: options.tracker.current().state,
    role: client === owner ? "owner" : "observer",
    ownerPresent: owner !== undefined,
    engine: options.engine.status(),
    modules: options.host.modules().map(access.module),
    sections: options.sections.list().map(access.section),
    history: historyItems(Effect.runSync(options.engine.history)),
    traces: options.publisher.traces(),
    vault: keys.info(isAdmin(client))
  })

  const hello = (client: Client, message: ClientMessage) => {
    if (message.type !== "hello") return drop(client, CloseCode.helloTimeout, "the first message must be hello")
    if (client.helloTimer !== undefined) clearTimeout(client.helloTimer)
    if (message.protocol !== PROTOCOL_VERSION) {
      send(client, { type: "error", error: { code: "bad_message", message: "This page is out of date; reload it" } })
      return drop(client, CloseCode.protocolMismatch, "protocol version mismatch")
    }
    client.clientId = message.clientId
    // Resume when this client was the last owner, or when nobody has owned the audio since this process
    // started (the assistant was restarted under a page that owned it: nobody else has claimed since).
    const resume = message.resumeOwner && owner === undefined &&
      (lastOwnerClientId === undefined || lastOwnerClientId === message.clientId)
    if (resume) becomeOwner(client, ownerMode)
    send(client, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      server: options.server,
      connectionId: client.connection.id,
      snapshot: snapshot(client)
    })
    client.helloed = true
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

  const handle = (client: Client, message: ClientMessage) => {
    switch (message.type) {
      case "hello":
        return warnOnce(client, "bad_message", "hello was already received")
      case "audio.claim": {
        const previous = owner
        if (previous !== undefined && previous !== client && options.publisher.committedTurn() !== undefined) {
          // The previous owner's turn in flight is interrupted (its reply stops there).
          options.engine.send({ _tag: "Interrupt" })
        }
        becomeOwner(client, message.interruptMode)
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
        if (!requireOwner(client)) return
        ownerMode = message.interruptMode
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
        // A tab that just lost the audio still answers the reply.stop it was sent: ignored without an error.
        if (client !== owner) return
        return options.web.report(message)
      case "interrupt": {
        const running = options.publisher.committedTurn()
        if (message.turnId !== undefined && message.turnId !== running) return
        options.engine.send({ _tag: "Interrupt" })
        return
      }
      case "text.send": {
        if (options.engine.status().state !== "ready") {
          return result(client, message.requestId, failure("engine_failed", "The speech and language engines are not running; check Options → Engines"))
        }
        result(client, message.requestId, { ok: true })
        options.engine.send({ _tag: "TextInput", text: message.text, speak: message.speak && client === owner })
        return
      }
      case "module.enable":
        if (!allowed(client, message.requestId, access.moduleProtected(message.moduleId))) return
        return options.run(Effect.map(options.host.enable(message.moduleId), (r) => result(client, message.requestId, r)))
      case "module.disable":
        if (!allowed(client, message.requestId, access.moduleProtected(message.moduleId))) return
        return options.run(Effect.map(options.host.disable(message.moduleId), (r) => result(client, message.requestId, r)))
      case "module.configure":
        if (!allowed(client, message.requestId, access.moduleProtected(message.moduleId))) return
        return options.run(Effect.map(options.host.configure(message.moduleId, message.patch), (r) => result(client, message.requestId, r)))
      case "settings.update":
        if (!allowed(client, message.requestId, access.sectionProtected(message.sectionId))) return
        return options.run(Effect.map(options.sections.update(message.sectionId, message.patch), ({ reload, result: r }) => {
          result(client, message.requestId, r)
          if (r.ok) options.onSectionSaved(message.sectionId, reload)
        }))
      case "engine.reload":
        return options.run(Effect.map(options.engine.reload, (r) => result(client, message.requestId, r)))
      case "vault.setup":
        return vaultRequest(client, message.requestId, keys.setup(message.password), true)
      case "vault.unlock":
        return vaultRequest(client, message.requestId, keys.unlock(message.password), true)
      case "vault.changePassword":
        return vaultRequest(client, message.requestId, keys.changePassword(message.oldPassword, message.newPassword), true)
      case "vault.lock":
        if (keys.state() !== "none" && !isAdmin(client)) return result(client, message.requestId, failure("locked", lockedMessage()))
        return vaultRequest(client, message.requestId, keys.lock, false)
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
        helloTimer: undefined,
        lastSeq: undefined,
        lastGapErrorAt: -Infinity,
        warned: new Set(),
        link: undefined,
        admin: false,
        adminTimer: undefined
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
            const reason = decoded.messageType?.startsWith("vault.") === true
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
    ownerMode: () => (owner === undefined ? undefined : ownerMode),
    closeAll: (code, reason) => {
      for (const client of [...clients]) drop(client, code, reason)
    },
    size: () => clients.size,
    micFramesLost: () => micFramesLost,
    vaultChanged: () => {
      // Without unlocked keys there is no admin access (a lock ends it everywhere).
      if (keys.state() !== "unlocked") for (const client of clients) endAdmin(client, false)
      for (const client of clients) sendVault(client)
    }
  }
}
