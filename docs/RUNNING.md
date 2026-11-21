# Running

## Quick reference

```sh
pnpm install
pnpm download-models          # default STT (Parakeet v2 + Silero VAD) and TTS (Piper en_US-lessac-medium), into models/ (or later from Settings)
# everything else is set in the web UI (pnpm serve → Settings); .env only for the few startup variables

echo "what's the time?" | pnpm start text      # text mode; works offline with the stand-in model
pnpm start say "Hello, I run on this machine."   # plays on the speaker (or add --out hello.wav)
pnpm start bench --make-wavs bench-audio       # synthesise five test questions with the local voice
pnpm start bench --live bench-audio            # local end-to-end benchmark (stand-in model, WAV output)
LLM_PROVIDER=anthropic pnpm start voice        # on a machine with a microphone: talk to it, Ctrl+C to quit
pnpm serve                                     # the web UI: the browser is the microphone and speaker (see [Web UI](#web-ui-serve-mode))
```

Optional models: `pnpm --filter @pva/tts-sherpa download kokoro-af_heart` (the Kokoro voice), `pnpm --filter @pva/tts-sherpa download nl_NL-pim-medium` (Dutch), `pnpm --filter @pva/stt-sherpa download-models parakeet-ultra whisper-turbo nemotron-560 hybrid-nemotron-parakeet` (other speech recognisers, see [Speech recognition models](CONFIGURATION.md#speech-recognition-models)).

Every mode runs through the app's `start` script. From the repository root, `pnpm start <mode>` is a shortcut for `pnpm --filter @pva/assistant start <mode>`. Relative paths on the command line are resolved from the directory you run the command in.

## Text mode

A stdin/stdout chat over the same conversation and tool code that voice mode uses, with the same system prompt (including the voice instructions). Replies go to stdout with any voice markers removed. One latency line per turn goes to stderr.

```sh
pnpm start text                               # interactive
echo "what's the time?" | pnpm start text     # one-shot, works offline
LLM_PROVIDER=anthropic pnpm start text        # real model
```

## Voice mode

```sh
LLM_PROVIDER=anthropic pnpm start voice
```

Voice mode listens on the default PipeWire source and speaks on the default sink until you press Ctrl+C. Startup loads the local models (about 2 s). Ctrl+C stops the engine processes and the audio processes and closes every socket. For each turn it prints what it heard and what it answered on stdout, and the latency line on stderr. These lines come from a run with the file backend and the offline stand-in model (a barge-in test: the second question interrupts the first reply):

```
you: After early nightfall, the yellow lamps would light up here and there the squalid quarter of the brothels
assistant: You said: [interrupted]
turn #1 voice (speculative) interrupted llmRequestSent=-232ms llmFirstToken=-231ms (+1ms) firstClause=-216ms (+15ms) ttsFirstAudio=-184ms (+32ms) playbackStart=0ms (+185ms) voices: standard total=461ms
you: Thanks that's all for now
assistant: You said: Thanks that's all for now
turn #2 voice (speculative) completed llmRequestSent=-256ms llmFirstToken=-256ms (+0ms) firstClause=-241ms (+15ms) ttsFirstAudio=-218ms (+23ms) playbackStart=0ms (+218ms) voices: standard total=1925ms
```

To use a file instead of a microphone, run `AUDIO_BACKEND=file AUDIO_INPUT_FILE=question.wav pnpm start voice`. The file must be 16 kHz WAV (16-bit or 32-bit float). Silence around it is a −75 dBFS noise floor, like a quiet microphone. Replies are written to `audio-out/reply-NNN.wav`, and the program exits after the last reply.

## Web UI (serve mode)

To run it from a container image (Kubernetes included), see [docs/DEPLOYMENT.md](DEPLOYMENT.md). Versioned images come from
releases: [docs/RELEASING.md](RELEASING.md).

```sh
pnpm serve     # builds the UI (apps/web/out), then starts the assistant serving it on http://127.0.0.1:8787
pnpm dev       # development: the assistant on :8787 and the UI with hot reload on http://localhost:3000
```

`pnpm serve` is `pnpm --filter @pva/web build`, then `pnpm --filter @pva/node bundle` (the [voice node](VOICE-NODE-SETUP.md) program; a failure there does not stop the server), then `pnpm start serve`; `pnpm start serve` alone serves the last build. In `pnpm dev` the page reloads as you edit `apps/web`; the assistant itself does not restart on changes (restart `pnpm dev` after server changes; the engines load in about 2 s), and the dev page connects to `ws://<page host>:8787/ws`. In both modes Ctrl+C stops everything: checked on the development machine, no Next, tsx or engine process is left (pnpm then prints `ELIFECYCLE Command failed`, which only reports the Ctrl+C).

One process on one port serves the UI and a WebSocket at `/ws`. The browser becomes the assistant's microphone and speaker: press **Start** on the page. Any number of tabs (at most 8) can be open; one owns the audio and the others see the conversation and play nothing ("Use this tab" moves the audio). Without a built UI the page says how to build it; the assistant runs anyway.

The admin page (`/admin/`) has **Assistants** (one page per assistant: Basics, Behaviour, Language model, Hearing, Voice, Modules, Used on; and a seven-step wizard for a new one), **Devices** (who answers where, wake phrases, interrupting, audio, captions, a phrase tester), **Shared settings** (Home, modules, language model accounts, speech recognition models, voice providers, routing, limits), Keys & vault, Diagnostics (Latency, with the assistant, device and route of each turn) and About. A module runs while an assistant has it on; a change applies from the next turn and a tool call in progress finishes. Saved values go to `data/settings.json`; secrets such as API keys go to the key vault ([CONFIGURATION.md](CONFIGURATION.md#keys--access); before you set a password, to `data/secrets.json` at mode 0600 as before). The browser can set or remove a secret but never read it. `PVA_DATA_DIR` moves the data directory. Environment variables and `.env` win over saved values and lock the field in the UI (with **Move to settings** for a `.env` line; see [CONFIGURATION.md](CONFIGURATION.md)). Settings marked *reload* take effect after **Reload engines**, which rebuilds the speech and language engines in about 2 s and keeps the conversation.

Settings: `SERVE_HOST` (default `127.0.0.1`), `SERVE_PORT` (8787), `SERVE_ALLOWED_ORIGINS` (other page origins allowed to open the socket; default the Next dev server on port 3000), `SERVE_ALLOWED_HOSTS` (host names the server answers to besides IP addresses, `localhost` and the origins' hosts; any other name gets HTTP 403, against DNS rebinding), `SERVE_BEHIND_PROXY` (default `false`; `true` when a reverse proxy is in front, see below), `SERVE_TLS_CERT` + `SERVE_TLS_KEY` (PEM files; with both, the server speaks HTTPS/WSS on the same port), `SERVE_CROSS_ORIGIN_ISOLATION` (default `true`: COOP/COEP/CORP headers make the page cross-origin isolated, so it reads how much of a reply played straight from the player; they are left off while an enabled module's page loads other origins' players, such as the media module, with no setting to change), `PVA_WEB_DIR` (default `apps/web/out`), `PVA_DATA_DIR` (default `data/`), `PVA_VAULT_PATH`, `PVA_VAULT_PASSWORD` ([CONFIGURATION.md](CONFIGURATION.md#keys--access)). Ctrl+C closes the sockets, the engine processes and the modules.

**If the page does not load (or Start fails) on a particular browser**, restart the assistant with `SERVE_CROSS_ORIGIN_ISOLATION=false` (in `.env` or the service's environment) and reload the page. If that fixes it, cross-origin isolation is the cause: the page works without it, with a slightly less exact count of what was heard when it is closed in the middle of a reply. Tested in Chromium only; not yet on iPhone Safari. Isolation also ends by itself, from the next page load, while a module that declares `page.thirdPartyEmbeds` is enabled in the admin UI ([MODULES.md](MODULES.md#the-page-pagethirdpartyembeds)); HTML pages always carry `Referrer-Policy: strict-origin-when-cross-origin`.

Keys, the vault, admin access and reaching the page from another device: [CONFIGURATION.md](CONFIGURATION.md#keys--access).

**Testing it without a browser.** A scripted client speaks a WAV into a running server and prints the message timeline and each turn's latency trace:

```sh
LLM_PROVIDER=fake SERVE_PORT=8799 pnpm start serve &
pnpm --filter @pva/assistant exec tsx test/support/drive.ts --url http://127.0.0.1:8799 bench-audio/01-hello-can-you-hear-me.wav
```

Observed on the development machine (2026-11-13, local STT nemotron-3.5, Piper, fake LLM, scripted client on the same machine): the speculative reply was promoted and the client reported `playback.started` 2–4 ms after `EndOfTurn` in four turns; from the end of the speech audio to `turn.start` and `playback.started` 635 and 657 ms in the two turns where that was timed (the 600 ms final silence dominates, as in the CLI). The trace's `playbackStart` includes the WebSocket hop and the browser's report; `audible` adds the browser's `outputLatency`. For the real browser see [Through the browser](LATENCY.md#through-the-browser).

**Testing it with the real page.** `pnpm e2e:real` builds the UI and runs the page in headless Chromium against the real assistant (local speech models, `LLM_PROVIDER=fake`), with Chromium's fake microphone playing 48 kHz WAVs made from `bench-audio/`: a spoken turn, barge-in in `instant` and `confirm` mode, `manual` mode, a typed message, Stop, two pages with a takeover in the middle of a reply, the server killed and restarted in the middle of a reply, and modules changed from the options drawer (11 tests, about 1.5 minutes; each test file starts its own assistant on its own port, 8791–8798, with its data under `apps/web/test-results/real/`). It builds the UI into `apps/web/out-e2e/`, never over `apps/web/out/`, so an assistant already serving `out/` is not disturbed. One test checks that the page is cross-origin isolated as configured, that the worklets load and use the shared counter, and that Stop gives an exact final count; run it once more with `SERVE_CROSS_ORIGIN_ISOLATION=false pnpm e2e:real` to check the page without isolation. It skips when the models, `bench-audio/` or Chromium are missing (`pnpm start bench --make-wavs bench-audio`, `pnpm --filter @pva/web e2e:install`). `pnpm bench:browser` measures latency through the browser ([LATENCY.md](LATENCY.md#through-the-browser)); `pnpm --filter @pva/web screenshots:real` rewrites `apps/web/screenshots/real-*.png`. The assistant's output and each page's message log are kept under `apps/web/test-results/real/`.

## On a phone (iPhone Safari or Brave)

The page works on iOS (Safari, and Brave, which uses the same WebKit engine) over HTTPS. Settings → **This
device** has settings that matter more on a phone than elsewhere, stored per device:

- **Microphone processing**: echo cancellation, noise suppression and automatic gain, each switchable
  (changing one re-opens the microphone). On iOS, echo cancellation switches on Apple's voice processing,
  which also changes the level and sound of your voice and, on iOS 26.2 and later, can make playback crackle
  ([WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286), open). Without it the assistant hears
  its own voice on the loudspeaker: use headphones, or set *Interrupting* to *Tap Stop*.
- **Audio diagnostics**: the microphone's real sample rate and processing flags as the browser reports
  them, and playback counters (underruns, gaps, clicks smoothed, the lowest buffer level). **Copy report**
  puts them on the clipboard.
- **Advanced → Prebuffer** (up to 500 ms) and **Output path** (*Direct* or *Through a media element*).

If the assistant mishears you or playback pops, see [Is it the audio or the model?](#is-it-the-audio-or-the-model)
and [Popping in playback](#popping-in-playback).

## Is it the audio or the model?

To find out why a sentence was misheard:

1. Settings → Diagnostics → Recordings → **Save what the assistant hears** (on). From then on every turn's audio,
   exactly as the server received it (before its gain control), is saved in `data/recordings/` as a WAV file
   with a `.json` beside it (the transcript, the model, levels, band and transport counters); the newest 50
   are kept (*Recordings kept*, advanced). The server log gets one line per turn, for example:

   ```
   Heard (sherpa parakeet-v2): "What's the weather in Amsterdam?" — peak -31.2 dBFS, speech -45.0 dBFS RMS, floor -71.3 dBFS,
   SNR 26.3 dB, clipped 0 %, band to ~7.6 kHz (4.1 % above 3.4 kHz); quiet (peak below -18 dBFS) — data/recordings/2026-…-001.wav
   ```
2. Speak a few sentences from the phone, then turn it off again.
3. Run every installed model on those recordings (one model loaded at a time, about a minute for a few files):

   ```sh
   pnpm start compare-models data/recordings                    # every installed preset
   pnpm start compare-models --ref "The birch canoe slid on the smooth planks." data/recordings/<file>.wav
   pnpm start compare-models --agc both --models parakeet-v2,nemotron-320 data/recordings
   ```

   It prints each file's levels and, per model, the transcript, how many turns it became and when the
   speculative and final texts came after the speech; with `--ref`, the word error rate.

How to read it: *too quiet* (peak below −30 dBFS) or *noisy* → the audio; switch the phone's processing
switches and record again. *Narrowband* (energy ends near 3–4 kHz) → a Bluetooth headset or phone-call
audio path; use the phone's own microphone. Only one model wrong → the model. A sentence split into
several turns → pauses longer than *Pause that ends your turn*. Non-zero `droppedFrames`, `lostOnTheWay` or
long `maxMicGapMs` in the `.json` → frames lost or delayed on the network.

## Popping in playback

Reported from an iPhone; it cannot be reproduced here (no sound card, no iPhone). What was found in the
code and fixed (player worklet, `apps/web/worklets/player.js`, tested in `apps/web/test/worklets/player.test.ts`
at 48, 44.1 and 24 kHz):

- **An underrun jumped to silence and back.** When reply audio arrived late (the 60 ms prebuffer ran dry, as
  happens when Wi-Fi delivers packets in bursts), the output dropped from the current sample to zero within
  one sample, and jumped back when audio resumed: two clicks per underrun. Now every edge (a dry queue,
  resuming, the start of a reply, the end, one reply cutting off another) is bridged by a 3 ms de-click
  ramp, so a gap sounds like a gap.
- **A reply that replaced another one was cut hard**, and the first sample of a reply was played at full
  level: both are ramped now.
- **Repeated underruns kept refilling only 40 ms**, so a slow link stuttered on. Each underrun in a reply
  now doubles the refill target (40, 80, 160, 320 ms).
- Checked and fine: the 22 050 → 48 000 / 44 100 / 24 000 Hz resampling is continuous across frame and
  clause boundaries (bit-identical to resampling the whole reply at once), and fades on Stop were already
  ramped.

Remaining hypotheses, most likely first, and what to try (Settings → This device):

1. **iOS voice processing crackle** ([WebKit bug 326286](https://bugs.webkit.org/show_bug.cgi?id=326286):
   output crackles while a microphone with echo cancellation is open, iOS 26.2–27; open, no fix). Turn
   **Echo cancellation** off (with headphones, or *Interrupting: Tap Stop* on the loudspeaker). If the pops
   stop, this is it. Users report that output may then move to the earpiece at a lower volume.
2. **Late audio (underruns).** If *Audio diagnostics* shows underruns, raise **Prebuffer** to 200–300 ms.
   Each underrun is now a short, soft gap instead of a pop.
3. **The output path.** Switch **Output path** to *Through a media element* and compare (an older WebKit
   workaround for output problems while the microphone is open; [bug 218012](https://bugs.webkit.org/show_bug.cgi?id=218012)).
4. **Sample-rate switching when the microphone opens** (iOS changes its audio session when capture starts;
   [bug 236219](https://bugs.webkit.org/show_bug.cgi?id=236219), [bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451)).
   Compare the reported microphone sample rate with the audio context's in *Audio diagnostics*; try
   headphones.

Report back: **Copy report** in *Audio diagnostics* after a few replies, with echo cancellation on and off.

## Trying a voice or an STT provider: `say` and `transcribe`

Two quick-test commands try an engine without a conversation. Both stop with the startup message ([CONFIGURATION.md](CONFIGURATION.md)) if a key or a model is missing.

```sh
pnpm start say "Hello, this is the assistant's voice."           # plays on AUDIO_BACKEND
pnpm start say --voice sherpa:kokoro-af_heart "Once upon a time." # another voice, for this run (provider:voice)
pnpm start say --out hello.wav "Write it to a file instead."
pnpm start transcribe models/test-wavs/0.wav                     # 16 kHz WAV
```

`say` sends the text through the same clause chunker as a conversation, then prints the time from its first clause to its first audio, the total synthesis time, the length of the audio, and the real-time factor (synthesis time ÷ audio length; below 1 is faster than real time). Measured before voice providers (2026-11-14, Piper and Kokoro):

```
standard: first audio 74 ms, synthesis 75 ms, audio 1.63 s, real-time factor 0.05 (1 clauses)
natural: first audio 498 ms, synthesis 505 ms, audio 3.04 s, real-time factor 0.17 (1 clauses)
```

(Measured on the development machine: Piper, then a 14-word Kokoro clause. A 9-word sentence alone takes Kokoro about 275 ms to first audio, Piper about 70 ms.) `transcribe` streams the file in real time through `STT_PROVIDER`, then silence until an end of turn arrives (at most `AUDIO_INPUT_TRAILING_SILENCE_MS`). It prints every event with its time since the start and relative to the end of the speech audio (negative = before the audio ended), for example, with the local STT on `models/test-wavs/0.wav` (the clip ends with about 0.4 s of quiet, so the eager end of turn comes before the file ends):

```
+  562 ms  audio end - 6063 ms  SpeechStarted
+ 6584 ms  audio end -   41 ms  EagerEndOfTurn "After early nightfall, the yellow lamps would light up here and there the squalid quarter of the brothels"
+ 6821 ms  audio end +  196 ms  EndOfTurn "After early nightfall, the yellow lamps would light up here and there the squalid quarter of the brothels"
```

## Reading the latency line

Each mark is in milliseconds relative to **end of turn**, the moment the STT decided you had finished. The value in brackets is the time since the previous mark.

| Mark | Meaning |
|---|---|
| `llmRequestSent` | the request to the model left |
| `llmFirstToken` | the first word of text came back (after any tool round) |
| `firstClause` | the clause chunker handed the first clause to TTS |
| `ttsFirstAudio` | the first audio chunk came back from TTS |
| `playbackStart` | the first audio chunk went to the speaker: **the headline number** |
| `tools:` | how long each tool call took |
| `voices:` | the voices that spoke in this turn (voice mode) |
| `total` | when the turn ended (reply finished, or interrupted) |

**Negative values** mean the work happened before the end of turn. This is a speculative turn (started on `EagerEndOfTurn`) that was then confirmed. The outcome is `completed`, `interrupted` (barge-in), `discarded` (a speculative turn you talked over) or `failed` (provider error; the conversation keeps running).

The end-of-turn mark does not include the time the STT took to decide you had stopped talking. The live benchmark measures that separately (its `eager` and `eot` columns, from the end of the audio).

## Benchmarks

**Offline (no keys, runs anywhere):**

```sh
pnpm start bench
```

This runs a scripted four-turn conversation through the real `Conversation` orchestrator. STT, LLM, TTS and the speaker are replaced by in-process stand-ins with simulated delays. One turn uses a tool, and one has a false start where the user keeps talking after an eager end of turn. It runs three scenarios and prints a per-turn table plus median and worst case for each:

1. **All delays zero:** the overhead the orchestration itself adds between end of turn and first audio.
2. **Realistic delays, eager end-of-turn off:** LLM first token 250 ms, then 60 tokens/s; TTS first audio 150 ms.
3. **The same with eager end-of-turn on:** `EagerEndOfTurn` arrives 200 ms before `EndOfTurn`. This shows what speculative turns save.

The delays can be changed with the `BENCH_*` variables in `.env.example`. Results on the development machine (median / worst): overhead **0.8 / 1.6 ms** (measured with the voice router, which has since been removed); realistic without speculation **508 / 735 ms**; with speculation **307 / 535 ms**. The worst case is the tool turn, which needs two model calls.

**Live (the real pipeline):**

```sh
pnpm start bench --make-wavs bench-audio                   # five test questions, synthesised with the configured TTS, resampled to 16 kHz
pnpm start bench --live bench-audio                        # local STT + local TTS + the fake LLM (simulated 250 ms first token, 60 tok/s)
BENCH_LLM_FIRST_TOKEN_MS=300 pnpm start bench --live --rounds 4 bench-audio   # stand in for a 300 ms hosted model, 20 turns
LLM_PROVIDER=anthropic pnpm start bench --live bench-audio # the real model
```

`--live` takes WAV files and/or directories of them (16 kHz mono, 16-bit or 32-bit float); `--rounds N` repeats them. It plays each file as one user turn into the selected STT, LLM and TTS, all in one conversation, with the file audio backend. After each file it feeds silence (a −75 dBFS noise floor) until the reply has finished, so the turn detector fires and turns never overlap. Replies are saved to `bench-out/reply-NNN.wav` for listening. With `LLM_PROVIDER=fake`, the stand-in model waits `BENCH_LLM_FIRST_TOKEN_MS` before its first token (or tool call) and then streams at `BENCH_LLM_TOKENS_PER_S`, so a fully local run shows what a hosted model of that speed would give.

Every column is measured from the end of the file's audio: `eager` (STT `EagerEndOfTurn`: the speculative reply starts), `eot` (`EndOfTurn`: the reply may play), `1st token`, `1st clause` (handed to TTS), `tts audio` (its first audio) and `PLAY` (first audio handed to the speaker: what the user experiences). Under the table it prints what the STT heard for each file, and how often the user "resumed" (a pause long enough for an eager end of turn).