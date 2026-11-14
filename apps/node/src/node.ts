/**
 * The node program (`pva-node run`): one microphone capture and one reply player for the life of the process, and a
 * connection to the assistant that is re-made for ever (docs/VOICE-NODES.md §7.4). Each connection gets a fresh
 * `Session`; the capture feeds whichever session is current and owns the audio.
 *
 * Seams for later packages (each a named function or field, so they slot in without reshaping this file):
 * - `helloFor` (WP-10): adds `hello.node` (credential, version, bundle hash, platform).
 * - `NodeSettings` (WP-10): volume and cues come from the pushed profile instead of CLI flags; audio devices too
 *   (rebuild the audio layer on change).
 * - `updates` (WP-4, `update.ts`): the manifest check before every connection attempt and after a 4400, the
 *   confirmation of a new release at its first `welcome`, and a failed start while it is on probation.
 * - 4403 (WP-6 / WP-10) is already mapped to the slow retry (`Timing.unauthorizedRetryMs`).
 */
import { randomUUID } from "node:crypto"
import { AudioInput, AudioOutput } from "@pva/core"
import { PROTOCOL_VERSION } from "@pva/protocol"
import { Deferred, Effect, Stream } from "effect"
import { NodeAudioInfo } from "./audio.ts"
import { webSocketUrl, type NodeConfig, defaultDeviceName } from "./config.ts"
import {
  closeAction,
  connectOnce,
  type ConnectionLost,
  defaultTiming,
  type HelloMessage,
  type OpenSocket,
  reconnectDelay,
  type Timing
} from "./connection.ts"
import { makeReplyPlayer, type ReplyPlayer } from "./playback.ts"
import { makeSession, type Session } from "./session.ts"

/**
 * TODO(WP-6): protocol 7's `VOICE_NODE_KIND`. On protocol 5 the server does not know this kind and treats the node
 * like a voice connection without a device (the `web-voice` kind defaults, a shared audio owner), which is enough to
 * exercise capture, playback reports and reconnects.
 */
export const VOICE_NODE_KIND = "voice-node"

/** Settings the node applies itself. WP-10 fills them from `device.profile` (`outputVolume`, `cues`). */
export interface NodeSettings {
  volume: number
  cues: boolean
}

export const DEFAULT_VOLUME = 80

/** The `hello` of this node. WP-10 adds `node: { credential, version, bundleSha256, platform }`. */
export const helloFor = (config: NodeConfig, clientId: string): HelloMessage => ({
  type: "hello",
  protocol: PROTOCOL_VERSION,
  clientId,
  resumeOwner: true,
  frontend: "voice",
  device: { id: config.deviceId, kind: VOICE_NODE_KIND, name: config.name ?? defaultDeviceName() }
})

/** Self-update hooks (`update.ts`'s `Updater`). */
export interface NodeUpdates {
  /** Fetch the manifest; `Switched` means a new release is in place and the process should exit. */
  readonly check: Effect.Effect<{ readonly _tag: string }>
  /** The server welcomed this node. */
  readonly welcomed: Effect.Effect<void>
  /** The running release has not been confirmed by a welcome yet. */
  readonly onProbation: () => boolean
}

/** Why `runNode` returned: the service manager restarts the process with `exitCode`. */
export type NodeExit =
  | { readonly _tag: "Updated"; readonly exitCode: 0 }
  /** A release on probation reached the server but not `welcome`: counted as a failed start (`releases.ts`). */
  | { readonly _tag: "FailedStart"; readonly exitCode: 1; readonly reason: string }

/**
 * Close codes that mean the server was reached and refused what this node said (as opposed to an unreachable or
 * restarting server, or a removed node): protocol mismatch, protocol error, unsupported or invalid data, policy.
 */
const REFUSED_CODES = new Set([4400, 1002, 1003, 1007, 1008])

/** Whether a connection that never got `welcome` counts against a release on probation. */
export const countsAsFailedStart = (lost: ConnectionLost): boolean =>
  !lost.welcomed && (REFUSED_CODES.has(lost.code) || (lost.code === 0 && lost.reason === "no welcome"))

export interface NodeRunOptions {
  readonly config: NodeConfig
  readonly settings?: NodeSettings
  readonly timing?: Partial<Timing>
  readonly clientId?: string
  readonly log?: (line: string) => void
  readonly onTrace?: (line: string) => void
  /** The server speaks another protocol version (4400). Default: log; the backoff retries. */
  readonly onOutdated?: Effect.Effect<void>
  /** Self-update (absent: never updates, e.g. a development run). */
  readonly updates?: NodeUpdates
  /** Called after every lost connection with the delay chosen (tests). */
  readonly onReconnect?: (lost: ConnectionLost, delayMs: number) => void
  readonly random?: () => number
  readonly progressMs?: number
}

export const defaultLog = (line: string) => {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`)
}

/** Run the node until interrupted, or until it must restart (a new release, a failed start on probation). */
export const runNode = (options: NodeRunOptions) =>
  Effect.gen(function*() {
    const input = yield* AudioInput
    const output = yield* AudioOutput
    const info = yield* NodeAudioInfo
    const timing: Timing = { ...defaultTiming, ...options.timing }
    const log = options.log ?? defaultLog
    const settings: NodeSettings = options.settings ?? { volume: DEFAULT_VOLUME, cues: true }
    const clientId = options.clientId ?? `node-${randomUUID()}`
    const url = webSocketUrl(options.config.server)
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)

    let link: OpenSocket | undefined
    let session: Session | undefined
    const player: ReplyPlayer = makeReplyPlayer({
      output,
      cueOutput: info.cueOutput,
      outputLatencyMs: info.outputLatencyMs,
      volume: () => settings.volume,
      send: (m) => link?.send(m),
      fork,
      log,
      ...(options.progressMs !== undefined ? { progressMs: options.progressMs } : {})
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => player.lost()))

    // The capture starts once the node first owns the audio (so a replayed WAV is not spent before the server
    // listens) and then runs for the life of the process, across reconnects. A capture process that dies is
    // restarted after a second.
    const wanted = yield* Deferred.make<void>()
    const capture = Stream.runForEach(input.stream, (frame) => Effect.sync(() => session?.sendMic(frame))).pipe(
      Effect.catchCause((cause) => Effect.sync(() => log(`microphone capture stopped: ${String(cause)}; restarting`))),
      Effect.andThen(Effect.sleep(1000)),
      Effect.forever
    )
    yield* Effect.forkScoped(Effect.andThen(Deferred.await(wanted), capture))

    log(`pva-node: ${url} as device ${options.config.deviceId}; input ${info.input}, output ${info.output}`)
    const updates = options.updates
    const updated: Effect.Effect<boolean> = updates === undefined
      ? Effect.succeed(false)
      : Effect.map(updates.check, (result) => result._tag === "Switched")
    let attempt = 0
    while (true) {
      // §7.3: the manifest check comes before every hello, so a node never stays on another protocol for longer
      // than one connection attempt.
      if (yield* updated) return { _tag: "Updated", exitCode: 0 } as const
      const lost = yield* Effect.scoped(connectOnce(url, helloFor(options.config, clientId), (socket) => {
        link = socket
        const handlers = makeSession({
          link: socket,
          player,
          cues: () => settings.cues,
          claimRetryMs: timing.claimRetryMs,
          log,
          ...(options.onTrace !== undefined ? { onTrace: options.onTrace } : {}),
          onOwner: () => Deferred.doneUnsafe(wanted, Effect.void)
        })
        session = handlers
        if (updates === undefined) return handlers
        return {
          ...handlers,
          onMessage: (message) => {
            if (message.type === "welcome") fork(updates.welcomed)
            handlers.onMessage(message)
          }
        }
      }, timing)).pipe(Effect.flip)
      session?.close()
      session = undefined
      link = undefined

      if (lost.welcomed) attempt = 0
      attempt++
      const action = closeAction(lost.code)
      let delayMs: number
      if (action === "unauthorized") {
        log("this node was removed from the assistant or its credential is wrong; pair it again (retrying every 10 minutes)")
        delayMs = timing.unauthorizedRetryMs
      } else {
        if (action === "outdated") {
          log(`the server speaks another protocol version than this node (${PROTOCOL_VERSION}); the node must be updated`)
          if (options.onOutdated !== undefined) yield* options.onOutdated
          if (yield* updated) return { _tag: "Updated", exitCode: 0 } as const
        }
        if (updates?.onProbation() === true && countsAsFailedStart(lost)) {
          const reason = `${lost.code === 0 ? lost.reason : `${lost.code} ${lost.reason}`}`
          log(`the new release did not get a welcome (${reason}); exiting, which counts as a failed start`)
          return { _tag: "FailedStart", exitCode: 1, reason } as const
        }
        delayMs = reconnectDelay(attempt, timing, options.random)
      }
      log(`connection lost (${lost.code === 0 ? lost.reason : `${lost.code} ${lost.reason}`}); reconnecting in ${(delayMs / 1000).toFixed(1)} s`)
      options.onReconnect?.(lost, delayMs)
      yield* Effect.sleep(delayMs)
    }
  })
