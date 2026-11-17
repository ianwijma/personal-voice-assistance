// Module requirements and `pnpm start doctor` (docs/MODULES-PLAN.md §4 P1; module-definition §C.3–C.5), with a fake
// prober: nothing is run on this machine.
import { describe, expect, it } from "@effect/vitest"
import { defineModule, type Issue as HealthIssue, isMissingProgramError, makeModuleHost, makeTool, type ModuleHostApi, readOnlyPersistence, type Requirement } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { formatDoctor, runDoctor } from "../src/doctor.ts"
import { detectDistro, installFix, makeRequirementChecker, parseVersion, type ProbeOutput, type Prober, probePath, satisfiesRange, TOOL_REGISTRY } from "../src/requirements.ts"

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

  // Review round 1, finding 12: real semver, and an unprovable requirement is never met.
  it("is semver: OR ranges, zero-major carets, prereleases, and nothing to read is not a pass", () => {
    expect(satisfiesRange("3.2", ">=5 || ^4")).toBe(false)
    expect(satisfiesRange("4.7", ">=5 || ^4")).toBe(true)
    expect(satisfiesRange("6.0", ">=5 || ^4")).toBe(true)
    expect(satisfiesRange("0.99.0", "^0.35")).toBe(false)
    expect(satisfiesRange("0.35.4", "^0.35")).toBe(true)
    expect(satisfiesRange("0.36.0", "^0.35")).toBe(false)
    expect(satisfiesRange("7.0.0-rc.1", ">=6")).toBe(false)
    expect(satisfiesRange("7.0.0-rc.2", ">=7.0.0-rc.1")).toBe(true)
    expect(satisfiesRange("unknown", ">=5")).toBeUndefined()
  })
})

describe("version requirements fail closed (finding 12)", () => {
  const judge = (output: ProbeOutput, version: string) =>
    Effect.gen(function*() {
      const { prober } = fakeProber({ mpv: output })
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian" })
      const requirement: Requirement = { tool: "mpv", version, why: "Plays" }
      yield* checker.probe([requirement])
      return checker.check([requirement])[0]!
    })

  it.effect("a version that is not reported, a range that cannot be read, and an OR range are judged, never assumed", () =>
    Effect.gen(function*() {
      const silent = yield* judge(ran("usage: mpv [options]"), ">=0.35")
      expect(silent.state).toBe("missing")
      expect(silent.detail).toBe("mpv did not report its version; needs >=0.35")
      const unreadable = yield* judge(ran("mpv 0.36.0"), "about six")
      expect(unreadable.state).toBe("missing")
      expect(unreadable.detail).toMatch(/cannot be read/)
      expect((yield* judge(ran("mpv 3.0.1"), ">=5 || ^4")).state).toBe("missing")
      expect((yield* judge(ran("mpv 4.2.0"), ">=5 || ^4")).state).toBe("met")
      expect((yield* judge(ran("mpv 0.99.0"), "^0.35")).state).toBe("missing")
      const unversioned = yield* judge(ran("mpv vgit-abcdef"), ">=0.35")
      expect(unversioned.state).toBe("missing")
    }))
})

describe("probe versions keep their prerelease (review round 2, finding 15)", () => {
  it("parseVersion: full semver; a packaging revision is dropped, a prerelease kept, anything else is no version", () => {
    expect(parseVersion("6.1")).toBe("6.1.0")
    expect(parseVersion("2025.01.15")).toBe("2025.1.15")
    expect(parseVersion("2025.01.15.232340")).toBe("2025.1.15+232340")
    expect(parseVersion("n6.1-3ubuntu1")).toBe("6.1.0")
    expect(parseVersion("5.1.6-0+deb12u1")).toBe("5.1.6")
    expect(parseVersion("0.35.0-rc.1")).toBe("0.35.0-rc.1")
    expect(parseVersion("7.0-rc1")).toBe("7.0.0-rc1")
    expect(parseVersion("0.36.0+git")).toBe("0.36.0+git")
    expect(parseVersion("0.36.0-weird_build")).toBeUndefined()
    expect(parseVersion("vgit-abcdef")).toBeUndefined()
  })

  const check = (tool: string, output: string, version: string) =>
    Effect.gen(function*() {
      const { prober } = fakeProber({ [tool]: ran(output) })
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian" })
      const requirement: Requirement = { tool, version, why: "Plays" }
      yield* checker.probe([requirement])
      return checker.check([requirement])[0]!
    })

  it.effect("through the real checker: mpv 0.35.0-rc.1 does not meet >=0.35.0; a Debian revision is not a prerelease; an unreadable suffix fails closed", () =>
    Effect.gen(function*() {
      const rc = yield* check("mpv", "mpv 0.35.0-rc.1 Copyright © 2000-2023 mpv/MPlayer/mplayer2 projects", ">=0.35.0")
      expect(rc.state).toBe("missing")
      expect(rc.detail).toBe("mpv 0.35.0-rc.1 does not match >=0.35.0")
      expect((yield* check("mpv", "mpv 0.35.0-rc.1", ">=0.35.0-rc.1")).state).toBe("met")
      expect((yield* check("mpv", "mpv 0.35.1 Copyright", ">=0.35.0")).state).toBe("met")
      expect((yield* check("ffmpeg", "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", ">=5")).state).toBe("met")
      expect((yield* check("ffmpeg", "ffmpeg version 5.1.6-0+deb12u1 Copyright", ">=5")).state).toBe("met")
      expect((yield* check("ffmpeg", "ffmpeg version 6.1-full_build-www.gyan.dev Copyright", ">=5")).state).toBe("met")
      expect((yield* check("ffmpeg", "ffmpeg version 7.0-rc1 Copyright", ">=6")).state).toBe("missing")
      const odd = yield* check("mpv", "mpv 0.36.0-weird_build", ">=0.35")
      expect(odd.state).toBe("missing")
      expect(odd.detail).toMatch(/not a version/)
      // A program the registry does not know is probed with `--version` and read the same way.
      expect((yield* check("foo", "foo 2.0.0-beta.3", ">=2")).state).toBe("missing")
      expect((yield* check("foo", "foo 2.0.1", ">=2")).state).toBe("met")
    }))
})

describe("gpu requirements judge the device, never the program alone (finding 20)", () => {
  const judge = (gpu: "cuda" | "vulkan", answers: Readonly<Record<string, ProbeOutput>>) =>
    Effect.gen(function*() {
      const { prober } = fakeProber(answers)
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian" })
      const requirement: Requirement = { gpu }
      yield* checker.probe([requirement])
      return checker.check([requirement])[0]!
    })
  const summary = (devices: ReadonlyArray<[string, string]>) =>
    `Vulkan Instance Version: 1.3.275\n\nDevices:\n========\n${devices.map(([type, name], i) => `GPU${i}:\n\tdeviceType         = PHYSICAL_DEVICE_TYPE_${type}\n\tdeviceName         = ${name}\n`).join("")}`

  it.effect("vulkan: a hardware device is met; only llvmpipe, or no driver, is missing; no vulkaninfo is unchecked", () =>
    Effect.gen(function*() {
      const hardware = yield* judge("vulkan", { vulkaninfo: ran(summary([["CPU", "llvmpipe (LLVM 17.0.6, 256 bits)"], ["INTEGRATED_GPU", "Intel(R) UHD Graphics 620"]])) })
      expect(hardware).toMatchObject({ state: "met", detail: "Intel(R) UHD Graphics 620 (Vulkan)" })
      const software = yield* judge("vulkan", { vulkaninfo: ran(summary([["CPU", "llvmpipe (LLVM 17.0.6, 256 bits)"]])) })
      expect(software.state).toBe("missing")
      expect(software.detail).toMatch(/only a software renderer \(llvmpipe/)
      const noDriver = yield* judge("vulkan", { vulkaninfo: ran("ERROR: [Loader Message] Code 0 : vkCreateInstance: Found no drivers!\nCannot create Vulkan instance.\nERROR_INCOMPATIBLE_DRIVER", 1) })
      expect(noDriver.state).toBe("missing")
      const absent = yield* judge("vulkan", {})
      expect(absent.state).toBe("unchecked")
      expect(absent.detail).toMatch(/not checked \(vulkaninfo is not installed/)
      const odd = yield* judge("vulkan", { vulkaninfo: ran("Vulkan Instance Version: 1.3.275") })
      expect(odd.state).toBe("unchecked")
    }))

  it.effect("cuda: a listed GPU is met; none listed is missing; no nvidia-smi is unchecked", () =>
    Effect.gen(function*() {
      const listed = yield* judge("cuda", { "nvidia-smi": ran("GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-1234)\n") })
      expect(listed).toMatchObject({ state: "met", detail: "NVIDIA GeForce RTX 3060 (CUDA)" })
      const none = yield* judge("cuda", { "nvidia-smi": ran("No devices were found", 6) })
      expect(none.state).toBe("missing")
      const absent = yield* judge("cuda", {})
      expect(absent.state).toBe("unchecked")
    }))
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

// Review round 1, finding 11: doctor judges by the assistants' demand, through `uses` too, starting nothing.
describe("doctor's severity follows the assistants' demand", () => {
  const all = () => fakeProber({ flock: ran("flock from util-linux 2.39.3"), tar: ran("tar (GNU tar) 1.35"), bzip2: ran("Version 1.0.8"), nice: ran("nice (GNU coreutils) 9.4") })
  const base = { env: {}, dataDir: "/nonexistent/pva-data", modelDirs: { stt: "/nonexistent/stt", tts: "/nonexistent/tts" }, core: { ...quietCore, clockSynced: async () => true } }
  const offByDefault = defineModule({ id: "radio", name: "Radio", description: "", enabledByDefault: false, requires: [{ tool: "mpv", why: "Plays" }], start: () => Effect.succeed({}) })
  const provider = defineModule({ apiVersion: 2, id: "streams", name: "Streams", description: "", requires: [{ tool: "ffmpeg", why: "Converts" }], start: () => Effect.succeed({}) })
  const consumer = defineModule({ apiVersion: 2, id: "kitchen", name: "Kitchen", description: "", uses: ["streams"], start: () => Effect.succeed({}) })

  it.effect("a disabled-by-default capability an assistant has on, and a provider it reaches through `uses`, are errors", () =>
    Effect.gen(function*() {
      const issues = yield* runDoctor({
        ...base,
        catalog: [offByDefault, provider, consumer],
        assistants: [assistantWith({ radio: { on: true, offTools: [] }, kitchen: { on: true, offTools: [] } })],
        persistence: { modules: { radio: { enabled: false } }, secrets: {} },
        prober: all().prober
      })
      const severity = (id: string) => issues.find((i) => i.id === id)?.severity
      expect(severity("radio.requires.mpv")).toBe("error")
      expect(severity("streams.requires.ffmpeg")).toBe("error")
      expect(formatDoctor(issues).exitCode).toBe(1)
    }))

  it.effect("with nobody using them, both are warnings and doctor exits 0", () =>
    Effect.gen(function*() {
      const issues = yield* runDoctor({ ...base, catalog: [offByDefault, provider, consumer], assistants: [assistantWith({})], prober: all().prober })
      expect(issues.map((i) => i.severity)).toEqual(["warning", "warning"])
      expect(formatDoctor(issues).exitCode).toBe(0)
    }))
})

// Review round 1, finding 18: a required program that fails at run time makes its module unavailable at once.
describe("a missing program reported at run time", () => {
  it.effect("after a successful probe, a tool's ENOENT marks it missing and the module becomes unavailable, without probing again", () =>
    Effect.gen(function*() {
      const { calls, prober } = fakeProber({ "yt-dlp": ran("2025.01.15") })
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian" })
      let host: ModuleHostApi | undefined
      const player = defineModule({
        apiVersion: 2,
        id: "player",
        name: "Player",
        description: "",
        requires: [{ tool: "yt-dlp", why: "Resolves" }],
        start: (ctx) =>
          Effect.sync(() => {
            host = ctx.host
            return {
              tools: [makeTool({
                name: "play",
                description: "",
                parameters: Schema.Struct({}),
                execute: () =>
                  Effect.gen(function*() {
                    const spawnError = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" })
                    if (isMissingProgramError(spawnError)) yield* ctx.host.reportMissingProgram("yt-dlp")
                    return "could not play"
                  })
              })]
            }
          })
      })
      yield* checker.probeCatalog([player])
      const made = yield* makeModuleHost({
        catalog: [player],
        persistence: readOnlyPersistence(),
        env: {},
        requirements: checker.check,
        programMissing: (tool) => checker.markMissing(tool)
      })
      yield* made.startEnabled
      expect(made.modules()[0]!.state).toBe("running")
      expect(host).toBeDefined()
      yield* made.snapshot().registry.run({ id: "c1", name: "play", input: {} })
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      expect(made.modules()[0]!.state).toBe("unavailable")
      expect(made.modules()[0]!.unavailable?.reason).toBe("yt-dlp is missing")
      // No probe on the turn path: the one at start only.
      expect(calls.length).toBe(1)
      // A program it does not require is ignored.
      yield* host!.reportMissingProgram("ffmpeg")
      expect(checker.probed("ffmpeg")).toBeUndefined()
    }).pipe(Effect.scoped))
})
