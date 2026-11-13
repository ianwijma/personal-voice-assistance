# Anthropic Messages API: streaming + tools for the LM adapter

Researched 2026-11-13. SDK checked: **`@anthropic-ai/sdk` 1.8.0** (installed in a temp dir; types and `src/` read directly). API version sent by SDK 1.x: `2026-10-21` ([TS SDK page](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript), "Semantic versioning").
Items marked **UNVERIFIED** could not be confirmed from docs, SDK source or a local test.

Sources are listed per section. Doc URLs are on `platform.claude.com/docs/en/...`; SDK paths are relative to `node_modules/@anthropic-ai/sdk/` (`src/*.ts` and `resources/messages/messages.d.ts` ship in the package).

## 1. Model and latency settings

Source: [models/haiku-5-5/overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview), [models/overview](https://platform.claude.com/docs/en/about-claude/models/overview), [reduce-latency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency), [prompting-claude-haiku-5-5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5), [api/errors#thinking-cannot-be-disabled](https://platform.claude.com/docs/en/api/errors); SDK `Model` union in `resources/messages/messages.d.ts:3910`.

- Model id: **`claude-haiku-5-5`** (no date suffix; "Comparative latency: Fastest"; 1M context, 128K max output; released 2026-10-07). Present in the SDK `Model` union.
- Docs: "For speed-critical applications, **Claude Haiku 5.5** offers the fastest response times ... [Effort] is its main control for speed and cost." The documented example runs it at `low` "the cheapest and fastest level".
- Thinking: "Adaptive thinking is on by default." Omitted `thinking` = adaptive. Thinking tokens count toward `max_tokens`.
- Accepted `thinking` values on this model:
  - omitted or `{type:"adaptive"}`: accepted.
  - `{type:"disabled"}`: accepted **only at effort `low`, `medium`, `high`**. At `xhigh`/`max` it is a 400. With it, a per-message effort that differs from the one in effect is a 400, and `thinking.block_binding` is a 400.
  - `{type:"enabled", budget_tokens}`: **400**.
  - `{type:"between_tools"}`: **400** (Sonnet 5.5 only).
- `output_config.effort`: `low | medium | high | xhigh | max`, **default `medium`**. Docs: "`low` is the cheapest and fastest level. Use it for chat, short tool tasks".
- Docs on prompts: "In Anthropic's testing, telling the model in the prompt to answer directly didn't stop it from thinking." Lower effort is the lever.
- Docs warn that with thinking off the model "sometimes writes reasoning-like text in the reply ... more often with thinking off or at `low` effort. ... switch to adaptive thinking and `medium` effort." Voice output is read aloud, so **measure both** (see Recommendation).
- Omit `temperature`, `top_p`, `top_k`. Non-default values 400 (and any value 400s on API version `2026-10-21`). Prefill (last assistant turn) 400s.
- Forced `tool_choice` (`any`/`tool`) **is accepted** on Haiku 5.5 ([define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), "Forcing tool use": "models with thinking on by default, such as Claude Opus 5 and Claude Haiku 5.5, accept it, but a forced call skips thinking"; the 400 list names Fable/Mythos/Opus 5.5/Sonnet 5.5 only). A forced call skips thinking and emits no text before the call.
- `max_tokens`: the API never needs a large value for TTFT; it only caps output. Because thinking counts against it, a too-small cap can end the turn with `stop_reason:"max_tokens"` after a `thinking` block and before any text (migration guide). A spoken turn needs roughly 300-1024; start at **1024** at `low` effort and watch `stop_reason`. Do not copy 16000/64000 defaults. The SDK only forces streaming when a non-streaming `max_tokens` implies >10 min (`client.ts:1451`); irrelevant here because we always stream.
- `thinking.display`: default is `"omitted"` (blocks arrive with empty text, which "reduces latency, not cost"). Leave it default. Do not request `"summarized"`.
- Fast mode: **not available** on Haiku 5.5 (Opus 5 / 5.5 / 4.8 only, per bundled skill; SDK has `speed: 'standard'|'fast'` in `messages.d.ts:5714`, but it is a beta feature for Opus).
- `service_tier` request field: `'auto' | 'standard_only'` (`messages.d.ts:5712`). Whether Priority Tier is offered for Haiku 5.5 is **UNVERIFIED** (the bundled skill lists models excluded from Priority Tier and Haiku 5.5 is not on that list, but no doc states it positively). Response `usage.service_tier` reports `standard | priority | batch`.
- Other TTFT levers (from docs): short prompts, prompt caching (section 5), streaming. Keep `tools` and `system` small.

```ts
import Anthropic from "@anthropic-ai/sdk";
const params = {
  model: "claude-haiku-5-5",
  max_tokens: 1024,
  output_config: { effort: "low" as const },
  // thinking omitted => adaptive. Fastest-legal alternative (test it, see Recommendation):
  // thinking: { type: "disabled" as const },   // only valid with effort low|medium|high
};
```

**Recommendation (the numbers must come from `TurnTrace`, per CLAUDE.md):** A/B three configs on real turns and compare time to first text delta: (a) `effort:"low"`, thinking omitted; (b) `effort:"low"` + `thinking:{type:"disabled"}`; (c) `effort:"medium"`. Docs do not give TTFT numbers for any of these. Whether (b) is measurably faster than (a) is **UNVERIFIED**; (a) may already skip thinking on simple turns ("it can skip thinking entirely on simpler requests"). Do not change `thinking` or `effort` between turns of one conversation (see section 5, invalidation).

## 2. Streaming

Source: [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [fine-grained-tool-streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming); SDK `src/lib/MessageStream.ts`, `src/core/streaming.ts`.

### Which call

- `client.messages.stream(params, { signal })` returns a `MessageStream` helper: event emitters (`text`, `inputJson`, `contentBlock`, `finalMessage`), async iterable over raw events, and builds a final `Message` snapshot (it keeps a lazy JSON buffer per tool block, `MessageStream.ts:698-701`).
- `client.messages.create({ ...params, stream: true }, { signal })` returns `Stream<RawMessageStreamEvent>`, an async iterable of raw events only. Docs: "uses less memory (it does not build up a final message object for you)."
- **For the adapter use `create({stream:true})`.** It is a thin loop over raw events, we already need our own per-block bookkeeping (emit deltas immediately, emit a tool call at `content_block_stop`), and it skips the snapshot machinery. `messages.stream()` is also fine and gives `stream.abort()` plus `stream.controller`. Latency difference between the two: **UNVERIFIED** (not measured).
- SDK drops `ping` events and rethrows `event: error` as `APIError` (`core/streaming.ts:66-79`), so you never see them in the loop.

### Event sequence

From the docs, "Event types":

1. `message_start`: `Message` with empty `content`, `usage.input_tokens` (incl. cache fields).
2. Per block: `content_block_start`, any number of `content_block_delta`, `content_block_stop`. `index` matches the final `content` array.
3. One or more `message_delta`: `delta.stop_reason`, `delta.stop_sequence`, and `usage` (**cumulative** token counts, per docs warning).
4. `message_stop`.
`ping` may appear anywhere. Errors can arrive mid-stream after HTTP 200: `event: error` `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.

Doc example (verbatim shapes):

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
...
event: content_block_start      // tool_use: input is a placeholder {}
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{}}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}
```

Block types to expect on Haiku 5.5: `thinking` (with `thinking_delta`/`signature_delta`; empty text when omitted) before `text`. Never read `content[0]` as the answer. Docs also mention a `fallback` block, but Haiku 5.5 has no server-side fallback.
`stop_reason` values seen in SDK/docs: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal` (Haiku 5.5 runs safety classifiers; a refusal can arrive mid-stream; discard partial output; `stop_details.category`).

### Assembling tool input (documented contract)

1. On `content_block_start` with `type:"tool_use"`: `buf[index] = ""`.
2. On `input_json_delta`: `buf[index] += delta.partial_json`.
3. On `content_block_stop`: `JSON.parse(buf[index])` (guard it; empty string means `{}` for a no-arg tool).

```ts
import Anthropic from "@anthropic-ai/sdk";
type LmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: string | null; usage: Anthropic.Usage | undefined };

async function* run(client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal): AsyncGenerator<LmEvent> {
  const stream = await client.messages.create({ ...params, stream: true }, { signal });
  const tools = new Map<number, { id: string; name: string; json: string }>();
  let stopReason: string | null = null; let usage: Anthropic.Usage | undefined;
  for await (const ev of stream) {                       // break/return => SDK aborts the request
    switch (ev.type) {
      case "message_start": usage = ev.message.usage; break;
      case "content_block_start":
        if (ev.content_block.type === "tool_use")
          tools.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
        break;
      case "content_block_delta":
        if (ev.delta.type === "text_delta") yield { type: "text", delta: ev.delta.text };
        else if (ev.delta.type === "input_json_delta") tools.get(ev.index)!.json += ev.delta.partial_json;
        break;
      case "content_block_stop": {
        const t = tools.get(ev.index);
        if (t) { tools.delete(ev.index);
          let input: unknown;
          try { input = t.json === "" ? {} : JSON.parse(t.json); }
          catch { throw new Error(`invalid tool input JSON for ${t.name}`); } // or surface as is_error result
          yield { type: "tool_call", id: t.id, name: t.name, input };
        } break;
      }
      case "message_delta": stopReason = ev.delta.stop_reason; usage = { ...usage!, ...ev.usage }; break;
    }
  }
  yield { type: "done", stopReason, usage };
}
```

Notes:
- In the SDK, `Stream` iterator ends early without throwing if the stream is aborted via its controller (`core/streaming.ts:94-95`), and `finally { if (!done) controller.abort() }` (line 99) means **`break`/`return` from the loop aborts the HTTP request**. See section 3.
- Handle `stopReason === "max_tokens"` and `"refusal"` before running tools.
- Per [fine-grained doc](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming) "Accumulating tool input deltas": assembly contract is identical with or without eager streaming.

### Fine-grained (eager) tool input streaming

- Exists, GA, no beta header: set **`eager_input_streaming: true` on each user-defined tool** and stream the request. SDK type: `Tool.eager_input_streaming?: boolean | null` (`messages.d.ts:4421`). Supported on `claude-haiku-5-5` (listed in the doc's `supportedModels`). Do **not** also send the legacy beta header `fine-grained-tool-streaming-2025-05-14`.
- Effect: "Without `eager_input_streaming`, the API buffers and validates each parameter value before streaming it back." With it, fragments arrive from the moment the model starts a parameter, "typically longer, with fewer mid-word breaks".
- Warning: "you might receive partial or invalid JSON. A response that ends with ... `max_tokens` can also cut a parameter off midway." Guard the parse; on failure the docs suggest a `tool_result` with `is_error:true` and `content` `{"INVALID_JSON": "<raw>"}`.
- For our adapter (small tool inputs, we only act at `content_block_stop`): benefit is **UNVERIFIED**; it mainly cuts time to the first fragment of a *large* parameter. We do not act on partial input, so expected gain is small. Measure before enabling; if enabled, the invalid-JSON guard is mandatory.

## 3. Aborting

Source: SDK `src/lib/MessageStream.ts:226-300, 425-440`, `src/core/streaming.ts:85-100`, `src/client.ts:1630-1640`, `src/core/error.ts:132`; [TS SDK page](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) ("Streaming responses": "you can `break` from the loop or call `stream.controller.abort()`").

Ways to stop (all close the underlying fetch):
- Pass `{ signal }` as the **second argument** (request options) to `create()` or `stream()`. SDK wires it to its own `AbortController` (`fetchWithTimeout`, `client.ts:1827`). If the signal is already aborted, `create` throws `APIUserAbortError` before sending (`client.ts:1632`).
- `break`/`return` out of the `for await` over a `Stream`: iterator `finally` calls `controller.abort()` (`streaming.ts:99`).
- `stream.controller.abort()` (on `Stream`), or `messageStream.abort()` (on the `MessageStream` helper).

Error identification:
- Abort before/while connecting, or on the `messages.stream()` helper: **`Anthropic.APIUserAbortError`** (`name` "APIUserAbortError", message "Request was aborted.", `status` undefined). `isAbortError(e)` is normalised to it by the helper (`MessageStream.ts:432`). On the helper it is delivered as the `abort` event and rejects `finalMessage()`/`done()`.
- Abort **mid-iteration on `create({stream:true})`**: the iterator catches the abort error and **returns silently, no throw** (`streaming.ts:94-95`). So a consumer-driven stop looks like normal end of stream; track your own `signal.aborted` / `stopRequested` flag and do not emit `done` as if the turn completed.
- Distinguish from real failures: `err instanceof Anthropic.APIUserAbortError` (check this **before** `APIConnectionError`; `APIUserAbortError` is not a subclass of it, both extend `APIError`). Timeouts are `APIConnectionTimeoutError` (extends `APIConnectionError`), not abort errors.
- Aborts are **not retried**: the retry path checks `options.signal?.aborted` and throws `APIUserAbortError` first (`client.ts:1638-1640`).

```ts
const ac = new AbortController();
const it = run(client, params, ac.signal);
// consumer stops:  ac.abort();   (or just `await it.return()` / break)
try { for await (const e of it) {/* ... */} }
catch (e) { if (e instanceof Anthropic.APIUserAbortError) return; throw e; }
```

Whether the server stops generating (and stops billing output) at the instant of TCP close: **UNVERIFIED** (not documented). Expect billing for tokens generated until the server notices the closed connection.

## 4. Tool use

Source: [define-tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [handle-tool-calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), SDK `messages.d.ts` (`Tool` ~4388, `ToolChoiceAuto` 6092, `ToolResultBlockParam` 6167).

Request:

```ts
tools: [{
  name: "get_weather",                       // ^[a-zA-Z0-9_-]{1,128}$
  description: "Detailed: what, when to use, caveats ...",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  // eager_input_streaming?: boolean; strict?: boolean; cache_control?: {type:"ephemeral"}
}],
tool_choice: { type: "auto", disable_parallel_tool_use: false },   // default when tools present
```

- `tool_choice`: `auto` (default with tools), `any`, `tool` (`{type:"tool", name}`), `none`. `disable_parallel_tool_use?: boolean` is confirmed on `auto` (`messages.d.ts:6101`); with `true` the model emits at most one call. Forcing `any`/`tool` prefills the turn, so **no text before the tool call and thinking is skipped** (docs). Changing `tool_choice` invalidates cached *message* blocks only; tools and system stay cached.
- `strict: true` on a tool guarantees schema-valid input (schema needs `additionalProperties:false`; bundled skill). Strict adds server-side grammar handling; its latency cost on first use is **UNVERIFIED**.
- The model may emit text before `tool_use` ("I'll check...") and treat it as ordinary assistant text; speak it, it is a free filler.

Assistant message in history (replay exactly what you received; keep `thinking` blocks and their signatures; do not drop empty-text ones):

```ts
{ role: "assistant", content: [
  { type: "thinking", thinking: "", signature: "..." },      // if present: pass back unmodified
  { type: "text", text: "I'll check." },
  { type: "tool_use", id: "toolu_01A...", name: "get_weather", input: { city: "Paris" } },
] }
```

User tool results:

```ts
{ role: "user", content: [
  { type: "tool_result", tool_use_id: "toolu_01A...", content: "15 degrees" },
  { type: "tool_result", tool_use_id: "toolu_01B...", is_error: true,
    content: "ConnectionError: the weather service is not available (HTTP 500)" },
  // text, if any, goes AFTER all tool_result blocks
] }
```

Rules (verbatim from handle-tool-calls): "Tool result blocks must immediately follow their corresponding tool use blocks in the message history." "the `tool_result` blocks must come FIRST in the content array. Any text must come AFTER all tool results." Violation error: "tool_use ids were found without tool_result blocks immediately after". `content` may be string, `[ {type:"text"} ... ]`, or omitted. `is_error: true` signals failure; write instructive messages.
- **Parallel calls**: one assistant message can contain several `tool_use` blocks (each at its own `index`; the stream emits them sequentially). Run them concurrently and return **all** results in a **single** user message (bundled-skill guidance: splitting them "silently trains Claude to stop making parallel calls"; the single-message requirement itself follows from "must immediately follow"). The `tool_use` ids you must answer are the ones from the assistant turn; answer every one, including failures.
- Mid-turn user speech (barge-in text) must not go inside a `tool_result`; per Haiku 5.5 prompting doc, "Append the user's words as a text block after the last `tool_result` in the same user message" (the model treats tool results as untrusted).
- Tool names/schemas must be byte-stable turn to turn or the cache breaks (section 5).

## 5. Prompt caching

Source: [prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (first 100K chars read; the rest was not), [haiku-5-5 overview "Good to know"](https://platform.claude.com/docs/en/models/haiku-5-5/overview), bundled skill `shared/prompt-caching.md`; SDK `CacheControlEphemeral` (`messages.d.ts:2116`), `Usage` (~4775).

Order of the cached prefix: **`tools` -> `system` -> `messages`**. "Changes at each level invalidate that level and all subsequent levels."

Placement to cache tools + system: one breakpoint on the **last system block**. A breakpoint caches everything before it, including the whole `tools` array (so no marker on tools is needed). Optionally a second breakpoint on the last stable message (or top-level automatic caching) for conversation history. Max **4** breakpoints per request; each lookback checks at most 20 blocks.

```ts
system: [
  { type: "text", text: STABLE_PERSONA_AND_RULES,
    cache_control: { type: "ephemeral" } },          // 5m TTL; or { type: "ephemeral", ttl: "1h" }
],
tools: STABLE_TOOLS,                                   // fixed order, frozen text
// Optional: top-level automatic caching of the growing history (one extra breakpoint slot):
// cache_control: { type: "ephemeral" },
messages: [ ...history, { role: "user", content: [
  { type: "text", text: userUtterance },
  { type: "text", text: `[now: ${isoTime}]` },     // see below: dynamic data AFTER the breakpoint
] } ],
```

- Minimum cacheable prefix on Haiku 5.5: **512 tokens** (docs: haiku overview "The minimum cacheable prompt length is 512 tokens"). Below it the marker is silently ignored (`cache_creation_input_tokens` stays 0). The new tokenizer yields ~30% more tokens than Haiku 4.5 for the same text.
- TTL: default **5 minutes**, refreshed free on each hit; `ttl: "1h"` optional (type `'5m' | '1h'`). Longer TTL entries must come before shorter ones in the request. Pricing for Haiku 5.5 (<=100K prompt): input $0.10/MTok, 5m write $0.125, 1h write $0.20, read $0.01.
- Confirm hits from `usage` (final `message_delta` + `message_start`): `cache_read_input_tokens` (hit), `cache_creation_input_tokens` (written), `input_tokens` = tokens **after the last breakpoint** (uncached). Docs: `total_input = cache_read + cache_creation + input_tokens`. Also `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`. In `message_start` `usage` holds the input-side numbers; log them to `TurnTrace` to prove hits.
- A cache entry becomes available only "after the first response starts", so do not fire a second request for the same prefix in parallel with the first.
- **What invalidates** (docs table):
  - any change to tool definitions (names, descriptions, parameters) invalidates **everything** (tools, system, messages);
  - changing `system` invalidates system and messages;
  - changing `tool_choice`, images, or the thinking/effort config invalidates message blocks, and on some models also tools/system. Docs: "Thinking parameters: Model-specific"; "Effort setting: ... can invalidate message blocks, and on some models tool and system caches too". Which applies to Haiku 5.5: **UNVERIFIED**. Keep `thinking` and `effort` constant for the lifetime of a conversation to be safe;
  - `speed` switching (fast/standard) invalidates system and messages (n/a here);
  - Haiku 5.5 also validates replayed thinking blocks against the exact prior prefix ("history-editing check", 400 on edits; enforced by default for accounts created on/after 2026-08-31). **Keep history append-only.**
- **Dynamic per-turn context (current time etc.):** put it in the *latest user message*, after the last breakpoint, never in `system`/`tools`. Then store that user turn **exactly as sent** (timestamp included) in the history so the next request replays an identical prefix. Do not remove or rewrite earlier timestamps. Haiku 5.5 prompting doc: "Render the date once, when the conversation starts, and send the same `system` and `tools` on every later request ... When a conversation continues on a later day, give the new date in the newest turn". Alternative for non-user-visible notices: a `{role:"system"}` message appended to `messages` (supported on Haiku 5.5, no beta header; must follow a user message; bundled skill). Using it for the clock is **UNVERIFIED** for latency/caching behaviour, so prefer the user-turn text block.
- Cache is per workspace; keep the same API key/workspace for all turns.
- Cold start: `max_tokens: 0` pre-warm request writes the cache and returns immediately with `content: []`, `stop_reason:"max_tokens"` (bundled skill `shared/prompt-caching.md` "Pre-warming"; **not read in the live docs** because the fetch of that page was truncated at 100K chars, so confirm on the page "Pre-warming the cache"). Rejected with `stream:true`, `thinking.type:"enabled"`, `output_config.format`, forced `tool_choice`. Send the same `thinking`/`effort`/tools/system as real traffic.

## 6. Connection reuse, timeouts, retries

Source: [TS SDK page](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) ("Retries", "Timeouts", "Long requests", "Fetch options", "Configuring proxies"), [api/errors](https://platform.claude.com/docs/en/api/errors), SDK `src/client.ts` (1630-1700, 1811-1860, 1923-2016), local test (below).

- Transport: the SDK uses the **global `fetch`** (Node 22: undici). "By default, this library requires a global `fetch` function"; you can pass `new Anthropic({ fetch })` or `fetchOptions` (`RequestInit`, per client or per request; per-request wins). No `httpAgent` option in 1.x; for Node use `fetchOptions: { dispatcher: new undici.Agent({...}) }` (the docs show `dispatcher` only for a `ProxyAgent`; using a custom `Agent` the same way is **UNVERIFIED** against docs but is the same mechanism).
- Docs: "When supported by the `fetch` implementation, the SDK sets a TCP socket keep-alive option to reduce the impact of idle connection timeouts". This is TCP keepalive, not HTTP connection pooling.
- Connection reuse across requests: undici's global dispatcher pools HTTP/1.1 keep-alive connections by origin. **Local test** (Node v22.22.1, a loopback `http` server): 5 sequential `fetch` calls used 2 connections total; after a 6 s idle gap with the server advertising a 60 s keep-alive, the next call reused the connection (count stayed 2). With a server default (5 s keep-alive hint), a 6 s gap opened a new connection. So undici honours the server's `Keep-Alive: timeout` hint. What idle timeout `api.anthropic.com` advertises: **UNVERIFIED**. Measure the TLS+TCP setup cost in `TurnTrace` (connect time on first request vs second).
- **Always create one `Anthropic` client at process start and reuse it**; do not build a client per turn.
- Pre-warm connection: **no documented SDK API** for it. Options: (a) the cache-warm `max_tokens: 0` request (also warms the prompt cache, section 5); (b) any cheap authenticated call (e.g. `client.models.retrieve("claude-haiku-5-5")`) at startup. Both are **UNVERIFIED** for actually leaving a reusable pooled connection (not tested; needs an API key and the real network). Keep-alive across long idle gaps may need a periodic ping.
- Timeouts: `timeout` (ms, default 10 min) via client option or per request `{ timeout: 5_000 }`. Implementation arms `setTimeout(abort, ms)` around the raw `fetch` call and clears it as soon as `fetch` resolves, i.e. when **response headers arrive** (`client.ts:1853-1858`). So for streaming it bounds **time to headers/connect**, not total stream duration and not the gap between SSE chunks. Stalled streams are not covered: add your own watchdog (abort via your `AbortController` if no `text_delta`/event within N ms). On timeout: `APIConnectionTimeoutError`; timeouts are retried.
- Retries: `maxRetries` default **2** (client or per request). Retried: connection errors, 408, 409, 429, >=500, and any response with `x-should-retry: true` (obeys `false`). Backoff: `min(0.5 * 2^n, 8)` s with up to 25% jitter, or `retry-after-ms` / `retry-after` header when present (`client.ts:2005-2014`, `1972-1988`). Worst case wall clock is `timeout x (maxRetries+1)` plus sleeps.
- Suggested fail-fast config (values are our proposal, not from docs):

```ts
const client = new Anthropic({ timeout: 4_000, maxRetries: 0 });   // we do our own single fast retry
// per request: client.messages.create(body, { signal, timeout: 4_000, maxRetries: 0 })
```

  With `maxRetries: 0` the SDK's own 0.5 s+ backoff never delays a turn. Mid-stream failures are never retried by the SDK; only failures before the response starts. If a retry happens after any text was already spoken, do not replay it silently; decide in the adapter whether to restart or abandon the turn.

## 7. Errors and retry policy

Source: [api/errors](https://platform.claude.com/docs/en/api/errors), SDK `src/core/error.ts`.

SDK classes (all exported on `Anthropic.*`, extend `APIError` which has `.status`, `.headers`, `.error`, `request_id`):

| Class | Status / cause | Fast retry? |
|---|---|---|
| `APIUserAbortError` | our abort | never |
| `APIConnectionTimeoutError` (extends `APIConnectionError`) | no headers within `timeout` | yes, once |
| `APIConnectionError` | network/DNS/TLS/socket failure | yes, once |
| `RateLimitError` | 429 (`rate_limit_error`) | only if `retry-after` is short; a spend-cap 429 has no `retry-after` and keeps failing (docs) |
| `OverloadedError` (extends `InternalServerError`) | 529 (`overloaded_error`), "can occur when the API experiences high traffic across all users" | yes, once (also arrives as an SSE `error` event mid-stream) |
| `InternalServerError` (`>=500`, 500 `api_error`) | server error | yes, once |
| `ServiceUnavailableError` 503, `GatewayTimeoutError` 504 | transient | yes, once |
| `RequestTimeoutError` 408, `ConflictError` 409 | transient | yes, once |
| `AuthenticationError` 401, `PermissionDeniedError` 403, `NotFoundError` 404 | config | no |
| `BadRequestError` 400, `UnprocessableEntityError` 422, `ContentTooLargeError` 413 | our request is wrong (thinking/effort/sampling/prefill/tool-result ordering, invalid history after edits) | no |

Mid-stream errors: an SSE `error` event is thrown by the SDK iterator as a plain `APIError` (`core/streaming.ts:66-79`) with `status` undefined and `error.type` (e.g. `overloaded_error`), so it is **not** an `OverloadedError` instance. Branch on `err.error?.type` for mid-stream cases.
Docs: "The official SDK automatically retries transient failures ... twice by default, honoring the `retry-after` header". `request-id` header / `err.requestID`: log it in `TurnTrace`.
Voice policy suggestion: retry once immediately (no backoff) on connection/timeout/overloaded/5xx **only if nothing has been emitted to the consumer yet**; otherwise surface the error and let the caller speak a fallback line.

## Unverified summary

- Whether `thinking:{type:"disabled"}` is measurably faster than `effort:"low"` with default adaptive thinking on Haiku 5.5; no TTFT figures in docs.
- Whether Priority Tier / any `service_tier` benefit exists for Haiku 5.5; fast mode is Opus-only.
- Whether thinking/effort config changes invalidate the tools/system cache on Haiku 5.5 ("model-specific").
- Pre-warm: `max_tokens: 0` documented only in the bundled skill reference, not re-read on the live page; whether a warm-up leaves a reusable pooled connection; the API's server-side keep-alive idle timeout.
- Using a custom undici `Agent` via `fetchOptions.dispatcher` (docs only show `ProxyAgent`).
- Whether the server stops generating/billing output immediately when the client aborts.
- Net latency benefit of `eager_input_streaming` for small tool inputs, and of `strict: true` (first-use cost).
- Latency difference between `messages.stream()` and `create({stream:true})`.
- Parallel-tool-result rule is quoted from the bundled skill; the live "parallel-tool-use" page was not fetched.
- `disable_parallel_tool_use` was confirmed in the SDK only on `ToolChoiceAuto`; its presence on `any`/`tool` was not checked.
- Mid-conversation `role:"system"` message as a carrier for per-turn context (bundled skill only).
