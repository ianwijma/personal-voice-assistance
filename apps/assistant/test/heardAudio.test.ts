import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { levelStats } from "../src/levels.ts"
import { makeHeardAudio } from "../src/serve/HeardAudio.ts"

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

const setup = (maxFiles = 50) => {
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
    now: () => now
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
