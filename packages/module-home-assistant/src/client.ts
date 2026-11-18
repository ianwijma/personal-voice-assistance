import { type Connector, type ContentTypePolicy, fetchOwnerConfiguredLan, NetTimeout, type Resolver, type SafeFetchError } from "@pva/net"
import { Effect, Schema } from "effect"
import { addressSecrets, checkAddress, clip, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

/**
 * A minimal client for Home Assistant's REST API
 * (https://developers.home-assistant.io/docs/api/rest/, now served at
 * https://contributors.home-assistant.io/core/internals/rest-api/), through `@pva/net` only
 * (`fetchOwnerConfiguredLan`, docs/MODULES.md §12): the address is the one the owner typed, loopback only as typed
 * (`typedLoopback`), no redirect is followed (a redirect answer is a failure), the answer must be JSON or text, and
 * every call has its own time limit and byte limit.
 *
 * Three calls only: `GET /api/config` (reachability, the token, the temperature unit), `POST /api/template` with a JSON
 * body (one page of the house; admin only) and `POST /api/services/<domain>/<service>` with a JSON body (actions). A
 * POST is sent once and never again: when it fails after it may have reached Home Assistant, the failure is
 * `unconfirmed` (it may or may not have happened). Failures are `HomeAssistantError`s: `kind` says what happened (the
 * module words it in the household's language), `message` is an English sentence for the settings card and `detail` a
 * technical line, never with the token.
 */

export type HomeAssistantErrorKind =
  /** Not reached, and nothing was carried out: the name not found, the connection refused, an address or a redirect refused. */
  | "unreachable"
  /** A POST that may have reached Home Assistant failed before its answer was read: it may or may not have happened. */
  | "unconfirmed"
  /** No answer within the call's time limit (a service call may still have happened). */
  | "timeout"
  /** 401: the token is missing, wrong or revoked. */
  | "unauthorized"
  /** 403, or 401 on an admin-only endpoint for a non-admin user. */
  | "forbidden"
  /** Any other HTTP error status. */
  | "http"
  /** 200 with a body we could not read, or one larger than the call's `maxBytes`. */
  | "invalid"

export class HomeAssistantError extends Schema.TaggedError<HomeAssistantError>()("HomeAssistantError", {
  /** One spoken sentence: "I couldn't reach Home Assistant." */
  message: Schema.String,
  kind: Schema.Literals(["unreachable", "unconfirmed", "timeout", "unauthorized", "forbidden", "http", "invalid"]),
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
  /** The resolver and connector (tests: the kit's offline network); absent, `@pva/net`'s own. */
  readonly net?: NetDeps | undefined
}

/** What the client takes from its tests: `@pva/net`'s resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver | undefined
  readonly connector?: Connector | undefined
}

/** What Home Assistant answers: JSON (config, services, errors) or text (a rendered template, some errors). */
const HA_ANSWER: ContentTypePolicy = { name: "Home Assistant answer", types: ["application/json", "text/plain"] }

/** What one call may override: its time limit (default the client's `timeoutMs`) and the largest answer it reads. */
export interface CallLimits {
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
}

/** The largest answer read by default (`config`, a service call): 64 KiB. */
export const DEFAULT_MAX_BYTES = 64 * 1024

/** What `GET /api/config` says: the version, the place's name, and the installation's temperature unit. */
export interface HomeAssistantConfig {
  readonly version: string | undefined
  readonly locationName: string | undefined
  /** `unit_system.temperature`: "°C" → `C`, "°F" → `F`; anything else is `undefined` (not known). */
  readonly temperatureUnit: "C" | "F" | undefined
}

export interface HomeAssistantClient {
  readonly baseUrl: string
  /** `GET /api/config`, or a failure. */
  readonly config: (limits?: CallLimits) => Effect.Effect<HomeAssistantConfig, HomeAssistantError>
  /** `POST /api/template` with the template and its `variables`: the rendered text. */
  readonly renderTemplate: (template: string, variables: Readonly<Record<string, unknown>>, limits?: CallLimits) => Effect.Effect<string, HomeAssistantError>
  /**
   * `POST /api/services/<domain>/<service>` with `data` as the body (`?return_response` when `returnResponse`): the
   * answer's text (the changed states, or with `returnResponse` `{ changed_states, service_response }`), or
   * `undefined` when Home Assistant answered with success but more than `maxBytes` (the call happened; its answer is
   * not read).
   */
  readonly callService: (
    domain: string,
    service: string,
    data: Readonly<Record<string, unknown>>,
    limits?: CallLimits & { readonly returnResponse?: boolean | undefined }
  ) => Effect.Effect<string | undefined, HomeAssistantError>
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
  location_name: Schema.optional(Schema.String),
  unit_system: Schema.optional(Schema.Struct({ temperature: Schema.optional(Schema.String) }))
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
  let setup: { readonly baseUrl: string; readonly timeoutMs: number; readonly token: string } | string
  try {
    secrets = secretList(options.token)
    secrets = secretList(secrets, addressSecrets(options.baseUrl))
    const baseUrl = normalizeBaseUrl(options.baseUrl)
    setup = baseUrl === undefined
      ? `the address ${checkAddressSetting(options.baseUrl)?.toLowerCase() ?? "is empty"}`
      : { baseUrl, timeoutMs: options.timeoutMs, token: options.token }
  } catch (e) {
    setup = `the settings could not be read (${fromUpstream(e, secrets)})`
  }
  /** The only way a `HomeAssistantError` is made here: message and detail sanitised (see `redact.ts`). */
  const haError = (fields: ConstructorParameters<typeof HomeAssistantError>[0]) => new HomeAssistantError(sanitize(secrets, fields))
  // Only the credential-free form is ever shown; a refused address is shown as nothing at all.
  const shownUrl = typeof setup === "string" ? "" : setup.baseUrl

  const net = { ...(options.net?.resolver !== undefined ? { resolver: options.net.resolver } : {}), ...(options.net?.connector !== undefined ? { connector: options.net.connector } : {}) }

  /** One request through `@pva/net`: the status and the text, or `undefined` for a successful answer too large to read. */
  const send = (method: "GET" | "POST", path: string, body: unknown | undefined, adminOnly: boolean, limits: CallLimits, oversizedOk = false) =>
    Effect.suspend((): Effect.Effect<string | undefined, HomeAssistantError> => {
      if (typeof setup === "string") {
        return Effect.fail(haError({ message: "I couldn't reach Home Assistant.", kind: "unreachable", detail: `${method} ${path}: ${setup}` }))
      }
      const { baseUrl, token } = setup
      const timeoutMs = limits.timeoutMs ?? setup.timeoutMs
      const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES
      const common = {
        accept: HA_ANSWER,
        maxBytes,
        timeoutMs,
        // Never followed: a redirect answer is a failure with its own rule (a POST's is `post-redirect`).
        maxRedirects: 0,
        // The owner may have typed http://localhost:8123 (Home Assistant on this machine): loopback only as typed.
        typedLoopback: true,
        headers: { authorization: `Bearer ${token}` },
        ...net
      }
      const url = `${baseUrl}${path}`
      const fetched = method === "POST" ? fetchOwnerConfiguredLan(url, { ...common, method: "POST", body: { json: body } }) : fetchOwnerConfiguredLan(url, common)
      return fetched.pipe(
        // The same limit on the fiber's clock (a test drives it; in the app both are real time): whichever ends first.
        // Interrupting the request closes its connection.
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new NetTimeout({ url: shownUrl, timeoutMs })) }),
        Effect.mapError((e: SafeFetchError): HomeAssistantError | { readonly tooLarge: true } => {
          const at = `${method} ${path}`
          switch (e._tag) {
            case "NetTooLarge":
              return { tooLarge: true }
            case "NetTimeout":
              return haError({ message: "Home Assistant didn't answer in time.", kind: "timeout", detail: `${at}: no answer within ${timeoutMs} ms` })
            case "NetRefused":
              return haError({ message: "I couldn't reach Home Assistant.", kind: "unreachable", detail: `${at}: refused (${e.rule}): ${fromUpstream(e.detail, secrets)}` })
            case "NetAborted":
              return haError({ message: "I couldn't reach Home Assistant.", kind: "unreachable", detail: `${at}: aborted` })
            case "NetFailure": {
              // A POST that failed after it may have been written: it may or may not have been carried out.
              const maybe = method === "POST" && (e.stage === "response" || e.detail.includes("may or may not"))
              return haError({
                message: maybe ? "Home Assistant may or may not have done it: its answer did not come." : "I couldn't reach Home Assistant.",
                kind: maybe ? "unconfirmed" : "unreachable",
                detail: `${at}: ${e.stage}: ${fromUpstream(e.detail, secrets)}`
              })
            }
          }
        }),
        Effect.flatMap((response) => {
          const status = response.status
          const text = response.text()
          if (status >= 200 && status < 300) return Effect.succeed(text)
          // A proxy in front of Home Assistant may echo the Authorization header: `clip` redacts the whole body before shortening.
          const snippet = clip(fromUpstream(text, secrets).replace(/\s+/g, " ").trim(), secrets, 200)
          if (status === 401 && !adminOnly) {
            return Effect.fail(haError({ message: "Home Assistant rejected the access token.", kind: "unauthorized", status, detail: `${method} ${path}: 401` }))
          }
          if (status === 401 || status === 403) {
            return Effect.fail(haError({ message: "Home Assistant refused the request: the token's user may not be an administrator.", kind: "forbidden", status, detail: `${method} ${path}: ${status} ${snippet}` }))
          }
          return Effect.fail(haError({ message: status === 503 ? "Home Assistant is restarting." : "Home Assistant reported an error.", kind: "http", status, detail: `${method} ${path}: HTTP ${status} ${snippet}` }))
        }),
        Effect.catch((e): Effect.Effect<string | undefined, HomeAssistantError> => {
          if (!("tooLarge" in e)) return Effect.fail(e)
          // A successful service answer too large to read: the call happened, its answer is cut (Home Assistant's error
          // answers are short; `@pva/net` does not say the status of an answer it did not read).
          if (oversizedOk) return Effect.succeed(undefined)
          return Effect.fail(haError({ message: "Home Assistant sent an answer that is too large.", kind: "invalid", detail: `${method} ${path}: more than ${maxBytes} bytes` }))
        })
      )
    })

  // The last resort: anything unexpected (a defect) leaves as a sanitised `HomeAssistantError`.
  const request = (method: "GET" | "POST", path: string, body: unknown | undefined, adminOnly: boolean, limits: CallLimits = {}, oversizedOk = false) =>
    send(method, path, body, adminOnly, limits, oversizedOk).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(haError({ message: "Something went wrong talking to Home Assistant.", kind: "invalid", detail: `${method} ${path}: ${describeCause(defect, secrets)}` }))
      ),
      Effect.mapError((e) => haError({ message: e.message, kind: e.kind, detail: e.detail, ...(e.status !== undefined ? { status: e.status } : {}) }))
    )

  const config = (limits?: CallLimits) => request("GET", "/api/config", undefined, false, limits).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text ?? "") as unknown,
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
    Effect.map((c): HomeAssistantConfig => {
      const unit = c.unit_system?.temperature
      return { version: c.version, locationName: c.location_name, temperatureUnit: unit === "°C" ? "C" : unit === "°F" ? "F" : undefined }
    })
  )

  return {
    baseUrl: shownUrl,
    config,
    // The template endpoint is admin only: a 401 there with a token that passed /api/config means "not an admin".
    renderTemplate: (template, variables, limits) => Effect.map(request("POST", "/api/template", { template, variables }, true, limits), (t) => t ?? ""),
    callService: (domain, service, data, limits) =>
      request("POST", `/api/services/${domain}/${service}${limits?.returnResponse === true ? "?return_response" : ""}`, data, false, limits, true)
  }
}
