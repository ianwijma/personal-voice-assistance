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
 * Variables removed from the harness's environment: with an API key or another
 * provider configured, Claude Code would bill that instead of the owner's
 * subscription (and `apiKeySource` would no longer be "none").
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
  readonly system: string
  /** Tool names (without the MCP prefix) the session may call; empty = no MCP server. */
  readonly tools: ReadonlyArray<string>
  /** The MCP server to register at spawn, when `tools` is not empty. */
  readonly mcpServer: McpServerConfig | undefined
  readonly claudePath: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stderr: (line: string) => void
}

export const sessionEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = { ...env }
  for (const key of STRIPPED_ENV) delete out[key]
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
  thinking: { type: "disabled" },
  includePartialMessages: true,
  promptSuggestions: false,
  cwd: SESSION_CWD,
  env: sessionEnv(input.env),
  stderr: input.stderr,
  ...(input.claudePath !== undefined && input.claudePath.trim() !== "" ? { pathToClaudeCodeExecutable: input.claudePath.trim() } : {})
})
