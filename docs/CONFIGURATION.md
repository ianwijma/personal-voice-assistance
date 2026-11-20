# Configuration

How the assistant is configured: the Settings pages, the few startup variables, speech recognition models, keys and access, voices and echo cancellation. Running it: [RUNNING.md](RUNNING.md).

**Configure everything under Settings in the web UI** (`pnpm serve`, then the gear or `O`). Values are saved in
`data/settings.json`, keys in an encrypted key vault outside the project (see [Keys & access](#keys--access)). Every
page says what a choice implies (hosted, needs a key, not downloaded, slower start) and what it needs, and a speech
model that is not on this machine yet is downloaded from the same page. The command-line modes (`text`, `voice`,
`say`, `bench`, `transcribe`) read the same saved settings and keys; they use the shared settings and the flat keys (`LLM_PROVIDER`, `ANTHROPIC_MODEL`, `STT_SHERPA_MODEL`, `ASSISTANT_VOICE`, …) that became per-assistant settings in serve mode (a data directory from before assistants is migrated into one assistant at the first start of `serve`, and a copy of the old file is kept).

| What | Where in Settings |
|---|---|
| An assistant: prompt, tool rounds, follow-up, new conversation after a quiet spell | Assistants › the assistant › Behaviour |
| Language model: offline stand-in, Claude API (key), Claude subscription, OpenRouter, a home model server; model, effort, limits | Assistants › the assistant › Language model; the accounts under Shared settings › Language model accounts |
| Speech recognition: on this machine (model, language, turn timing, microphone processing) or Deepgram | Assistants › the assistant › Hearing; Deepgram key and the model list under Shared settings › Speech recognition models |
| Speech and voice models: download, cancel, delete | Shared settings › Speech recognition models, Voice providers |
| The assistant's voice (any provider's voice, preview, favourites) and the Cartesia and ElevenLabs keys | Assistants › the assistant › Voice; Shared settings › Voice providers |
| Modules (clock, weather, Home Assistant, …): which assistant has which, their shared and own settings | Assistants › the assistant › Modules; Shared settings › Modules |
| Which assistants answer on which device, wake phrases, who answers without a phrase | Devices (a device, or "Every browser") |
| Location, time zone, language, units (the modules' defaults) | Shared settings › Home |
| TypeSafe routing (key, model) | Shared settings › Routing |
| Keys, the vault password, who may change what | Keys & vault |
| What `.env` or the environment still sets, and **Move to settings** | Diagnostics › Settings from outside |

**`.env` holds almost nothing.** Only these are read before the settings exist ([`.env.example`](../.env.example)), all
optional:

| Variable | Default | What |
|---|---|---|
| `PVA_ADMIN_PASSWORD` | unset | the admin page's password (`/admin/`, at least 8 characters). Unset or shorter: admin is disabled and nothing can be configured from a browser |
| `PVA_VAULT_PASSWORD` | unset | unlocks the key vault at start (otherwise unlock it in the UI after each restart) |
| `PVA_DATA_DIR` | `<repo>/data` | where the settings are |
| `SERVE_HOST`, `SERVE_PORT` | `127.0.0.1`, `8787` | where the UI listens (anything but loopback exposes it to your network) |
| `SERVE_TLS_CERT`, `SERVE_TLS_KEY` | unset | both set: HTTPS (the microphone needs it off localhost) |

Anything else in `.env` or exported by the shell still works and wins over the saved settings (environment > saved >
default), and the field shows where it comes from ("Set by STT_SHERPA_AGC in /…/.env, line 3"). For a variable from
`.env`, **Move to settings** (on the field, or Diagnostics › Settings from outside, also *Move all*) saves the value
(a key into the vault; refused while the vault is locked) and comments its line out of the file, keeping a backup
next to it (`.env.bak-<time>`, mode 0600) and the file's mode; the value is never logged or sent to a page. That page
also lists variables nothing reads (often a typo).

The command-line modes unlock the vault with `PVA_VAULT_PASSWORD`, or ask for the password when run in a terminal
(Enter skips it; providers that need a key then fail and say the vault is locked).

**For development** (read from the environment only, not shown in the UI): `AUDIO_BACKEND` (`pipewire` | `file`),
`AUDIO_INPUT_FILE`, `AUDIO_INPUT_TRAILING_SILENCE_MS`, `AUDIO_OUTPUT_DIR`, `PIPEWIRE_*` (CLI audio), `BARGE_IN`,
`BENCH_*` (benchmarks; `BENCH_LLM_FIRST_TOKEN_MS` / `BENCH_LLM_TOKENS_PER_S` also give the offline stand-in a
simulated speed in serve mode), `SERVE_ALLOWED_ORIGINS`, `PVA_WEB_DIR`, `PVA_VAULT_PATH`, `DEEPGRAM_URL`,
`CARTESIA_URL`, `ELEVENLABS_URL`, and the web mock's `MOCK_*` / `E2E_MOCK_PORT`. The adapter READMEs list every provider setting by
its variable name ([stt-sherpa](../packages/stt-sherpa/README.md), [tts-sherpa](../packages/tts-sherpa/README.md), [tts-elevenlabs](../packages/tts-elevenlabs/README.md)), which is
also the key it is saved under.

`fake` is an offline LLM stand-in: it answers time questions through the clock tool and echoes everything else. It is the default so that text mode works without any key. **For real use choose Anthropic (with an API key) or the Claude subscription** as the account on an assistant's Language model tab (Assistants › the assistant). The accounts themselves are set up once, under Shared settings › Language model accounts (the Anthropic key there; for the Claude subscription, see below).

**Claude subscription** (`claude-subscription`): the language model is Claude Code with the login of the `claude` program on this machine, so replies count against your Claude plan's limits instead of an API bill ([`@pva/agent-claude-code`](../packages/agent-claude-code/README.md)). Anthropic's terms for using a subscription from other software are unclear, so the *Claude subscription* module is off by default and has its own opt-in switch. Under Shared settings › Language model accounts, switch on *Use my Claude subscription* in the *Claude subscription* block and save, then switch the module on there (it refuses to start without the opt-in); then choose *Claude subscription* as the account on an assistant's Language model tab. It takes effect from the next turn, no reload. While the module is off, starting or failed, the offline stand-in answers and first says so ("Claude subscription is off — switch it on in Settings, Language model."). Claude Code gets only a short allowlist of environment variables (`PATH`, `HOME`, locale, proxy and CA settings, `CLAUDE_CONFIG_DIR`, …), never other providers' keys or the vault password.

If a required setting or a model file is missing, a command-line mode lists every problem, with the stage it belongs to and how to fix it, and exits (serve mode shows the same problems in the admin Overview and keeps running):

```
Cannot start (settings go in the environment or in .env; see .env.example):
  voice (ASSISTANT_VOICE): Model file for TTS preset "en_US-lessac-medium" is missing: /…/models/vits-piper-en_US-lessac-medium/en_US-lessac-medium.onnx. Download it from an assistant's Voice tab, or run: pnpm --filter @pva/tts-sherpa download en_US-lessac-medium
  speech-to-text (STT_PROVIDER): DEEPGRAM_API_KEY is not set
```

## Speech recognition models

The local recogniser is chosen on an assistant's **Hearing** tab (`STT_SHERPA_MODEL` in the command-line modes; the choice
reloads the engines, and if the reload fails the running one keeps running). A model that is not downloaded yet
shows **Download** with its size right there, and Save waits until it is there. The same section sets the language, the two end-of-turn pauses, the speech
detection threshold and the gain control, each with an explanation of what it trades.

| Preset | For | Trade-off |
|---|---|---|
| **`parakeet-v2`** (default) | English | Most accurate (about 13 % word errors on phone-like audio, where the previous default had 34 %); reads your whole sentence when you pause, so the reply starts 0.1–0.5 s later than with a streaming model for long sentences; words appear about once a second while you talk |
| `parakeet-ultra` | English and Dutch (and 23 more European languages) | Nearly as accurate and as fast; picks the language itself, which very poor audio can confuse |
| `whisper-turbo` | Dutch in noise, 99 languages | Most robust for Dutch, but the reply starts 1–3 s after you stop and no words appear while you talk |
| `hybrid-nemotron-parakeet` | Seeing your words live | Nemotron shows the words as you speak, Parakeet makes the text that is answered; 1 GB more memory and more CPU |
| `nemotron-560` | Live words, multilingual, less memory | 2–3× the errors of Parakeet |
| `nemotron-320` | The previous default (`nemotron-3.5`) | The least accurate of the large models |
| `zipformer-en`, `fast-conformer-en` | Small machines, English | Not recommended: the worst on real-world audio |

**Downloads from the UI**: Shared settings › Speech recognition models and an assistant's Voice tab list every preset with its size and state
(installed, downloading x %, not downloaded) and offer Download, Cancel and Delete (a model the running engines use
cannot be deleted). Only a page with edit access can start one; every page sees the progress. A download checks the
free disk space first (download plus unpacked size), fetches into a `.part` file (60 s without data fails it),
checks the size, unpacks at low priority (`nice -n 10 tar -xjf`) into a temporary folder, checks the expected files,
and only then moves the model into place; cancelling or a failure removes the partial files (and a restart removes
what an interrupted one left). It runs on the server, so closing the page does not stop it. Measured effect on
replies: [While a model downloads](LATENCY.md#while-a-model-downloads).

From a terminal the same code runs: `pnpm --filter @pva/stt-sherpa download-models <preset>` (`--list` shows which
are installed and their sizes) and `pnpm --filter @pva/tts-sherpa download <preset>`. Details, licences and
measurements: [stt-sherpa README](../packages/stt-sherpa/README.md).

## Keys & access

Settings → **Keys & access** (every protected page also takes the password inline):

1. **Set a password** (at least 8 characters, typed twice). The keys in `data/secrets.json` move into an encrypted file outside the project, `~/.config/pva/vault.enc` (`$XDG_CONFIG_HOME/pva/vault.enc`, or `PVA_VAULT_PATH`; mode 0600 in a 0700 directory), and `data/secrets.json` is deleted; the page says how many keys moved. From then on every key entered in the UI is stored only there.
2. **After every restart the keys are locked.** Engines and modules that need a key do not start ("Keys are locked — unlock them in Settings → Keys & access"); local speech and the Claude subscription keep working. Type the password (the banner on the stage has a password field too): the failed engines reload and failed modules restart by themselves. To run unattended, put the password in `.env` as `PVA_VAULT_PASSWORD`, the one secret meant for `.env`: the vault then unlocks at start (a wrong one is logged and leaves it locked). It is never logged, taken out of the environment at start and never passed to Claude Code.
3. **Who may change what.** Since protocol 5 every change (settings, modules, keys, the vault, downloads, front ends, devices) is made on the admin page (`/admin/`), after logging in with `PVA_ADMIN_PASSWORD` from `.env` (read once at start, taken out of the environment, never logged). Without it admin is disabled and nothing can be configured from a browser. A login lasts at most 12 hours, ends after 30 minutes without a change, at **Log out**, and when the assistant restarts; after 5 wrong passwords in a row logins are refused for 30 s, then the wait doubles. Unlocking the vault needs both: an admin page and the vault password. The voice page (`/`) only talks to the assistant and changes its own voice and activation.
4. **Lock now** removes the keys from memory (admin logins stay; running engines keep the keys they started with until they are reloaded). **Change password** re-encrypts the vault with a new salt.
5. **Forgot the password?** Delete the vault file; the keys in it are lost and you enter them again. There is no other way in.

The vault is `node:crypto` only: scrypt (N = 2¹⁷, r = 8, p = 1, a random 16-byte salt, parameters in the file; unlocking took 289 ms on the development machine) and AES-256-GCM with a fresh 12-byte IV per write, the header authenticated. A wrong password and a modified file both fail to open, and the file is never reset. After 5 wrong passwords in a row, unlocking is refused for 30 s, then the wait doubles.

**Reaching it from another device.** Browsers allow the microphone only on `https://` pages or on `localhost`, and this machine has no sound card, so the microphone and speaker are always another device. The assistant binds to `127.0.0.1` and has **no login**: anyone who can reach the port can use it and change its open settings (once a vault password is set, keys, providers and agents need that password; see [Keys & access](#keys--access)). Routes, simplest first:

1. **SSH tunnel** (a laptop on your network; the recommended route):
   1. On the assistant machine: `pnpm serve` (leave it running; it stays on `127.0.0.1`).
   2. On the laptop: `ssh -N -L 8787:localhost:8787 user@assistant-host` (leave it running; `-N` means no shell).
   3. On the laptop, open **`http://localhost:8787`** in Chrome or Edge (only Chromium is tested), press **Start talking** and allow the microphone. `localhost` counts as secure, so no certificate is needed.
   4. On open speakers keep the default *Speakers: say a few words*; with headphones choose *Headphones: instant* (Settings → This device → Microphone & speaker), where **Test echo** also tells you whether your browser cancels the assistant's voice.

   For `pnpm dev`, forward both ports and open `http://localhost:3000`: `ssh -N -L 3000:localhost:3000 -L 8787:localhost:8787 user@assistant-host`.
2. **HTTPS on the assistant** (a phone, which cannot open an SSH tunnel easily): set `SERVE_TLS_CERT` and `SERVE_TLS_KEY` to a certificate the device trusts (your own CA installed on the device, or a real hostname with a DNS-01 certificate), and `SERVE_HOST=0.0.0.0`, then open `https://<that hostname>:8787` on the phone. The server warns when it listens beyond loopback. Not tried on a real phone yet.
3. **A reverse proxy** in front of the default loopback binding (Caddy, `tailscale serve`), which terminates TLS. Add the proxy's public origin to `SERVE_ALLOWED_ORIGINS` if it differs from the `Host` the server sees, and its host name to `SERVE_ALLOWED_HOSTS` if the proxy passes that name on as `Host`. Set `SERVE_BEHIND_PROXY=true`: the server cannot tell a proxied request from a local one, so then no caller counts as on the home network and module web addresses guarded by "home network" refuse every request (callers from outside use an address that needs a token). The proxy must pass `Host` through unchanged (Caddy and `tailscale serve` do by default): a browser's request to a module web address that is not public is then judged same-origin by the host and port of its `Origin` against `Host`, ignoring the scheme the proxy terminated.

**Echo and interrupting.** Each device chooses how speech interrupts the assistant (Settings → This device → Microphone & speaker): *Headphones: instant* (any speech stops the reply), *Speakers: confirm* (the default: the assistant stops once the recogniser has two words that are not its own echo; one-word "stop" does not interrupt, use the Stop button), or *manual* (only Stop; the microphone is muted while the assistant speaks). The server-side echo gate implements these; the browser's echo cancellation is also requested.

## Voices

Each assistant speaks every reply with **one voice** (Assistants › the assistant › Voice; `ASSISTANT_VOICE` is the voice of the command-line modes and of a migrated install), a voice of one of the **voice providers**, written `provider:voice`. The providers are `sherpa` (on this machine: Piper and Kokoro), `cartesia` and `elevenlabs` (hosted, each needs its key). The model does not choose voices. Design: [docs/VOICE-PROVIDERS.md](VOICE-PROVIDERS.md).

| Voice | Provider | First audio (this machine, measured 2026-11-14) |
|---|---|---|
| `sherpa:en_US-lessac-medium` (default) | Piper, local | 30–90 ms per clause |
| `sherpa:nl_NL-pim-medium` | Piper, local, Dutch | not measured |
| `sherpa:kokoro-af_heart` | Kokoro, local (warmer, slower to start, about 700 MB of memory) | 200–950 ms per clause |
| `cartesia:<voice id>` | Cartesia, hosted (`CARTESIA_API_KEY`) | not measured |
| `elevenlabs:<voice id>` | ElevenLabs, hosted (`ELEVENLABS_API_KEY`) | not measured |

In the web UI, an assistant's Voice tab lists every provider's voices (search, preview, favourites, download of local voices); Shared settings › Voice providers takes the keys. From `.env` (the command-line modes and a migrated install):

```sh
ASSISTANT_VOICE=sherpa:kokoro-af_heart          # after: pnpm --filter @pva/tts-sherpa download kokoro-af_heart
ASSISTANT_VOICE=elevenlabs:EXAVITQu4vr4xnSDxMaL # with ELEVENLABS_API_KEY=...
```

A provider's other settings (`CARTESIA_MODEL`, `ELEVENLABS_SPEED`, `TTS_SHERPA_SPEED`, …) apply to whichever of its voices is chosen. Cartesia speaks in the chosen voice's own language (as Cartesia lists it, else `en`); `CARTESIA_LANGUAGE`, when set, overrides it.

**Upgrading from named voices.** Installs from before voice providers used `TTS_PROVIDER`, `DEFAULT_VOICE`, `VOICES` and `VOICE_<NAME>_*`. While `ASSISTANT_VOICE` is not set, those settings still choose the voice the old default voice was (for example `DEFAULT_VOICE=natural` speaks with `sherpa:kokoro-af_heart`, `TTS_PROVIDER=elevenlabs` with `ELEVENLABS_VOICE`); `VOICES` is ignored. The rules are in [docs/VOICE-PROVIDERS.md §6.2](VOICE-PROVIDERS.md). Choosing a voice in the UI (or setting `ASSISTANT_VOICE`) replaces them.

Try a voice with `say`: `pnpm start say --voice sherpa:kokoro-af_heart --out kokoro.wav "Once upon a time."`.

## Echo cancellation (barge-in over open speakers)

Without echo cancellation the microphone hears the assistant, and the STT reports that as the user speaking. The assistant then interrupts itself. With headphones this is not a problem. With open speakers, either set `BARGE_IN=false` or route audio through PipeWire's echo-cancel module. [`packages/audio-pipewire/README.md`](../packages/audio-pipewire/README.md#echo-cancellation-for-barge-in-over-open-speakers) has the config snippet. Point the assistant at the virtual nodes it creates:

```
PIPEWIRE_CAPTURE_TARGET=pva-echo-cancel-source
PIPEWIRE_PLAYBACK_TARGET=pva-echo-cancel-sink
```

That snippet is untested; the development machine has no sound card.
