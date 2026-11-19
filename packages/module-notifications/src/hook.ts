import { type ModuleRoute, type NotifyError, type ModuleNotify } from "@pva/core"
import { isLine } from "@pva/module-contracts"
import { Effect } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"

/** Bounds of what the hook takes (the service's own bounds are 60 and 200; the hook is stricter on the body). */
export const HOOK_TITLE_MAX = 60
export const HOOK_TEXT_MAX = 200
export const HOOK_KEY_MAX = 48
export const HOOK_BODY_BYTES = 2_048
/** The header that carries the token (`authorization` is never given to a route that has no token guard). */
export const HOOK_TOKEN_HEADER = "x-pva-token"
/** Open hook notifications keep a day at most; the service's own default for `normal`, stated here once. */
export const HOOK_EXPIRY_MS = 24 * 3_600_000

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest()

/** Constant time, and of the same length whatever was sent: both sides are hashed first. */
export const tokenMatches = (configured: string, presented: string | undefined): boolean =>
  configured !== "" && presented !== undefined && timingSafeEqual(digest(configured), digest(presented))

/** The secret as written, percent-encoded and in base64 (standard and URL-safe, with and without padding). */
export const secretForms = (secret: string): ReadonlyArray<string> => {
  if (secret === "") return []
  const b64 = Buffer.from(secret, "utf8").toString("base64")
  return [...new Set([secret, encodeURIComponent(secret), b64, b64.replace(/=+$/, ""), b64.replace(/\+/g, "-").replace(/\//g, "_"), b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")])]
}

export const holdsSecret = (text: string, secret: string): boolean => secretForms(secret).some((form) => form.length >= 4 && text.includes(form))

export interface HookMessage {
  readonly title: string
  readonly text?: string
  readonly key?: string
}

/** What is wrong with a body (the field's name only; the value is never quoted). */
export const readBody = (body: unknown, secret: string): HookMessage | { readonly problem: string } => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { problem: "body" }
  const b = body as Record<string, unknown>
  for (const name of Object.keys(b)) if (name !== "title" && name !== "text" && name !== "key") return { problem: `field ${name.length <= 20 && /^[A-Za-z0-9_]+$/.test(name) ? name : "unknown"}` }
  if (typeof b.title !== "string" || b.title.trim() === "" || !isLine(b.title, HOOK_TITLE_MAX)) return { problem: "title" }
  if (b.text !== undefined && (typeof b.text !== "string" || b.text.length > HOOK_TEXT_MAX || !/^[^\u0000-\u0007\u000b\u000e-\u001f\ud800-\udfff]*$/u.test(b.text))) return { problem: "text" }
  if (b.key !== undefined && (typeof b.key !== "string" || b.key.length > HOOK_KEY_MAX || !/^[A-Za-z0-9_.:@/-]+$/.test(b.key))) return { problem: "key" }
  for (const [name, value] of [["title", b.title], ["text", b.text], ["key", b.key]] as const) if (typeof value === "string" && holdsSecret(value, secret)) return { problem: name }
  return { title: b.title, ...(typeof b.text === "string" && b.text !== "" ? { text: b.text } : {}), ...(typeof b.key === "string" ? { key: b.key } : {}) }
}

const json = (status: number, body: Readonly<Record<string, unknown>>) => ({ status, body })

/**
 * The one inbound route: `POST /api/modules/notifications/notify`. It needs both the home network (the `lan` guard) and
 * its token (a secret setting, read at each call from what the part started with), sends `normal` only, to every
 * device, and answers machine codes (the caller is a script, not a person). Every text is bounded and is outside text.
 */
export const hookRoute = (notify: ModuleNotify, secret: string | undefined): ModuleRoute => ({
  method: "POST",
  path: "notify",
  guards: ["lan"],
  body: "json",
  bodyLimitBytes: HOOK_BODY_BYTES,
  rateLimit: { perAddress: 10, total: 30 },
  timeoutMs: 5_000,
  description: "Show a notification card on every device. Needs the token in the X-PVA-Token header, from the home network. Priority normal only.",
  handler: (request) =>
    Effect.gen(function*() {
      const configured = secret ?? ""
      // Not set up: refuse everyone, the same for any caller, before anything of the body is read.
      if (configured === "") return json(503, { ok: false, error: "not-set-up" })
      if (!tokenMatches(configured, request.headers[HOOK_TOKEN_HEADER])) return json(401, { ok: false, error: "unauthorised" })
      const message = readBody(request.body, configured)
      if ("problem" in message) return json(400, { ok: false, error: "invalid", field: message.problem })
      const sent = yield* notify
        .send({
          title: message.title,
          ...(message.text !== undefined ? { text: message.text } : {}),
          priority: "normal",
          target: "everywhere",
          expiresInMs: HOOK_EXPIRY_MS,
          ...(message.key !== undefined ? { key: `hook:${message.key}` } : {})
        })
        .pipe(Effect.map((r) => json(202, { ok: true, deduped: r.deduped })), Effect.catch((e: NotifyError) => Effect.succeed(failure(e))))
      return sent
    })
})

const failure = (e: NotifyError) =>
  e.reason === "limit" ? json(429, { ok: false, error: "too-many-open" }) : e.reason === "busy" ? json(503, { ok: false, error: "busy" }) : e.reason === "invalid" ? json(400, { ok: false, error: "invalid" }) : json(502, { ok: false, error: "not-sent" })
