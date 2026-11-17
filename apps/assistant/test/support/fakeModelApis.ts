// Local stand-ins for the model list APIs the pickers ask (docs/MODEL-PICKERS.md §3): OpenRouter's and a home server's
// `GET /v1/models` (OpenAI shape) and Anthropic's `GET /v1/models` (the SDK's page shape). Nothing here reaches a real
// service. Each records its requests; `behave` changes how it answers from then on.
import * as Http from "node:http"
import type { AddressInfo } from "node:net"

export type Behaviour =
  | { readonly kind: "ok" }
  | { readonly kind: "status"; readonly status: number; readonly body?: string }
  | { readonly kind: "hang" }
  | { readonly kind: "html" }

export interface FakeApi {
  readonly url: string
  readonly requests: Array<{ readonly path: string; readonly authorization: string | undefined; readonly apiKey: string | undefined }>
  /** Model list requests so far. */
  readonly lists: () => number
  behave: (b: Behaviour) => void
  setModels: (models: ReadonlyArray<Record<string, unknown>>) => void
  close: () => Promise<void>
}

const start = async (
  answer: (path: URL, models: ReadonlyArray<Record<string, unknown>>) => unknown,
  initial: ReadonlyArray<Record<string, unknown>>
): Promise<FakeApi> => {
  const requests: FakeApi["requests"] = []
  let behaviour: Behaviour = { kind: "ok" }
  let models = initial
  const server = Http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    requests.push({ path: url.pathname + url.search, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined })
    req.resume()
    if (behaviour.kind === "hang") return
    if (behaviour.kind === "status") {
      res.writeHead(behaviour.status, { "content-type": "application/json" })
      return res.end(behaviour.body ?? JSON.stringify({ error: { message: "nope" } }))
    }
    if (behaviour.kind === "html") {
      res.writeHead(200, { "content-type": "text/html" })
      return res.end("<html>not an API</html>")
    }
    if (!url.pathname.endsWith("/models")) {
      res.writeHead(404, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: "not found" } }))
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(answer(url, models)))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    lists: () => requests.filter((r) => r.path.includes("/models")).length,
    behave: (b) => {
      behaviour = b
    },
    setModels: (m) => {
      models = m
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** OpenRouter's list entries, in the shape of its documentation (`GET /api/v1/models`). */
export const openRouterModels: ReadonlyArray<Record<string, unknown>> = [
  {
    id: "openai/gpt-oss-20b",
    name: "OpenAI: gpt-oss-20b",
    description: "An open-weight model.",
    context_length: 131072,
    pricing: { prompt: "0.00000004", completion: "0.00000015" },
    supported_parameters: ["tools", "tool_choice", "reasoning", "max_tokens"]
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Meta: Llama 3.3 70B Instruct (free)",
    context_length: 65536,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools", "max_tokens"]
  },
  // No tools: not listed.
  { id: "some/no-tools", name: "No tools", context_length: 4096, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["max_tokens"] },
  // Reasoning it cannot turn down: not listed.
  { id: "some/always-thinks", name: "Always thinks", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true } }
]

/** A home server's list (Ollama's OpenAI-compatible `GET /v1/models`). */
export const homeModels: ReadonlyArray<Record<string, unknown>> = [
  { id: "llama3.1:8b", object: "model", created: 1, owned_by: "library" },
  { id: "qwen2.5:14b", object: "model", created: 1, owned_by: "library" }
]

/** Anthropic's list entries, in the shape of `@anthropic-ai/sdk`'s `ModelInfo` (fields this code reads, and some more). */
export const anthropicModels: ReadonlyArray<Record<string, unknown>> = [
  { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-10-01T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000, lifecycle: "active", capabilities: null, deprecated_at: null, retires_at: null, line: "haiku" },
  { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 64000, lifecycle: "active", capabilities: null, deprecated_at: null, retires_at: null, line: "sonnet" },
  { type: "model", id: "claude-old-4", display_name: "Claude Old 4", created_at: "1970-01-01T00:00:00Z", max_input_tokens: 200000, max_tokens: 8192, lifecycle: "deprecated", capabilities: null, deprecated_at: "2026-06-01T00:00:00Z", retires_at: null, line: null }
]

export const fakeOpenAiApi = (models: ReadonlyArray<Record<string, unknown>> = openRouterModels) =>
  start((_url, list) => ({ data: list }), models)

/** Pages of `limit` (default 20) by `after_id`, as the API documents. */
export const fakeAnthropicApi = (models: ReadonlyArray<Record<string, unknown>> = anthropicModels) =>
  start((url, list) => {
    const limit = Number(url.searchParams.get("limit") ?? 20)
    const after = url.searchParams.get("after_id")
    const from = after === null ? 0 : list.findIndex((m) => m.id === after) + 1
    const page = list.slice(from, from + limit)
    return { data: page, has_more: from + limit < list.length, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null }
  }, models)
