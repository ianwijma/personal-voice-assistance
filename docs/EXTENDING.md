# Extending: modules and providers

The contracts are in [ARCHITECTURE.md](ARCHITECTURE.md); writing a module in full is [MODULES.md](MODULES.md).

## Adding a module

A module is a named capability the owner can switch on and off and configure. While it runs it contributes tools (things the model can call), context providers (short facts sent with every turn in the request's `context` field, separate from the cached system prompt), optional stable instructions for the system prompt, and a one-line status shown in the UI. [`packages/modules-builtin/src/weather.ts`](../packages/modules-builtin/src/weather.ts) is the example of a new way to fetch information: it calls Open-Meteo over HTTP, has a timeout setting, returns a compact result the model can speak from, and turns every failure into a `ToolError`. [`clock.ts`](../packages/modules-builtin/src/clock.ts) shows a context provider.

1. Write a file exporting `defineModule({ id, name, description, settings, start })`. Settings are declared with `Setting.text`, `secret`, `number`, `boolean`, `choice` and `multichoice` (optionally with `env: "NAME"`, so an environment variable can set and lock the field); the UI renders the form from them. `start` receives the validated settings and `setStatus`, runs in its own scope (acquire timers and sockets with `Effect.acquireRelease`), and returns `{ tools, context, instructions }`. Check credentials in `start`, so a bad key shows as a start error on the module rather than as a failing tool mid-conversation.
2. Define tools with `makeTool({ name, description, parameters, speculative, execute })`. `parameters` is an Effect `Schema`: it validates the model's input and produces the JSON Schema the model sees. Set `speculative: true` only for read-only tools; speculative turns run them before the user has finished. Give network tools a short timeout, because the user is waiting.
3. Return failures as `ToolError`. The model receives the message and can explain the problem.
4. Add the module to `moduleCatalog` in [`apps/assistant/src/modules.ts`](../apps/assistant/src/modules.ts). The order there is the display order and the order of instructions in the prompt. Every mode uses the catalog: `serve` with live changes, the CLI modes with the saved settings.
5. Test it without the host: `resolveSettings(module.settings, { stored, secrets: {}, env: {} })`, then `Effect.scoped(module.start({ settings, setStatus }))`, then call its tools through `makeToolRegistry`. See `packages/modules-builtin/test/weather.test.ts`, which injects a fake `fetch`.

## Adding or swapping a provider

Each pipeline stage is a service interface in `packages/core` (`Llm`, `Stt`, `Tts`, `AudioInput`, `AudioOutput`; see the architecture document for the exact contracts). To add a provider:

1. Create a package (e.g. `packages/tts-elevenlabs`) that implements the interface and exports a layer reading its settings from the environment. Provider SDKs may only be imported inside their own package.
2. Add it as a dependency of `apps/assistant` and add one line to the matching map in [`apps/assistant/src/providers.ts`](../apps/assistant/src/providers.ts), for example `elevenlabs: ElevenLabsTts.layerConfig`. A layer may fail at build time with the stage's error (`TtsError`, `SttError`, e.g. a missing model); its message is shown at startup, so make it say how to fix the problem.
3. For a voice provider, also add its entry to `ttsProviderInfo` and its voice list (`makeVoices`) to `hostedTtsVoices` (see [CONFIGURATION.md](CONFIGURATION.md#voices)); then choose one of its voices. Add its variables to `.env.example`, and compare it with the old provider using `say` and `bench --live` on the same WAV files. For a new STT provider, `transcribe` shows its event timing on a WAV file.

## Repository layout

```
apps/assistant                  the app: providers.ts, voiceSelection.ts, modules.ts, serve/ (assistants, devices, resource pool, session dispatcher); modes text, voice, serve, bench, say, transcribe
apps/web                        the web UI (Next.js static export), served by serve mode
apps/node                       the voice node: a headless microphone-and-speaker client for a box in a room
packages/core                   service interfaces, Conversation, tool registry, clause chunker, TurnTrace, voice references, route gate, module host, test fakes
packages/protocol               the browser/node ↔ assistant protocol (version 12): message schemas, binary frames, assistants, devices and their settings
packages/llm-anthropic          Llm via @anthropic-ai/sdk
packages/llm-openai-compatible  OpenRouter and home model servers (OpenAI-compatible API)
packages/agent-claude-code      the claude-subscription agent (Claude Code with the owner's login), off by default with an opt-in
packages/agent-intent           typed intents after "hey Jev"
packages/decide-typesafe        TypeSafe client (routing a sentence to an assistant; the intent decider)
packages/stt-sherpa             Stt on this machine: sherpa-onnx (Parakeet, Whisper, Nemotron, hybrid) + Silero VAD + gain control, turn detection (default)
packages/stt-deepgram           Stt via Deepgram Flux (hosted, optional)
packages/tts-sherpa             Tts on this machine: Piper / Kokoro via sherpa-onnx, one child process per engine (default)
packages/tts-cartesia           Tts via Cartesia Sonic (hosted, optional)
packages/tts-elevenlabs         Tts via the ElevenLabs multi-context WebSocket (hosted, optional)
packages/kws-sherpa             keyword spotter spike for the voice node (not used by the app yet)
packages/audio-pipewire         microphone/speaker via pw-record / pw-cat
packages/audio-alsa             microphone/speaker via arecord / aplay (headless boxes)
packages/audio-web              the browser as microphone and speaker (serve mode), over an abstract link
packages/audio-file             WAV in / WAV out (tests, benchmarks)
packages/store-sqlite           the modules' data store
packages/net                    outgoing HTTP for model- or user-chosen URLs and public APIs
packages/language               English and Dutch helpers the modules share (times, amounts, recurrences)
packages/module-contracts       the contracts modules share, and the module test kit
packages/modules-builtin        clock, weather
packages/module-*               one package per module family (see docs/modules/)
models/                         downloaded models (git-ignored; pnpm download-models)
```
