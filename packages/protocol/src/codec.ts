import { Result, Schema } from "effect"
import { ClientMessage } from "./client.ts"
import { MAX_TEXT_FRAME_BYTES } from "./constants.ts"
import { ServerMessage } from "./server.ts"

/**
 * Result of decoding a text frame.
 * - `Ok`: a valid message.
 * - `Unknown`: valid JSON with a `type` this build does not know. Receivers
 *   ignore it (and may count it), so an older peer survives a newer optional message.
 * - `Invalid`: not JSON, no `type`, too large, or a known type that failed
 *   validation. The server answers `error` with code `bad_message`; the client logs it.
 */
export type DecodeResult<M> =
  | { readonly _tag: "Ok"; readonly message: M }
  | { readonly _tag: "Unknown"; readonly messageType: string }
  | { readonly _tag: "Invalid"; readonly reason: string; readonly messageType?: string }

const makeDecoder = <M>(
  schema: Schema.Codec<M, unknown> & { readonly cases: object }
) => {
  const decode = Schema.decodeUnknownResult(schema)
  return (text: string): DecodeResult<M> => {
    if (text.length > MAX_TEXT_FRAME_BYTES) return { _tag: "Invalid", reason: `text frame too large (${text.length} characters)` }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { _tag: "Invalid", reason: "not valid JSON" }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { _tag: "Invalid", reason: "not a JSON object" }
    }
    const type: unknown = (parsed as { readonly type?: unknown }).type
    if (typeof type !== "string") return { _tag: "Invalid", reason: "missing \"type\"" }
    if (!Object.hasOwn(schema.cases, type)) return { _tag: "Unknown", messageType: type }
    const result = decode(parsed)
    return Result.isSuccess(result)
      ? { _tag: "Ok", message: result.success }
      : { _tag: "Invalid", reason: result.failure.message, messageType: type }
  }
}

/** For the assistant: decode a text frame from a browser. */
export const decodeClientMessage: (text: string) => DecodeResult<ClientMessage> = makeDecoder(ClientMessage)

/** For the browser: decode a text frame from the assistant. */
export const decodeServerMessage: (text: string) => DecodeResult<ServerMessage> = makeDecoder(ServerMessage)

const encodeClient = Schema.encodeSync(ClientMessage)
const encodeServer = Schema.encodeSync(ServerMessage)

/**
 * For the browser: validate and serialise a message. Throws on an invalid
 * message (a programming error, not a runtime condition).
 */
export const encodeClientMessage = (message: ClientMessage): string => JSON.stringify(encodeClient(message))

/** For the assistant: validate and serialise a message. Throws on an invalid message. */
export const encodeServerMessage = (message: ServerMessage): string => JSON.stringify(encodeServer(message))
