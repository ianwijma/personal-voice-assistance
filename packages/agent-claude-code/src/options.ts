import { tmpdir } from "node:os"
import { join } from "node:path"
import { type McpServerConfig, MCP_SERVER_NAME, mcpToolName, type Options } from "./sdk.ts"

/**
 * The `query()` options for a spoken-assistant session, from research §2
 * (measured) and checked against the SDK 0.3.323 type definitions. Every
 * safety property is set explicitly rather than relying on a default, and
 * `test/options.test.ts` pins each one.
 */

/** Claude Code's built-in tools, refused by name as a second line behind `tools: []`. */
export const BUILT_IN_TOOLS = [
  "Agent", "Bash", "BashOutput", "Edit", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "KillShell",
  "ListMcpResourcesTool", "MultiEdit", "NotebookEdit", "Read", "ReadMcpResourceTool", "Skill", "SlashCommand", "Task",
  "TodoWrite", "WebFetch", "WebSearch", "Write"
] as const

/**
 * The only variables of the assistant's environment the Claude Code process gets (fifth review, hardening):
 * an allow-list, so no other secret of the assistant (other providers' API keys, the vault password, Home
 * Assistant tokens) reaches a process that drives a model with tool access. What it needs to run and to
 * find its login: the program path, the home and user (its login is in `~/.claude`, or the macOS keychain),
 * its own configuration directory, a long-lived subscription token if the owner set one up
 * (`claude setup-token`), temporary files, locale and terminal, and proxy and certificate settings when
 * present. Locale and XDG variables are listed by their standard names (sixth review, finding 3: the `LC_`
 * and `XDG_` prefixes let any variable so named through). An inherited proxy variable is passed only when it
 * carries no credentials (`PROXY_ENV`, `proxyHasCredentials`).
 */
export const ALLOWED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TZ",
  "LANG", "LANGUAGE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  // POSIX locale categories (and glibc's extra ones).
  "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE",
  // XDG Base Directory variables.
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Windows: the profile and system folders Node and Claude Code resolve paths with.
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "HOMEDRIVE", "HOMEPATH"
] as const

/** The proxy variables that hold a proxy URL (and so may carry `user:password@`). `NO_PROXY` holds host names only. */
export const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const

/**
 * Whether a proxy URL carries user-info (`user@` or `user:password@`). A value that does not parse as a URL is
 * judged by an `@` before its first `/` after the scheme: when in doubt, it counts as carrying credentials.
 */
export const proxyHasCredentials = (value: string): boolean => {
  for (const candidate of [value, `http://${value}`]) {
    try {
      const url = new URL(candidate)
      if (url.username !== "" || url.password !== "") return true
      if (url.host !== "") return false
    } catch {
      // not a URL in this form
    }
  }
  return /@/.test(value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "")
}

/**
 * The inherited proxy variables that carry credentials (their names only: never the values). They are not
 * passed to the Claude Code process (sixth review, finding 3): a password the assistant was started with is
 * not handed on implicitly. A proxy that needs one is supplied deliberately with the agent's secret setting
 * "Proxy for Claude Code" (`SessionOptionsInput.proxy`), which replaces every inherited proxy URL.
 */
export const credentialProxyVars = (env: Readonly<Record<string, string | undefined>>): Array<string> =>
  PROXY_ENV.filter((key) => {
    const value = env[key]
    return value !== undefined && value !== "" && proxyHasCredentials(value)
  })

/** The settings problem for inherited proxy URLs with credentials (names only), or undefined. */
export const proxyCredentialsProblem = (env: Readonly<Record<string, string | undefined>>, proxy: string | undefined): string | undefined => {
  const vars = credentialProxyVars(env)
  if (vars.length === 0 || (proxy !== undefined && proxy.trim() !== "")) return undefined
  return `The proxy in ${vars.join(", ")} has credentials, which are not passed to Claude Code from the assistant's ` +
    `environment. Enter the proxy address, with its credentials, in this agent's setting "Proxy for Claude Code" ` +
    `(kept as a secret), or remove the credentials from ${vars.length === 1 ? "that variable" : "those variables"}.`
}

/**
 * Never passed, even if a future allow-list entry matched: with an API key or another provider configured,
 * Claude Code would bill that instead of the owner's subscription (and `apiKeySource` would no longer be
 * "none"). None of them is in `ALLOWED_ENV`; kept as the explicit second line (and for the tests).
 */
export const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY"
] as const

/** Used as the system prompt of a session started before the real prompt is known (see `ClaudeSession`). */
export const PROVISIONAL_SYSTEM_PROMPT =
  "You are a spoken personal assistant. The first user message starts with your instructions inside " +
  "<instructions> tags: follow them for the whole conversation. Reply in short plain sentences that sound natural " +
  "when read aloud: no markdown, no lists, no code."

/** An empty working directory: nothing in it to read, and not the assistant's project folder. */
export const SESSION_CWD = join(tmpdir(), "pva-claude-subscription")

export interface SessionOptionsInput {
  readonly model: string
  /** The assistant's effort (absent: Claude Code's default for the model). */
  readonly effort?: "low" | "medium" | "high" | undefined
  /** "adaptive": Claude decides when to think; absent or "off": no extended thinking (the spoken default). */
  readonly thinking?: "off" | "adaptive" | undefined
  readonly system: string
  /** Tool names (without the MCP prefix) the session may call; empty = no MCP server. */
  readonly tools: ReadonlyArray<string>
  /** The MCP server to register at spawn, when `tools` is not empty. */
  readonly mcpServer: McpServerConfig | undefined
  readonly claudePath: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  /** The agent's "Proxy for Claude Code" secret: passed as-is as `HTTPS_PROXY` and `HTTP_PROXY`, replacing inherited proxy URLs. */
  readonly proxy?: string | undefined
  readonly stderr: (line: string) => void
  /** Claude Code's debug logging (`--debug`; it writes debug files under its configuration directory). Off unless a setting enables it. */
  readonly debug?: boolean
}

const allowed = (key: string) => (ALLOWED_ENV as ReadonlyArray<string>).includes(key)

export const sessionEnv = (env: Readonly<Record<string, string | undefined>>, proxy?: string): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && allowed(key)) out[key] = value
  for (const key of STRIPPED_ENV) delete out[key]
  for (const key of credentialProxyVars(out)) delete out[key]
  if (proxy !== undefined && proxy.trim() !== "") {
    for (const key of PROXY_ENV) delete out[key]
    out.HTTPS_PROXY = proxy.trim()
    out.HTTP_PROXY = proxy.trim()
  }
  // Do not load the owner's claude.ai account connectors (Gmail, Drive, ...): research saw them appear otherwise.
  out.ENABLE_CLAUDEAI_MCP_SERVERS = "false"
  out.CLAUDE_AGENT_SDK_CLIENT_APP = "personal-voice-assistant/0.0.0"
  return out
}

export const sessionOptions = (input: SessionOptionsInput): Options => ({
  model: input.model,
  systemPrompt: input.system,
  // No built-in tools at all ("[] (empty array) - Disable all built-in tools"), and refuse them by name too.
  tools: [],
  disallowedTools: [...BUILT_IN_TOOLS],
  // Only our in-process tools are pre-approved; under "dontAsk" anything else is denied without asking,
  // and with permissionPrompts "none" nothing can ever wait for an approval.
  allowedTools: [`mcp__${MCP_SERVER_NAME}__*`, ...input.tools.map(mcpToolName)],
  permissionMode: "dontAsk",
  permissionPrompts: "none",
  // No filesystem settings, CLAUDE.md, hooks, skills or plugins; no MCP config but ours.
  settingSources: [],
  strictMcpConfig: true,
  skills: [],
  plugins: [],
  settings: { autoMemoryEnabled: false, disableAllHooks: true },
  ...(input.tools.length > 0 && input.mcpServer !== undefined ? { mcpServers: { [MCP_SERVER_NAME]: input.mcpServer } } : { mcpServers: {} }),
  // Nothing written to ~/.claude/projects.
  persistSession: false,
  thinking: input.thinking === "adaptive" ? { type: "adaptive" } : { type: "disabled" },
  ...(input.effort !== undefined ? { effort: input.effort } : {}),
  includePartialMessages: true,
  promptSuggestions: false,
  cwd: SESSION_CWD,
  env: sessionEnv(input.env, input.proxy),
  stderr: input.stderr,
  // No debug logs or debug files unless the owner switched them on (the environment above never carries
  // `DEBUG_CLAUDE_AGENT_SDK`, `DEBUG` or `CLAUDE_DEBUG` either).
  debug: input.debug === true,
  ...(input.claudePath !== undefined && input.claudePath.trim() !== "" ? { pathToClaudeCodeExecutable: input.claudePath.trim() } : {})
})
