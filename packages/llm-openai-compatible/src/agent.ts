/**
 * The `openrouter` and `home-model` agents (docs/AGENTS-AND-INTENTS.md §1.6–1.7):
 * model agents over `OpenAiCompatibleLlm`, one catalog line each.
 *
 * Start resolves the profile and address, checks reachability with
 * `GET /models` (2 s), so a wrong address or key is a start error on the card
 * rather than a failed spoken turn, keeps the list for the model picker, and
 * for a home server sends one tiny request in the background so the model is
 * loaded before the first turn (a cold local model load takes seconds).
 */
import { type AgentImplementation, defineAgent, makeModelAgent, ModuleStartError, Setting, type SettingsSpec } from "@pva/core"
import { Effect, Redacted, Stream } from "effect"
import { type ModelListError, listModels } from "./models.ts"
import { make } from "./OpenAiCompatibleLlm.ts"
import { type ModelInfo, type ProfileId, profiles, type ReasoningEffort, resolveBaseUrl } from "./profiles.ts"

export interface OpenAiCompatibleAgentOptions {
  /** Module id, named by routing rules ("openrouter", "home-model"). */
  readonly id: string
  readonly name: string
  readonly description?: string
  /** A fixed server (OpenRouter); absent: a `server` setting chooses the profile. */
  readonly fixedProfile?: ProfileId
  /** Prefix of the environment variables (`OPENROUTER_`, `HOME_MODEL_`). */
  readonly envPrefix: string
  /** Empty: the first model the server lists. */
  readonly defaultModel?: string
  readonly enabledByDefault?: boolean
  /** For tests. */
  readonly fetch?: typeof globalThis.fetch
}

const reasoningOptions = [
  { value: "default", label: "Server default" },
  { value: "none", label: "Off (fastest first word)" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
] as const

const serverOptions = [
  { value: "ollama", label: "Ollama" },
  { value: "llamacpp", label: "llama.cpp (llama-server)" },
  { value: "lmstudio", label: "LM Studio" },
  { value: "vllm", label: "vLLM" },
  { value: "generic", label: "Other OpenAI-compatible server" }
] as const

const checkUrl = (value: string): string | undefined => {
  if (value.trim() === "") return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === "http:" || url.protocol === "https:" ? undefined : "Must start with http:// or https://"
  } catch {
    return "Must be an address such as http://192.168.1.20:11434/v1"
  }
}

const checkTemperature = (value: string): string | undefined => {
  if (value.trim() === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 2 ? undefined : "A number from 0 to 2, or empty for the server's default"
}

/**
 * The settings both agents share, in form order. The model is a `text` field
 * for now: `SettingExtra.combo` (the design's model picker) cannot be put in a
 * module's settings until `Setting` is widened to the v2 field types (build
 * plan piece G). The list is already offered through `settingOptions().model`,
 * so switching the field to `combo` is a one-line change here.
 */
const sharedSettings = (p: string, keyRequired: boolean, defaultModel: string, keyHelp: string) => ({
  apiKey: Setting.secret({ label: "API key", env: `${p}API_KEY`, required: keyRequired, description: keyHelp }),
  model: Setting.text({
    label: "Model",
    env: `${p}MODEL`,
    default: defaultModel,
    maxLength: 200,
    placeholder: defaultModel === "" ? "First model the server lists" : defaultModel,
    description: "A model name from the server's list."
  }),
  systemPrompt: Setting.text({
    label: "System prompt for this agent",
    multiline: true,
    maxLength: 4_000,
    description: "Empty: the global prompt (Agents → All agents)."
  }),
  maxTokens: Setting.number({
    label: "Longest reply",
    env: `${p}MAX_TOKENS`,
    default: 512,
    integer: true,
    min: 16,
    max: 8_192,
    unit: "tokens",
    advanced: true
  }),
  temperature: Setting.text({
    label: "Temperature",
    env: `${p}TEMPERATURE`,
    default: "",
    maxLength: 10,
    placeholder: "Server default",
    check: checkTemperature,
    advanced: true
  }),
  reasoningEffort: Setting.choice({
    label: "Thinking",
    env: `${p}REASONING_EFFORT`,
    options: reasoningOptions,
    default: "none",
    advanced: true,
    description: "Thinking delays the first word. Sent only where the server supports it (OpenRouter models that list it; Ollama)."
  }),
  timeoutMs: Setting.number({
    label: "Time limit",
    env: `${p}TIMEOUT_MS`,
    default: 5_000,
    integer: true,
    min: 500,
    max: 60_000,
    step: 500,
    unit: "ms",
    advanced: true,
    description: "No answer (or a pause in the answer) this long fails the turn, and another agent answers."
  })
})

const openRouterSettings = (p: string, defaultModel: string) => {
  const { apiKey, model, systemPrompt, ...advanced } = sharedSettings(p, true, defaultModel, "From openrouter.ai/keys.")
  return {
    apiKey,
    model,
    systemPrompt,
    sortByLatency: Setting.boolean({
      label: "Prefer the fastest provider",
      env: `${p}SORT_BY_LATENCY`,
      default: true,
      description: "Ask OpenRouter to route to the provider with the lowest latency for this model."
    }),
    ...advanced,
    baseUrl: Setting.text({ label: "Server address", env: `${p}BASE_URL`, default: "", placeholder: "https://openrouter.ai/api/v1", check: checkUrl, advanced: true })
  }
}

const homeSettings = (p: string, defaultModel: string) => {
  const { apiKey, model, systemPrompt, reasoningEffort: _r, ...advanced } = sharedSettings(
    p,
    false,
    defaultModel,
    "Only if the server was started with a key (llama.cpp --api-key, vLLM --api-key)."
  )
  return {
    server: Setting.choice({ label: "Server", env: `${p}SERVER`, options: serverOptions, default: "ollama" }),
    baseUrl: Setting.text({
      label: "Server address",
      env: `${p}BASE_URL`,
      default: "",
      placeholder: "http://192.168.1.20:11434/v1",
      check: checkUrl,
      description: "Empty: this machine on the server's usual port. http://host:port is enough; /v1 is added."
    }),
    model,
    apiKey,
    systemPrompt,
    ...advanced,
    reasoningEffort: Setting.choice({
      label: "Thinking",
      env: `${p}REASONING_EFFORT`,
      options: reasoningOptions,
      // Ollama may refuse a thinking setting for a model that cannot think, so the default sends none.
      default: "default",
      advanced: true,
      description: "Ollama only. Off makes thinking models (gpt-oss, qwen3) answer sooner; some models refuse the setting."
    }),
    warmUp: Setting.boolean({
      label: "Load the model at start",
      env: `${p}WARM_UP`,
      default: true,
      advanced: true,
      description: "Sends one tiny request when the agent starts, so the first answer does not wait for the model to load."
    })
  }
}

/** What `start` reads, whichever variant declared it. */
interface RawSettings {
  readonly server?: ProfileId
  readonly baseUrl: string
  readonly apiKey: string | undefined
  readonly model: string
  readonly systemPrompt: string
  readonly sortByLatency?: boolean
  readonly maxTokens: number
  readonly temperature: string
  readonly reasoningEffort: "default" | ReasoningEffort
  readonly timeoutMs: number
  readonly warmUp?: boolean
}

const startError = (error: ModelListError, hint: string) =>
  new ModuleStartError({
    message: error.reason === "unauthorized" ? `${error.message}. Check the API key.` : `${error.message}. ${hint}`,
    cause: error
  })

/** An agent over one OpenAI-compatible endpoint. Another endpoint is one more call of this in the catalog. */
export const openAiCompatibleAgent = (options: OpenAiCompatibleAgentOptions) => {
  const fixed = options.fixedProfile
  const settings: SettingsSpec = fixed !== undefined
    ? openRouterSettings(options.envPrefix, options.defaultModel ?? "")
    : homeSettings(options.envPrefix, options.defaultModel ?? "")
  return defineAgent({
    id: options.id,
    name: options.name,
    description: options.description ??
      (fixed !== undefined ? `${profiles[fixed].label} with your API key.` : "A language model server on your network (Ollama, llama.cpp, LM Studio, vLLM)."),
    kind: "model",
    enabledByDefault: options.enabledByDefault ?? false,
    settings,
    start: ({ setStatus, settings: s }) =>
      Effect.gen(function*() {
        const raw = s as unknown as RawSettings
        const profile = profiles[fixed ?? raw.server ?? "generic"]
        const baseUrl = resolveBaseUrl(profile, raw.baseUrl)
        if (baseUrl === undefined) {
          return yield* new ModuleStartError({
            message: profile.defaultBaseUrl === undefined
              ? "Set the server address (for example http://192.168.1.20:8000/v1)."
              : "The server address is not a valid http:// or https:// address."
          })
        }
        const key = raw.apiKey?.trim() ?? ""
        if (profile.keyRequired && key === "") {
          return yield* new ModuleStartError({ message: `Add your ${profile.label} API key.` })
        }
        const apiKey = key === "" ? undefined : Redacted.make(key)
        const fetchOption = options.fetch !== undefined ? { fetch: options.fetch } : {}

        setStatus({ text: `Connecting to ${profile.label}…`, tone: "neutral" })
        const models: ReadonlyArray<ModelInfo> = yield* listModels({ profile, baseUrl, apiKey, timeoutMs: 2_000, ...fetchOption }).pipe(
          Effect.mapError((e) =>
            startError(e, fixed !== undefined ? "Check the connection." : "Is the server running, and reachable from this machine?")
          )
        )
        const model = raw.model.trim() !== "" ? raw.model.trim() : models[0]?.id
        if (model === undefined) {
          return yield* new ModuleStartError({ message: `${profile.label} lists no models: load one, or set the model name.` })
        }
        const modelInfo = models.find((m) => m.id === model)
        const temperature = raw.temperature.trim() === "" ? undefined : Number(raw.temperature)
        const common = {
          profile,
          baseUrl,
          apiKey,
          model,
          modelInfo,
          temperature,
          reasoningEffort: raw.reasoningEffort === "default" ? undefined : raw.reasoningEffort,
          sortByLatency: raw.sortByLatency ?? false,
          timeoutMs: raw.timeoutMs,
          ...fetchOption
        }
        const llm = yield* make({ ...common, maxTokens: raw.maxTokens })

        const ready = models.length > 0 && modelInfo === undefined
          ? {
            text: fixed !== undefined
              ? `${model} is not in OpenRouter's list of models with tools`
              : `${model} is not in the server's model list`,
            tone: "warning" as const
          }
          : { text: `${profile.label} · ${model}`, tone: "ok" as const }

        if (raw.warmUp === true) {
          // Loads the model into memory (Ollama unloads it after 5 idle minutes by default).
          setStatus({ text: `Loading ${model}…`, tone: "neutral" })
          const warm = yield* make({ ...common, maxTokens: 1, timeoutMs: 60_000 })
          yield* warm.stream({ system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }).pipe(
            Stream.runDrain,
            Effect.tap(() => Effect.sync(() => setStatus(ready))),
            Effect.catch((e) => Effect.sync(() => setStatus({ text: `Loading the model failed: ${e.message}`.slice(0, 120), tone: "warning" }))),
            Effect.forkScoped
          )
        } else {
          setStatus(ready)
        }

        const impl: AgentImplementation = {
          systemPrompt: raw.systemPrompt,
          firstEventTimeoutMs: raw.timeoutMs,
          turn: makeModelAgent({ llm }).turn,
          settingOptions: () => ({ model: models.map((m) => ({ value: m.id, label: m.label })) })
        }
        return impl
      })
  })
}

export const openRouterAgent = openAiCompatibleAgent({
  id: "openrouter",
  name: "OpenRouter",
  fixedProfile: "openrouter",
  envPrefix: "OPENROUTER_",
  defaultModel: "anthropic/claude-haiku-5.5",
  description: "Hundreds of hosted models through OpenRouter, with your API key."
})

export const homeModelAgent = openAiCompatibleAgent({
  id: "home-model",
  name: "Home model server",
  envPrefix: "HOME_MODEL_"
})
