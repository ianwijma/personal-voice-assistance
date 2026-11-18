import { isModuleStopped, type ModuleHostApi, type ServiceKey } from "@pva/core"
import { Cause, Data, Effect } from "effect"

/**
 * What every contract of this package shares (docs/MODULES.md, "Services and contributions between modules").
 *
 * The rules a consumer follows, whatever the service:
 *
 * 1. **Look the service up at each use** (`host.service(key)`, or `useService` below), never keep it: its provider
 *    starts, stops and restarts on its own. `undefined` means the providing module is off (no switched-on assistant has
 *    it on and no demanded module `uses` it): say so in one sentence ("The lists module is off."), never improvise.
 * 2. **A call can fail while the provider stops.** The provider's grace period covers only calls admitted to the
 *    provider itself; a call another module makes into its service while it stops may die with `ModuleStopped` (the
 *    provider's part has closed) or fail with the contract's own error. `useService` turns the first into
 *    `ProviderOff`, so a consumer handles both as "that module is off or restarting".
 * 3. **A service call runs on behalf of the call that made it** (docs/MODULES-PLAN.md §2 row 18): the gateway admitted
 *    the consumer's tool, command or job, and the provider does not ask again. So a service offers only what any caller
 *    may do (reads and `change`-class operations on household data). The transports (`HomeAssistant`, `Mcp`) are the
 *    exception: the consumer classifies its own tools and each call it makes must fit the call the gateway admitted.
 * 4. **A module that cannot run at all without a provider names it in `uses`**, so the provider is demanded with it.
 *    One that only works better with it (kitchen without lists) does not, and says what is missing when it is.
 */

/** A JSON value: what crosses a contract's boundary (plain data in and out, no classes, no functions). */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }
export type JsonObject = { readonly [key: string]: Json }

/** The household languages modules speak (`HOME_LANGUAGE` `en-GB`, `en-US`, `nl-NL`; any other is English). */
export type Language = "en" | "nl"

/** The providing module is off, or stopped or restarted while it was called (`useService`). */
export class ProviderOff extends Data.TaggedError("ProviderOff")<{
  /** The service key's id ("lists"). */
  readonly service: string
  /** One sentence for the person: "The lists module is off." */
  readonly message: string
}> {}

/**
 * Look a service up now and use it: `undefined` (the provider is off) and a `ModuleStopped` defect from the provider's
 * closed part (it stopped or restarted during the call) both become `ProviderOff`. Everything else the call does is
 * passed through unchanged, its typed errors included. `name` is how the module is called in the sentence ("lists").
 */
export const useService = <T, A, E, R>(
  host: Pick<ModuleHostApi, "service">,
  key: ServiceKey<T>,
  name: string,
  use: (service: T) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | ProviderOff, R> =>
  Effect.suspend(() => {
    const off = new ProviderOff({ service: key.id, message: `The ${name} module is off.` })
    const service = host.service(key)
    if (service === undefined) return Effect.fail(off)
    return Effect.suspend(() => use(service)).pipe(
      Effect.catchCause((cause): Effect.Effect<A, E | ProviderOff> => {
        const stopped = cause.reasons.some((r) => Cause.isDieReason(r) && isModuleStopped(r.defect))
        return stopped ? Effect.fail(off) : Effect.failCause(cause)
      })
    )
  })

/** Whether `text` is a well-formed bounded one-line text (no control characters, no lone surrogates). */
export const isLine = (text: unknown, max: number): text is string =>
  typeof text === "string" && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) && !LONE_SURROGATE.test(text)

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Ids that cross a contract: 1–`max` of letters, digits and `_ . : -` (every row, device, person and job id fits). */
export const isContractId = (text: unknown, max = 100): text is string =>
  typeof text === "string" && text.length >= 1 && text.length <= max && /^[A-Za-z0-9_.:-]+$/.test(text)
