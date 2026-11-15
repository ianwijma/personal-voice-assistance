/**
 * Where the audio for a voice comes from. Every source hands the extractor the latest 40 ms of
 * samples once per frame:
 *   ClipPlayer   a rendered synth clip or a decoded file, at a playback position the driver advances
 *   MicFeed      the real microphone (getUserMedia → AnalyserNode), started from a click
 *   decodeFile   a dropped audio file → a VoiceClip (mono, phrases found by energy)
 *   Monitor      "hear it": plays what a ClipPlayer plays, through the speakers
 */
import type { VoiceClip } from "./synth.ts"

export interface Feed {
  readonly sampleRate: number
  /** The latest ~40 ms of samples (a view into a reused buffer). */
  window(): Float32Array
}

/** Plays a clip by position: a span (one phrase) or the whole clip looping. Silent when stopped. */
export class ClipPlayer implements Feed {
  clip: VoiceClip | null = null
  /** Playback position in samples. */
  pos = 0
  /** End of the span in samples, or -1 to loop the whole clip. */
  end = 0
  playing = false
  private buf = new Float32Array(640)
  private rate = 16000

  get sampleRate(): number {
    return this.rate
  }

  /** Play `clip` from `from` seconds to `to` seconds, or loop it from `from` when `to` is null. */
  play(clip: VoiceClip, from: number, to: number | null): void {
    this.clip = clip
    this.rate = clip.sampleRate
    const len = Math.round(0.04 * clip.sampleRate)
    if (this.buf.length !== len) this.buf = new Float32Array(len)
    this.pos = Math.max(0, Math.round(from * clip.sampleRate))
    this.end = to === null ? -1 : Math.min(clip.samples.length, Math.round(to * clip.sampleRate))
    this.playing = true
  }

  stop(): void {
    this.playing = false
  }

  /** True once a span has played to its end. */
  get done(): boolean {
    return !this.playing || (this.end >= 0 && this.pos >= this.end)
  }

  advance(dt: number): void {
    if (!this.playing || this.clip === null) return
    this.pos += dt * this.rate
    const n = this.clip.samples.length
    if (this.end < 0) this.pos %= n
    else if (this.pos >= this.end) this.playing = false
  }

  window(): Float32Array {
    const out = this.buf
    const clip = this.clip
    if (!this.playing || clip === null) {
      out.fill(0)
      return out
    }
    const s = clip.samples
    const n = s.length
    const len = out.length
    const at = Math.floor(this.pos)
    for (let i = 0; i < len; i++) {
      let j = at - len + i
      if (this.end < 0) j = ((j % n) + n) % n
      out[i] = j >= 0 && j < n ? s[j]! : 0
    }
    return out
  }

  /** Seconds into the clip. */
  get seconds(): number {
    return this.pos / this.rate
  }
}

/** The real microphone. `MicFeed.open()` must run from a click (permission prompt, AudioContext). */
export class MicFeed implements Feed {
  readonly sampleRate: number
  private readonly full: Float32Array<ArrayBuffer>
  private readonly view: Float32Array
  private readonly ctx: AudioContext
  private readonly analyser: AnalyserNode
  private readonly stream: MediaStream

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx
    this.stream = stream
    this.sampleRate = ctx.sampleRate
    const src = ctx.createMediaStreamSource(stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    src.connect(this.analyser)
    this.full = new Float32Array(this.analyser.fftSize)
    const len = Math.min(this.full.length, Math.round(0.04 * this.sampleRate))
    this.view = this.full.subarray(this.full.length - len)
  }

  static async open(): Promise<MicFeed> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const ctx = new AudioContext()
    await ctx.resume()
    return new MicFeed(ctx, stream)
  }

  window(): Float32Array {
    this.analyser.getFloatTimeDomainData(this.full)
    return this.view
  }

  close(): void {
    for (const t of this.stream.getTracks()) t.stop()
    void this.ctx.close()
  }
}

/** Speech spans of a clip by energy: runs above −48 dBFS, split at 350 ms of quiet. */
export const findPhrases = (samples: Float32Array, rate: number): Array<{ start: number; end: number }> => {
  const hop = Math.round(rate * 0.02)
  const out: Array<{ start: number; end: number }> = []
  let start = -1
  let quiet = 0
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let s = 0
    for (let j = i; j < i + hop; j++) s += samples[j]! * samples[j]!
    const loud = 10 * Math.log10(s / hop + 1e-12) > -48
    if (loud) {
      if (start < 0) start = i
      quiet = 0
    } else if (start >= 0 && ++quiet * 0.02 >= 0.35) {
      const end = i - (quiet - 1) * hop
      if ((end - start) / rate > 0.25) out.push({ start: start / rate, end: end / rate })
      start = -1
    }
  }
  if (start >= 0) out.push({ start: start / rate, end: samples.length / rate })
  return out.length > 0 ? out : [{ start: 0, end: samples.length / rate }]
}

/** Decode an audio file to a mono clip (at most 60 s) with its phrases. No user gesture needed. */
export const decodeFile = async (file: File): Promise<VoiceClip> => {
  const data = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const audio = await ctx.decodeAudioData(data)
  const n = Math.min(audio.length, audio.sampleRate * 60)
  const mono = new Float32Array(n)
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] = mono[i]! + ch[i]! / audio.numberOfChannels
  }
  return { samples: mono, sampleRate: audio.sampleRate, phrases: findPhrases(mono, audio.sampleRate), label: file.name }
}

/** "Hear it": mirrors one ClipPlayer through the speakers. Create from a click. */
export class Monitor {
  private readonly ctx = new AudioContext()
  private node: AudioBufferSourceNode | null = null
  private readonly buffers = new WeakMap<VoiceClip, AudioBuffer>()
  private playingClip: VoiceClip | null = null
  private playingEnd = 0
  private startedAt = 0
  private startedPos = 0

  private bufferOf(clip: VoiceClip): AudioBuffer {
    let b = this.buffers.get(clip)
    if (b === undefined) {
      b = this.ctx.createBuffer(1, clip.samples.length, clip.sampleRate)
      b.copyToChannel(new Float32Array(clip.samples), 0)
      this.buffers.set(clip, b)
    }
    return b
  }

  /** Call every frame with the player to follow (or null for silence); restarts audio when it diverges. */
  follow(player: ClipPlayer | null): void {
    const clip = player !== null && player.playing ? player.clip : null
    if (clip === null || player === null) {
      this.stopNode()
      return
    }
    const now = this.ctx.currentTime
    const expected = this.startedPos + (now - this.startedAt)
    const drift = Math.abs(((player.seconds - expected) % (clip.samples.length / clip.sampleRate)))
    if (this.node !== null && this.playingClip === clip && this.playingEnd === player.end && drift < 0.12) return
    this.stopNode()
    const node = this.ctx.createBufferSource()
    node.buffer = this.bufferOf(clip)
    node.connect(this.ctx.destination)
    const from = player.seconds
    if (player.end < 0) {
      node.loop = true
      node.start(0, from)
    } else {
      node.start(0, from, Math.max(0, player.end / clip.sampleRate - from))
    }
    this.node = node
    this.playingClip = clip
    this.playingEnd = player.end
    this.startedAt = now
    this.startedPos = from
  }

  private stopNode(): void {
    if (this.node !== null) {
      try {
        this.node.stop()
      } catch {
        // already stopped
      }
      this.node.disconnect()
      this.node = null
      this.playingClip = null
    }
  }

  close(): void {
    this.stopNode()
    void this.ctx.close()
  }
}
