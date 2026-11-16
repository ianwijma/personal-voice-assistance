import { type ConversationEvent, type ConversationInput, type RouteResult, type RouteTarget, sameUtterance, type SttEvent } from "@pva/core"
import { Deferred, Effect } from "effect"
import type { SendOutcome } from "./SessionConversation.ts"

/**
 * The session dispatcher (docs/ASSISTANTS.md §1.2, §3.3): one per voice session, between the route gate's output and
 * one unchanged `Conversation` per assistant, each made the first time something is routed to it. It
 *
 * - forwards each utterance's events to the conversation of the assistant the route gate (or, for a `decide` target,
 *   the decider) chose for it;
 * - owns barge-in across conversations: an utterance's `SpeechStarted` goes at once to the *barge-in owner* (the
 *   conversation whose committed turn is running), so its reply stops before any words are recognised;
 * - hands an utterance over when its target changes (the owner got its `SpeechStarted` but the words are for
 *   another assistant; a speculative turn started for A on the eager transcript, then the final carries B's phrase):
 *   the conversation that has the utterance open gets an empty `EndOfTurn` (closes the utterance, discards its
 *   speculative turn, starts nothing: docs/ARCHITECTURE.md, `SttEvent`) and an `Interrupt` if a committed turn of
 *   it runs or is about to start; the new target gets `SpeechStarted` and the event;
 * - drops `EagerEndOfTurn` and `TurnResumed` before an assistant whose "start replying early" is off;
 * - sends typed text to the conversation it names and Stop to the ones that are active.
 *
 * It does not play audio: that two replies never sound at once is the output lease's guarantee (`OutputLease.ts`);
 * the dispatcher only avoids most supersessions by interrupting first.
 *
 * Choices where §3.3 left room (see also the WP-4a notes in the report):
 * - With no barge-in owner, an utterance's `SpeechStarted` goes to its base target when that is an assistant
 *   (default, follow-up, armed, phrase), so it is not delayed; with a `decide` base it waits for the decision
 *   (then `SpeechStarted` is replayed in front of the decided event).
 * - The barge-in owner is the conversation with the most recently started committed turn that has not ended, else
 *   one that was just handed a committing input (a non-empty final, typed text) whose turn has not been reported
 *   yet (conversation events arrive after the input is queued; without this an utterance started in that gap
 *   would not interrupt the reply about to start).
 * - The target is re-evaluated at every text event (`Interim`, `EagerEndOfTurn`, `EndOfTurn`), as the route gate
 *   re-matches phrases per event. Blank texts never move an utterance. A `decide` target is resolved only at a
 *   non-blank eager or final transcript (interims keep where the utterance is), and the decision is reused at the
 *   final when the text is the same utterance (`sameUtterance`), as §3.6 describes. Events are handled one after
 *   another, so the event being decided, and everything after it, waits for the answer (the recogniser's events
 *   queue meanwhile); a later eager event whose text changed is asked again too.
 * - Stop interrupts every conversation that is active (a committed turn running or about to start, a speculative
 *   turn, or the open utterance), and the rest of the stopped utterance is never handed over.
 * - Typed text, and a non-empty final, interrupt a committed turn of ANOTHER conversation (inside one conversation
 *   typed text always interrupts what runs, and a final interrupts a committed turn with barge-in on), except one the
 *   owner is speaking to right now (an `Interrupt` there would cancel that utterance). Without this a reply started
 *   by typed text during an utterance would only give way when the other reply starts playing (the lease).
 */

/** What the dispatcher needs of one assistant's conversation. */
export interface DispatchTarget {
  /**
   * Speech events and the dispatcher's own `Interrupt`s, in order (never refused). For a `SessionConversation`: an
   * inbox queue its voice loop reads instead of transcribing itself (`SessionConversationOptions.speech`).
   */
  readonly push: (input: ConversationInput) => void
  /** Typed text, `Say` and Stop through the conversation's admission (`SessionConversation.send`). */
  readonly send: (input: ConversationInput) => SendOutcome
}

export interface DispatchHooks {
  /** Must be called with every `ConversationEvent` of the conversation made (the dispatcher tracks its turns). */
  readonly onEvent: (event: ConversationEvent) => void
}

/** Asking who a `decide` utterance is for: TypeSafe (§3.6, WP-14: `routing.ts` `makeTypesafeDecide`). */
export interface DecideRequest {
  /** The eager or final transcript (phrase-free: a `decide` target means no phrase matched). Never blank. */
  readonly text: string
  /** Who answers when nobody is chosen (`null`: nobody; already `null` when that assistant is off). */
  readonly fallback: string | null
  /** `EndOfTurn` (true) or `EagerEndOfTurn` (false). */
  readonly final: boolean
}

/** What a routing call came to, for the trace (protocol 7 `TraceRoute` `by: "typesafe"`, marks `routeSent`/`routeReceived`). */
export interface RouteDecision {
  readonly outcome: "chosen" | "none-fits" | "timeout" | "error"
  /** The chosen (or, for none fits, the best) option's probability; absent with one candidate. */
  readonly probability?: number
  /** The companion Noul: does any assistant fit (0..1). */
  readonly fits?: number
  /** From sending to the answer (or to the give-up time). */
  readonly ms: number
  /** Trace clock (`TurnTrace.now`): the request left. */
  readonly sentAt: number
  /** Trace clock: the answer (or the error) arrived; absent after a timeout. */
  readonly receivedAt?: number
}

export interface DecideResult {
  /** `null`: nobody answers; the utterance is dropped. */
  readonly assistant: string | null
  /** The fallback answered (nobody was chosen, or the decider gave up or failed). */
  readonly fallback: boolean
  /** A routing call was made (absent: answered without one, e.g. `decideByFallback`). */
  readonly decision?: RouteDecision
}

/**
 * The seam for TypeSafe routing (WP-14, `routing.ts` `makeTypesafeDecide`). Without it the fallback answers every
 * `decide` utterance (and nobody when it is `null`). The dispatcher holds the event until the effect completes, so a
 * real decider must bound itself (the give-up time) and must not fail.
 */
export type DecideRoute = (request: DecideRequest) => Effect.Effect<DecideResult>

export const decideByFallback: DecideRoute = (request) => Effect.succeed({ assistant: request.fallback, fallback: true })

/** How the last utterance or typed message reached an assistant (for traces, §3.7). */
export type DispatchRoute =
  | Extract<RouteTarget, { readonly assistant: string; readonly by: "phrase" | "armed" | "follow-up" | "default" }>
  | { readonly by: "decide"; readonly assistant: string; readonly fallback: boolean; readonly decision?: RouteDecision }
  | { readonly by: "typed"; readonly assistant: string }
  /** It got the utterance's `SpeechStarted` as the barge-in owner, and no text has decided otherwise yet. */
  | { readonly by: "barge-in"; readonly assistant: string }

export interface SessionDispatcherOptions<C extends DispatchTarget> {
  /** Make `assistant`'s conversation (first use). Called at most once per assistant. */
  readonly make: (assistant: string, hooks: DispatchHooks) => Effect.Effect<C>
  /** "Start replying before I finish speaking", read at each eager event. Default: on for everyone. */
  readonly replyEarly?: (assistant: string) => boolean
  /** Default `decideByFallback`. */
  readonly decide?: DecideRoute
  /**
   * Read each time a `decide` answer is applied (after the wait, and when an eager answer is reused at the final):
   * the assistants it may go to now and the fallback now, since the device's settings can change while TypeSafe is
   * asked. A chosen assistant no longer among `candidates`, or a fallback that is no longer the fallback, gives way to
   * the fallback now (`null`: nobody). Default: every answer stands.
   */
  readonly decideNow?: () => { readonly candidates: ReadonlyArray<string>; readonly fallback: string | null }
}

export interface SessionDispatcher<C extends DispatchTarget> {
  /** One route gate result (`RouteGate.filter`), in the recogniser's order. Never fails. */
  readonly dispatch: (result: RouteResult) => Effect.Effect<void>
  /** Typed text or `Say` for `assistant`'s conversation (made if needed). */
  readonly send: (
    assistant: string,
    input: Extract<ConversationInput, { readonly _tag: "TextInput" | "Say" }>
  ) => Effect.Effect<SendOutcome>
  /**
   * Stop (`Interrupt`): `assistant`'s conversation, or, without one, every active conversation (a committed turn
   * running or about to start, a speculative turn, the open utterance). The rest of the open utterance is not handed
   * over. `accepted` unless every conversation asked answered otherwise.
   */
  readonly stop: (assistant?: string) => SendOutcome
  readonly get: (assistant: string) => C | undefined
  /** The conversations made so far, by assistant. */
  readonly conversations: () => ReadonlyMap<string, C>
  /** The barge-in owner now (see the module comment). */
  readonly owner: () => string | undefined
  /** The assistant whose conversation has the open utterance (`undefined`: none, or not delivered yet). */
  readonly delivering: () => string | undefined
  /** Which assistant a turn belongs to (turn ids must be unique across the session's conversations). */
  readonly assistantOfTurn: (turnId: number) => string | undefined
  /** How the latest utterance or typed message reached `assistant`. */
  readonly routeOf: (assistant: string) => DispatchRoute | undefined
}

/** The dispatcher's view of one conversation. */
interface Book<C> {
  readonly assistant: string
  target: C | undefined
  /** Committed turns running, with the order they became committed. */
  readonly committed: Map<number, number>
  readonly speculative: Set<number>
  /** A committing input was queued and its turn has not been reported; `speech` ones are ordered with `push`. */
  expecting: { readonly by: "speech" | "typed"; readonly seq: number } | undefined
  /** The latest `seq` an `Interrupt` pushed here already covers (no second one for the same turn). */
  interrupted: number
}

interface Open {
  /** The conversation that has this utterance open (got its `SpeechStarted`). */
  delivered: string | undefined
  /** Stop cancelled it: the rest goes only where it already is. */
  stopped: boolean
  /** The `decide` answer for this utterance's text so far. */
  decision: { readonly text: string; readonly result: DecideResult } | undefined
}

const TURN_MEMORY = 64
const speechStarted: SttEvent = { _tag: "SpeechStarted" }
const emptyEnd: SttEvent = { _tag: "EndOfTurn", text: "" }
const interrupt: ConversationInput = { _tag: "Interrupt" }
const blank = (text: string) => text.trim().length === 0

/** No assistant was decided by this event: the utterance stays where it is. */
const KEEP = Symbol("keep")
type Where = { readonly to: string | null; readonly route?: DispatchRoute } | typeof KEEP

export const makeSessionDispatcher = <C extends DispatchTarget>(
  options: SessionDispatcherOptions<C>
): SessionDispatcher<C> => {
  const replyEarly = options.replyEarly ?? (() => true)
  const decide = options.decide ?? decideByFallback
  /** A `decide` answer checked against the device as it is now (`decideNow`). */
  const stillValid = (result: DecideResult): DecideResult => {
    if (options.decideNow === undefined || result.assistant === null) return result
    const now = options.decideNow()
    const valid = result.fallback ? result.assistant === now.fallback : now.candidates.includes(result.assistant)
    return valid ? result : { ...result, assistant: now.fallback, fallback: true }
  }
  const books = new Map<string, Book<C>>()
  const made = new Map<string, C>()
  const making = new Map<string, Deferred.Deferred<Book<C>>>()
  const routes = new Map<string, DispatchRoute>()
  const turns = new Map<number, string>()
  let seq = 0
  let open: Open | undefined

  const observe = (book: Book<C>) => (event: ConversationEvent) => {
    switch (event._tag) {
      case "TurnStarted":
        turns.delete(event.turnId)
        turns.set(event.turnId, book.assistant)
        if (turns.size > TURN_MEMORY) turns.delete(turns.keys().next().value!)
        if (event.speculative) {
          book.speculative.add(event.turnId)
        } else {
          book.committed.set(event.turnId, ++seq)
          book.expecting = undefined
        }
        return
      case "TurnPromoted":
        book.speculative.delete(event.turnId)
        book.committed.set(event.turnId, ++seq)
        book.expecting = undefined
        return
      case "TurnEnded":
        book.speculative.delete(event.turnId)
        book.committed.delete(event.turnId)
        return
      default:
        return
    }
  }

  const ensure = (assistant: string): Effect.Effect<Book<C>> =>
    Effect.suspend(() => {
      const known = books.get(assistant)
      if (known !== undefined) return Effect.succeed(known)
      const pending = making.get(assistant)
      if (pending !== undefined) return Deferred.await(pending)
      const done = Deferred.makeUnsafe<Book<C>>()
      making.set(assistant, done)
      const book: Book<C> = { assistant, target: undefined, committed: new Map(), speculative: new Set(), expecting: undefined, interrupted: -1 }
      return options.make(assistant, { onEvent: observe(book) }).pipe(
        Effect.map((target) => {
          book.target = target
          books.set(assistant, book)
          made.set(assistant, target)
          return book
        }),
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            making.delete(assistant)
            return exit._tag === "Success" ? Deferred.succeed(done, exit.value) : Deferred.interrupt(done)
          })
        )
      )
    })

  const push = (book: Book<C>, input: ConversationInput) => book.target!.push(input)

  /** Its committed turn runs, or one is about to start. */
  const busy = (book: Book<C>) => book.committed.size > 0 || book.expecting !== undefined
  const lastSeq = (book: Book<C>) => {
    let last = -1
    for (const s of book.committed.values()) last = Math.max(last, s)
    return last
  }
  /**
   * Push an `Interrupt` (in order with the speech events) if a committed turn runs there or is about to start, and no
   * `Interrupt` pushed earlier already covers it. One queued after a final it was handed stops the turn that final
   * starts, so that expectation is settled.
   */
  const interruptIfBusy = (book: Book<C>) => {
    if (!busy(book)) return
    const latest = Math.max(lastSeq(book), book.expecting?.seq ?? -1)
    if (latest > book.interrupted) {
      push(book, interrupt)
      book.interrupted = latest
    }
    if (book.expecting?.by === "speech") book.expecting = undefined
  }

  const owner = (): Book<C> | undefined => {
    let best: Book<C> | undefined
    let bestSeq = -1
    for (const book of books.values()) {
      const s = lastSeq(book)
      if (s > bestSeq) {
        best = book
        bestSeq = s
      }
    }
    if (best !== undefined) return best
    for (const book of books.values()) {
      if (book.expecting !== undefined && book.expecting.seq > bestSeq) {
        best = book
        bestSeq = book.expecting.seq
      }
    }
    return best
  }

  const expect = (book: Book<C>, by: "speech" | "typed") => {
    book.expecting = { by, seq: ++seq }
  }

  const assistantOf = (target: RouteTarget | undefined): string | undefined =>
    target !== undefined && target.by !== "dropped" && target.by !== "decide" ? target.assistant : undefined

  /** Where a text event's target sends the utterance: an assistant, nobody (`null`), or `KEEP`. */
  const resolve = (
    event: Extract<SttEvent, { readonly text: string }>,
    target: RouteTarget | undefined,
    u: Open
  ): Effect.Effect<Where> =>
    Effect.suspend((): Effect.Effect<Where> => {
      if (target === undefined || blank(event.text)) return Effect.succeed(KEEP)
      switch (target.by) {
        case "dropped":
          return Effect.succeed({ to: null })
        case "decide": {
          if (event._tag === "Interim") return Effect.succeed(KEEP)
          const reuse = u.decision !== undefined && sameUtterance(u.decision.text, event.text) ? u.decision.result : undefined
          const answer = reuse !== undefined
            ? Effect.succeed(reuse)
            : decide({ text: event.text, fallback: target.fallback, final: event._tag === "EndOfTurn" }).pipe(
              Effect.tap((result) => Effect.sync(() => (u.decision = { text: event.text, result })))
            )
          return Effect.map(answer, (raw): Where => {
            const result = stillValid(raw)
            return result.assistant === null
              ? { to: null }
              : {
                to: result.assistant,
                route: {
                  by: "decide",
                  assistant: result.assistant,
                  fallback: result.fallback,
                  ...(result.decision !== undefined ? { decision: result.decision } : {})
                }
              }
          })
        }
        default:
          return Effect.succeed({ to: target.assistant, route: target })
      }
    })

  /** Give the utterance to `to` (`null`: nobody): close it where it is, open it there. */
  const handOver = (u: Open, to: string | null, route: DispatchRoute | undefined): Effect.Effect<void> =>
    Effect.gen(function*() {
      const from = u.delivered === undefined ? undefined : books.get(u.delivered)
      if (from !== undefined) {
        push(from, emptyEnd)
        interruptIfBusy(from)
      }
      u.delivered = undefined
      if (to === null) return
      const book = yield* ensure(to)
      // Stopped while its conversation was made: that conversation got no Interrupt, so it gets nothing.
      if (u.stopped) return
      push(book, speechStarted)
      u.delivered = to
      if (route !== undefined) routes.set(to, route)
    })

  /**
   * `Interrupt` (in order with its speech) to every other conversation whose committed turn runs or is about to
   * start, except one that has the open utterance (an `Interrupt` there would cancel what the owner is saying).
   */
  const interruptOthers = (assistant: string) => {
    for (const other of books.values()) {
      if (other.assistant !== assistant && open?.delivered !== other.assistant) interruptIfBusy(other)
    }
  }

  /** `commits`: a non-empty final here may start (or promote) a committed turn. */
  const forward = (assistant: string, event: SttEvent, commits = true) => {
    const book = books.get(assistant)
    if (book === undefined) return
    if ((event._tag === "EagerEndOfTurn" || event._tag === "TurnResumed") && !replyEarly(assistant)) return
    push(book, event)
    if (commits && event._tag === "EndOfTurn" && !blank(event.text)) expect(book, "speech")
  }

  const handle = (event: SttEvent, target: RouteTarget | undefined): Effect.Effect<void> =>
    Effect.gen(function*() {
      const u = open
      if (event._tag === "SpeechStarted") {
        if (u !== undefined) {
          // Repeated inside the utterance: the recogniser's business, passed on.
          if (u.delivered !== undefined) forward(u.delivered, event)
          return
        }
        const next: Open = { delivered: undefined, stopped: false, decision: undefined }
        open = next
        const o = owner()
        const to = o?.assistant ?? assistantOf(target)
        if (to === undefined) return
        const book = yield* ensure(to)
        if (next.stopped) return
        push(book, speechStarted)
        next.delivered = to
        routes.set(to, assistantOf(target) === to ? (target as DispatchRoute) : { by: "barge-in", assistant: to })
        return
      }
      if (u === undefined) {
        // Outside the utterance contract (no `SpeechStarted` first): passed on unchanged to whoever the target names,
        // whose conversation ignores it (docs/ARCHITECTURE.md, review round 6).
        const to = assistantOf(target) ?? (target?.by === "decide" ? target.fallback ?? undefined : undefined)
        if (to !== undefined) forward(to, event)
        return
      }
      if (event._tag !== "TurnResumed" && !u.stopped) {
        const where = yield* resolve(event, target, u)
        // Stop may have come while the decision was awaited: the stopped utterance stays where it is.
        if (where !== KEEP && !u.stopped) {
          if (where.to !== (u.delivered ?? null)) yield* handOver(u, where.to, where.route)
          else if (where.to !== null && where.route !== undefined) routes.set(where.to, where.route)
        }
      }
      // A stopped utterance's final is swallowed by its conversation: it starts nothing.
      if (u.delivered !== undefined) forward(u.delivered, event, !u.stopped)
      if (event._tag === "EndOfTurn" && open === u) {
        open = undefined
        // As a final interrupts a committed turn inside one conversation (barge-in): a reply of another
        // conversation that started during this utterance (typed text) gives way to the one this final starts.
        if (u.delivered !== undefined && !u.stopped && !blank(event.text)) interruptOthers(u.delivered)
      }
    })

  return {
    dispatch: (result) => Effect.forEach(result.events, (event) => handle(event, result.target), { discard: true }),
    send: (assistant, input) =>
      Effect.map(ensure(assistant), (book) => {
        const outcome = book.target!.send(input)
        if (outcome !== "accepted") return outcome
        expect(book, "typed")
        routes.set(assistant, { by: "typed", assistant })
        // Typed text replaces what runs, in the other conversations too.
        interruptOthers(assistant)
        return outcome
      }),
    stop: (assistant) => {
      const u = open
      const active = (book: Book<C>) => busy(book) || book.speculative.size > 0 || u?.delivered === book.assistant
      const chosen = assistant === undefined
        ? [...books.values()].filter(active)
        : [...books.values()].filter((b) => b.assistant === assistant)
      if (u !== undefined && (assistant === undefined || u.delivered === assistant)) u.stopped = true
      const outcomes = chosen.map((book) => book.target!.send(interrupt))
      return outcomes.length === 0 || outcomes.includes("accepted") ? "accepted" : outcomes[0]!
    },
    get: (assistant) => made.get(assistant),
    conversations: () => made,
    owner: () => owner()?.assistant,
    delivering: () => open?.delivered,
    assistantOfTurn: (turnId) => turns.get(turnId),
    routeOf: (assistant) => routes.get(assistant)
  }
}
