import type { AudioError, LlmError, SttError, TtsError } from "@pva/core"
import { makeTurnTrace, type Trace, TurnTrace } from "@pva/core"
import { Config, Context, Effect, Layer, References, Result, Schema, type Scope } from "effect"

/** A problem the user can fix (missing key, no microphone, ...): printed as one line, no stack trace. */
export class StartupError extends Schema.TaggedError<StartupError>()("StartupError", { message: Schema.String }) {}

/** "DEEPGRAM_API_KEY is not set" rather than a schema dump. */
export const describeConfigError = (error: Config.ConfigError): string => {
  const text = error.message
  const key = /at \["([^"]+)"\]/.exec(text)?.[1]
  if (key === undefined) return text
  if (/Expected string/.test(text) || /Missing/i.test(text)) return `${key} is not set`
  const reason = text.split("\n")[0]!.replace(/^SchemaError\(/, "")
  return `${key} has an invalid value (${reason})`
}

/** A provider that cannot start (a missing local model file, ...); its message says how to fix it. */
export type ProviderStartError = SttError | TtsError | LlmError | AudioError

/** One line for a failed startup stage: a config problem, or the provider's own message. */
export const describeStartFailure = (error: Config.ConfigError | ProviderStartError): string =>
  error instanceof Config.ConfigError ? describeConfigError(error) : error.message

/**
 * Build the provider layers one after another and report every missing or
 * invalid setting (or provider that failed to start, e.g. a missing local
 * model) at once, naming the stage it belongs to. Built layers live
 * in the current scope (sockets are closed and processes killed when it ends).
 */
export const buildProviders = Effect.fnUntraced(function*(
  stages: ReadonlyArray<{ readonly stage: string; readonly layer: Layer.Layer<any, Config.ConfigError | ProviderStartError> }>
): Effect.fn.Return<Context.Context<any>, StartupError, Scope.Scope> {
  let context = Context.empty() as Context.Context<any>
  const problems: Array<string> = []
  for (const { layer, stage } of stages) {
    const built = yield* Effect.result(Layer.build(layer))
    if (Result.isSuccess(built)) context = Context.merge(context, built.success)
    else problems.push(`  ${stage}: ${describeStartFailure(built.failure)}`)
  }
  if (problems.length > 0) {
    return yield* new StartupError({
      message: `Cannot start (settings go in the environment or in .env; see .env.example):\n${problems.join("\n")}`
    })
  }
  return context
})

/**
 * A `TurnTrace` that keeps the traces but, instead of logging its own line,
 * calls `onFinish` once a turn has finished (after its history was committed).
 * Modes use it to print the latency line together with the transcript, or to
 * know when a benchmark reply is over.
 */
export const observedTurnTrace = (onFinish: (trace: Trace) => Effect.Effect<void>): TurnTrace["Service"] => {
  const base = makeTurnTrace({ keep: 10_000 })
  return TurnTrace.of({
    ...base,
    finish: (trace, outcome) =>
      base.finish(trace, outcome).pipe(
        Effect.provideService(References.MinimumLogLevel, "Warn"),
        Effect.andThen(Effect.suspend(() => onFinish(trace)))
      )
  })
}

export const observedTurnTraceLayer = (onFinish: (trace: Trace) => Effect.Effect<void>) =>
  Layer.sync(TurnTrace, () => observedTurnTrace(onFinish))
