import type { IssueFix, ModuleDefinition, Requirement, RequirementCheck, RequirementStatus } from "@pva/core"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import semver from "semver"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Module requirements, judged on this server (module-definition-config-and-dependencies.md §C.3; docs/MODULES-PLAN.md
 * §4 P1). Two kinds: a program on the server, with an optional semver range, and the network (not probed yet). One
 * registry of the programs modules may need (how to find and check each, which package installs it), probes that
 * run each program's version command with no shell and a 5 s timeout on a fixed `PATH` (the data directory's
 * `tools/bin` first), and a cache the module host reads synchronously. Probes run at start and on "Check again",
 * never on a turn.
 *
 * The registry starts **empty**: no first version of a module needs a program. The PR of the first module that
 * needs one adds its entry here (tests use their own entries, `RequirementCheckerOptions.tools`).
 */

/** How to find, check and install one program. */
export interface ToolEntry {
  /**
   * The version command (no shell) and where the version is in its output: the first capture group, which must be a
   * strict semver version (`6.1.0`, `0.35.0-rc.1`, `1.2.3+build.5`); anything else counts as an unknown version.
   * No pattern: the program is only looked for, its version is unknown.
   */
  readonly probe: { readonly argv: ReadonlyArray<string>; readonly version?: RegExp }
  /** The package that installs it, per distribution family. */
  readonly packages?: { readonly debian?: string; readonly arch?: string; readonly nix?: string }
}

/** The programs this assistant knows how to check (modules name them in `requires`). Empty in this version. */
export const TOOL_REGISTRY: ReadonlyMap<string, ToolEntry> = new Map()

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
          // A version command that exits non-zero but printed something still ran.
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

/** semver.org's own pattern of a valid version: no `v`, no leading zeros, prerelease and build parts as specified. */
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** The version a probe read, if it is strict semver; anything else (`6.1`, `v1.0.0`, `2025.01.15`) is `undefined`: unknown. */
export const strictVersion = (token: string | undefined): string | undefined =>
  token !== undefined && STRICT_SEMVER.test(token) && semver.valid(token) !== null ? token : undefined

/**
 * Whether `version` lies in `range` (node-semver: comparators, `||`, `^`, `~`, `x` and hyphen ranges). A prerelease
 * satisfies a range only if the range allows it (names a prerelease of the same version). `undefined` when the
 * range cannot be read or the version is unknown: never a pass.
 */
export const satisfiesRange = (version: string | undefined, range: string): boolean | undefined => {
  if (semver.validRange(range) === null) return undefined
  const strict = strictVersion(version)
  if (strict === undefined) return undefined
  return semver.satisfies(strict, range)
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

/** A probed program: its version (strict semver, or `undefined`: unknown), or why it was not found. */
export type ToolProbe =
  | { readonly found: true; readonly version: string | undefined; readonly reported?: string }
  | { readonly found: false; readonly why: "missing" | "timeout" | "failed" | "not-recognised" | "unknown-program"; readonly message?: string }

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
  /**
   * A spawn of `tool` failed with ENOENT or EACCES: it is missing from now on, until a probe that starts after this
   * finds it (a probe already running when this is reported cannot undo it).
   */
  readonly markMissing: (tool: string) => void
  /** What the cache knows about one program (tests, `doctor`). */
  readonly probed: (tool: string) => ToolProbe | undefined
}

export interface RequirementCheckerOptions {
  readonly dataDir: string
  readonly prober?: Prober
  /** The program registry. Default: `TOOL_REGISTRY` (empty). */
  readonly tools?: ReadonlyMap<string, ToolEntry>
  readonly timeoutMs?: number
  readonly distro?: Distro
}

/** How the owner updates the assistant (README "Quick start": a git checkout with pnpm), run in its directory. */
export const UPDATE_FIX = { kind: "command" as const, label: "Update the assistant, then restart it", value: "git pull && pnpm install" }

export const makeRequirementChecker = (options: RequirementCheckerOptions): RequirementChecker => {
  const prober = options.prober ?? execProber
  // A Map: a program named "constructor" or "__proto__" is an unknown program, never an inherited property.
  const tools: ReadonlyMap<string, ToolEntry> = new Map(options.tools ?? TOOL_REGISTRY)
  const timeoutMs = options.timeoutMs ?? 5_000
  const distro = "distro" in options ? options.distro : detectDistro()
  const path = probePath(options.dataDir)
  const cache = new Map<string, ToolProbe>()
  /** Per program: the number of the last probe or report; an older probe's result is dropped. */
  const ticket = new Map<string, number>()
  let tickets = 0

  const probeOne = (tool: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      const mine = ++tickets
      ticket.set(tool, mine)
      const entry = tools.get(tool)
      let result: ToolProbe
      if (entry === undefined) result = { found: false, why: "unknown-program" }
      else {
        let out: ProbeOutput
        try {
          out = await prober(entry.probe.argv, { timeoutMs, path })
        } catch (error) {
          out = { kind: "failed", message: error instanceof Error ? error.message : String(error) }
        }
        if (out.kind === "ran") {
          // A fresh pattern per probe: a global or sticky one (`/g`, `/y`) keeps `lastIndex` between calls.
          const pattern = entry.probe.version
          const m = pattern === undefined ? undefined : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).exec(out.output)
          const reported = m?.[1]
          // It ran: found when it exited cleanly or printed its version; the version only if it is strict semver.
          result = reported !== undefined || out.exitCode === 0
            ? { found: true, version: strictVersion(reported), ...(reported !== undefined ? { reported: reported.slice(0, 60) } : {}) }
            : { found: false, why: "not-recognised" }
        } else result = out.kind === "failed" ? { found: false, why: "failed", message: out.message } : { found: false, why: out.kind }
      }
      // A report or a probe that started after this one has the newer word.
      if (ticket.get(tool) === mine) cache.set(tool, result)
    })

  const toolsOf = (requirements: ReadonlyArray<Requirement>): Array<string> => [...new Set(requirements.flatMap((r) => ("tool" in r ? [r.tool] : [])))]

  const probe: RequirementChecker["probe"] = (requirements, probeOptions = {}) =>
    Effect.suspend(() => {
      const wanted = toolsOf(requirements).filter((t) => probeOptions.force === true || !cache.has(t))
      return Effect.forEach(wanted, probeOne, { concurrency: "unbounded", discard: true })
    })

  const judgeTool = (r: Extract<Requirement, { readonly tool: string }>): RequirementStatus => {
    const entry = tools.get(r.tool)
    const p = cache.get(r.tool)
    if (p === undefined || !p.found) {
      const detail = p !== undefined && p.why === "unknown-program"
        ? `${r.tool} is not a program this assistant knows how to check`
        : p === undefined || p.why === "missing"
        ? `${r.tool} is missing`
        : p.why === "timeout"
        ? `${r.tool} did not answer within ${Math.round(timeoutMs / 1000)} s`
        : p.why === "not-recognised"
        ? `${r.tool} did not report its version`
        : `${r.tool} could not be run${p.message !== undefined ? ` (${p.message})` : ""}`
      // A program this version does not know: a newer assistant may (there is no update page in the admin app).
      const fix = p !== undefined && p.why === "unknown-program" ? UPDATE_FIX : installFix(r.tool, entry, distro)
      return { requirement: r, state: "missing", detail, fix }
    }
    const shown = p.version !== undefined ? `${r.tool} ${p.version}` : p.reported !== undefined ? `${r.tool} ${p.reported}` : `${r.tool} is installed`
    if (r.version === undefined || r.version.trim() === "") return { requirement: r, state: "met", detail: shown }
    // Fail closed: a version requirement that cannot be proven is not met.
    if (semver.validRange(r.version) === null) {
      return { requirement: r, state: "missing", detail: `${r.tool}: the version range "${r.version}" cannot be read, so ${r.tool} cannot be checked` }
    }
    if (p.version === undefined) {
      const why = p.reported === undefined ? "did not report its version" : `reported "${p.reported}", which is not a semver version`
      return { requirement: r, state: "missing", detail: `${r.tool} ${why}; needs ${r.version}`, fix: installFix(r.tool, entry, distro, "Update") }
    }
    return satisfiesRange(p.version, r.version) === true
      ? { requirement: r, state: "met", detail: shown }
      : { requirement: r, state: "missing", detail: `${r.tool} ${p.version} does not match ${r.version}`, fix: installFix(r.tool, entry, distro, "Update") }
  }

  const check: RequirementCheck = (requirements) =>
    requirements.map((r): RequirementStatus =>
      "tool" in r
        ? judgeTool(r)
        : { requirement: r, state: "unchecked", detail: r.network === "internet" ? "internet access (not checked)" : "the local network (not checked)" }
    )

  return {
    check,
    probe,
    probeCatalog: (catalog, probeOptions) => probe(catalog.flatMap((d) => d.requires ?? []), probeOptions),
    markMissing: (tool) => {
      ticket.set(tool, ++tickets)
      cache.set(tool, { found: false, why: "missing" })
    },
    probed: (tool) => cache.get(tool)
  }
}
