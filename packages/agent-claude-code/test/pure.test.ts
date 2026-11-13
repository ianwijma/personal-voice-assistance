import { describe, expect, it } from "@effect/vitest"
import type { Message } from "@pva/core"
import { catchUpBlock, composeMessage, primeBlock, sessionEnv, sessionOptions, SESSION_CWD } from "../src/index.ts"

const ctx = { selfId: "claude-subscription", selfName: "Claude subscription" }
const say = (agentId: string | undefined, content: string, extra: object = {}) =>
  ({ role: "assistant", content, ...(agentId !== undefined ? { agentId } : {}), ...extra }) as Message

describe("session options (safety)", () => {
  const options = sessionOptions({
    model: "claude-haiku-5-5",
    system: "Be brief.",
    tools: ["lights_on"],
    mcpServer: { type: "sdk", name: "assistant" } as never,
    claudePath: undefined,
    env: { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk", ANTHROPIC_BASE_URL: "http://x" },
    stderr: () => {}
  })

  it("disables the harness's own tools, prompts, settings, memory, hooks, skills, plugins and persistence", () => {
    expect(options.tools).toEqual([])
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch", "Task", "Skill"]))
    expect(options.permissionMode).toBe("dontAsk")
    expect(options.permissionPrompts).toBe("none")
    expect(options.allowedTools).toEqual(["mcp__assistant__*", "mcp__assistant__lights_on"])
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.skills).toEqual([])
    expect(options.plugins).toEqual([])
    expect(options.settings).toEqual({ autoMemoryEnabled: false, disableAllHooks: true })
    expect(options.persistSession).toBe(false)
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["assistant"])
    expect(options.cwd).toBe(SESSION_CWD)
  })

  it("streams text, no thinking, our system prompt", () => {
    expect(options.includePartialMessages).toBe(true)
    expect(options.thinking).toEqual({ type: "disabled" })
    expect(options.systemPrompt).toBe("Be brief.")
    expect(options.model).toBe("claude-haiku-5-5")
  })

  it("strips API keys (the subscription must be used) and turns off account connectors", () => {
    const env = sessionEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1" })
    expect(env).toEqual({ PATH: "/usr/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_AGENT_SDK_CLIENT_APP: "personal-voice-assistant/0.0.0" })
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(options.env?.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it("registers no MCP server without tools", () => {
    const bare = sessionOptions({ model: "m", system: "s", tools: [], mcpServer: undefined, claudePath: " /opt/claude ", env: {}, stderr: () => {} })
    expect(bare.mcpServers).toEqual({})
    expect(bare.pathToClaudeCodeExecutable).toBe("/opt/claude")
  })
})

describe("catch-up (§1.4)", () => {
  const history: Array<Message> = [
    { role: "user", content: "Hi" },
    say("claude-subscription", "Hello there."),
    { role: "user", content: "turn on the lights" },
    say("jev", "Living room lights on."),
    { role: "user", content: "what's the weather" },
    say("anthropic", "Let me check.", { toolCalls: [{ id: "1", name: "weather", input: {} }] }),
    { role: "tool", results: [{ id: "1", name: "weather", content: "{}", isError: false }] },
    say("anthropic", "Rain, 12 degrees.")
  ]

  it("drops its own previous turn and lists the rest, tool messages omitted", () => {
    expect(catchUpBlock(history, 0, ctx)).toBe(
      "<earlier>\nUser: turn on the lights\nJev: Living room lights on.\nUser: what's the weather\nAnthropic: Let me check.\nAnthropic: Rain, 12 degrees.\n</earlier>"
    )
  })

  it("nothing missed → no block", () => {
    expect(catchUpBlock(history.slice(0, 2), 0, ctx)).toBeUndefined()
    expect(catchUpBlock(history, history.length, ctx)).toBeUndefined()
  })

  it("keeps a note when its own reply was interrupted", () => {
    const h: Array<Message> = [{ role: "user", content: "Tell me a story" }, say("claude-subscription", "Once upon a", { interrupted: true })]
    expect(catchUpBlock(h, 0, ctx)).toBe("<earlier>\n(You were interrupted; the owner heard only: \"Once upon a\")\n</earlier>")
  })

  it("does not drop a turn another agent answered", () => {
    const h: Array<Message> = [{ role: "user", content: "Hi" }, say("jev", "Yes?")]
    expect(catchUpBlock(h, 0, ctx)).toBe("<earlier>\nUser: Hi\nJev: Yes?\n</earlier>")
  })

  it("primes a new session with the last 20 messages", () => {
    const long: Array<Message> = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? { role: "user", content: `q${i}` } : say("jev", `a${i}`)))
    const block = primeBlock(long, ctx)!
    expect(block.split("\n").slice(1, -1)).toHaveLength(20)
    expect(block).toContain("User: q10")
    expect(block).not.toContain("q8")
    expect(primeBlock([], ctx)).toBeUndefined()
    expect(primeBlock([say("claude-subscription", "Hi")], ctx)).toBe("<earlier>\nYou: Hi\n</earlier>")
  })

  it("composes the message: instructions, earlier, context, text", () => {
    expect(composeMessage({ text: "Hi" })).toBe("Hi")
    expect(composeMessage({ instructions: "I", earlier: "<earlier>\nE\n</earlier>", context: "C", text: "T" })).toBe(
      "<instructions>\nI\n</instructions>\n\n<earlier>\nE\n</earlier>\n\n<context>\nC\n</context>\n\nT"
    )
    expect(composeMessage({ context: "  ", text: "T" })).toBe("T")
  })
})
