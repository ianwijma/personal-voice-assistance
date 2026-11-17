// Module requirements and `pnpm start doctor` (docs/MODULES-PLAN.md §4 P1; module-definition §C.3–C.5), with fake
// program entries and a fake prober: nothing is run on this machine. The real registry is empty in this version.
import { describe, expect, it } from "@effect/vitest"
import { defineModule, type Issue as HealthIssue, isMissingProgramError, isModuleStopped, makeModuleHost, makeTool, type ModuleHostApi, readOnlyPersistence, type Requirement } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { Cause, Effect, Fiber, Schema } from "effect"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatDoctor, loadDoctorSettings, runDoctor } from "../src/doctor.ts"
import {
  detectDistro,
  installFix,
  makeRequirementChecker,
  type ProbeOutput,
  type Prober,
  probePath,
  satisfiesRange,
  strictVersion,
  TOOL_REGISTRY,
  type ToolEntry
} from "../src/requirements.ts"

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

/** Test entries (the real registry is empty): the version is the whole token after the program's name. */
const entry = (name: string, flag = "--version"): ToolEntry => ({
  probe: { argv: [name, flag], version: new RegExp(`${name} (\\S+)`) },
  packages: { debian: `${name}-pkg`, arch: name, nix: name }
})
const TOOLS = new Map<string, ToolEntry>([["mpv", entry("mpv")], ["ffmpeg", entry("ffmpeg", "-version")], ["yt-dlp", entry("yt-dlp")], ["sox", entry("sox")]])

describe("versions: strict semver or unknown", () => {
  it("a version is strict semver, prerelease and build parts included; anything else is unknown", () => {
    for (const v of ["6.1.0", "0.35.0-rc.1", "1.2.3+build.5", "1.0.0-alpha.1+exp.sha.5114f85"]) expect(strictVersion(v)).toBe(v)
    for (const v of ["6.1", "v1.2.3", "2025.01.15", "0.35.0~rc1", "1.02.3", "3.14.0rc1", "6.1.1-3ubuntu5x+", "", undefined]) expect(strictVersion(v)).toBeUndefined()
  })

  it("ranges by node-semver; unknown does not satisfy; a prerelease only a range that allows it", () => {
    expect(satisfiesRange("6.1.0", ">=5")).toBe(true)
    expect(satisfiesRange("4.4.2", ">=5")).toBe(false)
    expect(satisfiesRange("4.7.0", ">=5 || ^4")).toBe(true)
    expect(satisfiesRange("0.36.0", "^0.35")).toBe(false)
    expect(satisfiesRange("7.0.0-rc.1", ">=6")).toBe(false)
    expect(satisfiesRange("7.0.0-rc.2", ">=7.0.0-rc.1")).toBe(true)
    expect(satisfiesRange("0.35.0-1", ">=0.35.0")).toBe(false)
    expect(satisfiesRange("6.1", ">=5")).toBeUndefined()
    expect(satisfiesRange("6.1.0", "about six")).toBeUndefined()
  })
})

describe("the requirement checker", () => {
  it.effect("probes each program once, concurrently, without a shell, on the fixed path with 5 s, and judges from the cache", () =>
    Effect.gen(function*() {
      const { calls, prober } = fakeProber({
        ffmpeg: ran("ffmpeg 6.1.1 Copyright (c) 2000-2023"),
        mpv: ran("mpv 0.34.1 Copyright © 2000-2021"),
        sox: { kind: "timeout" }
      })
      const checker = makeRequirementChecker({ dataDir: "/srv/pva/data", prober, distro: "debian", tools: TOOLS })
      const requirements: ReadonlyArray<Requirement> = [
        { tool: "ffmpeg", version: ">=5", why: "Converts audio" },
        { tool: "mpv", version: ">=0.35", why: "Plays streams" },
        { tool: "yt-dlp", why: "Resolves stream URLs" },
        { tool: "sox", why: "Mixes" },
        { network: "internet" }
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
        ["unchecked", "internet access (not checked)"]
      ])
      expect(statuses[2]!.fix).toEqual({ kind: "command", label: "Install yt-dlp", value: "sudo apt install yt-dlp-pkg" })
      expect(statuses[1]!.fix?.label).toBe("Update mpv")
      yield* checker.probe(requirements, { force: true })
      expect(calls.length).toBe(8)
    }))

  it.effect("a version that is not strict semver is unknown: it never meets a range, and is shown as reported", () =>
    Effect.gen(function*() {
      const judge = (output: string, version?: string) =>
        Effect.gen(function*() {
          const checker = makeRequirementChecker({ dataDir: "/d", prober: fakeProber({ mpv: ran(output) }).prober, distro: "debian", tools: TOOLS })
          const r: Requirement = { tool: "mpv", ...(version !== undefined ? { version } : {}), why: "Plays" }
          yield* checker.probe([r])
          return checker.check([r])[0]!
        })
      expect((yield* judge("mpv 0.35.0-1", ">=0.35.0")).state).toBe("missing")
      expect((yield* judge("mpv 0.35.0~rc1", ">=0.35.0")).detail).toBe('mpv reported "0.35.0~rc1", which is not a semver version; needs >=0.35.0')
      expect((yield* judge("mpv 3.14.0rc1", ">=3")).state).toBe("missing")
      expect((yield* judge("mpv 0.35.0-rc.1", ">=0.35.0")).state).toBe("missing")
      expect((yield* judge("mpv 0.35.0-rc.1", ">=0.35.0-rc.1")).state).toBe("met")
      expect((yield* judge("mpv 2025.01.15", ">=2025.1.15")).state).toBe("missing")
      expect(yield* judge("mpv 6.1")).toEqual({ requirement: { tool: "mpv", why: "Plays" }, state: "met", detail: "mpv 6.1" })
      expect((yield* judge("mpv 1.0.0", "about one")).detail).toMatch(/cannot be read/)
    }))

  // Review round 4 (p1-r4c findings 5, 7).
  it.effect("a global or sticky version pattern judges the same on every probe; the unknown-program fix is a command, not a missing page", () =>
    Effect.gen(function*() {
      for (const flags of ["g", "y", "gy"]) {
        const shared = new RegExp("x (\\S+)", flags)
        const tools = new Map<string, ToolEntry>([["x", { probe: { argv: ["x", "--version"], version: shared }, packages: { debian: "x" } }], ["x2", { probe: { argv: ["x2", "--version"], version: shared }, packages: { debian: "x2" } }]])
        const checker = makeRequirementChecker({ dataDir: "/d", prober: fakeProber({ x: ran("x 1.2.3"), x2: ran("x 1.2.3") }).prober, distro: "debian", tools })
        const rs: ReadonlyArray<Requirement> = [{ tool: "x", version: ">=1", why: "y" }, { tool: "x2", version: ">=1", why: "y" }]
        for (let i = 0; i < 3; i++) {
          yield* checker.probe(rs, { force: true })
          expect(checker.check(rs).map((st) => st.state), `flags ${flags}, probe ${i + 1}`).toEqual(["met", "met"])
        }
      }
      const checker = makeRequirementChecker({ dataDir: "/d", prober: fakeProber({}).prober, distro: "debian" })
      const r: Requirement = { tool: "nosuch", why: "x" }
      yield* checker.probe([r])
      const fix = checker.check([r])[0]!.fix
      expect(fix?.kind).toBe("command")
      expect(fix?.value).toBe("git pull && pnpm install")
    }))

  it.effect("the registry is empty; a program it does not know is missing, also a name like constructor or __proto__", () =>
    Effect.gen(function*() {
      expect(TOOL_REGISTRY.size).toBe(0)
      const { calls, prober } = fakeProber({})
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian" })
      const names = ["ffmpeg", "constructor", "toString", "__proto__", "hasOwnProperty"]
      const requirements = names.map((tool): Requirement => ({ tool, why: "x" }))
      yield* checker.probe(requirements)
      expect(calls).toEqual([]) // an unknown program is never run
      expect(checker.check(requirements).map((s) => [s.state, s.detail])).toEqual(names.map((n) => ["missing", `${n} is not a program this assistant knows how to check`]))
    }))

  it.effect("a probe already running when a missing program is reported cannot undo the report; a later probe can", () =>
    Effect.gen(function*() {
      let release: (() => void) | undefined
      const prober: Prober = () => new Promise((resolve) => (release = () => resolve(ran("mpv 1.0.0"))))
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian", tools: TOOLS })
      const r: Requirement = { tool: "mpv", why: "Plays" }
      const probing = yield* Effect.forkChild(checker.probe([r], { force: true }))
      yield* Effect.repeat(Effect.yieldNow, { times: 10 })
      checker.markMissing("mpv")
      release!()
      yield* Fiber.await(probing)
      expect(checker.check([r])[0]!.state).toBe("missing")
      const again = yield* Effect.forkChild(checker.probe([r], { force: true }))
      yield* Effect.repeat(Effect.yieldNow, { times: 10 })
      release!()
      yield* Fiber.await(again)
      expect(checker.check([r])[0]!.state).toBe("met")
    }))

  it("fixes per distribution, and the os-release families", () => {
    const ffmpeg = TOOLS.get("ffmpeg")
    expect(installFix("ffmpeg", ffmpeg, "arch").value).toBe("sudo pacman -S ffmpeg")
    expect(installFix("ffmpeg", ffmpeg, "nix").value).toMatch(/^nix-env -iA nixos\.ffmpeg/)
    expect(installFix("ffmpeg", ffmpeg, undefined).value).toMatch(/Debian\/Ubuntu: sudo apt install ffmpeg-pkg · Arch: sudo pacman -S ffmpeg/)
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

const assistantWith = (modules: Assistant["modules"]): Assistant => ({ id: "jeff", name: "Jeff", on: true, modules, voice: { provider: "cartesia", voiceId: "x" } } as unknown as Assistant)

describe("doctor", () => {
  it.effect("prints one line per issue with its fix, says nothing about the machine, and exits 1 on an error", () =>
    Effect.gen(function*() {
      const report = yield* runDoctor({
        catalog: [music, weather],
        env: {},
        dataDir: "/nonexistent/pva-data",
        assistants: [assistantWith({ music: { on: true, offTools: [] } })],
        prober: fakeProber({}).prober,
        tools: TOOLS
      })
      const { exitCode, lines } = formatDoctor(report.issues, report.modules)
      expect(exitCode).toBe(1)
      expect(lines).toEqual([
        "module  music: cannot run here (yt-dlp is missing); requires yt-dlp missing (yt-dlp is missing); no health check.",
        "module  weather: no requirements; health: 1 issue.",
        expect.stringMatching(/^error   music: yt-dlp is missing\. Music needs it: Resolves stream URLs\. → Install yt-dlp: /),
        "info    weather: Forecast quota at 80 %.",
        "1 error, 0 warnings, 1 note."
      ])
    }))

  it.effect("a module no assistant has on is only a warning, and nothing to report exits 0", () =>
    Effect.gen(function*() {
      const unused = yield* runDoctor({ catalog: [music], env: {}, dataDir: "/nonexistent/pva-data", assistants: [assistantWith({})], prober: fakeProber({}).prober, tools: TOOLS })
      const report = formatDoctor(unused.issues, unused.modules)
      expect(report.lines).toEqual([
        "module  music: cannot run here (yt-dlp is missing); requires yt-dlp missing (yt-dlp is missing); no health check.",
        expect.stringMatching(/^warning music: yt-dlp is missing\. Music needs it: Resolves stream URLs\. \(No assistant has it on\.\) → Install yt-dlp: /),
        "0 errors, 1 warning, 0 notes."
      ])
      expect(report.exitCode).toBe(0)
      expect(formatDoctor([])).toEqual({ lines: ["No problems found."], exitCode: 0 })
    }))

  it("every piece of text is one line without control characters, whatever a module put in it", () => {
    const evil: HealthIssue = {
      id: "x",
      module: "weather",
      severity: "error",
      title: "Bad\nerror   music: all fine\u001b[2J",
      detail: "line one\r\nline two\u0007",
      fix: { kind: "command", label: "Fix\u001b]0;owned\u0007 it", value: "rm -rf /\nreboot" }
    }
    const { lines } = formatDoctor([evil])
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe("error   weather: Bad error music: all fine [2J. line one line two. → Fix ]0;owned it: rm -rf / reboot")
    // eslint-disable-next-line no-control-regex
    expect(lines.every((l) => !/[\u0000-\u001f\u007f-\u009f]/.test(l))).toBe(true)
  })

  it.effect("settings or a vault that cannot be read are a clear failure, never the defaults", () =>
    Effect.gen(function*() {
      const lockedVault = { state: () => "locked", unlock: async () => ({ ok: false, message: "wrong password" }) } as never
      const locked = yield* Effect.flip(loadDoctorSettings({ env: {}, dataDir: "/nonexistent", vaultPath: "/v.enc", catalog: [], openVault: async () => lockedVault }))
      expect(locked.message).toMatch(/^The key vault at \/v\.enc is locked: set PVA_VAULT_PASSWORD/)
      const wrong = yield* Effect.flip(loadDoctorSettings({ env: { PVA_VAULT_PASSWORD: "x" }, dataDir: "/nonexistent", vaultPath: "/v.enc", catalog: [], openVault: async () => lockedVault }))
      expect(wrong.message).toMatch(/did not unlock: wrong password/)
      const unreadable = yield* Effect.flip(loadDoctorSettings({ env: {}, dataDir: "/d", vaultPath: "/v.enc", catalog: [], openVault: async () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) }))
      expect(unreadable.message).toBe("The key vault at /v.enc could not be read: EACCES: permission denied")
    }))

  // Review round 4 (p1-r4c finding 1): a missing installation is not "the defaults".
  it.effect("a missing data directory, a missing settings file and a corrupt one are failures (exit 2), and nothing is written", () =>
    Effect.gen(function*() {
      const openVaultNone = async () => ({ state: () => "none" }) as never
      const root = mkdtempSync(join(tmpdir(), "pva-doctor-"))
      const missingDir = yield* Effect.flip(loadDoctorSettings({ env: {}, dataDir: join(root, "typo"), vaultPath: "/v.enc", catalog: [], openVault: openVaultNone }))
      expect(missingDir.message).toMatch(/^There is no data directory at .*typo: set PVA_DATA_DIR/)
      const missingFile = yield* Effect.flip(loadDoctorSettings({ env: {}, dataDir: root, vaultPath: "/v.enc", catalog: [], openVault: openVaultNone }))
      expect(missingFile.message).toMatch(/^There are no saved settings at .*settings\.json: set PVA_DATA_DIR/)
      expect(readdirSync(root)).toEqual([])
      expect(existsSync(join(root, "typo"))).toBe(false)
      writeFileSync(join(root, "settings.json"), "{ not json")
      const corrupt = yield* Effect.flip(loadDoctorSettings({ env: {}, dataDir: root, vaultPath: "/v.enc", catalog: [], openVault: openVaultNone }))
      expect(corrupt.message).toMatch(/could not be read/)
      expect(readdirSync(root)).toEqual(["settings.json"])
      expect(readFileSync(join(root, "settings.json"), "utf8")).toBe("{ not json")
      rmSync(root, { recursive: true, force: true })
    }))

  // Review round 4 (p1-r4c findings 3, 6): every module has its line, healthy and unchecked ones too; an issue says its device.
  it.effect("a healthy module, an unchecked-network module and an unhealthy one each have a line; issues name their device", () =>
    Effect.gen(function*() {
      const healthy = defineModule({ id: "clock", name: "Clock", description: "", requires: [{ tool: "mpv", why: "Plays" }], health: () => Effect.succeed([]), start: () => Effect.succeed({}) })
      const online = defineModule({ id: "news", name: "News", description: "", requires: [{ network: "internet", why: "Fetches" }], start: () => Effect.succeed({}) })
      const speakers = defineModule({
        id: "speakers",
        name: "Speakers",
        description: "",
        health: () => Effect.succeed<ReadonlyArray<HealthIssue>>([
          { id: "a", device: "d-kitchen", severity: "warning", title: "Speaker offline", detail: "" },
          { id: "b", device: "d-hall", severity: "warning", title: "Speaker offline", detail: "" }
        ]),
        start: () => Effect.succeed({})
      })
      const report = yield* runDoctor({
        catalog: [healthy, online, speakers],
        env: {},
        dataDir: "/nonexistent/pva-data",
        assistants: [assistantWith({})],
        prober: fakeProber({ mpv: ran("mpv 0.38.0") }).prober,
        tools: TOOLS
      })
      const { exitCode, lines } = formatDoctor(report.issues, report.modules)
      expect(exitCode).toBe(0)
      expect(lines.slice(0, 3)).toEqual([
        "module  clock: requires mpv met (mpv 0.38.0); healthy.",
        "module  news: requires network (internet) not checked; no health check.",
        "module  speakers: no requirements; health: 2 issues."
      ])
      expect(lines).toContain("warning speakers (device d-kitchen): Speaker offline.")
      expect(lines).toContain("warning speakers (device d-hall): Speaker offline.")
    }))
})

// Review round 1, finding 11: doctor judges by the assistants' demand, through `uses` too, starting nothing.
describe("doctor's severity follows the assistants' demand", () => {
  const base = { env: {}, dataDir: "/nonexistent/pva-data", tools: TOOLS, prober: fakeProber({}).prober }
  const offByDefault = defineModule({ id: "radio", name: "Radio", description: "", enabledByDefault: false, requires: [{ tool: "mpv", why: "Plays" }], start: () => Effect.succeed({}) })
  const provider = defineModule({ apiVersion: 2, id: "streams", name: "Streams", description: "", requires: [{ tool: "ffmpeg", why: "Converts" }], start: () => Effect.succeed({}) })
  const consumer = defineModule({ apiVersion: 2, id: "kitchen", name: "Kitchen", description: "", uses: ["streams"], start: () => Effect.succeed({}) })

  it.effect("a disabled-by-default capability an assistant has on, and a provider it reaches through `uses`, are errors", () =>
    Effect.gen(function*() {
      const { issues } = yield* runDoctor({
        ...base,
        catalog: [offByDefault, provider, consumer],
        assistants: [assistantWith({ radio: { on: true, offTools: [] }, kitchen: { on: true, offTools: [] } })],
        persistence: { modules: { radio: { enabled: false } }, secrets: {} }
      })
      const severity = (id: string) => issues.find((i) => i.id === id)?.severity
      expect(severity("radio.requires.mpv")).toBe("error")
      expect(severity("streams.requires.ffmpeg")).toBe("error")
      expect(formatDoctor(issues).exitCode).toBe(1)
    }))

  it.effect("with nobody using them, both are warnings and doctor exits 0", () =>
    Effect.gen(function*() {
      const { issues } = yield* runDoctor({ ...base, catalog: [offByDefault, provider, consumer], assistants: [assistantWith({})] })
      expect(issues.map((i) => i.severity)).toEqual(["warning", "warning"])
      expect(formatDoctor(issues).exitCode).toBe(0)
    }))
})

// Review round 1, finding 18: a required program that fails at run time makes its module unavailable at once.
describe("a missing program reported at run time", () => {
  it.effect("after a successful probe, a tool's ENOENT marks it missing and the module becomes unavailable, without probing again", () =>
    Effect.gen(function*() {
      const { calls, prober } = fakeProber({ "yt-dlp": ran("yt-dlp 2025.1.15") })
      const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian", tools: TOOLS })
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
      // A program it does not require is ignored.
      yield* host!.reportMissingProgram("ffmpeg")
      expect(checker.probed("ffmpeg")).toBeUndefined()
      yield* made.snapshot().registry.run({ id: "c1", name: "play", input: {} })
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      expect(made.modules()[0]!.state).toBe("unavailable")
      expect(made.modules()[0]!.unavailable?.reason).toBe("yt-dlp is missing")
      // No probe on the turn path: the one at start only.
      expect(calls.length).toBe(1)
      // The stopped module's host object answers with ModuleStopped (a defect: its types stay as they were).
      const after = yield* Effect.exit(host!.reportMissingProgram("ffmpeg"))
      expect(after._tag === "Failure" && isModuleStopped(Cause.squash(after.cause))).toBe(true)
    }).pipe(Effect.scoped))
})
