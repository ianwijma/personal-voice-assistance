# Agent and model backends behind one interface (spike)

Research date: 2026-11-13. Host: Node 22.22.1, `claude` 2.1.318, `codex-cli` 0.166.0.
Legend: **[run]** = executed here, numbers measured. **[doc]** = read in current official docs or installed type
definitions, not exercised. **[unverified]** = not checked or not checkable here.
Spike sources (not in the repo): `/workspace/build-cache/ian/claude-tmp/claude-1000/-home-ian--t3-projects-personal-voice-assistance/1f84cbd0-a497-41a3-93a1-c982868074d2/scratchpad/spike-agents/`
(`claude-bench.mjs`, `cli.mjs`, `cdx-probe.mjs`); `node_modules` deleted.

## 1. Recommendation

1. **Two backend kinds behind the interface, not one.**
   - `ModelBackend` (one call, the assistant runs the tool loop): Anthropic API, OpenRouter, and any OpenAI-compatible
     server (Ollama, llama.cpp, LM Studio, vLLM). Streams text and tool-call deltas; the assistant owns tools, history, barge-in
     (abort the HTTP request) and latency.
   - `AgentBackend` (a whole agent that runs its own loop, is handed the assistant's tools, and keeps its own history):
     Claude subscription via the Agent SDK, Codex subscription via `codex app-server`. The assistant sends one user sentence per turn
     and receives text deltas plus, optionally, tool-activity events.
2. **Claude subscription: use `@anthropic-ai/claude-agent-sdk` 0.3.323 in streaming-input mode, one long-lived `query()` per
   conversation.** [run] Measured on this machine with Haiku 5.5, thinking off, tools off: warm median **0.87 s to first text, 1.13 s
   total** (one-sentence answers), cold (new process per turn) median **1.5 s / 1.9 s**. Cold start is cheap enough that
   "spawn per turn" is a valid fallback, but warm wins ~0.6 s. Expose assistant tools as an in-process MCP server
   (`createSdkMcpServer`); a tool round trip cost 3.6 s to first text in my three runs (one tool call = a second model call), so
   keep latency-critical tools (time, simple state) as local fast-paths or prefetched context, not agent tools.
3. **Codex subscription: could not be measured; the CLI here is not logged in** (see §3). Design for `codex app-server`
   (JSON-RPC over stdio; has `item/agentMessage/delta` token deltas, `turn/interrupt`, per-turn `model`/`effort`/`sandboxPolicy`).
   Do **not** build on `@openai/codex-sdk` 0.168.0 for a voice loop: it wraps `codex exec --json`, whose public docs and README only
   describe completed items, not text deltas **[doc]** (not run). Treat Codex as "available once the owner runs `codex login`",
   with an honest "not measured" in the settings screen.
4. **Terms: usable for the owner's own personal tool, but not a stable guarantee.** Anthropic's text permits an end user signing
   in to the *unmodified* Claude Code binary with their own subscription, forbids third-party apps from offering claude.ai login
   or routing others through subscription credentials, and the billing treatment of Agent SDK / `claude -p` usage on
   subscriptions has changed twice in 2026. Ship it as an opt-in, single-owner backend; never collect tokens; keep the API-key
   path as the supported default.
5. **One OpenAI-compatible adapter is enough for OpenRouter and home servers** provided it is written to the lowest common
   denominator (§4). Per-provider quirks live in small "profile" objects (auth header, extra body fields, model-list parser).
6. **Settings screen:** backend kind → connection (API key / base URL / "uses logged-in CLI") → model list (live from
   `/v1/models` or fixed list for the agent backends) → latency options (thinking off by default).

## 2. Claude subscription (Agent SDK / `claude -p`)

### Packages and auth [run]
- `@anthropic-ai/claude-agent-sdk` **0.3.323** (npm `latest`). It ships a platform package (`@anthropic-ai/claude-agent-sdk-linux-x64`)
  containing the Claude Code binary and spawns it; option `pathToClaudeCodeExecutable` can point at the installed `claude`.
- `claude auth status` printed: `loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max"`.
  The SDK `init` message reported `apiKeySource: "none"` (= OAuth subscription, no API key) and `model: claude-haiku-5-5`.
- `--bare` mode ignores OAuth/keychain ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper") **[doc: `claude -p --help`]**,
  so it cannot be used for the subscription path. Use `--tools "" --setting-sources "" --strict-mcp-config` instead.

### Terms of use (quotes)
- Legal page, <https://code.claude.com/docs/en/legal-and-compliance> (fetched 2026-11-13):
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription
    plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK,
    should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party
    developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan
    credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or
    session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription…"
- Agent SDK overview, <https://code.claude.com/docs/en/agent-sdk/overview.md>: "Unless previously approved, Anthropic does not allow
  third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.
  Use the API key authentication methods described in the Quickstart instead."
- Support article <https://support.claude.com/en/articles/15036540> (as summarised by the fetch tool; I could not obtain verbatim
  text): an Oct 7 2026 update says plan-included monthly API credits cover the Agent SDK and `claude -p` only with a Console API key,
  and when signed in with the plan they "still draw from your subscription limits"; a June 15 2026 update says earlier announced
  changes were paused and Agent SDK / `claude -p` / third-party app usage still count against subscription limits.
- **Reading:** a personal, single-owner tool on the owner's machine that drives the unmodified binary with the owner's own login
  looks permitted, and the SDK overview is written for products offered to others. **It is not explicitly blessed for personal
  Agent SDK apps, the wording is restrictive, and billing policy has moved repeatedly. Unclear; confirm with Anthropic before
  relying on it, and do not distribute the app with this backend preconfigured.**

### Minimal code that ran [run] (`claude-bench.mjs`, trimmed)
```ts
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
const options = {
  model: "claude-haiku-5-5",
  tools: [],                                   // no built-in tools at all (Bash/Edit/Read/WebFetch…)
  settingSources: [],                          // ignore user/project settings, CLAUDE.md, hooks
  strictMcpConfig: true,                       // ignore other MCP config
  env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, // do not load claude.ai account connectors (they showed up in `tools` otherwise)
  persistSession: false,                       // no transcript in ~/.claude/projects
  thinking: { type: "disabled" },
  includePartialMessages: true,                // => stream_event / content_block_delta / text_delta
  systemPrompt: "You are a voice assistant. Reply in short plain spoken sentences. No markdown, no lists.",
};
// Warm session: streaming-input mode, one query() for the whole conversation.
const queue = []; let wake;
async function* input() { for (;;) { while (!queue.length) await new Promise(r => (wake = r)); const m = queue.shift(); if (!m) return; yield m; } }
const q = query({ prompt: input(), options });
const iter = q[Symbol.asyncIterator]();         // do NOT `for await ... break`: break closes the generator and ends the session
async function turn(text) {
  queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }); wake?.();
  for (;;) {
    const { value: m } = await iter.next();
    if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") onDelta(m.event.delta.text);
    if (m.type === "result") return m;
  }
}
// Barge-in:    await q.interrupt();  // result arrives with subtype "error_during_execution", terminal_reason "aborted_streaming"
// In-process tools (§ below):
const clock = createSdkMcpServer({ name: "assistant", tools: [tool("get_time", "Current local time", {}, async () => ({ content: [{ type: "text", text: "14:32" }] }))] });
// options.mcpServers = { assistant: clock }; options.allowedTools = ["mcp__assistant__get_time"];
```
Raw CLI equivalent that ran (`cli.mjs`): `claude -p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --model claude-haiku-5-5 --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence
--system-prompt "…"`, writing one JSON user message per line on stdin; deltas arrive as `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta",…}}}`.

### Answers to the specific questions
| Question | Answer |
|---|---|
| Token deltas | `includePartialMessages: true` / `--include-partial-messages` → `stream_event` with `text_delta` [run] |
| Warm session, history | Streaming-input mode: "a persistent, interactive session… long lived process"; the process keeps the conversation, the SDK needs no replay [run: 7 turns in one process]. Docs: single-message mode lacks "Real-time interruption" and "Natural multi-turn conversations" [doc] |
| History after restart | `persistSession` (default true) + `resume`/`continue` [doc]; I disabled persistence |
| Barge-in | `query.interrupt()` [run]: result message 8 ms after the call; later messages can still be sent on the same query [doc: queued messages with ability to interrupt] — resuming after an interrupt was **not** tested |
| Fast model, minimal thinking | `model: "claude-haiku-5-5"` (also tested `claude-sonnet-5-5`); `thinking: {type:"disabled"}`; `effort` option exists (`low…max`) [doc: sdk.d.ts]. CLI: `--effort` [doc] |
| Disable tools / prompts | `tools: []` (docs: "`[]` (empty array) - Disable all built-in tools") [run: `init.tools` was `[]`]. Permission prompts cannot occur with no tools; with the MCP tool, `allowedTools: ["mcp__assistant__get_time"]` auto-approved it [run]. `permissionMode`/`canUseTool`/`--permission-prompts` exist for restricted tool sets [doc] |
| System prompt | `systemPrompt` string replaces the Claude Code prompt [run]; presets with `excludeDynamicSections` exist [doc] |
| In-process tools | `createSdkMcpServer` + `tool()` (zod schemas) [run]; handler runs in the assistant process, no extra OS process. Stdio MCP also possible [doc] |
| Tool latency | haiku, one tool call: first text at 2.47 / 3.05 / 2.53 s (connectors on) and 3.57 / 3.63 s (hardened; the third hardened run did not see the tool and answered "I don't have access", see pitfalls). That is ≈ +1.7–2.2 s over a no-tool turn: it is a second model round trip, not MCP transport cost |

### Measurements [run] — "What's a good name for a goldfish? One sentence."
Time from writing the user message (or from `query()` call for cold) to: first `text_delta` / first sentence end (`[.!?]` followed by
space/end in accumulated text) / `result`. Each row is a median; raw values in brackets. Subscription auth (`apiKeySource: "none"`).

| Backend / mode | n | first text (ms) | first sentence (ms) | total (ms) | Settings |
|---|---|---|---|---|---|
| Claude haiku-5-5, **cold** SDK `query()` per turn, run A | 5 | 1407 [1179–1523] | 1775 | 1789 | tools off, thinking off, settings off; claude.ai connectors still loaded |
| Claude haiku-5-5, **cold**, run B | 5 | 1516 [1262, 1368, 1516, 1777, 3448] | 1889 [1680–3842] | 1907 | + strictMcpConfig, connectors off (one 3.4 s outlier) |
| Claude haiku-5-5, **cold**, raw `claude -p` stream-json | 3 | 1394 [1217, 1394, 2230] | – | 2006 [1652–2525] | same flags via CLI |
| Claude haiku-5-5, **warm**, turn 1 of session | 1+1 | 1172 / 2408 | 1478 / 2807 | 1497 / 2823 | hardened / connectors on (includes process start) |
| Claude haiku-5-5, **warm**, turns 3–7 (hardened) | 5 | **866** [769–935] | **1110** [1081–1231] | **1128** [1097–1250] | turn 2 was 1677 (outlier) |
| Claude haiku-5-5, warm, turns 4–6 (connectors on) | 3 | 918 [837–994] | 1274 | 1288 | |
| Claude sonnet-5-5, **cold** | 5 | 1209 [1095–1366] | 1688 | 1696 | tools off, thinking off, hardened |
| Claude sonnet-5-5, **warm**, turns 2–4 | 3 | 683 [648–777] | 1347 | 1361 | connectors on |
| Claude haiku-5-5 + in-process MCP tool | 3 | 3567 / 3631 (+1 run without tool call) | 3643 | 3656 | hardened |
| **Codex, any mode** | 0 | **not measured** | | | CLI not logged in, see §3 |

Observations: first-token time is ~0.7–0.9 s warm and ~1.2–1.5 s cold; "first sentence" is dominated by how long the model's first
sentence is (Sonnet writes longer ones), so a clause-level TTS splitter beats sentence-level here. Sonnet 5.5 was not slower than Haiku
5.5 to first token in these runs (n is small). Timings are wall-clock on a single machine over several minutes; expect ±0.3 s noise.
~60 model calls were made in total.

### Pitfalls
- `for await (…) { break }` on the SDK iterator closes the generator and ends the session (my first warm run returned nothing for turns 2+). Use manual `iter.next()`.
- With `tools: []` the `init.tools` list still contained `mcp__claude_ai_*` account connectors until `ENABLE_CLAUDEAI_MCP_SERVERS=false` + `strictMcpConfig`. Connectors add startup work and expose the owner's other services to a voice-triggered agent.
- First turn on a fresh session may see no in-process MCP tools (MCP connection is non-blocking; one of three hardened tool runs answered without the tool). `alwaysLoad: true` on the server blocks startup until connected (capped at 5 s) [doc: sdk.d.ts]; not tested.
- `settingSources: []` is needed to avoid loading CLAUDE.md/hooks/skills from the working directory and `~/.claude`.
- `persistSession` defaults to true: every spoken turn is written to `~/.claude/projects/` unless disabled.
- Streaming-input generator errors surface as "Claude Code process aborted by user" [doc].
- Subscription usage is rate-limited per plan; a chatty home assistant shares the pool with the owner's interactive Claude use.
- Not tested: `resume` after interrupt, memory growth of a day-long session, prompt-cache behaviour, `--fallback-model`, rate-limit errors.

## 3. Codex with a ChatGPT subscription

### Packages and state [run]
- `@openai/codex-sdk` **0.168.0** (npm), `@openai/codex` npm latest 0.168.0; installed CLI is 0.166.0.
- **Auth: not logged in.** `codex login status` printed `Not logged in`. `codex exec --json --skip-git-repo-check "Say hi"` emitted
  `thread.started`, `turn.started`, then repeatedly `Reconnecting... N/5 (unexpected status 401 Unauthorized: Missing bearer or basic
  authentication in header, url: wss://api.openai.com/v1/responses …)`, fell back from WebSockets to HTTPS with the same 401, and never
  produced text. (This one probe made no model call that was served.) `codex app-server` → `account/read` returned
  `{"account":null,"requiresOpenaiAuth":true}`.
- **Owner action:** run `codex login` (choose "Sign in with ChatGPT"); on a headless server the auth docs say "prefer device code
  authentication (beta)". Then `codex login status` should show a ChatGPT login. Credentials live in `~/.codex/auth.json`, which the
  docs say to "treat… like a password"; I did not read it.
- Because it was not logged in, **no Codex latency numbers exist** and none of the Codex settings below were exercised against a model.

### Terms [doc]
- Auth page <https://learn.chatgpt.com/docs/auth> (redirect of developers.openai.com/codex/auth): "Sign in with ChatGPT for subscription
  access" vs "Sign in with an API key for usage-based access"; "Use API key authentication for programmatic Codex CLI workflows, such as
  CI/CD jobs."; "API keys are still the recommended default for automation."; "Access tokens are intended for trusted scripts,
  schedulers, and private CI runners."; "Don't expose Codex execution in untrusted or public environments." The page (as summarised
  by the fetch tool) does not mention the SDK or `exec` specifically and I found no explicit rule forbidding a personal tool driving the
  logged-in CLI. **Unclear/undocumented for this use; recommended default for automation is an API key.** Usage draws on the shared
  Codex allowance: <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>.

### Interfaces
| Interface | Facts |
|---|---|
| `codex exec --json` | Flags seen in `--help` [run]: `-m`, `-s/--sandbox`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `--output-schema`, `-c key=value`, `--json`. One process per run. Event types seen: `thread.started`, `turn.started`, `item.completed`, `error` [run, auth failure only]. Whether it emits partial text: **[unverified]** |
| `@openai/codex-sdk` 0.168.0 | `new Codex({env, config, baseUrl})`, `startThread({workingDirectory, skipGitRepoCheck, sandboxMode, modelReasoningEffort, approvalPolicy, webSearchMode…})`, `thread.run()`, `thread.runStreamed()` → `item.completed` / `turn.completed`, `resumeThread(id)`, `signal: AbortSignal` in turn options (types, README) [doc]. "It spawns the CLI and exchanges JSONL events over stdin/stdout." Threads persist in `~/.codex/sessions` |
| `codex app-server` (experimental) | JSON-RPC over stdio. [run] `initialize` OK, `account/read` OK. From the generated schema (`codex app-server generate-ts`, 0.166.0) [doc]: requests `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, `model/list`, `account/read`, `mcpServerStatus/list`; notifications `item/agentMessage/delta` (`{threadId, turnId, itemId, delta}`), `item/reasoning/*`, `item/completed`, `turn/completed`; `turn/start` takes `model`, `effort`, `approvalPolicy` (`never`…), `sandboxPolicy` (`readOnly`, `workspaceWrite`, …), `cwd`; `thread/start` takes `baseInstructions`, `developerInstructions`, `ephemeral`, `config`, `sandbox`. A server request `item/tool/call` and type `DynamicToolSpec` exist, which suggests client-defined tools; **how to register them was not found in `ThreadStartParams`** [unverified] |
| MCP server mode | `codex mcp` in 0.166.0 only manages *external* MCP servers (`list/get/add/remove/login/logout`); I found no `codex mcp-server` subcommand in this version [run `--help`]. Custom tools for Codex therefore go through an MCP server the assistant hosts (stdio or HTTP) registered via `-c mcp_servers.<name>…` / config [doc, not exercised] |
| Models | `~/.codex/models_cache.json` (non-secret) lists slugs with default reasoning level and supported efforts (`low, medium, high, xhigh, max, ultra`), e.g. `gpt-6.1-sol` (default `low`), `gpt-6-luna`, `gpt-5.6-luna`. Which is fastest: **[unverified]**; `model/list` after login returns the authoritative list |

### Planned minimal code (NOT RUN — the CLI is not logged in)
```ts
// app-server: one process, one thread, many turns
const p = spawn("codex", ["app-server"], { stdio: ["pipe","pipe","inherit"] });
rpc("initialize", { clientInfo: { name: "voice", title: "voice", version: "0" } });   // this much ran
rpc("thread/start", { model: "<fast model from model/list>", ephemeral: true, sandbox: "read-only",
  approvalPolicy: "never", baseInstructions: "Reply in short spoken sentences.",
  config: { /* mcp_servers.assistant = { url | command } */ } });
rpc("turn/start", { threadId, input: [{ type: "text", text }], effort: "low" });
// stream: notification "item/agentMessage/delta" → onDelta(params.delta); "turn/completed" → done
// barge-in: rpc("turn/interrupt", { threadId, turnId })
```
Expected cost shape for a Codex-style harness: the system prompt carries Codex's own large agent instructions and tool definitions (shell, patch,
etc.) unless disabled — **[unverified]**; this is why TTFT with Codex is expected to be worse than with a bare API, but that is a hypothesis, not a measurement.

### Pitfalls (Codex)
- The harness is a coding agent: even with `sandbox: read-only` and `approvalPolicy: never` the shell tool is still *offered* to the model; I did not find an option to remove it [unverified]. Use `developerInstructions` and a read-only sandbox, and treat answers as untrusted.
- A failed login does not fail fast: `exec` retried 5× over WebSocket then 5× over HTTPS (~10 s) before surfacing. Check `account/read` (or `codex login status`) at startup and refuse to start the backend if not logged in.
- `@openai/codex-sdk` requires a git working directory unless `skipGitRepoCheck`.
- App-server is marked experimental; schema churn between 0.166 and 0.168 is possible.

## 4. OpenAI-compatible chat completions: one adapter?

**Verdict: yes, if the adapter sticks to the common subset** — `POST {base}/chat/completions` with `stream: true`, `messages`, `tools`,
`tool_calls` deltas assembled by `index`, `Authorization: Bearer <key or placeholder>`, and `GET {base}/models`. Not run: no API key for
OpenRouter and no local server on this machine, so **no time-to-first-token was measured**; everything below is **[doc]** or from the
live OpenRouter catalogue (`GET https://openrouter.ai/api/v1/models`, public, fetched 2026-11-13, 475 models).

| Concern | OpenRouter | Ollama | llama.cpp `llama-server` | LM Studio | vLLM |
|---|---|---|---|---|---|
| Base URL | `https://openrouter.ai/api/v1` | `http://host:11434/v1` | `http://host:8080/v1` | `http://host:1234/v1` | `http://host:8000/v1` |
| Auth | Bearer key required | "requires an API key value, but Ollama ignores it" (local) | optional `--api-key` / `LLAMA_API_KEY` (`/health` exempt) | not documented on the page I read | `--api-key`/`VLLM_API_KEY`; docs: "Do not rely on `--api-key` alone to secure vLLM" |
| Model list | `GET /models`, rich: `context_length`, `pricing`, `supported_parameters`, `reasoning.supported_efforts` | `GET /v1/models` (`created` = last modified) | `/v1/models` returns "one single element" (the loaded model; `--alias`) | `GET /v1/models` | `/v1/models` (not on the page I fetched; **unverified**) |
| Streaming | SSE; sends `: OPENROUTER PROCESSING` comment lines (skip lines starting `:`); errors mid-stream as chunk with top-level `error` and `finish_reason: "error"` (HTTP stays 200); final usage chunk before `[DONE]` | SSE | SSE | not documented there | SSE (`stream_interval` batches tokens) |
| Tool-call deltas | Standard; `parallel_tool_calls` default true; `require_parameters` to avoid providers that ignore `tools` | supported on chat completions; `tool_choice` **unsupported** | needs a template with tool support (`--jinja`) | "Tool Use" has its own page (not read) | needs `--enable-auto-tool-choice --tool-call-parser` (**not confirmed from the page I fetched**) |
| Reasoning control | `reasoning: {effort}` / `reasoning_effort`; per-model `supported_efforts` incl. `none` in the catalogue | `reasoning_effort`; levels per model, `none`→off, GPT-OSS cannot be disabled (maps to `low`) | `--reasoning-budget 0`, `--reasoning-format`; per request `reasoning_format` | not documented there | `chat_template_kwargs` (template-specific); reasoning parser flag |
| Warm/keep-alive | n/a (hosted) | model stays loaded for `keep_alive` (default 5 min; the OpenAI endpoint docs say nothing about `keep_alive`, so set `OLLAMA_KEEP_ALIVE` on the server) | `cache_prompt` default true; slots/`--keep` | idle TTL page exists (not read) | prefix cache (flag not confirmed) |
| Latency routing | `provider: {sort: "latency" \| "throughput", preferred_max_latency: {p50: 1, p90: 3}, preferred_min_throughput, order, allow_fallbacks, require_parameters}`; `:nitro` suffix = throughput sort; soft preferences | — | — | — | — |

Differences to code for: (a) reasoning text may arrive in a separate field (`delta.reasoning` / `reasoning_content`) — never speak it;
(b) some servers emit the whole `tool_calls[].function.arguments` in one chunk, others in fragments — always accumulate by `index`;
(c) `tool_choice`/`stream_options` may be rejected by local servers — send only when needed; (d) usage chunk has empty `choices` on some
servers; (e) local servers accept any key but still want a non-empty `Authorization`; (f) OpenRouter-only body fields (`provider`,
`reasoning`) must be gated per profile, since strict servers may 400.

### Fast models that exist today (OpenRouter catalogue, 2026-11-13; price = USD per token prompt/completion)
- `anthropic/claude-haiku-5.5` (1M ctx, 1e-7 / 5e-7; efforts incl. `none`), `anthropic/claude-sonnet-5.5` (2e-6 / 1e-5; reasoning mandatory).
- `openai/gpt-6-luna` (1.05M ctx, 1e-7 / 5e-7, efforts incl. `none`), `openai/gpt-5.6-luna` (2e-7 / 1.2e-6), `openai/gpt-5.4-nano` (2e-7 / 1.25e-6), `openai/gpt-4.1-nano`.
- `google/gemini-3.8-flash` (8.25e-7 / 4.1e-6), `minimax/minimax-m3.1-flash`, `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.8-flash`, `z-ai/glm-5.3-flash` (very cheap).
- Open weights for the home server (present in the catalogue, so they exist as of today): `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `meta-llama/llama-3.1-8b-instruct`, `meta-llama/llama-4-scout`, `qwen/qwen3.8-27b`, `mistralai/ministral-8b-2512`. Which quantised build runs well on the owner's GPU: **[unverified]**.
- Which is actually fastest to first token: **[unverified]**; measure with the project's `TurnTrace`. Expectation from general knowledge, not sources found today and **not measured**: hosted small models typically 0.3–0.8 s TTFT over the internet; a warm local 7–8B on a decent GPU 0.1–0.3 s; a cold local model load is multiple seconds, hence keep-alive.

### Pitfalls
- OpenRouter catalogue marks reasoning "mandatory" for several models (cannot be turned off → slow first token); filter the settings-screen list by `reasoning.mandatory === false` or `supported_efforts` containing `none` for voice.
- Local servers list only what is loaded (llama.cpp) or installed (Ollama); loading a not-yet-loaded model on first request costs seconds.
- OpenRouter errors can arrive as HTTP 200 + SSE error chunk after the stream starts.
- Aborting the fetch cancels generation only on providers that support it; otherwise you may still be billed for the full reply.

## 5. How the backends sit behind one interface

```ts
// Common surface the conversation loop sees
interface Backend {
  readonly kind: "model" | "agent";
  warm(): Effect<void>;                                   // spawn process / open connection / ping model
  turn(input: { text: string; tools: ToolDef[]; signal: AbortSignal }): Stream<BackendEvent>;
  // BackendEvent = TextDelta | ToolStarted | ToolFinished | Done | Failed
}
```
- **`ModelBackend` (Anthropic API, OpenRouter/OpenAI-compatible):** `turn` is one HTTP call; when the stream ends with tool calls, the
  *assistant* executes them via its own `ToolRegistry`, appends results and calls `turn` again. Assistant owns history and can cache,
  trim and persist it; barge-in = abort the request; TTFT is the model's own. Tool round trip = one extra model call (same as the
  Claude-agent measurement, ≈ +2 s) but fully traceable in `TurnTrace`.
- **`AgentBackend` (Claude Agent SDK, Codex app-server):** `turn` sends only the new user sentence; the harness keeps history, runs
  its own loop and calls the assistant's tools back (in-process MCP for Claude; MCP server the assistant hosts for Codex). Consequences:
  (1) history lives in the harness: switching backends mid-conversation loses context unless the assistant replays a transcript
  into the new session; (2) the harness's system prompt/tool schema overhead is outside the assistant's control; (3) tool
  calls are executed by the agent, so the assistant's `ToolRegistry` is reached through an MCP shim and timing appears only as
  `ToolStarted/ToolFinished` events; (4) interruption goes through `query.interrupt()` / `turn/interrupt`, then the assistant must
  re-establish the next turn on the same session; (5) quota and terms risk are tied to a consumer subscription; (6) startup must
  be hidden by `warm()` at boot; (7) the agent can spontaneously act (long tool chains), so cap with max turns and a turn timeout.
- Settings screen exposes `kind` implicitly: agent backends get a "Warm at startup" toggle and an "uses your subscription" notice;
  model backends get model picker, base URL, key.
- Conversation loop must not depend on `kind`; it consumes `BackendEvent`s. Keep a `TurnTrace` span per backend event
  (`first_text_delta`, `first_sentence`, `tool_started`, `done`) so the numbers in §2 can be re-measured by the owner from the UI.

## 6. Not run / unverified (summary)
1. Any Codex measurement, `codex exec` partial-text events, app-server `thread/start`/`turn/start` against a model, dynamic tool registration, MCP custom tools with Codex, Codex's offered built-in tools under read-only sandbox.
2. Any OpenAI-compatible endpoint timing (OpenRouter, Ollama, llama.cpp, LM Studio, vLLM); vLLM `/v1/models`, tool parser flags and prefix-caching flag; LM Studio auth/tool-use/TTL pages; Ollama `keep_alive` via the OpenAI endpoint.
3. Claude: resuming after `interrupt()`, long-session behaviour, `effort` option effect, `alwaysLoad` MCP, stdio MCP latency, rate-limit errors, results with the system-installed `claude` binary instead of the bundled one, whether any Anthropic statement covers personal Agent SDK apps (verbatim support-article text was not obtained).
4. Latency numbers are from one machine, n = 3–7 per row, subscription traffic over the public internet; treat ±0.3 s as noise.
