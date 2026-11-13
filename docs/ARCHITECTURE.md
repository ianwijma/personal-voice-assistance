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
   clause chunker ──▶ Tts (voice router) ──pcm at the default voice's rate──▶ AudioOutput
```

Default providers: `Stt` = sherpa-onnx streaming transducer + Silero VAD (local), `Tts` = Piper via sherpa-onnx
(local, 22050 Hz), `Llm` = Anthropic (hosted; `fake` offline stand-in when no key is configured).

All audio is raw PCM, signed 16-bit little-endian, mono, carried as `Uint8Array` chunks of about 20 ms. Input is 16 kHz. Output rate is declared by the `Tts` service (Piper 22050 Hz, Kokoro and Cartesia 24 kHz); an engine cannot be asked for another rate, so a consumer that needs one resamples (`makeResampler`).

### Service interfaces (`packages/core`)

These are the contract. Adapters implement them; nothing outside an adapter may import a provider SDK.

```ts
// Audio
AudioInput:  { readonly stream: Stream<Uint8Array, AudioError> }
AudioOutput: { play(audio: Stream<Uint8Array, E>, sampleRate: number): Effect<void, E | AudioError> }
// `play` returns when the audio has finished playing. Interrupting the fiber
// must silence the speaker immediately (drop everything buffered).

// Speech to text, including turn detection
Stt: { transcribe(audio: Stream<Uint8Array, AudioError>): Stream<SttEvent, SttError> }
SttEvent =
  | { _tag: "SpeechStarted" }                    // user began talking (used for barge-in)
  | { _tag: "Interim"; text: string }
  | { _tag: "EagerEndOfTurn"; text: string }     // probably done — start the LLM speculatively
  | { _tag: "TurnResumed" }                      // not done after all — discard the speculative turn
  | { _tag: "EndOfTurn"; text: string }          // done — commit

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

History can contain consecutive messages that map to the same provider role (a `tool` message followed by the next `user` message, or a `user` message after a turn that produced no text); the LLM adapter merges them as its API requires.

**How `Conversation` calls `Tts`:** once per turn, with the stream of every clause of the turn (all rounds, including text spoken before a tool call), running ahead of playback. Each clause is handed over the moment the chunker emits it; nothing waits for the end of the LLM stream. The adapter must send each clause on as soon as it arrives, as one continuous synthesis (for Cartesia: one context with continuations), so later clauses synthesise while earlier ones play, with no gap and natural intonation across clauses. It tags every audio chunk with the 0-based index of the input clause it belongs to, and these indexes never decrease; `Conversation` uses them to know which clauses' audio actually started playing (needed for interrupted history). The clause stream carries no errors: if the LLM fails mid-turn, the stream just ends, the audio already synthesised is played, and then the turn fails.

Interrupting the consumer of any of these streams must cancel the underlying work (abort the HTTP request, cancel the TTS context, kill the player). Barge-in is implemented purely as fiber interruption, so this is a correctness requirement, not a nicety.

### Conversation (the orchestrator, in `core`)

One long-lived fiber consumes `SttEvent`s and owns at most one *turn fiber*.

API: `Conversation.voice(events)` runs the loop over an event stream (`runVoice` wires `AudioInput → Stt → voice` with `Tts`/`AudioOutput`); `Conversation.textTurn(text)` runs one turn as a stream of text deltas without any audio service, through the same LLM/tool-loop code; `Conversation.history` reads the history.

| Event | Action |
|---|---|
| `EagerEndOfTurn(text)` | Start a **speculative** turn: run LLM → clause chunker → TTS, buffering audio, but do not play and do not write history. |
| `TurnResumed` | Interrupt and discard the speculative turn. |
| `EndOfTurn(text)` | If a speculative turn exists for the same text, promote it: start playing the buffered audio and commit history. Otherwise start a normal turn. |
| `SpeechStarted` while a committed turn is running | Barge-in (if enabled): interrupt the turn fiber, whether or not its audio has started playing (so a stale reply never starts over the user). History records only the clauses whose audio actually started playing, marked as interrupted. A pending speculative turn is left alone: `TurnResumed` or `EndOfTurn` decides its fate. |
| `EagerEndOfTurn` / `EndOfTurn` while a committed turn is still running | With barge-in enabled, interrupt it (history as above) and start the new turn. With barge-in disabled, ignore the event (it is most likely the assistant's own voice). |

Details:
- "Same text" compares transcripts case-insensitively, ignoring punctuation and extra whitespace.
- A clause's audio "started playing" when its first chunk was handed to `AudioOutput` (`playbackStart` marks the first chunk of the turn). With barge-in disabled, `SpeechStarted` does nothing.
- If the event stream ends, a still-pending speculative turn is discarded and a committed one is allowed to finish.
- A turn that fails (provider error) is logged and committed like an interrupted one; the loop keeps running.

Speculative turns must not run tools with side effects. Each `Tool` declares `speculative: boolean` (default `false`); if a speculative turn reaches a non-speculative tool call it pauses there until promoted.

Tool loop: on `ToolCall`, look the tool up in the `ToolRegistry`, decode the input with the tool's `Schema`, run it (calls in the same response run concurrently), append results, call the LLM again. Cap at a configurable number of rounds (default 5): at most that many tool rounds and one more LLM call; if the model still asks for tools after that, the turn ends (the unanswered calls are not recorded). Tool failures, invalid input and unknown tools are returned to the model as error results, never thrown. Text the model produced before a tool call is flushed to TTS before the tools run (the text stream carries a `"\n"` between rounds), so "let me check" is heard while the tool works.

Clause chunker: buffers `TextDelta`s and emits at sentence or clause boundaries (`. ! ? ; :` and, once past a minimum length, `,`). The first clause is flushed aggressively (short minimum) so TTS starts as early as possible. Pure function over a stream, tested on its own.

### Voices: per-reply TTS selection (`VoiceRouter`, in `core`)

Different replies can use different TTS engines: an everyday answer is spoken by the fast default voice, a song or a story by a more expressive (possibly hosted) one. A **voice** is a name, a one-line description of what it is good for, and a `Tts` implementation. `makeVoiceRouter({ voices, defaultVoice })` wraps them in a plain `Tts`, so `Conversation` and everything downstream are unchanged.

- **Selection is a marker, not a tool call.** The model starts its reply with `[voice:NAME]` (no marker = default voice). A marker at the start of a later clause switches part-way; the choice lasts until the next marker or the end of the reply. A tool call would cost an extra model round trip on every such reply; a marker costs nothing. An unknown name falls back to the default voice with a warning. Markers are removed before text reaches any engine (one elsewhere in a clause is stripped and ignored).
- **Chunker.** `chunkClauses` never cuts inside a marker (`[voice: expressive]` contains `: `), and a leading marker does not count towards the comma minimum. The check only runs on text that starts with `[`, so an unmarked reply is chunked exactly as before.
- **Ordering.** Each run of consecutive clauses with the same voice is a *segment*: one continuous `synthesize` call on that engine, fed clause by clause as clauses arrive (prosody is kept within a segment). A segment's engine starts as soon as its first clause arrives, even while an earlier segment's audio is still being delivered; its audio is buffered and emitted only after every earlier segment has ended. So audio never overtakes, and `TtsAudio.clause` is the index in the router's input and never decreases (a marker-only clause gets an index but no audio). Two segments of the same voice never synthesise at once, so engines need not support concurrent calls. Interrupting the consumer interrupts every running engine.
- **Sample rates.** A reply plays at one rate: the router declares the default voice's `sampleRate` and resamples other voices on typed arrays (`makeResampler`: linear interpolation with state carried across chunks, plus a two-tap low-pass when downsampling). Cheap and fine for speech.
- **Prompt.** `voicePrompt(voices, defaultVoice)` (also `router.prompt`) is a deterministic block listing the voices, when to use each, and the marker syntax. The app appends it to the stable system prompt, never to the per-turn `context`, so prompt caching keeps working. With one voice it is empty and markers are just stripped.
- **History keeps markers.** The assistant message is stored as the model wrote it, markers included (interrupted turns keep the markers of the clauses that played). Seeing its own earlier `[voice:...]` usage in context helps the model keep using the syntax correctly and consistently, and the history stays exactly what the model generated. Markers are removed only for display: text mode pipes replies through `stripVoiceMarkersStream`, and voice mode prints `stripVoiceMarkers(content)`.
- **Tracing.** `Conversation` provides the turn's `Trace` as `CurrentTurnTrace` around `Tts.synthesize`; the router appends each voice it uses to `trace.voices`, shown as `voices: ...` in the latency line. The `Tts` interface is unchanged.
- **Measurements.** An optional `onSegment` callback receives per-segment engine timings (first audio, synthesis time, audio length); `say` uses it.

In the app, voices are declared in `apps/assistant/src/voices.ts` (name, description, provider = an entry of `ttsProviders`; omitted = whatever `TTS_PROVIDER` selects; optional default `settings`, e.g. the `natural` voice's `TTS_SHERPA_PRESET=kokoro-af_heart`) and enabled with `VOICES`; `DEFAULT_VOICE` picks the default. Each enabled voice is built as its own startup stage, so missing keys are reported together with the other missing settings, and a disabled voice is never initialised. A voice's provider settings are read with a `VOICE_<NAME>_` prefix first, then from the voice's declared `settings`, then unprefixed (an Effect `ConfigProvider` wrapper), so two voices can share a provider with different settings (`VOICE_STANDARD_TTS_SHERPA_PRESET=nl_NL-pim-medium`) and the API key is shared by default.

### Local adapters: worker thread and child processes

**`stt-sherpa`.** The recogniser and the VAD run in a `worker_threads` worker (plain `.mjs`, because workers inherit no TypeScript loader), since each decode blocks for tens of milliseconds. The main thread copies audio into one transferred buffer per batch and runs the pure `TurnDetector` state machine on the per-frame VAD decisions; it drops audio rather than queue it when the worker falls behind by more than 1 s. Turn detection is silence-based (`EagerEndOfTurn` after 250 ms, `EndOfTurn` after 600 ms by default), and the eager transcript is a real finalised decode, so the speculative turn is promoted whenever the user does not resume.

**`tts-sherpa`.** Each engine (one per enabled local voice) runs in its own forked child process, because Piper needs `sherpa-onnx-node` 1.x and Kokoro 2.x, and because killing a child mid-synthesis is safe while terminating a worker was not. Clauses are queued in the parent and sent one at a time; audio comes back over IPC as `Float32Array`, is trimmed to controlled pauses and chunked on typed arrays. A crash or a stuck clause fails the turn and restarts the process; the child exits when the parent's IPC channel closes, and ignores the terminal's Ctrl+C so the parent shuts it down in order.

Building either layer fails with `SttError` / `TtsError` (e.g. a missing model file, naming the download command); the app reports that like a missing setting, per startup stage.

### Latency tracing

Every turn records monotonic timestamps (`performance.now()`): `endOfTurn`, `llmRequestSent`, `llmFirstToken`, `firstClause`, `ttsFirstAudio`, `playbackStart`, plus per-tool durations and the voices used. The `TurnTrace` service logs one line per turn with the deltas and exposes the last N traces. Each mark is shown relative to `endOfTurn` (negative for work a promoted speculative turn did early) and relative to the previous mark; the line also carries the outcome (`completed`, `interrupted`, `discarded`, `failed`). Marking is a plain synchronous call so it can sit on hot paths. In text mode only the LLM marks apply. Any change that claims to improve latency is judged by these numbers. `bench` in the app prints them as per-turn tables with median and worst case: offline (scripted turns through the real `Conversation` with the `@pva/core/testing` fakes and simulated provider delays; the TTS stand-in sits behind a one-voice router, as in the app) or live (WAV files through the real providers).

Latency techniques that are required, not optional:
- Everything is loaded at startup: local models are loaded and warmed up when their layers are built; hosted STT/TTS WebSockets are opened at startup and kept warm (reconnect with backoff). The LLM HTTP client uses keep-alive.
- Prompt caching for the system prompt and tool list.
- LLM configured for speed: thinking disabled / lowest effort, small `max_tokens`, a system prompt that asks for short spoken-style answers.
- No per-sample Effects. DSP and buffering happen on typed arrays inside a service; Effect `Stream`/`Queue` carry chunks between stages.

## Extending the assistant

A capability is an `AssistantModule`:

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

Adding a feature = one new file exporting a module + one line in `apps/assistant/src/modules.ts`. Adding a provider = one new package implementing a core interface + one line in `apps/assistant/src/providers.ts`. Adding a voice = one entry in `apps/assistant/src/voices.ts` (its provider must be in `ttsProviders`) + its name in `VOICES`.

## Repository layout

```
packages/
  core/             interfaces, domain types, Conversation, tool loop, clause chunker, TurnTrace, voice router
                    (markers, resampler), in-memory fakes
  llm-anthropic/    Llm via @anthropic-ai/sdk (default model claude-haiku-5-5)
  stt-sherpa/       Stt on this machine: sherpa-onnx streaming transducer + Silero VAD in a worker thread, silence-based
                    turn detection (default; presets nemotron-3.5, zipformer-en, fast-conformer-en)
  tts-sherpa/       Tts on this machine: Piper / Kokoro via sherpa-onnx, one child process per engine (default)
  stt-deepgram/     Stt via Deepgram Flux (wss /v2/listen, eager end-of-turn) — hosted, optional
  tts-cartesia/     Tts via Cartesia Sonic WebSocket (contexts/continuations, raw pcm_s16le) — hosted, optional
  audio-pipewire/   AudioInput/AudioOutput by spawning pw-record / pw-cat
  audio-file/       AudioInput from a WAV/PCM file (paced in real time), AudioOutput to a WAV file — for tests and benchmarks on machines with no sound card
  modules-builtin/  first modules: clock (context + tool), weather (Open-Meteo HTTP lookup, speculative-safe)
models/             downloaded model files (git-ignored; `pnpm download-models`)
apps/
  assistant/        config (env, `.env`), providers.ts (one map per stage, chosen by `LLM_PROVIDER` / `STT_PROVIDER` /
                    `TTS_PROVIDER` / `AUDIO_BACKEND`; only the selected layers are built), voices.ts (`VOICES`,
                    `DEFAULT_VOICE`), modules.ts, main.ts; modes: `voice`, `text` (stdin/stdout, no audio), `bench`
                    (offline with simulated delays, `--live` over WAV files with the real providers, `--make-wavs`),
                    `say` (text → router → speaker or WAV, with engine timings), `transcribe` (WAV → STT events with timings)
```

## Testing

- `core` is tested entirely with the in-memory fakes from `@pva/core/testing` (scripted `Stt` events, scripted `Llm` events, a `Tts` that reads clauses eagerly, records when each arrived, and turns each into a marker chunk tagged with its clause index, a tone `Tts` at a chosen sample rate, a recording `AudioOutput`, a scripted `AudioInput`) and `TestClock`. Gotcha: `TestClock.adjust` waits only one scheduler hop before advancing, so let freshly forked fibers run first (see `advance` in `Conversation.test.ts`). The Conversation table above — speculation, promotion, discard, barge-in, tool loop — each has a test.
- Adapters have unit tests for their protocol mapping against recorded/mock messages (a local mock WebSocket server), and an opt-in live test that runs only when the provider's API key is set.
- `pnpm check` (typecheck all), `pnpm test` (all unit tests) must pass before any change is considered done.
