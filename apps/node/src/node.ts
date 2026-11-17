/**
 * The node program (`pva-node run`): one microphone capture and one reply player for the life of the process, and a
 * connection to the assistant that is re-made for ever (docs/VOICE-NODES.md §8). Each connection gets a fresh
 * `Session`; the capture feeds whichever session is current and owns the audio.
 *
 * Protocol 9: `hello` carries the node's credential (`helloFor`); the pushed `sound` (volume, cues) and
 * `soundDevices` (input reopened, output used from the next play, a device that fails falls back to the default and
 * is reported as `lastError`) come with `snapshot.setup` / `device.setup`; `node.status` (`status.ts`) and
 * `node.level` go to the server; `node.command` is `identify`, `test-speaker`, `test-mic`, `restart` or `update`.
 * `updates` (`update.ts`): the manifest check before every connection attempt and after a 4400, the confirmation of
 * a new release at its first `welcome`, and a failed start while it is on probation. 4403 is the slow retry.
 */
import { randomUUID } from "node:crypto"
import { AudioInput, AudioOutput } from "@pva/core"
import {
  type DeviceCapabilities,
  type NodeCommand,
  type NodeHello,
  type NodeSoundDevices,
  PROTOCOL_VERSION,
  VOICE_NODE_KIND
} from "@pva/protocol"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { type AudioDevices, missingTools, NodeAudioInfo, type NodeAudio } from "./audio.ts"
import { webSocketUrl, type NodeConfig, defaultDeviceName } from "./config.ts"
import {
  closeAction,
  connectOnce,
  type ConnectionLost,
  defaultTiming,
  type HelloMessage,
  type OpenSocket,
  PIN_MISMATCH,
  reconnectDelay,
  type Timing
} from "./connection.ts"
import { platformInfo } from "./pair.ts"
import { makeReplyPlayer, type ReplyPlayer } from "./playback.ts"
import { makeSession, type Session } from "./session.ts"
import { makeStatusReporter } from "./status.ts"
import { asBytes, identifySound, TONE_RATE, testTone } from "./tones.ts"
import { detectInstall, NODE_VERSION } from "./update.ts"

export { VOICE_NODE_KIND }

/** Settings the node applies itself: the CLI's starting values, then the server's `sound`. */
export interface NodeSettings {
  volume: number
  cues: boolean
}

export const DEFAULT_VOLUME = 80

/** What this node declares it can do (§5.2). */
export const NODE_CAPABILITIES: DeviceCapabilities = { v: 1, speaker: { media: ["speech"] }, microphone: {} }

/** `hello.node` without the credential: the running version and bundle, and the box. */
export type NodeIdentity = Omit<NodeHello, "credential">

export const nodeIdentity = (): NodeIdentity => {
  const install = detectInstall()
  return {
    version: NODE_VERSION.slice(0, 64),
    ...(install._tag !== "Dev" ? { bundleSha256: install.sha256 } : {}),
    platform: platformInfo()
  }
}

/** The `hello` of this node (§5.2). */
export const helloFor = (config: NodeConfig, clientId: string, identity: NodeIdentity = nodeIdentity()): HelloMessage => ({
  type: "hello",
  protocol: PROTOCOL_VERSION,
  clientId,
  resumeOwner: true,
  frontend: "voice",
  device: { id: config.deviceId, kind: VOICE_NODE_KIND, name: config.name ?? defaultDeviceName(), capabilities: NODE_CAPABILITIES },
  node: { credential: config.credential, ...identity }
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
  /** `node.command restart` (admin's Restart). */
  | { readonly _tag: "Restarted"; readonly exitCode: 0 }
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

export interface NodeRunOptions {
  readonly config: NodeConfig
  readonly settings?: NodeSettings
  /** The devices the node starts with (`""` = the backend's default); the server's `soundDevices` replace them. */
  readonly soundDevices?: NodeSoundDevices
  /**
   * The audio services for a choice of devices. Absent (WAV files instead of devices): `soundDevices` of the
   * server is ignored.
   */
  readonly audioFor?: (devices: NodeSoundDevices) => NodeAudio
  /** The devices now, for `node.status` (absent: none listed). */
  readonly devices?: Effect.Effect<AudioDevices, unknown>
  /** Programs the backend needs that are missing (default: looked up on `PATH`). */
  readonly missingTools?: () => ReadonlyArray<string>
  /** `hello.node` without the credential (default: this process). */
  readonly identity?: NodeIdentity
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

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value ?? fallback)))

const dbfs = (amplitude: number) => Math.max(-120, 20 * Math.log10(Math.max(amplitude, 1e-9)))

/** Run the node until interrupted, or until it must restart (a new release, admin's restart, a failed start on probation). */
export const runNode = (options: NodeRunOptions) =>
  Effect.gen(function*() {
    const input = yield* AudioInput
    const output = yield* AudioOutput
    const info = yield* NodeAudioInfo
    const timing: Timing = { ...defaultTiming, ...options.timing }
    const log = options.log ?? defaultLog
    const settings: NodeSettings = { ...(options.settings ?? { volume: DEFAULT_VOLUME, cues: true }) }
    const clientId = options.clientId ?? `node-${randomUUID()}`
    const url = webSocketUrl(options.config.server)
    const identity = options.identity ?? nodeIdentity()
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)
    const stopped = yield* Deferred.make<NodeExit>()
    let exitRequested: NodeExit | undefined
    const requestExit = (exit: NodeExit) => {
      exitRequested ??= exit
      Deferred.doneUnsafe(stopped, Effect.succeed(exit))
    }

    let link: OpenSocket | undefined
    let session: Session | undefined
    let audio: NodeAudio = { input, output, info }
    /** What the server asked for, and what is open now (a device that failed to open falls back to ""). */
    let requested: NodeSoundDevices = options.soundDevices ?? { input: "", output: "" }
    const opened = { ...requested }

    const backend = info.input !== "file" ? info.input : info.output
    const status = makeStatusReporter({
      backend,
      list: () => (options.devices === undefined ? Promise.resolve(undefined) : runPromise(options.devices).catch(() => undefined)),
      missingTools: options.missingTools ?? (() => (backend === "file" ? [] : missingTools(backend))),
      opened: () => ({
        input: audio.info.input === "file" ? undefined : opened.input,
        output: audio.info.output === "file" ? undefined : opened.output
      }),
      pollMs: timing.statusPollMs,
      throttleMs: timing.statusThrottleMs
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => status.stop()))

    const fallBack = (side: "input" | "output", why: string) => {
      const wanted = opened[side]
      if (options.audioFor === undefined || wanted === "") return false
      opened[side] = ""
      const fresh = options.audioFor(opened)
      audio = side === "input" ? { ...audio, input: fresh.input } : { ...audio, output: fresh.output, info: fresh.info }
      const message = `Could not open ${wanted} (${why.slice(0, 200)}); using the default device.`
      log(message)
      status.setError(message)
      return true
    }

    const player: ReplyPlayer = makeReplyPlayer({
      output: () => audio.output,
      cueOutput: () => audio.info.cueOutput,
      outputLatencyMs: info.outputLatencyMs,
      volume: () => settings.volume,
      send: (m) => link?.send(m),
      fork,
      log,
      onPlayFailed: (why) => {
        fallBack("output", why)
      },
      ...(options.progressMs !== undefined ? { progressMs: options.progressMs } : {})
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => player.lost()))

    // `test-mic`: levels of the captured frames, sent 5 times a second for the length of the test and not otherwise.
    let meter: { sumSquares: number; peak: number; count: number; every: ReturnType<typeof setInterval>; end: ReturnType<typeof setTimeout> } | undefined
    const stopMeter = () => {
      if (meter === undefined) return
      clearInterval(meter.every)
      clearTimeout(meter.end)
      meter = undefined
    }
    yield* Effect.addFinalizer(() => Effect.sync(stopMeter))
    const startMeter = (durationMs: number) => {
      stopMeter()
      const state = {
        sumSquares: 0,
        peak: 0,
        count: 0,
        every: setInterval(() => {
          const rms = state.count === 0 ? 0 : Math.sqrt(state.sumSquares / state.count)
          link?.send({ type: "node.level", rmsDbfs: dbfs(rms / 32768), peakDbfs: dbfs(state.peak / 32768) })
          state.sumSquares = 0
          state.peak = 0
          state.count = 0
        }, 200),
        end: setTimeout(stopMeter, durationMs)
      }
      meter = state
    }
    const measure = (frame: Uint8Array) => {
      if (meter === undefined) return
      const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
      for (let i = 0; i + 1 < buffer.length; i += 2) {
        const v = buffer.readInt16LE(i)
        meter.sumSquares += v * v
        meter.peak = Math.max(meter.peak, Math.abs(v))
        meter.count++
      }
    }

    // The capture starts once the node first owns the audio (so a replayed WAV is not spent before the server
    // listens) and then runs for the life of the process, across reconnects. A capture process that dies is
    // restarted after a second; one that never gave a frame on a chosen device falls back to the default device.
    const captureOnce = Effect.suspend(() => {
      let gotFrame = false
      return Stream.runForEach(audio.input.stream, (frame) =>
        Effect.sync(() => {
          gotFrame = true
          measure(frame)
          session?.sendMic(frame)
        })).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log(`microphone capture stopped: ${String(cause)}; restarting`))),
          Effect.andThen(Effect.suspend(() => {
            if (!gotFrame && fallBack("input", "the capture gave no audio")) return Effect.void
            return Effect.sleep(1000)
          }))
        )
    }).pipe(Effect.forever)
    let capture: Fiber.Fiber<unknown> | undefined
    const startCapture = () => {
      capture = fork(captureOnce)
    }
    /** Interrupt the running capture, then capture from `audio.input` as it is now. */
    const restartCapture = () => {
      const old = capture
      capture = fork(Effect.andThen(old === undefined ? Effect.void : Fiber.interrupt(old), captureOnce))
    }
    yield* Effect.addFinalizer(() => (capture === undefined ? Effect.void : Fiber.interrupt(capture)))

    const applySetup = (setup: { readonly sound?: { readonly volume: number; readonly cues: boolean }; readonly soundDevices?: NodeSoundDevices }) => {
      if (setup.sound !== undefined) {
        settings.volume = setup.sound.volume
        settings.cues = setup.sound.cues
      }
      const next = setup.soundDevices
      if (next === undefined || options.audioFor === undefined) return
      const inputChanged = next.input !== requested.input
      const outputChanged = next.output !== requested.output
      if (!inputChanged && !outputChanged) return
      requested = { input: next.input, output: next.output }
      opened.input = next.input
      opened.output = next.output
      const fresh = options.audioFor(opened)
      status.clearError() // before the reopening: a device that fails to open sets the error again
      if (outputChanged) audio = { ...audio, output: fresh.output, info: fresh.info }
      if (inputChanged) {
        audio = { ...audio, input: fresh.input }
        if (capture !== undefined) {
          log(`reopening the microphone on ${next.input === "" ? "the default device" : next.input}`)
          restartCapture()
        }
      }
      status.changed()
    }

    const onCommand = (command: NodeCommand) => {
      log(`command from the server: ${command.command}`)
      switch (command.command) {
        case "identify":
          player.cue(identifySound(TONE_RATE), TONE_RATE)
          return
        case "test-speaker":
          player.cue(testTone(clamp(command.durationMs, 1000, 50, 5000), TONE_RATE), TONE_RATE)
          return
        case "test-mic":
          startMeter(clamp(command.durationMs, 10_000, 100, 30_000))
          return
        case "restart":
          requestExit({ _tag: "Restarted", exitCode: 0 })
          return
        case "update":
          if (options.updates === undefined) {
            log("update: this node does not update itself (running from source or not from an installed release)")
            return
          }
          fork(Effect.map(options.updates.check, (result) => {
            if (result._tag === "Switched") requestExit({ _tag: "Updated", exitCode: 0 })
          }))
          return
      }
    }

    log(`pva-node: ${url} as device ${options.config.deviceId}; input ${info.input}, output ${info.output}`)
    const updates = options.updates
    const updated: Effect.Effect<boolean> = updates === undefined
      ? Effect.succeed(false)
      : Effect.map(updates.check, (result) => result._tag === "Switched")
    let attempt = 0
    while (true) {
      // The manifest check comes before every hello, so a node never stays on another protocol for longer than one
      // connection attempt.
      if (yield* updated) return { _tag: "Updated", exitCode: 0 } as const
      const hello = helloFor(options.config, clientId, identity)
      const connection = Effect.scoped(connectOnce(url, hello, (socket) => {
        link = socket
        const handlers = makeSession({
          link: socket,
          player,
          cues: () => settings.cues,
          claimRetryMs: timing.claimRetryMs,
          log,
          ...(options.onTrace !== undefined ? { onTrace: options.onTrace } : {}),
          onOwner: () => {
            if (capture === undefined) startCapture()
          },
          onSetup: applySetup,
          onCommand
        })
        session = handlers
        return {
          ...handlers,
          onUndecodable: (text) => log(`could not decode a message from the server: ${text.slice(0, 200)}`),
          onMessage: (message) => {
            if (message.type === "welcome") {
              if (updates !== undefined) fork(updates.welcomed)
              status.clearError(PIN_MISMATCH)
              handlers.onMessage(message)
              status.connected((m) => socket.send(m))
              return
            }
            handlers.onMessage(message)
          }
        }
      }, timing, options.config.tlsPin)).pipe(Effect.flip)
      const outcome = yield* Effect.raceFirst(connection, Deferred.await(stopped))
      session?.close()
      session = undefined
      link = undefined
      stopMeter()
      status.disconnected()
      if ("exitCode" in outcome) return outcome
      const lost = outcome

      if (lost.reason === PIN_MISMATCH) {
        log(PIN_MISMATCH)
        status.setError(PIN_MISMATCH)
      }
      if (lost.welcomed) attempt = 0
      attempt++
      const action = closeAction(lost.code)
      let delayMs: number
      if (action === "unauthorized") {
        log("this node was removed from the assistant or paired again elsewhere; pair it again (retrying every 10 minutes)")
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
      yield* Effect.raceFirst(Effect.sleep(delayMs), Effect.asVoid(Deferred.await(stopped)))
      if (exitRequested !== undefined) return exitRequested
    }
  })
