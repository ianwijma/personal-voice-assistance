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
  micSequenceGap,
  PROTOCOL_VERSION,
  type RequestId,
  type ServerMessage,
  type Snapshot
} from "@pva/protocol"
import { Effect } from "effect"
import type { Engine } from "./Engine.ts"
import { historyItems, type Publisher } from "./Publisher.ts"
import type { Sections } from "./sections.ts"
import type { StateTracker } from "./StateTracker.ts"

/**
 * Connections, handshake, roles and ownership, request routing, broadcast and
 * send limits (docs/UI-AND-MODULES.md §2.1, §2.3). Transport-neutral: `http.ts`
 * adapts `ws` sockets to `HubConnection`.
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
  readonly helloTimeoutMs?: number
  readonly maxConnections?: number
  readonly observerBufferLimit?: number
  readonly ownerBufferLimit?: number
  /** Requests that do work (settings, modules, reload) running at once, per connection. Default 4. */
  readonly maxPendingPerConnection?: number
  /** The same, over all connections. Default 16. */
  readonly maxPendingTotal?: number
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
  /** Requests of this connection still running. */
  pending: number
  /** This connection as the audio link (one object per connection, so a repeated claim is not a change of owner). */
  link: AudioClientLink | undefined
}

const MIC_GAP_ERROR_INTERVAL_MS = 10_000

export const makeSessionHub = (options: HubOptions): SessionHub => {
  const clients = new Set<Client>()
  const helloTimeoutMs = options.helloTimeoutMs ?? 5_000
  const maxConnections = options.maxConnections ?? 8
  const observerLimit = options.observerBufferLimit ?? 1_048_576
  const ownerLimit = options.ownerBufferLimit ?? 8_388_608
  let owner: Client | undefined
  let micFramesLost = 0
  let ownerMode: InterruptMode = "confirm"
  let lastOwnerClientId: string | undefined
  let micLive = false
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

  const result = (client: Client, requestId: RequestId, outcome: HostResult) =>
    send(client, outcome.ok ? { type: "result", requestId, ok: true } : { type: "result", requestId, ok: false, error: outcome.error })

  const failure = (code: ErrorInfo["code"], message: string): HostResult => ({ ok: false, error: { code, message } })

  /**
   * Runs a request that does work, within the limits: a tab sending requests faster than they complete gets
   * `busy` answers instead of an ever-growing pile of operations (and disk writes) behind it.
   */
  const limited = (client: Client, requestId: RequestId, work: Effect.Effect<HostResult, never>, after?: (r: HostResult) => void) => {
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

  const snapshot = (client: Client): Snapshot => ({
    state: options.tracker.current().state,
    role: client === owner ? "owner" : "observer",
    ownerPresent: owner !== undefined,
    engine: options.engine.status(),
    modules: options.host.modules(),
    sections: options.sections.list(),
    history: historyItems(Effect.runSync(options.engine.history)),
    traces: options.publisher.traces()
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
            : failure("engine_failed", "The speech and language engines are not running; check Options → Engines")
        )
      }
      case "module.enable":
        return limited(client, message.requestId, options.host.enable(message.moduleId))
      case "module.disable":
        return limited(client, message.requestId, options.host.disable(message.moduleId))
      case "module.configure":
        return limited(client, message.requestId, options.host.configure(message.moduleId, message.patch))
      case "settings.update": {
        let reload = false
        const { sectionId } = message
        return limited(
          client,
          message.requestId,
          Effect.map(options.sections.update(sectionId, message.patch), (u) => {
            reload = u.reload
            return u.result
          }),
          (r) => {
            if (r.ok) options.onSectionSaved(sectionId, reload)
          }
        )
      }
      case "engine.reload":
        return limited(client, message.requestId, options.engine.reload)
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
        pending: 0,
        link: undefined
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
          if (decoded._tag === "Invalid") return warnOnce(client, "bad_message", `Message not understood: ${decoded.reason}`)
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
    micFramesLost: () => micFramesLost
  }
}
