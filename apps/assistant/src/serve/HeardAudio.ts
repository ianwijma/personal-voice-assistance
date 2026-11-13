import type { SttEvent } from "@pva/core"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
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
 *
 * Disk writes are asynchronous and one recording is written at a time: a disk that blocks (a stalled network
 * mount, a full device retrying) neither freezes the server nor piles recordings up in memory. A recording that
 * finishes while the previous one is still being written is skipped, counted and logged.
 *
 * Shutdown (`close`, run by the server before it releases the data directory's lock): no new recording is
 * accepted, a save not yet begun never begins, and a save in progress stops before its next file operation; `close`
 * waits for the operation already running to settle (at most `closeTimeoutMs`, for a disk that does not answer).
 * Every operation is also skipped once `writable()` says the directory is no longer this server's. And each save,
 * from its first file operation until its last has settled, is registered with the lock's release gate (`begin`,
 * see DataDirLock): an operation still running when `close` gives up keeps the lock held until it settles, so
 * nothing can be written or rotated in a directory another server owns.
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
  /**
   * Runs the saving of a finished recording (statistics, files, rotation, log). Default `setImmediate`: the
   * `EndOfTurn` that finishes a recording is on its way to the conversation, so the disk work comes after it.
   */
  readonly defer?: (task: () => void) => void
  /** File operations (tests: synchronous ones, or ones that never finish). Default `node:fs/promises`. */
  readonly io?: HeardAudioIo
  /** Whether this server may still write the directory (the data directory lock is held). Default: always. */
  readonly writable?: () => boolean
  /** How long `close` waits for a file operation in progress. Default 5000 ms. */
  readonly closeTimeoutMs?: number
  /**
   * Registers a save with the data directory lock's release gate (`DataDirLock.begin`): returns the function that
   * ends the registration, or `undefined` when the save must not start. Default: no gate.
   */
  readonly begin?: (what: string) => (() => void) | undefined
}

/** Each operation may finish synchronously (returns a plain value) or asynchronously (returns a promise). */
export interface HeardAudioIo {
  readonly mkdir: (dir: string) => unknown
  readonly writeFile: (path: string, data: Uint8Array | string) => unknown
  readonly readdir: (dir: string) => ReadonlyArray<string> | Promise<ReadonlyArray<string>>
  readonly rm: (path: string) => unknown
}

const defaultIo: HeardAudioIo = {
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  writeFile: (path, data) => writeFile(path, data),
  readdir: (dir) => readdir(dir),
  rm: (path) => rm(path, { force: true })
}

/** A save stopped because the recorder closed or the directory is no longer this server's. */
class Stopped extends Error {}

/**
 * Runs `steps` in order, waiting for the ones that return a promise; synchronous all the way when none does.
 * Before each step `go()` is asked; when it says no, the rest are not run (`onError` with `Stopped`).
 */
const sequence = (steps: ReadonlyArray<() => unknown>, go: () => boolean, onDone: () => void, onError: (error: unknown) => void) => {
  const next = (from: number): void => {
    for (let i = from; i < steps.length; i++) {
      if (!go()) return onError(new Stopped())
      let result: unknown
      try {
        result = steps[i]!()
      } catch (error) {
        return onError(error)
      }
      if (result instanceof Promise) {
        result.then(() => next(i + 1), onError)
        return
      }
    }
    onDone()
  }
  next(0)
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
  /** Recordings skipped because the previous one was still being written. */
  readonly skipped: () => number
  /** Stops recording and waits for the file operation in progress (see the shutdown note above). */
  readonly close: () => Promise<void>
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
  const io = options.io ?? defaultIo
  /** A recording is being written (at most one at a time). */
  let writing = false
  let skipped = 0
  let closed = false
  /** Settles when the save in progress (deferred or running) has ended. */
  let inflight: Promise<void> | undefined
  let settle: () => void = () => {}
  /** A save was deferred and has not begun. */
  let deferred = false
  const mayWrite = () => !closed && (options.writable?.() ?? true)

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

  /** Removes all but the newest `maxFiles` recordings; a promise only when the file operations are asynchronous. */
  const rotate = (): unknown => {
    const keep = Math.max(1, options.maxFiles())
    const removeOld = (all: ReadonlyArray<string>) => {
      const names = all.filter((n) => n.endsWith(".wav")).sort()
      const pending: Array<Promise<unknown>> = []
      for (const name of names.slice(0, Math.max(0, names.length - keep))) {
        for (const path of [join(options.dir, name), join(options.dir, name.replace(/\.wav$/, ".json"))]) {
          // The listing may have taken a while (a slow disk): nothing is removed once the directory is not ours.
          if (!mayWrite()) return pending.length > 0 ? Promise.allSettled(pending) : undefined
          const result = io.rm(path)
          if (result instanceof Promise) pending.push(result)
        }
      }
      // Settled, not just resolved: the save ends (and leaves the lock's gate) only once every removal has ended.
      return pending.length > 0 ? Promise.allSettled(pending) : undefined
    }
    const names = io.readdir(options.dir)
    return names instanceof Promise ? names.then(removeOld) : removeOld(names)
  }

  const defer = options.defer ?? ((task: () => void) => void setImmediate(task))

  const finish = (transcript: string, reason: string) => {
    const r = recording
    recording = undefined
    if (r === undefined || r.bytes < 2) return
    if (writing) {
      skipped++
      if (skipped === 1 || skipped % 10 === 0) {
        options.log(`Skipped a heard-audio recording (${skipped} so far): the previous one is still being written to ${options.dir}`)
      }
      return
    }
    writing = true
    inflight = new Promise<void>((resolve) => {
      settle = resolve
    })
    deferred = true
    defer(() => save(r, transcript, reason))
  }

  /** Ends the save's registration with the lock's release gate, once its last file operation has settled. */
  let unregister: (() => void) | undefined
  const ended = () => {
    unregister?.()
    unregister = undefined
    writing = false
    settle()
  }

  const save = (r: NonNullable<typeof recording>, transcript: string, reason: string) => {
    deferred = false
    if (!mayWrite()) return ended() // closed before the deferred save began
    if (options.begin !== undefined) {
      unregister = options.begin(`saving a heard-audio recording in ${options.dir}`)
      if (unregister === undefined) return ended() // the lock is being released
    }
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
    const onError = (error: unknown) => {
      ended()
      if (error instanceof Stopped) return options.log(`A heard-audio recording was not finished: the server is stopping (${wav})`)
      options.log(`Could not save the heard audio: ${error instanceof Error ? error.message : String(error)}`)
    }
    let steps: Array<() => unknown>
    try {
      const body = JSON.stringify(
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
      steps = [() => io.mkdir(options.dir), () => io.writeFile(wav, wavBytes(pcm, RATE)), () => io.writeFile(json, body), () => rotateQuietly()]
    } catch (error) {
      return onError(error)
    }
    sequence(steps, mayWrite, () => {
      ended()
      done(wav, json, transcript, stats, transport)
    }, onError)
  }

  /** Rotation failing (a file removed meanwhile) does not fail the save. */
  const rotateQuietly = () => {
    try {
      const result = rotate()
      return result instanceof Promise ? result.catch(() => {}) : result
    } catch {
      return undefined
    }
  }

  const done = (wav: string, json: string, transcript: string, stats: LevelStats, transport: Readonly<Record<string, number>> | undefined) => {
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
      if (closed) return
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
      if (closed || !options.enabled()) return
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
    saved: () => saved,
    skipped: () => skipped,
    close: async () => {
      closed = true
      recording = undefined
      if (deferred) ended() // it will not begin (see `save`)
      if (!writing || inflight === undefined) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        inflight.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), options.closeTimeoutMs ?? 5_000)
        })
      ])
      clearTimeout(timer)
      if (timedOut) {
        options.log(`A heard-audio recording is still being written to ${options.dir} (the disk does not answer); nothing more of it will be written`)
      }
    }
  }
}
