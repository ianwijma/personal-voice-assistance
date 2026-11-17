// Module requirements and `pnpm start doctor` (docs/MODULES-PLAN.md §4 P1; module-definition §C.3–C.5), with a fake
// prober: nothing is run on this machine.
import { describe, expect, it } from "@effect/vitest"
import { defineModule, type Issue as HealthIssue, type Requirement } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { Effect } from "effect"
import { formatDoctor, runDoctor } from "../src/doctor.ts"
import { detectDistro, installFix, makeRequirementChecker, type ProbeOutput, type Prober, probePath, satisfiesRange, TOOL_REGISTRY } from "../src/requirements.ts"

/** A prober answering from a table, recording every call. */
const fakeProber = (answers: Readonly<Record<string, ProbeOutput>>) => {
  const calls: Array<{ readonly argv: ReadonlyArray<string>; readonly path: string; readonly timeoutMs: number }> = []
  const prober: Prober = async (argv, options) => {
    calls.push({ argv, path: options.path, timeoutMs: options.timeoutMs })
    return answers[argv[0]!] ?? { kind: "missing" }
  }
  return { prober, calls }
}

const ran = (output: string, exitCode = 0): ProbeOutput => ({ kind: "ran", exitCode, output })

describe("version ranges", () => {
  it("reads the usual comparators", () => {
    expect(satisfiesRange("6.1", ">=5")).toBe(true)
    expect(satisfiesRange("4.4.2", ">=5")).toBe(false)
    expect(satisfiesRange("0.35.1", ">=0.35 <1")).toBe(true)
    expect(satisfiesRange("1.0", ">=0.35 <1")).toBe(false)
    expect(satisfiesRange("6.2", "^6")).toBe(true)
    expect(satisfiesRange("7.0", "^6")).toBe(false)
    expect(satisfiesRange("6.1.3", "~6.1")).toBe(true)
    expect(satisfiesRange("6.2", "~6.1")).toBe(false)
    expect(satisfiesRange("2025.01.15", ">=2024.1")).toBe(true)
    expect(satisfiesRange("6.1", "6.1")).toBe(true)
    expect(satisfiesRange("6.1.4", "6.1")).toBe(true)
    expect(satisfiesRange("6.1", "about six")).toBeUndefined()
  })
})

describe("the requirement checker", () => {
  it.effect("probes each program once, concurrently, without a shell, on the fixed path with 5 s, and judges from the cache", () =>
    Effect.gen(function*() {
      const { calls, prober } = fakeProber({
        ffmpeg: ran("ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023"),
        mpv: ran("mpv 0.34.1 Copyright © 2000-2021"),
        sox: { kind: "timeout" }
      })
      const checker = makeRequirementChecker({ dataDir: "/srv/pva/data", prober, distro: "debian", memoryMb: () => 2048, freeDiskMb: () => 500 })
      const requirements: ReadonlyArray<Requirement> = [
        { tool: "ffmpeg", version: ">=5", why: "Converts audio" },
        { tool: "mpv", version: ">=0.35", why: "Plays streams" },
        { tool: "yt-dlp", why: "Resolves stream URLs" },
        { tool: "sox", why: "Mixes" },
        { tool: "mpv", where: "playback-device", why: "Plays on the device" },
        { network: "internet" },
        { memoryMb: 4096 },
        { diskMb: 100 }
      ]
      yield* checker.probe(requirements)
      yield* checker.probe(requirements)
      expect(calls.map((c) => c.argv.join(" ")).sort()).toEqual(["ffmpeg -version", "mpv --version", "sox --version", "yt-dlp --version"])
      expect(calls.every((c) => c.timeoutMs === 5_000 && c.path === probePath("/srv/pva/data"))).toBe(true)
      expect(probePath("/srv/pva/data").split(":")[0]).toBe("/srv/pva/data/tools/bin")
      const statuses = checker.check(requirements)
      expect(statuses.map((s) => [s.state, s.detail])).toEqual([
        ["met", "ffmpeg 6.1.1"],
        ["missing", "mpv 0.34.1 does not match >=0.35"],
        ["missing", "yt-dlp is missing"],
        ["missing", "sox did not answer within 5 s"],
        ["unchecked", "mpv on the device (not checked yet)"],
        ["unchecked", "internet access (not checked)"],
        ["missing", "Needs 4096 MB of memory; this server has 2048 MB"],
        ["met", "500 MB free"]
      ])
      expect(statuses[2]!.fix).toEqual({ kind: "command", label: "Install yt-dlp", value: "sudo apt install yt-dlp" })
      expect(statuses[1]!.fix?.label).toBe("Update mpv")

      // "Check again" probes again; a spawn that failed with ENOENT marks the program missing at once.
      yield* checker.probe(requirements, { force: true })
      expect(calls.length).toBe(8)
      checker.markMissing("ffmpeg")
      expect(checker.check([requirements[0]!])[0]!.state).toBe("missing")
    }))

  it("fixes per distribution, and the os-release families", () => {
    expect(installFix("ffmpeg", TOOL_REGISTRY.ffmpeg, "arch").value).toBe("sudo pacman -S ffmpeg")
    expect(installFix("ffmpeg", TOOL_REGISTRY.ffmpeg, "nix").value).toMatch(/^nix-env -iA nixos\.ffmpeg/)
    expect(installFix("ffmpeg", TOOL_REGISTRY.ffmpeg, undefined).value).toMatch(/Debian\/Ubuntu: sudo apt install ffmpeg · Arch: sudo pacman -S ffmpeg/)
    expect(detectDistro("ID=ubuntu\nID_LIKE=debian\n")).toBe("debian")
    expect(detectDistro('ID="manjaro"\n')).toBe("arch")
    expect(detectDistro("ID=nixos\n")).toBe("nix")
    expect(detectDistro("ID=fedora\n")).toBeUndefined()
  })
})

const music = defineModule({
  id: "music",
  name: "Music",
  description: "Plays music",
  requires: [{ tool: "yt-dlp", why: "Resolves stream URLs" }],
  start: () => Effect.succeed({})
})
const weather = defineModule({
  id: "weather",
  name: "Weather",
  description: "Forecasts",
  health: () => Effect.succeed<ReadonlyArray<HealthIssue>>([{ id: "quota", severity: "info", title: "Forecast quota at 80 %", detail: "" }]),
  start: () => Effect.succeed({})
})

const quietCore = {
  freeMb: () => 50_000,
  portFree: async () => "free" as const,
  clockSynced: async () => false,
  readable: () => true,
  checkStt: () => undefined,
  nodeVersion: "22.20.0"
}

const assistantWith = (modules: Assistant["modules"]): Assistant => ({ id: "jeff", name: "Jeff", on: true, modules, voice: { provider: "cartesia", voiceId: "x" } } as unknown as Assistant)

describe("doctor", () => {
  it.effect("prints one line per issue with its fix, and exits 1 on an error", () =>
    Effect.gen(function*() {
      const { prober } = fakeProber({ tar: ran("tar (GNU tar) 1.35"), bzip2: ran("bzip2, a block-sorting file compressor.  Version 1.0.8, 13-Jul-2019."), nice: ran("nice (GNU coreutils) 9.4") })
      const issues = yield* runDoctor({
        catalog: [music, weather],
        env: {},
        dataDir: "/nonexistent/pva-data",
        modelDirs: { stt: "/nonexistent/stt", tts: "/nonexistent/tts" },
        assistants: [assistantWith({ music: { on: true, offTools: [] } })],
        vault: { state: "locked", path: "/home/owner/.config/pva/vault.enc" },
        prober,
        core: quietCore
      })
      const { exitCode, lines } = formatDoctor(issues)
      expect(exitCode).toBe(1)
      expect(lines.some((l) => l.startsWith("error   core: flock is missing. serve mode takes the data directory's writer lock with it; without it the server refuses to start. → Install flock: "))).toBe(true)
      expect(lines.some((l) => l.startsWith("error   music: yt-dlp is missing. Music needs it: Resolves stream URLs. → Install yt-dlp: "))).toBe(true)
      expect(lines).toContain("warning core: The clock is not synchronised. Times, timers and reminders may be off. → Turn on time synchronisation: sudo timedatectl set-ntp true")
      expect(lines).toContain("info    core: The key vault is locked. Modules and engines that need a key do not run until it is unlocked (or PVA_VAULT_PASSWORD is set). → Unlock it: #settings/keys/access")
      expect(lines).toContain("info    weather: Forecast quota at 80 %.")
      expect(lines.at(-1)).toBe("2 errors, 1 warning, 2 notes.")
    }))

  it.effect("a module no assistant has on is only a warning, and a clean machine exits 0", () =>
    Effect.gen(function*() {
      const all = fakeProber({ flock: ran("flock from util-linux 2.39.3"), tar: ran("tar (GNU tar) 1.35"), bzip2: ran("Version 1.0.8"), nice: ran("nice (GNU coreutils) 9.4") })
      const unused = yield* runDoctor({
        catalog: [music],
        env: {},
        dataDir: "/nonexistent/pva-data",
        modelDirs: { stt: "/nonexistent/stt", tts: "/nonexistent/tts" },
        assistants: [assistantWith({})],
        prober: all.prober,
        core: { ...quietCore, clockSynced: async () => true }
      })
      const report = formatDoctor(unused)
      expect(report.lines).toEqual([
        expect.stringMatching(/^warning music: yt-dlp is missing\. Music needs it: Resolves stream URLs\. \(No assistant has it on\.\) → Install yt-dlp: /),
        "0 errors, 1 warning, 0 notes."
      ])
      expect(report.exitCode).toBe(0)
      expect(formatDoctor([])).toEqual({ lines: ["No problems found."], exitCode: 0 })
    }))
})
