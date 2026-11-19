import { Context, Effect, Layer, Schema, SchemaAST as AST } from "effect"
import { type ActionError, type ActionOutcome, actionToolName, type RegisteredAction } from "./Actions.ts"
import type { ToolCall, ToolResult, ToolSpec } from "./Domain.ts"
import { type ActionCallOptions, defaultGateway, type ExecutionGateway, prepareTool } from "./Gateway.ts"
import { registerRegistryGateway } from "./GatewayPrivate.ts"
import type { AssistantModule, ContextProvider, Tool } from "./Module.ts"

/**
 * The tools and context providers of all enabled modules.
 * `run` never fails: unknown tools, invalid input, refusals and tool failures become
 * error results for the model. Every call goes through the registry's execution gateway
 * (`Gateway.ts`), which validates the input and checks the call before `execute` runs.
 */
export class ToolRegistry extends Context.Service<ToolRegistry, {
  readonly specs: ReadonlyArray<ToolSpec>
  isSpeculative(name: string): boolean
  run(call: ToolCall): Effect.Effect<ToolResult>
  /** The action a generated action tool stands for (`Tool.action`); absent for other tools and in hand-made registries. */
  readonly actionFor?: (name: string) => RegisteredAction | undefined
  /**
   * Every action of the registry's modules, for intent agents, in module order: those of its generated action tools
   * and those its modules offer only to intent agents (`AssistantModule.intentActions`). Absent in hand-made registries.
   */
  readonly actions?: ReadonlyArray<RegisteredAction>
  /**
   * Run an action with its values through the registry's gateway (the intent agent). An action declared
   * `confirm: true` is refused. Absent in hand-made registries: callers use `defaultGateway.action`.
   */
  readonly runAction?: (
    action: RegisteredAction,
    values: Readonly<Record<string, unknown>>,
    options?: Pick<ActionCallOptions, "onAdmitted" | "holdUntil">
  ) => Effect.Effect<ActionOutcome | void, ActionError>
  /** Output of every context provider, formatted for `LlmRequest.context` ("" if none; empty outputs are left out). */
  readonly context: Effect.Effect<string>
}>()("@pva/core/ToolRegistry") {
  static readonly layer = (modules: ReadonlyArray<AssistantModule>) =>
    Layer.sync(ToolRegistry, () => makeToolRegistry(modules))
}

/** Whether a schema is a struct with no fields and nothing else (a tool without parameters), whatever its annotations. */
const isEmptyStruct = (schema: Schema.Top): boolean => {
  const ast = schema.ast
  return AST.isObjects(ast) && ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0
}

/**
 * A tool as a model provider and the Claude Code bridge receive it: its name, description and parameters as a JSON
 * Schema. A tool without parameters (an empty `Schema.Struct({})`, whatever its annotations) is sent as
 * `{ "type": "object", "properties": {} }`, because providers take only an object schema as a tool's input.
 */
export const toolSpec = (tool: Tool): ToolSpec => {
  if (isEmptyStruct(tool.parameters)) return { name: tool.name, description: tool.description, inputSchema: { type: "object", properties: {} } }
  const document = Schema.toJsonSchemaDocument(tool.parameters)
  const inputSchema: Record<string, unknown> = { ...document.schema }
  if (Object.keys(document.definitions).length > 0) inputSchema.$defs = document.definitions
  return { name: tool.name, description: tool.description, inputSchema }
}

const errorResult = (call: ToolCall, content: string): ToolResult => ({
  id: call.id,
  name: call.name,
  content,
  isError: true
})

const encodeResult = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return "ok"
  return JSON.stringify(value)
}

export interface ToolRegistryOptions {
  /**
   * The gateway every call goes through. Default: `defaultGateway` (no access checks, no hooks). A tool or action its
   * risk policy refuses for every class (`ExecutionGateway.offers`) is left out of `specs` and `actions`, decided on the
   * policy of the moment they are read (P8: a saved change applies to the next list without a new registry); a call that
   * names it anyway reaches the gateway, which refuses it.
   */
  readonly gateway?: ExecutionGateway
}

/**
 * A module's part as one assistant has it: without the tools it switched off (`offTools`: a tool's name, or an
 * action's generated tool name `<moduleId>_<actionId>`), and without the intent actions whose generated tool name it
 * switched off. Serve mode builds each assistant's registry, the model's tool list, with it; so does the test kit.
 */
export const withoutOffTools = (module: AssistantModule, offTools: ReadonlyArray<string>): AssistantModule => {
  if (offTools.length === 0) return module
  const off = new Set(offTools)
  const intentActions = module.intentActions?.filter((a) => !off.has(actionToolName(a.moduleId, a.definition.id)))
  return { ...module, tools: (module.tools ?? []).filter((t) => !off.has(t.name)), ...(intentActions !== undefined ? { intentActions } : {}) }
}

/**
 * A registry like `base` with some members replaced (a wrapper's `run`, `context`). Its tool list and actions are read
 * through `base` whenever they are read (P8: `base` decides them on the risk policy of that moment), never copied.
 */
export const registryWith = (
  base: ToolRegistry["Service"],
  patch: Partial<Omit<ToolRegistry["Service"], "specs" | "actions">>
): ToolRegistry["Service"] => {
  const out = { ...base, ...patch }
  Object.defineProperty(out, "specs", { get: () => base.specs, enumerable: true, configurable: true })
  if (base.actions !== undefined) Object.defineProperty(out, "actions", { get: () => base.actions, enumerable: true, configurable: true })
  return ToolRegistry.of(out)
}

/** A registry of `modules`' tools; each tool belongs to the module whose `name` lists it (the module host names parts by module id). */
export const makeToolRegistry = (modules: ReadonlyArray<AssistantModule>, options: ToolRegistryOptions = {}): ToolRegistry["Service"] => {
  const gateway = options.gateway ?? defaultGateway
  const tools = new Map<string, { readonly tool: Tool; readonly moduleId: string; readonly spec: ToolSpec }>()
  const providers: Array<ContextProvider> = []
  /** Every action, in module order, before the policy (each with its generated tool's entry when it has one). */
  const allActions: Array<RegisteredAction> = []
  for (const module of modules) {
    for (const tool of module.tools ?? []) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" (module ${module.name})`)
      // The input decoder and the JSON Schema are made here, once per tool (the decoder cached across registries), never on a call.
      prepareTool(tool)
      tools.set(tool.name, { tool, moduleId: module.name, spec: toolSpec(tool) })
      if (tool.action !== undefined) allActions.push(tool.action)
    }
    allActions.push(...(module.intentActions ?? []))
    providers.push(...(module.context ?? []))
  }
  /**
   * The list and the actions the policy offers now (`ExecutionGateway.offerKey`): decided again only when what the
   * policy offers changed, so reading them is a key comparison (one decision per tool after a change).
   */
  let offered: { readonly key: string; readonly specs: ReadonlyArray<ToolSpec>; readonly actions: ReadonlyArray<RegisteredAction> } | undefined
  const offeredNow = () => {
    const key = gateway.offerKey()
    if (offered === undefined || offered.key !== key) {
      offered = {
        key,
        specs: Array.from(tools.values()).filter(({ tool }) => gateway.offers(tool.action?.definition ?? tool)).map(({ spec }) => spec),
        actions: allActions.filter((a) => gateway.offers(a.definition))
      }
    }
    return offered
  }

  const run = (call: ToolCall): Effect.Effect<ToolResult> => {
    const entry = tools.get(call.name)
    if (entry === undefined) return Effect.succeed(errorResult(call, `Unknown tool "${call.name}"`))
    // Validation, the checks and `execute`, in the gateway. A tool that throws while building its effect is a defect
    // caught here, not a failed turn; interruption is neither an error nor a defect, so it passes through.
    return gateway.tool(entry.moduleId, entry.tool, call.input).pipe(
      Effect.map((value): ToolResult => ({ id: call.id, name: call.name, content: encodeResult(value), isError: false })),
      Effect.catch((error) => Effect.succeed(errorResult(call, error.message))),
      Effect.catchDefect((defect) => Effect.succeed(errorResult(call, `Tool crashed: ${String(defect)}`)))
    )
  }

  const context = providers.length === 0
    ? Effect.succeed("")
    : Effect.forEach(providers, (p) => Effect.map(p.get, (text) => text.length === 0 ? "" : `## ${p.name}\n${text}`), {
      concurrency: "unbounded"
    }).pipe(Effect.map((sections) => sections.filter((s) => s.length > 0).join("\n\n")))

  const registry = ToolRegistry.of({
    get specs() {
      return offeredNow().specs
    },
    isSpeculative: (name) => tools.get(name)?.tool.speculative === true,
    actionFor: (name) => tools.get(name)?.tool.action,
    get actions() {
      return offeredNow().actions
    },
    // Never with a caller's principal or a claim of confirmation: the turn's own context decides who it runs for.
    runAction: (action, values, runOptions) =>
      gateway.action(action, values, {
        ...(runOptions?.onAdmitted !== undefined ? { onAdmitted: runOptions.onAdmitted } : {}),
        ...(runOptions?.holdUntil !== undefined ? { holdUntil: runOptions.holdUntil } : {})
      }),
    run,
    context
  })
  registerRegistryGateway(registry, gateway)
  return registry
}
