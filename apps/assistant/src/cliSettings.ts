/**
 * The command-line modes (`voice`, `text`, `say`, `bench`, `transcribe`, `compare-models`) on the saved settings
 * (docs/SETTINGS-UI.md §4.4): the same precedence as serve mode, environment > saved settings > default, with the
 * keys from the key vault. So a `.env` emptied by "Move to settings" keeps working on the command line.
 *
 * The vault is unlocked with `PVA_VAULT_PASSWORD`, else (stdin and stderr are a terminal) by asking for the password;
 * Enter skips it. Without the keys, a provider that needs one fails with "X is not set (the key vault is locked …)".
 */
import type { ModuleDefinition } from "@pva/core"
import type { Assistant } from "@pva/protocol"
import { ConfigProvider, Context, Effect } from "effect"
import * as readline from "node:readline"
import { makeSections } from "./serve/sections.ts"
import { loadSettingsStore, type SettingsStore } from "./serve/SettingsStore.ts"
import { openVault, type Vault } from "./serve/Vault.ts"

export interface CliSettings {
  /** The saved settings, read-only. Absent when they could not be read (then only the environment counts). */
  readonly store: SettingsStore | undefined
  readonly vaultState: "none" | "locked" | "unlocked"
  readonly vaultPath: string
  /**
   * The assistant a CLI mode answers as (docs/ASSISTANTS.md §4.4): `assistantId` if it exists, else the first
   * switched-on one, with the environment applied to the migrated one as in serve mode. A version-3 data directory
   * is migrated in memory only. Absent: no settings, or no assistant.
   */
  readonly assistant?: Assistant | undefined
}

/** The CLI's saved settings, when `withCliSettings` loaded them (`startCliModules` reuses them). */
export const CliSettingsRef = Context.Reference<CliSettings | undefined>("@pva/assistant/CliSettings", { defaultValue: () => undefined })

/** Environment > saved settings and vault keys > default: what the providers read in a CLI mode. */
export const cliConfigProvider = (store: SettingsStore, env: Readonly<Record<string, string | undefined>>): ConfigProvider.ConfigProvider =>
  makeSections(store, env).configProvider()

export interface LoadCliOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly dataDir: string
  readonly vaultPath: string
  /** Asks for the vault password (a terminal); resolves "" to skip. Absent: never asks. */
  readonly prompt?: () => Promise<string>
  /** For tests. */
  readonly openVault?: (path: string) => Promise<Vault>
  /** The module catalog, for migrating a version-3 data directory in memory (which modules were on). */
  readonly catalog?: ReadonlyArray<ModuleDefinition<any>>
  /** The assistant to answer as (default: the first switched-on one). */
  readonly assistantId?: string
}

/** The assistant a CLI mode uses: `id` when it exists, else the first switched-on one (with the environment applied). */
export const cliAssistant = (store: SettingsStore, id?: string): Assistant | undefined => {
  const inEffect = store.assistantsInEffect().map((a) => a.assistant)
  return (id !== undefined ? inEffect.find((a) => a.id === id) : undefined) ?? inEffect.find((a) => a.on)
}

export const loadCliSettings = (options: LoadCliOptions): Effect.Effect<{ readonly settings: CliSettings; readonly configProvider: ConfigProvider.ConfigProvider }> =>
  Effect.gen(function*() {
    const fromEnv = (): ConfigProvider.ConfigProvider => {
      const record: Record<string, string> = {}
      for (const [k, v] of Object.entries(options.env)) if (v !== undefined && v !== "") record[k] = v
      return ConfigProvider.fromEnvRecord(record)
    }
    const vault = yield* Effect.tryPromise(() => (options.openVault ?? ((path) => openVault({ path })))(options.vaultPath)).pipe(
      Effect.catchCause((cause) => Effect.as(Effect.logWarning(`Could not open the key vault at ${options.vaultPath}`, cause), undefined))
    )
    if (vault !== undefined && vault.state() === "locked") {
      let password = options.env.PVA_VAULT_PASSWORD ?? ""
      const fromPrompt = password === "" && options.prompt !== undefined
      if (fromPrompt) password = yield* Effect.promise(() => options.prompt!())
      if (password !== "") {
        const unlocked = yield* Effect.promise(() => vault.unlock(password))
        if (!unlocked.ok) {
          yield* Effect.logWarning(`${fromPrompt ? "That password" : "PVA_VAULT_PASSWORD"} did not unlock the key vault: ${unlocked.message}`)
        }
      }
      if (vault.state() === "locked") {
        yield* Effect.logWarning(
          "The key vault is locked: providers and modules that need a key are not available (set PVA_VAULT_PASSWORD, or run this in a terminal to be asked)."
        )
      }
    }
    const vaultState = vault?.state() ?? "none"
    const store = yield* loadSettingsStore(options.dataDir, {
      readOnly: true,
      ...(vault !== undefined ? { vault } : {}),
      assistants: { env: options.env, ...(options.catalog !== undefined ? { catalog: options.catalog } : {}) }
    }).pipe(
      Effect.tap((s) => Effect.forEach(s.problems, (p) => Effect.logWarning(p), { discard: true })),
      Effect.catchCause((cause) => Effect.as(Effect.logWarning("Could not read the saved settings; using the environment and defaults", cause), undefined))
    )
    return {
      settings: { store, vaultState, vaultPath: options.vaultPath, assistant: store === undefined ? undefined : cliAssistant(store, options.assistantId) },
      configProvider: store === undefined ? fromEnv() : cliConfigProvider(store, options.env)
    }
  })

/** Run `effect` with the CLI's saved settings as its `ConfigProvider` (and `CliSettingsRef`). */
export const withCliSettings = <A, E, R>(effect: Effect.Effect<A, E, R>, options: LoadCliOptions): Effect.Effect<A, E, R> =>
  Effect.flatMap(loadCliSettings(options), ({ settings, configProvider }) =>
    effect.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.provideService(CliSettingsRef, settings)
    ))

/** Ask for the vault password on the terminal without echoing it. Enter alone skips. */
export const askVaultPassword = (): Promise<string> =>
  new Promise((resolve) => {
    const question = "Key vault password (Enter to skip): "
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    const internal = rl as unknown as { _writeToOutput: (s: string) => void }
    const write = internal._writeToOutput.bind(rl)
    internal._writeToOutput = (s: string) => {
      if (s.includes(question) || s === "\r\n" || s === "\n") write(s)
    }
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })

/** A startup error naming a setting that "is not set" while the vault is locked: say why. */
export const explainMissingKey = (message: string, settings: CliSettings | undefined): string =>
  settings?.vaultState === "locked" && /\bis not set\b/.test(message)
    ? `${message}\nThe key vault (${settings.vaultPath}) is locked, so its keys were not read: set PVA_VAULT_PASSWORD, or run this in a terminal to be asked for the password.`
    : message
