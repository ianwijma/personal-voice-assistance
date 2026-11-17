import type { IssueFix, ModuleDefinition, Requirement, RequirementCheck, RequirementStatus } from "@pva/core"
import { Effect } from "effect"
import { execFile } from "node:child_process"
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
  /** The version command (no shell) and where the version is in its output (first capture group; none: any output). */
  readonly probe: { readonly argv: ReadonlyArray<string>; readonly version: RegExp }
  /** The package that installs it, per distribution family. */
  readonly packages?: { readonly debian?: string; readonly arch?: string; readonly nix?: string }
}

/** The programs this assistant knows how to check (modules name them in `requires`). */
export const TOOL_REGISTRY: Readonly<Record<string, ToolEntry>> = {
  ffmpeg: { probe: { argv: ["ffmpeg", "-version"], version: /ffmpeg version n?(\d+(?:\.\d+)+)/ }, packages: { debian: "ffmpeg", arch: "ffmpeg", nix: "ffmpeg" } },
  ffprobe: { probe: { argv: ["ffprobe", "-version"], version: /ffprobe version n?(\d+(?:\.\d+)+)/ }, packages: { debian: "ffmpeg", arch: "ffmpeg", nix: "ffmpeg" } },
  "yt-dlp": { probe: { argv: ["yt-dlp", "--version"], version: /(\d{4}\.\d+\.\d+)/ }, packages: { debian: "yt-dlp", arch: "yt-dlp", nix: "yt-dlp" } },
  mpv: { probe: { argv: ["mpv", "--version"], version: /mpv v?(\d+(?:\.\d+)+)/ }, packages: { debian: "mpv", arch: "mpv", nix: "mpv" } },
  sox: { probe: { argv: ["sox", "--version"], version: /v(\d+(?:\.\d+)+)/ }, packages: { debian: "sox", arch: "sox", nix: "sox" } },
  tar: { probe: { argv: ["tar", "--version"], version: /(\d+\.\d+(?:\.\d+)?)/ }, packages: { debian: "tar", arch: "tar", nix: "gnutar" } },
  bzip2: { probe: { argv: ["bzip2", "-h"], version: /Version (\d+\.\d+(?:\.\d+)?)/ }, packages: { debian: "bzip2", arch: "bzip2", nix: "bzip2" } },
  flock: { probe: { argv: ["flock", "--version"], version: /(\d+\.\d+(?:\.\d+)?)/ }, packages: { debian: "util-linux", arch: "util-linux", nix: "util-linux" } },
  nice: { probe: { argv: ["nice", "--version"], version: /(\d+\.\d+(?:\.\d+)?)/ }, packages: { debian: "coreutils", arch: "coreutils", nix: "coreutils" } },
  git: { probe: { argv: ["git", "--version"], version: /git version (\d+(?:\.\d+)+)/ }, packages: { debian: "git", arch: "git", nix: "git" } },
  python3: { probe: { argv: ["python3", "--version"], version: /Python (\d+(?:\.\d+)+)/ }, packages: { debian: "python3", arch: "python", nix: "python3" } },
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

const parts = (v: string): Array<number> => v.split(/[.-]/).map((p) => Number.parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : 0))

const compare = (a: string, b: string): number => {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Whether `version` lies in `range`: space-separated comparators, all of which must hold: `>=1.2`, `>1`, `<2`,
 * `<=2.1`, `=1.4`, `1.4` (the same as `=`), `^1.2` (same major), `~1.2` (same major and minor). Returns `undefined`
 * for a range it cannot read.
 */
export const satisfiesRange = (version: string, range: string): boolean | undefined => {
  const comparators = range.trim().split(/\s+/).filter((c) => c.length > 0)
  if (comparators.length === 0) return true
  for (const c of comparators) {
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.\d+)*)$/.exec(c)
    if (m === null) return undefined
    const op = m[1] ?? "="
    const target = m[2]!
    const d = compare(version, target)
    const [major, minor] = parts(target)
    const [vMajor, vMinor] = parts(version)
    const ok = op === ">=" ? d >= 0
      : op === "<=" ? d <= 0
      : op === ">" ? d > 0
      : op === "<" ? d < 0
      : op === "^" ? d >= 0 && vMajor === major
      : op === "~" ? d >= 0 && vMajor === major && vMinor === (minor ?? vMinor)
      : compare(version, target) === 0 || (target.split(".").length < version.split(".").length && version.startsWith(`${target}.`))
    if (!ok) return false
  }
  return true
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
  | { readonly found: true; readonly version: string | undefined }
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

  const probeOne = (tool: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      const entry = tools[tool]
      const argv = entry?.probe.argv ?? [tool, "--version"]
      const pattern = entry?.probe.version ?? /(\d+(?:\.\d+)+)/
      let out: ProbeOutput
      try {
        out = await prober(argv, { timeoutMs, path })
      } catch (error) {
        out = { kind: "failed", message: error instanceof Error ? error.message : String(error) }
      }
      const result: ToolProbe = out.kind === "ran"
        ? (() => {
          const m = pattern.exec(out.output)
          if (m !== null) return { found: true, version: m[1] }
          // It ran but did not say what it is: present when it exited cleanly, else not recognised.
          return out.exitCode === 0 ? { found: true, version: undefined } : { found: false, why: "not-recognised" }
        })()
        : out.kind === "failed"
        ? { found: false, why: "failed", message: out.message }
        : { found: false, why: out.kind }
      cache.set(tool, result)
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
    if (p.version === undefined) return { requirement: r, state: "met", detail: `${shown} (version not reported; needs ${r.version})` }
    const ok = satisfiesRange(p.version, r.version)
    if (ok === undefined) return { requirement: r, state: "met", detail: `${shown} (the range "${r.version}" could not be read)` }
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
      const tool = gpuTool(r.gpu)
      const p = cache.get(tool)
      const name = r.gpu === "cuda" ? "a CUDA graphics card" : "a Vulkan graphics device"
      return p?.found === true
        ? { requirement: r, state: "met", detail: `${name} (${tool})` }
        : { requirement: r, state: "missing", detail: `Needs ${name}; ${tool} found none`, fix: installFix(tool, tools[tool], distro) }
    })

  return {
    check,
    probe,
    probeCatalog: (catalog, probeOptions) => probe(catalog.flatMap((d) => d.requires ?? []), probeOptions),
    markMissing: (tool) => {
      cache.set(tool, { found: false, why: "missing" })
    },
    probed: (tool) => cache.get(tool)
  }
}
