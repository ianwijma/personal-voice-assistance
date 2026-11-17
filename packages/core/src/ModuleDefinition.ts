import { type AgentKind, AssistantTemplate, type HealthIssue as Issue, type ModuleKind, type StatusLine } from "@pva/protocol"
import { Effect, Schema, type Scope } from "effect"
import type { AssistantModule, ContextProvider, Tool } from "./Module.ts"
import type { DeclaredAction, HealthContext, ModuleServicesV2, ModuleTemplate, Platforms, Requirement, SharedContext, SharedPart } from "./ModuleApi.ts"
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

/** What `start` receives (module API version 1: every module without `apiVersion`). */
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
 * What `start` receives in a module written for API version 2 (`apiVersion: 2`): the version 1 context, the host's
 * services (`ModuleServicesV2`: `host` today; later `store`, `events`, `scheduler`, `speech`, `notify`, `present`,
 * `connections`), and what the module's `shared` part returned (`undefined` without one).
 */
export interface ModuleContextV2<A, X = undefined> extends ModuleContext<A>, ModuleServicesV2 {
  readonly shared: X
}

/** The context of a module of API version `V`: version 1 gets `ModuleContext`, any later one `ModuleContextV2`. */
export type ModuleContextOf<V extends number, A, X = undefined> = V extends 1 ? ModuleContext<A> : ModuleContextV2<A, X>

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
   * The module API it was written for (`MODULE_API`). Absent: 1, exactly the behaviour before version 2. A version
   * the host does not support makes the module `unavailable`.
   */
  readonly apiVersion?: number
  /** The module's own version (semver), shown in the UI; keys storage migrations later. */
  readonly version?: string
  /** What it needs outside the process (§C.3), judged before `start`: a missing required one makes it `unavailable`. */
  readonly requires?: ReadonlyArray<Requirement>
  /** Where it runs; absent = everywhere. Another platform makes it `unavailable`. */
  readonly platforms?: Platforms
  /**
   * A cheap check that returns what is wrong, with fixes (§C.5): run at start, on "Check again" and by
   * `pnpm start doctor`, never on a turn; 5 s at most. Issue ids should start with the module id.
   */
  readonly health?: (context: HealthContext<SettingsOf<S>>) => Effect.Effect<ReadonlyArray<Issue>>
  /** Suggested assistants (plain data) the new-assistant flow offers. */
  readonly templates?: ReadonlyArray<ModuleTemplate>
  /**
   * The actions it offers, declared so they stay known while the module is `unavailable` (§C.4): an assistant that
   * has it on still recognises them by intent and is answered with its "not set up" line. What runs while it is
   * available are the actions its `start` returns.
   */
  readonly declaredActions?: ReadonlyArray<DeclaredAction>
  /**
   * Other modules this one needs while it is demanded (version 2): each is demanded too, so its `shared` part (its
   * services and contributions) runs even when no assistant has it on. Its instances still follow the assistants.
   */
  readonly uses?: ReadonlyArray<string>
  /**
   * The part that runs once per module (version 2) while it is demanded, with its shared settings only, in a scope the
   * host closes when demand ends or a new generation replaces it (after the grace period): sockets, caches, handlers,
   * services and contributions. 10 s to start. What it returns as `value` every instance receives as `ctx.shared`.
   * A changed shared setting starts a new generation: a new shared part and every instance, switched to at once.
   */
  shared?(context: SharedContext<SettingsOf<S>>): Effect.Effect<SharedPart<unknown>, ModuleStartError, Scope.Scope>
  /**
   * Start an instance with validated settings. Runs in a scope that the host
   * closes when the module is disabled or restarted with new settings (after
   * a grace period for tool calls still running): acquire timers, sockets and
   * caches with `Effect.acquireRelease` / `Effect.addFinalizer`. The host fails
   * the start after 10 s. Keep it fast; check credentials here so a bad token
   * shows as a start error, not as a failing tool later.
   *
   * A version 1 module receives `ModuleContext`; a version 2 module `ModuleContextV2` (declared through
   * `defineModule`, which types the parameter by `apiVersion`). Method syntax keeps both assignable here.
   */
  start(context: ModuleContext<SettingsOf<S>>): Effect.Effect<ModuleInstance, ModuleStartError, Scope.Scope>
}

const TEMPLATE_ID = /^[a-z][a-z0-9_-]{0,39}$/
const ACTION_ID = /^[a-z][a-z0-9_]{0,39}$/
const isWireTemplate = Schema.is(AssistantTemplate)

/** Refuse, at definition time, manifest values the wire could not carry. */
const checkManifest = (
  id: string,
  definition: {
    readonly version?: string
    readonly apiVersion?: number
    readonly templates?: ReadonlyArray<ModuleTemplate>
    readonly declaredActions?: ReadonlyArray<DeclaredAction>
    readonly uses?: ReadonlyArray<string>
    readonly shared?: unknown
  }
) => {
  if (definition.shared !== undefined && (definition.apiVersion ?? 1) < 2) throw new Error(`Module ${id}: shared needs apiVersion 2`)
  for (const used of definition.uses ?? []) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(used) || used === id) throw new Error(`Module ${id}: uses names "${used}", which is not another module id`)
  }
  if (definition.apiVersion !== undefined && (!Number.isInteger(definition.apiVersion) || definition.apiVersion < 1)) {
    throw new Error(`Module ${id}: apiVersion must be a whole number of at least 1`)
  }
  if (definition.version !== undefined && (definition.version.length === 0 || definition.version.length > 40)) {
    throw new Error(`Module ${id}: version must be 1 to 40 characters`)
  }
  const seen = new Set<string>()
  for (const t of definition.templates ?? []) {
    if (!TEMPLATE_ID.test(t.id)) throw new Error(`Module ${id}: template id "${t.id}" must match ${TEMPLATE_ID}`)
    if (seen.has(t.id)) throw new Error(`Module ${id}: template "${t.id}" is declared twice`)
    seen.add(t.id)
    if (t.name.length === 0 || t.name.length > 32) throw new Error(`Module ${id}: template "${t.id}" needs a name of 1 to 32 characters`)
    if (t.prompt.length > 4000) throw new Error(`Module ${id}: template "${t.id}" has a prompt over 4000 characters`)
    if ((t.purpose?.length ?? 0) > 80) throw new Error(`Module ${id}: template "${t.id}" has a purpose over 80 characters`)
    if ((t.handles?.length ?? 0) > 240) throw new Error(`Module ${id}: template "${t.id}" has handles over 240 characters`)
    // Everything else the wire carries (module ids, suggested phrases): exactly what the admin snapshot will encode.
    const wire = {
      id: `${id}.${t.id}`,
      name: t.name,
      prompt: t.prompt,
      ...(t.purpose !== undefined ? { purpose: t.purpose } : {}),
      ...(t.handles !== undefined ? { handles: t.handles } : {}),
      modules: [...(t.modules ?? [id])],
      ...(t.suggestedPhrases !== undefined ? { suggestedPhrases: [...t.suggestedPhrases] } : {})
    }
    if (!isWireTemplate(wire as unknown)) {
      const badModule = wire.modules.find((m) => !/^[a-z][a-z0-9-]{0,39}$/.test(m))
      const longPhrase = (t.suggestedPhrases ?? []).find((p) => p.length > 60)
      throw new Error(
        `Module ${id}: template "${t.id}" cannot be sent to the admin page: ${
          badModule !== undefined ? `"${badModule}" is not a module id` : longPhrase !== undefined ? `the suggested phrase "${longPhrase.slice(0, 20)}…" is over 60 characters` : "a field is out of bounds"
        }`
      )
    }
  }
  const actionIds = new Set<string>()
  for (const a of definition.declaredActions ?? []) {
    if (!ACTION_ID.test(a.id)) throw new Error(`Module ${id}: declared action id "${a.id}" must match ${ACTION_ID}`)
    if (actionIds.has(a.id)) throw new Error(`Module ${id}: declared action "${a.id}" is declared twice`)
    actionIds.add(a.id)
    if (a.label.length === 0) throw new Error(`Module ${id}: declared action "${a.id}" needs a label`)
  }
}

/**
 * Declare a module. Infers the settings type from `settings`, and the context `start` receives from `apiVersion`:
 * without it (version 1) `ModuleContext`, with `apiVersion: 2` `ModuleContextV2` (with `host`).
 */
export const defineModule = <const S extends SettingsSpec = {}, const V extends number = 1, X = undefined>(definition: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly settings?: S
  readonly enabledByDefault?: boolean
  readonly enabledWhenSet?: keyof S & string
  readonly kind?: ModuleKind
  readonly apiVersion?: V
  readonly version?: string
  readonly requires?: ReadonlyArray<Requirement>
  readonly platforms?: Platforms
  readonly health?: (context: HealthContext<SettingsOf<S>>) => Effect.Effect<ReadonlyArray<Issue>>
  readonly templates?: ReadonlyArray<ModuleTemplate>
  readonly declaredActions?: ReadonlyArray<DeclaredAction>
  readonly uses?: ReadonlyArray<string>
  readonly shared?: (context: SharedContext<SettingsOf<S>>) => Effect.Effect<SharedPart<X>, ModuleStartError, Scope.Scope>
  readonly start: (context: ModuleContextOf<V, SettingsOf<S>, X>) => Effect.Effect<ModuleInstance, ModuleStartError, Scope.Scope>
}): ModuleDefinition<S> => {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(definition.id)) {
    throw new Error(`Module id "${definition.id}" must match /^[a-z][a-z0-9-]{0,39}$/`)
  }
  checkManifest(definition.id, definition)
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    settings: definition.settings ?? ({} as S),
    enabledByDefault: definition.enabledByDefault ?? true,
    ...(definition.enabledWhenSet !== undefined ? { enabledWhenSet: definition.enabledWhenSet } : {}),
    ...(definition.kind !== undefined ? { kind: definition.kind } : {}),
    ...(definition.apiVersion !== undefined ? { apiVersion: definition.apiVersion } : {}),
    ...(definition.version !== undefined ? { version: definition.version } : {}),
    ...(definition.requires !== undefined ? { requires: definition.requires } : {}),
    ...(definition.platforms !== undefined ? { platforms: definition.platforms } : {}),
    ...(definition.health !== undefined ? { health: definition.health } : {}),
    ...(definition.templates !== undefined ? { templates: definition.templates } : {}),
    ...(definition.declaredActions !== undefined ? { declaredActions: definition.declaredActions } : {}),
    ...(definition.uses !== undefined ? { uses: definition.uses } : {}),
    ...(definition.shared !== undefined ? { shared: definition.shared as NonNullable<ModuleDefinition<S>["shared"]> } : {}),
    // The host passes the context of the module's version (`ModuleContextOf`).
    start: definition.start as ModuleDefinition<S>["start"]
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
