import { Effect } from "effect"
import { ActionError, type ActionOutcome, type RegisteredAction } from "./Actions.ts"
import { ToolError } from "./Errors.ts"
import type { Tool } from "./Module.ts"

/**
 * The execution gateway's private half: how a call it admitted reaches module code. This file is deliberately not
 * exported from the package (`src/index.ts` leaves it out, and `package.json` exports only the index), so nothing
 * outside core runs a published tool or action by accident without admission. That is all sealing does: it stops
 * accidental direct calls. It is not a security boundary against code compiled into the process (docs/MODULES-PLAN.md
 * §3.5): a runner is found by the published object, not by the gateway that published it, so any gateway (the
 * default one too) runs a sealed handle it is given, and the module id a caller passes is not checked against the
 * handle's owner.
 *
 * The module host **seals** every tool and action it publishes: the published object's `execute` / `run` only
 * refuses, and the real one (wrapped in the host's in-flight tracking) is kept here, where only the gateway looks it
 * up. A tool or action that is not sealed (a hand-made registry's, a module definition's own) is its own runner.
 */

const NOT_ADMITTED = "Not run: this can only be run through the execution gateway."

type ToolRunner = (input: unknown) => Effect.Effect<unknown, ToolError>
type ActionRunner = (values: Readonly<Record<string, unknown>>) => Effect.Effect<ActionOutcome | void, ActionError>

const toolRunners = new WeakMap<Tool, ToolRunner>()
const actionRunners = new WeakMap<object, ActionRunner>()

/** A copy of `tool` whose `execute` refuses; the gateway runs `run` instead. */
export const sealTool = (tool: Tool, run: ToolRunner): Tool => {
  const sealed: Tool = { ...tool, execute: () => Effect.fail(new ToolError({ message: NOT_ADMITTED })) }
  toolRunners.set(sealed, run)
  return sealed
}

/** A copy of `registered` whose definition's `run` refuses; the gateway runs `run` instead. */
export const sealAction = (registered: RegisteredAction, run: ActionRunner): RegisteredAction => {
  const definition = { ...registered.definition, run: () => Effect.fail(new ActionError({ message: NOT_ADMITTED })) }
  actionRunners.set(definition, run)
  return { ...registered, definition }
}

/** How the gateway runs an admitted tool. */
export const toolRunnerOf = (tool: Tool): ToolRunner => toolRunners.get(tool) ?? ((input) => tool.execute(input))

/** How the gateway runs an admitted action. */
export const actionRunnerOf = (registered: RegisteredAction): ActionRunner =>
  actionRunners.get(registered.definition) ?? ((values) => registered.definition.run(values as never))

/**
 * Run an action declared `confirm: true` after core consumed the owner's spoken yes (`Conversation`, only while its
 * `confirmActions` is "on"): the gateway's own confirmed path, registered by `makeExecutionGateway`. No caller outside
 * core can reach it; every public path refuses such an action.
 */
export type ConfirmedRunner = (
  action: RegisteredAction,
  values: Readonly<Record<string, unknown>>
) => Effect.Effect<ActionOutcome | void, ActionError>

const confirmedRunners = new WeakMap<object, ConfirmedRunner>()
const registryGateways = new WeakMap<object, object>()

export const registerConfirmedRunner = (gateway: object, run: ConfirmedRunner) => void confirmedRunners.set(gateway, run)
export const registerRegistryGateway = (registry: object, gateway: object) => void registryGateways.set(registry, gateway)

/** The confirmed runner of the gateway a registry runs through (`undefined`: a registry made without one). */
export const confirmedRunnerOf = (registry: object | undefined, fallback: object): ConfirmedRunner | undefined => {
  const gateway = (registry === undefined ? undefined : registryGateways.get(registry)) ?? fallback
  return confirmedRunners.get(gateway)
}
