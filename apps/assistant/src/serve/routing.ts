import { DecisionError, type DecisionRequest, type DecisionResponse } from "@pva/core"
import { checkUrl, defaults as jevDefaults, makeJevClient, readRouting, type RouteCandidate, routingRequest } from "@pva/decide-typesafe"
import { Effect, Redacted } from "effect"
import type { DecideResult, DecideRoute, RouteDecision } from "./SessionDispatcher.ts"

/**
 * TypeSafe routing in serve mode (docs/ASSISTANTS.md §3.6, WP-14): the shared `routing` section's client, and the
 * session dispatcher's `decide` built from it for one device.
 *
 * The request is built and read by `@pva/decide-typesafe` (`routingRequest`, `readRouting`); the HTTP call is its
 * `makeJevClient`. Here: whether routing is set up (`ready`, the voice page's `canAuto`), the give-up timer, the
 * fallback, and the times for the trace.
 */

/** The routing section's keys (`sectionDefinitions.ts`). */
export const ROUTING_KEYS = {
  enabled: "TYPESAFE_ROUTING",
  apiKey: "TYPESAFE_API_KEY",
  model: "TYPESAFE_MODEL",
  baseUrl: "TYPESAFE_BASE_URL"
} as const

/** The settings the routing client is made from (already resolved: environment, saved values, vault). */
export interface RoutingSettings {
  readonly enabled: boolean
  readonly apiKey: string | undefined
  readonly model: string | undefined
  readonly baseUrl: string | undefined
}

/** One routing round trip, at most `timeoutMs`; interruptible. */
export interface RoutingService {
  /** The routing section is enabled and has a key and a valid address. */
  readonly ready: () => boolean
  readonly decide: (request: DecisionRequest, timeoutMs: number) => Effect.Effect<DecisionResponse, DecisionError>
}

/** Enabled, a key, an address that passes the adapter's check. */
export const routingReady = (s: RoutingSettings): boolean =>
  s.enabled && s.apiKey !== undefined && s.apiKey.trim() !== "" &&
  checkUrl(s.baseUrl?.trim() || jevDefaults.baseUrl) === undefined

/**
 * The routing service over the settings read at each call: one `JevClient` per distinct (key, address, model), so a
 * kept connection is reused, and a changed key makes a new client (a rejected key is remembered per client).
 */
export const makeRoutingService = (
  settings: () => RoutingSettings,
  options: { readonly fetch?: typeof globalThis.fetch } = {}
): RoutingService => {
  let current: { readonly id: string; readonly client: ReturnType<typeof makeJevClient> } | undefined
  const clientFor = (s: RoutingSettings) => {
    const apiKey = s.apiKey?.trim() ?? ""
    const baseUrl = s.baseUrl?.trim() || jevDefaults.baseUrl
    const model = s.model?.trim() || jevDefaults.model
    const id = JSON.stringify([apiKey, baseUrl, model])
    if (current?.id !== id) {
      current = {
        id,
        client: makeJevClient({ apiKey: Redacted.make(apiKey), baseUrl, model, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) })
      }
    }
    return current.client
  }
  return {
    ready: () => routingReady(settings()),
    decide: (request, timeoutMs) =>
      Effect.suspend(() => {
        const s = settings()
        if (!routingReady(s)) return Effect.fail(new DecisionError({ reason: "unavailable", message: "TypeSafe routing is not set up" }))
        return clientFor(s).decide(request, { timeoutMs })
      })
  }
}

export interface TypesafeDecideOptions {
  /** `undefined`, or not `ready`: routing is not set up, and nobody answers without a phrase (the device page says so). */
  readonly routing: () => RoutingService | undefined
  /** The device's switched-on assistants in list order (`typesafeCandidates`), with their Handles. */
  readonly candidates: () => ReadonlyArray<RouteCandidate>
  /** The device's give-up time (`withoutPhrase.giveUpMs`). */
  readonly giveUpMs: () => number
  /** The trace clock (`TurnTrace.now`), so `routeSent`/`routeReceived` sit on the turns' time line. */
  readonly now: () => number
  /** A failed decision (not a timeout), once per distinct message in a row. */
  readonly log?: (line: string) => void
}

/**
 * The session dispatcher's `decide` for a TypeSafe device (§3.6). Never fails, never takes longer than the give-up
 * time (the call is interrupted and its request aborted then; a late answer is never read):
 *
 * - routing not set up → nobody (`assistant: null`), no request;
 * - no switched-on candidate → the fallback, no request;
 * - chosen → that assistant; none fits, the give-up time, or an error (rejected key, network, refused, bad answer)
 *   → the fallback (`null`: nobody), with the outcome, probabilities and times in `decision` for the trace.
 */
export const makeTypesafeDecide = (options: TypesafeDecideOptions): DecideRoute => {
  let lastLogged: string | undefined
  return (request) =>
    Effect.suspend((): Effect.Effect<DecideResult> => {
      const routing = options.routing()
      if (routing === undefined || !routing.ready()) return Effect.succeed({ assistant: null, fallback: true })
      const candidates = options.candidates()
      if (candidates.length === 0) return Effect.succeed({ assistant: request.fallback, fallback: true })
      const giveUpMs = options.giveUpMs()
      const sentAt = options.now()
      const timedOut = new DecisionError({ reason: "timeout", message: `TypeSafe did not answer within ${giveUpMs} ms` })
      return routing.decide(routingRequest(request.text, candidates), giveUpMs).pipe(
        Effect.timeoutOrElse({ duration: giveUpMs, orElse: () => Effect.fail(timedOut) }),
        Effect.catchDefect((defect) => Effect.fail(new DecisionError({ reason: "unavailable", message: `TypeSafe routing failed: ${String(defect)}` }))),
        Effect.result,
        Effect.map((result): DecideResult => {
          const at = options.now()
          const ms = Math.max(0, at - sentAt)
          if (result._tag === "Failure") {
            const timeout = result.failure.reason === "timeout"
            if (!timeout && options.log !== undefined && result.failure.message !== lastLogged) {
              lastLogged = result.failure.message
              options.log(`TypeSafe routing failed, the fallback answers: ${result.failure.message}`)
            }
            const decision: RouteDecision = timeout ? { outcome: "timeout", ms, sentAt } : { outcome: "error", ms, sentAt, receivedAt: at }
            return { assistant: request.fallback, fallback: true, decision }
          }
          lastLogged = undefined
          const reading = readRouting(result.success, candidates)
          const decision: RouteDecision = {
            outcome: reading.outcome,
            ...(reading.probability !== undefined ? { probability: reading.probability } : {}),
            fits: reading.fits,
            ms,
            sentAt,
            receivedAt: at
          }
          return reading.outcome === "chosen"
            ? { assistant: reading.assistant, fallback: false, decision }
            : { assistant: request.fallback, fallback: true, decision }
        })
      )
    })
}
