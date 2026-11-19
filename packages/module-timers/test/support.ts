// A test's own wrapper of what the host gives the two modules (not a test file): failures and gates at the store, the
// notification service and the Presenter, and a record of the handlers the module registered, so a test can make one
// step fail, hold one step, or run a registered handler itself with its original identity.
import { type JobHandler, type ModuleDefinition, type ModuleStore, NotifyError, type NotifyActionHandler, PresentError, type StoreFailure } from "@pva/core"
import { Deferred, Effect } from "effect"

export interface Hooks {
  /** Every transaction fails with this, writing nothing. */
  writesFail?: StoreFailure | undefined
  /** The next `n` transactions fail with this, writing nothing (each consumes one). */
  txFail?: { times: number; readonly failure: StoreFailure } | undefined
  /** After the next successful send, the next transaction fails once with this (the write after the send). */
  failAfterSend?: StoreFailure | undefined
  /** The `n`-th row write inside the next transaction throws this: it rolls back after a write. */
  throwAtWrite?: { readonly n: number; readonly failure: StoreFailure } | undefined
  /** The next transaction waits for this to be completed first. */
  gate?: Deferred.Deferred<void> | undefined
  /** The next send waits for this to be completed first; `sendEntered` says it is waiting. */
  sendGate?: Deferred.Deferred<void> | undefined
  sendEntered?: boolean
  /** `notify.send` fails with this while set. */
  sendFail?: NotifyError | undefined
  /** `notify.resolve` fails with this while set. */
  resolveFail?: NotifyError | undefined
  /** `present.show` fails with this while set. */
  showFail?: PresentError | undefined
  /** A presentation handle's `dismiss` fails with this while set. */
  dismissFail?: PresentError | undefined
  /** Real milliseconds of busy work inside every send, before it is made (the latency test's sensitivity check). */
  sendBusyMs?: number | undefined
  /** Calls of each scheduler handler, by name. */
  readonly runs: Map<string, number>
}

export const makeHooks = (): Hooks => ({ runs: new Map() })

/** The handlers the module registered, by name, as it registered them. */
export interface Registered {
  readonly jobs: Map<string, JobHandler<any, any>>
  readonly presses: Map<string, NotifyActionHandler>
}

export const makeRegistered = (): Registered => ({ jobs: new Map(), presses: new Map() })

export const busyFailure = (): NotifyError => new NotifyError({ reason: "busy", message: "test: busy" })
export const limitFailure = (): NotifyError => new NotifyError({ reason: "limit", message: "test: limit" })
export const presentFailure = (): PresentError => new PresentError({ reason: "busy", message: "test: busy" })

const hookStore = (raw: ModuleStore, hooks: Hooks): ModuleStore => ({
  moduleId: raw.moduleId,
  readOnly: raw.readOnly,
  collection: (c) => {
    const h = raw.collection(c)
    const fails = () => hooks.writesFail
    return {
      ...h,
      insert: (v, o) => (fails() !== undefined ? Effect.fail(fails()!) : h.insert(v, o)),
      update: (id, f, o) => (fails() !== undefined ? Effect.fail(fails()!) : h.update(id, f, o)),
      remove: (id, o) => (fails() !== undefined ? Effect.fail(fails()!) : h.remove(id, o))
    } as typeof h
  },
  transaction: (f) =>
    Effect.gen(function*() {
      const gate = hooks.gate
      if (gate !== undefined) {
        hooks.gate = undefined
        yield* Deferred.await(gate)
      }
      if (hooks.writesFail !== undefined) return yield* Effect.fail(hooks.writesFail)
      const t = hooks.txFail
      if (t !== undefined && t.times > 0) {
        t.times--
        return yield* Effect.fail(t.failure)
      }
      const at = hooks.throwAtWrite
      if (at === undefined) return yield* raw.transaction(f)
      hooks.throwAtWrite = undefined
      let writes = 0
      const count = () => {
        if (++writes === at.n) throw at.failure
      }
      return yield* raw.transaction((tx) =>
        f({
          ...tx,
          collection: (c: any) => {
            const x = tx.collection(c)
            return { ...x, insert: (v: any, o: any) => (count(), x.insert(v, o)), update: (id: string, g: any, o: any) => (count(), x.update(id, g, o)) }
          }
        } as typeof tx)
      )
    }) as any
})

const busyWait = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) { /* the sensitivity check's own work */ }
}

/** A module with the hooks between it and the host, and its registrations recorded. */
export const hooked = <M extends ModuleDefinition<any>>(definition: M, hooks: Hooks, registered: Registered = makeRegistered()): M => ({
  ...definition,
  shared: (ctx: any) =>
    definition.shared!({
      ...ctx,
      store: hookStore(ctx.store, hooks),
      scheduler: {
        ...ctx.scheduler,
        handle: (name: string, handler: JobHandler<any, any>) => {
          const counted = { ...handler, run: (p: any, due: any) => Effect.andThen(Effect.sync(() => void hooks.runs.set(name, (hooks.runs.get(name) ?? 0) + 1)), handler.run(p, due)) }
          registered.jobs.set(name, counted)
          return ctx.scheduler.handle(name, counted)
        }
      },
      notify: {
        ...ctx.notify,
        send: (request: any) =>
          Effect.gen(function*() {
            const gate = hooks.sendGate
            if (gate !== undefined) {
              hooks.sendGate = undefined
              hooks.sendEntered = true
              yield* Deferred.await(gate)
            }
          }).pipe(Effect.andThen(Effect.suspend(() => {
            if (hooks.sendBusyMs !== undefined) busyWait(hooks.sendBusyMs)
            if (hooks.sendFail !== undefined) return Effect.fail(hooks.sendFail)
            return Effect.tap(ctx.notify.send(request), () =>
              Effect.sync(() => {
                if (hooks.failAfterSend !== undefined) {
                  hooks.txFail = { times: 1, failure: hooks.failAfterSend }
                  hooks.failAfterSend = undefined
                }
              }))
          }))),
        resolve: (target: any, outcome?: any) => Effect.suspend(() => (hooks.resolveFail !== undefined ? Effect.fail(hooks.resolveFail) : ctx.notify.resolve(target, outcome))),
        handle: (name: string, handler: NotifyActionHandler) => {
          registered.presses.set(name, handler)
          return ctx.notify.handle(name, handler)
        }
      },
      present: {
        ...ctx.present,
        show: (target: any, presentation: any, options?: any) =>
          Effect.suspend(() =>
            hooks.showFail !== undefined
              ? Effect.fail(hooks.showFail)
              : Effect.map(ctx.present.show(target, presentation, options), (handle: any) => ({
                ...handle,
                dismiss: Effect.suspend(() => (hooks.dismissFail !== undefined ? Effect.fail(hooks.dismissFail) : handle.dismiss)),
                update: handle.update
              }))
          )
      }
    })
}) as M
