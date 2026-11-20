# What has been verified

| Part | How it was tested |
|---|---|
| Conversation, tool loop, chunker, tracing | unit tests with scripted fakes |
| Local STT and TTS adapters | unit tests, plus real-model tests and measurements (see their READMEs) |
| **Local end to end** (`bench --live` with sherpa STT, Piper TTS, the file audio backend and `LLM_PROVIDER=fake`) | run on the development machine, 2026-11-13: 20-turn runs per configuration, transcripts checked, every speculative turn promoted, reply WAVs checked (22050 Hz, plausible length, about −4 dBFS peak). Numbers in [Measured latency](LATENCY.md) |
| Barge-in with files (voice mode, file backend) | a second question started while a long reply was playing: the reply stopped and history kept only the played part. The file backend cannot hear the assistant, so this tests the logic, **not echo handling** |
| `say` | run with Piper, with Kokoro, and with both in one reply (markers), to WAV files; against local stand-ins for Cartesia and ElevenLabs; never against the real services |
| `transcribe` | run with the local STT on the test clips (English and Dutch); never against Deepgram |
| Startup and shutdown with two local voices | model-missing messages checked; Ctrl+C (SIGINT to the whole process group) and a killed parent leave no engine processes |
| Text mode with `LLM_PROVIDER=fake`, offline benchmark | run end to end on the development machine |
| Anthropic, Deepgram, Cartesia, ElevenLabs adapters | unit tests against mock servers and recorded messages; opt-in live tests exist but have **not** been run (no keys) |
| PipeWire backend | unit tests with stand-in processes; in voice mode `pw-record` started and delivered audio to a stand-in STT server on the development machine, which has no sound card (so that audio was not a real microphone signal) |
| Weather module | unit tests with an injected `fetch`; never called against the real Open-Meteo API from the tests |
| **Serve mode** (WebSocket protocol, ownership, modules and settings from the UI, engine reload, echo gate) | unit tests (module host, echo gate, web audio backend, conversation events) and scripted-client tests against the real server with injected providers; a live test with the local models; run by hand on the development machine with a scripted client streaming `bench-audio` WAVs into `LLM_PROVIDER=fake pnpm start serve`: real recognition, Piper reply audio over the socket, an engine reload with the local models (1.8 s, conversation kept, no engine process left behind), and Ctrl+C leaving no processes |
| **Key vault, admin access, Claude subscription as the language model** (2026-11-14) | vault unit tests (round trip, wrong password, tampering, change password, file modes, legacy import, rate limit with an injected clock, unlock time with the real parameters); scripted-client tests against the real server (protected changes refused per connection, unlock reloads failed engines, restart starts locked, `PVA_VAULT_PASSWORD`); the agent conversation with the scripted Agent SDK fake (module off → stand-in with notice, on → Claude, no reload); Playwright against the mock (set password → lock → unlock → change → lock → refused; second page; banner unlock). Text mode with `LLM_PROVIDER=claude-subscription` and the module off, by hand. **Not** run against a real subscription in this work (the adapter's own live test passed earlier on the owner's Max plan), and never with the real UI against the real server |
| **Speech recognition presets, gain control, diagnostics** (2026-11-14) | real-model tests for Parakeet v2 (whole turn, quiet input, steady noise), the hybrid, Whisper (Dutch), Nemotron 560; measurements on the degraded set and false-trigger runs (stt-sherpa README); `pnpm e2e:real` with Parakeet v2 as the default (10/10, including "say a few words" barge-in through Parakeet's interim words and the This-device diagnostics); by hand with the scripted client on a second server: switching the model from the settings (`settings.update` + `engine.reload`, 1.9 s) to Nemotron 560 and back, the next turn recognised by the new model each time, "Save what the assistant hears" writing WAV + JSON and the log line, then `compare-models` on those files (8 presets, 2 files, 1 min 39 s). Not on a real phone. |
| **Web UI against the real assistant** (`pnpm e2e:real`, 10 tests; 2026-11-13) | the built page in headless Chromium (no sound card), fake microphone fed from WAVs, real `serve` with the local models and the fake LLM: visual states of a spoken turn in order, transcript and reply in the chat, latency readout; the player worklet really runs (`playback.started`, progress every 250 ms, `finished`); barge-in in `instant` and `confirm` mode with history holding only the clauses that played; `manual` mode ignoring speech over the reply; typed message with a spoken reply; Stop (no stall error, history cut); two pages and a takeover in the middle of a reply; server killed (SIGKILL and SIGINT) in the middle of a reply, then restarted: the page reconnects and gets the audio back without a new Start; a module setting the server rejects, a reconfiguration and disabling/enabling seen in a second page and used on the next turn. Also by hand: the `pnpm dev` page against the real server, and Ctrl+C in `pnpm serve` and `pnpm dev` leaving no processes. Latency through the browser: [Through the browser](LATENCY.md#through-the-browser) |

**Not verified:**

- No real microphone or speaker, ever: the development machine has no sound card. All speech input was clean synthetic (Piper) or read (LibriSpeech/FLEURS) speech from WAV files, with no room noise, no far-field audio and no echo. Microphone gain matters for the VAD (see the stt-sherpa README).
- Nobody has listened to the output. The WAVs in `bench-out/` (gitignored, regenerate with `say --out` and `bench --live`) are there to listen to.
- No real language model: latency with Anthropic is extrapolated from the simulated 300 ms first token, not measured.
- Echo cancellation and barge-in over open speakers: the headless browser never hears its own output, so `confirm` mode was tested only with a second sentence in the input file, not with real echo (PipeWire echo-cancel snippet untested too). Whether a real browser cancels the assistant's voice (Options → This device → Test echo, with both output paths) is unknown.
- The web UI on a real device: a laptop through the SSH tunnel, a phone over HTTPS with a real certificate, real `outputLatency`, Bluetooth, speaker selection, Safari and Firefox. Nobody has listened to the browser's playback.
- Deepgram, Cartesia and ElevenLabs have never been called for real.
- Thread counts were tuned on one 16-thread machine; a 4-core machine will behave differently.

The opt-in live adapter tests run when the keys are present in the shell environment (the test runner does not read `.env`):

```sh
ANTHROPIC_API_KEY=... CARTESIA_API_KEY=... ELEVENLABS_API_KEY=... DEEPGRAM_API_KEY=... DEEPGRAM_TEST_AUDIO=question.wav pnpm test
PVA_PIPEWIRE_LIVE=1 pnpm --filter @pva/audio-pipewire test
```
