import type { AgentKind, ModuleKind, StatusLine } from "@pva/protocol"
import { Effect, Schema, type Scope } from "effect"
import type { AssistantModule, ContextProvider, Tool } from "./Module.ts"
import type { ModuleContributions } from "./ModuleContributions.ts"
import type { SettingsOf, SettingsSpec } from "./Settings.ts"

/**
 * The module system (docs/UI-AND-MODULES.md §1).
 *
 * A module is declared once, with `defineModule`, and registered with one line
 * in the app's module catalog. The host (serve mode) owns its lifecycle: it
 * resolves the settings (environment > saved > default), starts the module in
 * its own scope when it is enabled, swaps it into the tool registry from the
 * next turn on, restarts it when its settings change, and closes the scope when
 * it is disabled. The UI is generated from the declaration: name, description,
 * settings form, tools, status line.
 *
 * Agents, decision providers and actions are module contributions too
 * (`ModuleContributions`, docs/AGENTS-AND-INTENTS.md §1.6).
 */

/** A module could not start: missing or rejected credentials, unreachable service, ... */
export class ModuleStartError extends Schema.TaggedError<ModuleStartError>()("ModuleStartError", {
  /** One sentence for the user, saying how to fix it where possible. */
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** What `start` receives. */
export interface ModuleContext<A> {
  /** Validated settings, secrets resolved. */
  readonly settings: A
  /**
   * Publish (or clear, with `undefined`) the module's one-line status in the UI.
   * Synchronous and cheap; the host coalesces updates. Do not put secrets in it.
   */
  readonly setStatus: (status: StatusLine | undefined) => void
}

/**
 * What a running module contributes: tools, context and instructions, and
 * (`ModuleContributions`) agents, decision providers, actions, and values for
 * its form.
 */
export interface ModuleInstance extends ModuleContributions {
  /** Tools the model can call. Tool names must be unique across all enabled modules. */
  readonly tools?: ReadonlyArray<Tool>
  /**
   * Facts sent with every turn (`LlmRequest.context`), not part of the cached
   * prompt. Must answer within 50 ms (the host enforces it and drops a slow
   * provider's output for that turn with a warning): compute locally or cache.
   */
  readonly context?: ReadonlyArray<ContextProvider>
  /**
   * Stable text appended to the system prompt while the module is enabled
   * ("When the user asks about their home, use home_state."). Part of the
   * cached prefix: keep it short, and never put changing data in it.
   */
  readonly instructions?: string
}

export interface ModuleDefinition<S extends SettingsSpec = SettingsSpec> {
  /** Stable id: persistence key and protocol id. Lower case, digits and dashes (`/^[a-z][a-z0-9-]{0,39}$/`). */
  readonly id: string
  /** Display name, e.g. "Home Assistant". */
  readonly name: string
  /** One sentence for the UI. */
  readonly description: string
  readonly settings: S
  /** Enabled on first run (before the owner has chosen). Default true. */
  readonly enabledByDefault: boolean
  /**
   * Also enabled before the owner has chosen once this secret field (a key of `settings`) is set, from the
   * environment or saved (the key vault): a key entered in the UI counts like one in `.env`. The host re-checks it
   * when the saved secrets change (the vault was unlocked).
   */
  readonly enabledWhenSet?: string
  /** Which tab shows the module: `capability` (default), `agent` or `decider`. */
  readonly kind?: ModuleKind
  /** For `kind: "agent"`: the agent's kind. */
  readonly agentKind?: AgentKind
  /**
   * Start an instance with validated settings. Runs in a scope that the host
   * closes when the module is disabled or restarted with new settings (after
   * a grace period for tool calls still running): acquire timers, sockets and
   * caches with `Effect.acquireRelease` / `Effect.addFinalizer`. The host fails
   * the start after 10 s. Keep it fast; check credentials here so a bad token
   * shows as a start error, not as a failing tool later.
   */
  readonly start: (context: ModuleContext<SettingsOf<S>>) => Effect.Effect<ModuleInstance, ModuleStartError, Scope.Scope>
}

/** Declare a module. Infers the settings type from `settings`. */
export const defineModule = <const S extends SettingsSpec = {}>(definition: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly settings?: S
  readonly enabledByDefault?: boolean
  readonly enabledWhenSet?: keyof S & string
  readonly kind?: ModuleKind
  readonly start: (context: ModuleContext<SettingsOf<S>>) => Effect.Effect<ModuleInstance, ModuleStartError, Scope.Scope>
}): ModuleDefinition<S> => {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(definition.id)) {
    throw new Error(`Module id "${definition.id}" must match /^[a-z][a-z0-9-]{0,39}$/`)
  }
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    settings: definition.settings ?? ({} as S),
    enabledByDefault: definition.enabledByDefault ?? true,
    ...(definition.enabledWhenSet !== undefined ? { enabledWhenSet: definition.enabledWhenSet } : {}),
    ...(definition.kind !== undefined ? { kind: definition.kind } : {}),
    start: definition.start
  }
}

/**
 * Wrap a settings-less `AssistantModule` (the pre-module-system shape) as a
 * definition, for modules not yet migrated.
 */
export const fromAssistantModule = (
  meta: { readonly id: string; readonly name: string; readonly description: string },
  module: AssistantModule
): ModuleDefinition<{}> =>
  defineModule({
    ...meta,
    start: () =>
      Effect.succeed({
        ...(module.tools !== undefined ? { tools: module.tools } : {}),
        ...(module.context !== undefined ? { context: module.context } : {})
      })
  })
