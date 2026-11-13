# Agents, trigger routing and typed intents

Design for the next stage: several interchangeable agents (Claude and Codex subscriptions through their harnesses,
OpenAI-compatible servers on the home network and OpenRouter, the existing Anthropic API), a spoken trigger phrase that
picks the agent ("hey Jev, …"), a typed-intent path that runs programmatic actions without a conversational model, and a
much more configurable settings screen. Written 2026-11-13. `docs/ARCHITECTURE.md` and `docs/UI-AND-MODULES.md` remain the
contract for what exists; this document adds to them. Facts come from `docs/research/agent-backends.md` and
`docs/research/typesafe-jev.md`; where something is unmeasured or unverified it says so (**[verify]**, *estimate*).

## Changes since the design

Recorded by the implementers while building; each entry says what changed and why. Other pieces build against these.

### Pieces A, C, D (agent core and routing, intent path, modules) — 2026-11-13

Interfaces other pieces use:

- **`AgentTurnInput.now?: () => number`** (new, optional): the trace clock, so agents measure tool and action durations on
  the same scale as the marks. Absent → use `Clock.currentTimeMillis`. Agent implementations need no change.
- **`AgentSet`** (in `ConversationEvents.ts`): `defaultAgent` is **required** (the fallback rule "default agent if
  conversational" needs it; `Router` does not expose its config). New optional `armedMs` (how long `ExpectReply` arms; the
  router's `armedMs`, default 10 000). `names`, `actions`, `deciders`, `maxToolRounds`, `promptFor` are optional with
  defaults (running agents' names, none, none, the conversation's `maxToolRounds`, the setup's `system`).
  `acknowledgement` was **dropped**: the router's `RouteDecision.acknowledge` already carries the text.
- **`Conversation`**: `layerWithAgents` / `makeAgentConversation` as designed; the service gains
  `routerState: Effect<RouterState>` (for `snapshot.routing`) and `textTurn(text, { agentId? })`. `textTurn` still fails
  with `LlmError` (an `AgentError` is mapped to it) so existing callers compile.
- **Single-model conversations are unchanged** (`layer`, `layerWithSetup`): they run one `model` agent with **no
  first-event timeout** (an `Llm` that thinks for more than 5 s keeps working), and their events and history carry **no**
  agent fields (`TurnStarted` without `agentId`…, assistant messages without `agentId`, no `RoutingChanged`, no
  `Trace.agent`). All 169 core tests that existed before pass unchanged.
- **Failure fallback** (§1.9): an `AgentError` (or first-event timeout) re-runs the turn on `fallbackFor(agent)` only when
  the agent said nothing **and started no tool or action** (a side effect may have happened). With no fallback agent the
  turn fails as before (no canned reply). A `Handoff` with no agent to take it speaks "I can't help with that right now.",
  recorded as that agent's reply. The fallback agent gets one try (no second fallback).
- **Notices and canned replies**: "X isn't available." is a clause of its own, spoken and shown (`TextDelta`) but not in
  history. `Say` starts a turn with `TurnStarted { source: "text", text: "", canned: true }`.
- **Events**: `IntentDecided` also carries `agentId`. `RoutingChanged` is emitted when a commit or an `ExpectReply` changes
  the state, and always on `SetActiveAgent`.
- **`TurnTrace`**: `traceMarks` in time order: `…, llmFirstToken, decisionSent, decisionReceived, firstClause,
  ttsFirstAudio, playbackStart, actionStarted, actionFinished`. `Trace.agent: TraceAgent` (`{ id, kind, routedBy,
  fallbackFrom? }`); `formatTrace` prints `agent=jev(trigger)` / `agent=main(trigger, instead of jev)`.
- **Modules**: `ModuleInstance extends ModuleContributions` (`ExtendedModuleInstance` kept as an alias);
  `ModuleDefinition.kind?` / `agentKind?`; `defineModule` accepts `kind`. `ModuleSnapshot` gains **required** `agents`,
  `actions`, `deciders` (only the host builds snapshots). Generated action tools are in `registry`, `toolModules` and
  `ModuleInfo.tools`; their names are clash-checked like module tools; duplicate action ids fail the start.
- **Generated Test button**: `ModuleHost.fieldAction(moduleId, key)` runs an instance's own `fieldActions[key]`, or, for
  `key: "test"`, the generated agent test ("Say hello in five words." → "First text after … ms, done after … ms: '…'") or
  decider test (fixed two-action request). It answers `FieldActionHostResult` with its own codes (`unknown_module`,
  `unknown_action`, `not_running`) because protocol v1 has no `unknown_action`; piece F/G maps them. The `action` field
  itself appears in forms with piece G. `testAgent` / `testDecider` are exported.
- **`Param.*` typing fix** (`Actions.ts`): the constructors now return `XParam<NoInfer<O>>`. Before, inside
  `defineAction({ params })` the contextual type made `O` infer as `boolean`, so `run` saw every value as `T | undefined`.
  Backwards compatible (code that handled `undefined` still compiles).
- **`actionTool`** (`Actions.ts`): returns the action's `say`, else its `announce` text, else "ok" (design: `say` or "ok"),
  so a conversational agent can confirm in its own words. A `confirm` action's tool description adds "Ask the owner to
  confirm before calling this." (not enforced: §7). Names are resolved with `resolveOption` (exported): value/label/alias
  ignoring case, punctuation and a leading article; then phonetic key; then one edit on phonetic keys of ≥ 4 letters
  when only one option is that close. Durations as tool input: `parseDuration` ("10 minutes"; a bare number = seconds).
- **`makeIntentAgent`** options: `deciders: string[]` (preference order, default `["jev-typesafe", "keywords"]`) instead of
  `decider: () => DecisionProvider | undefined`, because the running providers arrive with each turn
  (`input.deciders`); `onDeciderChange(provider, preferred)` drives the status line. `thresholds`, `parse` (default
  `parseValues`), `onNoMatch`, `noMatchText`, `speakBeforeDone`, `pendingMs`, `timeoutMs` as designed.
- **Intent agent behaviour**: a started action runs **detached** (not `uninterruptible`), so a barge-in does not wait up
  to 5 s for it, yet the action still finishes. On a fallback or decider error the pending question is dropped at once
  (not at commit): the `Handoff` ends the stream before promotion and waiting would delay the fallback agent. Each spoken
  sentence is followed by `"\n"` (immediate flush); a second sentence starts with a space so history reads naturally.
- **`ValueParser`** (signature unchanged): the parameter's `unit` is not passed, so candidates followed by *any* unit word
  (`%`, percent, procent, degrees, graden) rank first. "een" counts as 1 only before a unit word or written "één" (it is
  also the Dutch article); "a/an" count only in durations ("a minute").
- **Keyword decider** (`agent-intent/src/keywords.ts`), needed to make the demo sentences work: action scores weight each
  word by how few actions share it and are sharpened (4th power) before normalising (plain normalisation never reached
  the 0.7 threshold when actions share words like "lights"); description sentences starting with "Not" are ignored;
  words naming a parameter value ("kitchen", "woonkamer") are ignored when choosing the action (in the utterance and in
  examples) unless the action's own description uses them; "close to an example" = Jaccard ≥ 0.75 of content words;
  question words (what, which, hoe, …) count in the score but not toward `fits`; number candidates: the first gets 0.7
  when it carries a unit.
- **`jev`** settings as §3.6 plus env `JEV_DECIDER`; thresholds have no environment variables.
- **`demo-home`**: no settings yet (constant house: 4 rooms with a main light each, Desk lamp, Reading lamp); targets
  `area:<room>`, `light:<lamp>`, `all` (room main lights are reached through their room); status "4 rooms · N lights on";
  a short `instructions` line says the home is pretend. `clock.time_now` uses a constant places list (Amsterdam, London,
  New York, Tokyo) until the `records` setting exists; `weather.today` takes the place after in/for/at/voor/te and drops
  trailing "today/now/vandaag/…".
- `packages/agent-intent` has a dev dependency on `@pva/modules-builtin` (end-to-end test); the lockfile gained that one link.

**Who reads what**

| Reader | Sections |
|---|---|
| Everyone | [0. Decisions at a glance](#0-decisions-at-a-glance), [6. Build plan](#6-build-plan), [9. Changes to existing interfaces](#9-changes-to-existing-interfaces) |
| Agent core and routing (piece A) | [1. Agents](#1-agents), [2. Routing](#2-routing-by-trigger-phrase) |
| Intent path and modules (pieces C, D, K) | [3. Typed intents](#3-the-typed-intent-path) |
| Adapters (pieces E, F, I, J, L) | [1.6–1.9](#16-agents-are-modules), [3.7](#37-decision-providers) |
| Settings, protocol, UI (pieces G, H) | [4. Settings](#4-settings), [5. Protocol and UI](#5-protocol-and-ui-changes) |

**Already in the repository (written with this document; nothing uses it yet, nothing existing was changed)**

| File | What | Tests |
|---|---|---|
| `packages/core/src/Agent.ts` | `Agent`, `AgentTurnInput`, `AgentEvent`, `AgentError`, `IntentDecisionInfo` | (types) |
| `packages/core/src/Routing.ts` | `Router`, `RoutingConfig`, `RouterState`, `RouteDecision`, `makeTriggerRouter` (tolerant trigger matching, stickiness, arming, availability fallback), `armAgent`, `setActiveAgent`, `activeAgent` | `test/Routing.test.ts` (24) |
| `packages/core/src/TextMatching.ts` | words with offsets, normalisation, phonetic keys, edit distance, spelled-letter joining (finished from the interrupted attempt) | `test/TextMatching.test.ts` (19) |
| `packages/core/src/Actions.ts` | `defineAction`, `Param.*` (six parameter kinds), `ActionError`, `RegisteredAction`, `actionToolName` | via `Decision.test.ts` |
| `packages/core/src/Decision.ts` | `DecisionProvider`, request/response types, `buildDecisionPlan` (one request per utterance), `interpretDecision` (thresholds, ask, confirm, fallback), `makeScriptedDecider` | `test/Decision.test.ts` (14) |
| `packages/core/src/ModuleContributions.ts` | `ModuleContributions` (agents, actions, deciders, dynamic options, info, field actions), `defineAgent`, `defineDecider` | `test/AgentModules.test.ts` |
| `packages/core/src/SettingsExtra.ts` | the five new field types' constructors and validation (`textList`, `records`, `combo`, `action`, `info`) | `test/AgentModules.test.ts` (12 in total) |
| `packages/protocol/src/agents.ts` | every protocol addition as a schema: new field types, `SettingFieldV2`, new messages, optional fields for existing structs, `ErrorCodeV2`. **Not** in the unions; `PROTOCOL_VERSION` still 1 | `test/agents.test.ts` (10) |
| `packages/protocol/src/agentExamples.ts` | examples of the additions (`@pva/protocol/agent-examples`) | |

The only edits to existing files: export lines in `packages/core/src/index.ts` and `packages/protocol/src/index.ts`, and the
`./agent-examples` entry in `packages/protocol/package.json`.

---

## 0. Decisions at a glance

| Topic | Decision | Why (short) |
|---|---|---|
| Agent interface | One `Agent` with `turn(input) → Stream<AgentEvent, AgentError>`. Three kinds: `model` (assistant runs the tool loop), `harness` (own loop and session), `intent` (decide and act) | `Conversation` treats every kind alike: text deltas to TTS, rounds to history, interruption by fiber |
| Existing `Llm` | Unchanged contract for "one model call". The tool loop moves out of `Conversation` into `makeModelAgent(llm)`; every `Llm` adapter gains a 30-line agent file | No adapter rewrites; the Anthropic adapter becomes one agent among several |
| Where agents live | **Agents are modules** (kind `agent`), decision providers are modules (kind `decider`), actions are a module contribution. Same host, settings, persistence, form, enable switch | "One file plus one line" for every pluggable thing; live reconfiguration (no engine reload) for agents |
| History | One shared transcript owned by `Conversation`. Model agents read it every turn; harness agents keep their own session and are sent a compact catch-up of what other agents said since their last turn | Switching agents mid-conversation keeps context; harness sessions cannot be rewritten |
| Speculation | Model agents: as today. Intent agents: decide speculatively, act only after promotion (read-only actions may run early). Harness agents: **wait for promotion by default** (setting to speculate) | A harness cannot take back a sent message, and a discard wastes subscription quota; ≈ 270 ms is the price, switchable |
| Routing | A pure, synchronous `Router` (≈ 10–16 µs measured) at the start of every turn, speculative ones included. Rules are settings data. Trigger at the start of the utterance; tolerant matching (greeting words interchangeable, phonetic keys, one edit for longer names, spelled letters, fillers skipped) | Zero added latency; misrecognitions like "hey Jeff" handled without the owner listing every variant |
| Trigger scope | Per rule: `turn` (that utterance) or `conversation` (sticky until another trigger, "hey assistant", the UI, or 2 min idle). Defaults: Jev `turn`, conversational agents `conversation` | Commands are one-offs; a follow-up question to Claude should stay with Claude |
| Trigger only ("Hey Jev.") | Speak "Yes?" (no model call) and arm that agent for the next utterance (10 s) | The natural pause after a wake phrase must not lose the command |
| Unavailable agent | The default agent answers, preceded by "Codex isn't available." when the owner asked for that agent on purpose; an agent that fails before saying anything is retried once on the default | The owner always gets an answer and knows who gave it |
| Typed intents | Modules declare actions with typed parameters of six kinds; ONE decision request per utterance (action choice + "does any fit?" + "several at once?" + every choosable parameter of every action); numbers, durations and free text parsed locally | Jev only chooses among supplied options; one round trip keeps it ≈ 250 ms |
| Low confidence | Not a command or not surely one → the conversational agent takes the turn (silently). Clear action, unclear or missing value → ask a short question ("Which room?") and arm the agent for the answer. Several actions at once → conversational agent | The conversational agent handles ambiguity better than a second decision round; asking is only worth it when the action is clear |
| Actions vs tools | Every action is also a tool for conversational agents (unless `offerAsTool: false`); tools are not automatically actions | "Turn on the living room lights" works through Jev and through Claude; a tool's JSON input cannot be mapped to choice questions |
| Speaking actions | An action's `announce` text is synthesised while the turn is still speculative and plays at promotion, while the action runs | The intent path then plays ≈ 15 ms after end of turn (*estimate*), not after the action's round trip |
| Decision providers | `DecisionProvider` interface: Jev (TypeSafe API, also any `/v1/systemone` server such as Ollama + Nimble), and an offline keyword decider that works with no key | Swappable; the intent path can be tried and tested today |
| Settings | Audit of every setting (§4.1). Five new field types: `textList`, `records`, `combo`, `action`, `info`. New tabs: Agents, Modules, Speech, Voices, This device, About | Everything sensible editable; the UI still renders only what the server describes |
| Voices | Per-voice sections keyed by the existing `VOICE_<NAME>_*` variables (provider, preset, speed, pauses, Cartesia voice), with "Play a sample" | The prefix wrapper already exists: zero adapter change |
| Protocol | All additions defined now in `agents.ts`; merged in one change with `PROTOCOL_VERSION = 2` (new field types are a closed-set change) | Others are building against v1 right now |
| Home automation | A Home Assistant module (areas and lights from HA's template API, cached) and a dependency-free `demo-home` module; `clock` and `weather` gain one action each | The realistic source plus a way to try everything without one |

### 0.1 How the owner's request was read

| Request | Interpretation |
|---|---|
| "Use my Claude and Codex subscriptions … hook into those harnesses" | Two `harness` agents driving the official CLIs with the owner's own login (Claude Agent SDK; `codex app-server`). Off by default, behind an explicit opt-in switch that states the terms are unclear (research §2). The API-key agents stay the supported default |
| "A local AI agent somewhere in my home network, or OpenRouter" | One OpenAI-compatible adapter with per-server profiles, shipped as two catalog entries: `home-model` (Ollama / llama.cpp / LM Studio / vLLM, chosen by a setting) and `openrouter`. A third endpoint is one catalog line |
| "Hey Jev … uses the TypeSafe agent" | "Jev" is TypeSafe's decision model (dictated as "Jeff"). The `jev` agent is the typed-intent responder; its decision provider is Jev when a TypeSafe key is set, otherwise the offline keyword decider |
| "Detect the lights … also send out the location" | An action `lights_on` with one parameter `target` whose values are the rooms and lights the home module knows at run time ("Living room", "Desk lamp", "All lights") |
| "Recognising the actions and having a list of programmatic actions" | Actions are declared by modules next to their tools; the list sent to Jev is built from the enabled modules on every utterance |
| "Modularity is key" | Agents, decision providers, routers and actions are each one interface + one file + one catalog line; routing rules are data |
| "Model and agent choice … API keys, system prompt" | Per-agent settings: model (picked from the backend's own list), keys, an optional per-agent system prompt, speculation, test button; the default agent and the rules in a Routing card |
| "Speech recognition (model, language, wait time)" | Owned by the speech-recognition implementer; this design only places their sections in a Speech tab (§4.4) |
| "Voices (which voice, speed, pauses, per-voice settings)" | Per-voice sections (§4.4), reload to apply, "Play a sample" |
| "Audit everything and expose all sensible settings" | §4.1: every environment variable and constant the app reads, with a verdict |

---

## 1. Agents

### 1.1 Kinds, and what happens to `Llm`

| Kind | Examples | Who runs the tool loop | History | Speculative turn | Barge-in |
|---|---|---|---|---|---|
| `model` | `anthropic` (API key), `openrouter`, `home-model`, `offline` stand-in | The assistant (`makeModelAgent`), as today | Shared transcript sent every request | Runs fully; non-speculative tools wait for promotion (today's rule) | Abort the HTTP request (fiber interruption) |
| `harness` | `claude-subscription`, `codex-subscription` | The harness; our tools are handed to it | Its own session + catch-up preface | **Waits for promotion** unless the agent's `speculate` setting is on | `query.interrupt()` / `turn/interrupt`, session kept |
| `intent` | `jev` | None (no model conversation) | Reads nothing; its spoken text is recorded | Decides speculatively; acts only after promotion unless the action is `speculative` | Stops speech; an action already started finishes |

`Llm` (`stream(request) → Stream<LlmEvent>`) stays exactly as it is: it is the contract for "one model call" and the
easiest thing to implement for a new backend. The `llm-anthropic` adapter is unchanged; it gets an `agent.ts` that wraps
it. The new OpenAI-compatible adapter implements `Llm` too. `LLM_PROVIDER` keeps working: CLI `bench` still uses it, and
when `DEFAULT_AGENT` is unset it picks the default agent (`anthropic` → `anthropic`, `fake` → `offline`). Serve mode stops
building an LLM stage in the engine: agents are modules now, so changing a model or key restarts that agent (10 s grace for
a turn in flight) instead of reloading the engines.

### 1.2 The interface (real code: `packages/core/src/Agent.ts`)

```ts
interface Agent {
  readonly id: string                    // its module id
  readonly name: string
  readonly kind: "model" | "harness" | "intent"
  readonly speculate: boolean            // may run before the turn is committed
  readonly systemPrompt?: string         // replaces the global prompt for this agent (instructions + voice block still appended)
  readonly firstEventTimeoutMs: number   // model 5000, harness 8000, intent 1500
  turn(input: AgentTurnInput): Stream<AgentEvent, AgentError>
}

interface AgentTurnInput {
  turnId; text /* trigger removed */; utterance /* as heard */; source; spoken; routedBy
  history: ReadonlyArray<Message>        // shared, committed only
  system: string; context: string | undefined
  tools: ToolRegistry["Service"]         // module tools + generated action tools
  actions: ReadonlyArray<RegisteredAction>; deciders: ReadonlyMap<string, DecisionProvider>
  promoted: Effect<void>                 // await before any side effect
  speculative: boolean
  mark(mark: TraceMark): void; trace: Trace; maxToolRounds: number
}

type AgentEvent =
  | { _tag: "TextDelta"; text }                     // spoken as it streams; exactly "\n" = round separator (flush)
  | { _tag: "ToolStarted"; call } | { _tag: "ToolFinished"; result; ms }      // recorded in history as rounds
  | { _tag: "Decision"; decision: IntentDecisionInfo }                        // intent agents; UI + trace
  | { _tag: "ActionStarted"; callId; actionId; label; params } | { _tag: "ActionFinished"; callId; ok; ms; error? }
  | { _tag: "ExpectReply" }                         // arm this agent for the next utterance
  | { _tag: "Handoff"; reason }                     // before any text: the fallback agent takes this turn
// Completion = the stream ends. Failure = AgentError { reason: "unavailable" | "timeout" | "failed" }.
```

Contract details:

- **Text.** Deltas are forwarded to the clause chunker unchanged; voice markers work for every agent kind (the voice block is
  in `system`). An agent emits `"\n"` before its first tool call that follows text, so "Let me check," is spoken while the
  tool runs (this is today's behaviour, now the agent's job; `makeModelAgent` does exactly what `assistantText` does today).
- **Rounds.** `Conversation` rebuilds the turn log from events: text accumulates in the current round (the `"\n"` separator
  is not part of it); `ToolStarted` adds a call to the current round, or opens a new one if the current round's calls all
  have results; `ToolFinished` records the result; text after a closed round opens a new round. History is committed with
  today's `commit` (interrupted turns keep only played clauses).
- **Actions** are *not* recorded as tool calls: the history of an intent turn is the user message and what was spoken
  ("Living room lights on."). A conversational agent reading the history then knows what happened without seeing tool calls
  for tools it may not have.
- **Side effects** wait for `promoted`. `Conversation` interrupts the stream of a discarded speculative turn; the agent must
  release everything on interruption (abort the request, interrupt the harness turn).
- **First event.** If no event arrives within `firstEventTimeoutMs` of `turn` being called, `Conversation` interrupts the
  stream and treats it as `AgentError("timeout")` (§1.9).
- **`Handoff`** is legal only before the first `TextDelta`; after text it is ignored with a warning.

### 1.3 A turn's path through router and agent

```
SttEvent / TextInput ─▶ Conversation.start(text, speculative, source, explicitAgent?)
   │  setup = yield* options.setup            (snapshot: agents, router, actions, deciders, tools, prompts)
   │  decision = setup.router.route({ text, source, explicitAgent, state, now, isAvailable })   ≈ 10–16 µs
   │  emit TurnStarted { agentId, routedBy, fallbackFrom?, agentText }
   ▼
   ├─ decision.agentId undefined ─────────▶ canned turn: "No agent is available right now."
   ├─ decision.acknowledge (trigger only) ─▶ canned turn: "Yes?" (or "Codex isn't available.")   not recorded
   └─ agent = setup.agents.get(decision.agentId)
        │  unavailable && reason ≠ default ─▶ first clause "Codex isn't available." (spoken while the default agent thinks)
        │  agent.speculate == false && speculative ─▶ await promoted before calling turn
        ▼
      agent.turn(input) ── TextDelta ─▶ chunker ─▶ Tts ─▶ (buffered until promoted) ─▶ AudioOutput
            │                ToolStarted/Finished ─▶ rounds (history) + events
            │                Decision / Action* ─▶ events (UI, trace)
            │                ExpectReply ─▶ router.armAgent on commit
            └─ Handoff, or AgentError before any text ─▶ same turn on fallbackFor(agent) ─▶ emit TurnAgentChanged
   on promotion / normal start: routerState = decision.next (+ armed if ExpectReply)
   on discard: routerState unchanged
```

`fallbackFor(agent)` = the default agent if it is conversational (kind `model` or `harness`), available and not `agent`;
else `RoutingConfig.fallbackAgent` if available; else a canned "I can't help with that right now."

### 1.4 History shared between agents

**Decision: one shared transcript, owned by `Conversation`, is the truth.** Each assistant `Message` gains an optional
`agentId` (who said it), and the user message stores the text the agent received (trigger removed; the UI keeps the full
utterance in `turn.start.userText`).

- **Model agents** get `history` every turn, as today. Messages from other agents are ordinary assistant messages to them.
  Prompt caching still works: history is append-only.
- **Harness agents** keep their own session (it cannot be replaced from outside). Each harness agent remembers
  `syncedThrough = input.history.length` at the start of each of its turns. At its next turn it looks at
  `missed = input.history.slice(syncedThrough)`:
  1. Drop the leading block that is its own previous turn: the first user message and the non-user messages after it up
     to the next user message, when the first assistant message in that block has `agentId` equal to its own id. If that
     own reply was `interrupted`, keep one line `(You were interrupted; the owner heard only: "…")`.
  2. Nothing left (and no interruption line) → send `text` as is.
  3. Otherwise prepend a catch-up block of the rest, at most the last 20 messages, tool messages omitted, each line
     `User: …` / `<agent name>: …` (names from `agentId`):
     `"<earlier>\nUser: turn on the lights\nJev: Living room lights on.\n</earlier>\n\n<text>"`.
  4. A new session (first turn, restart, crash) is primed the same way with the last 20 messages of `input.history`.
- **Intent agents** read no history (the decision is about one utterance); their pending question state is their own (§3.6).

Interrupted replies: the harness's own session holds the full reply it generated, while the shared history holds only what
was heard; the "(You were interrupted …)" line in the next catch-up corrects that.

### 1.5 Speculation and interruption, per kind

| | Speculative turn (from `EagerEndOfTurn`) | Discarded (`TurnResumed`) | Barge-in on a committed turn |
|---|---|---|---|
| `model` | Model call runs; text synthesised and buffered; speculative tools run; others wait for promotion | Request aborted; paid tokens of the partial reply are lost (today's decision) | Request aborted; history keeps played clauses |
| `harness`, `speculate: false` (default) | `Conversation` waits for promotion before `turn`; nothing reaches the harness | Nothing to undo | `interrupt()`; the session continues; next catch-up notes what was heard |
| `harness`, `speculate: true` | Message sent at `EagerEndOfTurn` | `interrupt()`: the partial message **stays in the harness session** and one call of quota is used | Same as above |
| `intent` | Decision request runs; `announce` synthesised; `speculative` actions run; others wait | Decision discarded (Jev costs ≈ $0.00002 per request; no side effect) | Speech stops; an action that started runs to completion (cannot half-switch a light) |

Close call — harness default `speculate: false`: speculation would save ≈ 270 ms (eager at 372 ms vs end of turn at 641 ms
after speech, README table), but real speech pauses longer than 250 ms mid-sentence are common, each would leave a partial
message in the Claude or Codex session and spend quota, and resuming a Claude session after `interrupt()` was **not
tested** (research §2). The setting is per agent ("Start before I finish speaking"), so the owner can measure both.

### 1.6 Agents are modules

`defineAgent` (real code, `ModuleContributions.ts`) declares a module of kind `agent` whose instance contributes one
`Agent`. A decision provider is `defineDecider` (kind `decider`). Any module may add `actions`. Consequences:

- The module host already does lifecycle (start with 10 s limit, scope, grace period, status line), settings
  (environment > saved > default, secrets in `secrets.json`), persistence, generated forms and live reconfiguration.
  Nothing new is needed except the snapshot carrying agents, actions and deciders (§9).
- An agent package adds **one file** (`agent.ts` exporting `defineAgent({...})`) and the app adds **one line** to
  `agentCatalog` in `apps/assistant/src/agents.ts` (new file; the host's catalog is `[...agentCatalog, ...moduleCatalog]`).
- `enabledByDefault` is `false` for agents (they need keys, logins or opt-ins), except `offline` and `jev` (which works with
  the keyword decider) and the `keywords` decider.
- The host adds a **Test** button (`action` field, key `test`) to every agent's form. Pressing it runs
  `agent.turn` with `text: "Say hello in five words."`, empty history, no tools, already promoted, outside the conversation,
  and answers `result.detail`: `"First text after 640 ms, done after 910 ms: 'Hello there, nice to meet you.'"` (or the
  error). For deciders the test sends a fixed two-action request and reports the round trip and the answer.
- An agent may expose `settingOptions` (model list for its `combo` field, fetched at start and cached), `info` values
  ("Logged in with a Max plan") and extra `fieldActions` ("Refresh model list").

Catalog (initial; ids are module ids and are what routing rules name):

| id | Name | Kind | Package | Enabled by default |
|---|---|---|---|---|
| `anthropic` | Claude (API) | model | `llm-anthropic` (`agent.ts`) | no (needs a key; enabled automatically when `ANTHROPIC_API_KEY` is set and no saved intent exists) |
| `openrouter` | OpenRouter | model | `llm-openai-compatible` | no |
| `home-model` | Home model server | model | `llm-openai-compatible` | no |
| `offline` | Offline stand-in | model | `apps/assistant/src/agents/offline.ts` (wraps `FakeLlm`) | yes |
| `claude-subscription` | Claude subscription | harness | `agent-claude-code` | no (opt-in) |
| `codex-subscription` | Codex subscription | harness | `agent-codex` | no (opt-in) |
| `jev` | Jev | intent | `agent-intent` | yes |
| `jev-typesafe` | TypeSafe Jev | decider | `decide-typesafe` | no (needs a key; enabled automatically when `TYPESAFE_API_KEY` is set) |
| `keywords` | Offline keywords | decider | `agent-intent` | yes |

("Enabled automatically when the key is set" = the definition's `enabledByDefault` is computed from the environment when
the catalog is built; a saved intent always wins.)

### 1.7 Model agents

`makeModelAgent({ llm })` (new, `packages/core/src/ModelAgent.ts`, piece A) is today's `assistantText` loop moved out of
`Conversation`: request = `{ system: input.system, context: input.context, messages: [...history, user, ...rounds], tools:
input.tools.specs }`, `mark("llmRequestSent")` / `mark("llmFirstToken")`, tool calls run through `input.tools.run` after
awaiting `promoted` for non-speculative ones, `ToolStarted`/`ToolFinished` events, the `"\n"` flush, `maxToolRounds`.
`Conversation.layer` / `layerWithSetup` (which take an `Llm`) keep their signatures and build a one-agent set from it, so
every existing caller and test is unchanged.

Agent files (piece F for `anthropic` and `offline`, piece E for the OpenAI-compatible ones):

```ts
// packages/llm-anthropic/src/agent.ts
export const anthropicAgent = defineAgent({
  id: "anthropic", name: "Claude (API)", kind: "model",
  description: "Anthropic's API with your API key. Fast and the supported default.",
  settings: {
    apiKey: Setting.secret({ label: "API key", env: "ANTHROPIC_API_KEY", required: true }),
    model: Setting.combo({ label: "Model", env: "ANTHROPIC_MODEL", default: "claude-haiku-5-5" }),
    systemPrompt: Setting.text({ label: "System prompt for this agent", multiline: true, maxLength: 4000,
      description: "Empty: the global prompt (Agents → All agents)." }),
    maxTokens: Setting.number({ ..., env: "ANTHROPIC_MAX_TOKENS", default: 1024, advanced: true }),
    effort: Setting.choice({ ..., env: "ANTHROPIC_EFFORT", advanced: true }),
    thinking: Setting.choice({ ..., env: "ANTHROPIC_THINKING", advanced: true }),
    timeoutMs: Setting.number({ ..., env: "ANTHROPIC_TIMEOUT_MS", advanced: true }),
    warmUp: Setting.boolean({ ..., env: "ANTHROPIC_WARM_UP", advanced: true }),
    baseUrl: Setting.text({ ..., env: "ANTHROPIC_BASE_URL", advanced: true }),
  },
  start: ({ settings }) => Effect.gen(function*() {
    const llm = yield* AnthropicLlm.make({ ...settings, apiKey: Redacted.make(settings.apiKey!) })   // warm-up included
    const models = yield* listModels(settings).pipe(Effect.orElseSucceed(() => []))                   // GET /v1/models, 2 s
    return { systemPrompt: settings.systemPrompt, turn: makeModelAgent({ llm }).turn,
             settingOptions: () => ({ model: models }) }
  })
})
```

**OpenAI-compatible adapter** (`packages/llm-openai-compatible`, piece E): plain `fetch` + an SSE parser (no SDK), the
lowest common denominator of research §4: `POST {base}/chat/completions` with `stream: true`, `messages`, `tools`;
tool-call deltas accumulated by `index`; lines starting with `:` skipped; `reasoning` / `reasoning_content` deltas never
spoken; an `error` chunk inside a 200 stream fails the turn; `Authorization: Bearer <key or "none">`; `GET {base}/models`
for the model list. A `profile` object per server holds the quirks:

| Profile | Base URL default | Key | Extra body | Model list |
|---|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | required | `provider: { sort: "latency" }` (setting), `reasoning: { effort }` only if the model lists it | `/models`, filtered to models with tools support and not `reasoning.mandatory` |
| `ollama` | `http://<host>:11434/v1` | ignored | `reasoning_effort` when set | `/models` |
| `llamacpp` | `http://<host>:8080/v1` | optional | none | `/models` (the loaded model only) |
| `lmstudio` | `http://<host>:1234/v1` | optional | none | `/models` |
| `vllm` | `http://<host>:8000/v1` | optional | none | `/models` |
| `generic` | (setting) | optional | none | `/models` |

Catalog entries: `openAiCompatibleAgent({ id: "openrouter", name: "OpenRouter", fixedProfile: "openrouter", envPrefix:
"OPENROUTER_" })` and `openAiCompatibleAgent({ id: "home-model", name: "Home model server", envPrefix: "HOME_MODEL_" })`,
whose `server` setting chooses the profile. Settings: `server` (home-model only), `baseUrl`, `apiKey`, `model` (combo),
`systemPrompt`, `maxTokens` (default 512), `temperature` (advanced), `reasoningEffort` (advanced; `none` default where
supported), `timeoutMs` (first byte, default 5000), `sortByLatency` (OpenRouter), test. Start checks reachability with
`GET /models` (2 s) so a wrong address is a start error, not a failed turn.

### 1.8 Harness agents

**Claude subscription** (`packages/agent-claude-code`, piece J), from research §2 (all **[run]** unless marked):

- `@anthropic-ai/claude-agent-sdk` (pin the version the research ran, 0.3.323) in streaming-input mode: **one long-lived
  `query()` per session**, input fed from a queue, output read with manual `iterator.next()` (a `for await … break`
  closes the session). Options: `model`, `tools: []`, `settingSources: []`, `strictMcpConfig: true`,
  `env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }`, `persistSession: false`, `thinking: { type:
  "disabled" }`, `includePartialMessages: true`, `systemPrompt: input.system`, and, when tools are on, `mcpServers: {
  assistant: createSdkMcpServer(...) }` with `allowedTools` listing them.
- **Opt-in.** Setting `optIn` ("I understand Anthropic's terms for using a subscription from other software are unclear,
  and I accept that", default off, env `CLAUDE_SUBSCRIPTION_OPT_IN`). With it off, `start` fails with that sentence, so the
  card shows why. The assistant never reads or stores Claude credentials; login happens in `claude` itself.
- **Start** spawns the session and waits for the SDK's `init` message (≤ 10 s, the host limit). `apiKeySource` must be
  `"none"` (subscription login); otherwise `ModuleStartError("Claude Code is not logged in with a subscription: run
  `claude` and log in.")`. `info.login` shows the plan from `claude auth status` (`subscriptionType`).
- **Warm-up:** the process is started at module start, so its startup (≈ 0.3–1.3 s of the cold numbers) is off the turn
  path. No warm-up *turn* (it would spend quota and put a message in the session). First turn measured 1172 ms to first
  text, later turns median 866 ms.
- **Turn:** apply the catch-up (§1.4), prepend `<context>…</context>` when `input.context` is set, push the user message,
  map `stream_event` `text_delta` → `TextDelta` (`mark("llmFirstToken")` on the first), MCP tool handler calls →
  `ToolStarted`/`ToolFinished` (the handler awaits `input.promoted` for non-speculative tools and runs
  `input.tools.run`), `result` → end of stream. Emit `"\n"` before a tool call that follows text.
- **Tools** (setting, default on): the MCP server is built from `input.tools` at session start; when the snapshot's tool
  list or `system` changes, the session is restarted at the next turn boundary (re-primed by catch-up). A tool round trip
  costs ≈ +1.7–2.2 s (measured), so latency-critical facts stay in `context` (the clock is a context provider already).
  First-turn tool visibility is flaky (one of three runs did not see the tool): set `alwaysLoad: true` **[verify]**.
- **Interruption:** on stream interruption call `query.interrupt()` and wait (≤ 1 s) for its `result`
  (`error_during_execution`). The next `turn` waits for that. If the session errors afterwards (resuming after interrupt is
  **[verify]**), restart it transparently with a catch-up of the last 20 messages.
- **Session lifetime:** restarted when settings change (module restart), when tools or `system` change, after a crash,
  and after `sessionIdleMinutes` (default 60) without a turn (bounds memory growth, which is untested). Limits: `maxTurns`
  per harness turn 4, a turn timeout of 30 s (`AgentError("timeout")`).
- **Settings:** `optIn`, `model` (combo with `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`; default Haiku),
  `systemPrompt`, `speculate` (default off), `tools` (default on), `sessionIdleMinutes`, `claudePath` (advanced; default:
  the SDK's bundled binary), test.

**Codex subscription** (`packages/agent-codex`, piece L, last). Nothing was measured: the CLI is not logged in. Design:

- `codex app-server` (JSON-RPC over stdio), one process and one thread per session: `initialize`, `account/read` at start
  (`account: null` → `ModuleStartError("Codex is not logged in: run `codex login` and choose Sign in with ChatGPT.")`,
  fails fast instead of the CLI's ~10 s of retries), `thread/start { model, ephemeral: true, sandbox: "read-only",
  approvalPolicy: "never", baseInstructions: input.system }`, per turn `turn/start { threadId, input: [{ type: "text",
  text }], effort }`, `item/agentMessage/delta` → `TextDelta`, `turn/completed` → end, barge-in `turn/interrupt`.
- Same opt-in switch, `speculate` default off, model combo from `model/list`, `effort` default `low`.
- **No tools in the first version**: how client-defined tools are registered was not found (`DynamicToolSpec` exists in
  the schema). The assistant's tools reach Codex only after that is verified.
- **[verify] before it can be finished:** `codex login` works headless (device code); `thread/start` / `turn/start`
  against a model; deltas arrive as documented; `turn/interrupt` leaves the thread usable; which model is fastest and its
  time to first text; whether the built-in shell tool is still offered under `read-only` (if so, add
  `developerInstructions` forbidding it and treat output as untrusted); dynamic or MCP tool registration.
- Its absence blocks nothing: it is one catalog entry, disabled by default.

### 1.9 Failure and fallback

| Situation | Behaviour | Spoken |
|---|---|---|
| Routed agent not running (disabled, starting, error) | Default agent answers (router; `unavailable` set) | If the owner chose it (trigger, armed, sticky, explicit): first clause "`<Name>` isn't available." then the answer |
| Default agent not running either | `RoutingConfig.fallbackAgent` if running | Same notice |
| No agent running at all | Canned turn, not recorded | "No agent is available right now. Check the agents in the options." |
| Agent fails before any text (`AgentError`, or no first event within `firstEventTimeoutMs`) | Same turn re-run once on `fallbackFor(agent)`; `turn.agent { reason: "failed" }` | "`<Name>` isn't available." then the answer |
| Agent fails after text | Turn fails, committed as interrupted (today's rule); `error turn_failed` | What was played |
| Intent agent: no match, uncertain, compound, decider error or timeout | `Handoff` → `fallbackFor(jev)`; `turn.agent { reason: "handoff" }`; `intent.decision` shows why | Nothing extra (the answer is the answer) |
| Harness session crashed between turns | Restarted at the next turn with catch-up; if the restart fails → `AgentError("unavailable")` → fallback row above | As above |

No automatic retry of the *same* agent: a retry on the voice path doubles latency for a rare gain.

### 1.10 Latency trace attribution

`Trace` gains `agent?: { id, kind, routedBy, fallbackFrom? }` and four marks for intent turns. Existing marks keep their
meaning for model agents and are reused, with the same meaning, by harness agents (`llmRequestSent` = message written to
the harness, `llmFirstToken` = first text delta), so the latency readout's columns stay comparable across kinds.

| Mark | model | harness | intent |
|---|---|---|---|
| `llmRequestSent` | each model request (first counts) | user message sent to the harness | — |
| `llmFirstToken` | first text delta | first text delta | — |
| `decisionSent` / `decisionReceived` | — | — | decision request out / answer in |
| `actionStarted` / `actionFinished` | — | — | action `run` |
| `firstClause`, `ttsFirstAudio`, `playbackStart` | unchanged | unchanged | unchanged |
| `trace.tools` | tool calls | tool calls reported by the harness | the action (name = its tool name) |

`formatTrace` prints `agent=jev(trigger)` and the new marks when present; `TraceInfo` carries them (`TraceAgentFields`,
`TraceMarkAdditions` in `agents.ts`). The routing cost is not a mark: 10–16 µs (measured, §2.3) is below the clock's noise.

### 1.11 Expected time from end of speech to first audio

Measured base (README, development machine, nemotron-3.5, 250/600 ms): `EagerEndOfTurn` at **372 ms** and `EndOfTurn` at
**641 ms** after the speech ends (medians); with a speculative turn already synthesised, playback starts ≈ 15 ms after
`EndOfTurn` in the browser (779 vs 765 ms CLI at the same model speed); first Piper audio 20–30 ms after a clause.

| Path | Time to first audio (median) | Basis |
|---|---|---|
| Conversational, simulated 300 ms model (today's benchmark) | **729 ms** CLI, 779 ms browser | measured |
| Conversational, Anthropic Haiku via API | ≈ 372 + TTFT + ≈ 60 ms; with TTFT 400–700 ms → **≈ 830–1130 ms** | *estimate*: Haiku API TTFT is unmeasured |
| Conversational, home GPU server (warm 7–8B) | bounded by end of turn: **≈ 660–750 ms** | *estimate* (research's unmeasured expectation of 0.1–0.3 s TTFT) |
| Conversational, OpenRouter small model | ≈ 372 + 300–800 + 60 → **≈ 730–1230 ms** | *estimate* |
| Claude subscription, `speculate: false` (default) | 641 + 866 (warm first text) + ≈ 80 (first clause) + 30 + 15 → **≈ 1.6 s** | measured parts (first text median 866 ms, first sentence 1110 ms) |
| Claude subscription, `speculate: true` | 372 + 866 + ≈ 125 → **≈ 1.35 s** | measured parts |
| Claude subscription, one tool call | **≈ 3.5 s** | measured (3567 / 3631 ms first text) |
| Codex subscription | unknown | not measured |
| **Intent (Jev), action with `announce`** | decision done at 372 + ≈ 250 = 622 ms < 641: announcement synthesised during speculation, plays at promotion → **≈ 660 ms**; with Jev's p95 (347 ms) ≈ 720 ms | Jev latency is a third party's measurement (median 247 ms), not from this machine |
| Intent, offline keyword decider | **≈ 660 ms** (bounded by end of turn) | *estimate*; decider is local and sub-millisecond |
| Intent, query action (`clock.time_now`, speculative) | **≈ 660 ms** | *estimate* |
| Intent, no speculation (end of turn came without an eager one) | 641 + 250 + 30 + 15 → **≈ 940 ms** | *estimate* |
| Routing, any path | **+0.01–0.02 ms** | measured: 8.7–16.2 µs per utterance with the default rules (`tsx`, this machine) |

So the intent path is bounded by turn detection and beats a 300 ms model by ≈ 70 ms, a realistic hosted model by
≈ 200–450 ms, and the Claude subscription by ≈ 1 s. Its remaining cost is the 600 ms silence wait; committing early when the
decision is confident is a possible later step (§7). Every number above becomes a `TurnTrace` measurement once the pieces
land; the build plan says which.

### 1.12 What changes in `Conversation` (piece A)

All additive; existing options, inputs and events keep their meaning.

- `makeAgentConversation(options: AgentConversationOptions)` / `Conversation.layerWithAgents(...)`: like
  `layerWithSetup` but `setup: Effect<AgentTurnSetup>` and no `Llm` requirement.
  `AgentTurnSetup = TurnSetup & { agents: AgentSet }`,
  `AgentSet = { router: Router; agents: ReadonlyMap<string, Agent>; names: ReadonlyMap<string, string> /* every catalog agent */; actions; deciders; maxToolRounds; promptFor(agent): string; fallbackAgent?: string; acknowledgement: string }`.
  `makeConversationWithSetup` becomes a wrapper that builds a one-agent set (`makeModelAgent` over its `Llm`, a router that
  always returns it): identical behaviour, so the 100 existing core tests pass unchanged.
- Setup is read once in `start` (before `TurnStarted`, it is a reference read), not inside the turn fiber; the context
  providers still run inside the fiber.
- Router state lives in the voice loop; `decision.next` (plus an `ExpectReply` arm) is applied when the turn is committed
  (non-speculative start, or promotion). A discarded turn changes nothing. `textTurn` (CLI text mode) routes too and
  commits at once.
- `ConversationInput` gains `TextInput.agentId?` and two inputs: `{ _tag: "SetActiveAgent"; agentId: string | null }`
  (from `routing.set`; applied at once) and `{ _tag: "Say"; text: string; voice?: string }` (a canned spoken turn that is
  not recorded: "Play a sample", trigger acknowledgements use the same path internally). `Say` interrupts like
  `TextInput`.
- `ConversationEvent` changes: `TurnStarted` gains `agentId?`, `routedBy?`, `fallbackFrom?`, `agentText?`, `canned?`;
  new `TurnAgentChanged { turnId, agentId, from, reason: "handoff" | "failed" }`, `IntentDecided { turnId, decision }`,
  `ActionStarted { turnId, callId, actionId, label, params }`, `ActionFinished { turnId, callId, ok, ms, error? }`,
  `RoutingChanged { state }` (after each commit that changed it, and on `SetActiveAgent`).
- `MAX_TOOL_ROUNDS` becomes live (read per turn from the setup) instead of an engine reload.

---

## 2. Routing by trigger phrase

Real code: `packages/core/src/Routing.ts` (pure; 24 tests). Integration into `Conversation`: piece A.

### 2.1 Rules are data

```ts
interface RoutingConfig {
  defaultAgent: string                 // DEFAULT_AGENT
  fallbackAgent?: string               // ROUTING_FALLBACK_AGENT: answers when the default cannot
  rules: Array<{ agent: string /* agent id or "@default" */; phrases: string[]; mode: "turn" | "conversation" }>
  greetings: string[]                  // interchangeable first words: hey, hi, hello, hay, ok, okay, oke, yo, he, hoi, hallo
  fillers: string[]                    // skipped at the start: um, uh, er, eh, euh, hmm, so, …
  requireGreeting: boolean             // default false
  stickyIdleMs: number                 // default 120 000
  armedMs: number                      // default 10 000
  acknowledgement: string              // default "Yes?"
}
```

All of it comes from the `routing` settings section (§4.4), live: the router is rebuilt when the section changes and each
turn's setup holds the current one. Default rules:

| Agent | Phrases | Mode |
|---|---|---|
| `jev` | "hey jev", "hey jeff" | turn |
| `claude-subscription` | "hey claude" | conversation |
| `codex-subscription` | "hey codex" | conversation |
| `openrouter` | "hey router", "hey open router" | conversation |
| `home-model` | "hey local", "hey home" | conversation |
| `@default` | "hey assistant", "back to normal" | conversation (selecting the default clears stickiness) |

A rule for an agent that is not running is harmless: the route falls back (§1.9). The settings screen warns next to a rule
whose agent is disabled.

### 2.2 How the agent for a turn is chosen

`route(input)` checks in this order (first match wins); the result carries `next`, the router state to keep if the turn is
committed.

| # | Condition | Agent | `reason` | State after commit |
|---|---|---|---|---|
| 1 | `explicitAgent` (chat composer) | that agent; a trigger in the text is still removed | `explicit` | sticky kept as is; armed cleared |
| 2 | trigger at the start | the rule's agent (`@default` → default) | `trigger` | `conversation` rule: sticky = that agent (cleared for the default); `turn` rule: sticky kept, not refreshed. Trigger only: also armed |
| 3 | an armed agent (`now < until`) | the armed agent | `armed` | armed cleared; sticky refreshed if it is the same agent |
| 4 | sticky and `now − lastUsedAt < stickyIdleMs` | the sticky agent | `sticky` | `lastUsedAt = now` |
| 5 | otherwise | default | `default` | empty |

Then availability: if the chosen agent is not running, the default answers (or `fallbackAgent`, or nobody), `unavailable`
names the missing agent, and `next` never sticks to or arms it. Getting back to the default: say a `@default` phrase
("hey assistant"), wait two minutes, press **Back to <default>** in the UI (`routing.set { agentId: null }`), or choose
"Auto" in the composer.

### 2.3 Tolerant matching

Only the first 160 characters are scanned; a trigger is recognised only at the start of the utterance.

1. Split into words with offsets (`TextMatching.words`: lower case, no diacritics, no apostrophes), join runs of
   single letters ("J. E. V." → `jev`), skip leading fillers.
2. A phrase whose first word is a greeting matches *any* greeting word there ("hey jev" also matches "hi Jev", "okay Jev",
   "hé Jev"). Greeting words also match by phonetic key.
3. Each other phrase word must match the next utterance word with a score:

   | Match | Score | Example |
   |---|---|---|
   | same normalised word | 1 | "Jev" |
   | same phonetic key (`phoneticWord`: ph/v → f, soft g → j, c/ck/q → k, vowel runs and doubled letters collapsed, final silent e dropped) | 0.9 | "Jeff", "Jef", "Jeph" → `jef` |
   | one edit apart, both words ≥ 4 letters | 0.8 | "Cluade" |
   | phonetic keys one edit apart, both keys ≥ 4 letters | 0.75 | "cloud" (`klod`) ≈ "claude" (`klad`) |
   | anything else | no match | "Jen", "rev" (3 letters: exact or phonetic only) |

4. Greeting missing ("Jev, lights off"): accepted when every name word scored ≥ 0.9, scored 0.85; refused when
   `requireGreeting` is on.
5. Best phrase: the one matching more utterance words ("hey open router" beats "hey open"), then the higher score, then
   rule order.
6. The agent receives the text after the matched words with leading punctuation removed and the first letter upper-cased:
   "Hey Jeff, turn on the lights." → "Turn on the lights."

The owner adds aliases for misrecognitions the rules do not cover (the phrases list is per rule). Misrecognitions seen so
far: "hey Jeff" (dictation). To check a phrase, type it in the chat with the composer on "Auto": the reply is labelled with
the agent it went to, and `turn.start.agentText` shows what was removed.

### 2.4 Trigger-only utterances, arming and stickiness

- **Only the trigger** ("Hey Jev."): no agent runs. `Conversation` speaks `acknowledgement` ("Yes?") as a canned turn, not
  recorded in history, and the agent is armed for 10 s. If the pause after "hey Jev" is longer than the eager silence but
  the owner continues, the speculative "Yes?" is discarded with the turn (`TurnResumed`) and the full sentence is routed
  normally. If the agent is not running, the canned turn says "Jev isn't available." instead and nothing is armed.
- **An agent asks** ("Which room?"): it emits `ExpectReply`; on commit the router arms it, so "the kitchen" goes back to it
  without a trigger.
- **Sticky** (`conversation` rules, or `routing.set`): lasts until another trigger, the default's phrase, `routing.set null`,
  or `stickyIdleMs` (2 min) with no turn for that agent. A `turn` trigger for another agent in between does not end it.

### 2.5 Typed messages

`text.send` gains `agentId?`. Absent ("Auto" in the composer) → routed exactly like speech, so typing "hey jev lights off"
works. Present → reason `explicit`. The composer shows an agent chip: "Auto · Claude (API)" (the active agent), and a menu
of running agents plus "Auto"; the choice is per device (`localStorage`). `agentId` naming an agent that is not running →
`result { ok: false, error: { code: "agent_unavailable" } }` and no turn.

### 2.6 Speculative end of turn

The route is computed from the eager transcript when the speculative turn starts (synchronously, before anything else), and
kept when the turn is promoted (promotion already requires the same text). A different final transcript starts a new turn,
routed anew. Router state changes only on commit, so a discarded speculative turn ("hey Claude" … resumed) never makes Claude
sticky. Cost: 8.7–16.2 µs per utterance (measured, default rules), so routing adds nothing measurable to either path.

### 2.7 Showing who answers

- `turn.start` carries `agent` (`{ id, name, kind }`), `routedBy`, `fallbackFrom`, and `agentText` (what the agent got).
  `turn.agent` reports a hand-off or a failure fallback mid-turn.
- `routing` messages (and `snapshot.routing`) carry the active agent and its expiry.
- UI (§5.3): the visualiser label reads `THINKING · JEV`, `SPEAKING · CLAUDE (API) · natural`; the chat labels each reply
  with its agent name instead of "ASSISTANT"; the top bar shows a chip when the active agent is not the default.

### 2.8 Replacing the router

`Router` is an interface (`route`, `matchTrigger`). Another implementation is one file returning the same shape, chosen in
`apps/assistant/src/agents.ts`. It must stay synchronous: anything that needs a model call (a semantic router) is an agent
(like `jev`, which hands off what it cannot do), not a router.

---

## 3. The typed-intent path

Real code: `Actions.ts`, `Decision.ts` (pure: request assembly and interpretation; 14 tests). Built in piece C: the intent
agent, the value parser, the keyword decider, the generated tools; piece D: the modules; piece I: the Jev provider.

### 3.1 Declaring actions

A module returns `actions` next to `tools` (`ModuleContributions.actions`):

```ts
defineAction({
  id: "lights_on",                                  // global id "demo-home.lights_on"
  label: "Turn lights on",
  description: "Switch on the lights in a room, one light, or every light. Not for dimming: that is set_brightness.",
  examples: ["turn on the kitchen lights", "doe het licht aan in de woonkamer"],
  params: { target: Param.dynamic({ label: "Room or light", options: () => home.targets() }) },
  speculative: false,                               // default: run waits for the end of the turn
  confirm: false,                                   // true / (params) => "Unlock the front door?"
  offerAsTool: true,                                // default
  announce: ({ target }) => `${home.labelOf(target)} on.`,
  run: ({ target }) => home.switch(target, true)    // Effect<ActionOutcome | void, ActionError>, ≤ 5 s
})
```

Parameter kinds (closed set; `Param.*`):

| Kind | Filled by | Value | Request | Example |
|---|---|---|---|---|
| `choice` | decision model | one of the fixed option values | choice over the options (label + aliases + description) | a scene, a mode |
| `dynamic` | decision model | one of the values the module supplies now (`options()`, synchronous, from its cache; ≤ 255) | choice over them | rooms and lights |
| `number` | local parser; model only to pick among several candidates | number in `[min, max]` | nothing, or a choice over the candidates + "none" | "40 percent" |
| `duration` | local parser; same | milliseconds | same | "ten minutes", "anderhalf uur" |
| `boolean` | decision model | `noul ≥ 0.5` | yes/no question (`question` required) | "dimmed rather than off?" |
| `text` | local code: words after the first of `after` (≤ `maxWords`) | string | nothing | "weather in **Paris**" |

Every parameter may be `optional` (with an optional `default`); an optional choice also gets a "does the utterance say
which …?" yes/no question so an unstated value is never guessed. `question` words the decision question (about meaning);
`ask` words the spoken follow-up ("Which room?").

### 3.2 Actions and tools

**Every action is offered to conversational agents as a tool** unless `offerAsTool: false` (piece C,
`actionTool(registered)`): name `actionToolName(moduleId, id)` (`demo-home_lights_on`), description = label + description,
input schema: `choice` → enum of values; `dynamic` → string ("one of the names the owner uses for a room or light"),
resolved at execution against the current options by label, value or alias with `TextMatching` (exact, then phonetic), an
unresolved name returning an error result that lists the valid names (so a changing room list never changes the cached tool
schema); `number` → number; `duration` → string parsed by the value parser; `boolean` → boolean; `text` → string. The
tool's `speculative` = the action's. The tool runs `run` and returns `say` (or "ok"). So "turn on the living room lights"
works through Jev and through any conversational agent, with one implementation.

Tools are **not** turned into actions automatically (a JSON-schema input cannot be mapped onto choice questions). A module
that wants both declares the action and lets the tool be generated, or keeps a hand-written tool and sets
`offerAsTool: false` on the action (weather does this: its `weather` tool exists).

The host checks generated tool names for clashes exactly as it checks tool names today (§1.4 of UI-AND-MODULES).

### 3.3 One request per utterance

`buildDecisionPlan({ utterance, actions, pending?, parse })` builds the request; Jev sees it as `state` + `questions`:

| Question name | Type | Content | Read when |
|---|---|---|---|
| `action` | choice | one option per action (≤ 255): `"<label>. <description> For example: "…"; "…"."` | always |
| `fits` | yes/no | "Does the utterance ask the assistant to do one of the available_actions?" (the companion question: a choice always picks something) | always |
| `compound` | yes/no | "Does the utterance ask for two or more different actions at once?" | always |
| `<action>/<param>` | choice | the parameter's options (`"Living room (also called: lounge, woonkamer)"`), or number candidates + `none` | for the chosen action only |
| `<action>/<param>?` | yes/no | "Does the utterance say which <label> it means?" (optional choices) | chosen action only |
| `<action>/<param>` | yes/no | a boolean parameter's question | chosen action only |
| `pending/answers`, `pending/answer`, `pending/yes` | yes/no, choice, yes/no | when a question or confirmation is pending (§3.4) | first |

`state` = `{ utterance, available_actions: { id: label }, question_asked? }`: the trigger-free utterance and action labels,
nothing else about the owner. Parameters with a single possible value, numbers with one candidate, and text are filled
locally and not asked. All parameters of all actions are asked in the same request (TypeSafe's "speculative fan-out": more
questions "usually" do not slow it; sequential requests would). Each question carries a machine-readable `role`, which the
Jev adapter strips and the keyword decider uses. Limits: 255 options per choice (excess actions or values dropped with a
warning on the agent's status line); 64k tokens per request (≈ 100 actions with short descriptions stay far below).

### 3.4 Decision flow and thresholds

Real code: `interpretDecision(plan, response, thresholds)`. Thresholds are settings of the `jev` agent; the defaults are
TypeSafe's suggested starting points and must be tuned on the owner's own utterances. The probability of the chosen option
is compared, never Jev's `confidence`.

```
pending question or confirmation?  ── pending/answers ≥ 0.5 ──▶ confirm: pending/yes ≥ 0.8 → ACT, else CANCELLED ("OK, I won't.")
        │                                                        param:  value found (p ≥ 0.6) → continue below with it
        │                                                                not found → FALLBACK uncertain
        no (or answers < 0.5: a new request; the pending one is dropped)
        ▼
no actions offered ─────────────────────────────▶ FALLBACK no_match
compound ≥ 0.5 ─────────────────────────────────▶ FALLBACK compound
fits < 0.3 ─────────────────────────────────────▶ FALLBACK no_match
fits < 0.7  or  p(chosen action) < 0.7 ─────────▶ FALLBACK uncertain
        ▼ action chosen
for each parameter: fixed → use · flag → noul ≥ 0.5 · optional and "says which?" < 0.5 → default
                    choice p ≥ 0.6 → use · else → missing
        ▼
missing required value? ──▶ ASK "<ask>" (pending; ExpectReply arms Jev for 10 s … pending kept 15 s)
action.confirm? ──────────▶ CONFIRM "<label>?" (pending)
        ▼
ACT  (probability = min of fits, action and every chosen value)
```

| Outcome | What the intent agent does | Spoken |
|---|---|---|
| ACT | emit `Decision`; speak `announce` (if any) at once; await `promoted` unless the action is `speculative`; `ActionStarted`; run (uninterruptible, 5 s limit); `ActionFinished`; speak `say` (if any) | "Living room lights on." / "It's 14:32." |
| ACT, action fails | as above, then the error | "Living room lights on. Sorry, Home Assistant did not answer." (with `speakBeforeDone` on) |
| ASK | emit `Decision`, speak the question, `ExpectReply`; keep the pending intent for `pendingSeconds` (15) | "Which room or light?" |
| CONFIRM | same as ASK | "Switch everything off?" |
| CANCELLED | | "OK, I won't." |
| FALLBACK | emit `Decision` (outcome `fallback`, reason), then `Handoff`; the conversational agent answers the same text | (its answer) |

Decided, with reasons:

- **Uncertain action → conversational agent**, not "Did you mean X or Y?": the conversational agent has the actions as
  tools, so it can do the action itself or ask a better question; a second decision round would add a turn for a gain the
  conversational agent already provides.
- **Clear action, unclear value → ask.** One short question is faster than a conversational round trip, and the answer goes
  back to Jev through arming.
- **Asked once.** A reply that still leaves the value unclear falls back (no loops).
- **No match → silent fallback** (setting `onNoMatch`: `fallback` default, or `say` = "I can't do that." for an owner who
  wants Jev to stay strict).
- **`speakBeforeDone`** (default on): `announce` plays while the action runs. Off: it is spoken after `run` succeeds (adds
  the action's time, ≈ 50–150 ms for Home Assistant on the LAN, *estimate*).

### 3.5 Local value parsing (piece C, `packages/core/src/ValueParsing.ts`)

`parseValues: ValueParser` returns candidates `{ text, value }` for `number` and `duration`, English and Dutch:

- numbers: digits ("40", "21.5", "21,5"), words 0–100 ("forty", "veertig", "eenentwintig"), "a/one/een", "half/halve",
  "a quarter/een kwart", percentages ("40%", "forty percent", "veertig procent");
- durations: `<number> <unit>` with second(s)/seconde(n), minute(s)/minuut/minuten, hour(s)/uur, "an hour and a half",
  "anderhalf uur", "een kwartier" (15 min), "half an hour/half uur", combinations ("one hour twenty minutes");
- a number followed by the parameter's `unit` word ranks first; candidates out of range are dropped by the plan.

Tested with a table of English and Dutch phrases. The free-text kind is `extractText` (real code in `Decision.ts`).

### 3.6 The intent agent (piece C, `packages/core/src/IntentAgent.ts` + `packages/agent-intent`)

`makeIntentAgent({ decider: () => DecisionProvider | undefined, thresholds, parse, onNoMatch, speakBeforeDone,
pendingMs, timeoutMs })` returns an `AgentImplementation` with `speculate: true`:

1. `pending` = its own stored pending intent if younger than `pendingMs` (else dropped).
2. `plan = buildDecisionPlan({ utterance: input.text, actions: input.actions, pending, parse })`. No actions and no pending →
   `Handoff("no actions")` at once (no request).
3. Decider: the configured one from `input.deciders` (`jev-typesafe` by default); if it is not running, `keywords`, with
   the status line "TypeSafe key not set: using offline keyword matching". `mark("decisionSent")`, `decide` with
   `timeoutMs` (default 1200 ms; no retries), `mark("decisionReceived")`. Error or timeout → `Decision { outcome: "error" }`
   + `Handoff`.
4. `interpretDecision` → outcome → as in the table above. Speech goes out as `TextDelta`s (one sentence each, so the chunker
   flushes them at once). The pending intent is stored only when the turn is committed (await `promoted` before storing).
5. Settings (the `jev` agent's form): `decider` (choice: TypeSafe Jev / Offline keywords), `fitsAccept`, `fitsReject`,
   `actionThreshold`, `paramThreshold`, `compoundThreshold` (advanced, 0–1 step 0.05), `onNoMatch`, `speakBeforeDone`,
   `timeoutMs`, `pendingSeconds`, test.

### 3.7 Decision providers

```ts
interface DecisionProvider {
  readonly id: string; readonly name: string; readonly location: "local" | "hosted"
  decide(request: DecisionRequest): Effect<DecisionResponse, DecisionError>   // DecisionError.reason: timeout | unavailable | rejected | invalid
}
```

- **TypeSafe Jev** (`packages/decide-typesafe`, piece I): plain `fetch` to `POST {baseUrl}/v1/systemone` (the SDK's 10 s
  timeout and two retries are wrong for voice; plain fetch keeps the dependency out), body `{ model, state, questions }`
  with `options` mapped to `criteria` and `role` removed, `Authorization: Bearer`, `AbortSignal` from the fiber, response
  validated with a `Schema` (`answers[name]` as `{ type: "choice", choice, probabilities }` or `{ type: "noul", noul }` →
  `value`). 401 → `ModuleStartError` at start (start sends one tiny request to check the key and measure the round trip),
  `unavailable` during a turn; 429/529/5xx → `unavailable`; 400/422 → `rejected` (logged with the body). Settings: `apiKey`
  (secret, env `TYPESAFE_API_KEY`, required), `model` (text, default `jev-1.14.0`, pinned: thresholds are
  version-specific), `baseUrl` (default `https://api.typesafe.ai`; any server speaking `/v1/systemone`, e.g. Ollama ≥ 0.35
  with the open Nimble model, works unchanged, English only and untested), `timeoutMs`, test. Status line: "Last decision
  241 ms". **Privacy:** only utterances routed to Jev leave the machine (TypeSafe documents no retention period); the card
  says so.
- **Offline keywords** (`packages/agent-intent/src/keywords.ts`, piece C): deterministic, local, no settings. Uses the
  question roles. `action`: score each action by the stemmed content words of the utterance found in its label,
  description and examples (stop words removed, English + Dutch list), probabilities = scores normalised; `fits` = 0.85 if
  the best action matched at least two content words or one example closely, 0.5 if one word, else 0.1; `compound` = 0.8 if
  the utterance contains "and/en/then" between two separately matching parts, else 0.05; `param` choices: an option whose
  label or alias appears in the utterance (phonetic match allowed) gets 0.9, else uniform; `stated`: 0.9 if some option
  appeared, else 0.1; `answers`: 0.9 if an option appears or the reply is short (≤ 4 words), else 0.2; `yes`: yes / ja /
  sure / doe maar / please → 0.95, no / nee / cancel → 0.05, else 0.5; `flag`: 0.5. Good enough to try the path and to
  test it; not a classifier.
- **Later, same interface**: a small local classifier (embeddings + nearest example), or a local language model with
  structured output. Each is one decider module.

### 3.8 The lights example, end to end

Where the rooms come from: the `demo-home` module's `rooms` setting (a `records` list: name + aliases, default Living room,
Kitchen, Bedroom, Office) and its lights; with Home Assistant, HA's areas and light entities (§3.9). Both expose
`target` options: one value per room (`area:<id>`), one per light (`light.<id>` / `light:<id>`), and `all`.

| ms after speech ends (*estimates* from §1.11) | What happens |
|---|---|
| 0 | Owner stops saying "Hey Jeff, turn on the lights in the living room." |
| 372 | `EagerEndOfTurn("Hey Jeff, turn on the lights in the living room.")` → speculative turn; router: phrase "hey jeff" (alias; also phonetic) → `jev`, text "Turn on the lights in the living room.", reason `trigger` |
| 372 | `jev.turn`: plan with `action` (all enabled actions), `fits`, `compound`, `demo-home.lights_on/target`, `…lights_off/target`, `…set_brightness/target`, `clock.time_now/zone(?)`; `decisionSent` |
| ≈ 620 | Jev answers: action `demo-home.lights_on` 0.96, fits 0.98, compound 0.03, target `area:living_room` 0.93 → ACT; `Decision` event (held by the publisher until promotion); `announce` → "Living room lights on." → chunker → Piper (≈ 30 ms) → buffered |
| 641 | `EndOfTurn` (same text) → promoted: `turn.start { agent: Jev, routedBy: trigger }`, `intent.decision`, playback starts (≈ 15 ms) |
| ≈ 656 | Owner hears "Living room lights on."; meanwhile `ActionStarted` → `home.switch("area:living_room", true)` (demo: in memory; HA: `POST /api/services/light/turn_on {"area_id":"living_room"}`, ≈ 50–150 ms) → `ActionFinished` |
| end | History: user "Turn on the lights in the living room." / assistant (`agentId: jev`) "Living room lights on." Trace: `agent=jev(trigger) decisionSent=-269 decisionReceived=-21 playbackStart=15 actionStarted=1 actionFinished=…` |

Without a room ("Hey Jev, lights on"): target probabilities flat → ASK "Which room or light?" → `ExpectReply` → "The kitchen"
(armed, no trigger needed) → `pending/answers` 0.95, `pending/answer` `area:kitchen` 0.95 → ACT. The same request typed to
Claude: Claude calls the generated tool `demo-home_lights_on { target: "living room" }`, resolved to `area:living_room`.

### 3.9 Modules (pieces D and K)

**`demo-home`** (`packages/modules-builtin/src/demoHome.ts`, no external dependency, enabled by default: it is how the path
is tried): an in-memory house. Settings: `rooms` (`records`: `name` text, `aliases` textList; defaults above), `lights`
(`records`: `name`, `room` text, `aliases`). Status line "4 rooms · 2 lights on". Actions: `lights_on`, `lights_off`
(`target`, dynamic), `set_brightness` (`target`, `level`: number 0–100, unit "percent"), `lights_status` (speculative,
no params: "The kitchen and the desk lamp are on."), `all_off` (`confirm: true`). Tool: `demo_home_state` (speculative).
State resets when the module restarts.

**`home-assistant`** (`packages/module-home-assistant`, piece K; the previous design's sketch, extended):

- Settings: `baseUrl` (env `HOME_ASSISTANT_URL`), `token` (secret, env `HOME_ASSISTANT_TOKEN`, required), `domains`
  (multichoice; this stage acts on `light` only), `timeoutMs` (2000).
- Start: `GET /api/config` (401 → "Home Assistant rejected the token …"), then the entity cache: one
  `POST /api/template` rendering a JSON list of areas with their light entities and friendly names
  (`{% for a in areas() %}…area_name(a)…area_entities(a)|select('match','light\\.')…{% endfor %}`, plus lights without an
  area), refreshed every 60 s and on a failed lookup. **[verify]** the template on the owner's HA version.
- Actions as in `demo-home` (`lights_on`, `lights_off`, `set_brightness`, `lights_status`), `target` options built from the
  cache (areas → `area:<area_id>`, lights → `light.<id>`, plus `all`), aliases from HA's area aliases where the template
  exposes them **[verify]**. `run` calls `light/turn_on` / `turn_off` with `area_id`, `entity_id` or `entity_id: "all"`;
  brightness via `brightness_pct`. Tool `home_state` (speculative) as sketched before.

**`clock`** gains `time_now` (speculative): optional `zone` (choice over the module's new `places` setting, a `records` list
of `{ name, zone }` with defaults Amsterdam → Europe/Amsterdam, London, New York, Tokyo); `run` says "It's 14:32." (or "In
Tokyo it's 22:32."). Tool generated (`clock_time_now`); the existing `current_time` tool stays.

**`weather`** gains `today` (speculative, `offerAsTool: false` because the `weather` tool exists): optional `place`
(`text`, after "in", "for", "at", "voor", max 4 words); `run` reuses the lookup and says "Amsterdam: light rain, 12
degrees; 9 to 14 today."

---

## 4. Settings

### 4.1 Audit

Every environment variable the app and its adapters read (grep of `Config.*`, `env:` and `process.env` on 2026-11-13), and
the fixed constants worth a decision. *Apply*: **live** = next turn or next form use; **module** = the module/agent restarts
(10 s grace for a turn in flight; no engine reload); **reload** = engine reload (≈ 2 s, interrupts a reply); **restart** =
process restart. Speech-recognition rows are the speech implementer's; the verdicts there are proposals.

| Setting | In the UI today | Should be | Where | Apply |
|---|---|---|---|---|
| `LLM_PROVIDER` | yes (Language model) | replaced by `DEFAULT_AGENT`; kept as a legacy alias and for `bench` | Agents → Routing | live |
| `DEFAULT_AGENT` (new) | — | yes | Agents → Routing | live |
| `ROUTING_RULES`, `ROUTING_GREETINGS`, `ROUTING_REQUIRE_GREETING`, `ROUTING_STICKY_IDLE_S`, `ROUTING_ARMED_S`, `ROUTING_ACKNOWLEDGEMENT`, `ROUTING_FALLBACK_AGENT` (new) | — | yes | Agents → Routing | live |
| `SYSTEM_PROMPT` | yes | yes | Agents → All agents | live |
| `MAX_TOOL_ROUNDS` | yes (reload) | yes, now live | Agents → All agents | live |
| `BARGE_IN` | no | no: serve always barges in and the per-device interrupt mode decides; CLI only | — | — |
| `ANTHROPIC_API_KEY` | yes (Language model) | yes | Agents → Claude (API) | module |
| `ANTHROPIC_MODEL` | yes (text) | yes, as a model picker | Agents → Claude (API) | module |
| `ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_EFFORT`, `ANTHROPIC_THINKING`, `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_WARM_UP`, `ANTHROPIC_BASE_URL` | no | yes, advanced | Agents → Claude (API) | module |
| `OPENROUTER_*`, `HOME_MODEL_*` (new: `BASE_URL`, `API_KEY`, `MODEL`, `SERVER`, `MAX_TOKENS`, `TIMEOUT_MS`) | — | yes | Agents → OpenRouter / Home model server | module |
| `CLAUDE_SUBSCRIPTION_OPT_IN`, `CLAUDE_SUBSCRIPTION_MODEL`, `CODEX_SUBSCRIPTION_OPT_IN`, `CODEX_SUBSCRIPTION_MODEL` (new) | — | yes | Agents → Claude / Codex subscription | module |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `TYPESAFE_BASE_URL` (new) | — | yes | Agents → Decision providers → TypeSafe Jev | module |
| Jev thresholds, decider, `onNoMatch`, `speakBeforeDone`, timeouts (new) | — | yes (advanced for thresholds) | Agents → Jev | module |
| `BENCH_LLM_FIRST_TOKEN_MS`, `BENCH_LLM_TOKENS_PER_S` | no (env only) | yes, as the offline agent's "simulated speed" | Agents → Offline stand-in | module |
| other `BENCH_*`, `MOCK_*` | no | no (benchmark and mock tools) | — | — |
| `STT_PROVIDER` | yes (Speech engines) | yes | Speech | reload |
| `STT_SHERPA_MODEL`, `_EAGER_SILENCE_MS`, `_FINAL_SILENCE_MS`, `_VAD_THRESHOLD`, `_MIN_SPEECH_MS` | yes (Listening) | yes (speech implementer) | Speech → Listening | reload |
| `STT_SHERPA_LANGUAGE` | no | yes (owner asked for "language"; speech implementer) | Speech → Listening | reload |
| `STT_SHERPA_THREADS` | no | yes, advanced | Speech → Listening | reload |
| `STT_SHERPA_MODEL_DIR`, `TTS_SHERPA_MODEL_DIR` | no | no (paths on the server) | — | — |
| `DEEPGRAM_EOT_THRESHOLD`, `DEEPGRAM_EAGER_EOT_THRESHOLD` | yes (Listening, when Deepgram) | yes | Speech → Listening | reload |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` | no | yes (so Deepgram can be set up from the UI) | Speech → Hosted speech | reload |
| `DEEPGRAM_EOT_TIMEOUT_MS` | no | yes, advanced | Speech → Listening | reload |
| `DEEPGRAM_URL`, `CARTESIA_URL` | no | no (endpoints) | — | — |
| `TTS_PROVIDER` | yes (Speech engines) | yes, as the standard voice's provider (`VOICE_STANDARD_PROVIDER`; `TTS_PROVIDER` stays the fallback) | Voices → standard | reload |
| `VOICES` | yes | yes | Voices | reload |
| `DEFAULT_VOICE` | yes | yes | Voices | live (reload if not enabled) |
| `VOICE_<NAME>_PROVIDER` | no | yes | Voices → each voice | reload |
| `VOICE_<NAME>_TTS_SHERPA_PRESET`, `_SPEED`, `_TRIM_SILENCE`, `_CLAUSE_PAUSE_MS`, `_SENTENCE_PAUSE_MS` | no | yes | Voices → each local voice | reload |
| `VOICE_<NAME>_TTS_SHERPA_PAD_MS`, `_CHUNK_MS`, `_THREADS` | no | yes, advanced | Voices → each local voice | reload |
| `VOICE_<NAME>_CARTESIA_VOICE`, `_CARTESIA_MODEL`, `_CARTESIA_LANGUAGE` | no | yes | Voices → each Cartesia voice | reload |
| `VOICE_<NAME>_CARTESIA_MAX_BUFFER_DELAY_MS` | no | yes, advanced | Voices → each Cartesia voice | reload |
| `CARTESIA_SAMPLE_RATE` | no | no (the router plays at the default voice's rate and resamples; nothing to gain) | — | — |
| `CARTESIA_API_KEY` | no | yes | Voices → Hosted voice services | reload |
| `CLOCK_TIME_ZONE`, clock `locale`, clock `places` (new) | yes / yes / — | yes | Modules → Clock | module |
| `WEATHER_DEFAULT_PLACE`, `WEATHER_UNITS`, weather `timeoutMs` | yes | yes | Modules → Weather | module |
| `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, HA `domains`, `timeoutMs` (new) | — | yes | Modules → Home Assistant | module |
| demo-home `rooms`, `lights` (new) | — | yes | Modules → Demo home | module |
| `AUDIO_BACKEND`, `AUDIO_INPUT_FILE`, `AUDIO_INPUT_TRAILING_SILENCE_MS`, `AUDIO_OUTPUT_DIR`, `PIPEWIRE_*` | no | no (CLI modes only; serve uses the browser) | — | — |
| `SERVE_HOST`, `SERVE_PORT`, `SERVE_ALLOWED_ORIGINS`, `SERVE_TLS_CERT`, `SERVE_TLS_KEY` | no | no: process-level, and letting the page change its own exposure is a security risk | — | restart |
| `PVA_WEB_DIR`, `PVA_DATA_DIR`, `NEXT_PUBLIC_PVA_WS_URL`, `INIT_CWD`, `NODE_ENV` | no | no | — | — |
| Constants: module start limit 10 s, grace 10 s, context provider 50 ms, playback stall 2 s, echo-gate thresholds, Publisher limits | no | no: correctness limits with tests, not preferences | — | — |
| Per device (browser `localStorage`): interrupt mode, microphone (+ the speech implementer's per-device options), speaker, output path, prebuffer, captions, latency readout | yes | yes; add "Composer agent" (Auto or an agent) and "Show Jev's decisions in the chat" (default on) | This device / composer | live |

`.env.example` (piece H, after the speech implementer): new blocks for agents, routing, TypeSafe, Home Assistant, all
commented out (a value set there locks the UI field).

### 4.2 Screen structure

Tabs are data (`src/ui/registry.ts`). Which cards go where is decided from server data only: `ModuleInfo.kind` and
`SettingsSection.group` (both closed sets in the protocol); the UI never names an agent or module.

| Tab | Content, in order |
|---|---|
| **Agents** | (1) *Who answers*: the active agent from `routing` ("Claude subscription · sticky · 1:43 left" + **Back to default**), (2) sections of group `agents` in server order: **Routing** (default agent, fallback agent, rules, greetings, timings, acknowledgement) and **All agents** (system prompt, tool rounds), (3) cards of `kind: "agent"` modules in catalog order: switch, name, kind chip (`API` model / `SUBSCRIPTION` harness / `COMMANDS` intent / `LOCAL` when the agent says so in its status), `DEFAULT` / `ACTIVE` badges, status line; expanded: error, form (model picker, keys, own system prompt, speculation, Test with its result), (4) heading *Decision providers* and the `kind: "decider"` cards |
| **Modules** | cards of `kind: "capability"` (or absent) modules, as today, plus an **Actions** list in the expanded card: label, parameters (`Room or light: Living room, Kitchen, …`), chips `READ-ONLY` (speculative), `ASKS FIRST` (confirm), `ALSO A TOOL` with the tool name |
| **Speech** | sections of group `speech` in server order (Listening, Speech engines, Hosted speech: the speech implementer's fields; proposal: recognition model and language first, then turn timing, thresholds under Advanced) |
| **Voices** | the engines list (`EngineStatus.voices`, read-only), the **Voices** section (default voice, enabled voices), then one card per `voice-<name>` section with its fields and **Play a sample**, then **Hosted voice services** (Cartesia key) |
| **This device** | as today, plus the speech implementer's microphone options and "Show Jev's decisions in the chat" |
| **About** | as today |
| *General* | sections with group `general` or none; the tab is shown only when such a section exists |

Engine-reload fields keep the existing note and "Saved changes need an engine reload" bar (Speech and Voices tabs).

### 4.3 New field types (protocol `agents.ts`, core `SettingsExtra.ts`)

| Type | Value | Server (core) | Renderer (web) |
|---|---|---|---|
| `textList` | `string[]` | trimmed, empty and duplicate (case-insensitive) items dropped, `maxItems`, `itemMaxLength`; env: comma-separated | chips with × and an input that adds on Enter or comma; counter near `maxItems` |
| `records` | `RecordValue[]` | each item decoded with its `itemFields` (v1 non-secret types + `textList`), missing keys = defaults, unknown keys dropped, errors name the item ("Rule 2, Agent: …"), optional whole-list `check`; env: JSON | one row per item titled by `titleKey` (choice label) + a summary of the other values; expands into a small form using the same renderers; **Add <itemLabel>**, remove, move up/down when `orderable`; the whole list is the patch value |
| `combo` | `string` | non-empty, `maxLength`; must be a static option unless `allowCustom`; the form's `options` = static options + the running instance's `settingOptions()[key]` (deduplicated), `optionsNote` set by the host ("From the server's model list" / "Agent not running: type a name") | text input with a filtering dropdown of options (label, value in mono); free text allowed when `allowCustom` |
| `action` | none | never in `values`; never patchable; handler = instance `fieldActions[key]` (module) or the server's (section) | button `buttonLabel`; optional confirm dialog; disabled with "Save first" while dirty if `requiresSaved`; spinner, then `result.detail` text (tone colour) under it until the form closes |
| `info` | `string` | value from the instance's `info()[key]`, "" when not running; patching it is an error ("Read-only") | read-only text with a tone dot |

Rules kept: one renderer per type (`fieldRenderers: Record<SettingFieldTypeV2, …>`, so a missing renderer is a compile
error), the UI renders only what the server describes, secrets keep the previous handling (write-only, `SecretState`,
`secrets.json` 0600, environment wins and locks). Patches never contain `action` or `info` keys; `records` and `textList`
are compared deeply for dirtiness. Core changes at integration (piece G): `Setting<A>.type`/`describe` widen to v2,
`SettingExtra` joins `Setting`, `resolveSettings` skips `action` fields and leaves `info` to the host,
`applySettingsPatch` rejects both.

### 4.4 Sections and forms

**`routing`** (group `agents`, title "Routing", all live; new file `apps/assistant/src/serve/routingSection.ts`, piece H):
`DEFAULT_AGENT` (choice over catalog agents; default `anthropic` when `ANTHROPIC_API_KEY` is set, else `offline`; legacy
`LLM_PROVIDER` honoured when unset), `ROUTING_FALLBACK_AGENT` (choice: none or a conversational agent), `ROUTING_RULES`
(`records`: `agent` choice over catalog agents + "The default agent" (`@default`), `phrases` textList ≤ 10, `mode` choice
"That sentence" / "Following sentences too"; `orderable`; check: at least one phrase per rule), `ROUTING_GREETINGS`
(textList), `ROUTING_REQUIRE_GREETING` (boolean, advanced), `ROUTING_STICKY_IDLE_S` (number 10–3600 s, default 120),
`ROUTING_ARMED_S` (number 3–60 s, default 10, advanced), `ROUTING_ACKNOWLEDGEMENT` (text, default "Yes?").

**`conversation`** (group `agents`, title "All agents"): `SYSTEM_PROMPT`, `MAX_TOOL_ROUNDS` (now live).

**Agent forms** (module settings, §1.7–1.8, §3.6, §3.7). Every agent's form ends with the host-added `test` action and an
`info` "Last test" value.

**`voices`** (group `voices`): `DEFAULT_VOICE`, `VOICES` (as today).

**`voice-<name>`** (group `voices`, one per declared voice; new file `apps/assistant/src/serve/voiceSections.ts`, piece H).
Keys are the existing prefixed variables, so the providers read them through the existing `VOICE_<NAME>_` wrapper and the
section overlay with no adapter change; `env` on each field is the same name (an environment value locks it):

| Field (for voice `natural`) | Type | Shown when |
|---|---|---|
| `VOICE_NATURAL_PROVIDER` | choice (sherpa = on this machine, cartesia = hosted) | always |
| `VOICE_NATURAL_TTS_SHERPA_PRESET` | choice over the tts-sherpa presets | local |
| `VOICE_NATURAL_TTS_SHERPA_SPEED` | number 0.5–2.0, step 0.05 | local |
| `VOICE_NATURAL_TTS_SHERPA_TRIM_SILENCE` | boolean | local |
| `VOICE_NATURAL_TTS_SHERPA_CLAUSE_PAUSE_MS` / `_SENTENCE_PAUSE_MS` | number 0–1000 / 0–1500 ms | local |
| `VOICE_NATURAL_TTS_SHERPA_PAD_MS`, `_CHUNK_MS`, `_THREADS` | number, advanced | local |
| `VOICE_NATURAL_CARTESIA_VOICE`, `_CARTESIA_MODEL` (combo), `_CARTESIA_LANGUAGE` | text / combo / text | hosted |
| `VOICE_NATURAL_CARTESIA_MAX_BUFFER_DELAY_MS` | number, advanced | hosted |
| `PLAY_SAMPLE` | action "Play a sample" (`requiresSaved`) | always |

The fields shown depend on the saved provider (as `listening` depends on `STT_PROVIDER` today); changing the provider
announces the section again. All value fields are `reload` (the engines read them at start; making speed and pauses live
needs a tts-sherpa change, left out). **Play a sample** sends `Say { text: "[voice:<name>] This is the <name> voice. The
quick brown fox jumps over the lazy dog.", voice }` to the conversation: it is heard on the owner's device with the
running engines, so after changing a value the owner saves, reloads (the bar offers it), then plays. When the voice is not
enabled in the running engines the result says "Enable this voice and reload the engines first."

**`voice-services`** (group `voices`, "Hosted voice services"): `CARTESIA_API_KEY` (secret, reload).

**Speech** (group `speech`): the existing `listening` and `speech` sections, owned by the speech implementer, gain
`group: "speech"`; proposed additions for them: `STT_SHERPA_LANGUAGE`, `STT_SHERPA_THREADS` (advanced),
`DEEPGRAM_EOT_TIMEOUT_MS` (advanced), and a `speech-services` section with `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`. The
`language-model` section is removed (replaced by the Agents tab), which is one deletion in their file.

### 4.5 Secrets

Unchanged handling, applied to the new keys: OpenRouter, home server, TypeSafe, Home Assistant, Cartesia, Deepgram keys are
`secret` fields (write-only from the browser, `secrets.json` at 0600, environment wins). Subscription agents hold no
secrets at all: the CLIs keep their own logins.

---

## 5. Protocol and UI changes

### 5.1 Protocol additions (all defined in `packages/protocol/src/agents.ts`, examples in `agentExamples.ts`)

| Addition | Kind | Purpose |
|---|---|---|
| `TextListField`, `RecordsField` (+ `RecordItemField`), `ComboField`, `ActionField`, `InfoField`; `SettingFieldV2` | new field types (closed set) | §4.3 |
| `SettingValueV2` (adds `RecordValue[]`), `SettingsFormV2`, `SettingsPatchV2` | wider value union | records |
| `module.action { requestId, moduleId, key }`, `settings.action { requestId, sectionId, key }` | client → server | action buttons; answered with `result` + `detail` |
| `routing.set { requestId, agentId \| null }` | client → server | make an agent sticky / back to default |
| `routing { routing: RoutingInfo }` | server → all | active agent, reason, expiry; also `snapshot.routing` |
| `intent.decision { turnId, agentId, decider, outcome, action?, params, probability?, ms, reason? }` | server → all | Jev's decision in the chat |
| `turn.agent { turnId, agent, from, reason }` | server → all | hand-off / failure fallback mid-turn |
| `TextSend.agentId?` | optional field | composer choice |
| `TurnStart.agent?`, `routedBy?`, `fallbackFrom?`, `agentText?` | optional fields | who answers and why |
| `ToolStart.kind?` (`tool` / `action`), `label?` | optional fields | actions shown like tools |
| `ModuleInfo.kind?`, `agentKind?`, `actions?` (`ActionInfo[]`) | optional fields | tabs and action lists |
| `SettingsSection.group?` | optional field | tabs |
| `HistoryItem.agentId?` (assistant) | optional field | who answered, after a reload |
| `Result.detail?` | optional field | action results |
| `TraceInfo.agent?`, marks `decisionSent?`, `decisionReceived?`, `actionStarted?`, `actionFinished?` | optional fields | latency readout per agent |
| `ErrorCodeV2` adds `unknown_action`, `action_failed`, `agent_unavailable` | closed set | new failures |

**Versioning.** New field types and error codes are new members of closed literal sets, so this is protocol **2**. The
optional fields and new messages alone would not need a bump, but they ship together. The UI is served by the assistant,
so the bump means a stale tab sees "This page is older than the assistant · Reload". The merge is one change (piece G):
spread the field records into the existing structs (`TurnStart.mapFields((f) => ({ ...f, ...TurnStartAgentFields }))`, as
`test/agents.test.ts` does), add the messages to the unions, swap `SettingField`/`SettingValue`/`ErrorCode` for the V2
versions, move `agentExamples` into `examples.ts` (the "every message has an example" test then covers them), set
`PROTOCOL_VERSION = 2`, and update the web mock server.

### 5.2 Server mapping (piece F, `Publisher.ts` / `SessionHub.ts`)

| Conversation / host event | Message |
|---|---|
| `TurnStarted` (+ agent fields) | `turn.start` with `agent`, `routedBy`, `fallbackFrom`, `agentText` (buffered while speculative, as today) |
| `TurnAgentChanged` | `turn.agent` |
| `IntentDecided` | `intent.decision` |
| `ActionStarted` / `ActionFinished` | `tool.start { kind: "action", label, tool: <tool name>, moduleId }` / `tool.end` |
| `RoutingChanged`, `routing.set` handled | `routing` (to all) |
| `TurnStarted { canned: true }` | `turn.start` + `assistant.text` as usual (the chat shows "Yes?" like any reply); not in history |
| `module.action` | host → instance `fieldActions[key]` (or the generated `test`); `result { ok, detail }`; then `module.changed` if `info` changed |
| `settings.action` | section handler (`PLAY_SAMPLE` → `engine.send(Say)`); `result { ok, detail }` |
| `text.send { agentId }` | `TextInput { agentId }`; unknown or stopped agent → `result agent_unavailable` |

History projection: assistant items get `agentId`; the user item shows the stored (trigger-free) text.

### 5.3 UI (piece G, `apps/web`)

- **State** (`state.ts`): `TurnView` gains `agent?: AgentRef`, `routedBy?`, `fallbackFrom?`, `decision?: IntentDecision`,
  and tools with `kind`/`label`; `ClientState` gains `routing?: RoutingInfo`. The reducer handles `routing`,
  `intent.decision`, `turn.agent` (replace the turn's `agent`, keep `fallbackFrom`).
- **Chat**: the speaker label of a reply is the agent's name (`JEV`, `CLAUDE (API)`), in the same mono label style; a muted
  line above a fallback reply: "Codex isn't available · answered by Claude (API)" / "Jev passed this on · no matching
  action". An intent turn shows a decision chip: `Turn lights on · Room or light: Living room · 93 % · 241 ms`, the action
  as a tool chip with its label and ok/error state; `ask` shows the question as the reply; low probabilities (< 0.7) in
  `warn`. Per-device toggle hides the chips.
- **Stage**: the label shows the agent while thinking/speaking (`THINKING · JEV`, `SPEAKING · CLAUDE (API) · natural`).
  When the active agent is not the default, a chip under the top bar: "Claude subscription · 1:43" with × (`routing.set
  null`), counting down from `expiresInMs`.
- **Composer**: agent chip at the left: "Auto" (shows the active agent's name in muted text) or a chosen agent; menu of
  running agents + Auto; sends `text.send.agentId`.
- **Latency popover**: columns `agent` and `decision` (`decisionReceived − decisionSent`).
- **Options**: the tabs of §4.2; renderers for the five field types; `ModuleCard` gains the kind chip, badges, the Actions
  list and action-field results; a `VoicesTab` and `AgentsTab` composed from the existing `SettingsForm` and `ModuleCard`.
- **Mock server and tests**: scenarios `agents` (routing chip, a Jev turn with decision and action, a hand-off, a fallback
  notice) and `settings-v2` (every new field type, an action with a result). Playwright: the Agents tab, a routed typed
  message, records editing.

---

## 6. Build plan

Each piece is testable on its own without API keys, subscriptions or a home-automation system, keeps `pnpm check` and
`pnpm test` green, and owns the files listed (nobody else edits them while it runs). Pieces F, G and H touch `apps/assistant`
and `apps/web`, which the speech-recognition implementer is editing now: **they start when that work has landed**. All
others can start at once against the interfaces already in `core` and `protocol`.

| # | Piece | Owns | Depends on | Tested with (no keys) | Needs from the owner to verify for real |
|---|---|---|---|---|---|
| **A** | Agent core and routing integration: `ModelAgent.ts`; `Conversation` refactor (`makeAgentConversation`, routing at turn start, router state on commit, canned turns, availability notice, hand-off and failure fallback, `Say`, `SetActiveAgent`, new events); `ModuleDefinition`/`ModuleHost` (kind, contributions, snapshot `agents`/`actions`/`deciders`, generated action tools via `actionTool`, clash check, generated agent `test`); `TurnTrace` (agent, marks, `formatTrace`); `Domain` (`Message.agentId`); `testing.ts` (`makeScriptedAgent`) | `packages/core/src/{Conversation,ConversationEvents,ModelAgent,ModuleDefinition,ModuleHost,TurnTrace,Domain,Actions,testing}.ts` and their tests | — | the 100 existing core tests unchanged; new: routing per reason, trigger-only ack, arming via `ExpectReply`, sticky across turns, discarded speculative turn leaves state, harness `speculate: false` waits for promotion, hand-off, failure before/after text, unavailable notice, rounds from tool events, actions not in history, `MAX_TOOL_ROUNDS` live | nothing |
| **C** | Intent path: `IntentAgent.ts`, `ValueParsing.ts` (core); `packages/agent-intent` (`jev` agent definition, `keywords` decider) | those files | A's `Agent` (exists) | `makeScriptedDecider`; table tests for EN/NL numbers and durations; intent agent turns driven directly (act, ask → answer, confirm, cancel, no match → `Handoff`, decider timeout → `Handoff`, `announce` before `promoted`, read-only action before promotion) | TypeSafe key (via I) |
| **D** | Modules: `demo-home` (constant default house first; `records` settings after G), `clock.time_now`, `weather.today` | `packages/modules-builtin/src/*` | `ModuleContributions` (exists) | module tests as today (start in a scope, call actions, `weatherModule({ fetch })`) | nothing |
| **E** | OpenAI-compatible: `packages/llm-openai-compatible` (`Llm` adapter, profiles, model list) + `openrouter` / `home-model` agent definitions | that package | A's `makeModelAgent` for the agent files only | a local scripted SSE server (text deltas, tool-call fragments by index, `:` comments, reasoning deltas, mid-stream error chunk, abort) | OpenRouter key; or the home server's address and a loaded model |
| **F** | App wiring: `apps/assistant/src/agents.ts` (catalog), `agents/offline.ts`, `packages/llm-anthropic/src/agent.ts`; serve: engine without an LLM stage, setup with agents and router, Publisher/SessionHub mappings (§5.2), CLI modes on agents; ARCHITECTURE.md and README | `apps/assistant/src/{agents.ts,agents/,main.ts,text.ts,voice.ts,serve/Engine.ts,serve/serveMode.ts,serve/Publisher.ts,serve/SessionHub.ts}`, `packages/llm-anthropic/src/agent.ts`, docs | A; speech implementer done; G's protocol merge for the new messages (F can land core wiring first and the messages with G) | serve tests with the scripted client, scripted agents and `FakeLlm`: a Jev turn end to end with `demo-home` and the keyword decider, a hand-off, `routing.set`, `module.action` test | Anthropic API key (never tested yet) |
| **G** | Protocol v2 and web: merge `agents.ts` into the unions, `PROTOCOL_VERSION = 2`; core `Settings.ts` widening + `SettingExtra` in `Setting` + host form additions (combo options, info, kind, actions); web state, renderers, tabs, chat/stage/composer changes, mock server, e2e | `packages/protocol/src/*`, `packages/core/src/Settings.ts`, `apps/web/**` | speech implementer done; A (host) | reducer tests from examples; renderer tests per field type; Playwright against the mock | nothing |
| **H** | Settings sections: `routingSection.ts`, `voiceSections.ts`, `group` on all sections, speech-section proposals agreed with the speech implementer, `language-model` removed, `.env.example`; `demo-home`/clock to `records` | `apps/assistant/src/serve/{sections,routingSection,voiceSections}.ts`, `.env.example`, `packages/modules-builtin` settings | G | section tests (resolve, patch, env lock, provider-dependent voice fields), Play a sample through the scripted client | nothing |
| **I** | Jev decider: `packages/decide-typesafe` | that package | `defineDecider` (exists) | a local fake `/v1/systemone` server (answers, 401, 429, 422, slow → timeout) | **TypeSafe API key**: real latency from this machine, threshold tuning on ~30 owner utterances, Dutch |
| **J** | Claude subscription: `packages/agent-claude-code` | that package | `Agent` (exists); A for the integrated test | an injected fake `query()` (deltas, tool calls through the MCP handler, interrupt result, crash) | the **opt-in decision** (Claude is already logged in on this machine): warm/cold numbers through `TurnTrace`, resume after interrupt, `alwaysLoad` |
| **K** | Home Assistant: `packages/module-home-assistant` | that package | actions interface (exists) | a fake HA HTTP server (`/api/config`, `/api/template`, services, 401) | **Home Assistant address and long-lived token**: template on the real version, area aliases, action latency |
| **L** | Codex subscription: `packages/agent-codex` | that package | `Agent`; A | a scripted app-server transport | **`codex login`** on this machine, then the §1.8 verify list |

Order by value (what to finish first when people are scarce): **A → C + D → E → F → G + H → I → J → K → L**. After A, C, D
and F, the owner can say "hey Jev, turn on the living room lights" in the browser (offline keyword decider, demo home) and
see the decision in the chat once G lands.

**What the owner supplies, and what each unlocks**

| Supply | Unlocks |
|---|---|
| A TypeSafe API key (console.typesafe.ai/keys) and agreement that "hey Jev" sentences are sent to TypeSafe | Real Jev decisions, measured latency, threshold tuning, a Dutch check |
| An Anthropic API key | The supported default conversational agent, measured for the first time |
| An OpenRouter key, and/or the home model server's address, server type and a loaded model | `openrouter` / `home-model` agents with measured TTFT |
| The decision to opt in to using the Claude subscription (terms unclear) | `claude-subscription`, measured |
| `codex login` (Sign in with ChatGPT, device code on a headless machine) and the same opt-in | `codex-subscription` can be finished and measured |
| Home Assistant address and a long-lived access token (or the name of the system actually used) | Real lights and rooms |

---

## 7. Deliberately left out

- Creating agents from the UI (several instances of one kind at run time). Each instance is one catalog line.
- Several actions in one sentence ("lights on and blinds down"): detected and passed to the conversational agent.
- Timers, reminders and anything a module would have to say on its own later (modules still cannot speak by themselves).
- Confirmation before side-effecting *tools* of conversational agents (actions have `confirm`).
- Running the conversational agent in parallel with Jev "just in case" (wastes tokens on every command).
- Committing an intent turn before the final silence when the decision is confident (the obvious next latency step for
  commands; needs data from real use).
- Live voice speed and pauses (needs a tts-sherpa change), per-agent voices, editing voice descriptions.
- Clearing or persisting the conversation; agent-to-agent delegation; external MCP servers for harness agents; Codex tools
  until registration is verified.
- A local decision model (Nimble through Ollama works through the Jev provider's base URL, untested and English only).
- A wake word: trigger phrases work only while a tab owns the audio.

## 8. Open questions for the owner (with the default used)

1. **Which agent answers by default?** *Default: Claude (API) once `ANTHROPIC_API_KEY` is set; the offline stand-in until then.*
2. **Trigger phrases?** *Default: "hey Jev" (+ "hey Jeff"), "hey Claude", "hey Codex", "hey router", "hey local", and "hey assistant" / "back to normal" for the default.*
3. **Should "hey Claude" keep Claude for follow-up questions?** *Default: yes, until another trigger, "hey assistant", the × in the UI, or 2 minutes without a turn. Jev is one sentence only.*
4. **Use the Claude and Codex subscriptions despite unclear terms?** *Default: off; each has an explicit opt-in switch.*
5. **Is it acceptable that sentences starting with "hey Jev" go to TypeSafe** (retention period undocumented)? *Default: yes once you add the key; nothing else is sent; without a key the offline keyword matcher is used.*
6. **Which home-automation system?** *Default: Home Assistant (module built, off until you add the address and token); the demo home works without one.*
7. **Will you give commands in Dutch?** *Default: English action descriptions with Dutch aliases and examples; checked once the key is there.*
8. **Hear "Living room lights on." before the light has actually switched?** *Default: yes (≈ 50–150 ms sooner; a failure is said afterwards).*
9. **Let Claude/Codex start before you finish speaking?** *Default: no (saves ≈ 270 ms but can leave half sentences in their session and spends quota); per-agent switch.*
10. **Should Jev ever be the default agent** (every sentence tried as a command first)? *Default: no; allowed in the settings, and it adds ≈ 250 ms to every conversational answer.*

## 9. Changes to existing interfaces

All additive unless marked. Nothing here is done yet; the pieces do it.

| Interface | Change | Why | Piece |
|---|---|---|---|
| `Conversation` | new `makeAgentConversation` / `layerWithAgents`; `layer`/`layerWithSetup` become wrappers (same signatures and behaviour); tool loop moves to `ModelAgent.ts` | agents behind one interface | A |
| `ConversationInput` | `TextInput.agentId?`; new `SetActiveAgent`, `Say` | composer choice, `routing.set`, samples and acknowledgements | A |
| `ConversationEvent` | `TurnStarted` + `agentId?`, `routedBy?`, `fallbackFrom?`, `agentText?`, `canned?`; new `TurnAgentChanged`, `IntentDecided`, `ActionStarted`, `ActionFinished`, `RoutingChanged` | UI and trace | A |
| `TurnSetup` | extended by `AgentTurnSetup` (`agents: AgentSet`) | per-turn snapshot of agents and router | A |
| `Message` (assistant) | `agentId?` | who said it (catch-up, UI) | A |
| `Trace` / `traceMarks` | `agent?`; marks `decisionSent`, `decisionReceived`, `actionStarted`, `actionFinished` | attribution | A |
| `ModuleInstance` | absorbs `ModuleContributions` (`agents`, `actions`, `deciders`, `settingOptions`, `info`, `fieldActions`) | everything pluggable is a module | A |
| `ModuleDefinition` | `kind?`, `agentKind?` | tabs | A |
| `ModuleSnapshot` | `agents`, `actions`, `deciders`; generated action tools in `registry` and `toolModules` | per-turn use | A |
| `ModuleHost.modules()` (`ModuleInfo`) | `kind`, `agentKind`, `actions`, combo options, `info` values, generated `test` field | UI | G (needs protocol v2) |
| `Setting` / `resolveSettings` / `applySettingsPatch` | **widened** to v2 field types; skip `action`, host fills `info` | new field types | G |
| `@pva/protocol` | v2 (§5.1); `SettingField`, `SettingValue`, `ErrorCode` **replaced** by the V2 unions | closed sets grow | G |
| `Llm`, `Stt`, `Tts`, `AudioInput`, `AudioOutput`, `ToolRegistry`, `Tool`, `SttEvent` | unchanged | | |
| `llm-anthropic` | unchanged; new `agent.ts` | | F |
| `apps/assistant` engine | no LLM stage in serve; agents come from the module host; `language-model` section removed | agents are modules | F, H |
