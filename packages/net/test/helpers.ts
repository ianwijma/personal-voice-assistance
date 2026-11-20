import type { ConnectRequest, ConnectResponse, Connector, Resolver } from "../src/SafeFetch.ts"

export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

export async function* chunks(...parts: ReadonlyArray<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? bytes(p) : p
}

/** A response; a 2xx one is `text/plain` unless `headers` says otherwise (pass `"content-type": ""` for none). */
export const reply = (status: number, body: string | AsyncIterable<Uint8Array> = "", headers: Record<string, string> = {}): ConnectResponse => {
  const h: Record<string, string> = status >= 200 && status <= 299 && !("content-type" in headers) ? { "content-type": "text/plain", ...headers } : { ...headers }
  if (h["content-type"] === "") delete h["content-type"]
  return { status, headers: h, body: typeof body === "string" ? chunks(body) : body }
}

/** A resolver from a table; anything else fails like NXDOMAIN. Records its calls. */
export const fakeResolver = (table: Record<string, ReadonlyArray<string>>): Resolver & { calls: Array<string> } => {
  const calls: Array<string> = []
  const fn = (async (host: string) => {
    calls.push(host)
    const found = table[host]
    if (found === undefined) throw new Error(`ENOTFOUND ${host}`)
    return found
  }) as unknown as Resolver & { calls: Array<string> }
  fn.calls = calls
  return fn
}

/** A connector from a function of the request; records every request it was asked to make. */
export const fakeConnector = (handler: (request: ConnectRequest) => ConnectResponse | Promise<ConnectResponse>): Connector & { requests: Array<ConnectRequest> } => {
  const requests: Array<ConnectRequest> = []
  const fn = (async (request: ConnectRequest) => {
    requests.push(request)
    return handler(request)
  }) as unknown as Connector & { requests: Array<ConnectRequest> }
  fn.requests = requests
  return fn
}
