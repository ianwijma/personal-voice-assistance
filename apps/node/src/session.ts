/**
 * The device side of the protocol for one connection (docs/VOICE-NODES.md §4.2, §4.4, §7.4): after `welcome` it
 * claims the audio and turns the microphone on, sends microphone frames with sequence numbers while it is the
 * owner, hands reply audio to the player, plays the wake and lapse cues, and prints the latency line of every turn
 * from `turn.end.trace` (the same `TurnTrace` numbers as the server's log).
 *
 * Protocol 5 (main) facts this relies on: the last `audio.claim` wins; `session` tells the role; `wake` carries
 * `armed`; reply audio comes only to the owner. Not here yet (later packages, no protocol messages invented):
 * `hello.node` and 4403 (WP-10 / WP-6), `node.status` / `node.command` / `node.level` (WP-10), on-keyword
 * streaming (WP-10, `kws.ts`). The protocol-6 error `sessions_full` is recognised from the raw text (see
 * `isSessionsFull`) because the protocol-5 codec cannot decode its code yet.
 */
import {
  type ClientMessage,
  encodeMicFrame,
  MIC_SAMPLE_RATE,
  type ServerMessage,
  type TraceInfo
} from "@pva/protocol"
import type { ReplyPlayer } from "./playback.ts"
import { lapseCue, TONE_RATE, wakeCue } from "./tones.ts"

/** Microphone frames are dropped (not queued) when more than this is waiting to be sent: 500 ms of audio (as the web). */
export const MIC_BUFFER_LIMIT = 16_000

/** What the session needs from the socket. */
export interface SessionLink {
  readonly send: (message: ClientMessage) => void
  readonly sendBinary: (frame: Uint8Array) => void
  readonly bufferedAmount: () => number
}

export interface SessionOptions {
  readonly link: SessionLink
  readonly player: ReplyPlayer
  /** Cues on (profile `cues`, WP-10; a CLI flag until then). */
  readonly cues: () => boolean
  /** After `sessions_full`, claim again this much later. */
  readonly claimRetryMs: number
  readonly log: (line: string) => void
  /** Every turn's latency line (default: `log`). */
  readonly onTrace?: (line: string, trace: TraceInfo) => void
  /** The node became the owner (the capture can start). */
  readonly onOwner?: () => void
  readonly setTimer?: (f: () => void, ms: number) => () => void
}

export interface SessionStats {
  readonly micSent: number
  readonly micDropped: number
  readonly claims: number
}

export interface Session {
  readonly onMessage: (message: ServerMessage) => void
  /** A text frame the codec could not decode (`Invalid`), for the protocol-6 `sessions_full` seam. */
  readonly onUndecodable: (text: string) => void
  readonly onReplyFrame: (turnId: number, pcm: Uint8Array) => void
  /** One captured 20 ms frame; sent only while this connection owns the audio. */
  readonly sendMic: (pcm: Uint8Array) => void
  readonly isOwner: () => boolean
  readonly close: () => void
  readonly stats: () => SessionStats
}

/**
 * TODO(protocol 6 / WP-10): `sessions_full` is an `error` code from the voice-sessions branch on. Protocol 5's
 * `ErrorCode` does not have it, so its codec reports such a message as invalid; recognise it from the raw JSON.
 * Once `@pva/protocol` has the code, handle it in `onMessage` and drop this.
 */
export const isSessionsFull = (text: string): boolean => {
  try {
    const parsed = JSON.parse(text) as { type?: unknown; error?: { code?: unknown } }
    return parsed.type === "error" && parsed.error?.code === "sessions_full"
  } catch {
    return false
  }
}

const fmt = (n: number) => `${Math.round(n)}ms`

/** The node's latency line from a `turn.end` trace: marks relative to end of turn, as the server's `formatTrace`. */
export const formatTraceInfo = (t: TraceInfo): string => {
  const parts = [`turn #${t.turnId} ${t.mode}${t.speculative ? " (speculative)" : ""} ${t.outcome}`]
  let prev: number | undefined
  for (const mark of ["llmRequestSent", "llmFirstToken", "firstClause", "ttsFirstAudio", "playbackStart"] as const) {
    const v = t.marks[mark]
    if (v === undefined) continue
    parts.push(`${mark}=${fmt(v)}${prev !== undefined ? ` (+${fmt(v - prev)})` : ""}`)
    prev = v
  }
  const start = t.marks.playbackStart
  if (t.client !== undefined && start !== undefined) {
    parts.push(`audible=${fmt(start + t.client.outputLatencyMs)} (+${fmt(t.client.outputLatencyMs)} output latency, start delay ${fmt(t.client.startDelayMs)})`)
  }
  if (t.tools.length > 0) parts.push(`tools: ${t.tools.map((x) => `${x.name} ${fmt(x.ms)}`).join(", ")}`)
  if (t.voices.length > 0) parts.push(`voices: ${t.voices.join(", ")}`)
  if (t.totalMs !== undefined) parts.push(`total=${fmt(t.totalMs)}`)
  return parts.join(" ")
}

const defaultTimer = (f: () => void, ms: number) => {
  const t = setTimeout(f, ms)
  return () => clearTimeout(t)
}

export const makeSession = (options: SessionOptions): Session => {
  const { link, player, log } = options
  const setTimer = options.setTimer ?? defaultTimer
  let owner = false
  let ownerPresent = false
  let closed = false
  let micSeq = 0
  /** A `wake { armed: true }` came and no turn started since: `asleep` now means the window lapsed. */
  let armedPending = false
  let cancelRetry: (() => void) | undefined
  const counters = { micSent: 0, micDropped: 0, claims: 0 }

  const claim = () => {
    if (closed) return
    cancelRetry?.()
    cancelRetry = undefined
    counters.claims++
    link.send({ type: "audio.claim", audio: { contextSampleRate: MIC_SAMPLE_RATE, outputPath: "direct" } })
    // Continuous streaming (§6): the microphone is live from the claim on. WP-10's on-keyword mode sends
    // `mic.state` on a spotter fire instead.
    link.send({ type: "mic.state", live: true })
    micSeq = 0
  }

  const retryClaimLater = (why: string) => {
    if (closed || cancelRetry !== undefined) return
    log(`${why}; claiming the audio again in ${Math.round(options.claimRetryMs / 1000)} s`)
    cancelRetry = setTimer(() => {
      cancelRetry = undefined
      claim()
    }, options.claimRetryMs)
  }

  const setOwner = (next: boolean) => {
    if (next === owner) return
    owner = next
    if (owner) {
      micSeq = 0
      options.onOwner?.()
    } else {
      // Another device took the audio: whatever was playing is no longer ours to report.
      player.lost()
    }
  }

  const onMessage = (m: ServerMessage) => {
    if (closed) return
    switch (m.type) {
      case "welcome":
        ownerPresent = m.snapshot.ownerPresent
        setOwner(m.snapshot.role === "owner")
        claim()
        return
      case "session":
        ownerPresent = m.ownerPresent
        setOwner(m.role === "owner")
        // Protocol 5 shares one audio owner between all devices. Do not fight a browser that took it; take it
        // back once nobody holds it. (With voice sessions, protocol 6, a node is its own device and keeps it.)
        if (!owner && !ownerPresent) retryClaimLater("nobody owns the audio")
        else if (!owner) log(`another device took the audio (${m.reason}); waiting until it lets go`)
        return
      case "reply.start":
        if (owner) player.start(m.turnId, m.sampleRate)
        return
      case "reply.end":
        if (owner) player.end(m.turnId)
        return
      case "reply.stop":
        void player.stop(m.turnId)
        return
      case "wake":
        if (m.armed) {
          armedPending = true
          if (options.cues()) player.cue(wakeCue(TONE_RATE), TONE_RATE)
        }
        return
      case "turn.start":
        armedPending = false
        return
      case "state":
        if (m.state === "asleep" && armedPending) {
          armedPending = false
          if (options.cues()) player.cue(lapseCue(TONE_RATE), TONE_RATE)
        }
        return
      case "turn.end": {
        const line = formatTraceInfo(m.trace)
        if (options.onTrace !== undefined) options.onTrace(line, m.trace)
        else log(line)
        return
      }
      case "error":
        log(`server: ${m.error.code}: ${m.error.message}`)
        return
      default:
        return
    }
  }

  return {
    onMessage,
    onUndecodable: (text) => {
      if (isSessionsFull(text)) retryClaimLater("the assistant is talking on as many devices as it may (sessions_full)")
    },
    onReplyFrame: (turnId, pcm) => {
      if (owner && !closed) player.frame(turnId, pcm)
    },
    sendMic: (pcm) => {
      if (!owner || closed) return
      const frame = encodeMicFrame(micSeq, pcm)
      micSeq = (micSeq + 1) >>> 0
      if (link.bufferedAmount() > MIC_BUFFER_LIMIT) {
        // A growing send queue is latency: drop. The server sees the sequence gap.
        counters.micDropped++
        return
      }
      link.sendBinary(frame)
      counters.micSent++
    },
    isOwner: () => owner && !closed,
    close: () => {
      closed = true
      cancelRetry?.()
      cancelRetry = undefined
      owner = false
      player.lost()
    },
    stats: () => ({ ...counters })
  }
}
