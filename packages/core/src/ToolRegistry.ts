import { Context, Effect, Layer, Schema } from "effect"
import type { ActionError, ActionOutcome, RegisteredAction } from "./Actions.ts"
import type { ToolCall, ToolResult, ToolSpec } from "./Domain.ts"
import { defaultGateway, type ExecutionGateway, prepareTool } from "./Gateway.ts"
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
   * Run an action with its values through the registry's gateway (the intent agent, a confirmed action). Absent in
   * hand-made registries: callers use `defaultGateway.action`.
   */
  readonly runAction?: (
    action: RegisteredAction,
    values: Readonly<Record<string, unknown>>,
    options?: { readonly confirmed?: boolean }
  ) => Effect.Effect<ActionOutcome | void, ActionError>
  /** Output of every context provider, formatted for `LlmRequest.context` ("" if none; empty outputs are left out). */
  readonly context: Effect.Effect<string>
}>()("@pva/core/ToolRegistry") {
  static readonly layer = (modules: ReadonlyArray<AssistantModule>) =>
    Layer.sync(ToolRegistry, () => makeToolRegistry(modules))
}

const toSpec = (tool: Tool): ToolSpec => {
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
  /** The gateway every call goes through. Default: `defaultGateway` (no access checks, no hooks). */
  readonly gateway?: ExecutionGateway
}

/** A registry of `modules`' tools; each tool belongs to the module whose `name` lists it (the module host names parts by module id). */
export const makeToolRegistry = (modules: ReadonlyArray<AssistantModule>, options: ToolRegistryOptions = {}): ToolRegistry["Service"] => {
  const gateway = options.gateway ?? defaultGateway
  const tools = new Map<string, { readonly tool: Tool; readonly moduleId: string }>()
  const providers: Array<ContextProvider> = []
  const actions: Array<RegisteredAction> = []
  for (const module of modules) {
    for (const tool of module.tools ?? []) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" (module ${module.name})`)
      tools.set(tool.name, { tool, moduleId: module.name })
      // The input decoder is made here, once per tool (cached across registries), never on a call.
      prepareTool(tool)
      if (tool.action !== undefined) actions.push(tool.action)
    }
    actions.push(...(module.intentActions ?? []))
    providers.push(...(module.context ?? []))
  }
  const specs = Array.from(tools.values(), ({ tool }) => toSpec(tool))

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

  return ToolRegistry.of({
    specs,
    isSpeculative: (name) => tools.get(name)?.tool.speculative === true,
    actionFor: (name) => tools.get(name)?.tool.action,
    actions,
    runAction: gateway.action,
    run,
    context
  })
}
