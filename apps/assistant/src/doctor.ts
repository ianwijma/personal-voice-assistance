import { type Issue, makeModuleHost, type ModuleDefinition, oneLine, readOnlyPersistence } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { Effect } from "effect"
import { askVaultPassword } from "./cliSettings.ts"
import { moduleCatalog, moduleDemandOf } from "./modules.ts"
import { makeRequirementChecker, type Prober, type ToolEntry } from "./requirements.ts"
import { DataDirConfig, loadSettingsStore } from "./serve/SettingsStore.ts"
import { openVault, type Vault, VaultPathConfig } from "./serve/Vault.ts"
import { householdIssues } from "@pva/store-sqlite"

/**
 * `pnpm start doctor` (module-definition-config-and-dependencies.md §C.5, after `brew doctor`): the household
 * database's checks (P4), then every module's requirements and `health()`, on the saved settings, read-only (nothing
 * is started or written). One line per issue with its fix; the exit code is 1 when there is an error. It says
 * nothing else about the machine itself (disk, TLS files, the port, speech models: the deployment work,
 * docs/MODULES-PLAN.md §7).
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

/** Every issue doctor finds. Modules are judged, never started. */
export const runDoctor = (options: DoctorOptions): Effect.Effect<ReadonlyArray<Issue>> =>
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
    const host = yield* makeModuleHost({
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
    // The household database (P4): opens, passes SQLite's quick check, is not from a newer version, holds no module
    // data newer than that module (judged read-only against the catalog), has a recent backup.
    const household = yield* householdIssues(options.dataDir, { modules: options.catalog.map((d) => ({ id: d.id, name: d.name, storage: d.storage })) })
    return [...household, ...host.issues.all()]
  }))

const LABEL: Readonly<Record<Issue["severity"], string>> = { error: "error  ", warning: "warning", info: "info   " }

/**
 * One line per issue (`<severity> <module>: <title>. <detail> → <fix>`), a summary, and the exit code. Every piece of
 * text is one line with no control characters (an issue's text comes from modules and probes: it cannot add lines or
 * move the terminal's cursor), and each line is at most 1,000 characters.
 */
export const formatDoctor = (issues: ReadonlyArray<Issue>): { readonly lines: ReadonlyArray<string>; readonly exitCode: number } => {
  const sentence = (s: string) => (s === "" || /[.!?)]$/.test(s) ? s : `${s}.`)
  const lines = issues.map((issue) => {
    const fix = issue.fix === undefined ? "" : ` → ${oneLine(issue.fix.label, 200)}${issue.fix.value !== undefined ? `: ${oneLine(issue.fix.value, 400)}` : ""}`
    const detail = oneLine(issue.detail, 400)
    const line = `${LABEL[issue.severity] ?? "warning"} ${oneLine(issue.module ?? "assistant", 60)}: ${sentence(oneLine(issue.title, 200))}${detail === "" ? "" : ` ${sentence(detail)}`}${fix}`
    return line.length <= 1_000 ? line : `${line.slice(0, 999)}…`
  })
  const count = (s: Issue["severity"]) => issues.filter((i) => i.severity === s).length
  const errors = count("error")
  const warnings = count("warning")
  const summary = issues.length === 0
    ? "No problems found."
    : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${count("info")} note${count("info") === 1 ? "" : "s"}.`
  return { lines: [...lines, summary], exitCode: errors > 0 ? 1 : 0 }
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
  const issues = yield* runDoctor({ catalog: moduleCatalog, env, dataDir, ...settings.success })
  const { exitCode, lines } = formatDoctor(issues)
  yield* Effect.sync(() => {
    for (const line of lines) process.stdout.write(`${line}\n`)
    process.exitCode = exitCode
  })
})
