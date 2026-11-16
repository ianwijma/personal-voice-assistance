# Architecture

A personal voice assistant. Two rules decide every design question:

1. **Latency first.** The number we optimise is *end of user speech → first audible reply audio*. Target: under 800 ms.
   Speech to text and text to speech run locally by default; only the language model is hosted.
2. **Everything is swappable.** Each pipeline stage is an Effect service interface in `core`. Providers, audio backends and tools live in their own packages and are chosen in one composition file.

## Stack

- Node 22, TypeScript (strict), ESM only, pnpm workspace with a `catalog:` so every package uses the same `effect` version (duplicate copies break service identity).
- No build step: package `exports` point at `src/index.ts`, imports use `.ts` extensions, the app runs with `tsx` (Node's native type stripping is not usable: it is off by default in Node 22 and some distro builds ship without it). Code must stay erasable TypeScript (`erasableSyntaxOnly`: no enums, namespaces or parameter properties).
- `effect@^4.1.4` (v4: `Context.Service`, `Layer.effect`, `Effect.forkChild`, `Schema` from `"effect"`, `effect/socket`, `effect/process`). The bundled docs at `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/**` are the API reference — read them rather than relying on v3 memory.
- `@effect/platform-node`, `@effect/vitest` + vitest 5.
- The LLM is called through the official `@anthropic-ai/sdk` wrapped in a `Stream`, not `effect/ai` (unstable, and we want direct control over abort and stream events).

## Pipeline

```
AudioInput ──pcm 16k──▶ Stt ──SttEvent──▶ Conversation ──▶ Llm (+ tool loop) ──text deltas──▶
   clause chunker ──▶ Tts (the assistant's voice) ──pcm at the voice's rate──▶ AudioOutput
```

Default providers: `Stt` = sherpa-onnx Parakeet-TDT v2, decoded once per turn, + Silero VAD (local), `Tts` = Piper via sherpa-onnx
(local, 22050 Hz), `Llm` = Anthropic (hosted; `fake` offline stand-in when no key is configured). These are the defaults of a new
assistant and what the CLI modes use (`LLM_PROVIDER`, `STT_PROVIDER`, ...). In serve mode every assistant chooses its own
language model account (`offline`, `anthropic`, `claude-subscription`, `openrouter`, `home-model`), hearing and voice
(docs/ASSISTANTS.md), and the resource pool shares what is equal. An assistant on `claude-subscription` runs an agent
conversation (`makeAgentConversation`) whose agent is the running `claude-subscription` module (Claude Code with the owner's
login, `packages/agent-claude-code`), read per turn; the offline stand-in answers, after a spoken notice, while that module is
not running (`apps/assistant/src/subscription.ts`).

All audio is raw PCM, signed 16-bit little-endian, mono, carried as `Uint8Array` chunks of about 20 ms. Input is 16 kHz. Output rate is declared by the `Tts` service (Piper 22050 Hz, Kokoro, Cartesia and ElevenLabs 24 kHz); an engine cannot be asked for another rate, so a consumer that needs one resamples (`makeResampler`).

### Service interfaces (`packages/core`)

These are the contract. Adapters implement them; nothing outside an adapter may import a provider SDK.

```ts
// Audio
AudioInput:  { readonly stream: Stream<Uint8Array, AudioError> }
AudioOutput: {
  readonly reportsPlayback?: boolean
  play(audio: Stream<Uint8Array, E>, sampleRate: number, observer?: PlaybackObserver): Effect<void, E | AudioError>
}
// `play` returns when the audio has finished playing. Interrupting the fiber
// must silence the speaker immediately (drop everything buffered).
// An output that is not paced by pulling (the browser buffers what it receives)
// sets `reportsPlayback` and reports through the observer:
PlaybackObserver = { started(): void; progress(playedSamples: number): void; final?(playedSamples: number): void }
// `started`: the first sample reached the device; `progress`: samples handed to
// the device so far (non-decreasing; the final value before `play` returns or
// its interruption completes). `final` (optional, review round 6): the
// authoritative count when playback ended (finished, stopped or failed), at most
// once, after the last `progress` and before `play` returns or its interruption
// completes; it may be LOWER than the last progress value. When it is called,
// `Conversation` recomputes the clauses heard from it (a clause whose first sample
// lies at or beyond it was not heard; the set may shrink) before the turn's history
// is committed, ignores any later `progress`. A `ClausePlaying` already emitted for a
// clause found not heard is not recalled (no event for that exists). Review round 7:
// the count decides history WHATEVER the turn's outcome — a turn whose `play` returned
// successfully but whose final count is below the samples handed over is recorded like
// an interrupted one (only the clauses heard, `interrupted: true`); and a confirmation
// question is armed only when its turn completed with everything played (a final count,
// if given, covering all of it). A `final` count that arrives after the owner began
// speaking never makes that utterance an answer: what an utterance may answer is fixed
// at its `SpeechStarted` (docs/AGENTS-AND-INTENTS.md §3.2). Outputs that never call
// `final` behave as before.

// Speech to text, including turn detection
Stt: { transcribe(audio: Stream<Uint8Array, AudioError>): Stream<SttEvent, SttError> }
// `transcribe` may be called concurrently (docs/VOICE-SESSIONS.md, one call per voice session): each call is its
// own stream with its own turn detection; closing one leaves the others running. An adapter that holds a shared
// resource (stt-sherpa: one loaded model) fails every open call when that resource dies.
SttEvent =
  | { _tag: "SpeechStarted" }                    // user began talking (used for barge-in)
  | { _tag: "Interim"; text: string }
  | { _tag: "EagerEndOfTurn"; text: string }     // probably done — start the LLM speculatively
  | { _tag: "TurnResumed" }                      // not done after all — discard the speculative turn
  | { _tag: "EndOfTurn"; text: string }          // done — commit
// Utterance boundaries (contract, relied on by Stop): every utterance begins with `SpeechStarted`
// and ends with exactly one `EndOfTurn`; `Interim`, `EagerEndOfTurn` and `TurnResumed` in between
// belong to it (a recogniser that commits without having sent `SpeechStarted` sends it right
// before the `EndOfTurn`). When no words were recognised the `EndOfTurn`'s `text` is the empty
// string ("the utterance is over"); `EagerEndOfTurn` is never empty. Both stt-sherpa's `TurnDetector`
// (empty `EndOfTurn` since 2026-11-14) and stt-deepgram (Flux `StartOfTurn`) emit this.
// `Conversation` (review round 4): an `EndOfTurn` whose text is empty or blank closes the open
// utterance and any Stop attached to it, discards a speculative turn, and starts nothing (no agent
// request, no history entry, no canned reply), for every agent kind. An empty or blank
// `EagerEndOfTurn` (outside the contract; review round 5) discards a speculative turn and starts
// nothing, but is NOT the end of the utterance: the utterance stays open and a Stop attached to it
// stays in force until the utterance's `EndOfTurn` (or the lapse), so the rest of a stopped
// utterance can never start a reply through it. A recogniser that breaks the
// contract is tolerated only by a lapse: Stop's cancellation ends after 20 s. No sounder rule exists
// there: `Conversation` sees events and their times, not audio, so it cannot tell a `SpeechStarted`
// that begins a new utterance from one a recogniser repeats inside the stopped one.
// Review round 6: an `EagerEndOfTurn`, `TurnResumed` or `EndOfTurn` that arrives with NO utterance
// open (no `SpeechStarted` since the last `EndOfTurn`) breaks the contract and is ignored: it starts,
// promotes, discards and interrupts nothing, and is logged at most once per 10 s. (A duplicated final
// used to start a second committed turn and run its action twice.) A recogniser that closes an
// utterance early (a reconnect, a session reset) and then goes on hearing it must send `SpeechStarted`
// again before the rest. Typed text, `Say` and Stop are not recogniser events and are never ignored.
// The scripted recogniser fakes of `@pva/core/testing` (`scripted`, `makeScriptedStt`) insert the
// `SpeechStarted` a contract-keeping recogniser would send; `scriptedRaw` sends events as written,
// and `sttContractKeeper()` does the same for fakes that emit in several calls.
// Review round 7: a recogniser must not repeat an utterance's transcript as a new utterance. A
// repeated `EndOfTurn` preceded by a fresh `SpeechStarted` is indistinguishable from the owner
// saying it again, and runs it again. stt-deepgram drops Flux messages of a turn index that has
// already ended on the connection (and, without an index, a final right after a final), and
// synthesises `SpeechStarted` only for a turn that was neither opened nor ended. The time of an
// utterance's `SpeechStarted` also decides whether it can answer a confirmation question (only if
// the question had been played to its end by then), so a recogniser should send it when speech
// begins, not late.

// Language model. One request = one model call. The tool loop lives in core.
Llm: { stream(request: LlmRequest): Stream<LlmEvent, LlmError> }
LlmRequest = { system: string; context?: string; messages: ReadonlyArray<Message>; tools: ReadonlyArray<ToolSpec> }
// `system` is the stable instructions (identical across turns, cacheable); `context` is the
// per-turn context-provider output (omitted when empty), placed by the adapter after any cached prefix.
LlmEvent =
  | { _tag: "TextDelta"; text: string }
  | { _tag: "ToolCall"; id: string; name: string; input: unknown }
  | { _tag: "Done"; stopReason: "end" | "tool_use" | "max_tokens" | "other" }

// Text to speech. One call per turn: clauses arrive incrementally, audio streams out tagged
// with the index of the input clause it belongs to.
Tts: { readonly sampleRate: number; synthesize(clauses: Stream<string>): Stream<TtsAudio, TtsError> }
TtsAudio = { audio: Uint8Array; clause: number }   // `clause` indexes are non-decreasing

// The voices of one text-to-speech provider (docs/VOICE-PROVIDERS.md §7.2): what it offers, and a preview of any of
// them. Separate from `Tts`, which speaks with one chosen voice. Interrupting either effect cancels the work.
TtsVoices: {
  readonly list: Effect<VoiceList, VoiceCatalogError>
  preview(voiceId: string, text: string): Effect<PreviewAudio, VoiceCatalogError>
}
VoiceList        = { voices: ReadonlyArray<VoiceDescription>; truncated: boolean }   // at most MAX_LISTED_VOICES (1000)
VoiceDescription = { id; name; description?; language?; gender?: "female" | "male" | "neutral"; tags: ReadonlyArray<string>;
                     local?: { installed: boolean; sizeMb: number; diskMb: number } }
PreviewAudio     = { sampleRate: number; pcm: Uint8Array }   // s16le mono
VoiceCatalogError: { reason: "unauthorized" | "rate_limited" | "unknown_voice" | "not_installed" | "unavailable" | "invalid"; message; retryAfterMs? }
```

Supporting types (`packages/core/src/Domain.ts`):

```ts
Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ReadonlyArray<ToolCall>; interrupted?: boolean }
  | { role: "tool"; results: ReadonlyArray<ToolResult> }   // adapter maps to the provider's shape
ToolCall   = { id: string; name: string; input: unknown }
ToolResult = { id: string; name: string; content: string; isError: boolean }
ToolSpec   = { name: string; description: string; inputSchema: JsonSchema }
```

History records what was heard and what happened (review round 7). A spoken turn keeps only the clauses whose audio started playing when it was interrupted, or when the output's authoritative final count shows that not everything was played (also for a turn whose playback returned successfully). A turn that settled a confirmation (core's: docs/AGENTS-AND-INTENTS.md §3.2) or refused a proposal ends with an assistant message that is an explicit outcome note, never spoken, attributed to the proposing agent: `[Switch everything off: the owner confirmed; it ran and succeeded.]`, `…; it ran and failed: <reason>`, `[…: the owner said no; it was not run.]`, `[…: not run — the owner answered before the confirmation question had finished playing.]`, `… — the owner's answer came after the confirmation window had closed.`, `… — the action is no longer available.`, `[…: not asked and not run — <reason>]`. When a confirmed action is still running as its turn is committed (the turn was interrupted), the note says its outcome was not known yet and is replaced in place by the real outcome when the action ends. Since the final review, actions that require confirmation are switched off by default (`confirmActions: "off"` in the conversation options): a proposal is refused before anything is asked, and the question, when confirmations are on, is always generated by core, never taken from the module. The known limitations are listed at the start of the actions section of docs/AGENTS-AND-INTENTS.md.

**History bound** (`ConversationOptions.history: HistoryLimits`, defaults `DEFAULT_HISTORY_LIMITS`; added 2026-11-14, review round 3). The stored history — what every model agent is sent each turn and what a new browser tab walks — is bounded, not only what is sent. Whole committed turns are evicted, oldest first: a turn is a user message with everything the assistant said and did in reply, so a tool call always stays with its result and an interrupted reply keeps its `interrupted` marker. Eviction happens after a commit when the history holds more than `maxTurns` turns (default **32**) or more than `maxChars` characters of message text, tool inputs and tool results (default **48 000**), and removes `evictTurns` turns at a time (default **8**; repeated while the character budget is still passed; the latest turn is always kept). Batches keep the start of what is sent to the model the same for eight turns at a time, so a provider's prompt cache (which needs a stable prefix) is invalidated once per eight turns instead of every turn. A single message text or tool result longer than `maxItemChars` (default **8 000**) is cut when it is stored, keeping its envelope (role, ids, flags) and ending in `… [N more characters cut from the history]`. `initialHistory` is bounded the same way. The character budget stands in for tokens: about 4 characters per token in English (fewer in Dutch) makes 48 000 characters roughly 12 000–14 000 tokens — ample for 32 spoken turns (a typical turn is a few hundred characters) while capping what tool-heavy turns add to every request's prefill time and cost. `AgentTurnInput.historyStart` says how many messages were evicted before `history[0]`, so an agent that remembers a position in the history across turns (a harness's catch-up) can keep it in absolute numbers. `AgentTurnInput.conversationId` (docs/VOICE-SESSIONS.md) is the conversation the turn belongs to: it changes with a new conversation and differs per voice session, and an agent that keeps state across turns keys it by this id (agent-claude-code: one Claude Code session and catch-up position per conversation). `Agent.endConversation?(id)` (optional) tells an agent that a conversation has ended so it can drop that state; `Conversation` calls it on the agents of its current setup whenever it starts a new conversation.

History can contain consecutive messages that map to the same provider role (a `tool` message followed by the next `user` message, or a `user` message after a turn that produced no text); the LLM adapter merges them as its API requires.

**How `Conversation` calls `Tts`:** once per turn, with the stream of every clause of the turn (all rounds, including text spoken before a tool call), running ahead of playback. Each clause is handed over the moment the chunker emits it; nothing waits for the end of the LLM stream. The adapter must send each clause on as soon as it arrives, as one continuous synthesis (for Cartesia: one context with continuations; for ElevenLabs: one context, each clause flushed), so later clauses synthesise while earlier ones play, with no gap and natural intonation across clauses. It tags every audio chunk with the 0-based index of the input clause it belongs to, and these indexes never decrease; `Conversation` uses them to know which clauses' audio actually started playing (needed for interrupted history). The clause stream carries no errors: if the LLM fails mid-turn, the stream just ends, the audio already synthesised is played, and then the turn fails.

Interrupting the consumer of any of these streams must cancel the underlying work (abort the HTTP request, cancel the TTS context, kill the player). Barge-in is implemented purely as fiber interruption, so this is a correctness requirement, not a nicety.

### Conversation (the orchestrator, in `core`)

One long-lived fiber consumes `SttEvent`s and owns at most one *turn fiber*.

API: `Conversation.voice(events)` runs the loop over an input stream (`runVoice` wires `AudioInput → Stt → voice` with `Tts`/`AudioOutput`); `Conversation.textTurn(text)` runs one turn as a stream of text deltas without any audio service, through the same LLM/tool-loop code; `Conversation.history` reads the history.

New conversations (docs/VOICE-SESSIONS.md §1): `Conversation.newConversation(reason = "new"): Effect<string>` stops the running voice turn exactly as Stop does (the stopped turn is committed to the old conversation, and the rest of the utterance being spoken starts nothing), then drops the history, the pending question or confirmation and the routing state, gives the conversation a new id, emits `ConversationStarted { conversationId, reason }`, calls `endConversation(oldId)` on the setup's agents, and succeeds with the new id. It is handled by the voice loop in order with its events when one runs, and directly otherwise (no engines needed). A `textTurn` still running is not stopped, but nothing of it is recorded in the new conversation. `Conversation.conversationId` and `Conversation.lastTurnAt` (epoch ms of the last committed turn, `Clock`) read the current state. Option `idleResetMs` (a number, or a function read at every turn start so an assistant's setting can change it; absent/0 = never): when no turn has been committed for that long, the next turn first starts a new conversation with reason `idle`. It is decided at the turn's start (a speculative turn's start for a promoted one), so a speculative turn and its promotion see the same history; a canned `Say` does not trigger it, and a fresh conversation with nothing committed is never reset. `initialConversationId` and `initialLastTurnAt` carry the id and the idle clock across an engine reload together with `initialHistory`.

```ts
ConversationInput = SttEvent | { _tag: "TextInput"; text: string; speak: boolean } | { _tag: "Interrupt" }
Conversation.layer({ systemPrompt, maxToolRounds?, bargeIn?, chunker?, onEvent?, initialHistory?, initialConversationId?, initialLastTurnAt?, idleResetMs?, history? })  // needs ToolRegistry
Conversation.layerWithSetup({ setup: Effect<TurnSetup>, ... })   // TurnSetup = { system, registry, llm?, tts?, maxToolRounds? }, read once per turn
```

- `TextInput` (a typed message) behaves like `EndOfTurn` but always interrupts what runs, whatever the barge-in setting; with `speak: false` nothing is synthesised and the whole reply is committed. `Interrupt` (the Stop button) interrupts the committed turn; a pending speculative turn is discarded; and the utterance being spoken — tracked apart from any turn: `SpeechStarted` or an eager transcript opens it, `TurnResumed` keeps it open, its `EndOfTurn` closes it — is cancelled whether or not a turn exists for it (before its first eager transcript, or between speculative replies after `TurnResumed`). The rest of that utterance — eager transcripts, `TurnResumed`, a `SpeechStarted` inside it, its final `EndOfTurn`, whatever their words — then starts nothing, until its `EndOfTurn` (swallowed; the next `SpeechStarted` then begins something new), typed text or `Say`, or at most `CANCELLED_UTTERANCE_MS` (20 s). An `EndOfTurn` with no words (`text` "") closes the utterance like any other and starts nothing (changed 2026-11-14, review rounds 1–4, see docs/AGENTS-AND-INTENTS.md "Changes since the design").
- `setup` is evaluated once at the start of each turn (voice and text, including a speculative turn that is later promoted): a turn never sees a half-applied module or prompt change. `initialHistory` lets an engine reload keep the conversation.
- `TurnSetup.llm` (optional, added 2026-11-16 for the resource pool, docs/ASSISTANTS.md §3.2): the `Llm` that answers that turn, for every round of its tool loop, even when a newer one is published while it runs. Absent: the `Llm` the conversation was made with, exactly as before. Serve mode sets it to the pool's instance for the assistant's language-model settings, so a changed model applies at the next turn start without rebuilding the conversation. Agent conversations (`makeAgentConversation`) ignore it; their agents hold their own model.
- `TurnSetup.tts` (optional, added 2026-11-16 for per-assistant voices, docs/ASSISTANTS.md §3.2; the exact analogue of `llm`): the `Tts` that speaks that turn, every clause of every round, and whose `sampleRate` the turn plays at. Read in the turn's body from the plan's setup, so a voice published mid-turn applies from the next turn; a `Say` reads the setup when it starts. Absent: the `Tts` the voice loop was given (`Conversation.voice` still requires one), exactly as before. Serve mode sets it to the pool's instance for the assistant's `voice`. Its `sampleRate` must be final once `TurnSetup.ttsReady` has completed: for a voice still being built, the serve setup sets `ttsReady`, and a spoken turn waits for it inside the turn, just before it plays (so Stop, barge-in and a new conversation are never held up by it, and a typed reply that is not spoken never waits). The setup itself never waits.
- `TurnSetup.maxToolRounds` (optional, added 2026-11-17): the tool-round limit of that turn, fixed at its start; it wins over `AgentSet.maxToolRounds` and the conversation's `maxToolRounds`. Serve mode sets it to the assistant's `toolRounds` in the same setup read that makes the turn's configuration snapshot (`TraceInfo.config.toolRounds`), so a changed limit applies from the next turn and the snapshot reports the limit the turn ran with.
- `onEvent` receives `ConversationEvent`s synchronously on the turn's fiber (no Effect per event): `ConversationStarted` (a new conversation, `reason` `new` or `idle`; before the turn that an idle reset started for), `TurnStarted` (with `speculative`, `spoken`, `source`), `TurnPromoted`, `TextDelta` (raw, rounds separated by `"\n"`), `ClauseQueued`, `ClausePlaying`, `ToolStarted`, `ToolFinished`, `TurnEnded` (after history is committed, with the trace). Speculative turns emit events too; the subscriber decides what to show. A throwing subscriber is ignored.
- `CurrentTurnTrace` is provided around `AudioOutput.play` as well as around `Tts.synthesize` (the web output uses the turn id as the reply id and records the browser's numbers in the trace).

| Event | Action |
|---|---|
| `EagerEndOfTurn(text)` | Start a **speculative** turn: run LLM → clause chunker → TTS, buffering audio, but do not play and do not write history. |
| `TurnResumed` | Interrupt and discard the speculative turn. |
| `EndOfTurn(text)` | If a speculative turn exists for the same text, promote it: start playing the buffered audio and commit history. Otherwise start a normal turn. "The same text", for **every** agent kind (review round 5; rounds 3–4 applied it to intent turns only): the same canonical text (`canonicalUtterance` in `packages/core/src/Utterance.ts`, the very normalisation the intent path's parser and accounting read; `strictTranscript` is that function): only whitespace and the closed set of ignorable punctuation may differ, case and every other mark count ("yes" vs "yes?", "5" vs "–5", "5" vs ".5" differ). A turn planned for a conversational agent can reach an intent agent by hand-off or failure fallback, and a conversational agent can call side-effecting tools, so there is one rule. An `EndOfTurn` with no words promotes nothing and starts nothing. |
| `SpeechStarted` while a committed turn is running | Barge-in (if enabled): interrupt the turn fiber, whether or not its audio has started playing (so a stale reply never starts over the user). History records only the clauses whose audio actually started playing, marked as interrupted. A pending speculative turn is left alone: `TurnResumed` or `EndOfTurn` decides its fate. |
| `EagerEndOfTurn` / `EndOfTurn` while a committed turn is still running | With barge-in enabled, interrupt it (history as above) and start the new turn. With barge-in disabled, ignore the event (it is most likely the assistant's own voice). |

Details:
- "Same text" is the canonical-text comparison above (`sameUtterance`); `normalizeTranscript`, the looser comparison that ignored case and a final "?", was removed in review round 5. A turn decided on "5" is never promoted for "-5", nor one decided on "yes" for "yes?".
- A clause's audio "started playing" when its first chunk was handed to `AudioOutput` (`playbackStart` marks the first chunk of the turn). With an output that `reportsPlayback`, `Conversation` instead records each clause's start offset in samples as chunks are pulled and counts a clause as played once the reported progress passes it; `playbackStart` is marked on `started()`. With barge-in disabled, `SpeechStarted` does nothing.
- A turn whose playback fails (the browser disconnected) is committed like an interrupted one: only the clauses reported as played.
- If the event stream ends, a still-pending speculative turn is discarded and a committed one is allowed to finish.
- A turn that fails (provider error) is logged and committed like an interrupted one; the loop keeps running.

Speculative turns must not run tools with side effects. Each `Tool` declares `speculative: boolean` (default `false`); if a speculative turn reaches a non-speculative tool call it pauses there until promoted.

Tool loop: on `ToolCall`, look the tool up in the `ToolRegistry`, decode the input with the tool's `Schema`, run it (calls in the same response run concurrently), append results, call the LLM again. Cap at a configurable number of rounds (default 5): at most that many tool rounds and one more LLM call; if the model still asks for tools after that, the turn ends (the unanswered calls are not recorded). Tool failures, invalid input and unknown tools are returned to the model as error results, never thrown. Text the model produced before a tool call is flushed to TTS before the tools run (the text stream carries a `"\n"` between rounds), so "let me check" is heard while the tool works.

Clause chunker: buffers `TextDelta`s and emits at sentence or clause boundaries (`. ! ? ; :` and, once past a minimum length, `,`). The first clause is flushed aggressively (short minimum) so TTS starts as early as possible. Pure function over a stream, tested on its own.

### Voices and voice providers (docs/VOICE-PROVIDERS.md)

A **voice** is one concrete voice of one provider: `VoiceRef = { provider, voiceId }` (`packages/core/src/VoiceRef.ts`), written as the voice key `provider:voiceId` where one string is needed (`voiceKey`, `parseVoiceKey`). The providers are `sherpa` (on this machine: Piper, Kokoro), `cartesia` and `elevenlabs`; each adapter package implements `Tts` (a `layerConfig` that speaks with the voice its voice setting names) and `TtsVoices` (`makeVoices`: the voices it offers, and previews). Provider-specific HTTP lives in the adapter: the hosted adapters list and preview over REST (`fetch`, never the live WebSocket), with every error built through their `redact.ts`.

- **One voice speaks every reply of an assistant.** The model does not choose (the `[voice:NAME]` markers, the voice router and the voice block of the system prompt were removed on 2026-11-16). Each assistant has one voice reference (`Assistant.voice`); the resource pool holds one `Tts` per distinct voice and a turn speaks with its assistant's (`TurnSetup.tts`). `apps/assistant/src/voiceSelection.ts` keeps the resolution of the flat `ASSISTANT_VOICE` setting (read by the CLI modes and by the version 3 -> 4 migration) and the default voice.
- **Building a voice.** `ttsLayerFor(ref)` is the provider's layer from `ttsProviders` with its voice setting (`ttsProviderInfo[...].voiceSetting`: `TTS_SHERPA_PRESET`, `CARTESIA_VOICE`, `ELEVENLABS_VOICE`) set to the voice's id; every other provider setting is read as usual. It is one startup stage (`voice (ASSISTANT_VOICE)`), so a missing key or model is reported with the other settings.
- **Sample rate.** A reply plays at its voice's rate (Piper 22050 Hz, the others 24 kHz), the rate of the turn's own `Tts` (`TurnSetup.tts`). A changed voice is built first and applies at that assistant's next turn.
- **Tracing.** `withTraceVoice(tts, key)` appends the voice key to `trace.voices` once per turn, shown as `voices: …` in the latency line. `synthesizeText(tts, text, maxSamples)` speaks a text cut into clauses and collects the audio (previews, `say`).

### Local adapters: worker thread and child processes

**`stt-sherpa`.** The recogniser, the Silero VAD and a gain control run in a `worker_threads` worker (one per loaded model; several concurrent `transcribe` calls share it, each a session of its own in the worker with its own VAD, gain control and turn state, and whole-turn decodes of all sessions queued one at a time; docs/VOICE-SESSIONS.md §3) (plain `.mjs`, because workers inherit no TypeScript loader), since each decode blocks for tens of milliseconds to seconds. Workers are shared process-wide by **worker key** (`workerKey`: model, model directory, threads, the language only for a model that takes one, and the per-model tuning; docs/ASSISTANTS.md §3.2): `make(options)` and `acquire(options)` reuse the loaded worker of the key, counted, stopped with the last user; everything else is **per stream** (`SherpaStreamOptions`: turn timing on the main thread, and the VAD threshold, gain control and pre-roll sent in the worker session's `open`), so two recognisers that differ only there share one loaded model. A worker that dies is not reused; a worker that did not answer `close` in time is left behind, and no new worker of *its key* loads beside it until it has gone (other models still load). The main thread copies audio into one transferred buffer per batch and runs the pure `TurnDetector` state machine on the per-frame VAD decisions; it drops audio rather than queue it when the worker falls behind by more than 1 s. Turn detection is silence-based (`EagerEndOfTurn` after 250 ms, `EndOfTurn` after 600 ms by default), and the eager transcript is a real final decode, so the speculative turn is promoted whenever the user does not resume. Two recogniser families behind the same `Stt` contract: **whole-turn** models (Parakeet, Whisper; the default) keep the turn's audio and decode all of it, from the turn's start, at each eager point, off the worker's event loop (`decodeAsync`), so VAD decisions keep flowing during the decode; their answer replaces the turn's text (the detector's cumulative mode), so a resumed sentence is decoded again as one piece instead of being joined from segments. **Streaming** models (Nemotron) show words while the user speaks and finalise a segment per pause, with a fresh stream per segment. A **hybrid** preset runs both: streaming for the live words, Parakeet for the text. The detector tells the worker when a turn ends (`Commit`) so the turn's audio is dropped; the worker collects garbage once per turn to keep the recogniser streams' native memory flat.

**`tts-sherpa`.** Each engine (the assistant's voice when it is local, plus at most one kept engine for previewing another local voice) runs in its own forked child process, because Piper needs `sherpa-onnx-node` 1.x and Kokoro 2.x, and because killing a child mid-synthesis is safe while terminating a worker was not. Clauses are queued in the parent and sent one at a time; audio comes back over IPC as `Float32Array`, is trimmed to controlled pauses and chunked on typed arrays. A crash or a stuck clause fails the turn and restarts the process; the child exits when the parent's IPC channel closes, and ignores the terminal's Ctrl+C so the parent shuts it down in order.

Building either layer fails with `SttError` / `TtsError` (e.g. a missing model file, naming the download command); the app reports that like a missing setting, per startup stage.

### Latency tracing

Every turn records monotonic timestamps (`performance.now()`): `endOfTurn`, `llmRequestSent`, `llmFirstToken`, `firstClause`, `ttsFirstAudio`, `playbackStart`, plus per-tool durations and the voices used. An output in a browser adds `client: { outputLatencyMs, startDelayMs }`, and the latency line then shows `audible=` (playback start plus the device's output latency). The `TurnTrace` service logs one line per turn with the deltas and exposes the last N traces. Each mark is shown relative to `endOfTurn` (negative for work a promoted speculative turn did early) and relative to the previous mark; the line also carries the outcome (`completed`, `interrupted`, `discarded`, `failed`). Marking is a plain synchronous call so it can sit on hot paths. In text mode only the LLM marks apply. Any change that claims to improve latency is judged by these numbers. `bench` in the app prints them as per-turn tables with median and worst case: offline (scripted turns through the real `Conversation` with the `@pva/core/testing` fakes and simulated provider delays; the TTS stand-in is tagged with its voice, as in the app) or live (WAV files through the real providers).

Latency techniques that are required, not optional:
- Everything is loaded at startup: local models are loaded and warmed up when their layers are built; hosted STT/TTS WebSockets are opened at startup and kept warm (reconnect with backoff). The LLM HTTP client uses keep-alive.
- Prompt caching for the system prompt and tool list.
- LLM configured for speed: thinking disabled / lowest effort, small `max_tokens`, a system prompt that asks for short spoken-style answers.
- No per-sample Effects. DSP and buffering happen on typed arrays inside a service; Effect `Stream`/`Queue` carry chunks between stages.

## Extending the assistant

A capability is a **module**, declared with `defineModule` (`packages/core/src/ModuleDefinition.ts`) and listed in `moduleCatalog` (`apps/assistant/src/modules.ts`):

```ts
defineModule({
  id: "weather", name: "Weather", description: "…",
  settings: { defaultPlace: Setting.text({ label: "Home location", env: "WEATHER_DEFAULT_PLACE", overridable: true }), … },
  enabledByDefault?: boolean,
  start: ({ settings, setStatus }) => Effect<ModuleInstance, ModuleStartError, Scope>
})
ModuleInstance = { tools?: ReadonlyArray<Tool>; context?: ReadonlyArray<ContextProvider>; instructions?: string }
```

Settings use a closed set of field types (`Setting.text`, `secret`, `number`, `boolean`, `choice`, `multichoice`; `packages/core/src/Settings.ts`); precedence is environment > saved value > default, and an environment value locks the field in the UI. Since WP-12 (docs/ASSISTANTS.md §2.6) a field may be `overridable` (never a secret; modules do not mark addresses): an assistant may then hold its own value for it (`ModuleChoice.own`), which wins over the environment and the saved value for that assistant, and the field description sent to the admin says `overridable: true`; a module's default may be a *linked default* computed from the shared Home section (`ModuleHostOptions.defaults`: Weather place and units, Clock time zone and date format), used when nothing is saved and the environment does not set the field. Every field reports its `source` (default, saved, `.env` file or process environment) and may carry `visibleWhen` (shown, validated and saved only while another field has one of some values); choice options may carry `tags` (hosted, needs key, …) and an `implication` line; `runSettingsChecks` runs cross-field checks. The **module host** (`packages/core/src/ModuleHost.ts`, no Node dependency; persistence injected) starts enabled modules, enables, disables and reconfigures them while the assistant runs (one operation per module at a time; a replaced or disabled instance keeps running for a 10 s grace period so tool calls in flight finish; `start` has 10 s; a context provider has 50 ms per turn or contributes nothing), and publishes an immutable snapshot (tool registry, instructions in catalog order, tool → module map) that each turn reads once through `ConversationSetupOptions.setup`. `setSecrets` replaces the modules' saved secrets without saving them (the app's key vault was unlocked or locked) and restarts enabled modules that failed. A module runs as **instances**: without `ModuleHostOptions.demand` (the CLI modes; agent and decision-provider modules always) one at most, following its saved switch, exactly as before. With `demand` (serve mode, for every capability) the module runs while at least one switched-on assistant has it on, one instance per distinct set of effective settings (own values over shared over linked defaults), shared by every assistant whose settings are equal; its own switch is then not read (`enable`/`disable` answer `not_allowed`). `refresh` (after every settings save, and after a Home save) starts the instances now wanted and retires, with the grace period, the ones no longer wanted; a replaced instance serves until its replacement has started. `configure` restarts only the instances whose effective settings change (every one when a secret changes), all or nothing. One instance failing to start is that instance's `error` only (`ModuleInfo.instances` lists each with its assistants; the module's `state` is `error` while one fails); the others run. The snapshot keeps one instance per module in `registry`/`parts` (the shared-settings one when it runs) and adds `assistantParts`: per assistant, the parts of the instances it uses, from which serve mode builds that assistant's registry and instructions (filtered by its module and tool switches) at its turn start. `checkOwn` validates an assistant's own values with the fields' own validators (`assistant.save` refuses a secret, a field that is not overridable, or a value the field refuses). The system prompt of a turn is base prompt + (serve mode) the Home line (`homeLineOf`: location, time zone, language of the `home` section) + running modules' instructions; changing the tool list or the instructions changes the cached prefix once. The CLI modes start the catalog through the same host with the saved settings and no live changes; they read the assistant settings the same way as serve mode, environment > saved > default, with the vault's keys (`cliSettings.ts`: unlocked by `PVA_VAULT_PASSWORD`, or a password prompt on a terminal). A module may set `enabledWhenSet: <secret key>`: until the owner chooses, it is on once that key is set in the environment or the vault (judged by the host, re-checked when the vault unlocks). Full lifecycle: docs/UI-AND-MODULES.md §1.4.

The pieces a module returns are the original capability shapes (an `AssistantModule` is still accepted by `makeToolRegistry`, and `fromAssistantModule` wraps one as a definition):

```ts
interface AssistantModule {
  readonly name: string
  readonly tools?: ReadonlyArray<Tool>              // things the model can call
  readonly context?: ReadonlyArray<ContextProvider> // facts sent with each turn (LlmRequest.context)
}
interface Tool<I = any, R = never> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Codec<I, unknown> // validated input; also the source of the JSON Schema sent to the model
  readonly speculative?: boolean             // safe to run before the turn is confirmed (read-only lookups)
  readonly execute: (input: I) => Effect<unknown, ToolError, R>
}
interface ContextProvider { readonly name: string; readonly get: Effect<string> }  // must be fast; cached or local
```

The JSON Schema is `Schema.toJsonSchemaDocument(parameters)`, which describes the schema's canonical JSON form, so the registry decodes model input with the matching `Schema.toCodecJson(parameters)`. Prefer `Schema.Finite` / `Schema.Int` over `Schema.Number` (the latter's JSON form also admits `"NaN"`/`"Infinity"` strings, which clutters the schema). `makeTool({...})` infers `I` from `parameters`. `packages/modules-builtin/src/clock.ts` is the reference module.

Context-provider output is sent each turn as `LlmRequest.context`, separate from the stable `system` prompt, so a ticking clock does not invalidate the cached prefix (system prompt + tools). The LLM adapter places it after the cached prefix. Keep it short and fast to compute.

Adding a feature = one new file exporting `defineModule({...})` + one line in `moduleCatalog` in `apps/assistant/src/modules.ts`. Adding a provider = one new package implementing a core interface + one line in `apps/assistant/src/providers.ts`. Adding a voice provider = an adapter with `layerConfig` (`Tts`) and `makeVoices` (`TtsVoices`), and one entry in `ttsProviders`, `ttsProviderInfo` and (hosted) `hostedTtsVoices` in `providers.ts`. A voice needs no code: it is chosen by its key.

## Serve mode (web UI)

`pnpm start serve` (`apps/assistant/src/serve/`) runs one HTTP(S) server on one port: the static UI from `apps/web/out` (the voice front end at `/`, the admin front end at `/admin/`, `/admin` redirected there; docs/FRONTENDS-AND-ACTIVATION.md) and a WebSocket at `/ws` speaking the protocol in `packages/protocol` (JSON text frames validated with Effect Schema; binary frames of PCM with an 8-byte header). Design and protocol: [docs/UI-AND-MODULES.md](UI-AND-MODULES.md).

Every voice device has its own **voice session** ([docs/VOICE-SESSIONS.md](VOICE-SESSIONS.md)): several devices talk at the same time, each with its own conversation, and each hears only its own replies. The resources (language models, voices, recognisers) are shared by configuration (docs/ASSISTANTS.md §3.2).

```
                ┌──── Resource pool (Resources.ts) · Engine (full reload / status) ────┐
                │ Llm per configuration · Tts per voice · Stt per SttKey (a stream      │
                │ per device, with its hearer's options) · modules                      │
                └───────────────────────────────────────────────────────────────────────┘
device A, owner tab ─mic─▶ SessionHub ─▶ VoiceSession A: WebAudioInput ▶ Stt(A's hearer) ▶ EchoGate ▶ RouteGate ▶ Dispatcher ▶ Conversation(s) ▶ … ▶ Tts ▶ OutputLease ▶ WebAudioOutput ─reply─▶ A's owner tab
                    ◀──── Publisher A (ConversationEvent → messages, to device A's tabs only) ◀── onEvent ─┘    playback reports ─▶ PlaybackObserver
device B, owner tab ─mic─▶ SessionHub ─▶ VoiceSession B: … the same, with its own conversations …                                   ─reply─▶ B's owner tab
   each device's effective settings (type defaults ← its own sections) ──▶ its session's EchoGate mode, RouteGate config, the hearer
admin page ──HTTP /api/ (Bearer admin token)──▶ voice catalog (providers, lists, previews) · favourites · ASSISTANT_VOICE
```

- **`packages/audio-web`** is the browser as `AudioInput`/`AudioOutput`, over an abstract link (no WebSocket dependency). The input is a continuous real-time 16 kHz stream: the owner's microphone frames while there is an owner with a live microphone, otherwise a −75 dBFS noise floor, so every STT adapter behaves as with a real microphone. The output sends reply audio as fast as TTS produces it (never paced) and waits for the browser's `playback.*` reports (`reportsPlayback: true`); it stops a reply on interruption (`reply.stop`, ≤ 300 ms wait for the final count), fails on owner loss, and fails with `playback_timeout` when the browser stops reporting for 2 s. Every reported count is clamped to the samples it sent to that link for that reply, so the `PlaybackObserver` never sees more than was transmitted (docs/UI-AND-MODULES.md, "Changes since the design"). Its input queue holds 3 s and counts what it drops (`inputStats()`).
- **SessionHub**: handshake, roles, requests, routing by audience, send limits. A voice connection belongs to the session of its device (`hello.device.id`, else its own `clientId`); ownership is per session (one tab of the device owns its audio, the others observe, the last claim on *that device* wins, `resumeOwner` within the device; a claim on another device takes nothing; admin pages never own audio). A session's messages (`state`, `transcript`, `turn.*`, `assistant.*`, `tool.*`, `reply.*`, `wake`, `conversation`, its `error`s) go to its device's connections only; shared ones (`engine.summary`, …) are broadcast; `ADMIN_ONLY` types (now with `sessions`, throttled like `devices`, and `trace`: every finished turn of every session with its `key`, `deviceId` and `TraceInfo.session`, so admin's latency view grows live without turn traffic) go to admin connections only. At most 24 connections. **VoiceSessions** (`serve/VoiceSessions.ts`): device → session, created at the device's first `audio.claim` or `text.send` (an idle open tab costs nothing), at most `MAX_VOICE_SESSIONS` (default 4; one more takes the place of the least recently active session whose device has no connection, else it is refused `sessions_full`), discarded with its conversation after `SESSION_DISCARD_MINUTES` (default 30) without a connection; a device without a session still has the conversation id its first turn will use (`conversation.new` works before anything was said); the recent traces of every session for admin. **VoiceSession** (`serve/VoiceSession.ts`): one device's `WebAudio`, echo gate, wake gate, state tracker, publisher, heard-audio tap and **SessionConversation** (`serve/SessionConversation.ts`: the `Conversation` and its voice loop on the shared engines, the history, conversation id and idle clock carried across builds, the typed-input admission; every reply is spoken with the voice of its turn's setup, `TurnSetup.tts`). Its device's settings configure it live (`syncProfile`: interrupt mode, the route gate's phrases and without-phrase mode, the hearer); each assistant on the device has its own `SessionConversation` (made on first use; its prompt, tools, follow-up, `idleResetMs` from `newConversationAfter`, reply early, tool rounds come from that assistant), all behind one **SessionDispatcher** and one **OutputLease**. Its turns are numbered per session and its traces carry `session` (the device name) in the latency line and in `TraceInfo`. A Claude subscription assistant's conversations use the one running agent module, which keeps one Claude Code session per conversation id (so per device and assistant) and answers each turn with that assistant's model, effort, thinking, tools and fresh-session time (`withConversationOptions`, docs/ASSISTANTS.md WP-13a; the module's opt-in, program, proxy and debug logs are the account's, shared), at most `MAX_VOICE_SESSIONS` × the switched-on assistants on the account open at once; a discarded session ends its conversation there. Every finished turn's `TraceInfo.config` (admin only) is the configuration snapshot taken at its start (docs/ASSISTANTS.md §3.7). **AdminSessions**: `PVA_ADMIN_PASSWORD` (read once at start, removed from the environment and the env view; unset or < 8 characters = admin disabled), `admin.login` → a random token kept in memory (12 h, 30 min idle, constant-time compare, the vault's back-off), accepted again in an admin page's `hello`; every request that changes the server is admin only (`admin_required`). **Assistants and devices** (`serve/assistants.ts`, `serve/devices.ts`; docs/ASSISTANTS.md): the assistants, the **device types** (`DEVICE_TYPES`, `web-voice` today: the registry that replaced the front-end kinds) with their defaults, and the **device registry** (devices recorded at hello, at most 64, with their names and last visits), stored in `settings.json` version 4 (`assistants`, `deviceTypes`, `devices`, each entity with a `rev`). A device's effective settings = built-in ← its type's defaults ← its own sections; `assistant.*`, `device.save`, `device.pick` and `device.forget` change them, and the new setup is pushed live to the device's tabs (`device.setup`) and the lists to the admin pages (`assistants`, `device.types`, `devices`). **Publisher**: maps conversation events to messages synchronously, holding a speculative turn's messages until it is promoted. **StateTracker**: the assistant state. **Engine**: since WP-11 it holds no provider (`EngineProviders.llm` / `.stt` / `.tts` / `.voice` exist only for tests that inject one of each; the pool then hands out instances that use them); it is the **full reload** of docs/ASSISTANTS.md §3.2 (the owner's Reload button, model directories and thread counts) and the status. Each session attaches its loop (`attach`), which runs on every build and is stopped, keeping that session's history and conversation id, when the build ends; a loop that fails (not interrupted) stops the engines (`failed`, stage speech-to-text); a build failure is reported per stage instead of exiting; a reload first runs cheap checks (serve mode's: the model files of every local recogniser in use exist), and if they fail the running engines are kept; a reload also rebuilds every resource in use in the background. Its status lists the resource pool's resources (`EngineStatus.resources`) and, from them, the `llm`, `stt` and `tts` engine rows and the `voices` in use. **Resources** (`serve/Resources.ts`, docs/ASSISTANTS.md §3.2): the resource pool: the language models, the voices and the recognisers; one language-model instance per distinct `LlmKey` (plus the account's key stamp), shared by every assistant with equal settings, built at start and reconciled after every settings save and vault change; a changed model is built first, then the assistant's next turn start takes it (`TurnSetup.llm`), turns already running finish on the old one, which is released 10 s after its last user; a build failure is that resource's problem only (its assistants' turns fail, the others run); the owner's reload rebuilds every instance in use without interrupting a turn. Voices (WP-10) are keyed by `voiceKey`; assistants with the same voice share one instance, and the voices of one local engine (every Kokoro speaker) share that engine, which runs one clause at a time; a changed voice is built first and applies at that assistant's next turn (`TurnSetup.tts`). Recognisers (WP-11) are keyed by `SttKey` (stt-sherpa: model, language when the model takes one, model directory, threads; Deepgram: the shared model and address) and bound per hearing place (a known device, or a device type's defaults for the devices that follow them): each device hears with its *hearer's* (`hearerOf`: the assistant that answers without a phrase, else the first in its list) model, on a stream with that hearer's turn timing, VAD and gain (Deepgram: confidences), so hearers on one model share one loaded worker; a device with no assistant runs none. A changed hearer, model or stream option builds the new recogniser first, and the device's stream is replaced at its next silence (at most 5 s; an utterance still open then is closed and starts nothing). A recogniser that fails to load or whose worker dies is a failed resource: its devices hear nothing (told once with `engine_failed`), typed text still works, the hearer's `AssistantInfo.problems` name it, every other device hears. A save whose new local models would need more than 75 % of the free memory (WP-0's `ramMb`) asks for "Save anyway". **HeardAudio** (one per session): when "Save what the assistant hears" is on, each turn's audio as the recogniser received it goes to `data/recordings/<time>-<device>-<n>.wav` with level statistics, the transcript, the device (`device: { key, name }`) and transport counters (`pnpm start compare-models` replays them through every installed model). **SettingsStore**: `data/settings.json` (version 4: module settings per module, the shared settings flat by key, the assistants, the device types' defaults and the device records; a version-3 file is migrated at load into one assistant with the same behaviour and kept as `settings.json.v3-backup`; a version-2 file is read as version 3 first, a version-1 file is migrated at load, collision-safe, with a `.v1-backup`, keeping its revision), atomic writes; secrets in the key vault once one exists, else `data/secrets.json` (0600), the same shape. A save that changes both the settings and the secrets file (`secrets.json`, or the vault's file) writes both with one new `revision`, journalled in `data/transaction.json` (0600; with the vault it holds only the vault's encrypted text, and restoring it needs no password) and resolved at the next load; the vault carries its revision outside the encrypted part (authenticated), so a locked vault can still be matched with `settings.json`, and a save that changes no secret while the vault is in use writes `settings.json` alone with the vault's revision (so settings save while the keys are locked). Read-only loads (the CLI modes) take no lock and see exactly one committed save: they re-read while the journal or the files change (equal revisions prove the two files are one save), at most 20 times (~1 s), and otherwise fail rather than mix two saves; with the vault they decrypt the vault text that snapshot chose. Settings and keys that may come from two saves (a damaged journal) start no engine and no module until the next save (the engine status says why). `serve` is the only writer: it holds an advisory `flock` on `data/writer.lock` (`DataDirLock.ts`: taken by the util-linux `flock` program on the server's own descriptor, released by the kernel when the server exits or dies; the file is never removed; `data/writer.holder` names the holder for messages) from before it reads the settings until it stops, so a second server on the same directory refuses to start; the CLI modes only read. (The lock is the data directory's: two servers with different data directories sharing one vault file are not kept apart.) **Vault** / **Keys**: the encrypted key vault outside the project (`PVA_VAULT_PATH`, default `~/.config/pva/vault.enc`; scrypt + AES-256-GCM, `node:crypto` only), locked after every start, unlocked with the owner's password (or `PVA_VAULT_PASSWORD`); an unlock reloads engines that failed and restarts modules that failed. **access**: which sections and modules are protected (a secret field, the provider sections `language-model`, `stt-engine`, `voice-providers`, agent modules); since protocol 5 this is information only (every change needs an admin session, and the vault password alone grants nothing). Details: docs/UI-AND-MODULES.md §1.6, docs/FRONTENDS-AND-ACTIVATION.md §1. **Voice API** (`serve/api.ts`, `VoiceCatalog.ts`, `Favourites.ts`, `AssistantVoice.ts`; docs/VOICE-PROVIDERS.md §5, §7.3): HTTP routes under `/api/` on the same server (host check, same-origin only, every route admin only with `Authorization: Bearer <admin token>`): providers and their status (a missing key is `needs_key`, never an error), every provider's voices (hosted lists cached 6 h per key), previews as WAV (at most 300 characters; one at a time, a newer one supersedes; hosted over the provider's REST synthesis; local ones refused while a device is in a turn and cancelled when one starts, the running engine reused for the assistant's own voice, one kept engine for another local voice), local voice downloads as `tts-models` jobs, favourites in `data/voice-favourites.json`, and, since WP-10, no single assistant voice: `VoiceEntry.usedBy` lists the assistants that speak with a voice, `GET /api/voices/default` answers with the first assistant's voice (`source: "assistant"`), `PUT /api/voices/default` answers `410 gone` (each assistant's voice is saved with the assistant). **sections**: the assistant settings (voices, engines, turn detection) as settings forms keyed by their environment variable names, fed to the providers through a `ConfigProvider` placed under the environment. `sectionDefinitions.ts` places each section on a page of the web UI's settings screen (`group`, `page`, `order`), makes fields and pages depend on a choice (`visibleWhen`: hidden fields are not validated or saved) and declares cross-field checks (errors refuse a save, warnings ask for "Save anyway"); a save names the page in `EngineStatus.reloadPendingFor` when it needs an engine reload. Design: docs/SETTINGS-UI.md. **Env view** (`apps/assistant/src/envView.ts`, loaded by `env.ts`): every environment variable with its origin (a `.env` file with path and line, from Node's own `util.parseEnv` plus a line scan, or the process); sections and the module host read it live, so **envSettings** (`serve/envSettings.ts`) can move a `.env` value into the saved settings (a key into the vault, refused while it is locked), release it from the view and `process.env`, and comment its line out of the file (backup, atomic rewrite, mode kept; values never logged or sent). **Jobs** (`serve/jobs.ts`): long-running work with progress, a short log and cancel, published to every page (`job`), started only by admin pages; **models** (`serve/models.ts`) uses them to download speech models by preset name through `downloadPreset` of the speech packages (the shared downloader is `@pva/core/download`: disk check with `statfs`, `.part` file, stall timeout, size check, `nice -n 10 tar -xjf` into a temporary folder, file check, then into place; cancel and failures clean up, and a start removes what an interrupted run left).
- **`EchoGate`** (`packages/core`, pure): during the audible window it passes everything (`instant`), drops recognition events that are the assistant's own words (`confirm`), or drops everything (`manual`). Serve mode always runs `Conversation` with barge-in on; the gate implements the interrupt modes.
- **`RouteGate`** (`packages/core/src/RouteGate.ts`, pure; docs/ASSISTANTS.md §3.4, docs/FRONTENDS-AND-ACTIVATION.md §3): placed after the `EchoGate` and before the dispatcher. It decides, for each utterance on a device, which assistant it goes to: a wake phrase at the start (matched over every assignment's phrases, `matchWakePhrase`: normalised words, at most two fillers first, `exact` or `close` = one edit on words of four or more letters, longest phrase wins, the phrase removed in every mode) picks its assistant; the phrase alone opens that assistant's armed window; a reply opens its follow-up window (per assistant, from the assignment or the assistant); otherwise the device's `withoutPhrase` decides (`nobody`: the utterance is dropped and the device is asleep; `assistant`: that one; `decide`: TypeSafe, asked by the dispatcher). A switched-off assistant is the answer and the utterance is dropped. Every event it lets through is tagged with a target; the utterance contract holds (a dropped utterance forwards nothing). The gate is reconfigured only when its config changes (`routeConfigFrom`), which drops a held utterance. Only events that passed both gates move the session state (`asleep` while the owner's mic is live and nobody is awake), become captions, reach a conversation or end a "what the assistant hears" recording; an ignored utterance's text goes only to admin pages with the phrase tester on (`wake.heard`). A heard phrase is sent to the device's tabs as `wake` (with `assistantId`). `WakeGate` (`WakeGate.ts`, the single-assistant gate with `always`/`wake-phrase` and `wakeConfigFromProfile`) stays in core: `RouteGate` uses its matcher, the offline bench still measures it, and the voice-node branch builds its one-shot mode on it.
- **`SessionDispatcher`** (`serve/SessionDispatcher.ts`, docs/ASSISTANTS.md §3.3): per voice session, after the route gate: it owns the routing state of one device, makes one `SessionConversation` per assistant on first use, sends `SpeechStarted` to the conversation whose turn is running (barge-in) and hands the utterance over to its target with an empty `EndOfTurn` when the words show it is for another assistant, drops `EagerEndOfTurn` and `TurnResumed` for assistants with `replyEarly` off, and for a `decide` target asks TypeSafe (`serve/routing.ts`, `packages/decide-typesafe/src/routing.ts`) at the first eager event, holding events until the answer or the give-up time (default 400 ms). **`OutputLease`** (`serve/OutputLease.ts`) gives every conversation the session's one `AudioOutput`: a `play` that starts while another conversation's plays makes the older fail with `AudioError("superseded")` (committed like an interrupted turn), so two replies never sound at once.

## Repository layout

```
packages/
  core/             interfaces, domain types, Conversation, tool loop, clause chunker, TurnTrace, voice references
                    (`VoiceRef`, `TtsVoices`), resampler, settings, module definition and host, echo gate, route gate (and the
                    single-assistant wake gate), in-memory fakes (and a trigger-phrase router fixture for the agent tests);
                    `@pva/core/download` (Node only): the model-archive downloader the speech packages share
  llm-anthropic/    Llm via @anthropic-ai/sdk (default model claude-haiku-5-5)
  stt-sherpa/       Stt on this machine: sherpa-onnx + Silero VAD + gain control in a worker thread, silence-based turn
                    detection; whole-turn presets (parakeet-v2 default, parakeet-ultra, whisper-turbo), streaming presets
                    (nemotron-560, nemotron-320, zipformer-en, fast-conformer-en) and a hybrid (live words + Parakeet)
  tts-sherpa/       Tts on this machine: Piper / Kokoro via sherpa-onnx, one child process per engine (default)
  stt-deepgram/     Stt via Deepgram Flux (wss /v2/listen, eager end-of-turn) — hosted, optional
  tts-cartesia/     Tts via Cartesia Sonic WebSocket (contexts/continuations, raw pcm_s16le) — hosted, optional
  tts-elevenlabs/   Tts via the ElevenLabs multi-context WebSocket (one context per turn, raw pcm_s16le) — hosted, optional
  audio-pipewire/   AudioInput/AudioOutput by spawning pw-record / pw-cat
  audio-file/       AudioInput from a WAV/PCM file (paced in real time), AudioOutput to a WAV file — for tests and benchmarks on machines with no sound card
  audio-web/        AudioInput/AudioOutput for a browser (serve mode), over an abstract link to the owner's connection
  protocol/         browser ↔ assistant protocol (version 7): message schemas, binary framing, examples; assistants,
                    device types, devices and their settings, resolution rules and bounds (`assistants.ts`, `devices.ts`);
                    device identity, wake phrases and the version 3 profile fields the migration reads (`frontends.ts`);
                    admin sessions (`admin.ts`) (browser-safe)
  agent-claude-code/ the claude-subscription harness agent: Claude Code via @anthropic-ai/claude-agent-sdk with the owner's
                    login, off by default with an opt-in; the subprocess environment is an allowlist
  modules-builtin/  first modules (defineModule): clock (context + tool), weather (Open-Meteo HTTP lookup, speculative-safe)
  module-home-assistant/ lights by room through the owner's Home Assistant (REST, actions); in the app's catalog since WP-12c
models/             downloaded model files (git-ignored; `pnpm download-models`, or Settings › Models in the web UI)
apps/
  assistant/        config (env view with origins, `.env`; cliSettings.ts: CLI modes on the saved settings), providers.ts (one map per stage, chosen by `LLM_PROVIDER` / `STT_PROVIDER` /
                    `AUDIO_BACKEND` in the CLI modes; `llmAccountLayers` for the assistants' accounts; `ttsProviders` / `ttsProviderInfo` for the voice
                    providers), voiceSelection.ts (the default voice, `ASSISTANT_VOICE` for the CLI and the migration), modules.ts (the module catalog), main.ts, serve/ (web UI server:
                    Resources.ts the resource pool, SessionDispatcher.ts, OutputLease.ts, assistants.ts, devices.ts, migrateAssistants.ts); modes: `serve`,
                    `voice`, `text` (stdin/stdout, no audio), `bench`
                    (offline with simulated delays, `--live` over WAV files with the real providers, `--make-wavs`),
                    `say` (text → a voice → speaker or WAV, with engine timings), `transcribe` (WAV → STT events with timings),
                    `compare-models` (WAVs → every installed local STT preset: transcript and timings)
```

## Testing

- `core` is tested entirely with the in-memory fakes from `@pva/core/testing` (scripted `Stt` events, scripted `Llm` events, a `Tts` that reads clauses eagerly, records when each arrived, and turns each into a marker chunk tagged with its clause index, a tone `Tts` at a chosen sample rate, a recording `AudioOutput`, a reporting `AudioOutput` that behaves like the browser, a scripted `AudioInput`) and `TestClock`.
- Serve mode is tested with a scripted client (`apps/assistant/test/support/scriptedClient.ts`: a Node `ws` client that speaks the protocol and simulates the browser's player) against the real server with injected providers, plus one live test with the local models. Gotcha: `TestClock.adjust` waits only one scheduler hop before advancing, so let freshly forked fibers run first (see `advance` in `Conversation.test.ts`). The Conversation table above — speculation, promotion, discard, barge-in, tool loop — each has a test.
- Adapters have unit tests for their protocol mapping against recorded/mock messages (a local mock WebSocket server), and an opt-in live test that runs only when the provider's API key is set.
- `pnpm check` (typecheck all), `pnpm test` (all unit tests) must pass before any change is considered done.
