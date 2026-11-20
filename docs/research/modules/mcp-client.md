# MCP client: any MCP server as a module

Research write-up, 2026-11-17. Not an approved design. It builds on
[landscape-launchers-and-agent-tools.md](../module-investigation/landscape-launchers-and-agent-tools.md) §2.1 and §4,
and on the "MCP bridge module" option in
[module-definition-config-and-dependencies.md](../module-investigation/module-definition-config-and-dependencies.md)
§A.5. **(unverified)** marks claims I could not confirm against a primary source. Latency numbers are to be measured
with `TurnTrace`.

## 1. Summary

The assistant becomes a Model Context Protocol client. The owner adds MCP servers (a local command such as
`npx -y @some/server@1.2.3`, or a remote URL), ticks which of their tools each assistant may use, and those tools join
the tool registry like any module's tools. This is the escape hatch for everything we will not build natively
(GitHub, Obsidian, n8n workflows, a Grocy or Mealie server, Home Assistant's own MCP endpoint) without putting foreign
code in our process. Built-in essentials stay native: they are latency-critical, use typed actions and confirmation,
and must work offline.

- **Priority: second wave.** High value as an escape hatch, but every tool it brings is slower, untrusted and costs
  prompt tokens; the first-wave modules ([core tools](core-tools.md), [web search](web-search.md),
  [memory and notes](memory-and-notes.md)) cover the common needs better.
- **Effort: L.** A read-only client for HTTP servers is M. stdio process management, the allowlist UI (which needs the
  `records` field type that is BUILT, NOT WIRED, current-system.md §6.2), trust levels, OAuth, both protocol revisions
  and the task extension make it L.

## 2. What others do

| Client | Configuration | Tool control | Copy | Avoid |
|---|---|---|---|---|
| Claude Agent SDK / Claude Code ([MCP docs](https://code.claude.com/docs/en/agent-sdk/mcp.md)) | `mcpServers` map: stdio `{ command, args, env }`, `{ type: "http", url, headers }`, `sse`, in-process SDK servers; `.mcp.json` with `${VAR}` expansion | `allowedTools` with `mcp__server__tool` and `mcp__server__*`; tool search defers definitions; `MCP_TIMEOUT` 30 s connect, `MCP_TOOL_TIMEOUT`; results over 25,000 tokens are written to a file | The JSON shape owners already paste from READMEs; status per server (`connected`, `failed`, `needs-auth`, `pending`) | Wildcard allow as the norm |
| Home Assistant ([MCP client](https://www.home-assistant.io/integrations/mcp)) | One config entry per server URL, OAuth supported | Tools go to the conversation agent | Config entry per server | — |
| Hermes Agent (landscape §2.5) | MCP client with a filter of each server's tools | per-server filter | The filter | — |
| Raycast ([AI extensions](https://manual.raycast.com/ai/ai-extensions)) | MCP servers next to extensions | Ask / Auto / Always Allow modes, per-call allow once or always | Permission modes | Auto as the paid default |
| OpenClaw | MCP plus tool groups with allow and deny lists where deny wins ([docs](https://docs.openclaw.ai/tools)) | `group:` allow/deny | Deny wins | ClawHub's unreviewed installs (341 malicious skills of 2,857, landscape §2.5) |
| ChatGPT apps, Claude connectors | Directories of reviewed remote servers, per-app permissions | per-app | Curated, remote-first | Third-party UIs in iframes by default |

The spec itself says clients must treat tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) as untrusted unless the server is trusted, should show which tools are exposed, ask before sensitive
operations and time calls out ([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).

## 3. Example conversations

1. "Hey Jeff, what's on the meal plan this week?" → tool `mealie_get_mealplan` from a Mealie MCP server (community,
   unverified) → "Monday pasta, Tuesday soup, Wednesday is open."
2. "Add 'call the plumber' to my Obsidian daily note." → `obsidian_append_daily` (Obsidian Local REST API's built-in
   MCP endpoint, §5.4) → "Added to today's note." Risk "changes data", trusted server, so no confirmation.
3. "Any new issues on my voice assistant repo?" → `github_list_issues` (GitHub's remote server,
   `https://api.githubcopilot.com/mcp/`) → "Two since yesterday: … and …" On a screen, a `list`. **Screen optional.**
4. "Run the backup workflow." → an n8n MCP Server Trigger tool (landscape-automation-platforms.md §2) marked "changes
   data" and slow → "Started. n8n says it will take about five minutes." The server returns a task handle; the
   result is announced later (§7).
5. **Confirmation:** "Close issue 42." → `github_update_issue` is untrusted-annotated but the owner marked it
   "outward-facing" → core asks "Close issue 42 on GitHub?" "Yes." → done. (Needs confirmations switched on,
   current-system.md §2.5; until then the tool is not offered.)
6. **Elicitation:** a server returns `input_required` asking to pick one of three calendars → "Which calendar: Family,
   Work or Football?" "Family." → the call is retried with the answer.
7. **Ambiguous:** two servers both have `search` → the owner's prefix makes them `notes_search` and `github_search`;
   "search my notes for the boiler" picks the first by name.
8. **Failure:** the stdio server crashed → "The Obsidian connection isn't working right now. I've told the owner in
   Settings." The module status line says "obsidian: exited with code 1, restarting in 30 s".
9. **Failure, needs a screen:** a server asks the user to sign in (URL elicitation) on a speaker → "This needs you to
   sign in on a screen. I've put the link in Settings and on the kitchen screen."

## 4. Tools

The module contributes no fixed tools; it re-exposes the allowlisted tools of each configured server, renamed
`<prefix>_<tool>` (≤ 64 characters, `[a-z0-9_]`, unique across the registry, current-system.md §2.1). Two host tools
are optional:

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `<prefix>_<tool>` (each allowlisted server tool) | the server's `inputSchema`, passed through after checks (§5.6) | text content, cut to 6,000 characters; images to the presentation path | per owner setting, default W | default "changes data"; owner may set safe or outward-facing | network + server; default timeout 8 s | No |
| `find_tool` (only when an assistant has more than about 10 MCP tools) | `query: string` | names and one-line descriptions of matching deferred tools, which become callable on the next round | R | safe | < 5 ms (local BM25) | — |
| `mcp_task_status` | `taskId?` | state of running server tasks | R | safe | < 5 ms | Yes |

## 5. Integrate or build

### 5.1 The client library

The official TypeScript SDK split in v2 into `@modelcontextprotocol/client` and `@modelcontextprotocol/server`
(previously the single `@modelcontextprotocol/sdk`), released alongside the 2026-07-28 revision; by default
`Client.connect()` still performs the 2025 `initialize` handshake and the stateless revision is opted into through
`ClientOptions.versionNegotiation` ([migration notes](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28);
exact option name and current 2.x version unverified). Under the provider-SDK rule it lives only in a new adapter
package, `packages/module-mcp`. Writing our own client on JSON-RPC is possible (the stateless revision is small) but
OAuth, both revisions and stdio framing are where the bugs are; use the SDK.

### 5.2 Both protocol revisions

The [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md): no `initialize`
handshake and no `Mcp-Session-Id`; version and capabilities in every request's `_meta`; a required `server/discover`;
`subscriptions/listen` replaces the GET stream; server-initiated requests (elicitation, sampling, roots) replaced by
multi round-trip requests (`resultType: "input_required"` with `inputRequests`, retried with `inputResponses`); tasks
moved to the extension `io.modelcontextprotocol/tasks` (`tasks/get` polling, `tasks/update`, no `tasks/list`); servers
should return `tools/list` in deterministic order and must send `ttlMs` and `cacheScope`; roots, sampling and logging
deprecated; HTTP+SSE deprecated. Most servers in directories probably still speak 2025-11-25 (landscape §8,
unverified). The client calls `server/discover` first and falls back to `initialize` when it fails. We implement
neither sampling nor roots.

### 5.3 One module or one module per server

| Option | How | For | Against |
|---|---|---|---|
| **A. One `mcp` module, servers in its settings** | A `records` setting lists servers; tools are tools of module `mcp`; per-assistant tool switches through the existing `offTools` | No module-host change; matches module-definition §A.5 | One status line for all servers; one restart restarts all; `offTools` is opt-out, while MCP needs opt-in |
| B. One virtual module per server | The host creates `mcp:<id>` modules at run time | Own card, status, health, enable per assistant | The catalog is compiled in (current-system.md §1.2); dynamic ids are a host change |

Recommendation: **A first, with an opt-in allowlist inside the module's own settings** (a tool is exposed only if
ticked for the server; `offTools` then narrows per assistant). Move to B when the module host supports dynamic
modules. The landscape document §4 assumed B ("each configured server becomes a module instance"); see open question 1.

### 5.4 A vetted starter list

| Server | Transport | Why | Notes |
|---|---|---|---|
| Home Assistant `/api/mcp` ([docs](https://home-assistant.io/integrations/mcp_server/)) | HTTP, OAuth or token | Every entity the owner exposed, without waiting for our native module to grow | Overlaps our `home-assistant` module; useful for domains we lack |
| Obsidian [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) `/mcp/` | HTTPS on `127.0.0.1:27124`, bearer key, self-signed CA | Notes in the owner's vault | Only while Obsidian runs, on that machine |
| GitHub remote server | HTTP `https://api.githubcopilot.com/mcp/`, token header | The owner's repos | Large tool list; allowlist 3–5 tools |
| n8n MCP Server Trigger | HTTP | Owner-built workflows as tools | Each workflow is one tool with its own description |
| Playwright MCP | stdio, Chromium | Browser jobs | Background only; 5–14k tokens of definitions (landscape §3.15, unverified) |

### 5.5 stdio versus HTTP, and what stdio servers bring

| | stdio | Streamable HTTP |
|---|---|---|
| Runs | a child process of our server | anywhere |
| Lifetime | we start, watch and restart it | the server's |
| Native dependencies | whatever it is written in: `node`/`npx`, `python`/`uvx` (needs `uv`), `docker` | none for us |
| Auth | environment variables | headers, OAuth 2.1 |
| Isolation | same user as the assistant unless we add more | network boundary |
| Latency | IPC, small | a LAN or internet hop |

Native dependencies, through [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md)
§C.3: each stdio server declares `{ tool: "npx" | "uvx" | "docker", where: "server" }`. Rules:

- **No unpinned downloads.** `npx -y pkg` and `uvx pkg` fetch the latest version at every start, which is the
  `youtube-dl-exec` anti-pattern module-definition §C.6 warns about. The form requires a version (`pkg@1.4.2`); better,
  an **Install** field action installs it once into `data/mcp/<id>/` (`npm install --ignore-scripts --omit=dev` or
  `uv tool install pkg==1.4.2` with `UV_TOOL_DIR` there) and the command runs from that directory.
- **Docker** is the strongest isolation that is easy: `docker run -i --rm --read-only --network <none|bridge>
  --memory 256m image@sha256:…`. It needs Docker on the server and the assistant user in the `docker` group, which is
  root-equivalent; rootless Podman avoids that (open question 5).
- **Environment:** a stdio child gets only `PATH`, `HOME=data/mcp/<id>/home`, `LANG` and the secrets declared for it,
  never the assistant's own environment (which can hold `PVA_VAULT_PASSWORD`).
- **systemd:** under the installer's hardened unit (`ProtectSystem=strict`, module-definition §C.8) a stdio child
  inherits the sandbox, so `ReadWritePaths` must include `data/mcp/`.
- **Restart:** exponential back-off from 5 s to 5 min; the module status line names the failing server.

Recommendation: **prefer HTTP servers**; allow stdio only from the owner's form with a pinned version or image digest.

### 5.6 Trust levels

| Level | Who sets it | Annotations | Default risk per tool | Results | Speculative |
|---|---|---|---|---|---|
| `untrusted` (default) | — | ignored | "changes data"; `openWorldHint` ignored | wrapped as untrusted data, cut to 6,000 characters, instructions in them not followed | never |
| `trusted` | owner, per server | honoured: `readOnlyHint` → safe + speculative; `destructiveHint` → confirm | from annotations | wrapped | only read-only tools |
| `own` | owner, for servers he wrote | as trusted | as trusted | not wrapped | as trusted |

Two more checks, at every level:

- **Pinned tool definitions.** On approval the client stores a hash of each tool's name, description and schema. When
  `tools/list` later differs (a server update, or a "rug pull" that rewrites a description to inject instructions),
  the changed tool is withdrawn until the owner re-approves, with the diff shown.
- **Description limits.** Descriptions over 1,024 characters are cut; descriptions that mention other tools by name or
  contain "ignore previous" style phrases are flagged in the UI (a heuristic, not a defence).

### 5.7 Tool context, presentation and risk that MCP does not declare

MCP tools know nothing about our device, assistant, person, speech or screens. The owner fills the gap per tool, with
defaults:

| Our concept | MCP source | Default | Owner override |
|---|---|---|---|
| Risk class (module-definition §B.5) | annotations, trusted servers only | "changes data" | safe / changes data / outward-facing / money / security |
| `speculative` | `readOnlyHint` (trusted) | false | on/off |
| Latency class | none | `slow` (filler allowed) | instant / quick / slow / background |
| Timeout | none | 8 s | 1–60 s; longer means a task |
| Spoken name | `title` | `title` or name | text ("my notes") |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | `content` items, `structuredContent`, `_meta.ui.resourceUri` (MCP Apps) | `image` content → `image` through `/media/`; `resource_link` → `handoff`; text → none | map `structuredContent` to `list`, `table` or `facts` with a field mapping |
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) (§4.5) | none | not sent | per server: send `{ language, room }` in `_meta` under `io.pva/turn`; never the person unless the owner ticks it |

MCP Apps (interactive `ui://` HTML in a sandboxed iframe, [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp))
are not rendered: our front ends render only the closed presentation catalogue, and the presentation document defers
an `app` kind (§3.1 and its open question 8). A tool with a UI resource still works; its text content is used.

### 5.8 Elicitation and multi round-trip requests

- Form mode with one enum or boolean field → a spoken question with fixed options, parsed locally like a
  confirmation; several fields or free text → "This needs a screen" and a `confirm`-style card on a screen device.
- URL mode → never spoken; the URL is shown in admin and as a `handoff` on a screen, with the full URL visible (the
  spec requires showing it and asking consent).
- Requests for secrets by form are refused (the spec forbids them in form mode). Keys go only into the vault form.
- Sampling is not offered: a server cannot spend the assistant's model budget.

### 5.9 Tool-count limits

Definitions sit in the cached prefix, and Anthropic reports selection degrading past 30–50 tools and recommends
deferred loading from about 10 ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
Rules: the admin shows each server's token cost (measured by encoding its allowlisted definitions); an assistant's
total MCP tools over 10 switches that assistant to deferred mode (`find_tool` plus the 3–5 most used tools loaded);
a hard cap of 25 MCP tools per assistant. Tool order is deterministic (server order, then name) so the prompt cache
holds. Claude Code's own tool search does the deferral on the subscription path automatically (§12).

### 5.10 Secrets and connections

Each server's settings hold references, not values: `env: { GITHUB_TOKEN: { vault: "mcp.github.token" } }` and
`headers: { Authorization: "Bearer {vault:mcp.github.token}" }`. The vault resolves them at start; a locked vault
leaves the server `locked` (current-system.md §6.3). HTTP servers that need OAuth 2.1 use the
[Connection](../module-investigation/module-definition-config-and-dependencies.md) foundation (§B.4): the 2026 revision
prefers Client ID Metadata Documents over dynamic client registration and requires validating `iss`
([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)). Credentials are keyed by issuer.

## 6. Data

| Collection | Scope | Shape |
|---|---|---|
| `servers` (settings, not store) | household | `{ id, prefix, label, transport: { stdio: { command, args, cwd, image? } } \| { http: { url } }, env, headers, trust, timeoutMs, allow: Record<tool, ToolPolicy> }` |
| `tool_pins` | household | `{ server, tool, hash, approvedAt, definition }` |
| `tasks` | conversation origin, job scope | `{ server, taskId, tool, startedAt, origin, state }` |
| `calls` (optional log) | household | `{ server, tool, ms, ok, bytes, at }` for the admin's cost and latency view |

Servers are owner configuration and belong in `settings.json`, edited as `records` (BUILT, NOT WIRED today). The rest
goes in the [Module store](../module-investigation/shared-state-jobs-and-notifications.md). No other module reads
these.

## 7. Long-running work and events

- **Server tasks** (`io.modelcontextprotocol/tasks`): when a call returns a task handle, the tool returns "started" at
  once and a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) `task` job polls `tasks/get`
  with back-off (2 s up to 30 s) until done, then sends a `result` notification to the origin device. Across a restart
  the handle is in the store, so polling resumes if the server still knows the task.
- **Process supervision** is a scoped fiber per stdio server; restart on exit with back-off.
- **List changes:** on the 2026 revision `subscriptions/listen` with `toolsListChanged`; on 2025 the
  `notifications/tools/list_changed` notification; else re-list after `ttlMs`. A change goes through the pin check
  before it reaches the registry.
- Events emitted: `mcp.server.status`, `mcp.tool.withdrawn`. Listens to: vault unlock (via the host restart that
  exists today).

## 8. Presentation

On a screen: what §5.7 maps, plus a small "via GitHub" origin line on any card from an MCP tool so the owner sees
where it came from. Without a screen: the text content, summarised by the model. Admin shows per server: state,
protocol revision, tool list with ticks, token cost, last error, a **Test** button that calls `tools/list`. The
character shows "working" for `slow` tools.

## 9. Notifications and proactive behaviour

Task results (`normal`, origin device, else inbox). Server failures go to the admin health page as issues, not to
speakers. A server's own notifications (`notifications/message`, progress) are not spoken. A future "server-initiated
announce" would be an [Event bus](../module-investigation/shared-state-jobs-and-notifications.md) bridge and needs its
own design.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | MCP on/off; allow stdio servers; allow Docker; max MCP tools per assistant | on; off; off; 25 |
| Module (per server) | label, prefix, transport (command + args + pinned version or image digest, or URL), env and headers from the vault, trust level, timeout, per tool: exposed, risk, speculative, latency class, spoken name, presentation mapping; send Tool context | —, derived, —, —, untrusted, 8 s, none exposed |
| Assistant | which servers and tools (`offTools` narrows), deferred mode threshold | none |
| Device | none (risk policy per device from module-definition §B.5 applies: a hallway node never gets "security" tools) | — |
| Person | per-person OAuth connections for servers that support it | — |

First run: **Add server** → paste a `mcpServers` JSON snippet from a README (import box, parsed into the form, with
`${VAR}` placeholders turned into vault fields) or fill the form → **Test** lists the tools with their token cost →
tick tools → assign to assistants. Nothing is exposed until ticked.

## 11. Native tools and dependencies

| Dependency | Where | When missing (spoken line) |
|---|---|---|
| `@modelcontextprotocol/client` (npm) | server, inside `packages/module-mcp` | build-time |
| `node`/`npx` | server | Present (we run on Node 22) |
| `uv`/`uvx`, Python | server | That server `unavailable`: "The notes connection needs Python tools that aren't installed." |
| `docker` or `podman` | server | That server `unavailable`, fix: install command shown in Health |
| Remote server reachability | network | "I can't reach GitHub right now." |

Every server's state is a line in the module status and an issue in `pva doctor`
([Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) §C.5).

## 12. Interaction with the rest of the system

**The Claude subscription backend already speaks MCP.** `agent-claude-code` exposes the assistant's registry as an
in-process MCP server named `assistant`, so Claude Code sees `mcp__assistant__<name>`, with all built-in tools disabled
(current-system.md §2.6). MCP tools from this module therefore reach Claude Code as `mcp__assistant__github_list_issues`
with two hops (Claude Code → our in-process server → the remote server). The alternative, passing the owner's servers
straight into Claude Code's `mcpServers`, is cheaper by one hop but bypasses our allowlist, risk classes, confirmation,
pins, timeouts and `TurnTrace`, and only works for that one backend. Recommendation: always through our registry.
Note Claude Code's own limits still apply on that path (`MCP_TOOL_TIMEOUT`, results over 25,000 tokens written to a
file, [docs](https://code.claude.com/docs/en/agent-sdk/mcp.md)); our 6,000-character cut is far below them.

**Voice.** Every MCP tool is `slow` by default: the instructions ask for a lead-in; the canned filler covers silence.
Barge-in cancels the call; on the 2026 revision the request is simply abandoned, on 2025 a cancellation notification is
sent. Server tool names are often English verbs; the owner's spoken name helps the model describe what it did.

**Assistants.** No template. A "Developer" assistant with GitHub tools is the obvious example. The intent path (Jev)
cannot use MCP tools: they have no `examples` or typed params. An owner could wrap one in an action later.

**Other modules.** Native modules win on overlap: if both `home-assistant` and HA's MCP server are on, the instructions
prefer the native tools, and the admin warns about duplicates.

**Being an MCP server** (the other direction) is out of scope; landscape §4 notes the in-process server code exists.

## 13. Privacy and safety

- A server sees every argument the model sends it and can return text that tries to steer the model. Untrusted by
  default, results wrapped, pins on definitions, no sampling.
- Outward-facing tools (send mail, post, close issues) need confirmation, which is switched off today
  (current-system.md §2.5). **Until confirmations are on, only tools the owner marks safe or changes-data may be
  exposed**; outward-facing, money and security tools stay greyed out with that reason.
- No installation by voice and no registry browsing by the assistant. Only the owner adds servers.
- Children's and guest assistants get no MCP tools by default.
- Secrets never pass through the model: env and headers are filled by the host.
- Shared devices: a GitHub issue list on the kitchen screen may be fine; a mail server's results are `personal`
  presentation and are not shown on `shared` devices ([Device capabilities](../module-investigation/presentation-and-device-capabilities.md) §6.1).

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| `records` settings field on the wire (current-system.md §6.2) | the server list and tool ticks | A JSON text setting, edited by hand |
| [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) | per-server state, `pva doctor` | Status line only |
| [Connection](../module-investigation/module-definition-config-and-dependencies.md) | OAuth servers | Token headers only |
| Risk classes and confirmations | outward-facing tools | Read and changes-data tools only |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md), [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) | tasks | Calls that exceed the timeout fail |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | images, lists from structured content | Text only |

Useful first version: HTTP servers only, token headers from the vault, servers as a JSON setting, untrusted level
only, read-only tools only, 8 s timeout, both protocol revisions. That already lets the owner use HA's and Obsidian's
MCP endpoints safely.

## 15. Open questions

1. **One `mcp` module (A) or one module per server (B)?** A needs no host change; B gives each server its own card and
   status. The landscape document assumed B; module-definition §A.5 and this document propose A first.
2. **stdio at all?** Allowing stdio brings Python, uv and Docker onto the server. HTTP-only is safer; is there a stdio
   server you need?
3. **Default trust**: is "untrusted, nothing exposed until ticked" too strict for servers you run yourself (the `own`
   level)?
4. **Confirmation dependency**: should outward-facing MCP tools wait for confirmations to be switched on, or may the
   owner accept them unconfirmed per tool?
5. **Docker or rootless Podman** for isolating stdio servers, given that `docker` group membership is root-equivalent?
6. **Tool context to servers**: may a trusted server receive the room and language? The person's identity?
7. **Tool budget**: is 25 MCP tools per assistant, with deferred loading above 10, the right ceiling?
8. **MCP Apps**: render third-party UIs ever, or text and our catalogue only (the presentation document's open
   question 8)?
