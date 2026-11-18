import { isModuleStopped, type ModuleHostApi, type ServiceKey } from "@pva/core"
import { Cause, Data, Effect } from "effect"

/**
 * What every contract of this package shares (docs/MODULES.md, "Services and contributions between modules").
 *
 * The rules a consumer follows, whatever the service:
 *
 * 1. **Look the service up at each use** (`host.service(key)`, or `useService` below), never keep it: its provider
 *    starts, stops and restarts on its own, and after a restart it is a new object. `undefined` means the providing
 *    module is off (no switched-on assistant has it on and no demanded module `uses` it): say so in one sentence
 *    (`providerOffText`), never improvise.
 * 2. **A call can fail while the provider stops.** The provider's grace period covers only calls admitted to the
 *    provider itself; a call another module makes into its service while it stops may die with `ModuleStopped` (the
 *    provider's part has closed) or fail with the contract's own error. `useService` turns the first into
 *    `ProviderOff`, so a consumer handles both as "that module is off or restarting".
 * 3. **A service call runs on behalf of the call that made it** (docs/MODULES-PLAN.md §2 row 18): the gateway admitted
 *    the consumer's tool, command or job, and the provider does not ask again. So a service offers only what any caller
 *    may do (reads and `change`-class operations on household data). The transport (`HomeAssistant`) is the
 *    exception: the consumer classifies its own tools, and each call it makes must fit the call the gateway admitted.
 * 4. **A module that cannot run at all without a provider names it in `uses`**, so the provider is demanded with it.
 *    One that only works better with it (kitchen without lists) does not, and says what is missing when it is.
 * 5. **Errors carry a reason, not a sentence.** A contract's error has a `reason` the consumer words in its own two
 *    languages, and a `detail` for the log (English, never spoken, never private).
 */

/** A JSON value: what crosses a contract's boundary (plain data in and out, no classes, no functions). */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }
export type JsonObject = { readonly [key: string]: Json }

/** The household languages modules speak (`HOME_LANGUAGE` `en-GB`, `en-US`, `nl-NL`; any other is English). */
export type Language = "en" | "nl"

/** The providing module is off, or stopped or restarted while it was called (`useService`). Worded by the consumer. */
export class ProviderOff extends Data.TaggedError("ProviderOff")<{
  /** The service key's id ("lists"). */
  readonly service: string
}> {}

/**
 * Look a service up now and use it: `undefined` (the provider is off) and a `ModuleStopped` defect from the provider's
 * closed part (it stopped or restarted during the call) both become `ProviderOff`. Everything else the call does is
 * passed through unchanged, its typed errors included.
 */
export const useService = <T, A, E, R>(
  host: Pick<ModuleHostApi, "service">,
  key: ServiceKey<T>,
  use: (service: T) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | ProviderOff, R> =>
  Effect.suspend(() => {
    const service = host.service(key)
    if (service === undefined) return Effect.fail(new ProviderOff({ service: key.id }))
    return Effect.suspend(() => use(service)).pipe(
      Effect.catchCause((cause): Effect.Effect<A, E | ProviderOff> => {
        const stopped = cause.reasons.some((r) => Cause.isDieReason(r) && isModuleStopped(r.defect))
        return stopped ? Effect.fail(new ProviderOff({ service: key.id })) : Effect.failCause(cause)
      })
    )
  })

/**
 * The sentence for `ProviderOff` in the household's language: "The Lists module is off." / "De module Lists staat
 * uit." `module` is the providing module's name as the owner sees it on the Modules page ("Lists", "Smart home").
 */
export const providerOffText = (language: Language, module: string): string =>
  language === "nl" ? `De module ${module} staat uit.` : `The ${module} module is off.`

/** Whether `text` is a well-formed bounded one-line text: no control characters, no lone surrogates, at most `max` UTF-16 units. */
export const isLine = (text: unknown, max: number): text is string =>
  typeof text === "string" && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) && !LONE_SURROGATE.test(text)

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/**
 * Whether `text` is an id of 1 to `max` of letters, digits and `_ . : -`. Each contract field that takes an id states its
 * own bound (a store row id is at most 200, a Members id 40, a device id 64); there is no default.
 */
export const isContractId = (text: unknown, max: number): text is string =>
  typeof text === "string" && text.length >= 1 && text.length <= max && /^[A-Za-z0-9_.:-]+$/.test(text)
