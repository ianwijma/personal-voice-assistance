import { createStore, type Store } from "../store.ts"

/**
 * What the owner can read off "This device" to report audio problems: the
 * microphone as the browser reports it (after the processing switches), and
 * playback counters from the player worklet (underruns, gaps, smoothed clicks).
 * Kept in the page only; never sent to the server.
 */

export interface MicProcessing {
  readonly echoCancellation: boolean
  readonly noiseSuppression: boolean
  readonly autoGainControl: boolean
}

export interface MicReport {
  /** What the page asked for. */
  readonly requested: MicProcessing
  /** What `MediaStreamTrack.getSettings()` says (absent fields: the browser does not report them). */
  readonly sampleRate?: number
  readonly channelCount?: number
  readonly echoCancellation?: boolean
  readonly noiseSuppression?: boolean
  readonly autoGainControl?: boolean
  readonly label: string
  readonly contextSampleRate: number
  readonly baseLatencyMs?: number
  readonly outputLatencyMs?: number
}

/** One reply's playback, from the worklet's `stats` message. */
export interface ReplyStats {
  readonly id: number
  readonly underruns: number
  readonly gapMs: number
  readonly clicks: number
  readonly minQueueMs: number
  readonly srcRate: number
  readonly ctxRate: number
  readonly prebufferMs: number
}

export interface PlaybackTotals {
  readonly replies: number
  /** Replies with at least one underrun. */
  readonly repliesWithUnderruns: number
  readonly underruns: number
  readonly gapMs: number
  /** Steep edges (would-be clicks) the player smoothed: underrun edges, starts and cuts at a high level. */
  readonly clicks: number
  /** The lowest amount of audio that was queued while a reply played (how close it came to an underrun). */
  readonly minQueueMs: number | undefined
  readonly last: ReplyStats | undefined
  readonly since: number
}

export interface Diagnostics {
  readonly mic: MicReport | undefined
  readonly playback: PlaybackTotals
}

const emptyPlayback = (): PlaybackTotals => ({
  replies: 0,
  repliesWithUnderruns: 0,
  underruns: 0,
  gapMs: 0,
  clicks: 0,
  minQueueMs: undefined,
  last: undefined,
  since: Date.now()
})

type DiagnosticsAction =
  | { readonly type: "mic"; readonly report: MicReport | undefined }
  | { readonly type: "reply"; readonly stats: ReplyStats }
  | { readonly type: "reset" }

export const reduceDiagnostics = (s: Diagnostics, a: DiagnosticsAction): Diagnostics => {
  switch (a.type) {
    case "mic":
      return { ...s, mic: a.report }
    case "reply": {
      const p = s.playback
      const min = a.stats.minQueueMs >= 0 ? Math.min(p.minQueueMs ?? Infinity, a.stats.minQueueMs) : p.minQueueMs
      return {
        ...s,
        playback: {
          ...p,
          replies: p.replies + 1,
          repliesWithUnderruns: p.repliesWithUnderruns + (a.stats.underruns > 0 ? 1 : 0),
          underruns: p.underruns + a.stats.underruns,
          gapMs: p.gapMs + a.stats.gapMs,
          clicks: p.clicks + a.stats.clicks,
          minQueueMs: min,
          last: a.stats
        }
      }
    }
    case "reset":
      return { ...s, playback: emptyPlayback() }
  }
}

export type DiagnosticsStore = Store<Diagnostics, DiagnosticsAction>

export const createDiagnosticsStore = (): DiagnosticsStore =>
  createStore<Diagnostics, DiagnosticsAction>({ mic: undefined, playback: emptyPlayback() }, reduceDiagnostics)

const flag = (v: boolean | undefined) => (v === undefined ? "not reported" : v ? "on" : "off")

/** Plain text for "Copy report". */
export const formatDiagnostics = (d: Diagnostics, extra: { readonly userAgent: string; readonly outputPath: string; readonly prebufferMs: number }): string => {
  const lines = [`Browser: ${extra.userAgent}`]
  const m = d.mic
  if (m === undefined) lines.push("Microphone: not open")
  else {
    lines.push(
      `Microphone: ${m.label || "(no label)"}; ${m.sampleRate ?? "?"} Hz, ${m.channelCount ?? "?"} channel(s); audio context ${m.contextSampleRate} Hz` +
        (m.baseLatencyMs !== undefined ? `, base latency ${m.baseLatencyMs.toFixed(1)} ms` : "") +
        (m.outputLatencyMs !== undefined ? `, output latency ${m.outputLatencyMs.toFixed(1)} ms` : ""),
      `Processing requested: echo cancellation ${m.requested.echoCancellation ? "on" : "off"}, noise suppression ${m.requested.noiseSuppression ? "on" : "off"}, auto gain ${m.requested.autoGainControl ? "on" : "off"}`,
      `Processing reported:  echo cancellation ${flag(m.echoCancellation)}, noise suppression ${flag(m.noiseSuppression)}, auto gain ${flag(m.autoGainControl)}`
    )
  }
  const p = d.playback
  lines.push(
    `Playback (${extra.outputPath} output, prebuffer ${extra.prebufferMs} ms) since ${new Date(p.since).toLocaleTimeString()}: ${p.replies} replies, ` +
      `${p.underruns} underruns in ${p.repliesWithUnderruns} replies, ${p.gapMs} ms of gaps, ${p.clicks} clicks smoothed, ` +
      `lowest buffer ${p.minQueueMs === undefined ? "-" : `${p.minQueueMs} ms`}`
  )
  if (p.last !== undefined) {
    lines.push(`Last reply: ${p.last.srcRate} Hz → ${p.last.ctxRate} Hz, ${p.last.underruns} underruns, ${p.last.gapMs} ms of gaps, ${p.last.clicks} clicks smoothed`)
  }
  return lines.join("\n")
}
