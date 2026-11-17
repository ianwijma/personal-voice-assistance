/**
 * The `openrouter` and `home-model` language-model accounts of the assistant app (docs/ASSISTANTS.md §2.2, §3.2,
 * WP-13b): one `Llm` per assistant configuration, built from settings (a `ConfigProvider`), as `llm-anthropic`'s
 * `config` and `layerConfig` are.
 *
 * Settings, with the prefix of the account (`OPENROUTER_`, `HOME_MODEL_`):
 * - shared (the account): `API_KEY` (OpenRouter: required; home model: only if the server was started with a key),
 *   `BASE_URL` (OpenRouter: the default address when empty; home model: required), OpenRouter's `SORT_BY_LATENCY`;
 * - the assistant's own (set by the resource pool over the shared ones): `MODEL`, `MAX_TOKENS`, `TIMEOUT_MS`
 *   (the give-up time), `WARM_UP`.
 *
 * What is not read: a reasoning effort (neither account sends one: OpenRouter takes it only for models whose list entry
 * names it, and the pool does not fetch the list), a temperature (the server's default).
 *
 * An account that is not set up (no key, no address) fails the build with a sentence for the owner
 * (`notSetUpMessage`); the pool shows it as that resource's problem, and the assistant's turns fail with it.
 *
 * Warm-up (`warmUp` true): OpenRouter opens the connection with `GET /models` (also checks the key); a home model
 * gets one one-token request, which makes the server load the model (Ollama unloads it after idle minutes). With
 * `awaitWarmUp` the instance is returned once the warm-up has ended (succeeded, failed, or timed out), as
 * `AnthropicLlm.make`'s option does, so "ready" means "warm". A failing warm-up does not fail the build.
 */
import { Llm, LlmError } from "@pva/core"
import { Config, Effect, Layer, Redacted, Stream } from "effect"
import { createHash } from "node:crypto"
import { listModels, type ModelListError } from "./models.ts"
import { make, type OpenAiCompatibleLlmOptions } from "./OpenAiCompatibleLlm.ts"
import { type ModelInfo, type Profile, profiles, type ProfileId, resolveBaseUrl } from "./profiles.ts"
import { addressSecrets, checkAddress, fromUpstream, sanitize, secretList } from "./redact.ts"

export type AccountId = "openrouter" | "home-model"

interface AccountDef {
  readonly prefix: string
  readonly profile: ProfileId
  readonly label: string
}

const accounts: Readonly<Record<AccountId, AccountDef>> = {
  openrouter: { prefix: "OPENROUTER_", profile: "openrouter", label: "OpenRouter" },
  "home-model": { prefix: "HOME_MODEL_", profile: "generic", label: "Home model" }
}

export const isAccountId = (id: string): id is AccountId => Object.hasOwn(accounts, id)

/** Where the owner sets an account up (the words of the admin's navigation). */
const WHERE = "Shared settings › Language model accounts"

/** The one sentence for an account that lacks its key or address. */
export const notSetUpMessage = (account: AccountId, missing: "key" | "address"): string =>
  `${accounts[account].label} is not set up: add ${missing === "key" ? "its API key" : "the server address"} in ${WHERE}.`

/** The default address of an account (`undefined`: the owner must give one). */
export const defaultAddress = (account: AccountId): string | undefined => profiles[accounts[account].profile].defaultBaseUrl

/** For a settings field: `undefined` when `value` is empty or an acceptable address, else a sentence for the owner. */
export const checkAccountAddress = (value: string): string | undefined => {
  if (value.trim() === "") return undefined
  const checked = checkAddress(value, { protocols: ["http:", "https:"], query: false })
  if (checked.ok) return undefined
  return checked.problem === "is not a valid address"
    ? "Must be an address such as http://192.168.1.20:11434"
    : `${checked.problem[0]!.toUpperCase()}${checked.problem.slice(1)}`
}

/** How long a home model may take to load for the warm-up request (loading is its point). */
export const WARM_UP_LOAD_MS = 60_000

export interface AccountOptions extends OpenAiCompatibleLlmOptions {
  readonly warmUp?: "models" | "completion" | undefined
  readonly awaitWarmUp?: boolean | undefined
}

/**
 * The options of `account` from the settings. Fails with a `Config.ConfigError` for a malformed setting and with an
 * `LlmError` for an account that is not set up or whose address is refused (message without any credential).
 */
export const accountConfig = (account: AccountId): Effect.Effect<AccountOptions, Config.ConfigError | LlmError> => {
  const def = accounts[account]
  const p = def.prefix
  return Effect.gen(function*() {
    const key = yield* Config.Redacted(`${p}API_KEY`).pipe(Config.option)
    const apiKey = key._tag === "Some" && Redacted.value(key.value).trim() !== "" ? Redacted.make(Redacted.value(key.value).trim()) : undefined
    const configured = (yield* Config.String(`${p}BASE_URL`).pipe(Config.withDefault(""))).trim()
    const model = (yield* Config.String(`${p}MODEL`).pipe(Config.withDefault(""))).trim()
    const maxTokens = yield* Config.Int(`${p}MAX_TOKENS`).pipe(Config.withDefault(512))
    const timeoutMs = yield* Config.Int(`${p}TIMEOUT_MS`).pipe(Config.withDefault(5_000))
    const warmUp = yield* Config.Boolean(`${p}WARM_UP`).pipe(Config.withDefault(true))
    const sortByLatency = account === "openrouter"
      ? yield* Config.Boolean(`${p}SORT_BY_LATENCY`).pipe(Config.withDefault(true))
      : false

    const secrets = secretList(apiKey !== undefined ? Redacted.value(apiKey) : undefined, addressSecrets(configured))
    const fail = (message: string) => Effect.fail(new LlmError(sanitize(secrets, { message })))
    const profile: Profile = profiles[def.profile]
    if (profile.keyRequired && apiKey === undefined) return yield* fail(notSetUpMessage(account, "key"))
    if (!profile.keyRequired && configured === "") return yield* fail(notSetUpMessage(account, "address"))
    if (configured !== "") {
      const checked = checkAddress(configured, { protocols: ["http:", "https:"], query: false })
      if (!checked.ok) return yield* fail(`The ${def.label} address ${checked.problem}`)
    }
    // A home server's address as printed at start (`http://host:11434`) gets the `/v1` every such server expects.
    const baseUrl = resolveBaseUrl(account === "home-model" ? profiles.ollama : profile, configured)
    if (baseUrl === undefined) return yield* fail(`The ${def.label} address is not a valid http:// or https:// address`)
    if (model === "") return yield* fail(`Choose a model for ${def.label}.`)
    return {
      profile,
      baseUrl,
      apiKey,
      model,
      maxTokens,
      timeoutMs,
      sortByLatency,
      warmUp: warmUp ? (account === "openrouter" ? "models" : "completion") : undefined
    } satisfies AccountOptions
  })
}

/** The `Llm` of an account's options, warmed as asked (see the file header). */
export const makeAccount = (options: AccountOptions) =>
  Effect.gen(function*() {
    const llm = yield* make(options)
    if (options.warmUp === undefined) return llm
    const secrets = secretList(options.apiKey !== undefined ? Redacted.value(options.apiKey) : undefined, addressSecrets(options.baseUrl))
    const warm: Effect.Effect<void, unknown> = options.warmUp === "models"
      ? Effect.asVoid(listModels({
        profile: options.profile,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        timeoutMs: options.timeoutMs,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
      }))
      : Effect.flatMap(
        make({ ...options, maxTokens: 1, timeoutMs: WARM_UP_LOAD_MS }),
        (loader) => Stream.runDrain(loader.stream({ system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }))
      )
    const task = warm.pipe(
      Effect.catch((e) => Effect.logWarning(`Language model warm-up failed: ${fromUpstream(e instanceof Error ? e.message : e, secrets)}`)),
      Effect.catchDefect(() => Effect.void)
    )
    if (options.awaitWarmUp === true) yield* task
    else yield* Effect.asVoid(Effect.forkScoped(task))
    return llm
  })

/** The layer of an account, from settings (the app's `ConfigProvider`). `awaitWarmUp` as `AnthropicLlm.make`. */
export const accountLayer = (account: AccountId, awaitWarmUp = false): Layer.Layer<Llm, Config.ConfigError | LlmError> =>
  Layer.effect(Llm, Effect.flatMap(accountConfig(account), (options) => makeAccount({ ...options, awaitWarmUp })))

/**
 * Where the model picker gets an account's models (docs/MODEL-PICKERS.md §3): the account's own `GET {base}/models`,
 * read with the shared settings only (no model needs to be chosen yet). Never on a turn's path.
 *
 * - `not_set_up`: no key (OpenRouter) or no address (home model); `message` is `notSetUpMessage`'s sentence.
 * - `invalid`: the configured address is refused (message without any credential).
 * - `ready`: `list` fetches the list; `identity` changes whenever the address or the key changes (a hash: neither
 *   value can be read back from it), so a cache keyed by it never serves another key's list.
 */
export type AccountModelSource =
  | { readonly state: "not_set_up"; readonly missing: "key" | "address"; readonly message: string }
  | { readonly state: "invalid"; readonly message: string }
  | {
    readonly state: "ready"
    readonly identity: string
    /** The credential-free address, for messages. */
    readonly address: string
    readonly list: (options: { readonly timeoutMs: number; readonly fetch?: typeof globalThis.fetch }) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelListError>
  }

export const accountModelSource = (account: AccountId): Effect.Effect<AccountModelSource, Config.ConfigError> => {
  const def = accounts[account]
  const p = def.prefix
  return Effect.gen(function*() {
    const key = yield* Config.Redacted(`${p}API_KEY`).pipe(Config.option)
    const apiKey = key._tag === "Some" && Redacted.value(key.value).trim() !== "" ? Redacted.make(Redacted.value(key.value).trim()) : undefined
    const configured = (yield* Config.String(`${p}BASE_URL`).pipe(Config.withDefault(""))).trim()
    const secrets = secretList(apiKey !== undefined ? Redacted.value(apiKey) : undefined, addressSecrets(configured))
    const profile: Profile = profiles[def.profile]
    if (profile.keyRequired && apiKey === undefined) return { state: "not_set_up", missing: "key", message: notSetUpMessage(account, "key") } as const
    if (!profile.keyRequired && configured === "") return { state: "not_set_up", missing: "address", message: notSetUpMessage(account, "address") } as const
    if (configured !== "") {
      const checked = checkAddress(configured, { protocols: ["http:", "https:"], query: false })
      if (!checked.ok) return { state: "invalid", message: sanitize(secrets, { message: `The ${def.label} address ${checked.problem}` }).message } as const
    }
    const baseUrl = resolveBaseUrl(account === "home-model" ? profiles.ollama : profile, configured)
    if (baseUrl === undefined) return { state: "invalid", message: `The ${def.label} address is not a valid http:// or https:// address` } as const
    const identity = createHash("sha256").update(`${account}\u0000${baseUrl}\u0000${apiKey !== undefined ? Redacted.value(apiKey) : ""}`).digest("hex").slice(0, 16)
    const checked = checkAddress(baseUrl, { protocols: ["http:", "https:"], query: false })
    return {
      state: "ready",
      identity,
      address: checked.ok ? checked.display : def.label,
      list: (options) => listModels({ profile, baseUrl, apiKey, timeoutMs: options.timeoutMs, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) })
    } as const
  })
}
