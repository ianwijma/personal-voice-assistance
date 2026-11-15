/**
 * Conversation driver: the mode and both voices' features, advanced once per frame.
 *
 * Automatic loop (no microphone):
 *   idle 1.5 s → listening 1.2 s → hearing (one user phrase plays) → thinking 1.5 s
 *   → speaking (one agent phrase plays) → listening 1.2 s → hearing … ; every third
 *   exchange goes back through idle so the idle look shows up regularly.
 * With the real microphone the loop follows the person instead: listening waits until they
 * speak, hearing lasts until 0.6 s after they stop.
 * A pinned mode holds: hearing loops the whole user clip, speaking the whole agent clip,
 * listening carries only room tone, idle and thinking are silent.
 *
 * Only the side that is "on" gets audio: the user in listening (room tone) and hearing,
 * the agent in speaking. The other side is fed silence, so its features decay naturally.
 */
import type { Mode, VoiceFeatures } from "./contract.ts"
import { FeatureExtractor } from "./features.ts"
import { ClipPlayer, type Feed, type MicFeed } from "./sources.ts"
import { renderRoomNoise, type VoiceClip } from "./synth.ts"

export type Pin = Mode | "auto"

const IDLE_FOR = 1.5
const LISTEN_FOR = 1.2
const THINK_FOR = 1.5
/** A phrase span starts this early and runs this long past its end (so the hangover shows). */
const LEAD = 0.05
const TAIL = 0.35

class Side {
  readonly player = new ClipPlayer()
  private extractor: FeatureExtractor = new FeatureExtractor(16000)
  private readonly silence = new Float32Array(640)
  clip: VoiceClip
  phrase = 0
  /** Copy of the extractor's features object, stable across extractor swaps. */
  features: VoiceFeatures

  constructor(clip: VoiceClip) {
    this.clip = clip
    this.features = this.extractor.features
  }

  playNextPhrase(): void {
    const phrases = this.clip.phrases
    const p = phrases[this.phrase % Math.max(1, phrases.length)]
    this.phrase++
    if (p === undefined) this.player.play(this.clip, 0, this.clip.samples.length / this.clip.sampleRate)
    else this.player.play(this.clip, Math.max(0, p.start - LEAD), Math.min(this.clip.samples.length / this.clip.sampleRate, p.end + TAIL))
  }

  /** Feed one window (from `feed`, or silence) and advance by `dt`. */
  step(feed: Feed | null, dt: number, mixIn: Float32Array | null): void {
    const rate = feed?.sampleRate ?? 16000
    if (this.extractor.sampleRate !== rate) {
      this.extractor = new FeatureExtractor(rate)
      this.features = this.extractor.features
    }
    let w = feed === null ? this.silence : feed.window()
    if (mixIn !== null && feed !== null && mixIn.length === w.length && feed.sampleRate === 16000) {
      // Room tone under the voice (both 16 kHz, same window length). `w` is the player's own buffer.
      for (let i = 0; i < w.length; i++) w[i] = w[i]! + mixIn[i]!
    } else if (mixIn !== null && feed === null) {
      w = mixIn
    }
    this.extractor.process(w, dt)
  }
}

export class Conversation {
  mode: Mode = "idle"
  prevMode: Mode = "idle"
  modeAge = 0
  /** Seconds since the conversation was created (frames advanced). */
  clock = 0
  private pin: Pin
  private readonly userSide: Side
  private readonly agentSide: Side
  private readonly room = new ClipPlayer()
  private mic: MicFeed | null = null
  private exchanges = 0
  /** Frame stamp of the last step, so a conversation shared by many tiles advances once per frame. */
  stepped = -1

  constructor(opts: { readonly pin: Pin; readonly user: VoiceClip; readonly agent: VoiceClip }) {
    this.pin = opts.pin
    this.userSide = new Side(opts.user)
    this.agentSide = new Side(opts.agent)
    this.room.play(renderRoomNoise(), 0, null)
    this.enter(opts.pin === "auto" ? "idle" : opts.pin, true)
  }

  get user(): VoiceFeatures {
    return this.userSide.features
  }
  get agent(): VoiceFeatures {
    return this.agentSide.features
  }
  /** The player whose audio is "on" now (for the hear-it monitor), or null. */
  get audible(): ClipPlayer | null {
    if (this.mode === "hearing" && this.mic === null) return this.userSide.player
    if (this.mode === "speaking") return this.agentSide.player
    return null
  }
  get pinned(): Pin {
    return this.pin
  }

  setPin(pin: Pin): void {
    if (pin === this.pin) return
    this.pin = pin
    this.enter(pin === "auto" ? "listening" : pin, true)
  }

  setUserClip(clip: VoiceClip): void {
    if (clip === this.userSide.clip) return
    this.userSide.clip = clip
    this.userSide.phrase = 0
    if (this.mode === "hearing") this.restartAudio()
  }

  setAgentClip(clip: VoiceClip): void {
    if (clip === this.agentSide.clip) return
    this.agentSide.clip = clip
    this.agentSide.phrase = 0
    if (this.mode === "speaking") this.restartAudio()
  }

  /** Use the real microphone for the user side (null: back to the simulator). */
  setMic(mic: MicFeed | null): void {
    this.mic = mic
    if (this.pin === "auto") this.enter("listening", true)
    else this.restartAudio()
  }

  private restartAudio(): void {
    this.userSide.player.stop()
    this.agentSide.player.stop()
    const looping = this.pin !== "auto"
    if (this.mode === "hearing" && this.mic === null) {
      if (looping) this.userSide.player.play(this.userSide.clip, 0, null)
      else this.userSide.playNextPhrase()
    }
    if (this.mode === "speaking") {
      if (looping) this.agentSide.player.play(this.agentSide.clip, 0, null)
      else this.agentSide.playNextPhrase()
    }
  }

  private enter(mode: Mode, force = false): void {
    if (mode === this.mode && !force) return
    if (mode !== this.mode) {
      this.prevMode = this.mode
      this.mode = mode
      this.modeAge = 0
    }
    this.restartAudio()
  }

  /** Advance the loop and both voices by `dt` seconds. */
  step(dt: number): void {
    this.clock += dt
    this.modeAge += dt
    if (this.pin === "auto") this.advanceLoop()
    const m = this.mode
    const u = this.userSide
    const a = this.agentSide
    u.player.advance(dt)
    a.player.advance(dt)
    this.room.advance(dt)
    // The microphone is open in listening and hearing (and, with a real mic, always).
    const micOpen = m === "listening" || m === "hearing"
    if (this.mic !== null) u.step(this.mic, dt, null)
    else if (micOpen) u.step(u.player.playing ? u.player : null, dt, this.room.window())
    else u.step(null, dt, null)
    a.step(m === "speaking" && a.player.playing ? a.player : null, dt, null)
  }

  private advanceLoop(): void {
    const age = this.modeAge
    switch (this.mode) {
      case "idle":
        if (age >= IDLE_FOR) this.enter("listening")
        break
      case "listening":
        if (this.mic !== null) {
          if (this.user.speaking && this.user.speechFor > 0.15) this.enter("hearing")
        } else if (age >= LISTEN_FOR) this.enter("hearing")
        break
      case "hearing":
        if (this.mic !== null) {
          if (!this.user.speaking && this.user.silenceFor > 0.6) this.enter("thinking")
        } else if (this.userSide.player.done) this.enter("thinking")
        break
      case "thinking":
        if (age >= THINK_FOR) this.enter("speaking")
        break
      case "speaking":
        if (this.agentSide.player.done) {
          this.exchanges++
          this.enter(this.exchanges % 3 === 0 && this.mic === null ? "idle" : "listening")
        }
        break
    }
  }
}
