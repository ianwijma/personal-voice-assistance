import { Effect } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"

/** A local HTTP server that records requests and lets each test script its answers. */

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly headers: Http.IncomingHttpHeaders
  readonly body: any
}

export type Handler = (req: Http.IncomingMessage, res: Http.ServerResponse, body: any) => void

export const fakeServer = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; requests: Array<Recorded>; server: Http.Server }>((resume) => {
      const requests: Array<Recorded> = []
      const server = Http.createServer((req, res) => {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = raw.length > 0 ? JSON.parse(raw) : undefined
          requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body })
          handler(req, res, body)
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resume(Effect.succeed({ url: `http://127.0.0.1:${port}/v1`, requests, server }))
      })
    }),
    (api) =>
      Effect.sync(() => {
        api.server.closeAllConnections()
        api.server.close()
      })
  )

export const startSse = (res: Http.ServerResponse) =>
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })

/** `data: <json>\n\n` per chunk; strings are written as they are (comments, `[DONE]`). */
export const sse = (chunks: ReadonlyArray<unknown>) =>
  chunks.map((c) => (typeof c === "string" ? (c.startsWith(":") ? `${c}\n\n` : `data: ${c}\n\n`) : `data: ${JSON.stringify(c)}\n\n`)).join("")

export const replay = (chunks: ReadonlyArray<unknown>): Handler => (_req, res) => {
  startSse(res)
  res.end(sse(chunks))
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

// Chunk builders (the OpenAI chat.completion.chunk shape)

const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "m" }

export const text = (content: string) => ({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })
export const role = () => ({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
export const reasoning = (r: string, field = "reasoning") => ({ ...base, choices: [{ index: 0, delta: { [field]: r }, finish_reason: null }] })
export const toolDelta = (calls: ReadonlyArray<Record<string, unknown>>) => ({
  ...base,
  choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }]
})
export const finish = (reason: string | null) => ({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }] })
export const usage = () => ({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })
