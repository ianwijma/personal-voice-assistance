/**
 * `Llm` via the official `@anthropic-ai/sdk` (default model claude-haiku-5-5).
 * Reference for every setting here: docs/protocols/anthropic-streaming.md.
 */
import Anthropic from "@anthropic-ai/sdk"
import { Llm, LlmError, type LlmEvent, type LlmRequest, type Message, type StopReason } from "@pva/core"
import { Cause, Config, Effect, Layer, Queue, Redacted, Stream } from "effect"

export type Effort = "low" | "medium" | "high"
/**
 * "disabled" is the default: lowest latency, and core's history cannot carry
 * thinking blocks, which the API expects to be replayed during a tool loop.
 * "adaptive" exists for A/B tests only (see the reference, section 1).
 */
export type ThinkingMode = "disabled" | "adaptive"

export interface AnthropicLlmOptions {
  readonly apiKey: Redacted.Redacted<string>
  /**
   * The API endpoint. Default `DEFAULT_BASE_URL`. Always passed to the SDK, so the SDK never falls back to reading
   * `ANTHROPIC_BASE_URL` from `process.env` itself: the value comes from the settings (`config`), like the rest.
   */
  readonly baseURL?: string
  readonly model: string
  readonly maxTokens: number
  readonly effort: Effort
  readonly thinking: ThinkingMode
  /** Fail when no response headers, or no stream event, arrive for this long. */
  readonly timeoutMs: number
  /** Open the HTTPS connection at startup (cheap authenticated GET). */
  readonly warmUp: boolean
}

/** The public API. */
export const DEFAULT_BASE_URL = "https://api.anthropic.com"

export const defaults = {
  baseURL: DEFAULT_BASE_URL,
  model: "claude-haiku-5-5",
  maxTokens: 1024,
  effort: "low",
  thinking: "disabled",
  timeoutMs: 5_000,
  warmUp: true
} as const

// ---------------------------------------------------------------------------
// Request mapping

type Block = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
interface Turn {
  role: "user" | "assistant"
  content: Array<Block>
}

const ephemeral = { type: "ephemeral" } as const

/**
 * Maps core history to Anthropic messages: tool results become user
 * `tool_result` blocks, consecutive same-role messages are merged (tool results
 * first, as the API requires), and messages with no content are dropped.
 */
export const toMessages = (messages: ReadonlyArray<Message>): Array<Turn> => {
  const turns: Array<Turn> = []
  for (const message of messages) {
    let role: Turn["role"]
    let content: Array<Block>
    switch (message.role) {
      case "user":
        role = "user"
        content = message.content.length > 0 ? [{ type: "text", text: message.content }] : []
        break
      case "assistant":
        role = "assistant"
        content = [
          ...(message.content.length > 0 ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call): Block => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input
          }))
        ]
        break
      case "tool":
        role = "user"
        content = message.results.map((result): Block => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        }))
        break
    }
    if (content.length === 0) continue
    const last = turns.at(-1)
    if (last?.role === role) {
      const all = [...last.content, ...content]
      last.content = [...all.filter((b) => b.type === "tool_result"), ...all.filter((b) => b.type !== "tool_result")]
    } else {
      turns.push({ role, content })
    }
  }
  return turns
}

/**
 * Cache layout (prefix order is tools -> system -> messages):
 * 1. breakpoint on the system block: caches tools + system;
 * 2. breakpoint on the last history block: caches the conversation so far.
 * `request.context` changes every turn and core does not store it in history,
 * so it goes into the last user message *after* breakpoint 2. Next turn that
 * message is replayed without it, which is exactly the prefix that was cached,
 * so neither breakpoint is invalidated by a changing clock.
 */
export const toParams = (
  request: LlmRequest,
  options: Pick<AnthropicLlmOptions, "model" | "maxTokens" | "effort" | "thinking">
): Anthropic.MessageCreateParamsStreaming => {
  const turns = toMessages(request.messages)
  const last = turns.at(-1)
  const lastBlock = last?.content.at(-1)
  if (lastBlock !== undefined) lastBlock.cache_control = ephemeral
  if (request.context !== undefined && request.context.length > 0) {
    const block: Block = { type: "text", text: `<context>\n${request.context}\n</context>` }
    if (last?.role === "user") last.content.push(block)
    else turns.push({ role: "user", content: [block] })
  }
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    output_config: { effort: options.effort },
    ...(options.thinking === "disabled" ? { thinking: { type: "disabled" } } : {}),
    system: [{ type: "text", text: request.system, cache_control: ephemeral }],
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
    })),
    messages: turns,
    stream: true
  }
}

export const toStopReason = (reason: Anthropic.StopReason | null): StopReason => {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end"
    case "tool_use":
      return "tool_use"
    case "max_tokens":
      return "max_tokens"
    default:
      return "other"
  }
}

// ---------------------------------------------------------------------------
// Errors

class StallError extends Error {}
class InvalidToolInput extends Error {}

/** Worth one immediate retry, if nothing was emitted yet (reference, section 7). */
const isRetryable = (e: unknown): boolean => {
  if (e instanceof StallError) return true
  if (e instanceof Anthropic.APIUserAbortError) return false
  if (e instanceof Anthropic.APIConnectionError) return true // includes timeouts
  if (e instanceof Anthropic.APIError) {
    // Mid-stream SSE `error` events have no status, only a type.
    if (e.status === undefined) return e.type === "overloaded_error" || e.type === "api_error"
    return e.status === 408 || e.status === 409 || e.status >= 500
  }
  return false
}

const toLlmError = (e: unknown): LlmError => {
  if (e instanceof LlmError) return e
  if (e instanceof Anthropic.APIError) {
    const parts = [
      "Anthropic API error",
      e.status !== undefined ? String(e.status) : undefined,
      e.type ?? e.name,
      ": ",
      e.apiMessage ?? e.message,
      e.requestID ? ` (request-id ${e.requestID})` : undefined
    ]
    return new LlmError({ message: parts.filter(Boolean).join(" ").replace(" : ", ": "), cause: e })
  }
  return new LlmError({ message: e instanceof Error ? e.message : String(e), cause: e })
}

// ---------------------------------------------------------------------------
// Streaming

/** One model call. Resolves without throwing if `signal` aborts. */
async function attempt(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsStreaming,
  signal: AbortSignal,
  timeoutMs: number,
  emit: (event: LlmEvent) => void
): Promise<void> {
  const watchdog = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      watchdog.abort()
    }, timeoutMs)
  }
  try {
    const stream = await client.messages.create(params, {
      signal: AbortSignal.any([signal, watchdog.signal]),
      timeout: timeoutMs,
      maxRetries: 0
    })
    arm()
    const tools = new Map<number, { id: string; name: string; json: string }>()
    let stopReason: Anthropic.StopReason | null = null
    // The iterator returns silently (no throw) when the request is aborted.
    for await (const event of stream) {
      arm()
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            tools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" })
          }
          break
        case "content_block_delta":
          if (event.delta.type === "text_delta") emit({ _tag: "TextDelta", text: event.delta.text })
          else if (event.delta.type === "input_json_delta") {
            const tool = tools.get(event.index)
            if (tool) tool.json += event.delta.partial_json
          }
          break
        case "content_block_stop": {
          const tool = tools.get(event.index)
          if (!tool) break
          tools.delete(event.index)
          let input: unknown
          try {
            input = tool.json === "" ? {} : JSON.parse(tool.json)
          } catch {
            throw new InvalidToolInput(`Invalid JSON input for tool ${tool.name}: ${tool.json}`)
          }
          emit({ _tag: "ToolCall", id: tool.id, name: tool.name, input })
          break
        }
        case "message_delta":
          stopReason = event.delta.stop_reason
          break
      }
    }
    if (stalled) throw new StallError(`No stream event from Anthropic for ${timeoutMs} ms`)
    if (!signal.aborted) emit({ _tag: "Done", stopReason: toStopReason(stopReason) })
  } catch (e) {
    if (stalled) throw new StallError(`No response from Anthropic within ${timeoutMs} ms`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export const make = Effect.fnUntraced(function*(options: AnthropicLlmOptions) {
  // One client for the process: undici keeps the connection alive between turns.
  const client = new Anthropic({
    apiKey: Redacted.value(options.apiKey),
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    timeout: options.timeoutMs,
    maxRetries: 0
  })

  if (options.warmUp) {
    // Opens TCP+TLS to the API (and validates the key) so the first turn does
    // not pay for the handshake. Whether the pooled connection survives until
    // the first turn depends on the server's keep-alive hint (unverified).
    yield* Effect.tryPromise({
      try: (signal) => client.models.retrieve(options.model, null, { signal }),
      catch: toLlmError
    }).pipe(
      Effect.tapError((e) => Effect.logWarning(`Anthropic warm-up failed: ${e.message}`)),
      Effect.ignore,
      Effect.forkScoped
    )
  }

  const stream = (request: LlmRequest): Stream.Stream<LlmEvent, LlmError> =>
    Stream.callback<LlmEvent, LlmError>((queue) =>
      Effect.gen(function*() {
        // Closing the stream's scope (completion, error or interruption of the
        // consumer) aborts the HTTP request: barge-in depends on this.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (c) => Effect.sync(() => c.abort())
        )
        const params = toParams(request, options)
        let emitted = false
        const emit = (event: LlmEvent) => {
          emitted = true
          Queue.offerUnsafe(queue, event)
        }
        const run = async () => {
          try {
            await attempt(client, params, controller.signal, options.timeoutMs, emit)
          } catch (e) {
            if (emitted || controller.signal.aborted || !isRetryable(e)) throw e
            await attempt(client, params, controller.signal, options.timeoutMs, emit)
          }
        }
        run().then(
          () => Queue.endUnsafe(queue),
          (e) => Queue.failCauseUnsafe(queue, Cause.fail(toLlmError(e)))
        )
      })
    )

  return Llm.of({ stream })
})

export const layer = (options: AnthropicLlmOptions): Layer.Layer<Llm> => Layer.effect(Llm, make(options))

/** Options from the environment; everything but the API key has a default. */
export const config = Config.all({
  apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
  baseURL: Config.String("ANTHROPIC_BASE_URL").pipe(Config.withDefault(DEFAULT_BASE_URL)),
  model: Config.String("ANTHROPIC_MODEL").pipe(Config.withDefault(defaults.model)),
  maxTokens: Config.Int("ANTHROPIC_MAX_TOKENS").pipe(Config.withDefault(defaults.maxTokens)),
  effort: Config.Literals(["low", "medium", "high"], "ANTHROPIC_EFFORT").pipe(
    Config.withDefault<Effort>(defaults.effort)
  ),
  thinking: Config.Literals(["disabled", "adaptive"], "ANTHROPIC_THINKING").pipe(
    Config.withDefault<ThinkingMode>(defaults.thinking)
  ),
  timeoutMs: Config.Int("ANTHROPIC_TIMEOUT_MS").pipe(Config.withDefault(defaults.timeoutMs)),
  warmUp: Config.Boolean("ANTHROPIC_WARM_UP").pipe(Config.withDefault<boolean>(defaults.warmUp))
})

export const layerConfig: Layer.Layer<Llm, Config.ConfigError> = Layer.effect(
  Llm,
  Effect.flatMap(config, make)
)

export const AnthropicLlm = { layer, layerConfig, make, config } as const
