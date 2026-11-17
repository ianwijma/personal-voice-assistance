import type { IssueFix, ModuleDefinition, Requirement, RequirementCheck, RequirementStatus } from "@pva/core"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import semver from "semver"
import { readFileSync, statfsSync } from "node:fs"
import { totalmem } from "node:os"
import { join } from "node:path"

/**
 * Module requirements, judged on this server (module-definition-config-and-dependencies.md §C.3): one registry of the
 * programs modules may need (how to find and check each, which package installs it), probes that run each program's
 * version command with no shell and a 5 s timeout on a fixed `PATH` (the data directory's `tools/bin` first), and a
 * cache the module host reads synchronously. Probes run at start and on "Check again", never on a turn.
 */

/** How to find, check and install one program. */
export interface ToolEntry {
  /**
   * The version command (no shell) and where the version is in its output (first capture group, the whole token:
   * prerelease and build parts included; none: any output). `packaging`: a suffix that is the distribution's
   * packaging, not part of the program's version (stripped before it is read; default `DEB_REVISION`).
   */
  readonly probe: { readonly argv: ReadonlyArray<string>; readonly version: RegExp; readonly packaging?: RegExp }
  /** The package that installs it, per distribution family. */
  readonly packages?: { readonly debian?: string; readonly arch?: string; readonly nix?: string }
}

/** A version token as programs print it: numbers, then any prerelease (`-rc.1`) or build (`+git`) part, kept whole. */
const VERSION = String.raw`(\d+(?:\.\d+)+(?:[-+~][0-9A-Za-z][0-9A-Za-z.+~_-]*)?)`
const versionAfter = (prefix: string) => new RegExp(`${prefix}${VERSION}`)

/**
 * A Debian/Ubuntu-style package revision after the version (`-3ubuntu5`, `-0+deb12u1`, `-1build2`, `~22.04`): it
 * starts with a digit or a tilde, which a program's own prerelease (`-rc.1`, `-beta`, `-dev`) does not.
 */
export const DEB_REVISION = /(?:-\d[0-9A-Za-z.+~_-]*|~[0-9A-Za-z.+~_-]*)$/
/** FFmpeg's builds name their packaging after the version too (`-static`, `-full_build-www.gyan.dev`). */
const FFMPEG_PACKAGING = /(?:-\d[0-9A-Za-z.+~_-]*|~[0-9A-Za-z.+~_-]*|-(?:static|full_build|essentials_build|tessus)[0-9A-Za-z.+~_-]*)$/

/** The programs this assistant knows how to check (modules name them in `requires`). */
export const TOOL_REGISTRY: Readonly<Record<string, ToolEntry>> = {
  ffmpeg: { probe: { argv: ["ffmpeg", "-version"], version: versionAfter("ffmpeg version n?"), packaging: FFMPEG_PACKAGING }, packages: { debian: "ffmpeg", arch: "ffmpeg", nix: "ffmpeg" } },
  ffprobe: { probe: { argv: ["ffprobe", "-version"], version: versionAfter("ffprobe version n?"), packaging: FFMPEG_PACKAGING }, packages: { debian: "ffmpeg", arch: "ffmpeg", nix: "ffmpeg" } },
  "yt-dlp": { probe: { argv: ["yt-dlp", "--version"], version: /(\d{4}\.\d+\.\d+(?:\.\d+)?)/ }, packages: { debian: "yt-dlp", arch: "yt-dlp", nix: "yt-dlp" } },
  mpv: { probe: { argv: ["mpv", "--version"], version: versionAfter("mpv v?") }, packages: { debian: "mpv", arch: "mpv", nix: "mpv" } },
  sox: { probe: { argv: ["sox", "--version"], version: versionAfter("v") }, packages: { debian: "sox", arch: "sox", nix: "sox" } },
  tar: { probe: { argv: ["tar", "--version"], version: versionAfter("") }, packages: { debian: "tar", arch: "tar", nix: "gnutar" } },
  bzip2: { probe: { argv: ["bzip2", "-h"], version: versionAfter("Version ") }, packages: { debian: "bzip2", arch: "bzip2", nix: "bzip2" } },
  flock: { probe: { argv: ["flock", "--version"], version: versionAfter("") }, packages: { debian: "util-linux", arch: "util-linux", nix: "util-linux" } },
  nice: { probe: { argv: ["nice", "--version"], version: versionAfter("") }, packages: { debian: "coreutils", arch: "coreutils", nix: "coreutils" } },
  git: { probe: { argv: ["git", "--version"], version: versionAfter("git version ") }, packages: { debian: "git", arch: "git", nix: "git" } },
  python3: { probe: { argv: ["python3", "--version"], version: versionAfter("Python ") }, packages: { debian: "python3", arch: "python", nix: "python3" } },
  "nvidia-smi": { probe: { argv: ["nvidia-smi", "-L"], version: /GPU \d+/ }, packages: { debian: "nvidia-utils", arch: "nvidia-utils", nix: "linuxPackages.nvidia_x11" } },
  vulkaninfo: { probe: { argv: ["vulkaninfo", "--summary"], version: /Vulkan Instance Version: (\d+(?:\.\d+)+)/ }, packages: { debian: "vulkan-tools", arch: "vulkan-tools", nix: "vulkan-tools" } }
}

/** What running a version command gave. */
export type ProbeOutput =
  | { readonly kind: "ran"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "missing" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed"; readonly message: string }

/** Runs one version command. The real one is `execProber`; tests give a fake. */
export type Prober = (argv: ReadonlyArray<string>, options: { readonly timeoutMs: number; readonly path: string }) => Promise<ProbeOutput>

/** The fixed search path of the probes (and of nothing else): the data directory's `tools/bin`, then the system's. */
export const probePath = (dataDir: string): string =>
  [
    join(dataDir, "tools", "bin"),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/snap/bin",
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
    "/opt/homebrew/bin"
  ].join(":")

/** Run `argv` without a shell, on `path`, with stdin closed, at most `timeoutMs`; stdout and stderr together. */
export const execProber: Prober = (argv, options) =>
  new Promise((resolve) => {
    const [file, ...args] = argv
    if (file === undefined) return resolve({ kind: "failed", message: "empty command" })
    try {
      const child = execFile(
        file,
        args,
        { timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, env: { PATH: options.path, LC_ALL: "C" }, shell: false, windowsHide: true },
        (error, stdout, stderr) => {
          const output = `${String(stdout)}\n${String(stderr)}`
          if (error === null) return resolve({ kind: "ran", exitCode: 0, output })
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
          if (e.code === "ENOENT" || e.code === "EACCES") return resolve({ kind: "missing" })
          if (e.killed === true) return resolve({ kind: "timeout" })
          // A version command that exits non-zero but printed something (bzip2 -h exits 0; others vary) still ran.
          if (typeof e.code === "number") return resolve({ kind: "ran", exitCode: e.code, output })
          resolve({ kind: "failed", message: e.message })
        }
      )
      child.stdin?.end()
    } catch (error) {
      resolve({ kind: "failed", message: error instanceof Error ? error.message : String(error) })
    }
  })

// ---------------------------------------------------------------------------------------------------------------------
// Versions

/**
 * A program's reported version as full semver: "6.1" is 6.1.0, "2025.01.15" is 2025.1.15, a fourth number is build
 * metadata ("2025.01.15.232340" is 2025.1.15+232340), a packaging suffix (`packaging`, default `DEB_REVISION`: "6.1-
 * 3ubuntu1" is 6.1.0) is dropped, and a prerelease stays one ("0.35.0-rc.1", "7.0-rc1" is 7.0.0-rc1), so a range
 * that names none rejects it. `undefined` when it holds no version, or a suffix that is neither: never guessed.
 */
export const parseVersion = (reported: string, packaging: RegExp = DEB_REVISION): string | undefined => {
  const token = reported.trim().replace(/^[vn](?=\d)/i, "").replace(packaging, "")
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(token)
  if (m === null) return undefined
  const numbers = m[1]!.split(".")
  const core = [...numbers.slice(0, 3), "0", "0"].slice(0, 3).map((n) => String(Number(n))).join(".")
  const rest = m[2]!.startsWith("~") ? `-${m[2]!.slice(1)}` : m[2]!
  const build = numbers.length > 3 ? numbers.slice(3).join(".") : undefined
  const candidate = build === undefined ? `${core}${rest}` : rest.includes("+") ? `${core}${rest}.${build}` : `${core}${rest}+${build}`
  return semver.valid(candidate) === null ? undefined : candidate
}

/**
 * Whether `version` lies in `range`, by semver (node-semver): comparators, `||`, `^` (for `0.x`, the same minor),
 * `~`, `x` ranges and hyphen ranges; a prerelease satisfies only a range that names a prerelease of the same version.
 * `undefined` when the range cannot be read or the version holds none: never a pass.
 */
export const satisfiesRange = (version: string, range: string, packaging?: RegExp): boolean | undefined => {
  if (semver.validRange(range) === null) return undefined
  const parsed = parseVersion(version, packaging)
  if (parsed === undefined) return undefined
  return semver.satisfies(parsed, range)
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixes

export type Distro = "debian" | "arch" | "nix" | undefined

/** The distribution family from `/etc/os-release` (`ID`, `ID_LIKE`). */
export const detectDistro = (osRelease: string | undefined = readOsRelease()): Distro => {
  if (osRelease === undefined) return undefined
  const field = (name: string) => new RegExp(`^${name}="?([^"\\n]*)"?`, "m").exec(osRelease)?.[1]?.toLowerCase() ?? ""
  const ids = `${field("ID")} ${field("ID_LIKE")}`.split(/\s+/)
  if (ids.some((id) => id === "nixos")) return "nix"
  if (ids.some((id) => id === "debian" || id === "ubuntu")) return "debian"
  if (ids.some((id) => id === "arch" || id === "archlinux" || id === "manjaro")) return "arch"
  return undefined
}

const readOsRelease = (): string | undefined => {
  try {
    return readFileSync("/etc/os-release", "utf8")
  } catch {
    return undefined
  }
}

/** The command that installs `tool` here (shown to the owner, never run by the server). */
export const installFix = (tool: string, entry: ToolEntry | undefined, distro: Distro, verb = "Install"): IssueFix => {
  const pkg = entry?.packages
  const label = `${verb} ${tool}`
  if (distro === "debian" && pkg?.debian !== undefined) return { kind: "command", label, value: `sudo apt install ${pkg.debian}` }
  if (distro === "arch" && pkg?.arch !== undefined) return { kind: "command", label, value: `sudo pacman -S ${pkg.arch}` }
  if (distro === "nix" && pkg?.nix !== undefined) return { kind: "command", label, value: `nix-env -iA nixos.${pkg.nix} (or add ${pkg.nix} to environment.systemPackages)` }
  if (pkg === undefined) return { kind: "command", label, value: `Install ${tool} with your system's package manager, so that it is on the PATH.` }
  const options = [
    pkg.debian !== undefined ? `Debian/Ubuntu: sudo apt install ${pkg.debian}` : undefined,
    pkg.arch !== undefined ? `Arch: sudo pacman -S ${pkg.arch}` : undefined,
    pkg.nix !== undefined ? `Nix: ${pkg.nix}` : undefined
  ].filter((x) => x !== undefined)
  return { kind: "command", label, value: options.join(" · ") }
}

// ---------------------------------------------------------------------------------------------------------------------
// The checker

/** A probed program: its version, or why not. */
export type ToolProbe =
  | { readonly found: true; readonly version: string | undefined; readonly packaging?: RegExp | undefined }
  | { readonly found: false; readonly why: "missing" | "timeout" | "failed" | "not-recognised"; readonly message?: string }

export interface RequirementChecker {
  /** Judge requirements from the cache (synchronous): what the module host reads. A program never probed is missing. */
  readonly check: RequirementCheck
  /**
   * Probe every program the requirements name, concurrently (5 s each). Without `force`, programs already in the
   * cache are not probed again. Never fails.
   */
  readonly probe: (requirements: ReadonlyArray<Requirement>, options?: { readonly force?: boolean }) => Effect.Effect<void>
  /** `probe` for every requirement of every module of `catalog`. */
  readonly probeCatalog: (catalog: ReadonlyArray<ModuleDefinition<any>>, options?: { readonly force?: boolean }) => Effect.Effect<void>
  /** A spawn of `tool` failed with ENOENT or EACCES: it is missing from now on (until probed again). */
  readonly markMissing: (tool: string) => void
  /** What the cache knows about one program (tests, `doctor`). */
  readonly probed: (tool: string) => ToolProbe | undefined
}

export interface RequirementCheckerOptions {
  readonly dataDir: string
  readonly prober?: Prober
  readonly tools?: Readonly<Record<string, ToolEntry>>
  readonly timeoutMs?: number
  readonly distro?: Distro
  /** Total memory in MB. Default: the machine's. */
  readonly memoryMb?: () => number
  /** Free space in MB in the data directory, or `undefined` when it cannot be read. Default: `statfs`. */
  readonly freeDiskMb?: () => number | undefined
}

/** The program a `gpu` requirement is probed with. */
const gpuTool = (gpu: "cuda" | "vulkan") => (gpu === "cuda" ? "nvidia-smi" : "vulkaninfo")

export const freeMbOf = (dir: string): number | undefined => {
  try {
    const s = statfsSync(dir)
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024))
  } catch {
    return undefined
  }
}

export const makeRequirementChecker = (options: RequirementCheckerOptions): RequirementChecker => {
  const prober = options.prober ?? execProber
  const tools = options.tools ?? TOOL_REGISTRY
  const timeoutMs = options.timeoutMs ?? 5_000
  const distro = "distro" in options ? options.distro : detectDistro()
  const path = probePath(options.dataDir)
  const memoryMb = options.memoryMb ?? (() => Math.floor(totalmem() / (1024 * 1024)))
  const freeDiskMb = options.freeDiskMb ?? (() => freeMbOf(options.dataDir))
  const cache = new Map<string, ToolProbe>()
  /** What a GPU program printed when it ran (its exit code and output): the devices are read from it. */
  const ranOutput = new Map<string, { readonly exitCode: number; readonly output: string }>()

  const probeOne = (tool: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      const entry = tools[tool]
      const argv = entry?.probe.argv ?? [tool, "--version"]
      const pattern = entry?.probe.version ?? new RegExp(VERSION)
      let out: ProbeOutput
      try {
        out = await prober(argv, { timeoutMs, path })
      } catch (error) {
        out = { kind: "failed", message: error instanceof Error ? error.message : String(error) }
      }
      const result: ToolProbe = out.kind === "ran"
        ? (() => {
          const m = pattern.exec(out.output)
          // The whole token, without its packaging suffix ("6.1.1-3ubuntu5" is shown and judged as 6.1.1).
          if (m !== null) return { found: true, version: m[1]?.replace(entry?.probe.packaging ?? DEB_REVISION, ""), packaging: entry?.probe.packaging }
          // It ran but did not say what it is: present when it exited cleanly, else not recognised.
          return out.exitCode === 0 ? { found: true, version: undefined } : { found: false, why: "not-recognised" }
        })()
        : out.kind === "failed"
        ? { found: false, why: "failed", message: out.message }
        : { found: false, why: out.kind }
      cache.set(tool, result)
      if (out.kind === "ran") ranOutput.set(tool, { exitCode: out.exitCode, output: out.output.slice(0, 64 * 1024) })
      else ranOutput.delete(tool)
    })

  const toolsOf = (requirements: ReadonlyArray<Requirement>): Array<string> => {
    const names = new Set<string>()
    for (const r of requirements) {
      if ("tool" in r && (r.where ?? "server") === "server") names.add(r.tool)
      else if ("gpu" in r) names.add(gpuTool(r.gpu))
    }
    return [...names]
  }

  const probe: RequirementChecker["probe"] = (requirements, probeOptions = {}) =>
    Effect.suspend(() => {
      const wanted = toolsOf(requirements).filter((t) => probeOptions.force === true || !cache.has(t))
      return Effect.forEach(wanted, probeOne, { concurrency: "unbounded", discard: true })
    })

  const judgeTool = (r: Extract<Requirement, { readonly tool: string }>): RequirementStatus => {
    const entry = tools[r.tool]
    const p = cache.get(r.tool)
    if (p === undefined || !p.found) {
      const detail = p === undefined || p.why === "missing"
        ? `${r.tool} is missing`
        : p.why === "timeout"
        ? `${r.tool} did not answer within ${Math.round(timeoutMs / 1000)} s`
        : p.why === "not-recognised"
        ? `${r.tool} did not report its version`
        : `${r.tool} could not be run${p.message !== undefined ? ` (${p.message})` : ""}`
      return { requirement: r, state: "missing", detail, fix: installFix(r.tool, entry, distro) }
    }
    const shown = p.version === undefined ? `${r.tool} is installed` : `${r.tool} ${p.version}`
    if (r.version === undefined || r.version.trim() === "") return { requirement: r, state: "met", detail: shown }
    // Fail closed: a version requirement that cannot be proven is not met.
    if (semver.validRange(r.version) === null) {
      return { requirement: r, state: "missing", detail: `${r.tool}: the version range "${r.version}" cannot be read, so ${r.tool} cannot be checked` }
    }
    if (p.version === undefined) {
      return { requirement: r, state: "missing", detail: `${r.tool} did not report its version; needs ${r.version}`, fix: installFix(r.tool, entry, distro, "Update") }
    }
    const ok = satisfiesRange(p.version, r.version, p.packaging)
    if (ok === undefined) {
      return { requirement: r, state: "missing", detail: `${r.tool} reported "${p.version}", which is not a version; needs ${r.version}`, fix: installFix(r.tool, entry, distro, "Update") }
    }
    return ok
      ? { requirement: r, state: "met", detail: shown }
      : { requirement: r, state: "missing", detail: `${r.tool} ${p.version} does not match ${r.version}`, fix: installFix(r.tool, entry, distro, "Update") }
  }

  const check: RequirementCheck = (requirements) =>
    requirements.map((r): RequirementStatus => {
      if ("tool" in r) {
        if ((r.where ?? "server") !== "server") return { requirement: r, state: "unchecked", detail: `${r.tool} on the device (not checked yet)` }
        return judgeTool(r)
      }
      if ("network" in r) return { requirement: r, state: "unchecked", detail: r.network === "internet" ? "internet access (not checked)" : "the local network (not checked)" }
      if ("memoryMb" in r) {
        const has = memoryMb()
        return has >= r.memoryMb
          ? { requirement: r, state: "met", detail: `${has} MB of memory` }
          : { requirement: r, state: "missing", detail: `Needs ${r.memoryMb} MB of memory; this server has ${has} MB` }
      }
      if ("diskMb" in r) {
        const free = freeDiskMb()
        if (free === undefined) return { requirement: r, state: "unchecked", detail: "free disk space (could not be read)" }
        return free >= r.diskMb
          ? { requirement: r, state: "met", detail: `${free} MB free` }
          : { requirement: r, state: "missing", detail: `Needs ${r.diskMb} MB of free disk space; ${free} MB is free in ${options.dataDir}` }
      }
      return judgeGpu(r)
    })

  /**
   * A `gpu` requirement, judged on the device the program lists, never on the program alone: met only for a hardware
   * device (a CUDA GPU in `nvidia-smi -L`; a discrete, integrated or virtual GPU in `vulkaninfo --summary`, not
   * Mesa's CPU renderer llvmpipe); missing only when the program ran and showed there is none; `unchecked` (never
   * a pass, never unavailable) when the device cannot be judged here (the program is not installed, timed out, or
   * printed something this server cannot read).
   */
  const judgeGpu = (r: Extract<Requirement, { readonly gpu: unknown }>): RequirementStatus => {
    const tool = gpuTool(r.gpu)
    const name = r.gpu === "cuda" ? "a CUDA graphics card" : "a Vulkan graphics device"
    const ran = ranOutput.get(tool)
    const p = cache.get(tool)
    if (ran === undefined) {
      const why = p === undefined || (!p.found && p.why === "missing") ? `${tool} is not installed` : !p.found && p.why === "timeout" ? `${tool} did not answer` : `${tool} could not be run`
      return { requirement: r, state: "unchecked", detail: `${name}: not checked (${why}, so the device cannot be seen)`, fix: installFix(tool, tools[tool], distro) }
    }
    if (r.gpu === "cuda") {
      const gpus = [...ran.output.matchAll(/^GPU \d+: (.+?)(?: \(UUID[^)]*\))?\s*$/gm)].map((m) => m[1]!.trim())
      if (gpus.length > 0) return { requirement: r, state: "met", detail: `${gpus[0]} (CUDA)` }
      if (/No devices were found/i.test(ran.output) || (ran.exitCode === 0 && ran.output.trim() === "")) {
        return { requirement: r, state: "missing", detail: `Needs ${name}; nvidia-smi lists none` }
      }
      return { requirement: r, state: "unchecked", detail: `${name}: not checked (nvidia-smi printed something this server cannot read)` }
    }
    const types = [...ran.output.matchAll(/deviceType\s*=\s*PHYSICAL_DEVICE_TYPE_(\w+)/g)].map((m) => m[1]!)
    const names = [...ran.output.matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1]!.trim())
    const hardware = types.findIndex((t) => t === "DISCRETE_GPU" || t === "INTEGRATED_GPU" || t === "VIRTUAL_GPU")
    if (hardware >= 0) return { requirement: r, state: "met", detail: `${names[hardware] ?? "a graphics device"} (Vulkan)` }
    if (types.length > 0) {
      return { requirement: r, state: "missing", detail: `Needs ${name}; Vulkan finds only a software renderer (${names[0] ?? "on the processor"})` }
    }
    if (/ERROR_INCOMPATIBLE_DRIVER|Cannot create Vulkan instance|ERROR_INITIALIZATION_FAILED/.test(ran.output)) {
      return { requirement: r, state: "missing", detail: `Needs ${name}; Vulkan finds no driver or device` }
    }
    return { requirement: r, state: "unchecked", detail: `${name}: not checked (vulkaninfo printed something this server cannot read)` }
  }

  return {
    check,
    probe,
    probeCatalog: (catalog, probeOptions) => probe(catalog.flatMap((d) => d.requires ?? []), probeOptions),
    markMissing: (tool) => {
      cache.set(tool, { found: false, why: "missing" })
      ranOutput.delete(tool)
    },
    probed: (tool) => cache.get(tool)
  }
}
