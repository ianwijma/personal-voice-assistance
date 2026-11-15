/**
 * Scripted conversations for the compatibility tests: simulated voices (`synth.ts`, the lab's formant
 * synthesiser) played through the real feature extractor, the way the host feeds it (`voices.ts`: the person's
 * side is on while listening or hearing, the assistant's while speaking), into a `Runner` on a recording canvas.
 * Fixed 60 Hz steps, so a run is deterministic.
 */
import type { Character, FrameExtensions, Mode, OptionValues, Palette } from "@/characters/contract.ts"
import { coreOf, Runner } from "@/characters/runner.ts"
import { agentOn, LiveVoice, userOn } from "@/characters/voices.ts"
import { markStage, recording } from "./fakeCanvas.ts"
import { renderRoomNoise, renderVoice, type VoiceClip } from "./synth.ts"

export const DT = 1 / 60

/** Plays a clip in a loop; `window(out)` writes the latest samples ending at the play position. */
class Loop {
  private pos = 0
  private readonly clip: VoiceClip
  constructor(clip: VoiceClip) {
    this.clip = clip
  }
  advance(dt: number): void {
    this.pos += Math.round(dt * this.clip.sampleRate)
  }
  rewind(): void {
    this.pos = 0
  }
  add(out: Float32Array): void {
    const s = this.clip.samples
    const n = s.length
    for (let i = 0; i < out.length; i++) {
      const k = (((this.pos - out.length + i) % n) + n) % n
      out[i] = out[i]! + s[k]!
    }
  }
}

let clips: { user: VoiceClip; agent: VoiceClip; room: VoiceClip } | null = null
const voicesOnce = () =>
  (clips ??= {
    user: renderVoice({ register: "mid", loudness: "normal", delivery: "normal", seed: 1 }),
    agent: renderVoice({ register: "high", loudness: "normal", delivery: "questions", seed: 2 }),
    room: renderRoomNoise()
  })

/** A conversation: what the application's mode is at time `t` (seconds). */
export type Script = (t: number) => Mode

/** idle → listening → hearing → thinking → speaking → listening → idle, about 11 s. */
export const CONVERSATION: Script = (t) =>
  t < 1 ? "idle" : t < 2 ? "listening" : t < 5 ? "hearing" : t < 6.5 ? "thinking" : t < 9.5 ? "speaking" : t < 10.5 ? "listening" : "idle"
export const CONVERSATION_SECONDS = 11

export const pinned = (mode: Mode): Script => () => mode

export interface RunOptions {
  readonly script: Script
  readonly seconds: number
  readonly palette: Palette
  readonly stored?: OptionValues
  readonly reducedMotion?: boolean
  /** No audio at all (both sides silent). */
  readonly silent?: boolean
  readonly ext?: (t: number) => FrameExtensions | undefined
  readonly size?: readonly [width: number, height: number, dpr: number]
  /** Times (s) at which to keep the frame's digest. Default: every 0.5 s. */
  readonly checkpoints?: ReadonlyArray<number>
}

export interface RunResult {
  /** Digest of each checkpoint's frame, with its time, mode and call count. */
  readonly frames: ReadonlyArray<{ readonly t: number; readonly mode: Mode; readonly calls: number; readonly digest: string }>
  /** Digest of the last frame. */
  readonly last: string
  /** Drawing calls in the last frame. */
  readonly lastCalls: number
  /** Total drawing calls over the run. */
  readonly calls: number
  /** How far drawing went outside the canvas over the run, CSS px (0 when it stayed inside). */
  readonly overflow: number
  /** Mean `frame()` time, ms. */
  readonly meanFrameMs: number
}

export const STAGE_SIZE = [720, 240, 1] as const

export const run = (character: Character, o: RunOptions): RunResult => {
  const v = voicesOnce()
  const userClip = new Loop(v.user)
  const agentClip = new Loop(v.agent)
  const room = new Loop(v.room)
  const user = new LiveVoice()
  const agent = new LiveVoice()
  const [w, h, dpr] = o.size ?? STAGE_SIZE
  const canvas = document.createElement("canvas")
  markStage(canvas)
  const runner = new Runner(character, canvas, o.stored)
  recording.reset()
  runner.create()
  runner.resize(w, h, dpr)
  const checkpoints = o.checkpoints ?? Array.from({ length: Math.floor(o.seconds / 0.5) }, (_, i) => (i + 1) * 0.5)
  const frames: Array<{ t: number; mode: Mode; calls: number; digest: string }> = []
  const pointer = { x: w / 2, y: h / 2, down: false, inside: false }
  let calls = 0
  let overflow = 0
  let spent = 0
  let last = ""
  let lastCalls = 0
  let prev: Mode | null = null
  const steps = Math.round(o.seconds / DT)
  let next = 0
  for (let i = 1; i <= steps; i++) {
    const t = i * DT
    const mode = o.script(t)
    const core = coreOf(mode)
    // A phrase starts from its beginning each time its side comes on.
    if (mode !== prev) {
      if (core === "hearing") userClip.rewind()
      if (core === "speaking") agentClip.rewind()
      prev = mode
    }
    userClip.advance(DT)
    agentClip.advance(DT)
    room.advance(DT)
    const uw = user.window(16000)
    uw.fill(0)
    const uOn = !o.silent && userOn(core)
    if (uOn) {
      room.add(uw)
      if (core === "hearing") userClip.add(uw)
    }
    const aw = agent.window(16000)
    aw.fill(0)
    const aOn = !o.silent && agentOn(core)
    if (aOn) agentClip.add(aw)
    const uf = user.step(DT, uOn)
    const af = agent.step(DT, aOn)
    recording.reset()
    const t0 = performance.now()
    runner.step({ mode, dt: DT, user: uf, agent: af, palette: o.palette, reducedMotion: o.reducedMotion === true, pointer, sinceInterrupt: Infinity, ...(o.ext !== undefined ? { ext: o.ext(t) ?? {} } : {}) })
    spent += performance.now() - t0
    calls += recording.calls
    if (recording.minX !== Infinity) {
      const out = Math.max(-recording.minX, -recording.minY, recording.maxX - canvas.width, recording.maxY - canvas.height, 0) / dpr
      if (out > overflow) overflow = out
    }
    last = recording.digest
    lastCalls = recording.calls
    while (next < checkpoints.length && t + 1e-9 >= checkpoints[next]!) {
      frames.push({ t: Math.round(checkpoints[next]! * 100) / 100, mode, calls: recording.calls, digest: recording.digest })
      next++
    }
  }
  runner.dispose()
  return { frames, last, lastCalls, calls, overflow, meanFrameMs: spent / steps }
}
