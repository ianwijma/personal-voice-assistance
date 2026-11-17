import { type Issue, type Requirement } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Cause, Effect, Exit } from "effect"
import { execFile } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { createServer } from "node:net"
import { freeMbOf, type RequirementChecker } from "./requirements.ts"
import { sherpaOptionsOf, type SttShared, sttSpecOf } from "./serve/Resources.ts"

/**
 * The core checks (module-definition-config-and-dependencies.md §C.5): what the assistant itself needs on this
 * machine, as issues with fixes. `pnpm start doctor` runs them with every module's requirements and health; serve
 * mode runs them at start and on "Check again" for the Health page (without the port check: it holds the port).
 * Nothing here runs on a turn.
 */

/** The oldest Node this runs on (`package.json` engines). */
export const MIN_NODE = "22.18.0"

export interface CoreCheckOptions {
  /** Probes `tar`, `bzip2`, `flock` and `nice` (the cache is shared with the modules' requirements). */
  readonly checker: RequirementChecker
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dataDir: string
  /** The recognisers' and voices' model directories. */
  readonly modelDirs: { readonly stt: string; readonly tts: string }
  /** Default: this process's. */
  readonly nodeVersion?: string
  /** Serve mode: the port is the server's own, so it is not checked. */
  readonly serving: boolean
  /** The key vault as it was found (undefined: not read). */
  readonly vault?: { readonly state: "none" | "locked" | "unlocked"; readonly path: string } | { readonly error: string }
  /** The assistants in effect, for their model files. */
  readonly assistants?: ReadonlyArray<Assistant>
  /** The shared recogniser settings (model directory, threads). */
  readonly sttShared?: SttShared
  /** For tests. */
  readonly freeMb?: (dir: string) => number | undefined
  readonly portFree?: (host: string, port: number) => Promise<"free" | "in-use" | "denied" | "error">
  readonly clockSynced?: () => Promise<boolean | undefined>
  readonly readable?: (file: string) => boolean
  /** The problem with one recogniser's model files, or `undefined` when they are there. Default: `SherpaStt.check`. */
  readonly checkStt?: (assistant: Assistant) => string | undefined
}

const compareVersions = (a: string, b: string): number => {
  const x = a.split(".").map(Number)
  const y = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The programs core needs, as requirements (the same registry and cache as the modules'). */
const CORE_TOOLS: ReadonlyArray<{ readonly tool: string; readonly severity: "error" | "warning"; readonly why: string }> = [
  { tool: "flock", severity: "error", why: "serve mode takes the data directory's writer lock with it; without it the server refuses to start." },
  { tool: "tar", severity: "warning", why: "Model downloads are unpacked with it." },
  { tool: "bzip2", severity: "warning", why: "Model downloads are bzip2 archives." },
  { tool: "nice", severity: "warning", why: "Model downloads are unpacked at low priority with it." }
]

const defaultPortFree = (host: string, port: number): Promise<"free" | "in-use" | "denied" | "error"> =>
  new Promise((resolve) => {
    const server = createServer()
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE" ? "in-use" : e.code === "EACCES" ? "denied" : "error"))
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve("free")))
  })

/** `timedatectl`'s NTPSynchronized; `undefined` where it does not exist (not systemd). */
const defaultClockSynced = (): Promise<boolean | undefined> =>
  new Promise((resolve) => {
    try {
      const child = execFile("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { timeout: 5_000, shell: false, env: { PATH: "/usr/bin:/bin" } }, (error, stdout) => {
        if (error !== null) return resolve(undefined)
        const v = String(stdout).trim()
        resolve(v === "yes" ? true : v === "no" ? false : undefined)
      })
      child.stdin?.end()
    } catch {
      resolve(undefined)
    }
  })

const defaultReadable = (file: string): boolean => {
  try {
    accessSync(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export const runCoreChecks = (options: CoreCheckOptions): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.gen(function*() {
    const issues: Array<Issue> = []
    const freeMb = options.freeMb ?? freeMbOf

    // Node
    const node = options.nodeVersion ?? process.versions.node
    if (compareVersions(node, MIN_NODE) < 0) {
      issues.push({
        id: "core.node",
        severity: "error",
        title: `Node ${node} is older than ${MIN_NODE}`,
        detail: "The assistant runs on Node 22.18 or newer.",
        fix: { kind: "link", label: "Install Node 22.18 or newer", value: "https://nodejs.org/en/download" }
      })
    }

    // Programs
    const requirements: ReadonlyArray<Requirement> = CORE_TOOLS.map((t) => ({ tool: t.tool, why: t.why }))
    yield* options.checker.probe(requirements, { force: true })
    options.checker.check(requirements).forEach((status, i) => {
      if (status.state !== "missing") return
      const t = CORE_TOOLS[i]!
      issues.push({ id: `core.tool.${t.tool}`, severity: t.severity, title: status.detail, detail: t.why, ...(status.fix !== undefined ? { fix: status.fix } : {}) })
    })

    // Disk space
    const places: ReadonlyArray<readonly [string, string]> = [["data", options.dataDir], ["stt-models", options.modelDirs.stt], ["tts-models", options.modelDirs.tts]]
    const seen = new Set<string>()
    for (const [name, dir] of places) {
      if (seen.has(dir) || !existsSync(dir)) continue
      seen.add(dir)
      const free = freeMb(dir)
      if (free === undefined) continue
      if (free < 1024) {
        issues.push({
          id: `core.disk.${name}`,
          severity: free < 200 ? "error" : "warning",
          title: `Only ${free} MB free in ${dir}`,
          detail: free < 200 ? "Saving settings and recordings may fail." : "A model download needs up to a few gigabytes.",
          fix: { kind: "command", label: "Make room", value: `df -h ${dir}` }
        })
      }
    }

    // The model files of every assistant's hearing and voice
    for (const assistant of options.assistants ?? []) {
      if (!assistant.on) continue
      const stt = options.checkStt !== undefined ? options.checkStt(assistant) : defaultCheckStt(assistant, options.sttShared)
      if (stt !== undefined) {
        issues.push({
          id: `core.models.stt.${assistant.id}`,
          severity: "error",
          title: `${assistant.name} cannot hear: the recogniser's model files are missing`,
          detail: stt,
          fix: { kind: "link", label: "Download it", value: "#settings/shared/speech" }
        })
      }
      if (assistant.voice.provider === "sherpa") {
        const preset = Object.hasOwn(SherpaTts.presets, assistant.voice.voiceId) ? SherpaTts.presets[assistant.voice.voiceId] : undefined
        if (preset === undefined || !SherpaTts.isInstalled(preset.name, options.modelDirs.tts)) {
          issues.push({
            id: `core.models.tts.${assistant.id}`,
            severity: "error",
            title: `${assistant.name}'s voice is not downloaded`,
            detail: preset === undefined ? `There is no voice "${assistant.voice.voiceId}" on this machine.` : `${preset.voice.name} (${preset.sizeMb} MB) is missing from ${options.modelDirs.tts}.`,
            fix: { kind: "link", label: "Download it", value: "#settings/shared/providers" }
          })
        }
      }
    }

    // The key vault
    const vault = options.vault
    if (vault !== undefined) {
      if ("error" in vault) {
        issues.push({ id: "core.vault", severity: "error", title: "The key vault cannot be read", detail: vault.error })
      } else if (vault.state === "none") {
        issues.push({
          id: "core.vault",
          severity: "info",
          title: "There is no key vault",
          detail: `Keys are kept unencrypted in ${options.dataDir}/secrets.json until you set a vault password.`,
          fix: { kind: "link", label: "Set a vault password", value: "#settings/keys/access" }
        })
      } else if (vault.state === "locked") {
        issues.push({
          id: "core.vault",
          severity: options.serving ? "warning" : "info",
          title: "The key vault is locked",
          detail: "Modules and engines that need a key do not run until it is unlocked (or PVA_VAULT_PASSWORD is set).",
          fix: { kind: "link", label: "Unlock it", value: "#settings/keys/access" }
        })
      }
    }

    // TLS and the port
    const cert = options.env.SERVE_TLS_CERT ?? ""
    const key = options.env.SERVE_TLS_KEY ?? ""
    const readable = options.readable ?? defaultReadable
    for (const [name, file] of [["SERVE_TLS_CERT", cert], ["SERVE_TLS_KEY", key]] as const) {
      if (file !== "" && !readable(file)) {
        issues.push({ id: `core.tls.${name}`, severity: "error", title: `${name} cannot be read`, detail: `${file} does not exist or is not readable by this user.` })
      }
    }
    if ((cert === "") !== (key === "")) {
      issues.push({ id: "core.tls.pair", severity: "warning", title: "Only one of SERVE_TLS_CERT and SERVE_TLS_KEY is set", detail: "Both are needed for HTTPS; the server serves plain HTTP." })
    }
    const host = options.env.SERVE_HOST === undefined || options.env.SERVE_HOST === "" ? "127.0.0.1" : options.env.SERVE_HOST
    if (cert === "" && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      issues.push({
        id: "core.tls.missing",
        severity: "warning",
        title: "Served without HTTPS on the network",
        detail: "Browsers allow the microphone only on https:// or localhost.",
        fix: { kind: "link", label: "Set up HTTPS", value: "README.md" }
      })
    }
    if (!options.serving) {
      const port = Number.parseInt(options.env.SERVE_PORT ?? "8787", 10)
      if (Number.isInteger(port) && port > 0 && port < 65_536) {
        const free = yield* Effect.promise(() => (options.portFree ?? defaultPortFree)(host, port))
        if (free === "in-use") {
          issues.push({ id: "core.port", severity: "warning", title: `Port ${port} is in use`, detail: "Another program listens on it; if it is this assistant, that is expected.", fix: { kind: "command", label: "See what uses it", value: `ss -ltnp 'sport = :${port}'` } })
        } else if (free === "denied") {
          issues.push({ id: "core.port", severity: "error", title: `Port ${port} may not be used by this user`, detail: "Ports below 1024 need extra rights; choose another SERVE_PORT." })
        }
      }
    }

    // The clock
    const synced = yield* Effect.promise(() => (options.clockSynced ?? defaultClockSynced)())
    if (synced === false) {
      issues.push({
        id: "core.clock",
        severity: "warning",
        title: "The clock is not synchronised",
        detail: "Times, timers and reminders may be off.",
        fix: { kind: "command", label: "Turn on time synchronisation", value: "sudo timedatectl set-ntp true" }
      })
    }
    return issues
  })

const defaultCheckStt = (assistant: Assistant, shared: SttShared | undefined): string | undefined => {
  if (assistant.hearing.engine !== "sherpa") return undefined
  const spec = sttSpecOf(assistant.hearing, shared)
  if (spec.engine !== "sherpa") return undefined
  const exit = Effect.runSyncExit(SherpaStt.check(sherpaOptionsOf(spec, spec.stream)))
  if (Exit.isSuccess(exit)) return undefined
  const failure = Cause.squash(exit.cause)
  return failure instanceof Error ? failure.message : String(failure)
}
