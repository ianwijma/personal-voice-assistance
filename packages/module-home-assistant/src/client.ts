import { Effect, Schema } from "effect"
import { addressSecrets, checkAddress, clip, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

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

/** The rules for the address: http(s), no user-info, no query (the token has its own setting; see `redact.ts`). */
const ADDRESS_RULES = { protocols: ["http:", "https:"], query: false } as const

/**
 * "http://ha:8123/", "http://ha:8123/api" → "http://ha:8123". Undefined for anything that is not a
 * plain http(s) address: credentials or a query in it are refused, not dropped (`checkAddressSetting` says why).
 */
export const normalizeBaseUrl = (text: string): string | undefined => {
  if (text.trim() === "") return undefined
  const address = checkAddress(text, ADDRESS_RULES)
  if (!address.ok) return undefined
  return address.display.replace(/\/api$/, "")
}

/** The settings form's check of the address: why it is refused, in words that never repeat it (it may hold a password). */
export const checkAddressSetting = (text: string): string | undefined => {
  if (text.trim() === "") return undefined
  const address = checkAddress(text, ADDRESS_RULES)
  if (address.ok) return undefined
  return address.problem === "is not a valid address"
    ? "Must be an http:// or https:// address"
    : `${address.problem[0]!.toUpperCase()}${address.problem.slice(1)}`
}

const ConfigResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
  location_name: Schema.optional(Schema.String)
})

/** A thrown error as text: its message and its cause's code (or message), all upstream text, redacted as it enters. */
const describeCause = (cause: unknown, secrets: Secrets): string => {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause
    const code = inner instanceof Error ? ((inner as { code?: unknown }).code ?? inner.message) : undefined
    const message = fromUpstream(cause.message, secrets)
    return code !== undefined ? `${message} (${fromUpstream(code, secrets)})` : message
  }
  return fromUpstream(cause, secrets)
}

export const makeHomeAssistantClient = (options: HomeAssistantClientOptions): HomeAssistantClient => {
  // Read and checked once, inside the boundary: a getter that throws or a refused address makes every
  // call fail with a sanitised error; constructing the client never throws.
  let secrets: Secrets = []
  let setup: { readonly baseUrl: string; readonly fetchFn: typeof globalThis.fetch; readonly timeoutMs: number; readonly token: string } | string
  try {
    secrets = secretList(options.token)
    secrets = secretList(secrets, addressSecrets(options.baseUrl))
    const baseUrl = normalizeBaseUrl(options.baseUrl)
    setup = baseUrl === undefined
      ? `the address ${checkAddressSetting(options.baseUrl)?.toLowerCase() ?? "is empty"}`
      : { baseUrl, fetchFn: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs, token: options.token }
  } catch (e) {
    setup = `the settings could not be read (${fromUpstream(e, secrets)})`
  }
  /** The only way a `HomeAssistantError` is made here: message and detail sanitised (see `redact.ts`). */
  const haError = (fields: ConstructorParameters<typeof HomeAssistantError>[0]) => new HomeAssistantError(sanitize(secrets, fields))
  // Only the credential-free form is ever shown; a refused address is shown as nothing at all.
  const shownUrl = typeof setup === "string" ? "" : setup.baseUrl

  const send = (method: "GET" | "POST", path: string, body: unknown | undefined, adminOnly = false) =>
    Effect.suspend(() => {
      if (typeof setup === "string") {
        return Effect.fail(haError({ message: "I couldn't reach Home Assistant.", kind: "unreachable", detail: `${method} ${path}: ${setup}` }))
      }
      const { baseUrl, fetchFn, timeoutMs, token } = setup
      return Effect.tryPromise({
      try: async (signal) => {
        // Inside the boundary: serialising can throw (a value with a throwing `toJSON`).
        const payload = body !== undefined ? JSON.stringify(body) : undefined
        const response = await fetchFn(`${baseUrl}${path}`, {
          method,
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(payload !== undefined ? { "Content-Type": "application/json" } : {})
          },
          ...(payload !== undefined ? { body: payload } : {})
        })
        // Raw here. A successful answer is content (room and light names feed targeting and the house
        // state the model sees) and passes through untouched: generic token patterns would turn a room
        // called "Basic Bedroom" into "Basic [redacted]" (fourth review, finding 4). Only diagnostics are
        // redacted: an error body below (`clip`: the whole text redacted, then shortened), and whatever a
        // caller puts in an error detail or a status line (`sanitize`, the status wrapper in `module.ts`).
        const text = await response.text()
        return { status: response.status, text }
      },
      catch: (cause) =>
        haError({
          message: "I couldn't reach Home Assistant.",
          kind: "unreachable",
          detail: `${method} ${path}: ${describeCause(cause, secrets)}`
        })
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            haError({
              message: "Home Assistant didn't answer in time.",
              kind: "unreachable",
              detail: `${method} ${path}: no answer within ${timeoutMs} ms`
            })
          )
      }),
      Effect.flatMap(({ status, text }) => {
        if (status >= 200 && status < 300) return Effect.succeed(text)
        // A proxy in front of Home Assistant may echo the Authorization header: `clip` redacts the whole body before shortening.
        const snippet = clip(fromUpstream(text, secrets).replace(/\s+/g, " ").trim(), secrets, 200)
        if (status === 401 && !adminOnly) {
          return Effect.fail(
            haError({ message: "Home Assistant rejected the access token.", kind: "unauthorized", status, detail: `${method} ${path}: 401` })
          )
        }
        if (status === 401 || status === 403) {
          return Effect.fail(
            haError({
              message: "Home Assistant refused the request: the token's user may not be an administrator.",
              kind: "forbidden",
              status,
              detail: `${method} ${path}: ${status} ${snippet}`
            })
          )
        }
        return Effect.fail(
          haError({
            message: status === 503 ? "Home Assistant is restarting." : "Home Assistant reported an error.",
            kind: "http",
            status,
            detail: `${method} ${path}: HTTP ${status} ${snippet}`
          })
        )
      })
    )
    })

  // The last resort: anything unexpected (a defect) leaves as a sanitised `HomeAssistantError`.
  const request = (method: "GET" | "POST", path: string, body: unknown | undefined, adminOnly = false) =>
    send(method, path, body, adminOnly).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(haError({ message: "Something went wrong talking to Home Assistant.", kind: "invalid", detail: `${method} ${path}: ${describeCause(defect, secrets)}` }))
      ),
      Effect.mapError((e) => haError({ message: e.message, kind: e.kind, detail: e.detail, ...(e.status !== undefined ? { status: e.status } : {}) }))
    )

  const config = request("GET", "/api/config", undefined).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => haError({ message: "Home Assistant sent an unexpected answer.", kind: "invalid", detail: "GET /api/config: not JSON" })
      })
    ),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(ConfigResponse)(json).pipe(
        Effect.mapError(() =>
          haError({ message: "Home Assistant sent an unexpected answer.", kind: "invalid", detail: "GET /api/config: unexpected shape" })
        )
      )
    ),
    Effect.map((c) => ({ version: c.version, locationName: c.location_name }))
  )

  return {
    baseUrl: shownUrl,
    config,
    // The template endpoint is admin only: a 401 there with a token that passed /api/config means "not an admin".
    renderTemplate: (template) => request("POST", "/api/template", { template }, true),
    callService: (domain, service, data) => Effect.asVoid(request("POST", `/api/services/${domain}/${service}`, data))
  }
}
