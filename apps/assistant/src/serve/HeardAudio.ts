import type { SttEvent } from "@pva/core"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formatLevelStats, levelStats, type LevelStats, wavBytes } from "../levels.ts"

/**
 * "What does the assistant hear": while switched on (the `RECORD_HEARD_AUDIO`
 * setting, live), every turn's audio as the recogniser received it (before the
 * recogniser's own gain control) is saved as `<dataDir>/recordings/<time>.wav`
 * with a `.json` beside it (transcript, model, level statistics, transport
 * counters), and one line is logged per turn. `pnpm start compare-models
 * <file>` then runs every installed model on it (README, "Is it the audio or
 * the model?").
 *
 * A recording starts at `SpeechStarted` with the 1.5 s before it and ends at
 * `EndOfTurn` (which comes after the end-of-turn silence), at 30 s, or 5 s
 * after the last recogniser event for a turn that never got words. Only the
 * newest `maxFiles` recordings are kept. Pure bookkeeping on the audio the
 * engine already receives: no effect on the recognition itself.
 */

export interface HeardAudioOptions {
  readonly dir: string
  readonly enabled: () => boolean
  readonly maxFiles: () => number
  /** The recogniser in use, e.g. "sherpa parakeet-v2". */
  readonly model: () => string
  /** Transport counters since the previous call (WebAudio.inputStats). */
  readonly transport?: () => Readonly<Record<string, number>>
  readonly log: (line: string) => void
  /** Default `Date.now`. */
  readonly now?: () => number
}

export interface HeardRecording {
  readonly wav: string
  readonly json: string
  readonly transcript: string
  readonly stats: LevelStats
}

export interface HeardAudio {
  /** Every chunk of audio the recogniser receives (16 kHz s16le). */
  readonly audio: (chunk: Uint8Array) => void
  /** Every event the recogniser emits (before the echo gate). */
  readonly event: (event: SttEvent) => void
  /** The recordings saved so far by this instance (newest last). */
  readonly saved: () => ReadonlyArray<HeardRecording>
}

const RATE = 16_000
const BYTES_PER_MS = 32
const PREROLL_MS = 1_500
const MAX_MS = 30_000
const IDLE_MS = 5_000

export const makeHeardAudio = (options: HeardAudioOptions): HeardAudio => {
  const now = options.now ?? Date.now
  const preroll = new Uint8Array(PREROLL_MS * BYTES_PER_MS)
  let prerollFill = 0
  let prerollPos = 0
  let recording: { chunks: Array<Uint8Array>; bytes: number; startedAt: number; lastEventAt: number; eager: Array<string>; interim: string } | undefined
  const saved: Array<HeardRecording> = []
  let counter = 0

  const pushPreroll = (chunk: Uint8Array) => {
    for (let offset = 0; offset < chunk.length;) {
      const n = Math.min(chunk.length - offset, preroll.length - prerollPos)
      preroll.set(chunk.subarray(offset, offset + n), prerollPos)
      prerollPos = (prerollPos + n) % preroll.length
      prerollFill = Math.min(preroll.length, prerollFill + n)
      offset += n
    }
  }

  const prerollBytes = () => {
    const out = new Uint8Array(prerollFill)
    const start = (prerollPos - prerollFill + preroll.length) % preroll.length
    const first = Math.min(prerollFill, preroll.length - start)
    out.set(preroll.subarray(start, start + first), 0)
    out.set(preroll.subarray(0, prerollFill - first), first)
    return out
  }

  const rotate = () => {
    const keep = Math.max(1, options.maxFiles())
    let names: Array<string>
    try {
      names = readdirSync(options.dir).filter((n) => n.endsWith(".wav")).sort()
    } catch {
      return
    }
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      rmSync(join(options.dir, name), { force: true })
      rmSync(join(options.dir, name.replace(/\.wav$/, ".json")), { force: true })
    }
  }

  const finish = (transcript: string, reason: string) => {
    const r = recording
    recording = undefined
    if (r === undefined || r.bytes < 2) return
    const bytes = new Uint8Array(r.bytes - (r.bytes % 2))
    let offset = 0
    for (const chunk of r.chunks) {
      const n = Math.min(chunk.length, bytes.length - offset)
      bytes.set(chunk.subarray(0, n), offset)
      offset += n
    }
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length / 2)
    const stats = levelStats(pcm)
    const stamp = new Date(r.startedAt).toISOString().replace(/[:.]/g, "-")
    const base = `${stamp}-${String(++counter).padStart(3, "0")}`
    const wav = join(options.dir, `${base}.wav`)
    const json = join(options.dir, `${base}.json`)
    const transport = options.transport?.()
    try {
      mkdirSync(options.dir, { recursive: true })
      writeFileSync(wav, wavBytes(pcm, RATE))
      writeFileSync(
        json,
        JSON.stringify(
          {
            startedAt: new Date(r.startedAt).toISOString(),
            model: options.model(),
            transcript,
            speculative: r.eager,
            lastInterim: r.interim,
            ended: reason,
            stats,
            transport: transport ?? {}
          },
          null,
          1
        )
      )
      rotate()
    } catch (error) {
      options.log(`Could not save the heard audio: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    saved.push({ wav, json, transcript, stats })
    if (saved.length > 100) saved.shift()
    const problems = transport === undefined
      ? ""
      : Object.entries(transport).filter(([key, v]) => v > 0 && key !== "micFrames" && key !== "maxMicGapMs").map(([k, v]) => `${k} ${v}`).join(", ")
    options.log(
      `Heard (${options.model()}): "${transcript || "(no words recognised)"}" — ${formatLevelStats(stats)}` +
        (transport?.maxMicGapMs !== undefined && transport.maxMicGapMs > 200 ? `; mic frames paused up to ${Math.round(transport.maxMicGapMs)} ms` : "") +
        (problems ? `; ${problems}` : "") + ` — ${wav}`
    )
  }

  return {
    audio: (chunk) => {
      if (!options.enabled()) {
        if (recording !== undefined) recording = undefined
        prerollFill = 0
        return
      }
      if (recording === undefined) {
        pushPreroll(chunk)
        return
      }
      recording.chunks.push(chunk.slice())
      recording.bytes += chunk.length
      const at = now()
      if (recording.bytes >= MAX_MS * BYTES_PER_MS) finish(recording.eager.at(-1) ?? recording.interim, "30 s limit")
      else if (at - recording.lastEventAt > IDLE_MS) finish(recording.eager.at(-1) ?? "", "no end of turn")
    },
    event: (event) => {
      if (!options.enabled()) return
      const at = now()
      if (event._tag === "SpeechStarted") {
        if (recording !== undefined) return void (recording.lastEventAt = at)
        const head = prerollBytes()
        recording = { chunks: [head], bytes: head.length, startedAt: at - head.length / BYTES_PER_MS, lastEventAt: at, eager: [], interim: "" }
        prerollFill = 0
        return
      }
      if (recording === undefined) return
      recording.lastEventAt = at
      if (event._tag === "Interim") recording.interim = event.text
      else if (event._tag === "EagerEndOfTurn") recording.eager.push(event.text)
      else if (event._tag === "EndOfTurn") finish(event.text, "end of turn")
    },
    saved: () => saved
  }
}
