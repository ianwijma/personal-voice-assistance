/**
 * `Llm` via the official `@anthropic-ai/sdk` (default model claude-haiku-5-5).
 * Reference for every setting here: docs/protocols/anthropic-streaming.md.
 */
import Anthropic from "@anthropic-ai/sdk"
import { Llm, LlmError, type LlmEvent, type LlmRequest, type Message, type StopReason } from "@pva/core"
import { Cause, Config, Effect, Layer, Queue, Redacted, Stream } from "effect"
import { addressSecrets, checkAddress, clip, fromUpstream, logText, safeId, sanitize, type Secrets, secretList } from "./redact.ts"

export type Effort = "low" | "medium" | "high"
/**
 * "disabled" is the default: lowest latency, and core's history cannot carry
 * thinking blocks, which the API expects to be replayed during a tool loop.
 * "adaptive" exists for A/B tests only (see the reference, section 1).
 */
export type ThinkingMode = "disabled" | "adaptive"

export interface AnthropicLlmOptions {
  readonly apiKey: Redacted.Redacted<string>
  /** Defaults to the SDK default (`ANTHROPIC_BASE_URL` or api.anthropic.com). */
  readonly baseURL?: string
  readonly model: string
  readonly maxTokens: number
  readonly effort: Effort
  readonly thinking: ThinkingMode
  /** Fail when no response headers, or no stream event, arrive for this long. */
  readonly timeoutMs: number
  /** Open the HTTPS connection at startup (cheap authenticated GET). */
  readonly warmUp: boolean
  /** For tests; defaults to the SDK's (the global `fetch`). */
  readonly fetch?: typeof globalThis.fetch
}

export const defaults = {
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

/**
 * The only way an `LlmError` is made here: message and cause are sanitised
 * (credentials masked in every form; the cause is a plain copy, never the SDK
 * error, which carries the raw body and headers).
 */
export const llmError = (secrets: Secrets, message: string, cause?: unknown): LlmError =>
  new LlmError(sanitize(secrets, { message, cause }))

/**
 * Upstream text can echo the submitted key (a gateway at `baseURL` answering
 * `Invalid API key: <key>`), so a rejected key gets a fixed message, the
 * request id is shown only when it is a plain id, and everything else is
 * sanitised by `llmError`.
 */
const toLlmError = (secrets: Secrets) => (e: unknown): LlmError => {
  if (e instanceof LlmError) return llmError(secrets, e.message, e.cause)
  if (e instanceof Anthropic.APIError) {
    const id = safeId(e.requestID, secrets)
    const requestId = id !== undefined ? ` (request-id ${id})` : ""
    const message = e.status === 401 || e.status === 403
      ? `Anthropic rejected the API key (${e.status})${requestId}`
      : [
        "Anthropic API error",
        e.status !== undefined ? String(e.status) : undefined,
        e.type ?? e.name,
        ": ",
        e.apiMessage ?? e.message,
        requestId || undefined
      ].filter(Boolean).join(" ").replace(" : ", ": ")
    return llmError(secrets, message, new Error(message))
  }
  // The SDK rethrows `JSON.parse`'s error for a stream event that is not JSON: its message quotes the
  // event's first characters, already cut, so it is never used (see `redact.ts`, `SYNTAX_ERROR_TEXT`).
  if (e instanceof SyntaxError) return llmError(secrets, "Anthropic sent a stream event that is not JSON")
  return llmError(secrets, fromUpstream(e, secrets), e)
}

// ---------------------------------------------------------------------------
// Streaming

/** One model call. Resolves without throwing if `signal` aborts. */
async function attempt(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsStreaming,
  signal: AbortSignal,
  timeoutMs: number,
  emit: (event: LlmEvent) => void,
  secrets: Secrets
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
            throw new InvalidToolInput(`Invalid JSON input for tool ${clip(tool.name, secrets, 64)}: ${clip(tool.json, secrets, 200)}`)
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

/** The rules for a base address: http(s), no user-info, no query (see `redact.ts`, `checkAddress`). */
const ADDRESS_RULES = { protocols: ["http:", "https:"], query: false } as const

/**
 * What the client needs, read and checked once; never throws. The address the
 * SDK would use (`baseURL`, else `ANTHROPIC_BASE_URL`) must carry no
 * credentials: the key goes in its own setting, and the SDK would put a
 * password into the URL of every error.
 */
const prepare = (options: AnthropicLlmOptions): { readonly secrets: Secrets; readonly base?: string; readonly error?: LlmError } => {
  let secrets: Secrets = []
  try {
    // In steps: whatever was read before a getter throws is already masked.
    secrets = secretList(Redacted.value(options.apiKey))
    const configured = options.baseURL ?? process.env.ANTHROPIC_BASE_URL
    secrets = secretList(secrets, addressSecrets(configured))
    if (configured === undefined || configured.trim() === "") return { secrets }
    const address = checkAddress(configured, ADDRESS_RULES)
    if (!address.ok) {
      const which = options.baseURL !== undefined ? "The Anthropic address" : "ANTHROPIC_BASE_URL"
      return { secrets, error: llmError(secrets, `${which} ${address.problem}`) }
    }
    return { secrets, base: address.display }
  } catch (e) {
    return { secrets, error: llmError(secrets, `The Anthropic settings could not be read: ${fromUpstream(e, secrets)}`, e) }
  }
}

const makeService = Effect.fnUntraced(function*(options: AnthropicLlmOptions) {
  const prepared = prepare(options)
  const secrets = prepared.secrets
  // The SDK's own log lines (warnings, and whatever `ANTHROPIC_LOG` turns on: at debug, request and
  // response details as objects) can quote responses: they go into the Effect log instead of the
  // console, through `logText`, which redacts every string inside them whole before anything is
  // inspected or shortened (fourth review: `inspect` cut strings at 10 000 characters first).
  const runLog = Effect.runForkWith(yield* Effect.context<never>())
  const sdkLog = (level: "error" | "warn" | "info" | "debug") => (message: string, ...rest: Array<unknown>) => {
    const text = logText([message, ...rest], secrets)
    runLog(
      level === "error"
        ? Effect.logError(`Anthropic SDK: ${text}`)
        : level === "warn"
        ? Effect.logWarning(`Anthropic SDK: ${text}`)
        : level === "info"
        ? Effect.logInfo(`Anthropic SDK: ${text}`)
        : Effect.logDebug(`Anthropic SDK: ${text}`)
    )
  }
  // One client for the process: undici keeps the connection alive between turns. Built inside the
  // boundary: a constructor that throws is a failed setup, reported like any other error.
  let setupError = prepared.error
  let client: Anthropic | undefined
  if (setupError === undefined) {
    try {
      client = new Anthropic({
        logger: { error: sdkLog("error"), warn: sdkLog("warn"), info: sdkLog("info"), debug: sdkLog("debug") },
        apiKey: Redacted.value(options.apiKey),
        // The checked, credential-free form (the SDK would otherwise read ANTHROPIC_BASE_URL itself).
        ...(prepared.base !== undefined ? { baseURL: prepared.base } : {}),
        timeout: options.timeoutMs,
        maxRetries: 0,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
      })
    } catch (e) {
      setupError = llmError(secrets, `The Anthropic client could not be set up: ${fromUpstream(e, secrets)}`, e)
    }
  }
  if (setupError !== undefined) yield* Effect.logWarning(setupError.message)

  if (client !== undefined && options.warmUp) {
    const warm = client
    // Opens TCP+TLS to the API (and validates the key) so the first turn does
    // not pay for the handshake. Whether the pooled connection survives until
    // the first turn depends on the server's keep-alive hint (unverified).
    yield* Effect.tryPromise({
      try: (signal) => warm.models.retrieve(options.model, null, { signal }),
      catch: toLlmError(secrets)
    }).pipe(
      Effect.catchDefect((d) => Effect.fail(llmError(secrets, `Anthropic warm-up failed unexpectedly: ${fromUpstream(d, secrets)}`, d))),
      Effect.tapError((e) => Effect.logWarning(`Anthropic warm-up failed: ${e.message}`)),
      Effect.ignore,
      Effect.forkScoped
    )
  }

  const run = (request: LlmRequest): Stream.Stream<LlmEvent, LlmError> => {
    if (client === undefined) return Stream.fail(setupError ?? llmError(secrets, "The Anthropic client is not set up"))
    const ready = client
    return Stream.callback<LlmEvent, LlmError>((queue) =>
      Effect.gen(function*() {
        // Closing the stream's scope (completion, error or interruption of the
        // consumer) aborts the HTTP request: barge-in depends on this.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (c) => Effect.sync(() => c.abort())
        )
        const params = yield* Effect.try({
          try: () => toParams(request, options),
          catch: (e) => llmError(secrets, `Could not build the Anthropic request: ${fromUpstream(e, secrets)}`, e)
        })
        let emitted = false
        const emit = (event: LlmEvent) => {
          emitted = true
          Queue.offerUnsafe(queue, event)
        }
        const run = async () => {
          try {
            await attempt(ready, params, controller.signal, options.timeoutMs, emit, secrets)
          } catch (e) {
            if (emitted || controller.signal.aborted || !isRetryable(e)) throw e
            await attempt(ready, params, controller.signal, options.timeoutMs, emit, secrets)
          }
        }
        run().then(
          () => Queue.endUnsafe(queue),
          (e) => Queue.failCauseUnsafe(queue, Cause.fail(toLlmError(secrets)(e)))
        )
      })
    )
  }

  // The last resort: whatever escapes the paths above (a defect) leaves as a sanitised `LlmError`.
  const stream = (request: LlmRequest): Stream.Stream<LlmEvent, LlmError> =>
    Stream.suspend(() => run(request)).pipe(
      Stream.catchDefect((defect) => Stream.fail(llmError(secrets, `The Anthropic call failed unexpectedly: ${fromUpstream(defect, secrets)}`, defect))),
      Stream.mapError((e) => llmError(secrets, e.message, e.cause))
    )

  return Llm.of({ stream })
})

/**
 * The service. The last resort for building it: a defect while it is built becomes a service whose every
 * call fails with a sanitised `LlmError`, never a raw defect.
 */
export const make = (options: AnthropicLlmOptions) =>
  makeService(options).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        let secrets: Secrets = []
        try {
          secrets = secretList(options.apiKey !== undefined ? Redacted.value(options.apiKey) : undefined)
        } catch {
          // what was read is kept
        }
        const error = llmError(secrets, `The Anthropic client could not be set up: ${fromUpstream(defect, secrets)}`, defect)
        return Llm.of({ stream: () => Stream.fail(error) })
      })
    )
  )

export const layer = (options: AnthropicLlmOptions): Layer.Layer<Llm> => Layer.effect(Llm, make(options))

/** Options from the environment; everything but the API key has a default. */
export const config = Config.all({
  apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
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
