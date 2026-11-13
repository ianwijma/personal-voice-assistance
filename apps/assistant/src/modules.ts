import { makeModuleHost, type ModuleDefinition, type ModulePersistence, type ModuleSnapshot, readOnlyPersistence } from "@pva/core"
import { clockModule, weatherModule } from "@pva/modules-builtin"
import { Effect, type Scope } from "effect"
import { DataDirConfig, loadSettingsStore } from "./serve/SettingsStore.ts"

/**
 * The capabilities, in display order (also the order of their instructions in
 * the system prompt). Adding a feature = one line here. Each module's settings,
 * enable switch and status appear in the web UI's Options; CLI modes use the
 * saved settings (`PVA_DATA_DIR`) and environment variables.
 */
export const moduleCatalog: ReadonlyArray<ModuleDefinition<any>> = [
  clockModule,
  weatherModule()
]

/** The stable system prompt followed by the running modules' instructions. */
export const withModuleInstructions = (systemPrompt: string, instructions: ReadonlyArray<string>): string =>
  instructions.length === 0 ? systemPrompt : `${systemPrompt}\n\n${instructions.join("\n\n")}`

/**
 * For the CLI modes: start the enabled modules once, with the saved settings
 * (never written), and return their snapshot. A module that cannot start is
 * reported as a warning and left out, as in serve mode.
 */
export const startCliModules = (
  options: { readonly catalog?: ReadonlyArray<ModuleDefinition<any>>; readonly persistence?: ModulePersistence } = {}
): Effect.Effect<ModuleSnapshot, never, Scope.Scope> =>
  Effect.gen(function*() {
    const persistence = options.persistence ?? (yield* Effect.gen(function*() {
      const directory = yield* DataDirConfig
      const store = yield* loadSettingsStore(directory, { readOnly: true })
      for (const problem of store.problems) yield* Effect.logWarning(problem)
      return readOnlyPersistence(store.modulePersistence.initial)
    }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning("Could not read the saved settings; using defaults", cause), readOnlyPersistence()))))
    const host = yield* makeModuleHost({ catalog: options.catalog ?? moduleCatalog, persistence, env: process.env })
    yield* host.startEnabled
    for (const module of host.modules()) {
      if (module.state === "error") yield* Effect.logWarning(`Module ${module.name} is not available: ${module.error ?? "unknown error"}`)
    }
    return host.snapshot()
  })
