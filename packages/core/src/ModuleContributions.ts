import type { AgentKind, ChoiceOption, ModuleKind } from "@pva/protocol"
import { Effect, type Scope } from "effect"
import type { ActionDefinition } from "./Actions.ts"
import type { Agent } from "./Agent.ts"
import type { DecisionProvider } from "./Decision.ts"
import { defineModule, type ModuleContext, type ModuleDefinition, type ModuleInstance, type ModuleStartError } from "./ModuleDefinition.ts"
import type { SettingsOf, SettingsSpec } from "./Settings.ts"

/**
 * Agents, decision providers and actions are contributed by modules
 * (docs/AGENTS-AND-INTENTS.md §1.6): one host, one settings mechanism, one
 * persistence file, one generated form, one enable switch for everything
 * pluggable. An agent is a module of kind "agent" whose instance contributes
 * one `Agent`; a decision provider is a module of kind "decider"; any module
 * may contribute actions next to its tools.
 *
 * `ModuleInstance` extends `ModuleContributions`; the module host collects the
 * running modules' agents, actions (plus one generated tool per action) and
 * deciders into its snapshot.
 */

/** Result of pressing an `action` field ("Test", "Refresh model list"), shown under the button. */
export interface FieldActionResult {
  readonly ok: boolean
  /** One or two sentences for the owner ("First text after 640 ms: 'Hello there.'"). At most 500 characters. */
  readonly text: string
  readonly tone?: "neutral" | "ok" | "warning" | "error"
}

/** What a running module may contribute besides tools, context and instructions. */
export interface ModuleContributions {
  /** Agents (a module of kind "agent" contributes exactly one). */
  readonly agents?: ReadonlyArray<Agent>
  /** Commands for the typed-intent path; each is also offered as a tool unless it says otherwise. */
  readonly actions?: ReadonlyArray<ActionDefinition<any>>
  /** Decision providers (a module of kind "decider" contributes exactly one). */
  readonly deciders?: ReadonlyArray<DecisionProvider>
  /**
   * Options for `combo` fields known only while running (a model list fetched
   * from the backend at start). Read whenever the form is described: return a cached value.
   */
  readonly settingOptions?: () => Readonly<Record<string, ReadonlyArray<ChoiceOption>>>
  /** Values of `info` fields (read-only text). Read whenever the form is described. */
  readonly info?: () => Readonly<Record<string, string>>
  /** Handlers of the module's `action` fields, by field key. */
  readonly fieldActions?: Readonly<Record<string, () => Effect.Effect<FieldActionResult>>>
}

/** Kept for compatibility: `ModuleInstance` itself now carries the contributions. */
export type ExtendedModuleInstance = ModuleInstance

/** A module definition with its kind (the UI groups cards by it). */
export type KindedModuleDefinition<S extends SettingsSpec> = ModuleDefinition<S> & {
  readonly kind: ModuleKind
  readonly agentKind?: AgentKind
}

/** What an agent module's `start` returns: the behaviour; `defineAgent` adds id, name and kind. */
export interface AgentImplementation extends Omit<ModuleContributions, "agents" | "deciders"> {
  readonly turn: Agent["turn"]
  /** Default: true for `model` and `intent`, false for `harness`. */
  readonly speculate?: boolean
  /** The agent's own system prompt; empty or absent = the global one. */
  readonly systemPrompt?: string | undefined
  /** Default: model 5000 ms, harness 8000 ms, intent 1500 ms. */
  readonly firstEventTimeoutMs?: number
  /** `Agent.endConversation`: drop what is kept for a conversation that has ended. */
  readonly endConversation?: Agent["endConversation"]
}

export const defaultFirstEventTimeoutMs: Readonly<Record<AgentKind, number>> = { model: 5_000, harness: 8_000, intent: 1_500 }

/** Assemble the `Agent` from what `start` returned. */
export const toAgent = (
  meta: { readonly id: string; readonly name: string; readonly kind: AgentKind },
  impl: AgentImplementation
): Agent => ({
  id: meta.id,
  name: meta.name,
  kind: meta.kind,
  speculate: impl.speculate ?? meta.kind !== "harness",
  firstEventTimeoutMs: impl.firstEventTimeoutMs ?? defaultFirstEventTimeoutMs[meta.kind],
  ...(impl.systemPrompt !== undefined && impl.systemPrompt.trim() !== "" ? { systemPrompt: impl.systemPrompt } : {}),
  turn: impl.turn,
  ...(impl.endConversation !== undefined ? { endConversation: impl.endConversation } : {})
})

/**
 * Declare an agent: one file exporting this, plus one line in the app's agent
 * catalog. Settings, the enable switch, persistence, the status line, the form
 * and a "Test" button (added by the host for every agent) come with it.
 */
export const defineAgent = <const S extends SettingsSpec = {}>(definition: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly kind: AgentKind
  readonly settings?: S
  /** Default false: the owner switches an agent on (it may need a key, a login or an opt-in). */
  readonly enabledByDefault?: boolean
  /** Enabled before the owner has chosen once this secret setting is set (see `ModuleDefinition.enabledWhenSet`). */
  readonly enabledWhenSet?: keyof S & string
  readonly start: (context: ModuleContext<SettingsOf<S>>) => Effect.Effect<AgentImplementation, ModuleStartError, Scope.Scope>
}): KindedModuleDefinition<S> => {
  const module = defineModule({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    ...(definition.settings !== undefined ? { settings: definition.settings } : {}),
    enabledByDefault: definition.enabledByDefault ?? false,
    ...(definition.enabledWhenSet !== undefined ? { enabledWhenSet: definition.enabledWhenSet } : {}),
    start: (context) =>
      Effect.map(definition.start(context), (impl): ExtendedModuleInstance => {
        const { firstEventTimeoutMs: _t, speculate: _s, systemPrompt: _p, turn: _turn, ...contributions } = impl
        return { ...contributions, agents: [toAgent(definition, impl)] }
      })
  })
  return { ...module, kind: "agent", agentKind: definition.kind }
}

/** Declare a decision-provider module (Jev, the offline keyword matcher, a local classifier). */
export const defineDecider = <const S extends SettingsSpec = {}>(definition: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly settings?: S
  readonly enabledByDefault?: boolean
  /** Enabled before the owner has chosen once this secret setting is set (see `ModuleDefinition.enabledWhenSet`). */
  readonly enabledWhenSet?: keyof S & string
  readonly start: (
    context: ModuleContext<SettingsOf<S>>
  ) => Effect.Effect<Pick<DecisionProvider, "decide" | "location"> & Omit<ModuleContributions, "agents" | "deciders">, ModuleStartError, Scope.Scope>
}): KindedModuleDefinition<S> => {
  const module = defineModule({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    ...(definition.settings !== undefined ? { settings: definition.settings } : {}),
    enabledByDefault: definition.enabledByDefault ?? false,
    ...(definition.enabledWhenSet !== undefined ? { enabledWhenSet: definition.enabledWhenSet } : {}),
    start: (context) =>
      Effect.map(definition.start(context), ({ decide, location, ...contributions }): ExtendedModuleInstance => ({
        ...contributions,
        deciders: [{ id: definition.id, name: definition.name, location, decide }]
      }))
  })
  return { ...module, kind: "decider" }
}
