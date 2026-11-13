import { Context, Effect, Layer, Schema } from "effect"
import type { ToolCall, ToolResult, ToolSpec } from "./Domain.ts"
import type { AssistantModule, ContextProvider, Tool } from "./Module.ts"

/**
 * The tools and context providers of all enabled modules.
 * `run` never fails: unknown tools, invalid input and tool failures become
 * error results for the model.
 */
export class ToolRegistry extends Context.Service<ToolRegistry, {
  readonly specs: ReadonlyArray<ToolSpec>
  isSpeculative(name: string): boolean
  run(call: ToolCall): Effect.Effect<ToolResult>
  /** Output of every context provider, formatted for `LlmRequest.context` ("" if none). */
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

export const makeToolRegistry = (modules: ReadonlyArray<AssistantModule>): ToolRegistry["Service"] => {
  const tools = new Map<string, { readonly tool: Tool; readonly decode: (u: unknown) => Effect.Effect<any, Schema.SchemaError> }>()
  const providers: Array<ContextProvider> = []
  for (const module of modules) {
    for (const tool of module.tools ?? []) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" (module ${module.name})`)
      // The JSON Schema describes the canonical JSON form, so decode with the matching codec.
      tools.set(tool.name, { tool, decode: Schema.decodeUnknownEffect(Schema.toCodecJson(tool.parameters)) })
    }
    providers.push(...(module.context ?? []))
  }
  const specs = Array.from(tools.values(), ({ tool }) => toSpec(tool))

  const run = (call: ToolCall): Effect.Effect<ToolResult> => {
    const entry = tools.get(call.name)
    if (entry === undefined) return Effect.succeed(errorResult(call, `Unknown tool "${call.name}"`))
    return entry.decode(call.input).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(errorResult(call, `Invalid input: ${error.message}`)),
        onSuccess: (input) =>
          entry.tool.execute(input).pipe(
            Effect.map((value): ToolResult => ({ id: call.id, name: call.name, content: encodeResult(value), isError: false })),
            Effect.catch((error) => Effect.succeed(errorResult(call, error.message))),
            Effect.catchDefect((defect) => Effect.succeed(errorResult(call, `Tool crashed: ${String(defect)}`)))
          )
      })
    )
  }

  const context = providers.length === 0
    ? Effect.succeed("")
    : Effect.forEach(providers, (p) => Effect.map(p.get, (text) => `## ${p.name}\n${text}`), { concurrency: "unbounded" })
      .pipe(Effect.map((sections) => sections.join("\n\n")))

  return ToolRegistry.of({
    specs,
    isSpeculative: (name) => tools.get(name)?.tool.speculative === true,
    run,
    context
  })
}
