import { claudeSubscriptionAgent } from "@pva/agent-claude-code"
import { makeModuleHost, type ModuleDefinition, type ModulePersistence, type ModuleSnapshot, readOnlyPersistence } from "@pva/core"
import { homeAssistantModule } from "@pva/module-home-assistant"
import { clockModule, weatherModule } from "@pva/modules-builtin"
import type { ModuleInfo } from "@pva/protocol"
import { Config, Effect, type Scope } from "effect"
import { CliSettingsRef } from "./cliSettings.ts"
import { makeRequirementChecker } from "./requirements.ts"
import { DataDirConfig, loadSettingsStore } from "./serve/SettingsStore.ts"
import { openVault, VaultPathConfig } from "./serve/Vault.ts"
import { openCliHousehold } from "./serve/household.ts"

/**
 * The capabilities, in display order (also the order of their instructions in
 * the system prompt). Adding a feature = one line here. Each module's settings,
 * enable switch and status appear in the web UI's Options; CLI modes use the
 * saved settings (`PVA_DATA_DIR`) and environment variables.
 */
export const moduleCatalog: ReadonlyArray<ModuleDefinition<any>> = [
  clockModule,
  weatherModule(),
  // Lights by room through the owner's Home Assistant (address and token shared; `domains` per assistant).
  homeAssistantModule(),
  // Off by default and behind its own opt-in switch; answers when LLM_PROVIDER=claude-subscription.
  claudeSubscriptionAgent
]

/** The stable system prompt followed by the running modules' instructions. */
export const withModuleInstructions = (systemPrompt: string, instructions: ReadonlyArray<string>): string =>
  instructions.length === 0 ? systemPrompt : `${systemPrompt}\n\n${instructions.join("\n\n")}`

/**
 * For the CLI modes: start the enabled modules once, with the saved settings
 * (never written), and return their snapshot (and the modules' info). A module
 * that cannot start is reported as a warning and left out, as in serve mode.
 * Module keys in the key vault are used when it was unlocked (`cliSettings.ts`: `PVA_VAULT_PASSWORD` or the
 * terminal prompt).
 */
export const startCliModules = (
  options: { readonly catalog?: ReadonlyArray<ModuleDefinition<any>>; readonly persistence?: ModulePersistence } = {}
): Effect.Effect<ModuleSnapshot & { readonly infos: ReadonlyArray<ModuleInfo> }, never, Scope.Scope> =>
  Effect.gen(function*() {
    const loaded = yield* CliSettingsRef
    const persistence = options.persistence ?? (loaded !== undefined
      ? readOnlyPersistence(loaded.store?.modulePersistence.initial)
      : undefined) ?? (yield* Effect.gen(function*() {
      const directory = yield* DataDirConfig
      const vaultPath = yield* VaultPathConfig
      const vault = yield* Effect.promise(() => openVault({ path: vaultPath }))
      const password = yield* Config.String("PVA_VAULT_PASSWORD").pipe(Config.withDefault(""))
      if (vault.state() === "locked" && password !== "") {
        const unlocked = yield* Effect.promise(() => vault.unlock(password))
        if (!unlocked.ok) yield* Effect.logWarning(`PVA_VAULT_PASSWORD did not unlock the key vault: ${unlocked.message}`)
      }
      if (vault.state() === "locked") {
        yield* Effect.logWarning("The key vault is locked: modules that need a key are not available here (set PVA_VAULT_PASSWORD, or use serve mode).")
      }
      const store = yield* loadSettingsStore(directory, { readOnly: true, vault })
      for (const problem of store.problems) yield* Effect.logWarning(problem)
      return readOnlyPersistence(store.modulePersistence.initial)
    }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning("Could not read the saved settings; using defaults", cause), readOnlyPersistence()))))
    const catalog = options.catalog ?? moduleCatalog
    // Module API v2: what the modules need is probed once, before any starts (never on a turn).
    const dataDir = yield* DataDirConfig.pipe(Effect.orElseSucceed(() => "data"))
    const checker = makeRequirementChecker({ dataDir })
    yield* checker.probeCatalog(catalog)
    // The household data read-only (serve is its one writer): version 2 modules read it here and every write is refused.
    const services = yield* Effect.context<never>()
    const household = yield* openCliHousehold({ dataDir, catalog, log: (line) => void Effect.runForkWith(services)(Effect.logWarning(line)) })
    const host = yield* makeModuleHost({
      catalog,
      persistence,
      household: { store: household.store, events: household.bus },
      env: process.env,
      platform: { os: process.platform, arch: process.arch },
      requirements: checker.check
    })
    yield* host.startEnabled
    for (const module of host.modules()) {
      if (module.state === "error") yield* Effect.logWarning(`Module ${module.name} is not available: ${module.error ?? "unknown error"}`)
      if (module.state === "unavailable" && module.enabled) {
        yield* Effect.logWarning(`Module ${module.name} cannot run here: ${module.unavailable?.reason ?? "unknown reason"} (pnpm start doctor says how to fix it)`)
      }
    }
    return { ...host.snapshot(), infos: host.modules() }
  })
