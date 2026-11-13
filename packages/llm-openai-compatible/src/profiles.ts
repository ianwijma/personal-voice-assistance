/**
 * Per-server differences of the OpenAI-compatible chat completions API
 * (docs/research/agent-backends.md §4, docs/AGENTS-AND-INTENTS.md §1.7).
 *
 * Everything that is the same everywhere (the request, SSE, tool-call deltas by
 * index, `GET /models`) lives in the adapter; a profile holds only what differs:
 * the default address, whether a key is required, the body fields only that
 * server understands (strict servers may answer 400 to unknown fields, so they
 * are never sent elsewhere), and how its model list is filtered.
 */

export type ProfileId = "openrouter" | "ollama" | "llamacpp" | "lmstudio" | "vllm" | "generic"

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high"

/** One entry of a server's model list. */
export interface ModelInfo {
  readonly id: string
  /** Display name (OpenRouter has one; other servers only the id). */
  readonly label: string
  /**
   * Reasoning efforts the model accepts, when the server says (OpenRouter's
   * `reasoning.supported_efforts`). `undefined` = not known.
   */
  readonly reasoningEfforts?: ReadonlyArray<string>
  /** The model accepts a reasoning setting at all (OpenRouter's `supported_parameters` has `reasoning`). */
  readonly reasoning?: boolean
}

export interface Profile {
  readonly id: ProfileId
  /** For the settings screen and error messages ("Ollama"). */
  readonly label: string
  /** `undefined`: the owner must give an address (generic). */
  readonly defaultBaseUrl: string | undefined
  readonly keyRequired: boolean
  /** Whether `reasoningEffort` means anything on this server. */
  readonly supportsReasoningEffort: boolean
  /**
   * Extra body fields for this server. `model` is the chosen model's list
   * entry when the list was fetched (so OpenRouter can send `reasoning` only to
   * models that take it).
   */
  readonly extraBody: (options: {
    readonly reasoningEffort: ReasoningEffort | undefined
    readonly sortByLatency: boolean
    readonly model: ModelInfo | undefined
  }) => Readonly<Record<string, unknown>>
  /** Turn one raw `GET /models` entry into a list entry, or drop it (`undefined`). */
  readonly parseModel: (raw: Readonly<Record<string, unknown>>) => ModelInfo | undefined
}

const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> => typeof u === "object" && u !== null && !Array.isArray(u)
const strings = (u: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(u) ? u.filter((s): s is string => typeof s === "string") : undefined

/** The common case: `{ id }`, labelled by its id. */
const plainModel = (raw: Readonly<Record<string, unknown>>): ModelInfo | undefined =>
  typeof raw.id === "string" && raw.id.length > 0 ? { id: raw.id, label: raw.id } : undefined

const noExtras = () => ({})

/**
 * OpenRouter: keep only models that take tools (the assistant's modules are
 * tools) and whose reasoning can be turned down (a mandatory-reasoning model
 * thinks before every first word, research §4 pitfalls).
 */
const openRouterModel = (raw: Readonly<Record<string, unknown>>): ModelInfo | undefined => {
  const base = plainModel(raw)
  if (base === undefined) return undefined
  const params = strings(raw.supported_parameters)
  if (params !== undefined && !params.includes("tools")) return undefined
  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : undefined
  if (reasoning?.mandatory === true) return undefined
  const efforts = strings(reasoning?.supported_efforts)
  return {
    id: base.id,
    label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : base.id,
    ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
    ...(params !== undefined ? { reasoning: params.includes("reasoning") || params.includes("reasoning_effort") } : {})
  }
}

export const profiles: Readonly<Record<ProfileId, Profile>> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    supportsReasoningEffort: true,
    extraBody: ({ model, reasoningEffort, sortByLatency }) => {
      // `reasoning` only when the model lists the effort (or at least reasoning
      // support): providers that do not take it may fail the request.
      const takesEffort = reasoningEffort !== undefined && model !== undefined &&
        (model.reasoningEfforts !== undefined ? model.reasoningEfforts.includes(reasoningEffort) : model.reasoning === true)
      return {
        ...(sortByLatency ? { provider: { sort: "latency" } } : {}),
        ...(takesEffort ? { reasoning: { effort: reasoningEffort } } : {})
      }
    },
    parseModel: openRouterModel
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434/v1",
    keyRequired: false,
    supportsReasoningEffort: true,
    extraBody: ({ reasoningEffort }) => (reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    parseModel: plainModel
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp",
    defaultBaseUrl: "http://localhost:8080/v1",
    keyRequired: false,
    supportsReasoningEffort: false,
    extraBody: noExtras,
    parseModel: plainModel
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    defaultBaseUrl: "http://localhost:1234/v1",
    keyRequired: false,
    supportsReasoningEffort: false,
    extraBody: noExtras,
    parseModel: plainModel
  },
  vllm: {
    id: "vllm",
    label: "vLLM",
    defaultBaseUrl: "http://localhost:8000/v1",
    keyRequired: false,
    supportsReasoningEffort: false,
    extraBody: noExtras,
    parseModel: plainModel
  },
  generic: {
    id: "generic",
    label: "OpenAI-compatible server",
    defaultBaseUrl: undefined,
    keyRequired: false,
    supportsReasoningEffort: false,
    extraBody: noExtras,
    parseModel: plainModel
  }
}

/**
 * The base address to use: the owner's, or the profile's default. A bare
 * `http://host:port` for a local server gets the `/v1` the servers expect, so
 * typing the address the server prints at start works.
 */
export const resolveBaseUrl = (profile: Profile, configured: string | undefined): string | undefined => {
  const text = configured?.trim() ?? ""
  if (text === "") return profile.defaultBaseUrl
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  const path = url.pathname.replace(/\/+$/, "")
  if (path === "" && profile.id !== "generic" && profile.defaultBaseUrl?.endsWith("/v1") === true) {
    return `${url.origin}/v1`
  }
  return `${url.origin}${path}`
}
