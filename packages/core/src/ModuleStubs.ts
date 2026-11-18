/**
 * Stubs of the services modules share (docs/MODULES.md, "Testing a consumer"): an object with a contract's methods,
 * each of which records its calls and answers what the test programmed for it. Exported from `@pva/core/testing`.
 *
 * A stub has **no behaviour of its own**: no merging, no limits, no matching, no queues, no clocks. What a provider
 * does is written in its contract's documentation, and a consumer's test programs the answers that documentation
 * allows for the case it tests (a value, a typed failure, the provider stopping mid-call, or a function of the
 * arguments). A method called without a programmed answer throws `UnprogrammedStubCall`, and the test kit fails the
 * test with it at the end of the tool, action or job that made the call, whatever the module did with the error.
 *
 * ```ts
 * const lists = stubService<ListsService>("lists", {
 *   addItem: (request) => Effect.succeed({ outcome: "added", item: { id: "i1", text: request.text, status: "open" } })
 * })
 * const kit = yield* startTestModule(kitchen, { provide: [provide("lists", { services: [Lists.of(lists.service)] })] })
 * // … run a tool …
 * assert.strictEqual(lists.calls.addItem?.[0]?.[0].dedupeKey, "kitchen:product:rice")
 * ```
 */
import { Effect } from "effect"
import { ModuleStopped } from "./ModuleApi.ts"

/** A call of a stub's method that the test gave no answer for. The test kit fails the test with it. */
export class UnprogrammedStubCall extends Error {
  readonly service: string
  readonly method: string
  constructor(service: string, method: string) {
    super(`The stub of ${service} was called (${method}) without a programmed answer: give it one with stubService(…, { ${method}: … }) or .answer("${method}", …)`)
    this.name = "UnprogrammedStubCall"
    this.service = service
    this.method = method
  }
}

const unprogrammed: Array<UnprogrammedStubCall> = []

/** The unprogrammed calls since the last time this was asked, oldest first (the test kit asks after every call it makes). */
export const takeUnprogrammedStubCalls = (): ReadonlyArray<UnprogrammedStubCall> => unprogrammed.splice(0, unprogrammed.length)

type Methods<T> = { readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : never }

export interface Stub<T> {
  /** The object to publish (`Lists.of(stub.service)`): every method of the contract, as the test programmed it. */
  readonly service: T
  /** The arguments of every call, per method, in order. */
  readonly calls: { readonly [K in keyof T]?: ReadonlyArray<T[K] extends (...args: infer A) => unknown ? A : never> }
  /** Program (or reprogram) a method's answer. */
  readonly answer: <K extends keyof T>(method: K, answer: Methods<T>[K]) => void
}

/**
 * A stub of the contract `T`, named `service` in its error messages, with the answers given (more with `answer`). An
 * answer is the method itself: a function of its arguments returning what the contract's method returns. The helpers
 * below make the usual ones.
 */
export const stubService = <T extends object>(service: string, answers: Partial<Methods<T>> = {}): Stub<T> => {
  const programmed = new Map<PropertyKey, (...args: ReadonlyArray<unknown>) => unknown>(Object.entries(answers) as never)
  const calls: Record<PropertyKey, Array<ReadonlyArray<unknown>>> = {}
  const methods = new Map<PropertyKey, (...args: ReadonlyArray<unknown>) => unknown>()
  const methodOf = (name: PropertyKey) => {
    let m = methods.get(name)
    if (m === undefined) {
      m = (...args: ReadonlyArray<unknown>) => {
        ;(calls[name] ??= []).push(args)
        const answer = programmed.get(name)
        if (answer === undefined) {
          const error = new UnprogrammedStubCall(service, String(name))
          unprogrammed.push(error)
          throw error
        }
        return answer(...args)
      }
      methods.set(name, m)
    }
    return m
  }
  // Every string property is a method (contracts have methods only); `then` and symbols are absent, so a stub is never
  // taken for a promise or printed as a method.
  const object = new Proxy({}, {
    get: (_target, name) => (typeof name === "symbol" || name === "then" || name === "toJSON" ? undefined : methodOf(name)),
    has: (_target, name) => typeof name === "string" && name !== "then"
  })
  return {
    service: object as T,
    calls: calls as unknown as Stub<T>["calls"],
    answer: (method, answer) => void programmed.set(method, answer as never)
  }
}

/** An answer that succeeds with `value` (an Effect method). */
export const succeeds = <A>(value: A) => (): Effect.Effect<A> => Effect.succeed(value)

/** An answer that fails with the contract's typed error `error` (an Effect method). */
export const fails = <E>(error: E) => (): Effect.Effect<never, E> => Effect.fail(error)

/**
 * An answer of a provider that stopped or restarted during the call: it dies with `ModuleStopped`, as a real
 * provider's closed part does; `useService` (`@pva/module-contracts`) makes that `ProviderOff`.
 */
export const stops = () => (): Effect.Effect<never> => Effect.die(new ModuleStopped({ message: "The providing module stopped during the call (stub)." }))

/** An answer that returns `value` as it is (a method that answers at once, without an Effect). */
export const returns = <A>(value: A) => (): A => value
