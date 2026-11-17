import { Data } from "effect"

/** The rule that refused a request. */
export type RefusedRule =
  | "scheme" // not http or https
  | "credentials" // user:password in the URL
  | "port" // a port other than 80 or 443 (unless allowLan)
  | "host-name" // .local, .lan, .home.arpa, .internal, .localhost or a name without a dot (unless allowLan)
  | "address" // the host is, or resolves to, a non-public address
  | "redirect-limit" // more redirects than allowed
  | "redirect-target" // a redirect without a usable Location

/** A rule refused the URL, before or during the request. `detail` is for people; never contains response data. */
export class NetRefused extends Data.TaggedError("NetRefused")<{
  readonly rule: RefusedRule
  readonly url: string
  readonly detail: string
  /** For `address`: the address that was refused and its class. */
  readonly address?: string
  readonly addressClass?: string
}> {
  override get message(): string {
    return `Refused (${this.rule}): ${this.detail}`
  }
}

/** The response is bigger than `maxBytes` (said by Content-Length, or counted while reading). */
export class NetTooLarge extends Data.TaggedError("NetTooLarge")<{ readonly url: string; readonly limit: number }> {
  override get message(): string {
    return `Response larger than ${this.limit} bytes`
  }
}

/** The total time limit (including redirects and reading the body) ran out. */
export class NetTimeout extends Data.TaggedError("NetTimeout")<{ readonly url: string; readonly timeoutMs: number }> {
  override get message(): string {
    return `No complete response within ${this.timeoutMs} ms`
  }
}

/** The caller's `AbortSignal` fired. (Effect interruption just interrupts; it has no error.) */
export class NetAborted extends Data.TaggedError("NetAborted")<{ readonly url: string }> {
  override get message(): string {
    return "Aborted"
  }
}

/** DNS, connection or protocol failure. */
export class NetFailure extends Data.TaggedError("NetFailure")<{
  readonly url: string
  readonly stage: "dns" | "connect" | "response"
  readonly detail: string
}> {
  override get message(): string {
    return `Request failed (${this.stage}): ${this.detail}`
  }
}

export type SafeFetchError = NetRefused | NetTooLarge | NetTimeout | NetAborted | NetFailure

/** `getJson`: the server answered with a status that is not a success. */
export class NetHttpStatus extends Data.TaggedError("NetHttpStatus")<{ readonly url: string; readonly status: number }> {
  override get message(): string {
    return `HTTP ${this.status}`
  }
}

/** `getJson`: the body is not JSON. */
export class NetBadJson extends Data.TaggedError("NetBadJson")<{ readonly url: string; readonly detail: string }> {
  override get message(): string {
    return `Not JSON: ${this.detail}`
  }
}

export type CachedJsonError = SafeFetchError | NetHttpStatus | NetBadJson
