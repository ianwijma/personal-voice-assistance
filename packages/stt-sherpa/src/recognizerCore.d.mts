export declare const RATE: number
export declare const FRAME: number
export declare const FRAME_MS: number
export declare const SEGMENT_LIMITS: { checkpointMs: number; pauseMs: number; hardCheckpointMs: number; overlapMs: number; keepMs: number; joinHoldMs: number }

export interface RecognizerCoreStats {
  readonly replayedFrames: number
  readonly replayMs: number
  readonly refedFrames: number
  readonly overlapFrames: number
  readonly unmatchedJoins: number
  readonly cutMs: number
  readonly checkpoints: number
  readonly uncutBoundaries: number
}

export interface RecognizerCore {
  readonly onMessage: (message: unknown) => void
  readonly inspect: () => {
    readonly queuedSamples: number
    readonly pendingDecodes: number
    readonly retainedStreamingFrames: number
    readonly pieces: number
    /** Sessions open now. */
    readonly sessions: number
    /** Detectors kept for later sessions (at most a few, whatever thresholds were asked for). */
    readonly idleVads: number
    readonly stats: RecognizerCoreStats
  }
}

export declare const reconcile: (prev: string, next: string, overlapWords?: number) => { text: string; matched: boolean }

export declare const wordsInLead: (
  result: { readonly text?: string; readonly tokens?: ReadonlyArray<string>; readonly timestamps?: ReadonlyArray<number> } | undefined,
  leadFrames: number,
  fedFrames: number
) => number

export declare const makeRecognizerCore: (deps: {
  config: unknown
  online?: unknown
  offline?: unknown
  /** The VAD of the first session (loaded and warm at startup); reused by later sessions when it is free. */
  vad?: unknown
  /**
   * Creates a VAD for a session when every existing one with that threshold is in use (several sessions at once, or
   * a session whose `open` asks for another threshold).
   */
  makeVad?: (threshold: number) => unknown
  /** The AGC of the first session with the worker's default gain options (`config.agc`). */
  agc?: unknown
  /** Creates an AGC with a session's options. Without it, sessions get no gain control. */
  makeAgc?: (options: unknown) => unknown
  post: (message: any) => void
  collect?: () => void
  segmentLimits?: Partial<{ checkpointMs: number; pauseMs: number; hardCheckpointMs: number; overlapMs: number; keepMs: number; joinHoldMs: number }>
  maxQueuedDecodeMs?: number
  /** Measurements: the text of each streaming checkpoint. */
  onCheckpoint?: (text: string) => void
}) => RecognizerCore
