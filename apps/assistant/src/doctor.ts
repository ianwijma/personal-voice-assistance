import { type Issue, makeModuleHost, type ModuleDefinition, readOnlyPersistence } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Effect } from "effect"
import { CliSettingsRef } from "./cliSettings.ts"
import { type CoreCheckOptions, runCoreChecks } from "./coreChecks.ts"
import { moduleCatalog } from "./modules.ts"
import { makeRequirementChecker, type Prober } from "./requirements.ts"
import type { SttShared } from "./serve/Resources.ts"
import { makeSections } from "./serve/sections.ts"
import { DataDirConfig } from "./serve/SettingsStore.ts"
import { householdIssues } from "@pva/store-sqlite"

/**
 * `pnpm start doctor` (module-definition-config-and-dependencies.md §C.5, after `brew doctor` and `flutter doctor`):
 * the core checks, then every module's requirements and `health()`, on the saved settings, read-only (nothing is
 * started or written). One line per issue with its fix; the exit code is 1 when there is an error.
 */

export interface DoctorOptions {
  readonly catalog: ReadonlyArray<ModuleDefinition<any>>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dataDir: string
  readonly modelDirs: CoreCheckOptions["modelDirs"]
  /** The saved module settings and keys (read-only). Absent: defaults. */
  readonly persistence?: Parameters<typeof readOnlyPersistence>[0]
  /** The assistants in effect: their model files, and which modules are in use. */
  readonly assistants?: ReadonlyArray<Assistant>
  readonly sttShared?: SttShared
  readonly vault?: CoreCheckOptions["vault"]
  readonly platform?: { readonly os: string; readonly arch: string }
  /** For tests: the probes, and the core checks' seams. */
  readonly prober?: Prober
  readonly core?: Partial<Pick<CoreCheckOptions, "freeMb" | "portFree" | "clockSynced" | "readable" | "checkStt" | "nodeVersion">>
}

/** Every issue doctor finds, core first. Modules are judged, never started. */
export const runDoctor = (options: DoctorOptions): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.scoped(Effect.gen(function*() {
    const checker = makeRequirementChecker({ dataDir: options.dataDir, ...(options.prober !== undefined ? { prober: options.prober } : {}) })
    const core = yield* runCoreChecks({
      checker,
      env: options.env,
      dataDir: options.dataDir,
      modelDirs: options.modelDirs,
      serving: false,
      ...(options.vault !== undefined ? { vault: options.vault } : {}),
      ...(options.assistants !== undefined ? { assistants: options.assistants } : {}),
      ...(options.sttShared !== undefined ? { sttShared: options.sttShared } : {}),
      ...options.core
    })
    yield* checker.probeCatalog(options.catalog, { force: true })
    const host = yield* makeModuleHost({
      catalog: options.catalog,
      persistence: readOnlyPersistence(options.persistence),
      env: options.env,
      platform: options.platform ?? { os: process.platform, arch: process.arch },
      requirements: checker.check
    })
    yield* host.checkHealth
    // Which capabilities an assistant uses (serve mode's demand): a module nobody uses is never an error here.
    const inUse = options.assistants === undefined
      ? undefined
      : new Set(options.assistants.filter((a) => a.on).flatMap((a) => Object.entries(a.modules).filter(([, c]) => c.on).map(([id]) => id)))
    const capability = (id: string) => {
      const kind = options.catalog.find((d) => d.id === id)?.kind
      return kind === undefined || kind === "capability"
    }
    const modules = host.issues.all().map((issue): Issue =>
      issue.severity === "error" && issue.module !== undefined && inUse !== undefined && capability(issue.module) && !inUse.has(issue.module)
        ? { ...issue, severity: "warning", detail: `${issue.detail} (No assistant has it on.)` }
        : issue
    )
    // The household database: opens, passes SQLite's quick check, is not from a newer version, holds no module data
    // newer than that module (judged read-only against the catalog), has a recent backup.
    const household = yield* householdIssues(options.dataDir, { modules: options.catalog.map((d) => ({ id: d.id, name: d.name, storage: d.storage })) })
    return [...core, ...household, ...modules]
  }))

const LABEL: Readonly<Record<Issue["severity"], string>> = { error: "error  ", warning: "warning", info: "info   " }

/** One line per issue (`<severity> <module or core>: <title>. <detail> → <fix>`), a summary, and the exit code. */
export const formatDoctor = (issues: ReadonlyArray<Issue>): { readonly lines: ReadonlyArray<string>; readonly exitCode: number } => {
  const sentence = (s: string) => (s === "" || /[.!?)]$/.test(s) ? s : `${s}.`)
  const lines = issues.map((issue) => {
    const fix = issue.fix === undefined ? "" : ` → ${issue.fix.label}${issue.fix.value !== undefined ? `: ${issue.fix.value}` : ""}`
    const detail = issue.detail.trim() === "" ? "" : ` ${sentence(issue.detail.trim())}`
    return `${LABEL[issue.severity]} ${issue.module ?? "core"}: ${sentence(issue.title)}${detail}${fix}`
  })
  const count = (s: Issue["severity"]) => issues.filter((i) => i.severity === s).length
  const errors = count("error")
  const warnings = count("warning")
  const summary = issues.length === 0
    ? "No problems found."
    : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${count("info")} note${count("info") === 1 ? "" : "s"}.`
  return { lines: [...lines, summary], exitCode: errors > 0 ? 1 : 0 }
}

/** The CLI mode: the saved settings as the other CLI modes read them (`withSavedSettings` in main.ts). */
export const doctorCommand: Effect.Effect<void, unknown> = Effect.gen(function*() {
  const settings = yield* CliSettingsRef
  const dataDir = yield* DataDirConfig
  const store = settings?.store
  const env = process.env
  const modelDirs = store !== undefined ? makeSections(store, env).modelDirs() : { stt: SherpaStt.defaultModelDir, tts: SherpaTts.defaultModelDir }
  const issues = yield* runDoctor({
    catalog: moduleCatalog,
    env,
    dataDir,
    modelDirs,
    sttShared: { modelDir: modelDirs.stt },
    ...(store !== undefined ? { persistence: store.modulePersistence.initial, assistants: store.assistantsInEffect().map((a) => a.assistant) } : {}),
    ...(settings !== undefined ? { vault: { state: settings.vaultState, path: settings.vaultPath } } : {})
  })
  const { exitCode, lines } = formatDoctor(issues)
  yield* Effect.sync(() => {
    for (const line of lines) process.stdout.write(`${line}\n`)
    process.exitCode = exitCode
  })
})
