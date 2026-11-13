/**
 * The `jev-typesafe` decision-provider module (docs/AGENTS-AND-INTENTS.md §1.6, §3.7):
 * one file and one catalog line.
 */
import { type DecisionError, defineDecider, type ModuleContext, ModuleStartError, Setting } from "@pva/core"
import { Effect, Redacted } from "effect"
import { defaults, isKeyRejected, makeJevClient, pingRequest } from "./JevClient.ts"

const checkUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? undefined : "Must start with https:// or http://"
  } catch {
    return "Must be an address such as https://api.typesafe.ai"
  }
}

type StatusLine = NonNullable<Parameters<ModuleContext<unknown>["setStatus"]>[0]>

const status = (text: string, tone: StatusLine["tone"]): StatusLine => ({ text: text.length > 120 ? `${text.slice(0, 119)}…` : text, tone })

/** The start check may open a fresh TLS connection, so it gets more time than a decision. */
const START_CHECK_MS = 3_000

export interface JevDeciderOptions {
  /** For tests. */
  readonly fetch?: typeof globalThis.fetch
}

export const makeJevDecider = (options: JevDeciderOptions = {}) => {
  return defineDecider({
    id: "jev-typesafe",
    name: "TypeSafe Jev",
    description:
      "TypeSafe's Jev model picks the action you meant, in about a quarter of a second. Only sentences routed to Jev are sent to TypeSafe, which documents no retention period.",
    // Switched on (until the owner chooses) once the key is set: in the environment or saved in the key vault. The
    // module host decides with the resolved settings, so a key entered in the UI counts like one in `.env`.
    enabledByDefault: false,
    enabledWhenSet: "apiKey",
    settings: {
      apiKey: Setting.secret({
        label: "API key",
        env: "TYPESAFE_API_KEY",
        required: true,
        description: "From console.typesafe.ai/keys."
      }),
      model: Setting.text({
        label: "Model",
        env: "TYPESAFE_MODEL",
        default: defaults.model,
        maxLength: 100,
        check: (v) => (v.trim() === "" ? "Must not be empty" : undefined),
        description: "A pinned version: the decision thresholds are tuned for one version, and jev-latest moves."
      }),
      baseUrl: Setting.text({
        label: "Server address",
        env: "TYPESAFE_BASE_URL",
        default: defaults.baseUrl,
        advanced: true,
        check: checkUrl,
        description: "Any server that speaks /v1/systemone (for example Ollama with the open Nimble model; English only, untested)."
      }),
      timeoutMs: Setting.number({
        label: "Time limit",
        env: "TYPESAFE_TIMEOUT_MS",
        default: defaults.timeoutMs,
        integer: true,
        min: 200,
        max: 5_000,
        step: 100,
        unit: "ms",
        advanced: true,
        description: "A slower answer is dropped and the conversational agent answers instead."
      })
    },
    start: ({ setStatus, settings }) =>
      Effect.gen(function*() {
        if (settings.apiKey === undefined || settings.apiKey.trim() === "") {
          return yield* new ModuleStartError({ message: "Add your TypeSafe API key (console.typesafe.ai/keys)." })
        }
        const common = {
          apiKey: Redacted.make(settings.apiKey.trim()),
          baseUrl: settings.baseUrl,
          model: settings.model.trim(),
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
        }
        // One tiny request: checks the key, opens the connection for the first
        // real decision, and measures the round trip from this machine.
        const check = makeJevClient({ ...common, timeoutMs: Math.max(START_CHECK_MS, settings.timeoutMs) })
        const checked = yield* Effect.result(check.decide(pingRequest))
        if (checked._tag === "Failure") {
          const error = checked.failure
          if (isKeyRejected(error)) {
            return yield* new ModuleStartError({ message: "TypeSafe rejected the API key: check it at console.typesafe.ai/keys.", cause: error })
          }
          if (error.reason === "rejected") {
            return yield* new ModuleStartError({ message: `${error.message}. Is the model name "${common.model}" right?`, cause: error })
          }
          // A passing outage must not leave the module in an error state: decisions are tried per turn.
          setStatus(status(`Start check failed (${error.message}); will try again on the next decision`, "warning"))
        } else {
          setStatus(status(`Ready · round trip at start ${check.lastMs() ?? "?"} ms · ${checked.success.model ?? common.model}`, "ok"))
        }

        const client = makeJevClient({ ...common, timeoutMs: settings.timeoutMs })
        const report = (error: DecisionError) =>
          Effect.sync(() =>
            setStatus(
              isKeyRejected(error)
                ? status("TypeSafe rejected the API key: fix it in the settings", "error")
                : status(`Last decision failed: ${error.message}`, "warning")
            )
          )
        return {
          location: "hosted" as const,
          decide: (request) =>
            client.decide(request).pipe(
              Effect.tap(() => Effect.sync(() => setStatus(status(`Last decision ${client.lastMs() ?? "?"} ms`, "ok")))),
              Effect.tapError(report)
            )
        }
      })
  })
}

/** The catalog entry: enabled by default once its key is set (`TYPESAFE_API_KEY` or the vault). */
export const jevTypesafeDecider = makeJevDecider()
