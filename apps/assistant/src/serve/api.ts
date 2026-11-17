import { encodeWav } from "@pva/audio-file"
import { parseVoiceKey, type VoiceRef, voiceKey } from "@pva/core"
import {
  API_PREFIX,
  type ApiErrorBody,
  FavouriteRequest,
  MAX_API_BODY_BYTES,
  MintRouteTokenRequest,
  type ModelRefJson,
  ModelRequest,
  modelKey,
  parseModelKey,
  type PickerKind,
  PreviewRequest,
  VoiceRequest
} from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Cause, type Context, Effect, Exit, Fiber, Schema } from "effect"
import type * as http from "node:http"
import type { AdminSessions } from "./AdminSessions.ts"
import type { AssistantVoice } from "./AssistantVoice.ts"
import type { Favourites } from "./Favourites.ts"
import type { Jobs } from "./jobs.ts"
import type { ModelCatalog } from "./ModelCatalog.ts"
import type { ModelFavourites } from "./ModelFavourites.ts"
import type { ModuleRouter } from "./moduleRoutes.ts"
import { type AdminScheduler, schedulerRoute } from "./schedulerApi.ts"
import type { Models } from "./models.ts"
import { ApiFailure, type VoiceCatalog } from "./VoiceCatalog.ts"

/**
 * The voice picker's HTTP API under `/api/` (docs/VOICE-PROVIDERS.md §5). Every route is admin only: the request
 * carries the admin session token (`Authorization: Bearer …`). A request from another origin is refused, except from
 * one of `SERVE_ALLOWED_ORIGINS` (the UI on `next dev`, which also opens the socket from there): that origin alone
 * gets CORS headers and its preflight is answered.
 * Keys are never part of an answer; provider messages are redacted by the adapters.
 */

export interface ApiOptions {
  readonly admin: AdminSessions
  readonly catalog: VoiceCatalog
  readonly favourites: Favourites
  readonly jobs: Jobs
  readonly models: Models
  readonly assistantVoice: AssistantVoice
  /** The model pickers (docs/MODEL-PICKERS.md §4): language models and recogniser models. */
  readonly modelCatalog: ModelCatalog
  readonly modelFavourites: Readonly<Record<PickerKind, ModelFavourites>>
  /** The server's services (logging), to run requests with. */
  readonly services: Context.Context<never>
  /** Origins allowed besides the server's own. */
  readonly allowedOrigins: ReadonlyArray<string>
  readonly scheme: "http" | "https"
  /** P3: the admin view of module routes and their tokens (`/api/module-routes`). Absent: 404. */
  readonly moduleRoutes?: ModuleRouter
  /** P6: the scheduled jobs (`/api/scheduler/jobs`, `schedulerApi.ts`). Absent: an empty list, `available: false`. */
  readonly scheduler?: AdminScheduler
}

/** A JSON answer, or a WAV body. */
type Answer =
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly wav: Uint8Array; readonly headers: Readonly<Record<string, string>> }

const json = (status: number, body: unknown): Answer => ({ status, json: body })

const fail = (status: number, code: string, message: string) => new ApiFailure({ status, code, message })

const badRequest = (message: string, fieldErrors?: ReadonlyArray<{ readonly key: string; readonly message: string }>) =>
  new ApiFailure({ status: 400, code: "invalid_request", message, ...(fieldErrors !== undefined ? { fieldErrors } : {}) })

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, body: unknown) => {
  const result = Schema.decodeUnknownResult(schema as never)(body) as { _tag: "Success"; success: S["Type"] } | { _tag: "Failure"; failure: { message: string } }
  if (result._tag === "Success") return Effect.succeed(result.success)
  const first = result.failure.message.split("\n").slice(0, 3).join(" ").slice(0, 300)
  const key = /\["([A-Za-z]+)"\]/.exec(result.failure.message)?.[1]
  return Effect.fail(badRequest(`The request is not valid: ${first}`, key !== undefined ? [{ key, message: "Not valid" }] : undefined))
}

/** Reads a JSON body (at most `MAX_API_BODY_BYTES`). An empty body is `undefined`. */
const readJson = (req: http.IncomingMessage): Effect.Effect<unknown, ApiFailure> =>
  Effect.callback<unknown, ApiFailure>((resume) => {
    const chunks: Array<Buffer> = []
    let size = 0
    let done = false
    const finish = (effect: Effect.Effect<unknown, ApiFailure>) => {
      if (done) return
      done = true
      resume(effect)
    }
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_API_BODY_BYTES) {
        finish(Effect.fail(new ApiFailure({ status: 413, code: "too_large", message: `The request body is larger than ${MAX_API_BODY_BYTES} bytes` })))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on("error", () => finish(Effect.fail(badRequest("The request body could not be read"))))
    req.on("end", () => {
      if (size === 0) return finish(Effect.succeed(undefined))
      const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()
      if (type !== "application/json") {
        return finish(Effect.fail(new ApiFailure({ status: 415, code: "unsupported_media_type", message: "Send JSON (Content-Type: application/json)" })))
      }
      try {
        finish(Effect.succeed(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
      } catch {
        finish(Effect.fail(badRequest("The request body is not valid JSON")))
      }
    })
  })

const methodNotAllowed = (allow: string) => new ApiFailure({ status: 405, code: "method_not_allowed", message: `Use ${allow}` })

/** `{key}` of a path: a URL-encoded voice key. */
const keyFromPath = (raw: string): Effect.Effect<VoiceRef, ApiFailure> => {
  let text: string
  try {
    text = decodeURIComponent(raw)
  } catch {
    return Effect.fail(badRequest("The voice in the address is not valid"))
  }
  const ref = parseVoiceKey(text)
  return ref === undefined ? Effect.fail(badRequest(`"${text.slice(0, 80)}" is not a voice (provider:voice)`)) : Effect.succeed(ref)
}

/** `{key}` of a model path: a URL-encoded model key (`provider:modelId`; the id may hold `/` and `:`). */
const modelKeyFromPath = (raw: string): Effect.Effect<ModelRefJson, ApiFailure> => {
  let text: string
  try {
    text = decodeURIComponent(raw)
  } catch {
    return Effect.fail(badRequest("The model in the address is not valid"))
  }
  const ref = parseModelKey(text)
  return ref === undefined ? Effect.fail(badRequest(`"${text.slice(0, 120)}" is not a model (provider:model)`)) : Effect.succeed(ref)
}

const bearer = (header: string | undefined): string | undefined => {
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/.exec(header ?? "")
  return match?.[1]
}

export const makeApi = (options: ApiOptions) => {
  const { catalog, favourites } = options

  const knownProvider = (ref: VoiceRef) =>
    catalog.isProvider(ref.provider) ? Effect.void : Effect.fail(new ApiFailure({ status: 404, code: "unknown_provider", message: `There is no voice provider "${ref.provider}"` }))

  const favouritesBody = () => ({ favourites: favourites.list() })

  const route = (req: http.IncomingMessage, path: string, query: URLSearchParams): Effect.Effect<Answer, ApiFailure> =>
    Effect.gen(function*() {
      const method = req.method ?? "GET"
      const only = (...allowed: Array<string>) => (allowed.includes(method) ? Effect.void : Effect.fail(methodNotAllowed(allowed.join(", "))))

      // P3 (docs/UI-AND-MODULES.md §1.11): what the modules expose, their recent calls, and their route tokens.
      const routesMatch = /^module-routes(?:\/([a-z][a-z0-9-]{0,39})\/tokens(?:\/([a-f0-9]{8,32}))?)?$/.exec(path)
      if (routesMatch !== null && options.moduleRoutes !== undefined) {
        const routes = options.moduleRoutes
        const [, moduleId, tokenId] = routesMatch
        const tokenFailure = (e: { readonly reason: string; readonly message: string }) =>
          e.reason === "unknown_module"
            ? fail(404, "not_found", e.message)
            : fail(
              e.reason === "locked" || e.reason === "unavailable" ? 503 : e.reason === "invalid" ? 400 : e.reason === "limit" || e.reason === "blocked" ? 409 : 500,
              e.reason === "locked" ? "locked" : e.reason,
              e.message
            )
        if (moduleId === undefined) {
          yield* only("GET")
          return json(200, yield* routes.view(query.get("module") ?? undefined))
        }
        if (tokenId === undefined) {
          yield* only("POST")
          const body = yield* decode(MintRouteTokenRequest, yield* readJson(req))
          return json(201, yield* routes.mint(moduleId, body.name, body.label).pipe(Effect.mapError(tokenFailure)))
        }
        yield* only("DELETE")
        const revoked = yield* routes.revoke(moduleId, tokenId).pipe(Effect.mapError(tokenFailure))
        if (!revoked) return yield* fail(404, "not_found", "There is no such token (it may have been revoked already)")
        return json(200, { revoked: true })
      }
      const scheduled = schedulerRoute(path, method, options.scheduler)
      if (scheduled !== undefined) return yield* scheduled
      if (path === "voice-providers") {
        yield* only("GET")
        return json(200, { providers: yield* catalog.providers })
      }
      if (path === "voices") {
        yield* only("GET")
        const provider = query.get("provider") ?? undefined
        const refresh = query.get("refresh") === "1" || query.get("refresh") === "true"
        const providers = yield* catalog.voices(provider, refresh)
        return json(200, { providers, selected: voiceKey(yield* options.assistantVoice.ref) })
      }
      if (path === "voices/preview") {
        yield* only("POST")
        const body = yield* decode(PreviewRequest, yield* readJson(req))
        yield* knownProvider(body.voice)
        const result = yield* catalog.preview(body.voice, body.text)
        return {
          status: 200,
          wav: encodeWav({ sampleRate: result.audio.sampleRate, channels: 1, data: result.audio.pcm }),
          headers: { "X-Voice-Sample-Rate": String(result.audio.sampleRate), "X-Preview-Cache": result.cached ? "hit" : "miss" }
        }
      }
      if (path === "voices/download" || path === "voices/download/cancel") {
        yield* only("POST")
        const body = yield* decode(VoiceRequest, yield* readJson(req))
        yield* knownProvider(body.voice)
        if (body.voice.provider !== "sherpa") return yield* badRequest("Only voices on this machine are downloaded", [{ key: "voice", message: "Not a voice on this machine" }])
        const preset = Object.hasOwn(SherpaTts.presets, body.voice.voiceId) ? SherpaTts.presets[body.voice.voiceId] : undefined
        if (preset === undefined) return yield* new ApiFailure({ status: 404, code: "unknown_voice", message: `There is no voice "${body.voice.voiceId}" on this machine` })
        // The voices of a shared archive (Kokoro) download as one job, under the archive's owner preset.
        const target = SherpaTts.archiveOwner(preset.name) ?? preset.name
        if (path === "voices/download/cancel") {
          const job = options.jobs.running("tts-models", target)
          if (job === undefined || !options.jobs.cancel(job.id)) return yield* fail(404, "not_found", `${preset.voice.name} is not being downloaded`)
          return json(200, { cancelled: true, job: options.jobs.list().find((j) => j.id === job.id) ?? job })
        }
        const started = options.models.download("tts-models", target)
        if (started.ok && started.job !== undefined) return json(202, { job: started.job })
        if (started.ok) return yield* fail(500, "internal", "The download did not start")
        const message = started.error.message
        if (/already downloaded/.test(message)) return yield* fail(409, "already_installed", `${preset.voice.name} is already downloaded`)
        if (started.error.code === "busy") return yield* fail(409, "busy", message)
        return yield* fail(400, "invalid_request", message)
      }
      const jobMatch = /^jobs\/([^/]+)$/.exec(path)
      if (jobMatch !== null) {
        yield* only("GET")
        const job = options.jobs.list().find((j) => j.id === jobMatch[1])
        if (job === undefined) return yield* fail(404, "not_found", "There is no such job (finished jobs are kept for the last 10)")
        return json(200, { job })
      }
      if (path === "voices/favourites") {
        yield* only("GET")
        return json(200, favouritesBody())
      }
      const favMatch = /^voices\/favourites\/([^/]+)$/.exec(path)
      if (favMatch !== null) {
        yield* only("PUT", "DELETE")
        const ref = yield* keyFromPath(favMatch[1]!)
        yield* knownProvider(ref)
        if (method === "DELETE") {
          const removed = yield* Effect.try({
            try: () => favourites.remove(ref),
            catch: (e) => fail(500, "internal", `The favourites could not be saved: ${(e as Error).message}`)
          })
          if (!removed) return yield* fail(404, "not_found", "That voice is not a favourite")
          return json(200, favouritesBody())
        }
        const raw = yield* readJson(req)
        const body = yield* decode(FavouriteRequest, raw ?? {})
        // The name from the provider's list (cached; fetched once if there is none yet), else the one it had, else the id.
        const listed = body.name ?? catalog.nameOf(ref) ?? (yield* catalog.voices(ref.provider, false).pipe(
          Effect.map((lists) => lists[0]?.voices.find((v) => v.voice.voiceId === ref.voiceId)?.name),
          Effect.orElseSucceed(() => undefined)
        ))
        const name = listed ?? favourites.list().find((f) => f.key === voiceKey(ref))?.name ?? ref.voiceId
        const added = favourites.add(ref, name)
        if (!added.ok) return yield* fail(added.code === "limit_reached" ? 409 : 500, added.code, added.message)
        return json(200, { favourite: added.favourite, ...favouritesBody() })
      }
      const modelsMatch = /^models\/([^/]+)(?:\/(.*))?$/.exec(path)
      if (modelsMatch !== null) return yield* modelRoute(req, method, modelsMatch[1]!, modelsMatch[2] ?? "", query)
      if (path === "voices/default") {
        yield* only("GET", "PUT")
        if (method === "GET") return json(200, { default: yield* options.assistantVoice.get })
        // Each assistant has its own voice (docs/ASSISTANTS.md §5.5): it is saved with the assistant.
        return yield* fail(410, "gone", "There is no single assistant voice any more: choose each assistant's voice in its Voice tab (Assistants › the assistant › Voice).")
      }
      return yield* fail(404, "not_found", `There is nothing at ${API_PREFIX}${path}`)
    })

  /** `/api/models/{kind}/…` (docs/MODEL-PICKERS.md §4). */
  const modelRoute = (req: http.IncomingMessage, method: string, kind: string, rest: string, query: URLSearchParams): Effect.Effect<Answer, ApiFailure> =>
    Effect.gen(function*() {
      const only = (...allowed: Array<string>) => (allowed.includes(method) ? Effect.void : Effect.fail(methodNotAllowed(allowed.join(", "))))
      if (kind !== "llm" && kind !== "stt") return yield* fail(404, "unknown_kind", `There is no model picker "${kind.slice(0, 40)}" (llm or stt)`)
      const k: PickerKind = kind
      const mc = options.modelCatalog
      const favs = options.modelFavourites[k]
      const knownModelProvider = (ref: ModelRefJson) =>
        mc.isProvider(k, ref.provider) ? Effect.void : Effect.fail(fail(404, "unknown_provider", `There is no ${k === "llm" ? "language model" : "speech recognition"} provider "${ref.provider}"`))
      if (rest === "") {
        yield* only("GET")
        const provider = query.get("provider") ?? undefined
        const refresh = query.get("refresh") === "1" || query.get("refresh") === "true"
        return json(200, { kind: k, providers: yield* mc.models(k, provider, refresh) })
      }
      if (rest === "providers") {
        yield* only("GET")
        return json(200, { kind: k, providers: yield* mc.providers(k) })
      }
      if (rest === "favourites") {
        yield* only("GET")
        return json(200, { favourites: favs.list() })
      }
      const favMatch = /^favourites\/([^/]+)$/.exec(rest)
      if (favMatch !== null) {
        yield* only("PUT", "DELETE")
        const ref = yield* modelKeyFromPath(favMatch[1]!)
        yield* knownModelProvider(ref)
        if (method === "DELETE") {
          const removed = yield* Effect.try({
            try: () => favs.remove(ref),
            catch: (e) => fail(500, "internal", `The favourites could not be saved: ${(e as Error).message}`)
          })
          if (!removed) return yield* fail(404, "not_found", "That model is not a favourite")
          return json(200, { favourites: favs.list() })
        }
        const body = yield* decode(FavouriteRequest, (yield* readJson(req)) ?? {})
        // The name from the provider's list (cached; fetched once when there is none), else the one it had, else the id.
        const listed = body.name ?? mc.nameOf(k, ref) ?? (yield* mc.models(k, ref.provider, false).pipe(
          Effect.map((lists) => lists[0]?.models.find((m) => m.model.modelId === ref.modelId)?.name),
          Effect.orElseSucceed(() => undefined)
        ))
        const name = listed ?? favs.list().find((f) => f.key === modelKey(ref))?.name ?? ref.modelId
        const added = favs.add(ref, name)
        if (!added.ok) return yield* fail(added.code === "limit_reached" ? 409 : 500, added.code, added.message)
        return json(200, { favourite: added.favourite, favourites: favs.list() })
      }
      if (rest === "download" || rest === "download/cancel") {
        yield* only("POST")
        if (k !== "stt") return yield* fail(404, "not_found", "Only speech recognition models are downloaded")
        const body = yield* decode(ModelRequest, yield* readJson(req))
        yield* knownModelProvider(body.model)
        if (body.model.provider !== "sherpa") return yield* badRequest("Only models on this machine are downloaded", [{ key: "model", message: "Not a model on this machine" }])
        const name = SherpaStt.resolvePresetName(body.model.modelId)
        if (name === undefined) return yield* fail(404, "unknown_model", `There is no speech recognition model "${body.model.modelId}" on this machine`)
        const label = (SherpaStt.presets[name] as SherpaStt.Preset).label.split(" — ")[0]!
        if (rest === "download/cancel") {
          const job = options.jobs.running("stt-models", name)
          if (job === undefined || !options.jobs.cancel(job.id)) return yield* fail(404, "not_found", `${label} is not being downloaded`)
          return json(200, { cancelled: true, job: options.jobs.list().find((j) => j.id === job.id) ?? job })
        }
        const started = options.models.download("stt-models", name)
        if (started.ok && started.job !== undefined) return json(202, { job: started.job })
        if (started.ok) return yield* fail(500, "internal", "The download did not start")
        const message = started.error.message
        if (/already downloaded/.test(message)) return yield* fail(409, "already_installed", `${label} is already downloaded`)
        if (started.error.code === "busy") return yield* fail(409, "busy", message)
        return yield* fail(400, "invalid_request", message)
      }
      return yield* fail(404, "not_found", `There is nothing at ${API_PREFIX}models/${kind}/${rest.slice(0, 80)}`)
    })

  const send = (res: http.ServerResponse, answer: Answer, cors: Readonly<Record<string, string>> = {}) => {
    if (res.writableEnded || res.destroyed) return
    const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...cors }
    if ("wav" in answer) {
      res.writeHead(answer.status, { ...common, ...answer.headers, "Content-Type": "audio/wav", "Content-Length": String(answer.wav.length) })
      res.end(Buffer.from(answer.wav.buffer, answer.wav.byteOffset, answer.wav.byteLength))
      return
    }
    const body = JSON.stringify(answer.json)
    res.writeHead(answer.status, { ...common, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(body)) })
    res.end(body)
  }

  const errorAnswer = (e: ApiFailure): Answer => {
    const body: ApiErrorBody = {
      error: {
        code: e.code,
        message: e.message,
        ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
        ...(e.fieldErrors !== undefined && e.fieldErrors.length > 0 ? { fieldErrors: e.fieldErrors } : {})
      }
    }
    return json(e.status, body)
  }

  /** Handles a request whose path starts with `/api/`. */
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://x")
    const path = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "")
    const origin = req.headers.origin
    const own = `${options.scheme}://${req.headers.host ?? ""}`
    const foreign = origin !== undefined && origin !== own
    if (foreign && !options.allowedOrigins.includes(origin)) {
      send(res, errorAnswer(new ApiFailure({ status: 403, code: "forbidden_origin", message: "Requests from another site are refused" })))
      req.resume()
      return
    }
    // An allowed other origin (SERVE_ALLOWED_ORIGINS): CORS for that origin only, and its preflight (the token header
    // makes every request need one) is answered before the token is checked.
    const cors: Record<string, string> = foreign
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Expose-Headers": "X-Voice-Sample-Rate, X-Preview-Cache" }
      : {}
    if (foreign && req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store"
      }).end()
      req.resume()
      return
    }
    const reject = (e: ApiFailure) => {
      send(res, errorAnswer(e), cors)
      req.resume()
    }
    const token = bearer(req.headers.authorization)
    if (!options.admin.enabled) {
      return reject(new ApiFailure({
        status: 401,
        code: "admin_required",
        message: "Admin is disabled: set PVA_ADMIN_PASSWORD (at least 8 characters) in .env and restart."
      }))
    }
    if (token === undefined || options.admin.check(token) === undefined || !options.admin.touch(token)) {
      return reject(new ApiFailure({ status: 401, code: "admin_required", message: "Log in to admin first (the session may have ended)" }))
    }
    const fiber = Effect.runForkWith(options.services)(
      route(req, path, url.searchParams).pipe(
        Effect.catchCause((cause) => {
          const failure = Cause.findErrorOption(cause)
          if (failure._tag === "Some" && failure.value instanceof ApiFailure) return Effect.succeed(errorAnswer(failure.value))
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          return Effect.logError("api: request failed", cause).pipe(
            Effect.as(errorAnswer(new ApiFailure({ status: 500, code: "internal", message: "Something went wrong on the server (see its log)" })))
          )
        })
      )
    )
    // The client went away: stop the work (a preview's request to a provider is aborted).
    res.on("close", () => {
      if (!res.writableEnded) void Effect.runForkWith(options.services)(Fiber.interrupt(fiber))
    })
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) send(res, exit.value, cors)
      else if (!res.writableEnded) res.destroy()
      if (!req.complete) req.resume()
    })
  }
}
