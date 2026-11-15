# @pva/tts-elevenlabs

`Tts` via the ElevenLabs multi-context WebSocket (`wss://api.elevenlabs.io/v1/text-to-speech/{voice}/multi-stream-input`),
spoken directly over `ws`. Hosted and optional. Wire reference: `docs/protocols/elevenlabs-tts.md`.

## Settings

| Variable | Default | |
|---|---|---|
| `ELEVENLABS_API_KEY` | (required) | sent in the `xi-api-key` header only |
| `ELEVENLABS_VOICE` | `EXAVITQu4vr4xnSDxMaL` ("Sarah") | voice id from your ElevenLabs voice library |
| `ELEVENLABS_MODEL` | `eleven_flash_v2_5` | `eleven_flash_v2` (English), `eleven_multilingual_v2`, … |
| `ELEVENLABS_LANGUAGE` | (unset) | `language_code`, for models that can enforce a language |
| `ELEVENLABS_SPEED` | (the voice's) | 0.7–1.2 |
| `ELEVENLABS_STABILITY` | (the voice's) | 0–1 |
| `ELEVENLABS_AUTO_MODE` | `true` | server skips its chunk schedule (the clause chunker sends whole clauses) |
| `ELEVENLABS_SAMPLE_RATE` | 24000 | 8000, 16000, 22050, 24000, 32000, 44100 or 48000; development only (the voice router resamples) |
| `ELEVENLABS_URL` | `wss://api.elevenlabs.io` | ws(s), no user-info, no query; development / regional hosts |

As a voice, every setting can be set for one voice with the `VOICE_<NAME>_` prefix, e.g.
`VOICE_EXPRESSIVE_PROVIDER=elevenlabs` and `VOICE_EXPRESSIVE_ELEVENLABS_VOICE=<voice id>`.

A setting the server would refuse (a rate it does not offer, speed or stability out of range, an empty voice, a refused
address) makes every turn fail with a `TtsError` naming the variable; building the layer never fails.

## How a turn maps to the wire

- One socket per voice, opened when the layer is built and kept warm (pings, a refresh before the idle limit, reconnect
  with backoff).
- One context per turn: `{ text: " " }` to open it, then each clause as `{ text: "<clause> ", flush: true }` the moment it
  arrives, then `close_context` after the last; the turn ends on `isFinal`.
- Interruption sends `close_context` and drops the context's late audio.
- Audio is tagged with its clause from the chunk's character alignment (`sync_alignment=true`); see the wire reference §6.
- More than 5 turns at once (the server's per-connection limit) open a second socket for the extra turns.

## Tests

`pnpm --filter @pva/tts-elevenlabs test`: protocol mapping against a local mock server, credential-leak cases, limits.
Opt-in live test: `ELEVENLABS_API_KEY=... pnpm --filter @pva/tts-elevenlabs test live` (writes a WAV to the temp folder and
prints time to first audio). It has **not** been run (no key).
