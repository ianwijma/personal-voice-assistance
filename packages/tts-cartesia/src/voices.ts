/**
 * The Cartesia voices (docs/VOICE-PROVIDERS.md §3, §7.2): the voice library over REST (`GET /voices`, pages of 100
 * by `starting_after`) and a one-shot preview (`POST /tts/bytes`, raw `pcm_s16le`). Plain `fetch`, never the live WebSocket, so a
 * preview cannot disturb a turn. Every error goes through `redact.ts`: no key and no raw body in any message.
 */
import { MAX_LISTED_VOICES, type PreviewAudio, TtsVoices, VOICE_ID_PATTERN, VoiceCatalogError, type VoiceDescription, type VoiceList } from "@pva/core"
import { Config, Effect, Redacted } from "effect"
import { CARTESIA_VERSION, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./index.ts"
import { addressSecrets, checkAddress, clip, errorName, safeSeconds, type Secrets, sanitize, secretList } from "./redact.ts"

export interface CartesiaVoicesOptions {
  readonly apiKey: Redacted.Redacted<string>
  /** The WebSocket address (`CARTESIA_URL`); the REST calls go to the same host over http(s). */
  readonly baseUrl?: string
  /** For previews. Default `DEFAULT_MODEL`. */
  readonly model?: string
  /** `language` for previews (`CARTESIA_LANGUAGE`); empty = unset. */
  readonly language?: string
  /** Preview rate (8000, 16000, 22050, 24000, 44100 or 48000). Default 24000. */
  readonly sampleRate?: number
  /** Per request. Default 15000. */
  readonly timeoutMs?: number
  /** Tests. Default `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/** The most audio a preview may return (30 s at 48 kHz, s16le, with room). */
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024
const PAGE_SIZE = 100

type Reason = VoiceCatalogError["reason"]

const failure = (secrets: Secrets, reason: Reason, message: string, extra: { readonly retryAfterMs?: number; readonly cause?: unknown } = {}) =>
  new VoiceCatalogError({ reason, ...sanitize(secrets, { message, ...(extra.cause !== undefined ? { cause: extra.cause } : {}) }), ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}) })

/** `wss://host/path` → `https://host/path`; `ws://` → `http://` (tests). */
export const restBase = (baseUrl: string | undefined): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly problem: string } => {
  const checked = checkAddress(baseUrl ?? DEFAULT_BASE_URL, { protocols: ["wss:", "ws:", "https:", "http:"], query: false })
  if (!checked.ok) return { ok: false, problem: `The Cartesia address (CARTESIA_URL) ${checked.problem}` }
  return { ok: true, url: checked.display.replace(/^wss:/, "https:").replace(/^ws:/, "http:") }
}

const statusFailure = (secrets: Secrets, status: number, retryAfter: string | null, what: string, body: string): VoiceCatalogError => {
  if (status === 401 || status === 403) {
    return failure(secrets, "unauthorized", `Cartesia refused the API key (${status}): check it on the Voice providers page.`)
  }
  if (status === 429) {
    const seconds = safeSeconds(retryAfter)
    return failure(secrets, "rate_limited", `Cartesia is limiting requests (429)${seconds !== undefined ? `: try again in ${seconds} s` : ""}.`, {
      ...(seconds !== undefined ? { retryAfterMs: seconds * 1000 } : {})
    })
  }
  if (status === 404 || /voice[^.]{0,40}not (?:be )?found/i.test(body)) return failure(secrets, "unknown_voice", "Cartesia does not have that voice (it may have been removed).")
  if (status >= 500) return failure(secrets, "unavailable", `Cartesia could not ${what} (${status}); try again later.`)
  return failure(secrets, "invalid", `Cartesia refused to ${what} (${status}): ${clip(body, secrets, 200)}`)
}

/** Reads at most `max` bytes of a body; more is an error. */
const readBody = async (response: Response, max: number): Promise<Uint8Array> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new RangeError("response too large")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const gender = (value: unknown): VoiceDescription["gender"] =>
  value === "feminine" ? "female" : value === "masculine" ? "male" : value === "gender_neutral" ? "neutral" : undefined

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const t = value.replace(/\s+/g, " ").trim()
  return t.length === 0 ? undefined : t.length > max ? `${t.slice(0, max)}…` : t
}

const tag = (value: unknown): string | undefined => text(typeof value === "string" ? value.replace(/_/g, " ").toLowerCase() : value, 40)

/** One entry of `data` in the `/voices` answer, or undefined when it is unusable or archived. */
export const describeVoice = (raw: unknown): VoiceDescription | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const v = raw as Record<string, unknown>
  const id = typeof v.id === "string" ? v.id : ""
  if (!VOICE_ID_PATTERN.test(id) || v.status === "archived") return undefined
  const accents = Array.isArray(v.accents) ? v.accents.filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null) : []
  const tags = [
    ...new Set([
      ...accents.map((a) => tag(a.accent)),
      v.is_pro === true ? "pro" : undefined,
      v.is_owner === true ? "yours" : undefined
    ].filter((t): t is string => t !== undefined))
  ]
  const description = text(v.description, 300) ?? text(v.tagline, 300)
  const language = text(accents.find((a) => typeof a.locale === "string")?.locale, 20) ?? text(v.language, 20)
  const g = gender(v.gender)
  return {
    id,
    name: text(v.name, 100) ?? id,
    ...(description !== undefined ? { description } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(g !== undefined ? { gender: g } : {}),
    tags
  }
}

export const makeVoices = (options: CartesiaVoicesOptions): TtsVoices["Service"] => {
  let secrets: Secrets = []
  try {
    secrets = secretList(Redacted.value(options.apiKey), addressSecrets(options.baseUrl))
  } catch {
    // a getter that throws: the calls below fail with a sanitised error
  }
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const sampleRate = options.sampleRate ?? 24_000

  /** One request: the response when it is 2xx, else a `VoiceCatalogError`. */
  const call = (what: string, path: string, init: { readonly method: string; readonly body?: string }, accept: string) =>
    Effect.gen(function*() {
      const base = restBase(options.baseUrl)
      if (!base.ok) return yield* failure(secrets, "invalid", base.problem)
      const key = yield* Effect.try({
        try: () => Redacted.value(options.apiKey),
        catch: (e) => failure(secrets, "invalid", `The Cartesia key could not be read (${errorName(e)})`)
      })
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await doFetch(`${base.url}${path}`, {
            method: init.method,
            headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": CARTESIA_VERSION, Accept: accept, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
            ...(init.body !== undefined ? { body: init.body } : {}),
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          })
          if (!response.ok) {
            const body = await readBody(response, 65_536).then((b) => new TextDecoder().decode(b), () => "")
            throw statusFailure(secrets, response.status, response.headers.get("retry-after"), what, body)
          }
          return response
        },
        catch: (e) =>
          e instanceof VoiceCatalogError
            ? e
            : failure(secrets, "unavailable", `Cartesia could not be reached to ${what} (${errorName(e)})`, { cause: e })
      })
    })

  const json = (what: string, path: string) =>
    Effect.flatMap(call(what, path, { method: "GET" }, "application/json"), (response) =>
      Effect.tryPromise({
        try: async () => JSON.parse(new TextDecoder().decode(await readBody(response, MAX_JSON_BYTES))) as unknown,
        catch: (e) => failure(secrets, "unavailable", `Cartesia sent an answer that is not valid JSON (${errorName(e)})`)
      }))

  const list: Effect.Effect<VoiceList, VoiceCatalogError> = Effect.gen(function*() {
    const voices: Array<VoiceDescription> = []
    const seen = new Set<string>()
    let after: string | undefined
    for (let page = 0; page < Math.ceil(MAX_LISTED_VOICES / PAGE_SIZE); page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (after !== undefined) query.set("starting_after", after)
      const body = yield* json("list its voices", `/voices?${query.toString()}`)
      const answer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
      if (!Array.isArray(answer.data)) return yield* failure(secrets, "unavailable", "Cartesia sent a voice list without voices")
      for (const raw of answer.data) {
        const voice = describeVoice(raw)
        if (voice === undefined || seen.has(voice.id)) continue
        seen.add(voice.id)
        voices.push(voice)
      }
      const next = typeof answer.next_page === "string" && answer.next_page !== "" ? answer.next_page : undefined
      if (answer.has_more !== true || next === undefined) return { voices: voices.slice(0, MAX_LISTED_VOICES), truncated: voices.length > MAX_LISTED_VOICES }
      if (voices.length >= MAX_LISTED_VOICES) break
      after = next
    }
    return { voices: voices.slice(0, MAX_LISTED_VOICES), truncated: true }
  })

  const preview = (voiceId: string, input: string): Effect.Effect<PreviewAudio, VoiceCatalogError> =>
    Effect.gen(function*() {
      if (!VOICE_ID_PATTERN.test(voiceId)) return yield* failure(secrets, "unknown_voice", "That is not an Cartesia voice id")
      if (!(SAMPLE_RATES as ReadonlyArray<number>).includes(sampleRate)) {
        return yield* failure(secrets, "invalid", `The Cartesia sample rate must be one of ${SAMPLE_RATES.join(", ")}`)
      }
      const language = options.language?.trim() ?? ""
      const body = JSON.stringify({
        model_id: options.model ?? DEFAULT_MODEL,
        transcript: input,
        voice: { id: voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: sampleRate },
        ...(language !== "" ? { language } : {})
      })
      const response = yield* call("read the preview", "/tts/bytes", { method: "POST", body }, "audio/*")
      const bytes = yield* Effect.tryPromise({
        try: () => readBody(response, MAX_PREVIEW_BYTES),
        catch: (e) => failure(secrets, "unavailable", `The Cartesia preview could not be read (${errorName(e)})`)
      })
      return { sampleRate, pcm: bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1) }
    })

  return TtsVoices.of({ list, preview })
}

/** `CARTESIA_API_KEY` (required), `CARTESIA_URL`, `CARTESIA_MODEL`, `CARTESIA_LANGUAGE` (default `en`). */
export const voicesConfig: Effect.Effect<TtsVoices["Service"], Config.ConfigError> = Effect.gen(function*() {
  const options = yield* Config.all({
    apiKey: Config.Redacted("CARTESIA_API_KEY"),
    baseUrl: Config.String("CARTESIA_URL").pipe(Config.withDefault(DEFAULT_BASE_URL)),
    model: Config.String("CARTESIA_MODEL").pipe(Config.withDefault(DEFAULT_MODEL)),
    language: Config.String("CARTESIA_LANGUAGE").pipe(Config.withDefault("en"))
  })
  return makeVoices(options)
})
