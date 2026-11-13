# @pva/agent-claude-code

The `claude-subscription` harness agent (build plan piece J, `docs/AGENTS-AND-INTENTS.md` §1.8): Claude through the
owner's Claude subscription, by driving Claude Code with `@anthropic-ai/claude-agent-sdk` 0.3.323 as one long-lived
session.

**Off by default, behind an explicit opt-in.** Anthropic's terms do not clearly allow other software to drive Claude
Code with a subscription login (research: `docs/research/agent-backends.md` §2). The assistant never reads or stores
Claude credentials: the owner logs in by running `claude`. Importing the package loads nothing (the SDK is imported
lazily) and spawns nothing until the module starts with the opt-in on.

In the app it is the `claude-subscription` entry of the module catalog and the `claude-subscription` choice of
`LLM_PROVIDER` (Options → Assistant → Language model): the assistant then answers through this agent, read per
turn, so switching the module on or off applies from the next turn (`apps/assistant/src/subscription.ts`).

## How it works

- **Start**: spawns one Claude Code process in streaming-input mode and waits for its `initialize` answer (login, plan,
  model list); a login through an API key (`apiKeySource` other than `none`/`oauth`) is refused. No warm-up message.
- **Warm first turn**: the system prompt and tools are not known at module start, so the first session is
  *provisional*: a fixed short system prompt; the first message carries the real prompt in `<instructions>` and the
  tools are registered with `setMcpServers` just before it. Every later session (restart) is spawned with the real
  prompt and tools.
- **Turn**: catch-up block (§1.4) or, on a new session, the last 20 messages; `<context>`; the text. `text_delta`s →
  `TextDelta` (`llmRequestSent` / `llmFirstToken` marks); tool calls arrive through the in-process MCP server, wait for
  `promoted` unless speculative, run through `input.tools.run`, emit `ToolStarted`/`ToolFinished`, `"\n"` before a tool
  call that follows text; `result` ends the stream. Tool rounds are capped in the handler (`maxToolRounds`).
- **Barge-in**: closing the stream calls `interrupt()` at once; the next turn waits for the interrupted reply's
  `result` (≤ 1 s, else the session is killed and replaced). The session is kept.
- **Failures**: a crash, a stuck interrupt, unexpected tools in `init`, a usage-limit or login error fail the turn as
  `unavailable` (the conversation falls back) and a replacement session is started in the background. 30 s turn limit
  → `timeout`. Sessions are restarted when the prompt or tool list changes, after a crash, and after
  `sessionIdleMinutes` without a turn.
- `speculate` setting (default off): the conversation waits for the end of the turn before sending.

## Safety on a home server (each pinned in `test/pure.test.ts`)

| Property | How |
|---|---|
| No shell, file, web tools | `tools: []` ("Disable all built-in tools"), every built-in also in `disallowedTools`; at the first `init` message the tool list must contain only `mcp__assistant__*` and the only MCP server must be `assistant`, else the session is killed |
| No permission prompt can block a turn | `permissionMode: "dontAsk"` (deny anything not pre-approved), `permissionPrompts: "none"` (nothing ever waits for approval), `allowedTools` = our MCP tools only |
| No project or user settings, CLAUDE.md, hooks, skills, plugins, memory | `settingSources: []`, `skills: []`, `plugins: []`, `settings: { autoMemoryEnabled: false, disableAllHooks: true }`, `strictMcpConfig: true`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `cwd` an empty folder in the temp dir |
| No sessions on disk | `persistSession: false` (live test: no folder under `~/.claude/projects` for the session's cwd) |
| Subscription, not an API key | `apiKeySource` checked at start; `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_*` are never passed (not in the allowlist below) |
| No other secrets reach Claude Code | the process environment is built from an **allowlist** (`ALLOWED_ENV` in `src/options.ts`), not copied: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (both cases), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, plus `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_AGENT_SDK_CLIENT_APP`. Other providers' keys, `PVA_VAULT_PASSWORD`, `NODE_OPTIONS` and anything else in `.env` stay out |

## Measured (live test, 2026-11-13, Haiku 5.5, Max plan, this machine)

| | ms |
|---|---|
| start (spawn + initialize) | 317 |
| turn 1 (provisional session bound), first text / done | 880 / 1316 |
| warm turns 2, 3, 7: first text | 700, 713, 814 |
| interrupt → `result` acknowledged | ≈ 4 (turn closed at 917, acknowledged at 921) |
| turn after interrupt, same session: first text | 775 (it knew what it had been saying) |
| turn with one tool call: first text | 1733 |

## Tests

- `pnpm --filter @pva/agent-claude-code test`: the agent against a scripted fake of `query()` (`test/fakeSdk.ts`):
  deltas, tool calls through the MCP handler, promotion, interrupt and resume, stuck interrupt, crash, prompt/tool
  change, timeout, usage limit, unexpected tools, opt-in; options and catch-up as pure functions.
- Live, opt-in (7 short calls on the owner's subscription):
  `CLAUDE_SUBSCRIPTION_LIVE=1 pnpm --filter @pva/agent-claude-code exec vitest run test/live.test.ts --silent=false`
