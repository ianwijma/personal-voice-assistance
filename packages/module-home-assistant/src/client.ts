import { Effect, Schema } from "effect"

/**
 * A minimal client for Home Assistant's REST API
 * (https://developers.home-assistant.io/docs/api/rest/, now served at
 * https://contributors.home-assistant.io/core/internals/rest-api/).
 *
 * Three calls only: `GET /api/config` (reachability and token check at
 * start), `POST /api/template` (one rendered template returns areas and
 * lights; admin only) and `POST /api/services/<domain>/<service>` (actions).
 * Every call has its own short timeout and is aborted when the fiber is
 * interrupted. Failures are `HomeAssistantError`s whose `message` can be
 * spoken as it is.
 */

export type HomeAssistantErrorKind =
  /** Connection refused, DNS failure, TLS error, timeout. */
  | "unreachable"
  /** 401: the token is missing, wrong or revoked. */
  | "unauthorized"
  /** 403, or 401 on an admin-only endpoint for a non-admin user. */
  | "forbidden"
  /** Any other HTTP error status. */
  | "http"
  /** 200 with a body we could not read. */
  | "invalid"

export class HomeAssistantError extends Schema.TaggedError<HomeAssistantError>()("HomeAssistantError", {
  /** One spoken sentence: "I couldn't reach Home Assistant." */
  message: Schema.String,
  kind: Schema.Literals(["unreachable", "unauthorized", "forbidden", "http", "invalid"]),
  status: Schema.optional(Schema.Number),
  /** Technical detail for logs and the settings card; never contains the token. */
  detail: Schema.String
}) {}

export interface HomeAssistantClientOptions {
  /** "http://homeassistant.local:8123" (a trailing slash or "/api" is tolerated). */
  readonly baseUrl: string
  readonly token: string
  /** Per request. */
  readonly timeoutMs: number
  readonly fetch?: typeof globalThis.fetch | undefined
}

export interface HomeAssistantClient {
  readonly baseUrl: string
  /** `GET /api/config`: the version, or a failure. */
  readonly config: Effect.Effect<{ readonly version: string | undefined; readonly locationName: string | undefined }, HomeAssistantError>
  /** `POST /api/template`: the rendered text. */
  readonly renderTemplate: (template: string) => Effect.Effect<string, HomeAssistantError>
  /** `POST /api/services/<domain>/<service>` with `data` as the body. */
  readonly callService: (domain: string, service: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, HomeAssistantError>
}

/** "http://ha:8123/", "http://ha:8123/api" → "http://ha:8123". Returns undefined for anything that is not an http(s) URL. */
export const normalizeBaseUrl = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "")
  return `${url.origin}${path}`
}

const ConfigResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
  location_name: Schema.optional(Schema.String)
})

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause
    const code = inner instanceof Error ? ((inner as { code?: string }).code ?? inner.message) : undefined
    return code !== undefined ? `${cause.message} (${code})` : cause.message
  }
  return String(cause)
}

export const makeHomeAssistantClient = (options: HomeAssistantClientOptions): HomeAssistantClient => {
  const fetchFn = options.fetch ?? globalThis.fetch
  const baseUrl = normalizeBaseUrl(options.baseUrl) ?? options.baseUrl
  const timeoutMs = options.timeoutMs

  const request = (method: "GET" | "POST", path: string, body: unknown | undefined, adminOnly = false) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchFn(`${baseUrl}${path}`, {
          method,
          signal,
          headers: {
            Authorization: `Bearer ${options.token}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        })
        const text = await response.text()
        return { status: response.status, text }
      },
      catch: (cause) =>
        new HomeAssistantError({
          message: "I couldn't reach Home Assistant.",
          kind: "unreachable",
          detail: `${method} ${path}: ${describeCause(cause)}`
        })
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new HomeAssistantError({
              message: "Home Assistant didn't answer in time.",
              kind: "unreachable",
              detail: `${method} ${path}: no answer within ${timeoutMs} ms`
            })
          )
      }),
      Effect.flatMap(({ status, text }) => {
        if (status >= 200 && status < 300) return Effect.succeed(text)
        const snippet = text.slice(0, 200).replace(/\s+/g, " ")
        if (status === 401 && !adminOnly) {
          return Effect.fail(
            new HomeAssistantError({ message: "Home Assistant rejected the access token.", kind: "unauthorized", status, detail: `${method} ${path}: 401` })
          )
        }
        if (status === 401 || status === 403) {
          return Effect.fail(
            new HomeAssistantError({
              message: "Home Assistant refused the request: the token's user may not be an administrator.",
              kind: "forbidden",
              status,
              detail: `${method} ${path}: ${status} ${snippet}`
            })
          )
        }
        return Effect.fail(
          new HomeAssistantError({
            message: status === 503 ? "Home Assistant is restarting." : "Home Assistant reported an error.",
            kind: "http",
            status,
            detail: `${method} ${path}: HTTP ${status} ${snippet}`
          })
        )
      })
    )

  const config = request("GET", "/api/config", undefined).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new HomeAssistantError({ message: "Home Assistant sent an unexpected answer.", kind: "invalid", detail: "GET /api/config: not JSON" })
      })
    ),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(ConfigResponse)(json).pipe(
        Effect.mapError(() =>
          new HomeAssistantError({ message: "Home Assistant sent an unexpected answer.", kind: "invalid", detail: "GET /api/config: unexpected shape" })
        )
      )
    ),
    Effect.map((c) => ({ version: c.version, locationName: c.location_name }))
  )

  return {
    baseUrl,
    config,
    // The template endpoint is admin only: a 401 there with a token that passed /api/config means "not an admin".
    renderTemplate: (template) => request("POST", "/api/template", { template }, true),
    callService: (domain, service, data) => Effect.asVoid(request("POST", `/api/services/${domain}/${service}`, data))
  }
}
