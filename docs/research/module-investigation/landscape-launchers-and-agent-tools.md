# Landscape: launchers and AI-agent tool ecosystems

Research slice for the module investigation, written 2026-11-17. It looks outward: what launchers (Raycast, Alfred and
friends) and agent platforms (MCP, ChatGPT, Claude, Gemini, OpenClaw, Hermes and others) give their users, which of
those capabilities a household voice assistant should have, and how to build them on our Node/TypeScript server. The
companion document [current-system.md](current-system.md) describes what our module system can do today; gap numbers
like "gap 8" below refer to its §9.

Conventions. Sources are linked inline. **(unverified)** marks a claim I could not confirm against a primary source
(vendor numbers that only appear in third-party write-ups, figures from memory, or sources that contradict each other).
Prices are list prices seen in November 2026 and change often. Every latency figure here is a vendor's or a third
party's number, not ours: per CLAUDE.md, a latency claim for this project needs `TurnTrace` numbers, so each figure
below is something to measure, not a result.

## Summary

- **The everyday core is small and stable.** People use voice assistants for weather, music, quick answers, and timers
  or alarms. A YouGov poll reported in 2025 found weather 59 %, music 51 %, quick answers 47 %, timers and alarms 40 %,
  with smart home at 19 % and third-party apps at 9 %
  ([YouGov](https://yougov.com/en-us/articles/52780-americans-use-digital-assistants-mainly-for-weather-music-and-timers),
  [9to5Mac](https://9to5mac.com/2025/08/20/seven-years-later-people-still-havent-changed-how-they-use-siri/)). Launchers
  show the same pattern for desktop use: the most-used tools are small utilities like a calculator that understands units,
  currencies, time zones and dates, plus clipboard, snippets, translate, colour and kill-process.
- **We are missing the essentials.** Of that core we have weather and a clock. We lack web search, page reading, a
  calculator, currency conversion, timers, alarms, reminders, music, and a lookup source (Wikipedia). Timers, reminders
  and "answer later" all need **proactive speech and a scheduler**, which our module system does not have (gaps 7, 8
  and 17). That is the biggest architectural item this survey turns up.
- **One rich calculator beats ten converters.** Raycast and Alfred's "Calculate Anything" put arithmetic, units,
  currencies, percentages, time zones and date arithmetic behind one input box
  ([Raycast manual](https://manual.raycast.com/calculator)). For us, one `calculate` tool and one `time` tool replace a
  dozen narrow ones, and fewer tools means a shorter prompt and better tool choice.
- **Web search: one interface, several providers.** Search APIs now cost about $5–15 per 1,000 queries. Brave and the
  Perplexity Search API are about $5 per 1,000, Exa about $7, Tavily $8, the Anthropic and OpenAI built-in tools $10 plus
  tokens, Gemini grounding $14 per 1,000 after 5,000 free a month, and Kagi FastGPT $15. A self-hosted SearXNG instance
  costs nothing per query. For a spoken answer we want short snippets (three to five results, title, snippet, date) and
  no page bodies. Fetching a page is a separate, slower step.
- **MCP is the common plug, and it changed a lot in 2026.** The 2026-07-28 spec made the protocol stateless, moved
  tasks and MCP Apps (interactive HTML results) into official extensions, and replaced server-initiated elicitation with
  "multi round-trip requests" ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)).
  ChatGPT apps, Claude connectors, Raycast AI, Home Assistant, OpenClaw and Hermes all consume MCP.
- **We should be an MCP client, as one module type and not the whole module system.** Each configured server becomes a
  module with a per-tool allowlist, a timeout, a trust level and the vault for its secrets. Built-in essentials stay
  native, because they are latency-critical, need our typed actions and confirmations, and must work offline. The
  costs of MCP are tool-count bloat (the GitHub server alone is about 55k tokens of tool definitions
  ([Unblocked](https://getunblocked.com/blog/github-mcp-token-cost/), unverified)), an extra process or network hop per
  call, and trust. ClawHub, OpenClaw's skill registry, shows what an open marketplace without review costs: hundreds of
  malicious skills ([eSecurity Planet](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub)).
- **Every tool call costs a model round trip.** Our own measurement on the Claude subscription path was 3.6 s to first
  text after one tool call ([agent-backends.md](../agent-backends.md)). The cheapest tool is the one the model never
  calls. Translation, definitions and rough unit facts can stay with the model. Tools are for what the model cannot know
  (now, prices, weather, the web) or cannot compute exactly (arithmetic, dates).

## 1. Launchers

### 1.1 Raycast

**Built-in commands.** Raycast ships a calculator, clipboard history, snippets, quicklinks, window management, notes,
emoji, file search, calendar, reminders, focus, system commands and a translator, plus weather, flight tracker, travel
time and colour conversion results in root search ([calculator manual](https://manual.raycast.com/calculator)). The
calculator covers:

- units, including CSS and design units ("2 inches in px at 72 ppi")
- currencies, with refreshable rates, shorthand like "10K" and minor units, plus crypto
- time zones by city or airport ("5pm ldn in sf", "time in JFK"), offsets ("time in 4 hours"), Unix and ISO timestamps
- date arithmetic ("monday in 3 weeks"), week numbers, workdays
- durations ("10pm to 2am", "transfer 1 TB at 100 Mbps")
- percentages, tips, discounts, compound interest
- bases and fractions
- three months of history

**Most installed store extensions.** The store's "Most Popular" page, read on 2026-11-17
([page 1](https://www.raycast.com/store/popular), [page 2](https://www.raycast.com/store/popular/2)):

| # | Extension | Installs | # | Extension | Installs |
|---|---|---|---|---|---|
| 1 | Kill Process | 809k | 11 | ChatGPT | 270k |
| 2 | Color Picker | 644k | 12 | 1Password | 264k |
| 3 | Google Chrome | 593k | 13 | Arc | 261k |
| 4 | Google Translate | 518k | 14 | GitHub | 220k |
| 5 | Spotify Player | 510k | 15 | Speedtest | 195k |
| 6 | Visual Studio Code | 430k | 16 | Obsidian | 185k |
| 7 | Linear | 417k | 17 | Coffee (keep awake) | 163k |
| 8 | Slack | 349k | 18 | Apple Notes | 162k |
| 9 | Brew | 309k | 19 | Google Search | 158k |
| 10 | Notion | 292k | 20 | Video Downloader | 142k |

Install counts measure trial, not retention
([Lilach Bullock](https://www.lilachbullock.com/?p=180303)). The list still shows what people reach for: system
control (kill process, keep awake, speed test), translation, music control, notes, search and work tools.

**Manifest.** An extension is a superset of npm's `package.json`
([manifest docs](https://developers.raycast.com/information/manifest)). It declares:

- `commands`: each has `name` (the entry file), `title`, `description` and `mode`. The mode is `view`, `no-view` or
  `menu-bar`, and an `interval` (at least `1m`) runs no-view and menu-bar commands in the background.
- `arguments`: typed `text`, `password` or `dropdown`, each `required` or not.
- `preferences`: at extension or command level, typed `textfield`, `password`, `checkbox`, `dropdown`, `appPicker`,
  `file` or `directory`, with `required`, `default` and `placeholder`.
- `tools` (for AI): `name`, `title`, `description`, plus a `functionalities` flag that decides whether a tool is
  exposed to the model or only to the `@` mention menu.
- `ai`: `instructions` and `evals`. Long content can live in `ai.yaml`.

**AI extensions.** A tool is a default-exported function with one typed input object. JSDoc on the function and on
each field is what the model reads. An exported `confirmation` function (`Tool.Confirmation<Input>`) returns a message
that the user must accept before the tool runs
([core concepts](https://developers.raycast.com/ai/learn-core-concepts-of-ai-extensions)). The docs tell authors not
to write persona instructions ("You are a … assistant"), because several extensions share one chat. Evals carry mocked
tool results, run with `ray evals`, and double as suggested prompts shown to users
([evals guide](https://raycastapp.notion.site/AI-Extensions-Evals-15fd6e4a8215800598cad77d8afb5dc8)).

The built-in AI extensions include Calculator, Calendar, Clipboard, File Search, Finder, Focus, Location, Memory,
Notes, Quicklinks, Reminders, Screen Awareness, Selected Text, Snippets, Terminal, Weather and Browser. Raycast also
connects to MCP servers, and on iOS MCP is the only way to extend it. A Permissions setting chooses between three
modes: Ask (anything not read-only), Auto (the default on paid plans) and Always Allow. Users can allow once, always
allow or deny, and a single chat can override the setting ([AI extensions manual](https://manual.raycast.com/ai/ai-extensions)).

### 1.2 Alfred

Alfred's built-in features are default results, file search, universal actions, web search with custom searches,
bookmarks, clipboard history, snippets, a calculator, a dictionary, contacts, a music mini player, 1Password, system
commands, a terminal, Large Type and previews ([features](https://www.alfredapp.com/help/features/)).

Workflows are node graphs of triggers, script filters and actions. The official [Alfred Gallery](https://alfred.app/workflows/)
replaced the old community lists. Its tags show the range: calculator, calendar, clipboard, clock, colour, converter,
currency, dictionary, emoji, maps, news, notes, pomodoro, QR code, reminders, snippets, speed test, sports, system,
thesaurus, timer, translation, transportation, weather, web search and window management.

No public install ranking exists (unverified). The forum's
["your most used workflows"](https://www.alfredforum.com/topic/19974-your-most-used-workflows/) thread and curated lists
keep naming the same kinds of workflow: a natural-language calculator, currency, time zones, Bluetooth device
toggling, search of bookmarks and docs, and Shortcuts runners.
[Calculate Anything](https://alfred.app/workflows/biatidigital/calculate-anything) is the clearest model for us. It
handles currency (ECB-style rates by default, more with a key), 5,000 cryptocurrencies, units, CSS px/em/rem,
percentages, VAT and time, and has a [Ulauncher/Albert port](https://github.com/tchar/ulauncher-albert-calculate-anything).

### 1.3 Ulauncher, Albert, PowerToys Command Palette

- **Ulauncher** (Linux) runs each extension as a separate Python 3 process
  ([docs](https://docs.ulauncher.io/en/stable/extensions/intro.html)). Process isolation per extension is the same
  shape as a stdio MCP server.
- **Albert** (Linux) has plugins in C++ or Python. Its official set includes a calculator, units, emoji, a
  Bitwarden client, an AUR search and the Arch Wiki ([varac.net notes](https://www.varac.net/docs/desktop/launchers/albert.html),
  unverified for the current release).
- **PowerToys Command Palette** (Windows, the successor to PowerToys Run) has a language-neutral WinRT extension API
  and, since v0.100, an in-app extension gallery to browse, install, update and remove extensions
  ([Microsoft Learn](https://learn.microsoft.com/en-us/Windows/powertoys/command-palette/finding-and-installing-extensions),
  [Windows Central](https://windowscentral.com/software-apps/powertoys-just-made-command-palette-extensions-easier-to-install-and-manage)).

### 1.4 The small utilities, and what they mean for voice

| Launcher utility | Spoken equivalent | Needs a tool? |
|---|---|---|
| Calculator: math, units, %, bases | "what's 17 % of 340", "how many cups is 500 ml" | Yes for exact arithmetic. Models still slip on multi-digit maths |
| Currency | "50 dollars in euros" | Yes (today's rate) |
| Time zones, date maths | "what time is it in Tokyo", "how many days until 3 March", "what week is it" | Yes. Partly covered by our `clock` |
| Timers, alarms, pomodoro | "set a 10-minute pasta timer" | Yes, plus a scheduler and proactive speech (gaps 7, 8) |
| Clipboard, snippets | "send that link to my phone", "read me the Wi-Fi password" | A handoff tool: push text or a link to a screen device or phone |
| Dictionary, thesaurus | "what does 'petrichor' mean", "spell 'necessary'" | Usually no; the model knows. Optional dictionary for exact senses |
| Translate | "how do you say 'thank you' in Japanese" | Usually no (the model). TTS must handle the foreign text |
| Colour picker | "what colour is #3b82f6" | Rarely; a screen device can show a swatch |
| System commands, kill process, keep awake | "volume down", "restart the kitchen speaker", "is the internet down" | Yes: device and host control, a speed test |
| Window management | none on a speaker; on a screen device, "show the timer bigger" | Front-end commands, not tools |
| Quick notes | "note that the boiler code is 4417" | Yes: notes and memory |
| Package tracking | "where's my parcel" | Yes: tracking API, key |
| Music control (Spotify) | "play some jazz in the kitchen" | Yes: media module |
| Custom web searches, quicklinks | "search Bol for AA batteries" | Owner-defined templates, no code |
| Flight tracker, travel time | "is KL1002 on time", "how long to drive to Utrecht" | Yes: routing and flight APIs |

## 2. Agent tool ecosystems

### 2.1 MCP

**Primitives.** A server offers tools (model-controlled), resources (application-controlled data addressed by URI) and
prompts (user-invoked templates).

A tool has a `name` (1–128 characters of letters, digits, `_`, `-` and `.`), an optional `title`, a `description`,
`icons`, an `inputSchema` (JSON Schema 2020-12), an optional `outputSchema`, `annotations` and `execution.taskSupport`
([tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).

A result carries `content`, `structuredContent` and `isError`. `content` is a list of text, image, audio,
`resource_link` and embedded resource items, each with optional audience and priority annotations. `structuredContent`
must match the `outputSchema` when one is declared. With `isError`, the error goes back to the model so it can correct
itself.

Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are hints, and clients **must**
treat them as untrusted unless the server is trusted. The spec says hosts **should** show which tools are exposed,
mark when one is invoked, ask before sensitive operations, and time out calls.

**Elicitation** lets a server ask the user something in the middle of a call
([elicitation spec](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)):

- **Form mode** sends a flat schema of string (with `email`, `uri`, `date` or `date-time` formats), number, boolean,
  single enum or multi enum fields. It must never ask for passwords, API keys or payment details.
- **URL mode** sends the user to a page the client cannot inspect, for OAuth with a third party or entering a secret.
  The client must show the full URL and get consent first.
- Answers are `accept`, `decline` or `cancel`.

For voice, form mode with an enum maps onto a spoken question with fixed options, which our IntentWords and confirm
logic already parse. URL mode maps onto "I've put a link on your screen" for a device that has one.

**2026-07-28 revision** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)):

- Stateless. No `initialize` handshake and no `Mcp-Session-Id`. Every request carries its version and capabilities in
  `_meta`, and `server/discover` advertises versions.
- Server-initiated requests (sampling, elicitation, roots) are replaced by **multi round-trip requests**: a call can
  return `resultType: "input_required"` with `inputRequests`, and the client retries the call with `inputResponses`.
- Tasks moved into an official extension (`io.modelcontextprotocol/tasks`), polled with `tasks/get` and fed with
  `tasks/update`.
- Roots, sampling and logging are deprecated.
- Servers **should** return `tools/list` in a deterministic order so that prompt caching works, and list results carry
  `ttlMs`.

Statelessness and multi round-trip requests make a client simpler to write. Deterministic order matters for us
because our tool list is part of the cached prompt prefix (docs/UI-AND-MODULES.md §1.1).

**MCP Apps** ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp),
Final, extension `io.modelcontextprotocol/ui`):

- A tool points at a predeclared `ui://` resource through `_meta.ui.resourceUri`, served as `text/html;profile=mcp-app`.
- The host renders it in a sandboxed iframe that talks to the host over MCP JSON-RPC through `postMessage`, and can
  call tools, with consent.
- It merges MCP-UI (Postman, Hugging Face, Shopify, Goose, ElevenLabs) with OpenAI's Apps SDK.
- Its key design choice is that the template is separate from the data, so a host can prefetch, cache and review the
  UI before any call.

Our modules are "data only" by decision, so an iframe from a third party does not fit. The useful parts are the split
of template from data and the idea of a declared result kind that the host renders.

**Registry and popularity.** The official registry is
[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io). Third-party counts range from 10,000 to
30,000 servers, depending on whether versions are counted ([dev.to](https://dev.to/amareswer/the-mcp-registry-by-the-numbers-38nc),
unverified). There is no official popularity ranking. Directories rank by stars and installs, and keep naming the same
servers: GitHub, Context7 (library docs), Playwright (browser), filesystem, fetch, memory, and search providers such as
Brave, Exa and Tavily ([mcp.directory](https://mcp.directory/blog/top-10-most-popular-mcp-servers), unverified).

The reference servers still maintained are Everything (a test server), Filesystem, Memory and Time, possibly also
Fetch, Git and Sequential Thinking; sources disagree. Brave Search, GitHub, Google Maps, Puppeteer, Slack and others
moved to an archive repository "with no security guarantees"
([examples](https://modelcontextprotocol.io/examples.md), [servers](https://github.com/modelcontextprotocol/servers)).

### 2.2 ChatGPT

- **Built-in tools (API):**
  - web search: $10 per 1,000 calls plus content tokens, or $25 per 1,000 with free content tokens for the
    non-reasoning preview
  - file search: $2.50 per 1,000
  - code interpreter containers: $0.03 per 20-minute session at 1 GB
  - image generation
  ([pricing](https://developers.openai.com/api/docs/pricing))
- **Apps:** "Connectors" were renamed apps on 2025-12-17. The app directory moved into a Plugin directory on
  2026-07-09, and a plugin bundles skills, apps and app templates
  ([help](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)). Apps are built with the
  [Apps SDK](https://help.openai.com/en/articles/12503483-apps-in-chatgpt-and-the-apps-sdk), which runs on MCP and
  informed MCP Apps. Per-app permissions decide when ChatGPT must ask first.
- **Scheduled tasks:** a Scheduled page (2026-06-17) for one-off and recurring tasks and for monitors that "notify only
  when something changes". It replaced Pulse and the 2025 Tasks beta
  ([9to5Mac](https://9to5mac.com/2026/06/17/openai-launches-scheduled-tasks-in-chatgpt-details-here/)). The daily
  briefing built from interests, past chats and connected apps is a strong idea for a home assistant.
- **Memory:** saved memories plus reference to chat history (details not re-checked here, unverified).

### 2.3 Claude

- **Server tools (API):**
  - web search: $10 per 1,000 searches plus result tokens, with domain allow and block lists, `user_location`,
    `max_uses` and citations. Versions `20260209` and later add "dynamic filtering", where Claude filters results in
    code before they reach context ([web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)).
  - web fetch, code execution and a client-side memory tool (file operations the application implements).
  - **tool search**: tools marked `defer_loading: true` stay out of context until a regex or BM25 search finds them.
    Anthropic's docs say a five-server setup costs about 55k tokens of definitions, that tool search cuts this by more
    than 85 %, and that selection accuracy "degrades once you exceed 30–50 available tools". They recommend it from
    10 tools upward, with the 3–5 most used tools kept loaded and names prefixed by service
    ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- **Directory:** skills, connectors (MCP) and plugins in one directory at claude.ai/directory since 2026-03-31, with
  third-party submissions opened later in 2026
  ([Anthropic](https://claude.com/resources/articles/organization-skills-and-directory),
  [Unite.AI](https://www.unite.ai/anthropic-opens-directory-submission-portal-for-claude-plugins/), unverified dates).
- **Agent Skills:** an open standard at agentskills.io. A skill is a `SKILL.md` instruction pack with optional scripts,
  loaded on demand ([The Decoder](https://the-decoder.com/anthropic-publishes-agent-skills-as-an-open-standard-for-ai-platforms/)).
  OpenClaw and Hermes use the same format.

### 2.4 Gemini

Gemini "extensions" are now **Connected Apps**: Google Workspace (Gmail, Docs, Drive, Calendar, Keep, Tasks), Maps,
YouTube, Flights, Hotels, and third parties such as Spotify. Maps and YouTube left the `@` menu in late 2025 and are
now called implicitly ([9to5Google](https://9to5google.com/2025/10/18/gemini-youtube-google-maps-apps/),
[Tech Nerdiness](https://www.technerdiness.com/gemini/google-gemini-connected-apps-guide/), unverified counts).

For developers, Grounding with Google Search on Gemini 3 is 5,000 free prompts a month, then $14 per 1,000 search
queries, and one request can run several queries. Gemini 2.5 used $35 per 1,000 grounded prompts
([forum](https://discuss.ai.google.dev/t/grounding-free-quota-clarifying-2026-rules-for-gemini-2-5-flash-paid-tier-1/144593),
[Puter](https://developer.puter.com/tutorials/gemini-api-pricing/), unverified).

### 2.5 OpenClaw, Hermes and other open-source personal agents

**OpenClaw** (formerly Clawdbot/Moltbot; Node) has built-in tools grouped as
([docs](https://docs.openclaw.ai/tools)):

- runtime: `exec`, `process`, `code_execution`
- files: `read`, `write`, `edit`, `apply_patch`
- human input: `ask_user`, and `secrets`, which "obtains a credential without exposing it to the agent"
- web: `web_search`, `x_search`, `web_fetch`; `browser`
- messaging and sessions, `subagents`
- automation: `automations`, alias `cron`
- `nodes`, for paired devices
- media: `view_image`, `image_generate`, `music_generate`, `video_generate`, `tts`
- an experimental large-catalogue mode (`tool_search`, `tool_describe`, `dispatch_action`) that avoids sending every
  schema

Plugins add tools, skills, channels, speech and search providers, and install from ClawHub, npm, git or a local
folder. Tool groups (`group:web`, `group:memory`) appear in allow and deny lists where deny wins. `web_fetch` caches
pages for 15 minutes, and `web_search` supports Brave, Perplexity, Gemini, Grok or Kimi depending on the version
([mirror of the docs](https://cdn.jsdelivr.net/npm/openclaw@2026.5.7/docs/tools/index.md)).

**ClawHub** is the cautionary tale. Koi Security found 341 malicious skills among 2,857, most from one campaign
("ClawHavoc"). A later audit reported 1,103 of 14,706. The most-downloaded skills were removed after being flagged
([eSecurity Planet](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub),
[InsiderLLM](https://insiderllm.com/guides/openclaw-clawhub-security-alert/),
[rotifer.dev](https://rotifer.dev/blog/clawhub-top50-scan/), vendor audits, unverified).

The popular skills cluster around integration hubs (Composio), research (Exa, a "deep research" skill), a headless
browser, Google Workspace, Obsidian, Home Assistant, GitHub, WhatsApp, YouTube summaries, local Whisper and ElevenLabs
voice calls ([Composio list](https://composio.dev/blog/top-openclaw-skills), a vendor's own ranking).

**Hermes Agent** (Nous Research, MIT, February 2026; Python). It has about 60 built-in tools: web search and extract,
browser, terminal with local, Docker, SSH and cloud backends, files, `execute_code`, vision, image generation, TTS and
subagents. Memory is curated by the agent with periodic nudges to save. Cross-session recall uses SQLite FTS5 search
plus LLM summaries, and user modelling uses Honcho. Skills are procedural memory that the agent writes itself after
solving something hard, compatible with agentskills.io. It connects to MCP with a filter for each server's tools, and
has built-in cron that delivers to any channel ([docs](https://hermes-agent.nousresearch.com/docs),
[Better Stack](https://betterstack.com/community/guides/ai/hermes-agent/)).

**Others** ([roundups](https://pinggy.io/blog/best_openclaw_alternatives/), unverified):

- nanobot (HKUDS, Python, about 4k lines)
- NanoClaw (TypeScript, runs in containers)
- ZeroClaw (Rust, single binary)
- IronClaw (NEAR AI, sandboxed tools)
- PicoClaw (Go)

They all converge on the same kit: shell, files, web search and fetch, browser, memory, cron, messaging channels,
SKILL.md skills and an MCP client. None is built around voice or low latency.

### 2.6 Open WebUI

Open WebUI distinguishes **tools** (Python functions the model calls: search, APIs, code) from **functions**, which
extend the app itself. Functions are pipes (model providers and routers), filters (run on every message, for example
PII redaction or translation) and actions (buttons on a message). Native function calling is now the default and the
only mode going forward. A community site offers one-click imports, and OpenAPI tool servers are supported
([extensibility](https://docs.openwebui.com/features/extensibility/),
[tool development](https://docs.openwebui.com/features/extensibility/plugin/tools/development.md)). Filters are a
pattern we already have in spirit (gates before and after the model).

### 2.7 LangChain, LlamaIndex, Vercel AI SDK

- **LangChain** has tool integrations for search (Tavily, Brave, Exa, DuckDuckGo, SerpAPI, Serper), Wikipedia, arXiv,
  Wolfram Alpha, a Python REPL, Requests, OpenWeatherMap, and toolkits for Gmail, Slack, GitHub, SQL databases, a
  Playwright browser and file management. **LlamaIndex**'s LlamaHub has tool specs for Wikipedia, Wolfram Alpha,
  Google services, code interpreter, Yahoo Finance and OpenAPI specs. Both lists are from memory and not re-checked
  (unverified). They are useful as a checklist; neither framework belongs in our stack.
- **Vercel AI SDK 6** has `tool()` with a schema, provider-defined tools (search and maps grounding run by the model
  vendor) and an MCP client, `createMCPClient` from `@ai-sdk/mcp` ([AI SDK 6](https://vercel.com/blog/ai-sdk-6); exact
  names unverified). We already have our own `Tool` and `Llm` contracts and should not add it. Its split between
  app-executed and provider-executed tools is the right model for our adapters.

### 2.8 Catalogues: Composio, Pipedream

These are integration hubs with managed OAuth. Composio claims more than 1,000 apps and tens of thousands of tools;
Pipedream claims more than 3,000 apps and 10,000 tools, exposed over MCP
([comparison](https://eseospace.com/blog/composio-vs-pipedream-mcp/), vendor counts, unverified). They solve OAuth for
SaaS, but every call and every token passes through a third party. That conflicts with local-first. They could be an
optional MCP server for owners who accept it.

### 2.9 Home Assistant (adjacent)

Home Assistant is both an MCP client (its conversation agents can use tools from external MCP servers, with OAuth) and
an MCP server that exposes its Assist API, limited to the entities the user exposed
([client](https://www.home-assistant.io/integrations/mcp), [server](https://home-assistant.io/integrations/mcp_server/)).
We already have a native Home Assistant module. HA's MCP server is a fallback path, and exposing our own tools as an
MCP server could later let HA or Claude Desktop use them.

## 3. The core essentials

### 3.1 Web search

| Provider | Cost | Key | Latency (third-party, unverified) | Notes for a spoken answer |
|---|---|---|---|---|
| **SearXNG** (self-hosted) | free | none | depends on the upstream engines it queries | Local-first default. Needs `json` added to `search.formats` in `settings.yml` and the limiter off for a private instance ([guide](https://www.ssdnodes.com/learn/searxng-json-api-for-open-webui)). Upstream engines can rate-limit or block it. Results are a meta-mix, fine for snippets |
| **Brave Search API** | about $5 per 1,000, $5 free credit a month (free tier removed February 2026 per [ecorpit](https://ecorpit.com/agent-web-search-api-cost-comparison-2026/)); "Answers" about $4 per 1,000 plus tokens | yes | about 600 ms ([Parallel's board](https://parallel.ai/articles/best-fast-search-apis), a competitor) | Own independent index. Image and news endpoints. Good cheap default with a key |
| **Tavily** | 1,000 credits free a month; about $8 per 1,000 basic, $16 advanced ([summary](https://omidsaffari.com/blog/perplexity-vs-exa-vs-tavily-search-api-cost-2026)) | yes | about 1.9 s basic (same board) | Built for agents. Returns cleaned content and an optional answer. Slower |
| **Exa** | about $7 per 1,000 for 10 results ([summary](https://www.beri.net/article/tavily-vs-exa-vs-brave-vs-perplexity-search-api-agent-cost-2026)) | yes | about 400 ms for "Exa Instant" (same board) | Neural search. Strong for "find pages about X" and developer docs |
| **Perplexity Search API** | $5 per 1,000 requests, up to 5 queries per request ([pricing](https://docs.perplexity.ai/pricing)) | yes | reports conflict, 0.18 s to 11 s ([Parallel](https://parallel.ai/articles/best-web-search-api-for-ai-applications)) | Raw ranked results. Sonar, the answer API, is token-priced and a second LLM in the loop |
| **Kagi** | Search API about $12 per 1,000 ([Open WebUI docs](https://docs.openwebui.com/features/chat-conversations/web-search/providers/kagi.md), unverified); FastGPT $15 per 1,000 ([Kagi](https://help.kagi.com/kagi/api/fastgpt.html)) | yes | not measured | High-quality index. FastGPT returns a short cited answer, which suits voice but costs the most |
| **Anthropic `web_search`** | $10 per 1,000 plus result tokens | the Claude API key we already have | runs inside the model request, so there is no client round trip | Only on Claude API assistants. Results come back encrypted and are re-sent on later turns, which grows context. Not available to OpenAI-compatible or local models |
| **OpenAI `web_search`** | $10 per 1,000 plus tokens | OpenAI key | same | Same lock-in |
| **Gemini grounding** | 5,000 free a month, then $14 per 1,000 queries | Google key | same | Same lock-in |
| **Parallel** | not checked | yes | about 350 ms (its own board) | Vendor-run benchmark |

What suits a spoken answer:

1. Ask for three to five results with title, snippet, URL and date, and pass about 1–2 KB to the model, not pages. A
   2026 analysis found the page text an API returns can cost 6–20 times the search fee
   ([beri.net](https://www.beri.net/article/tavily-vs-exa-vs-brave-vs-perplexity-search-api-agent-cost-2026)).
2. Give the model a `freshness` or `recency` parameter and the owner's locale and region (Brave, SearXNG and
   Anthropic's `user_location` all take one).
3. Keep "search" and "read page" as separate tools, so the cheap path stays cheap.
4. Provider-native search fits only when the assistant's model is that provider's. Keep it as an option behind the same
   module, not as the design.
5. The Claude subscription path (Claude Code) has its own WebSearch tool. Using it there is a choice in
   `agent-claude-code`, not a module.

Implementation: one `web-search` module with a provider setting (SearXNG URL, or Brave, Tavily, Exa, Perplexity or
Kagi with a key in the vault) and one tool, `web_search({ query, recency?, count? })`, with a hard timeout of about
2.5 s that returns "search timed out" instead of hanging the turn. It is plain `fetch` with no SDKs, which also keeps
provider SDKs out of core.

### 3.2 Reading a web page

- **Local:** `fetch`, then [`@mozilla/readability`](https://github.com/mozilla/readability) on a `linkedom` or `jsdom`
  document, then `turndown` to Markdown, truncated to about 6 KB to fit inside our 8,000-character result cap. No key.
  Fails on pages rendered by JavaScript.
- **Hosted:** Jina Reader (`r.jina.ai/<url>`, free with rate limits, token-priced with a key; prices conflict, see
  [Activepieces](https://www.activepieces.com/blog/jina-ai-api-pricing-token-costs-limits-2026)). Firecrawl is
  credit-priced and handles JavaScript ([comparison](https://blog.apify.com/jina-ai-vs-firecrawl/)).
- **Fallback:** a Playwright render (§3.15) for pages that need JavaScript.
- **Voice:** a fetch takes seconds and is rarely what a spoken question needs. Use it when the owner names a site or a
  search snippet is not enough. Cache pages for 15 minutes, as OpenClaw does. Return a title plus the main text, not
  navigation. Block private IP ranges so the model cannot be steered to the LAN (SSRF), unless the owner allows it.

### 3.3 Calculator and maths

- **[mathjs](https://mathjs.org)** covers expressions, units (`5 cm to inch`), big numbers, fractions, matrices and
  statistics. Running it in a restricted scope (no `import`, `createUnit` or `evaluate` re-entry) makes it safe enough
  for model input. Add currency units from the rates feed (§3.4). No key, no native dependencies, sub-millisecond.
- **Natural language:** let the model translate "17 % of 340" into `0.17 * 340`. The tool description lists the syntax
  with a few examples. Return the result plus a rounded form to speak ("about 57.8").
- **Symbolic maths (CAS):** `nerdamer` or `algebrite` for solving and simplifying (unverified maturity). A household
  rarely needs it, so it is optional.
- **Code execution (§3.14)** covers "work out my mortgage over 25 years". Wolfram|Alpha's LLM API is an optional extra
  with a key and its own pricing (unverified).
- **Speech:** spoken output needs number formatting suited to TTS ("three point one four", thousands separators per
  locale). `NumberWords.ts` in core already parses numbers in speech; the inverse belongs in the reply path.

### 3.4 Unit and currency conversion

- **Units:** mathjs, inside `calculate`.
- **Currency:** [Frankfurter](https://frankfurter.dev): no key, ECB and other central-bank rates, a v2 API at
  `api.frankfurter.dev`. Cache once a day, since ECB publishes once per working day. Crypto: CoinGecko's public API
  (key and limits unverified).
- **One tool or two:** fold currency into `calculate` ("50 USD to EUR"), so one tool covers all conversions, as Raycast
  does. Say the rate date when it is not today ("at Friday's rate").

### 3.5 Date, time and time zones

- The existing `clock` module has `current_time` and a context line. Extend it rather than adding a module:
  - `time_in(place)`, using geocoding plus `geo-tz`, or a city table like ours
  - `date_math(expression)` for "monday in 3 weeks", days until or since, week numbers and workdays, with
    `chrono-node` parsing natural-language dates (unverified fit for Dutch)
  - public holidays through `date-holidays` (offline)
  - sunrise and sunset through `suncalc` (offline)
- Effect's `DateTime` is already used. All of this is local and instant, with no keys.

### 3.6 Weather

- We have Open-Meteo (geocoding plus forecast, 3 s budget). Its free API is **non-commercial only**, under 10,000
  calls a day ([terms](https://open-meteo.com/en/terms)), which is fine for a household.
- Add hourly precipitation ("will it rain in the next hour", the most asked question in the Netherlands), weather
  warnings and the UV index.
- For minute-level rain in the Netherlands, Buienradar's rain text endpoint (unofficial, unverified terms) or KNMI open
  data. MET Norway's free API is an alternative and requires an identifying User-Agent (unverified detail).
- On a screen device, show a card; this needs the display channel (gap 2).

### 3.7 Wikipedia and Wikidata

- The Wikipedia REST `page/summary` endpoint gives a short extract suited to speech. Search goes through the Action API
  `opensearch`. Wikidata answers facts ("how tall is the Eiffel Tower"), through `wbgetentities` or SPARQL for joins.
- No key, but Wikimedia began enforcing new rate limits in 2026. They are per client and tiered, and a compliant
  User-Agent is required to avoid the lowest tier
  ([rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy),
  [Phabricator](https://phabricator.wikimedia.org/T418997); numeric limits unverified).
- Use the owner's language edition first (nl, then en). Latency is usually a few hundred ms (unverified; measure).
- Very good value: grounded answers to "who, what, when" without a paid search.

### 3.8 Dictionary

- The model answers most "what does X mean" questions. For exact senses, pronunciations and Dutch, use Wiktionary's
  REST definition endpoint or [dictionaryapi.dev](https://dictionaryapi.dev) (English only, unverified uptime), or an
  offline WordNet (English).
- Low priority. Worth it mainly for spelling games with children and Scrabble disputes.

### 3.9 Translation

- Default: no tool. The model translates. The real work is in TTS: speak the foreign phrase in a matching voice and
  language, or spell it out.
- Offline option for weak local models: LibreTranslate (AGPL, built on Argos; run as a Docker sidecar and call it over
  HTTP) ([Linux Magazine](https://www.linux-magazine.com/Issues/2026/307/Argos-Translate-and-LibreTranslate)). Bergamot
  (Firefox's Marian models) through CTranslate2 is possible but has no clear Node path (unverified). Hosted: the DeepL
  API (key; free-tier size unverified).

### 3.10 Maps, places, routing and transit

- **Geocoding:** Nominatim, the OpenStreetMap search API. The public instance allows at most 1 request per second and
  needs a User-Agent (from memory, unverified). Photon is an alternative and can be self-hosted. Open-Meteo's geocoder
  is fine for city names only.
- **Places** ("is the pharmacy open", "nearest petrol station"): the Overpass API on OSM, with opening-hours parsing via
  `opening_hours.js`. Hosted alternatives (Google Places, Foursquare) need a key and are costly (unverified).
- **Road routing and travel time:** OSRM, Valhalla or GraphHopper, self-hosted or public demo servers (demo terms
  unverified).
- **Public transport:** [Transitous](https://transitous.org/api/), a community-run MOTIS service on open GTFS and
  GTFS-RT feeds, free and best-effort, with a usage policy to read first. National APIs (for example NS, which needs a
  free key; unverified) give train delays.
- **Voice:** answers must be spoken summaries ("the next train to Utrecht leaves at 8:14 from platform 5, about 4
  minutes late"). A screen device can show the map.

### 3.11 News

- Owner-chosen RSS and Atom feeds (local broadcasters, national news, a club's site) with `rss-parser`. A "news
  briefing" tool reads the top N headlines and summarises on request.
- GDELT's DOC API for topic search (free, unverified limits). NewsAPI.org is development-only on its free plan
  (unverified). Brave and Tavily have news modes.
- Fits the "daily briefing" pattern (ChatGPT scheduled tasks), once a scheduler exists.

### 3.12 Stocks, crypto, sports

- **Stocks:** Finnhub or Alpha Vantage free tiers with a key (limits unverified), or Yahoo Finance through the
  unofficial `yahoo-finance2`, which can break.
- **Crypto:** CoinGecko.
- **Sports:** TheSportsDB, football-data.org, API-Football (keys, limits unverified).
- All are small HTTP tools. Value depends on the household, so ship them off by default.

### 3.13 Images: search and generation

- Useful only on screen devices; a headless node cannot show a result. The module should declare that, and the tool
  should not be offered to an assistant on a device without a screen (needs device capabilities, gap 4).
- **Search:** Brave image search, the SearXNG `images` category, Wikimedia Commons or Openverse (both free).
- **Generation:** hosted (OpenAI image models, Flux through fal or Replicate; keys, prices unverified) or local
  (ComfyUI or `stable-diffusion.cpp` on a GPU). Both take several seconds to tens of seconds, so they run in the
  background (§3.16).

### 3.14 Code execution

- **For arithmetic-heavy or data questions:** run model-written JavaScript in **`quickjs-emscripten`** (WASM, no native
  build, memory and time limits, no I/O by default) or **Pyodide** (Python in WASM; a large download and slow cold
  start, unverified size). Run either in a worker thread with a hard timeout.
- `isolated-vm` is a native addon with stronger isolation, but adds a build dependency. Node's own `vm` module is not a
  security boundary.
- Hosted sandboxes (E2B at about $0.000014 per vCPU-second ([summary](https://www.morphllm.com/e2b-pricing),
  unverified), Anthropic code execution, OpenAI containers) send data off the box.
- Cloudflare's **Code Mode** turns MCP tools into a TypeScript API that the model scripts in one go, run in a V8
  isolate. Cloudflare reports large token savings for big APIs ([blog](https://blog.cloudflare.com/code-mode/)).
  Interesting later for composing many tools in one round trip. It conflicts with our typed-action and confirmation
  model, so it is not a first step.

### 3.15 Files and browser automation

- **Files:** a read-only "documents" module that searches and reads a folder the owner chooses (Markdown, text, PDF via
  `pdfjs-dist`). Writing belongs to notes (§3.17). The MCP Filesystem reference server is an alternative.
- **Browser:** Playwright (Chromium, about 150 MB+, unverified) or the Playwright MCP server. Tool definitions cost
  about 5–14k tokens and one page snapshot can be 38k tokens
  ([dev.to](https://dev.to/paveltkachenk0/the-real-mcp-context-tax-isnt-the-schemas-its-the-responses-20g1), unverified).
  Unsuitable for a live voice turn. Use it only as a background job ("book…", "check my bin collection day on the
  council site") with confirmation before submitting anything.

### 3.16 Slow tools in a voice turn

- Text the model says before a tool call is already spoken while the tool runs (current-system.md §2.2). Instructions
  can ask for a short lead-in ("Let me look that up") before slow tools.
- Add a per-tool latency class (`instant`, under 300 ms; `quick`, under 2 s; `slow`). When a `slow` tool starts and
  the model said nothing, core speaks a canned, pre-synthesised filler, and the character shows "working"
  (docs/CHARACTERS.md §5.2 `turn.activity`).
- Anything over about 8 s (deep research, image generation, a browser job) becomes a **background job**: the tool
  returns "started, I'll tell you when it's done", and the result is announced later on the same device, or shown if
  the owner has walked away. This needs gaps 7 and 17. MCP's tasks extension (poll `tasks/get`) is the matching
  protocol shape for remote servers.
- Every tool needs a hard timeout. Today core sets none for plain tools (current-system.md §2.3). Make it a property
  of the tool, with a core default.

### 3.17 Memory and notes

- Two kinds:
  - **Memory:** facts about the household the assistant should keep ("Anna is vegetarian"). Hermes and OpenClaw store
    them as curated Markdown files and search with SQLite FTS5. Anthropic's memory tool is the same idea as file
    operations.
  - **Notes and lists:** content the owner asks to store (shopping list, boiler code, "remind me what I parked next
    to").
- Start with files plus FTS5 (`node:sqlite` in Node 22.5+, or `better-sqlite3`; current-system.md notes no SQLite
  today) and add local embeddings later.
- Needs a module data store (gap 10) and a policy for who may read what once there are several speakers (gap 24).
  Lists can sync to Home Assistant to-do lists or CalDAV VTODO.

### 3.18 Timers, alarms and reminders (not on the brief, but first in usage)

- "Set a timer" is a top-five voice use, and the launchers and ChatGPT both have it. It needs a scheduler that
  survives restarts, the device that asked as the place to announce, a sound plus a spoken label, "how long is left",
  cancel and snooze, and a screen countdown where there is a screen.
- None of this fits the current module contract, because a module cannot speak (docs/UI-AND-MODULES.md §1.1). The
  smallest change that works is a core **Announcements** service that modules may call:
  `announce({ device | "all", text, sound?, at? })`. It would be built on the existing core `Say` input.

## 4. Should the assistant be an MCP client?

**Yes, as one module kind, not as the module system.** A configured MCP server becomes a module instance ("MCP:
GitHub"), with settings for transport (stdio command or Streamable HTTP URL), headers and secrets from the vault, and
OAuth where the server needs it. It also gets a **tool allowlist** (default: none enabled, the owner ticks tools), a
per-tool timeout and a trust level. Its tools join the registry under a prefix (`github_…`). This matches how Hermes
filters server tools and how Raycast lets users mention a server.

| Concern | What happens | Mitigation |
|---|---|---|
| Latency | stdio adds process IPC (small); HTTP adds a network hop and the server's own API call. Each call is still a model round trip | Measure with `TurnTrace` (add a `toolMs` per call if missing). Keep latency-critical essentials native. Mark MCP tools `slow` by default |
| Tool-count bloat | Definitions sit in the cached prefix. 30–50 tools is where selection degrades (Anthropic), and one server can bring 90+ | Allowlist per server. Deterministic order. Deferred loading or tool search when over about 10 tools (Anthropic's server tool for Claude API assistants; a local BM25 "find tool" for others). A per-assistant tool budget shown in the UI |
| Trust | A server can lie in annotations, inject prompt text into descriptions and results, or read and send data | Annotations are trusted only for owner-marked servers. Results are wrapped and labelled as untrusted data. Destructive and open-world tools need confirmation (gap 16). No install from a registry by the assistant itself. stdio servers run with a restricted environment (only the declared secrets), and ideally in a container or under a separate user |
| Config UX | Users paste JSON from READMEs; OAuth flows; Node and Python runtimes needed | A form per server (name, command or URL, env secrets picked from the vault), "test connection" that lists tools, an import box for the usual `mcpServers` JSON. Show each server's prompt cost in tokens |
| Feature fit | Elicitation, MCP Apps and tasks are richer than our voice UI | Map form elicitation with enums to a spoken question, URL elicitation to "link sent to your screen". Render `structuredContent` with our own card kinds, not third-party iframes. Poll tasks as background jobs |
| Spec churn | 2025-11-25 to 2026-07-28 removed sessions and the handshake | Use the official TypeScript SDK (`@modelcontextprotocol/sdk`) inside its own adapter package (provider-SDK rule), and test against both revisions |

The other direction, **being an MCP server**, comes later. It would let Claude Desktop, Home Assistant or a phone
assistant call our modules (timers, notes, announce on a device). The Claude subscription path already builds an
in-process MCP server from our tools (`createSdkMcpServer`, docs/AGENTS-AND-INTENTS.md), so part of the code exists.

## 5. Patterns worth copying

1. **Tools as typed functions with docs on the fields** (Raycast JSDoc, MCP `inputSchema`). We have this
   (`makeTool`, `Param`).
2. **Instructions that describe capabilities, not personas** (Raycast), because several modules share one prompt. Fits
   our module `instructions`.
3. **Evals that double as examples.** Raycast evals mock tool results, serve as tests, and become suggested prompts.
   Module `examples` could feed the Jev decider, a spoken "what can you do", and a test suite.
4. **One rich input over many narrow tools** (Raycast calculator, Calculate Anything). Group by intent: `calculate`,
   `time`, `web_search`, `read_page`.
5. **Declared preferences that render a form** (Raycast `preferences`, MCP elicitation schemas). We already do this
   with `Setting.*`.
6. **Permission modes with "allow always"** (Raycast Ask, Auto and Always; ChatGPT per-app permissions; OpenClaw allow
   and deny where deny wins). Map MCP `readOnlyHint` and `destructiveHint` to our `confirm`, for trusted servers only.
7. **Deferred tool loading and namespaced names** (Anthropic tool search, OpenClaw's large-catalogue mode). Keep 3–5
   hot tools loaded, prefix by module.
8. **Secrets the agent never sees** (OpenClaw's `secrets` tool, MCP URL-mode elicitation). Our vault already keeps keys
   out of the prompt. Never accept a key by voice.
9. **Template separate from data** (MCP Apps). For us: a tool returns `structuredContent` with a declared kind
   (`weather`, `timer`, `list`, `place`, `image`, `table`), and each front end renders the kinds it knows. A headless
   node ignores them and speaks the text.
10. **Scheduled tasks and monitors** (ChatGPT Scheduled, OpenClaw `automations`, Hermes cron): a morning briefing,
    "tell me when the parcel is out for delivery", "warn me if it will freeze tonight".
11. **Memory as curated files plus full-text search** (Hermes, OpenClaw): simple, inspectable, editable by the owner in
    the admin UI.
12. **Owner-defined quick commands without code** (Alfred custom searches, Raycast quicklinks): templates like "search
    {site} for {query}" or "call webhook {url}" as one generic module.
13. **Page-fetch cache** (OpenClaw, 15 minutes) and a daily rate cache (currency).

## 6. Mistakes to avoid

1. **An open marketplace that installs code.** ClawHub's malware is the warning. No auto-install, pinned versions,
   owner review, and a list of servers we have vetted.
2. **Tool sprawl.** Dozens of tools in the prompt slows every turn and hurts tool choice; one server can add tens of
   thousands of tokens. Budget tools per assistant.
3. **Dumping raw pages, DOM snapshots or JSON into context.** It is slower and costs more, and it is useless for a
   spoken reply. Trim at the tool.
4. **Tools for what the model already does well** (translation, definitions, trivia), at about one extra model round
   trip each.
5. **Trusting tool metadata from unknown servers** (annotations, descriptions with hidden instructions).
6. **Blocking a voice turn on a slow tool with no sound.** Silence longer than about a second reads as broken. Use
   lead-in text, a filler or a background job.
7. **Ignoring free-API terms:** Open-Meteo non-commercial, Nominatim 1 request per second, Wikimedia User-Agent rules,
   Transitous's usage policy.
8. **Making provider-native tools the design.** They disappear when the owner switches an assistant to a local or
   OpenAI-compatible model, and they grow context on every later turn.
9. **Asking for secrets in chat or by voice** (the MCP spec forbids it in form mode).
10. **SSRF through `read_page`:** a model-chosen URL reaching `http://192.168.1.1/` or the Home Assistant API.
11. **Third-party iframes or scripts in our page** (MCP Apps by default). It contradicts our "data only" decision.
12. **Sending everything through an aggregator** (Composio, Pipedream) by default. Fine as an opt-in, wrong as the
    default for a local-first assistant.

## 7. Candidate modules for us

Effort: **S** about a day, **M** a few days, **L** a week or more or needs a core change first. "Core gap" names the
current-system.md §9 item the module depends on.

| Module | Tools (sketch) | Origin of the idea | Value | Effort | API keys / native deps |
|---|---|---|---|---|---|
| `calculator` | `calculate(expression)`: maths, units, %, bases, dates, currency | Raycast calculator, Alfred Calculate Anything, LangChain Wolfram | High: exact numbers, common question | S | none; `mathjs`; rates from `currency` |
| `currency` (inside calculator or separate) | `convert_currency(amount, from, to)`, daily cached rates | Raycast, Alfred `cur` | Medium | S | none (Frankfurter); crypto via CoinGecko |
| `clock` (extend) | `time_in(place)`, `date_math(expr)`, `holidays(year)`, `sun(place)` | Raycast time zones and dates | High, cheap | S | none; `geo-tz`, `date-holidays`, `suncalc`, `chrono-node` |
| `timers` | `set_timer`, `set_alarm`, `remind_me(at, text)`, `list`, `cancel`, `snooze` | every voice assistant, ChatGPT Scheduled, OpenClaw cron | Very high (top-five voice use) | L (core: scheduler, announce, persistence; gaps 7, 8, 10) | none |
| `web-search` | `web_search(query, recency?, count?)` | ChatGPT, Claude, OpenClaw, Hermes, LangChain | Very high | M | SearXNG (none) or Brave, Tavily, Exa, Perplexity or Kagi key |
| `web-read` | `read_page(url)`, cached, SSRF-guarded | OpenClaw `web_fetch`, MCP Fetch, Claude web fetch | Medium (follow-up to search) | S–M | none; `@mozilla/readability`, `linkedom`, `turndown`; optional Jina key |
| `wikipedia` | `wiki_summary(topic, lang?)`, `wikidata_fact(entity, property)` | LangChain and LlamaIndex Wikipedia tools | High, free grounding | S | none; User-Agent required |
| `dictionary` | `define(word, lang?)`, `spell(word)` | Alfred dictionary, Alfred Gallery | Low | S | none (Wiktionary); offline WordNet optional |
| `translate` (optional) | `translate(text, to)` only for weak local models; otherwise instructions plus TTS language switch | Raycast Google Translate (#4) | Low–medium | S (instructions) / M (LibreTranslate) | none, or a LibreTranslate sidecar, or a DeepL key |
| `weather` (extend) | `rain_next_hours(place)`, `warnings(place)`, UV | Raycast and Alfred weather | High | S | none (Open-Meteo); Buienradar or KNMI optional |
| `places` | `geocode(q)`, `nearby(kind, near?)`, `is_open(place)` | Gemini Maps, Alfred maps | Medium | M | none (Nominatim or Photon, Overpass); `opening_hours` |
| `travel` | `travel_time(to, mode)`, `next_departures(stop)`, `trip(from, to, at)` | Raycast travel time, Alfred transportation | Medium–high (commutes) | M | none (Transitous, OSRM); NS key optional |
| `news` | `headlines(source?, n)`, `news_about(topic)` | Alfred news, ChatGPT briefing | Medium | S–M | none (RSS); Brave news optional |
| `briefing` | `morning_briefing()`: weather, calendar, news, timers, run on a schedule | ChatGPT Scheduled and Pulse | High once a scheduler exists | M (after `timers` core work) | none (composes modules) |
| `markets` | `quote(symbol)`, `crypto(coin)` | Raycast and Alfred finance, LlamaIndex Yahoo Finance | Low–medium | S | Finnhub or Alpha Vantage key, or unofficial Yahoo |
| `sports` | `score(team)`, `next_match(team)` | Alfred sports tag | Low–medium | S | TheSportsDB or football-data key |
| `notes-memory` | `remember(fact)`, `recall(query)`, `note(text)`, `read_notes(query)` | Hermes and OpenClaw memory, Raycast Memory and Notes, Anthropic memory tool | High | M (gap 10, data store) | none; `node:sqlite` FTS5 |
| `lists` | `add_to_list(list, item)`, `read_list`, `remove`, `clear` | every voice assistant, HA to-do | High | M | none, or CalDAV or HA to-do |
| `calendar` | `agenda(day)`, `next_event`, `add_event` (confirmed) | Raycast calendar, Gemini Workspace, OpenClaw GOG | High | M | CalDAV, or Google OAuth |
| `handoff` | `send_to_screen(device, text or url)`, `send_to_phone(text or url)` | Raycast clipboard and quicklinks, MCP URL elicitation | Medium–high (bridges headless and screen) | S–M (gap 2 display channel, gap 9 notifications) | ntfy (self-hosted) optional |
| `media` | `play(query, room)`, `pause`, `next`, `volume`, `now_playing` | Raycast Spotify (#5), top voice use | Very high | M–L | Spotify OAuth, or Music Assistant or MPD |
| `system` | `speedtest()`, `internet_status()`, `device_status(device)`, `set_device_volume` | Raycast Kill Process, Speedtest, Coffee; Alfred system | Medium | S | none; host commands behind an allowlist |
| `parcels` | `track(code)`, `my_parcels()` | Raycast and Alfred package tracking | Medium | S | 17track or AfterShip key (unverified terms) |
| `images` | `show_image(query)`, `generate_image(prompt)` (screen devices only) | ChatGPT and Gemini image tools, OpenClaw `image_generate` | Low–medium | M (gaps 2, 4; background job) | Brave or SearXNG or Commons; generation key or local GPU |
| `code-runner` | `run_js(code)` (sandboxed, timed) | ChatGPT code interpreter, Hermes `execute_code`, Code Mode | Medium (hard maths, data) | M | none; `quickjs-emscripten` (WASM) |
| `documents` | `search_docs(query)`, `read_doc(path)` in an owner-chosen folder | MCP Filesystem, Raycast File Search | Medium | M | none; `pdfjs-dist` |
| `browser-jobs` | `browse_task(goal)` as a confirmed background job | OpenClaw `browser`, Playwright MCP, ChatGPT agent | Low–medium, risky | L (gap 17, confirmation) | Playwright and Chromium |
| `quick-commands` | owner-defined templates: site search, webhook call, canned answer | Alfred custom web searches, Raycast quicklinks and script commands | Medium, no code | S–M | none |
| `mcp-client` | one instance per configured server, allowlisted tools | MCP everywhere (ChatGPT apps, Claude connectors, Raycast, HA, Hermes) | High as an escape hatch | M–L | `@modelcontextprotocol/sdk` in its own package; per-server runtimes |
| `deep-research` | `research(question)` as a background job, announced when done | ChatGPT and Claude research, OpenClaw "Deep Research Pro" | Medium | L (gap 17) | a search key; many model calls |

Suggested order, by value for effort:

1. `calculator` with currency, the `clock` extensions and `wikipedia`: all S, keyless and offline-tolerant.
2. `web-search` with SearXNG and Brave, then `web-read`.
3. The core work behind `timers` (scheduler, announce, persistence), which also unlocks `briefing` and background jobs.
4. `notes-memory` and `lists`.
5. `media`.
6. `mcp-client` with a curated starter set.

## 8. Things I could not settle

- Current free tiers: Brave (credit versus quota), Exa's free allowance, Kagi Search API price, Jina Reader pricing.
- Real latencies from our network for each search provider. These need a small bench through `TurnTrace` before
  choosing a default.
- Which MCP reference servers are maintained now (Fetch, Git and Sequential Thinking are reported both ways).
- Whether the 2026-07-28 MCP spec is widely implemented by servers yet. Most servers in directories probably still
  speak 2025-11-25 (unverified), so a client must handle both.
- Alfred workflow popularity (no published install counts).
- LangChain and LlamaIndex tool lists, Wolfram|Alpha LLM API terms, NS, finance and sports API limits (from memory,
  not re-checked).
