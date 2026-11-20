/**
 * Secrets out of a report (docs/REPORTS.md "Privacy"): a report becomes an issue in a public repository, so everything
 * rendered into it passes here. Two nets: the exact values the server knows are secret (the key vault's, the report
 * token, environment variables with key-like names), and patterns of well-known token formats and of a long value after
 * a key-like name. Neither sees a secret that was encoded, split or retyped; the owner reads the draft before it is sent
 * (unless they chose to send at once).
 */

export const SECRET_MARK = "[secret]"

/**
 * Known values at least this long are replaced wherever they occur; shorter ones (a short password, a PIN) only as a
 * whole word, so "1234" is replaced in "the code is 1234" and not in "12345".
 */
const MIN_KNOWN_LENGTH = 8
/** Known values shorter than this are not looked for at all (one or two characters would match everywhere). */
const MIN_SHORT_LENGTH = 3

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // An HTTP authorization value.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${SECRET_MARK}`],
  // GitHub tokens: classic, OAuth, app and refresh tokens, fine-grained tokens.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, SECRET_MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, SECRET_MARK],
  // OpenAI, Anthropic and similar `sk-` keys; Slack tokens; AWS access key ids; JSON web tokens.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, SECRET_MARK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, SECRET_MARK],
  [/\bAKIA[0-9A-Z]{16}\b/g, SECRET_MARK],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{30,}/g, SECRET_MARK],
  // Credentials in an address: `https://user:password@host` (the user name kept).
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/gi, `$1:${SECRET_MARK}@`],
  // A key-like query parameter: `?key=…`, `&api_key=…`, `appid=…`, `token=…`, `access_token=…`.
  [/([?&](?:key|api[_-]?key|apikey|appid|app[_-]?key|token|access[_-]?token|auth|sig|signature|secret|password)=)[^\s&#"'<>]+/gi, `$1${SECRET_MARK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET_MARK],
  // A long value after a key-like name: `api_key=…`, `"token": "…"`, `PASSWORD: …`.
  [
    /\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|token|secret|password|passwd|passphrase|authorization|auth[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_.~=-]{12,}/gi,
    `$1${SECRET_MARK}`
  ]
]

/** Escape a string for a regular expression. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export interface Scrubber {
  readonly scrub: (text: string) => string
}

/**
 * A scrubber for these known secret values (longest first, so a value that contains another is replaced whole) and the
 * patterns. A short known value (under 8 characters) is replaced only as a whole word, and the text can grow by a
 * few characters there.
 */
export const makeScrubber = (known: Iterable<string | undefined>): Scrubber => {
  const all = [...new Set([...known].filter((v): v is string => typeof v === "string" && v.trim().length >= MIN_SHORT_LENGTH))].sort((a, b) => b.length - a.length)
  const long = all.filter((v) => v.length >= MIN_KNOWN_LENGTH)
  const short = all.filter((v) => v.length < MIN_KNOWN_LENGTH)
  // One alternation of them all (bounded: the vault holds a few dozen keys).
  const exact = long.length === 0 ? undefined : new RegExp(long.slice(0, 500).map(literal).join("|"), "g")
  // A short one only where it stands alone: no letter or digit right before or after it.
  const word = short.length === 0 ? undefined : new RegExp(`(?<![\\p{L}\\p{N}])(?:${short.slice(0, 500).map(literal).join("|")})(?![\\p{L}\\p{N}])`, "gu")
  return {
    scrub: (text) => {
      if (text === "") return text
      let out = exact === undefined ? text : text.replace(exact, SECRET_MARK)
      if (word !== undefined) out = out.replace(word, SECRET_MARK)
      for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
      return out
    }
  }
}

/**
 * Environment variables whose name says they hold a secret: their values are known secrets. Only values of 8
 * characters or more: a short one is as likely a switch (`…_KEY_ENABLED=true`) as a secret, and a short known value is
 * replaced wherever it stands as a word.
 */
export const secretLikeEnvValues = (env: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> =>
  Object.entries(env).flatMap(([name, value]) => (value !== undefined && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|PASS\b|CREDENTIAL/i.test(name) ? [value] : []))
