import { claudeSubscriptionAgent } from "@pva/agent-claude-code"
import { makeModuleHost, type ModuleDefinition, type ModuleDemand, type ModuleHost, type ModulePersistence, type ModuleSnapshot, readOnlyPersistence, type TurnSetup } from "@pva/core"
import { homeAssistantModule } from "@pva/module-home-assistant"
import { clockModule, weatherModule } from "@pva/modules-builtin"
import type { Assistant, ModuleInfo } from "@pva/protocol"
import { Config, Effect, type Scope } from "effect"
import { CliSettingsRef } from "./cliSettings.ts"
import { makeRequirementChecker, type RequirementChecker } from "./requirements.ts"
import { DataDirConfig, loadSettingsStore } from "./serve/SettingsStore.ts"
import { openVault, VaultPathConfig } from "./serve/Vault.ts"

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
/** Capabilities are switched on per assistant; agent and decision-provider modules follow their own switch. */
export const isCapabilityOf = (catalog: ReadonlyArray<ModuleDefinition<any>>) => (moduleId: string): boolean => {
  const def = catalog.find((d) => d.id === moduleId)
  return def === undefined || def.kind === undefined || def.kind === "capability"
}

/**
 * Who wants which capability (docs/ASSISTANTS.md §2.6): every switched-on assistant that has it on, with its own
 * values. Each capability has an entry (an empty list: nobody); agents and decision providers have none. Serve mode
 * runs modules by it, and `doctor` judges by it (a module an assistant uses is an error when it cannot run).
 */
export const moduleDemandOf = (
  catalog: ReadonlyArray<ModuleDefinition<any>>,
  assistants: Iterable<Assistant>
): ReadonlyMap<string, ReadonlyArray<ModuleDemand>> => {
  const isCapability = isCapabilityOf(catalog)
  const demand = new Map<string, Array<ModuleDemand>>(catalog.filter((d) => isCapability(d.id)).map((d) => [d.id, []]))
  for (const assistant of assistants) {
    if (!assistant.on) continue
    for (const [moduleId, choice] of Object.entries(assistant.modules)) {
      if (choice.on) demand.get(moduleId)?.push({ assistantId: assistant.id, ...(choice.own !== undefined ? { own: choice.own } : {}) })
    }
  }
  return demand
}

/**
 * The CLI modes' modules: the same host and gateway as serve mode, read **per turn**. Nothing here keeps a tool,
 * agent or instructions line from the start-up snapshot: a module restarted (`requestRestart`) or judged unavailable
 * since (a program went missing) is what the next turn sees, never the withdrawn one.
 */
export interface CliModules {
  readonly host: ModuleHost
  /** The snapshot now (a reference read): read once at the start of every turn. */
  readonly snapshot: () => ModuleSnapshot
  readonly infos: () => ReadonlyArray<ModuleInfo>
  /** A turn setup reading the snapshot at every turn's start: `systemPrompt` plus the instructions of now. */
  readonly setup: (systemPrompt: string) => Effect.Effect<TurnSetup>
}

export const startCliModules = (
  options: {
    readonly catalog?: ReadonlyArray<ModuleDefinition<any>>
    readonly persistence?: ModulePersistence
    /** What probes the programs modules need. Default: the real checker on the data directory (tests give a fake). */
    readonly checker?: RequirementChecker
  } = {}
): Effect.Effect<CliModules, never, Scope.Scope> =>
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
    const checker = options.checker ?? makeRequirementChecker({ dataDir: yield* DataDirConfig.pipe(Effect.orElseSucceed(() => "data")) })
    yield* checker.probeCatalog(catalog)
    const host = yield* makeModuleHost({
      catalog,
      persistence,
      env: process.env,
      platform: { os: process.platform, arch: process.arch },
      requirements: checker.check,
      // The CLI modes have no assistants: a call runs for the person at the terminal.
      localPrincipal: true,
      programMissing: (tool) => checker.markMissing(tool)
    })
    yield* host.startEnabled
    for (const module of host.modules()) {
      if (module.state === "error") yield* Effect.logWarning(`Module ${module.name} is not available: ${module.error ?? "unknown error"}`)
      if (module.state === "unavailable" && module.enabled) {
        yield* Effect.logWarning(`Module ${module.name} cannot run here: ${module.unavailable?.reason ?? "unknown reason"} (pnpm start doctor says how to fix it)`)
      }
    }
    return {
      host,
      snapshot: host.snapshot,
      infos: host.modules,
      setup: (systemPrompt: string) =>
        Effect.sync((): TurnSetup => {
          const snapshot = host.snapshot()
          return { system: withModuleInstructions(systemPrompt, snapshot.instructions), registry: snapshot.registry }
        })
    }
  })
