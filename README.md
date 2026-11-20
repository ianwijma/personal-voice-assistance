<img src="assets/icon.svg" width="64" height="64" alt="">

# personal-voice-assistance

Created in [T3 Code](https://t3.codes).

A personal voice assistant that runs on your Linux machine. You talk, it answers out loud, and it uses modules (timers, weather, lists, your smart home, …) to get things done. **Everything runs locally except the language model:** speech recognition, turn detection and speech synthesis use [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) models on the CPU. Hosted speech (Deepgram, Cartesia, ElevenLabs) is optional.

- **Low latency.** Target: under 800 ms from the end of your sentence to the first sound of the reply. Measured with local speech and a simulated 300 ms model: median 771 ms, worst 1095 ms ([docs/LATENCY.md](docs/LATENCY.md)).
- **Easy to extend and to swap.** A new module is one package; a new provider is one package plus one line ([docs/EXTENDING.md](docs/EXTENDING.md)).

Node 22, TypeScript, Effect 4, pnpm workspace. Design and service contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it does

- **Streaming replies.** The reply is spoken one clause at a time, while the model is still writing.
- **Speculative turns.** When you have *probably* finished, the reply is prepared at once and plays as soon as you really have; if you keep talking it is thrown away.
- **Barge-in.** Talk over the assistant and it stops; only what you heard is kept.
- **Several assistants.** Each has its own prompt, language model, hearing, voice, look and modules ([docs/ASSISTANTS.md](docs/ASSISTANTS.md)).
- **Devices and wake phrases.** Each device (a browser, a phone, a voice node) chooses which assistants answer there and the wake phrase for each ("Hey Jeff"); several devices can talk at once, each with its own conversation ([docs/FRONTENDS-AND-ACTIVATION.md](docs/FRONTENDS-AND-ACTIVATION.md), [docs/VOICE-SESSIONS.md](docs/VOICE-SESSIONS.md)).
- **Voice nodes.** A Raspberry Pi with a speakerphone becomes the assistant in a room, paired from the admin page ([docs/VOICE-NODE-SETUP.md](docs/VOICE-NODE-SETUP.md)).
- **Configured in the browser.** Everything is set on the admin page; keys live in an encrypted vault ([docs/CONFIGURATION.md](docs/CONFIGURATION.md)).

## Language models

| Account | What |
|---|---|
| Offline stand-in (`fake`, default) | answers time questions and echoes the rest; for trying it out without a key |
| Claude API | Anthropic, with an API key |
| Claude subscription | Claude Code with this machine's `claude` login; opt-in |
| OpenRouter, home model server | any OpenAI-compatible API |

## Hearing and voices

Speech recognition runs on this machine by default; Deepgram is the hosted option.

| Recogniser | For |
|---|---|
| `parakeet-v2` (default) | English, the most accurate |
| `parakeet-ultra` | English, Dutch and 23 more European languages |
| `whisper-turbo` | Dutch in noise, 99 languages; slower to answer |
| `hybrid-nemotron-parakeet`, `nemotron-560` | your words shown live while you speak |

Each assistant speaks with one voice, written `provider:voice`:

| Voice | Where |
|---|---|
| `sherpa:en_US-lessac-medium` (default) | Piper, local, fastest |
| `sherpa:nl_NL-pim-medium` | Piper, local, Dutch |
| `sherpa:kokoro-af_heart` | Kokoro, local, warmer and slower to start |
| `cartesia:<voice id>`, `elevenlabs:<voice id>` | hosted, needs a key |

All presets, trade-offs and downloads: [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Licences: [docs/MODEL-LICENCES.md](docs/MODEL-LICENCES.md).

## Modules

An assistant uses only the modules it has switched on. Each has its own page in [docs/modules/](docs/modules/).

| Module | What it does |
|---|---|
| [Clock](docs/modules/clock.md) | the local date and time, and the time elsewhere |
| [Weather](docs/modules/weather.md) | today's weather and the forecast, from Open-Meteo |
| [Timers](docs/modules/timers.md), [Alarms](docs/modules/alarms.md) | countdowns and alarms that ring on the device that set them |
| [Reminders](docs/modules/reminders.md) | at a time or repeating, for the household or one person |
| [Lists](docs/modules/lists.md) | shopping and to-do lists |
| [Calendar](docs/modules/calendar.md) | what is on and when you are free, from ICS links (read-only) |
| [Memory and notes](docs/modules/memory.md) | remembers what you tell it, and forgets it for good |
| [Smart home](docs/modules/home-assistant.md) | lights, switches, climate and covers through Home Assistant |
| [Music](docs/modules/music.md) | music per room through Music Assistant |
| [Presence](docs/modules/presence.md) | who is home, and who just arrived or left |
| [Broadcast](docs/modules/broadcast.md) | an announcement on every device or in one room |
| [Briefing](docs/modules/briefing.md) | a short spoken briefing from the other modules |
| [Routines](docs/modules/routines.md) | your own phrases that run several things |
| [News and feeds](docs/modules/news.md) | headlines and stories from feeds |
| [Web search](docs/modules/web-search.md) | SearXNG or Brave, and a page read in short |
| [Knowledge](docs/modules/knowledge.md) | Wikipedia summaries and Wiktionary definitions |
| [Images](docs/modules/images.md) | a picture from Wikipedia or Wikimedia Commons |
| [Calculator](docs/modules/calculator.md) | arithmetic, units, currency and random picks |
| [Kitchen](docs/modules/kitchen.md) | pantry, recipes and what you can make |
| [Bin day](docs/modules/bin-day.md) | which bin goes out next |
| [Notifications](docs/modules/notifications.md) | read and dismiss notifications, do not disturb |
| [Assistant controls](docs/modules/assistant-controls.md) | stop, repeat, new conversation, volume |
| [System status](docs/modules/system-status.md) | how the assistant itself is doing |

Writing one: [docs/MODULES.md](docs/MODULES.md).

## Quick start

Requirements: Node ≥ 22.18, pnpm 10, `tar` with bzip2, about 800 MB of disk for the default models and 2.5 GB of free memory. Voice mode also needs PipeWire.

```sh
pnpm install
pnpm download-models                        # default speech recognition and voice, into models/
echo "what's the time?" | pnpm start text   # text mode; works offline with the stand-in model
pnpm serve                                  # the web UI on http://127.0.0.1:8787
```

Set `PVA_ADMIN_PASSWORD` in `.env` (see [`.env.example`](.env.example)), then configure everything on the admin page (`/admin/`). The browser needs `https://` or `localhost` for the microphone; from another machine use an SSH tunnel: `ssh -N -L 8787:localhost:8787 user@assistant-host`.

`pnpm check` typechecks every package and `pnpm test` runs the unit tests. There is no build step: the app runs with `tsx`.

## Documentation

| | |
|---|---|
| [Overview](docs/OVERVIEW.md) | how a turn flows, and the current status |
| [Running](docs/RUNNING.md) | the modes (text, voice, serve, `say`, `transcribe`), phones, audio diagnostics, benchmarks |
| [Configuration](docs/CONFIGURATION.md) | Settings, `.env`, speech models, keys and access, voices, echo cancellation |
| [Deployment](docs/DEPLOYMENT.md), [Releasing](docs/RELEASING.md) | container images and versioned releases |
| [Voice node setup](docs/VOICE-NODE-SETUP.md) | a Raspberry Pi in a room |
| [Extending](docs/EXTENDING.md) | adding a module or a provider, repository layout |
| [Latency](docs/LATENCY.md) | measured numbers and memory footprint |
| [What has been verified](docs/VERIFICATION.md) | what was tested, and what never was |
| [Architecture](docs/ARCHITECTURE.md) | the design and the service contracts |
