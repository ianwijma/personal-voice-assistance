import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { levelStats } from "../src/levels.ts"
import { type HeardAudioIo, makeHeardAudio } from "../src/serve/HeardAudio.ts"

/** Synchronous file operations, so a test sees the files as soon as a recording finishes. */
const syncIo: HeardAudioIo = {
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  writeFile: (path, data) => writeFileSync(path, data),
  readdir: (dir) => readdirSync(dir),
  rm: (path) => rmSync(path, { force: true })
}

/** 20 ms of a tone at `peakDbfs` (or quiet noise when undefined). */
const chunk = (peakDbfs: number | undefined, n0 = 0) => {
  const s = new Int16Array(320)
  for (let i = 0; i < s.length; i++) {
    s[i] = peakDbfs === undefined
      ? ((i * 7919) % 21) - 10
      : Math.round(32767 * 10 ** (peakDbfs / 20) * Math.sin(2 * Math.PI * 300 * (n0 + i) / 16000))
  }
  return new Uint8Array(s.buffer)
}

const setup = (maxFiles = 50, device?: { readonly key: string; readonly name: string }) => {
  const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
  let now = 1_000_000
  const lines: Array<string> = []
  let enabled = true
  const heard = makeHeardAudio({
    dir,
    enabled: () => enabled,
    maxFiles: () => maxFiles,
    model: () => "sherpa parakeet-v2",
    transport: () => ({ micFrames: 100, droppedFrames: 0, noiseFrames: 0, unroutedMicFrames: 0, maxMicGapMs: 40 }),
    log: (line) => lines.push(line),
    now: () => now,
    defer: (task) => task(),
    io: syncIo,
    ...(device !== undefined ? { device: () => device } : {})
  })
  const audio = (ms: number, peak: number | undefined) => {
    for (let t = 0; t < ms; t += 20) {
      heard.audio(chunk(peak, t * 16))
      now += 20
    }
  }
  return { dir, heard, audio, lines, setEnabled: (v: boolean) => (enabled = v), files: () => (existsSync(dir) ? readdirSync(dir).sort() : []) }
}

describe("heard audio recorder", () => {
  it("saves a turn from 1.5 s before SpeechStarted to EndOfTurn, with level statistics and the transcript", () => {
    const t = setup()
    t.audio(3000, undefined)
    t.heard.event({ _tag: "SpeechStarted" })
    t.audio(1000, -30)
    t.heard.event({ _tag: "EagerEndOfTurn", text: "Hello there." })
    t.audio(600, undefined)
    t.heard.event({ _tag: "EndOfTurn", text: "Hello there." })
    const files = t.files()
    expect(files).toHaveLength(2)
    const meta = JSON.parse(readFileSync(join(t.dir, files.find((f) => f.endsWith(".json"))!), "utf8"))
    expect(meta).toMatchObject({ model: "sherpa parakeet-v2", transcript: "Hello there.", speculative: ["Hello there."], ended: "end of turn" })
    expect(meta.stats.seconds).toBeCloseTo(1.5 + 1.6, 1)
    expect(meta.stats.peakDbfs).toBeCloseTo(-30, 0)
    expect(meta.stats.verdict).toContain("quiet (peak below -18 dBFS)")
    const wav = readFileSync(join(t.dir, files.find((f) => f.endsWith(".wav"))!))
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF")
    expect(wav.length).toBe(44 + 3.1 * 16000 * 2)
    expect(t.lines[0]).toMatch(/^Heard \(sherpa parakeet-v2\): "Hello there\." — peak -30/)
  })

  it("ends a turn that never got words 5 s after the last event, and caps a turn at 30 s", () => {
    const t = setup()
    t.heard.event({ _tag: "SpeechStarted" })
    t.audio(6000, -20)
    expect(t.lines[0]).toContain("(no words recognised)")
    t.heard.event({ _tag: "SpeechStarted" })
    for (let k = 0; k < 8; k++) {
      t.audio(4000, -20)
      t.heard.event({ _tag: "Interim", text: `word ${k}` })
    }
    expect(t.lines[1]).toContain("word 6") // the 30 s were reached during the eighth stretch
    const meta = JSON.parse(readFileSync(join(t.dir, t.files().filter((f) => f.endsWith(".json"))[1]!), "utf8"))
    expect(meta.ended).toBe("30 s limit")
    expect(meta.stats.seconds).toBeCloseTo(30, 0)
  })

  it("a voice session's recorder names the device in the file name, the .json and the log line", () => {
    const t = setup(50, { key: "dev-1", name: "Kitchen tablet" })
    t.heard.event({ _tag: "SpeechStarted" })
    t.audio(200, -10)
    t.heard.event({ _tag: "EndOfTurn", text: "hello" })
    const files = t.files()
    expect(files.every((f) => /-kitchen-tablet-001\.(wav|json)$/.test(f))).toBe(true)
    const meta = JSON.parse(readFileSync(join(t.dir, files.find((f) => f.endsWith(".json"))!), "utf8"))
    expect(meta.device).toEqual({ key: "dev-1", name: "Kitchen tablet" })
    expect(t.lines[0]).toMatch(/^Heard on Kitchen tablet \(sherpa parakeet-v2\): "hello"/)
  })

  it("keeps only the newest recordings, and records nothing while switched off", () => {
    const t = setup(2)
    for (let k = 0; k < 4; k++) {
      t.heard.event({ _tag: "SpeechStarted" })
      t.audio(200, -10)
      t.heard.event({ _tag: "EndOfTurn", text: `turn ${k}` })
    }
    expect(t.files()).toHaveLength(4) // two pairs
    expect(readFileSync(join(t.dir, t.files().find((f) => f.endsWith(".json"))!), "utf8")).toContain("turn 2")
    t.setEnabled(false)
    t.heard.event({ _tag: "SpeechStarted" })
    t.audio(200, -10)
    t.heard.event({ _tag: "EndOfTurn", text: "off" })
    expect(t.files()).toHaveLength(4)
  })
})

describe("heard audio recorder, off the event path", () => {
  it("by default the files are written after the EndOfTurn event has been passed on, not while it is handled", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
    const heard = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 5, model: () => "m", log: () => {} })
    heard.event({ _tag: "SpeechStarted" })
    for (let t = 0; t < 400; t += 20) heard.audio(chunk(-20, t * 16))
    heard.event({ _tag: "EndOfTurn", text: "hi" })
    expect(existsSync(dir)).toBe(false)
    // Asynchronous writes by default: wait for them.
    for (let i = 0; i < 100 && (!existsSync(dir) || readdirSync(dir).length < 2); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(readdirSync(dir)).toHaveLength(2)
  })
})

describe("heard audio recorder, a disk that blocks", () => {
  it("writes one recording at a time: while a write never finishes, later recordings are skipped, not held", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
    const lines: Array<string> = []
    const writes: Array<number> = []
    const stuck: HeardAudioIo = {
      mkdir: () => undefined,
      writeFile: (_path, data) => {
        writes.push(data.length)
        return new Promise(() => {}) // never finishes
      },
      readdir: () => [],
      rm: () => undefined
    }
    const heard = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 5, model: () => "m", log: (l) => lines.push(l), defer: (task) => task(), io: stuck })
    for (let turn = 0; turn < 20; turn++) {
      heard.event({ _tag: "SpeechStarted" })
      for (let t = 0; t < 2_000; t += 20) heard.audio(chunk(-20, t * 16))
      heard.event({ _tag: "EndOfTurn", text: `turn ${turn}` })
    }
    await new Promise((resolve) => setImmediate(resolve))
    expect(writes).toHaveLength(1)
    expect(heard.skipped()).toBe(19)
    expect(lines.some((l) => l.includes("still being written"))).toBe(true)
  })

  it("after a failed write the next recording is written again", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
    let fail = true
    const io: HeardAudioIo = { ...syncIo, writeFile: (path, data) => (fail ? Promise.reject(new Error("EIO")) : syncIo.writeFile(path, data)) }
    const lines: Array<string> = []
    const heard = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 5, model: () => "m", log: (l) => lines.push(l), defer: (task) => task(), io })
    const turn = () => {
      heard.event({ _tag: "SpeechStarted" })
      for (let t = 0; t < 400; t += 20) heard.audio(chunk(-20, t * 16))
      heard.event({ _tag: "EndOfTurn", text: "hi" })
    }
    turn()
    await new Promise((resolve) => setImmediate(resolve))
    expect(lines.some((l) => l.includes("EIO"))).toBe(true)
    fail = false
    turn()
    expect(heard.saved()).toHaveLength(1)
  })
})

describe("heard audio recorder, shutdown and the directory lock", () => {
  /** File operations whose writes wait until released, recording every call. */
  const gatedIo = () => {
    const calls: Array<string> = []
    const gates: Array<() => void> = []
    const io: HeardAudioIo = {
      mkdir: (dir) => void calls.push(`mkdir ${dir}`),
      writeFile: (path) => {
        calls.push(`write ${path.slice(-5)}`)
        return new Promise<void>((resolve) => gates.push(resolve))
      },
      readdir: () => {
        calls.push("readdir")
        return Array.from({ length: 10 }, (_, i) => `2026-01-0${i}.wav`)
      },
      rm: (path) => void calls.push(`rm ${path}`)
    }
    return { io, calls, release: () => gates.shift()?.() }
  }
  const record = (heard: ReturnType<typeof makeHeardAudio>) => {
    heard.event({ _tag: "SpeechStarted" })
    for (let t = 0; t < 400; t += 20) heard.audio(chunk(-20, t * 16))
    heard.event({ _tag: "EndOfTurn", text: "hi" })
  }

  it("a write blocked when the server stops: close waits (bounded), and once the lock is gone nothing more is written or rotated", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
    const { io, calls, release } = gatedIo()
    let held = true
    const lines: Array<string> = []
    const heard = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 2, model: () => "m", log: (l) => lines.push(l), defer: (task) => task(), io, writable: () => held, closeTimeoutMs: 50 })
    record(heard)
    expect(calls.at(-1)).toMatch(/^write .*\.wav$/)
    const started = Date.now()
    await heard.close()
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    expect(lines.some((l) => l.includes("still being written"))).toBe(true)
    held = false // the lock is released; another server takes the directory
    release() // ... and the old write finally returns
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls.filter((c) => c.startsWith("rm") || c === "readdir" || c.endsWith(".json"))).toEqual([])
    expect(heard.saved()).toHaveLength(0)
    // And nothing new is recorded after close.
    record(heard)
    expect(calls.filter((c) => c.startsWith("write"))).toHaveLength(1)
  })

  it("the lock lost while a save waits (no close): the remaining steps never run (the reviewer's case)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
    const { io, calls, release } = gatedIo()
    let held = true
    const heard = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 2, model: () => "m", log: () => {}, defer: (task) => task(), io, writable: () => held })
    record(heard)
    held = false
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls.filter((c) => c.startsWith("rm") || c.endsWith(".json"))).toEqual([])
  })

  it("close settles once the operation in progress does, and a deferred save that has not begun never begins", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pva-heard-")), "recordings")
    const { io, calls, release } = gatedIo()
    const heard = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 2, model: () => "m", log: () => {}, defer: (task) => task(), io })
    record(heard)
    const closing = heard.close()
    setTimeout(release, 20)
    await closing
    expect(calls.filter((c) => c.startsWith("write"))).toHaveLength(1)
    const queued: Array<() => void> = []
    const later = makeHeardAudio({ dir, enabled: () => true, maxFiles: () => 2, model: () => "m", log: () => {}, defer: (task) => void queued.push(task), io })
    const before = calls.length
    record(later)
    await later.close() // the save was deferred, not begun
    for (const task of queued) task()
    expect(calls.length).toBe(before)
  })
})

describe("level statistics", () => {
  it("flags quiet, narrowband and clipped audio", () => {
    // 2 s: 0.5 s of quiet noise, then a 1 kHz tone (narrowband) at -35 dBFS.
    const pcm = new Int16Array(32000)
    for (let i = 0; i < pcm.length; i++) pcm[i] = i < 8000 ? ((i * 7919) % 5) - 2 : Math.round(32767 * 10 ** (-35 / 20) * Math.sin(2 * Math.PI * 1000 * i / 16000))
    const quiet = levelStats(pcm)
    expect(quiet.peakDbfs).toBeCloseTo(-35, 0)
    expect(quiet.verdict.join(" ")).toContain("too quiet")
    expect(quiet.verdict.join(" ")).toContain("narrowband")
    expect(quiet.rolloff99Hz).toBeLessThan(1500)
    const loud = Int16Array.from(pcm, (v, i) => (i < 8000 ? v : Math.max(-32768, Math.min(32767, v * 200))))
    expect(levelStats(loud).verdict).toContain("clipping")
  })
})
