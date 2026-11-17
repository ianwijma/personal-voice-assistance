import { Context, Effect, Exit, Semaphore } from "effect"
import type { CommittedChange } from "./HouseholdStore.ts"
import { StoreError } from "./HouseholdStore.ts"

/**
 * The household store's transaction model (docs/STORING-DATA.md "Transactions"), written once and used by the SQLite
 * store and the in-memory double alike, so both behave the same by construction:
 *
 * 1. **One transaction at a time.** A store has one lock. An outermost transaction holds it from its begin until its
 *    events are released; a statement outside any transaction takes it for that one statement. So nothing outside a
 *    transaction ever sees its uncommitted state, and two transactions never interleave on SQLite's one connection.
 * 2. **One frame at a time inside a transaction.** Each transaction level is a frame with its own mutex. A statement
 *    run with a frame in its context takes that frame's mutex for the statement; a nested transaction (a savepoint)
 *    takes its parent frame's mutex for its whole life. So while a savepoint is open, nothing else of its parent runs:
 *    rolling it back can only undo its own work, never a sibling's or the parent's (concurrent siblings run one after
 *    the other).
 * 3. **Ended frames are refused.** A fiber that kept a frame in its context after the transaction ended (forked inside
 *    it) fails with `StoreError` ("the transaction has already ended") instead of writing outside it.
 * 4. **Events after the commit, in change-log order.** Committed changes and module events go into the frame's outbox
 *    in the order they happen. A savepoint that commits hands its outbox to its parent; one that rolls back drops it.
 *    The outermost commit releases the outbox while it still holds the store lock, so the events of one transaction
 *    are delivered before any later transaction's, in change-log order.
 * 5. **Rollback hooks.** `onRollback` registers an undo for state kept outside the backend (the scheduler's in-memory
 *    job table): it runs, newest first, when the frame it was registered in (or an enclosing one) rolls back.
 */

/** What a frame's outbox holds: a committed data change, or something to run after the commit (a module event). */
export type OutboxItem = { readonly _tag: "change"; readonly change: CommittedChange } | { readonly _tag: "run"; readonly run: () => void }

interface Frame {
  readonly owner: object
  readonly parent: Frame | undefined
  readonly mutex: Semaphore.Semaphore
  active: boolean
  readonly outbox: Array<OutboxItem>
  readonly undo: Array<() => void>
}

const FrameRef = Context.Reference<Frame | undefined>("@pva/core/StoreFrame", { defaultValue: () => undefined })

const ended = () => new StoreError({ reason: "failed", message: "The household store transaction has already ended (a fiber kept it after it finished)" })

const isActive = (frame: Frame): boolean => {
  for (let f: Frame | undefined = frame; f !== undefined; f = f.parent) if (!f.active) return false
  return true
}

export interface TransactionBackend {
  /** Run `work` as the outermost transaction (begin; commit on success; roll back on failure or interruption). */
  readonly outer: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /** Run `work` as a savepoint inside the current one (release on success; roll back to it otherwise). */
  readonly inner: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /** After the outermost commit, with the store lock still held: deliver the outbox (never fails, never waits). */
  readonly release: (items: ReadonlyArray<OutboxItem>) => void
}

export interface Transactions {
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /**
   * Run one statement (or one backend operation of several statements): in the current frame under its mutex, else
   * under the store lock. Never nest `statement` in `statement`: the mutexes are not re-entrant.
   */
  readonly statement: <X, E, R>(effect: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /** Whether the caller runs inside a transaction of this store. */
  readonly inTransaction: Effect.Effect<boolean>
  /** Inside a transaction: queue `item` for after the outermost commit. Outside: release it now. */
  readonly enqueue: (item: OutboxItem) => Effect.Effect<void, StoreError>
  /** Inside a transaction: `undo` runs if the frame (or an enclosing one) rolls back. Outside: nothing. */
  readonly onRollback: (undo: () => void) => Effect.Effect<void, StoreError>
}

const runUndo = (undo: ReadonlyArray<() => void>) => {
  for (let i = undo.length - 1; i >= 0; i--) {
    try {
      undo[i]!()
    } catch {
      // An undo hook must not stop the others.
    }
  }
}

export const makeTransactions = (backend: TransactionBackend): Transactions => {
  const owner = {}
  const lock = Semaphore.makeUnsafe(1)

  const current = Effect.map(Effect.service(FrameRef), (f) => (f?.owner === owner ? f : undefined))

  const frameOf = (parent: Frame | undefined): Frame => ({ owner, parent, mutex: Semaphore.makeUnsafe(1), active: true, outbox: [], undo: [] })

  const outermost = <X, E, R>(work: Effect.Effect<X, E, R>): Effect.Effect<X, E | StoreError, R> =>
    lock.withPermits(1)(Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const frame = frameOf(undefined)
        return restore(backend.outer(Effect.provideService(work, FrameRef, frame))).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              frame.active = false
              if (Exit.isSuccess(exit)) backend.release(frame.outbox)
              else runUndo(frame.undo)
            })
          )
        )
      })
    ))

  const nested = <X, E, R>(parent: Frame, work: Effect.Effect<X, E, R>): Effect.Effect<X, E | StoreError, R> =>
    parent.mutex.withPermits(1)(Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (!isActive(parent)) return Effect.fail(ended())
        const frame = frameOf(parent)
        return restore(backend.inner(Effect.provideService(work, FrameRef, frame))).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              frame.active = false
              if (Exit.isSuccess(exit)) {
                parent.outbox.push(...frame.outbox)
                parent.undo.push(...frame.undo)
              } else runUndo(frame.undo)
            })
          )
        )
      })
    ))

  return {
    transaction: (work) => Effect.flatMap(current, (frame) => (frame === undefined ? outermost(work) : nested(frame, work))),
    statement: <X, E, R>(effect: Effect.Effect<X, E, R>) =>
      Effect.flatMap(current, (frame): Effect.Effect<X, E | StoreError, R> => {
        if (frame === undefined) return lock.withPermits(1)(effect)
        if (!isActive(frame)) return Effect.fail(ended())
        return frame.mutex.withPermits(1)(Effect.suspend((): Effect.Effect<X, E | StoreError, R> => (isActive(frame) ? effect : Effect.fail(ended()))))
      }),
    inTransaction: Effect.map(current, (f) => f !== undefined),
    enqueue: (item) =>
      Effect.flatMap(current, (frame) => {
        if (frame === undefined) {
          return Effect.sync(() => backend.release([item]))
        }
        if (!isActive(frame)) return Effect.fail(ended())
        return Effect.sync(() => void frame.outbox.push(item))
      }),
    onRollback: (undo) =>
      Effect.flatMap(current, (frame) => {
        if (frame === undefined) return Effect.void
        if (!isActive(frame)) return Effect.fail(ended())
        return Effect.sync(() => void frame.undo.push(undo))
      })
  }
}
