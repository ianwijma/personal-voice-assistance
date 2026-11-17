import { type Issue, type IssueRegistry, makeIssueRegistry, makeModuleHost, type ModuleDefinition, oneLine, readOnlyPersistence, type RequirementStatus } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { Effect } from "effect"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { askVaultPassword } from "./cliSettings.ts"
import { moduleCatalog, moduleDemandOf } from "./modules.ts"
import { makeRequirementChecker, type Prober, type ToolEntry } from "./requirements.ts"
import { DataDirConfig, loadSettingsStore } from "./serve/SettingsStore.ts"
import { openVault, type Vault, VaultPathConfig } from "./serve/Vault.ts"

/**
 * `pnpm start doctor` (module-definition-config-and-dependencies.md §C.5, after `brew doctor`): every module's
 * requirements and `health()`, on the saved settings, read-only (nothing is started or written). One line per module
 * (its requirements as judged, and its health: healthy, issues, not checked, or no check), then one line per issue
 * with its fix; the exit code is 1 when there is an error. It says nothing about the machine itself (disk, TLS
 * files, the port, speech models: the deployment work, docs/MODULES-PLAN.md §7).
 *
 * The saved settings and the key vault must be readable: doctor never falls back to defaults, which would judge a
 * different assistant than the one installed. When either cannot be read it says why and exits with 2.
 */

export interface DoctorOptions {
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dataDir: string
  /** The saved module settings and keys (read-only). */
  readonly persistence?: Parameters<typeof readOnlyPersistence>[0]
  /** The assistants in effect: which modules are in use. */
  readonly assistants?: ReadonlyArray<Assistant>
  readonly platform?: { readonly os: string; readonly arch: string }
  /** For tests: the probes and the program registry. */
  readonly prober?: Prober
  readonly tools?: ReadonlyMap<string, ToolEntry>
}

/** One module as doctor judged it: its requirements, and its health check. */
export interface DoctorModule {
  readonly id: string
  /** Why it cannot run here, if it cannot. */
  readonly unavailable?: string
  readonly requirements: ReadonlyArray<RequirementStatus>
  /** `none`: it has no health check; `not-checked`: it cannot run here, so it was not asked. */
  readonly health: "none" | "not-checked" | "healthy" | { readonly issues: number }
}

export interface DoctorReport {
  readonly modules: ReadonlyArray<DoctorModule>
  readonly issues: ReadonlyArray<Issue>
}

/** Every module and every issue doctor finds. Modules are judged, never started. */
export const runDoctor = (options: DoctorOptions): Effect.Effect<DoctorReport> =>
  Effect.scoped(Effect.gen(function*() {
    const checker = makeRequirementChecker({
      dataDir: options.dataDir,
      ...(options.prober !== undefined ? { prober: options.prober } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {})
    })
    yield* checker.probeCatalog(options.catalog, { force: true })
    // Which modules the assistants use (serve mode's demand, read-only: nothing starts): a module one of them has on,
    // or one such a module names in `uses`, is an error when it cannot run; a module nobody uses only a warning.
    const demand = options.assistants === undefined ? undefined : moduleDemandOf(options.catalog, options.assistants)
    // What each module's own health check reported (its source `health:<id>`), counted as it is set.
    const healthCounts = new Map<string, number>()
    const base = makeIssueRegistry()
    const registry: IssueRegistry = {
      ...base,
      set: (source, list) => {
        if (source.startsWith("health:")) healthCounts.set(source.slice("health:".length), list.length)
        base.set(source, list)
      }
    }
    const host = yield* makeModuleHost({
      issues: registry,
      catalog: options.catalog,
      persistence: readOnlyPersistence(options.persistence),
      env: options.env,
      platform: options.platform ?? { os: process.platform, arch: process.arch },
      requirements: checker.check,
      localPrincipal: true,
      ...(demand !== undefined ? { demand: () => demand } : {})
    })
    yield* host.evaluate
    yield* host.checkHealth
    const issues = host.issues.all()
    const infos = new Map(host.modules().map((m) => [m.id, m]))
    const modules = options.catalog.map((def): DoctorModule => {
      const unavailable = infos.get(def.id)?.unavailable?.reason
      const requires = def.requires ?? []
      const reported = healthCounts.get(def.id)
      return {
        id: def.id,
        ...(unavailable !== undefined ? { unavailable } : {}),
        requirements: requires.length === 0 ? [] : checker.check(requires),
        health: def.health === undefined ? "none" : unavailable !== undefined || reported === undefined ? "not-checked" : reported === 0 ? "healthy" : { issues: reported }
      }
    })
    return { modules, issues }
  }))

const LABEL: Readonly<Record<Issue["severity"], string>> = { error: "error  ", warning: "warning", info: "info   " }

/** A module's line: `module  <id>: <each requirement as judged>; health: <healthy | N issues | not checked | no check>.` */
const moduleLine = (m: DoctorModule): string => {
  const requirement = (st: RequirementStatus) => {
    const r = st.requirement
    const name = "tool" in r ? `${oneLine(r.tool, 60)}${r.version !== undefined ? ` ${oneLine(r.version, 40)}` : ""}` : `network (${r.network})`
    const judged = st.state === "unchecked" ? "not checked" : `${st.state} (${oneLine(st.detail, 120)})`
    return `${name}${r.optional === true ? " (optional)" : ""} ${judged}`
  }
  const requires = m.requirements.length === 0 ? "no requirements" : `requires ${m.requirements.map(requirement).join(", ")}`
  const health = m.health === "none"
    ? "no health check"
    : m.health === "not-checked"
    ? "health not checked"
    : m.health === "healthy"
    ? "healthy"
    : `health: ${m.health.issues} issue${m.health.issues === 1 ? "" : "s"}`
  const unavailable = m.unavailable === undefined ? "" : `cannot run here (${oneLine(m.unavailable, 200)}); `
  return `module  ${oneLine(m.id, 60)}: ${unavailable}${requires}; ${health}.`
}

/**
 * One line per module (`moduleLine`), then one line per issue (`<severity> <module> (<device>): <title>. <detail> →
 * <fix>`), a summary, and the exit code. Every piece of text is one line with no control characters (an issue's text
 * comes from modules and probes: it cannot add lines or move the terminal's cursor), and each line is at most 1,000
 * characters.
 */
export const formatDoctor = (issues: ReadonlyArray<Issue>, modules: ReadonlyArray<DoctorModule> = []): { readonly lines: ReadonlyArray<string>; readonly exitCode: number } => {
  const sentence = (s: string) => (s === "" || /[.!?)]$/.test(s) ? s : `${s}.`)
  const bounded = (line: string) => (line.length <= 1_000 ? line : `${line.slice(0, 999)}…`)
  const lines = issues.map((issue) => {
    const fix = issue.fix === undefined ? "" : ` → ${oneLine(issue.fix.label, 200)}${issue.fix.value !== undefined ? `: ${oneLine(issue.fix.value, 400)}` : ""}`
    const detail = oneLine(issue.detail, 400)
    const device = issue.device === undefined ? "" : ` (device ${oneLine(issue.device, 60)})`
    return bounded(`${LABEL[issue.severity] ?? "warning"} ${oneLine(issue.module ?? "assistant", 60)}${device}: ${sentence(oneLine(issue.title, 200))}${detail === "" ? "" : ` ${sentence(detail)}`}${fix}`)
  })
  const count = (s: Issue["severity"]) => issues.filter((i) => i.severity === s).length
  const errors = count("error")
  const warnings = count("warning")
  const summary = issues.length === 0
    ? "No problems found."
    : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${count("info")} note${count("info") === 1 ? "" : "s"}.`
  return { lines: [...modules.map((m) => bounded(moduleLine(m))), ...lines, summary], exitCode: errors > 0 ? 1 : 0 }
}

/** Why doctor could not read what it judges: printed as one line, exit code 2. */
export class DoctorReadError extends Error {}

export interface DoctorSettingsOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dataDir: string
  readonly vaultPath: string
  /** Asks for the vault password (a terminal). Absent: never asks. */
  readonly prompt?: () => Promise<string>
  readonly openVault?: (path: string) => Promise<Vault>
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
}

/**
 * The saved settings and keys, strictly: a vault that cannot be opened or stays locked, settings that cannot be read,
 * are blocked, or had parts dropped, are a `DoctorReadError` (never the defaults).
 */
export const loadDoctorSettings = (options: DoctorSettingsOptions): Effect.Effect<Pick<DoctorOptions, "persistence" | "assistants">, DoctorReadError> =>
  Effect.gen(function*() {
    const fail = (message: string) => Effect.fail(new DoctorReadError(oneLine(message, 600)))
    const vault = yield* Effect.tryPromise({
      try: () => (options.openVault ?? ((path) => openVault({ path })))(options.vaultPath),
      catch: (error) => new DoctorReadError(oneLine(`The key vault at ${options.vaultPath} could not be read: ${error instanceof Error ? error.message : String(error)}`, 600))
    })
    if (vault.state() === "locked") {
      let password = options.env.PVA_VAULT_PASSWORD ?? ""
      if (password === "" && options.prompt !== undefined) password = yield* Effect.promise(() => options.prompt!())
      if (password !== "") {
        const unlocked = yield* Effect.promise(() => vault.unlock(password))
        if (!unlocked.ok) return yield* fail(`The key vault at ${options.vaultPath} did not unlock: ${unlocked.message}`)
      }
      if (vault.state() === "locked") {
        return yield* fail(`The key vault at ${options.vaultPath} is locked: set PVA_VAULT_PASSWORD, or run doctor in a terminal to be asked for the password.`)
      }
    }
    // An installation has saved settings: a missing directory or file is a wrong PVA_DATA_DIR (or nothing installed),
    // never "the defaults" (serve mode starts a fresh install from defaults; doctor judges an installed one).
    const settingsFile = join(options.dataDir, "settings.json")
    if (!existsSync(options.dataDir) || !statSync(options.dataDir).isDirectory()) {
      return yield* fail(`There is no data directory at ${options.dataDir}: set PVA_DATA_DIR to the assistant's data directory (start the assistant once to create it).`)
    }
    if (!existsSync(settingsFile)) {
      return yield* fail(`There are no saved settings at ${settingsFile}: set PVA_DATA_DIR to the assistant's data directory (start the assistant once to create them).`)
    }
    const store = yield* loadSettingsStore(options.dataDir, { readOnly: true, vault, assistants: { env: options.env, catalog: options.catalog } }).pipe(
      Effect.mapError((error) => new DoctorReadError(oneLine(`The saved settings in ${options.dataDir} could not be read: ${error instanceof Error ? error.message : String(error)}`, 600)))
    )
    if (store.problems.length > 0) return yield* fail(`The saved settings in ${options.dataDir} could not be read in full: ${store.problems.join("; ")}`)
    const blocked = store.blocked()
    if (blocked !== undefined) return yield* fail(`The saved settings in ${options.dataDir} are not used: ${blocked}`)
    return { persistence: store.modulePersistence.initial, assistants: store.assistantsInEffect().map((a) => a.assistant) }
  })

/** The CLI mode. */
export const doctorCommand: Effect.Effect<void, unknown> = Effect.gen(function*() {
  const dataDir = yield* DataDirConfig
  const vaultPath = yield* VaultPathConfig
  const env = process.env
  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true
  const settings = yield* Effect.result(loadDoctorSettings({ env, dataDir, vaultPath, catalog: moduleCatalog, ...(interactive ? { prompt: askVaultPassword } : {}) }))
  if (settings._tag === "Failure") {
    yield* Effect.sync(() => {
      process.stdout.write(`doctor: ${settings.failure.message}\n`)
      process.exitCode = 2
    })
    return
  }
  const report = yield* runDoctor({ catalog: moduleCatalog, env, dataDir, ...settings.success })
  const { exitCode, lines } = formatDoctor(report.issues, report.modules)
  yield* Effect.sync(() => {
    for (const line of lines) process.stdout.write(`${line}\n`)
    process.exitCode = exitCode
  })
})
