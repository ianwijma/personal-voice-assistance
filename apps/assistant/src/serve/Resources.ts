import { Llm, LlmError } from "@pva/core"
import { DEFAULT_BASE_URL } from "@pva/llm-anthropic"
import type { AssistantLlm, LlmAccountId, ResourceInfo } from "@pva/protocol"
import { Cause, type Config, ConfigProvider, Context, Deferred, Effect, Exit, FiberSet, Layer, Schema, Scope, Stream } from "effect"
import { hasLlmAccountLayer, llmAccountLayers } from "../providers.ts"
import { describeStartFailure } from "../startup.ts"

/**
 * The resource pool of serve mode (docs/ASSISTANTS.md §3.2, WP-9): shared resources keyed by their configuration,
 * built for the assistants in use and released after a grace period once nobody uses them. Two assistants with the
 * same configuration share one instance. A changed configuration builds the new instance first; each assistant
 * switches to it once it is ready, at its next turn start (`llmFor` is read by the turn's setup), and the old one
 * stays for the turns still running on it. One build failing is a problem of that resource only.
 *
 * WP-9 scope: language models only (the accounts `offline`, `anthropic` and the offline stand-in of
 * `claude-subscription`; `openrouter` and `home-model` report a problem until WP-13b). Recognisers and voices are
 * still the engine's one shared build (WP-10, WP-11).
 */

/** What an instance of a language model is built from: the assistant's `llm` fields the account reads, and its address. */
export interface LlmSpec {
  readonly account: LlmAccountId
  readonly model: string
  readonly effort: AssistantLlm["effort"]
  readonly thinking: AssistantLlm["thinking"]
  readonly maxTokens: number
  readonly giveUpMs: number
  readonly warmUp: boolean
  /** The account's address (`anthropic`: ANTHROPIC_BASE_URL). Part of the key. */
  readonly address?: string
  /**
   * A stamp of the account's key (a hash, never the key; "" when none is set): a new key makes a new instance. Part
   * of the instance's identity, not of the key shown in the status.
   */
  readonly credential?: string
}

/** The shared account settings an `LlmSpec` takes besides the assistant's own fields. */
export interface LlmAccounts {
  readonly anthropic?: { readonly address?: string | undefined; readonly credential?: string | undefined }
}

/**
 * An assistant's `llm` as the pool keys it. Only what the account's adapter reads counts: the offline stand-ins
 * (`offline`, and `claude-subscription`'s, whose agent is the module's) ignore the model fields, so every assistant
 * on them shares one instance.
 */
export const llmSpecOf = (llm: AssistantLlm, accounts: LlmAccounts = {}): LlmSpec => {
  if (llm.account !== "anthropic") {
    return { account: llm.account, model: llm.account === "offline" || llm.account === "claude-subscription" ? "" : llm.model, effort: "low", thinking: "off", maxTokens: 1024, giveUpMs: 5000, warmUp: false }
  }
  const address = accounts.anthropic?.address
  const credential = accounts.anthropic?.credential
  return {
    account: "anthropic",
    model: llm.model,
    effort: llm.effort,
    thinking: llm.thinking,
    maxTokens: llm.maxTokens,
    giveUpMs: llm.giveUpMs,
    warmUp: llm.warmUp,
    address: address === undefined || address === "" ? DEFAULT_BASE_URL : address,
    ...(credential !== undefined ? { credential } : {})
  }
}

/** An address without what may be secret in it (user info, query), for keys and labels. */
const shownAddress = (address: string): string => {
  try {
    const url = new URL(address)
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`
  } catch {
    return "(invalid address)"
  }
}

/** `LlmKey` (docs/ASSISTANTS.md §3.2): account + model + effort + thinking + maxTokens + giveUpMs + warmUp (+ address). */
export const llmKeyOf = (spec: LlmSpec): string =>
  spec.account === "anthropic"
    ? [
      spec.account,
      spec.model,
      spec.effort,
      `thinking-${spec.thinking}`,
      `${spec.maxTokens}tok`,
      `${spec.giveUpMs}ms`,
      spec.warmUp ? "warm" : "cold",
      shownAddress(spec.address ?? DEFAULT_BASE_URL)
    ].join("|")
    : spec.model === ""
    ? spec.account
    : `${spec.account}|${spec.model}`

/** The instance's identity: its key plus what is not shown (the full address, the key stamp). */
const identityOf = (spec: LlmSpec): string => `${llmKeyOf(spec)}\u0000${spec.address ?? ""}\u0000${spec.credential ?? ""}`

const accountLabels: Readonly<Record<LlmAccountId, string>> = {
  offline: "Offline stand-in",
  anthropic: "Claude API",
  "claude-subscription": "Claude subscription (offline stand-in while the agent is not running)",
  openrouter: "OpenRouter",
  "home-model": "Home model"
}

export const llmLabelOf = (spec: LlmSpec): string =>
  spec.account === "anthropic" ? `Claude API ${spec.model} (${spec.effort} effort, thinking ${spec.thinking}, ${spec.maxTokens} tokens)` : accountLabels[spec.account] + (spec.model === "" ? "" : ` ${spec.model}`)

/**
 * The settings an account's adapter reads, from the spec (a `ConfigProvider` over the shared settings: the adapters
 * stay unchanged). The key itself is not here: it comes from the shared settings (vault or environment).
 */
export const llmConfigOf = (spec: LlmSpec): Record<string, string> =>
  spec.account === "anthropic"
    ? {
      ANTHROPIC_MODEL: spec.model,
      ANTHROPIC_EFFORT: spec.effort,
      ANTHROPIC_THINKING: spec.thinking === "adaptive" ? "adaptive" : "disabled",
      ANTHROPIC_MAX_TOKENS: String(spec.maxTokens),
      ANTHROPIC_TIMEOUT_MS: String(spec.giveUpMs),
      ANTHROPIC_WARM_UP: spec.warmUp ? "true" : "false",
      ...(spec.address !== undefined ? { ANTHROPIC_BASE_URL: spec.address } : {})
    }
    : {}

export class ResourceBuildError extends Schema.TaggedError<ResourceBuildError>()("ResourceBuildError", { message: Schema.String }) {}

/** Builds one language-model instance in the scope it is given (closed when the pool releases the instance). */
export type LlmBuilder = (spec: LlmSpec) => Effect.Effect<Llm["Service"], ResourceBuildError, Scope.Scope>

/** The accounts' layers of `providers.ts`, each over `configProvider()` with the spec's own values on top. */
export const defaultLlmBuilder = (configProvider: () => ConfigProvider.ConfigProvider): LlmBuilder => (spec) =>
  Effect.gen(function*() {
    if (!hasLlmAccountLayer(spec.account)) {
      return yield* new ResourceBuildError({ message: `The ${accountLabels[spec.account]} account is not available yet.` })
    }
    const provider = ConfigProvider.orElse(ConfigProvider.fromEnvRecord(llmConfigOf(spec)), configProvider())
    const context = yield* Layer.build(llmAccountLayers[spec.account] as Layer.Layer<Llm, Config.ConfigError>).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.mapError((e) => new ResourceBuildError({ message: describeStartFailure(e) }))
    )
    return Context.get(context, Llm)
  })

/** How long an instance nobody uses any more is kept (turns still running on it finish). docs/ASSISTANTS.md §1.2. */
export const RESOURCE_GRACE_MS = 10_000

export interface ResourcePoolOptions {
  readonly buildLlm: LlmBuilder
  /** Default `RESOURCE_GRACE_MS`. */
  readonly graceMs?: number
  /** Something in `status()` changed (a build settled, an instance was released, who uses what). */
  readonly onChange?: () => void
  /** Reword a build problem for the owner (a key that is locked away). */
  readonly explainProblem?: (message: string) => string
  readonly log?: (line: string) => void
}

export interface ReconcileOptions {
  /** Build again what failed (a vault unlock, the owner's reload). Default false: a failed instance stays failed. */
  readonly retryFailed?: boolean
  /**
   * Build a fresh instance of every resource in use (the owner's full reload). Each assistant switches when its new
   * instance is ready; the old one is released after the grace period. Implies `retryFailed`.
   */
  readonly rebuild?: boolean
}

export interface ResourcePool {
  /**
   * The assistants in use now (switched on and on at least one effective list), with the spec of each one's
   * language model: builds what is missing, rebinds what is ready, and releases what nobody uses after the grace
   * period. Completes when every build it started has settled (ready or failed).
   */
  readonly reconcile: (wanted: ReadonlyMap<string, LlmSpec>, options?: ReconcileOptions) => Effect.Effect<void>
  /** The ready instance with this key (`llmKeyOf`), if any. */
  readonly llm: (key: string) => Llm["Service"] | undefined
  /**
   * The language model `assistant`'s next turn uses (read once at its start, so a turn never changes model): the
   * ready instance for its spec, else the instance it used before while the new one is built, else the one being
   * built (its turn waits for it). A failed instance answers every request with its problem (an `LlmError`).
   * `undefined`: the assistant is not in use. The same object for as long as the binding lasts.
   */
  readonly llmFor: (assistant: string) => Llm["Service"] | undefined
  /** The key of the instance `assistant` uses now. */
  readonly keyFor: (assistant: string) => string | undefined
  readonly status: () => ReadonlyArray<ResourceInfo>
}

interface Entry {
  readonly spec: LlmSpec
  readonly key: string
  readonly identity: string
  state: "starting" | "ready" | "failed"
  problem?: string
  inner?: Llm["Service"]
  readonly scope: Scope.Closeable
  readonly settled: Deferred.Deferred<void>
  /**
   * The wrapper every user gets: waits for the build, answers with the problem, counts what runs on it (each turn,
   * held from its start to its end by `holdDuring`, and each stream, the wait for the build included).
   */
  readonly service: Llm["Service"]
  /** Turns and streams running on this instance: it is not closed while any runs. */
  inFlight: number
  /** Released (scheduled, or done): no longer offered. */
  retiring: boolean
  releaseTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

export const makeResourcePool = (options: ResourcePoolOptions): Effect.Effect<ResourcePool, never, Scope.Scope> =>
  Effect.gen(function*() {
    const graceMs = options.graceMs ?? RESOURCE_GRACE_MS
    const runFork = yield* FiberSet.makeRuntime<never, void, never>()
    /** The newest instance per identity (what new bindings get). */
    const current = new Map<string, Entry>()
    /** Every instance not closed yet (the newest and those still kept for a running turn). */
    const alive = new Set<Entry>()
    /** The instance each assistant in use is bound to. */
    const bound = new Map<string, Entry>()
    /** The assistants in use and the identity each one wants. */
    let wanted = new Map<string, LlmSpec>()
    let closing = false

    /** The status last announced: `onChange` fires only when what `status()` returns is different. */
    let announced = "[]"
    const changed = () => {
      const now = JSON.stringify(statusNow())
      if (now === announced) return
      announced = now
      try {
        options.onChange?.()
      } catch {
        // a throwing listener changes nothing here
      }
    }

    const close = (entry: Entry) => {
      if (entry.closed) return
      entry.closed = true
      alive.delete(entry)
      if (current.get(entry.identity) === entry) current.delete(entry.identity)
      runFork(Scope.close(entry.scope, Exit.void))
      options.log?.(`Language model released: ${entry.key}`)
    }

    /** Closes `entry` once it is retiring and no turn or stream runs on it any more. */
    const closeWhenIdle = (entry: Entry) => {
      if (entry.retiring && entry.inFlight === 0 && entry.releaseTimer === undefined) {
        close(entry)
        changed()
      }
    }

    const makeEntry = (spec: LlmSpec): Entry => {
      const scope = Effect.runSync(Scope.make())
      const settled = Deferred.makeUnsafe<void>()
      /** `stream` counted from its start to its end (completion, failure, interruption). */
      const holding = <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
        Stream.suspend(() => {
          entry.inFlight++
          return stream.pipe(Stream.ensuring(Effect.sync(() => {
            entry.inFlight--
            closeWhenIdle(entry)
          })))
        })
      const entry: Entry = {
        spec,
        key: llmKeyOf(spec),
        identity: identityOf(spec),
        state: "starting",
        scope,
        settled,
        inFlight: 0,
        retiring: false,
        closed: false,
        service: Llm.of({
          // A turn (the model agent's whole tool loop) holds its instance from its start to its end: one whose
          // assistant is rebound or switched off meanwhile keeps it, past the grace period too, for every model round
          // and the tools between them.
          holdDuring: holding,
          // Counted from the start, the wait for the build included: a turn waiting for its instance keeps it alive when
          // the assistant is rebound or switched off meanwhile (it finishes with the instance it started with).
          stream: (request) =>
            holding(
              Stream.unwrap(Effect.map(Deferred.await(settled), () => {
                const inner = entry.inner
                if (inner === undefined) {
                  return Stream.fail(new LlmError({ message: entry.problem ?? "The language model could not start." }))
                }
                // Released before this stream started (nothing kept it): its instance is shut down.
                if (entry.closed) {
                  return Stream.fail(new LlmError({ message: "The language model was released before the turn started." }))
                }
                return Stream.suspend(() => inner.stream(request))
              }))
            )
        })
      }
      return entry
    }

    /** Who uses `entry`: the assistants bound to it, and those that want its identity while it is the newest. */
    const usersOf = (entry: Entry): Array<string> => {
      const users = new Set<string>()
      for (const [assistant, e] of bound) if (e === entry) users.add(assistant)
      if (current.get(entry.identity) === entry) {
        for (const [assistant, spec] of wanted) if (identityOf(spec) === entry.identity) users.add(assistant)
      }
      return [...users]
    }

    /** Bind every assistant to the best instance for it; schedule the release of what nobody uses. */
    const rebind = () => {
      for (const assistant of [...bound.keys()]) if (!wanted.has(assistant)) bound.delete(assistant)
      for (const [assistant, spec] of wanted) {
        const target = current.get(identityOf(spec))
        if (target === undefined) continue
        const before = bound.get(assistant)
        // Building: keep what the assistant used before (its turns keep answering) until the new one has settled.
        if (target.state === "starting" && before !== undefined && before !== target && !before.closed) continue
        bound.set(assistant, target)
      }
      for (const entry of alive) {
        const used = usersOf(entry).length > 0
        if (used) {
          if (entry.retiring) {
            entry.retiring = false
            if (entry.releaseTimer !== undefined) clearTimeout(entry.releaseTimer)
            delete entry.releaseTimer
          }
        } else if (!entry.retiring) {
          entry.retiring = true
          // A failed or never-used instance holds nothing a turn needs: released at once; a working one after the grace.
          const wait = entry.state === "ready" ? graceMs : 0
          if (wait === 0) closeWhenIdle(entry)
          else {
            entry.releaseTimer = setTimeout(() => {
              delete entry.releaseTimer
              if (current.get(entry.identity) === entry && usersOf(entry).length === 0) current.delete(entry.identity)
              closeWhenIdle(entry)
            }, wait)
            entry.releaseTimer.unref?.()
          }
        }
      }
    }

    const start = (spec: LlmSpec): Entry => {
      const entry = makeEntry(spec)
      current.set(entry.identity, entry)
      alive.add(entry)
      options.log?.(`Language model starting: ${entry.key}`)
      runFork(
        Effect.suspend(() => options.buildLlm(spec)).pipe(
          Effect.provideService(Scope.Scope, entry.scope),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit)) {
                entry.inner = exit.value
                entry.state = "ready"
                options.log?.(`Language model ready: ${entry.key}`)
              } else {
                const failure = Cause.squash(exit.cause)
                entry.state = "failed"
                entry.problem = failure instanceof ResourceBuildError || failure instanceof Error ? failure.message : String(failure)
                options.log?.(`Language model failed: ${entry.key}: ${entry.problem}`)
              }
            })
          ),
          Effect.ensuring(Effect.suspend(() =>
            Deferred.succeed(entry.settled, undefined).pipe(
              Effect.andThen(Effect.sync(() => {
                if (closing) return
                rebind()
                changed()
              }))
            )
          ))
        )
      )
      return entry
    }

    const awaitAll = (entries: ReadonlyArray<Entry>) => Effect.forEach(entries, (e) => Deferred.await(e.settled), { discard: true })

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closing = true
        const all = [...alive]
        for (const entry of all) {
          if (entry.releaseTimer !== undefined) clearTimeout(entry.releaseTimer)
          entry.closed = true
        }
        alive.clear()
        current.clear()
        bound.clear()
        return Effect.forEach(all, (e) => Scope.close(e.scope, Exit.void), { discard: true })
      })
    )

    const info = (entry: Entry): ResourceInfo => {
      const usedBy = usersOf(entry)
      const problem = entry.problem === undefined ? undefined : options.explainProblem?.(entry.problem) ?? entry.problem
      return {
        kind: "llm",
        key: entry.key,
        label: llmLabelOf(entry.spec),
        location: entry.spec.account === "offline" || entry.spec.account === "claude-subscription" ? "local" : "hosted",
        usedBy,
        state: entry.state === "ready" && usedBy.length === 0 ? "unused" : entry.state,
        ...(problem !== undefined ? { problem } : {})
      }
    }

    const statusNow = (): Array<ResourceInfo> => [...alive].map(info)

    return {
      reconcile: (next, reconcileOptions = {}) =>
        Effect.suspend(() => {
          if (closing) return Effect.void
          wanted = new Map(next)
          const started: Array<Entry> = []
          const seen = new Set<string>()
          for (const spec of wanted.values()) {
            const identity = identityOf(spec)
            if (seen.has(identity)) continue
            seen.add(identity)
            const existing = current.get(identity)
            const again = reconcileOptions.rebuild === true || (reconcileOptions.retryFailed === true && existing?.state === "failed")
            if (existing === undefined || existing.closed || again) started.push(start(spec))
          }
          rebind()
          changed()
          return awaitAll(started)
        }),
      llm: (key) => {
        for (const entry of current.values()) if (entry.key === key && entry.state === "ready") return entry.service
        return undefined
      },
      llmFor: (assistant) => bound.get(assistant)?.service,
      keyFor: (assistant) => bound.get(assistant)?.key,
      status: statusNow
    } satisfies ResourcePool
  })
