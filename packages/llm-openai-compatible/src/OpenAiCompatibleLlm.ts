/**
 * `Llm` over the OpenAI-compatible chat completions API: OpenRouter, Ollama,
 * llama.cpp, LM Studio, vLLM and anything else that speaks
 * `POST {base}/chat/completions` with `stream: true`.
 *
 * Plain `fetch` and a small SSE parser, no SDK (docs/AGENTS-AND-INTENTS.md §1.7):
 * the API is one POST and a line protocol, the OpenAI SDK would add retries and
 * timeouts that must be switched off for a voice path, and its types follow
 * OpenAI rather than the lowest common denominator the home servers implement.
 *
 * Behaviour that matters on the voice path:
 * - text deltas are emitted as they arrive; reasoning deltas (`reasoning`,
 *   `reasoning_content`) are never emitted, so they are never spoken;
 * - tool calls are assembled from fragments by `index` and each is emitted as
 *   soon as it is complete (a later call started and its arguments are a
 *   complete, non-empty JSON object, or the choice finished);
 * - `Done` is emitted at the first `finish_reason` and the stream ends there:
 *   the trailing usage chunk and `[DONE]` are not waited for;
 * - interrupting the consumer aborts the HTTP request (barge-in, discarded
 *   speculative turns);
 * - no response, or no data event, for `timeoutMs` fails fast (keep-alive
 *   comment lines do not count as progress);
 * - one immediate retry only, and only before anything was emitted, for a
 *   connection failure, a stall, 408/409/425/5xx, or a 5xx error chunk.
 */
import { Llm, LlmError, type LlmEvent, type LlmRequest, type Message, type StopReason } from "@pva/core"
import { Cause, Effect, Layer, Queue, Redacted, Stream } from "effect"
import { type ModelInfo, type Profile, type ProfileId, profiles, type ReasoningEffort } from "./profiles.ts"
import { addressSecrets, checkAddress, clip, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"
import { type SseEvent, SseParser } from "./sse.ts"

export interface OpenAiCompatibleLlmOptions {
  readonly profile: Profile | ProfileId
  /** Including the version path: `https://openrouter.ai/api/v1`, `http://192.168.1.20:11434/v1`. */
  readonly baseUrl: string
  /** Sent as `Authorization: Bearer …`; local servers that ignore keys get `none`. */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model: string
  readonly maxTokens: number
  /** `undefined`: the server's default (the field is not sent). */
  readonly temperature?: number | undefined
  /** `undefined`: the server's default. Sent only where the profile supports it. */
  readonly reasoningEffort?: ReasoningEffort | undefined
  /** OpenRouter: prefer the provider with the lowest latency. */
  readonly sortByLatency?: boolean | undefined
  /** The chosen model's entry from the model list, when known (OpenRouter sends `reasoning` only to models that take it). */
  readonly modelInfo?: ModelInfo | undefined
  /** Fail when no response headers, or no data event, arrive for this long. */
  readonly timeoutMs: number
  /** For tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

export const defaults = {
  maxTokens: 512,
  timeoutMs: 5_000
} as const

const profileOf = (p: Profile | ProfileId): Profile => (typeof p === "string" ? profiles[p] : p)

// ---------------------------------------------------------------------------
// Request mapping

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<ChatToolCall> }
  | { role: "tool"; tool_call_id: string; content: string }

/**
 * Core history → chat messages. Tool results become one `tool` message per
 * result; consecutive user messages are joined (several chat templates of local
 * models insist on alternating roles); assistant messages with neither text nor
 * tool calls are dropped. A failed tool's result is prefixed with "Error: "
 * because the chat API has no error flag.
 */
export const toChatMessages = (system: string, messages: ReadonlyArray<Message>): Array<ChatMessage> => {
  const out: Array<ChatMessage> = system.length > 0 ? [{ role: "system", content: system }] : []
  for (const message of messages) {
    const last = out.at(-1)
    switch (message.role) {
      case "user":
        if (message.content.length === 0) break
        if (last?.role === "user") last.content = `${last.content}\n\n${message.content}`
        else out.push({ role: "user", content: message.content })
        break
      case "assistant": {
        const calls = (message.toolCalls ?? []).map((call): ChatToolCall => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) }
        }))
        if (message.content.length === 0 && calls.length === 0) break
        out.push({
          role: "assistant",
          content: message.content.length > 0 ? message.content : null,
          ...(calls.length > 0 ? { tool_calls: calls } : {})
        })
        break
      }
      case "tool":
        for (const result of message.results) {
          out.push({ role: "tool", tool_call_id: result.id, content: result.isError ? `Error: ${result.content}` : result.content })
        }
        break
    }
  }
  return out
}

/**
 * The request body. `request.context` (changes every turn, never stored in
 * history) goes at the very end, after everything a server can reuse from its
 * prompt cache (llama.cpp's `cache_prompt`, provider caches behind OpenRouter):
 * appended to the last user message, or as a user message of its own after
 * tool results. Optional fields are only sent when set, since strict servers
 * reject what they do not know.
 */
export const toBody = (request: LlmRequest, options: OpenAiCompatibleLlmOptions): Record<string, unknown> => {
  const profile = profileOf(options.profile)
  const messages = toChatMessages(request.system, request.messages)
  if (request.context !== undefined && request.context.length > 0) {
    const block = `<context>\n${request.context}\n</context>`
    const last = messages.at(-1)
    if (last?.role === "user") last.content = `${last.content}\n\n${block}`
    else messages.push({ role: "user", content: block })
  }
  return {
    model: options.model,
    messages,
    stream: true,
    max_tokens: options.maxTokens,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(request.tools.length > 0
      ? {
        tools: request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
        }))
      }
      : {}),
    ...profile.extraBody({
      reasoningEffort: profile.supportsReasoningEffort ? options.reasoningEffort : undefined,
      sortByLatency: options.sortByLatency ?? false,
      model: options.modelInfo
    })
  }
}

export const toStopReason = (reason: string | null | undefined, hadToolCalls: boolean): StopReason => {
  // Some servers say "stop" after tool calls (older Ollama), or no reason at all.
  if (hadToolCalls) return "tool_use"
  switch (reason) {
    case undefined:
    case null:
    case "stop":
    case "end_turn":
    case "eos":
      return "end"
    case "length":
    case "max_tokens":
      return "max_tokens"
    default:
      return "other"
  }
}

// ---------------------------------------------------------------------------
// Errors

class StallError extends Error {}
class ConnectionError extends Error {}
class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
/** An `error` chunk inside a 200 stream (OpenRouter), or `finish_reason: "error"`. */
class StreamError extends Error {
  readonly code: number | string | undefined
  constructor(code: number | string | undefined, message: string) {
    super(message)
    this.code = code
  }
}
class ProtocolError extends Error {}

/** Worth one immediate retry, if nothing was emitted yet. */
const isRetryable = (e: unknown): boolean => {
  if (e instanceof StallError || e instanceof ConnectionError) return true
  if (e instanceof HttpError) return e.status === 408 || e.status === 409 || e.status === 425 || e.status >= 500
  if (e instanceof StreamError) return typeof e.code === "number" && e.code >= 500
  return false
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/**
 * The human part of an error body: `{error:{message}}`, `{error:"…"}`, `{detail}`, `{message}` or the text.
 * The body is redacted as a whole first (`fromUpstream`); only then trimmed, parsed and shortened.
 */
export const errorText = (body: string, secrets: ReadonlyArray<string | undefined> = []): string => {
  const safe = fromUpstream(body, secrets)
  let text = safe.trim()
  try {
    const json: unknown = JSON.parse(safe)
    if (isRecord(json)) {
      const error = json.error
      if (isRecord(error) && typeof error.message === "string") text = error.message
      else if (typeof error === "string") text = error
      else if (typeof json.detail === "string") text = json.detail
      else if (typeof json.message === "string") text = json.message
    }
  } catch {
    // not JSON: keep the text
  }
  return clip(text.trim(), secrets, 300)
}

const describeHttp = (label: string, status: number, body: string, secrets: ReadonlyArray<string | undefined>): string => {
  // A rejected key gets a fixed message: the body of a 401 is where a gateway echoes the key back.
  if (status === 401 || status === 403) return `${label} rejected the API key (${status})`
  const detail = errorText(body, secrets)
  const what = status === 404
    ? `${label} answered 404 (wrong address or unknown model)`
    : status === 429
    ? `${label} is rate limiting (429)`
    : `${label} answered ${status}`
  return detail.length > 0 ? `${what}: ${detail}` : what
}

/**
 * The only way an `LlmError` is made here: message and cause are sanitised
 * (credentials masked in every form; the cause is a plain copy, never the
 * original error with its request or response).
 */
export const llmError = (secrets: Secrets, message: string, cause?: unknown): LlmError =>
  new LlmError(sanitize(secrets, { message, cause }))

const toLlmError = (label: string, secrets: Secrets) => (e: unknown): LlmError => {
  if (e instanceof LlmError) return llmError(secrets, e.message, e.cause)
  if (e instanceof ConnectionError) return llmError(secrets, `Could not reach ${label}: ${e.message}`, e)
  return llmError(secrets, fromUpstream(e, secrets), e) // through `messageOf`: a SyntaxError's message (an input excerpt, already cut) is never kept
}

// ---------------------------------------------------------------------------
// Response parsing

interface ToolSlot {
  id: string | undefined
  name: string
  args: string
  emitted: boolean
}

let callCounter = 0

/**
 * Turns chat-completion chunks into `LlmEvent`s. `handle` returns true once the
 * choice has finished (the caller then stops reading).
 */
export class ChunkHandler {
  private readonly slots = new Map<number, ToolSlot>()
  private toolCalls = 0
  private lastIndex: number | undefined = undefined
  /** Any chunk with choices was seen. */
  sawChoices = false

  private readonly label: string
  private readonly emit: (event: LlmEvent) => void
  private readonly secrets: ReadonlyArray<string | undefined>

  constructor(label: string, emit: (event: LlmEvent) => void, secrets: ReadonlyArray<string | undefined> = []) {
    this.label = label
    this.emit = emit
    this.secrets = secrets
  }

  /** One SSE event. */
  event(event: SseEvent): boolean {
    const data = event.data.trim()
    if (data === "") return false
    if (data === "[DONE]") return this.finish(undefined)
    let chunk: unknown
    try {
      chunk = JSON.parse(data)
    } catch {
      throw new ProtocolError(`${this.label} sent a stream line that is not JSON: ${clip(event.data, this.secrets, 120)}`)
    }
    if (event.event === "error") throw this.streamError(isRecord(chunk) ? chunk.error ?? chunk : chunk)
    return this.chunk(chunk)
  }

  /** One parsed chunk (also used for a non-streaming JSON answer, with `message` instead of `delta`). */
  chunk(chunk: unknown): boolean {
    if (!isRecord(chunk)) return false
    if (chunk.error !== undefined && chunk.error !== null) throw this.streamError(chunk.error)
    const choices = chunk.choices
    if (!Array.isArray(choices) || choices.length === 0) return false // usage chunk, or a server's empty keep-alive chunk
    this.sawChoices = true
    const choice: unknown = choices[0]
    if (!isRecord(choice)) return false
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined
    if (delta !== undefined) {
      // `reasoning` / `reasoning_content` / `reasoning_details` are deliberately ignored: never spoken.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.emit({ _tag: "TextDelta", text: delta.content })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) if (isRecord(call)) this.toolDelta(call)
      }
    }
    const reason = choice.finish_reason
    if (typeof reason === "string" && reason.length > 0) {
      if (reason === "error") throw this.streamError(chunk.error ?? choice.error ?? "the stream ended with an error")
      return this.finish(reason)
    }
    return false
  }

  /** The response ended without a finish reason (allowed: some servers omit it). */
  end(): void {
    if (!this.sawChoices) throw new ProtocolError(`${this.label} ended the response without sending anything`)
    this.finish(undefined)
  }

  private finished = false

  private finish(reason: string | undefined): boolean {
    if (this.finished) return true
    this.finished = true
    this.flushTools(Number.POSITIVE_INFINITY, false)
    this.emit({ _tag: "Done", stopReason: toStopReason(reason, this.toolCalls > 0) })
    return true
  }

  private toolDelta(call: Record<string, unknown>): void {
    const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined
    let index: number
    if (typeof call.index === "number") index = call.index
    else {
      // No index (some servers send each call whole): find it by id, else a new slot for a new id, else the last slot.
      const known = id === undefined ? undefined : [...this.slots].find(([, s]) => s.id === id)?.[0]
      index = known ?? (id !== undefined || this.lastIndex === undefined ? this.slots.size : this.lastIndex)
    }
    let slot = this.slots.get(index)
    if (slot === undefined) {
      slot = { id, name: "", args: "", emitted: false }
      this.slots.set(index, slot)
    }
    if (slot.id === undefined && id !== undefined) slot.id = id
    const fn = isRecord(call.function) ? call.function : undefined
    if (fn !== undefined) {
      // The name comes in the first fragment; some servers repeat it in every fragment.
      if (typeof fn.name === "string" && fn.name.length > 0 && slot.name === "") slot.name = fn.name
      if (typeof fn.arguments === "string") slot.args += fn.arguments
      else if (isRecord(fn.arguments)) slot.args = JSON.stringify(fn.arguments) // a server that sends parsed arguments
    }
    if (this.lastIndex !== undefined && index !== this.lastIndex) this.flushTools(index, true)
    this.lastIndex = index
  }

  /**
   * Emit the not-yet-emitted calls with an index below `before`, in index
   * order. `onlyComplete` (an early flush while the response is still
   * streaming): stop at the first call whose arguments are not yet a complete
   * JSON object. Empty arguments count as not yet complete, since a server may
   * send every call's header before any call's arguments; a call that really
   * has no arguments is emitted, as `{}`, when the choice finishes.
   */
  private flushTools(before: number, onlyComplete: boolean): void {
    const pending = [...this.slots].filter(([i, s]) => i < before && !s.emitted).sort(([a], [b]) => a - b)
    for (const [index, slot] of pending) {
      let input: unknown
      try {
        if (slot.args.trim() === "") {
          if (onlyComplete) return
          input = {}
        } else {
          input = JSON.parse(slot.args)
          if (onlyComplete && !isRecord(input)) return
        }
      } catch {
        if (onlyComplete) return
        throw new ProtocolError(`Invalid JSON arguments for tool ${clip(slot.name || "(unnamed)", this.secrets, 64)}: ${clip(slot.args, this.secrets, 200)}`)
      }
      if (slot.name === "") {
        if (onlyComplete) return
        throw new ProtocolError(`${this.label} sent a tool call without a name`)
      }
      slot.emitted = true
      this.toolCalls++
      this.emit({ _tag: "ToolCall", id: slot.id ?? `call_${index}_${(++callCounter).toString(36)}`, name: slot.name, input })
    }
  }

  private streamError(error: unknown): StreamError {
    if (isRecord(error)) {
      const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined
      const message = clip(typeof error.message === "string" ? error.message : JSON.stringify(error), this.secrets, 300)
      const shown = code === undefined ? "" : ` ${clip(String(code), this.secrets, 40)}`
      return new StreamError(code, `${this.label} error${shown} in the stream: ${message}`)
    }
    return new StreamError(undefined, `${this.label} error in the stream: ${clip(String(error), this.secrets, 300)}`)
  }
}

// ---------------------------------------------------------------------------
// One model call

/** The whole body, unshortened: it is redacted as a whole (`errorText` → `fromUpstream`) before any cut. */
const readText = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

/** Everything the options hold that must never be shown: the key and every credential part of the address. */
const secretsOf = (options: { readonly apiKey?: Redacted.Redacted<string> | undefined; readonly baseUrl: string }): ReadonlyArray<string> =>
  secretList(options.apiKey !== undefined ? Redacted.value(options.apiKey) : undefined, addressSecrets(options.baseUrl))

/** The rules for a configured base address: http(s), no user-info, no query (see `redact.ts`, `checkAddress`). */
const ADDRESS_RULES = { protocols: ["http:", "https:"], query: false } as const

/** What a call needs from the options, read once; reading or checking them never throws past here. */
type Prepared =
  | { readonly ok: true; readonly label: string; readonly base: string; readonly secrets: Secrets }
  | { readonly ok: false; readonly error: LlmError }

/** One model call. Resolves without throwing if `signal` aborts. */
async function attempt(
  options: OpenAiCompatibleLlmOptions,
  prepared: { readonly label: string; readonly base: string; readonly secrets: Secrets },
  body: string,
  signal: AbortSignal,
  emit: (event: LlmEvent) => void
): Promise<void> {
  const { label, base, secrets } = prepared
  const fetchFn = options.fetch ?? globalThis.fetch
  const watchdog = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      watchdog.abort()
    }, options.timeoutMs)
  }
  const failed = (e: unknown, waitingFor: string): Error | undefined => {
    if (stalled) return new StallError(`No ${waitingFor} from ${label} within ${options.timeoutMs} ms`)
    if (signal.aborted) return undefined
    if (e instanceof Error && !(e instanceof TypeError) && e.name !== "AbortError") return e
    return new ConnectionError(fromUpstream(e instanceof Error && e.cause instanceof Error ? e.cause : e, secrets))
  }
  arm()
  try {
    let response: Response
    try {
      response = await fetchFn(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey !== undefined ? Redacted.value(options.apiKey) : "none"}`,
          "content-type": "application/json",
          accept: "text/event-stream"
        },
        body,
        signal: AbortSignal.any([signal, watchdog.signal])
      })
    } catch (e) {
      const error = failed(e, "response")
      if (error === undefined) return
      throw error
    }
    if (!response.ok) throw new HttpError(response.status, describeHttp(label, response.status, await readText(response), secrets))
    arm()
    const handler = new ChunkHandler(label, emit, secrets)
    const type = response.headers.get("content-type") ?? ""
    if (type.includes("application/json")) {
      // A server that ignored `stream: true` and answered in one piece.
      let json: unknown
      try {
        json = JSON.parse(await response.text())
      } catch (e) {
        const error = failed(e, "response body")
        if (error === undefined) return
        throw error instanceof ConnectionError ? error : new ProtocolError(`${label} answered with invalid JSON`)
      }
      if (!handler.chunk(json)) handler.end()
      return
    }
    if (response.body === null) throw new ProtocolError(`${label} answered without a body`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    try {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>
        try {
          read = await reader.read()
        } catch (e) {
          const error = failed(e, "stream data")
          if (error === undefined) return
          throw error
        }
        if (read.done) break
        const events = parser.push(decoder.decode(read.value, { stream: true }))
        if (events.length > 0) arm() // comment lines alone are not progress
        for (const event of events) if (handler.event(event)) return
      }
      for (const event of [...parser.push(decoder.decode()), ...parser.end()]) if (handler.event(event)) return
      if (signal.aborted) return
      handler.end()
    } finally {
      reader.cancel().catch(() => {})
    }
  } finally {
    clearTimeout(timer)
  }
}

const prepare = (options: OpenAiCompatibleLlmOptions): Prepared => {
  let secrets: Secrets = []
  try {
    // In steps: whatever was read before a getter throws is already masked.
    secrets = secretList(options.apiKey !== undefined ? Redacted.value(options.apiKey) : undefined)
    secrets = secretsOf(options)
    const label = profileOf(options.profile).label
    const address = checkAddress(options.baseUrl, ADDRESS_RULES)
    if (!address.ok) return { ok: false, error: llmError(secrets, `The ${label} address ${address.problem}`) }
    // The credential-free form is the only one any message, or the request, uses.
    return { ok: true, label, base: address.display, secrets }
  } catch (e) {
    return { ok: false, error: llmError(secrets, `The language model settings could not be read: ${fromUpstream(e, secrets)}`, e) }
  }
}

const makeService = Effect.fnUntraced(function*(options: OpenAiCompatibleLlmOptions) {
  const prepared = prepare(options)

  const run = (request: LlmRequest): Stream.Stream<LlmEvent, LlmError> => {
    if (!prepared.ok) return Stream.fail(prepared.error)
    const { label, secrets } = prepared
    return Stream.callback<LlmEvent, LlmError>((queue) =>
      Effect.gen(function*() {
        // Closing the stream's scope (completion, error or interruption of the
        // consumer) aborts the HTTP request: barge-in depends on this.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (c) => Effect.sync(() => c.abort())
        )
        // Serialising can throw (a value with a throwing `toJSON`): a typed failure, not a defect.
        const body = yield* Effect.try({
          try: () => JSON.stringify(toBody(request, options)),
          catch: (e) => llmError(secrets, `Could not build the request for ${label}: ${fromUpstream(e, secrets)}`, e)
        })
        let emitted = false
        const emit = (event: LlmEvent) => {
          emitted = true
          Queue.offerUnsafe(queue, event)
        }
        const run = async () => {
          try {
            await attempt(options, prepared, body, controller.signal, emit)
          } catch (e) {
            if (emitted || controller.signal.aborted || !isRetryable(e)) throw e
            await attempt(options, prepared, body, controller.signal, emit)
          }
        }
        run().then(
          () => Queue.endUnsafe(queue),
          (e) => Queue.failCauseUnsafe(queue, Cause.fail(toLlmError(label, secrets)(e)))
        )
      })
    )
  }

  // The last resort: whatever escapes the paths above (a defect) leaves as a sanitised `LlmError`.
  const secrets = prepared.ok ? prepared.secrets : []
  const stream = (request: LlmRequest): Stream.Stream<LlmEvent, LlmError> =>
    Stream.suspend(() => run(request)).pipe(
      Stream.catchDefect((defect) => Stream.fail(llmError(secrets, `The language model call failed unexpectedly: ${fromUpstream(defect, secrets)}`, defect))),
      Stream.mapError((e) => llmError(secrets, e.message, e.cause))
    )

  return Llm.of({ stream })
})

/**
 * The service. The last resort for building it: a defect while it is built becomes a service whose every
 * call fails with a sanitised `LlmError`, never a raw defect.
 */
export const make = (options: OpenAiCompatibleLlmOptions) =>
  makeService(options).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        let secrets: Secrets = []
        try {
          secrets = secretList(options.apiKey !== undefined ? Redacted.value(options.apiKey) : undefined)
        } catch {
          // what was read is kept
        }
        const error = llmError(secrets, `The language model could not be set up: ${fromUpstream(defect, secrets)}`, defect)
        return Llm.of({ stream: () => Stream.fail(error) })
      })
    )
  )

export const layer = (options: OpenAiCompatibleLlmOptions): Layer.Layer<Llm> => Layer.effect(Llm, make(options))

export const OpenAiCompatibleLlm = { make, layer } as const
