// How the household stores call a hook nobody awaits (internal; `@pva/core/store-backend` re-exports `observe`).

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Observe a promise (or other thenable) nobody awaits, so a rejection is logged, never unhandled. */
export const observe = (x: unknown, log: (line: string) => void, what: string): void => {
  if ((typeof x === "object" || typeof x === "function") && x !== null && typeof (x as { then?: unknown }).then === "function") {
    try {
      ;(x as PromiseLike<unknown>).then(undefined, (e: unknown) => log(`${what} failed later (it is not awaited): ${messageOf(e)}`))
    } catch {
      // A thenable whose `then` throws has nothing more to observe.
    }
  }
}

/**
 * Run a hook (an after-commit callback, a rollback hook) as every store does: a synchronous throw is caught (a hook must
 * not break the others or its caller), a promise it returns is observed (`observe`), nothing is awaited.
 */
export const runHook = (f: () => unknown, log: (line: string) => void, what: string): void => {
  try {
    observe(f(), log, what)
  } catch {
    // A hook must not break the others.
  }
}
