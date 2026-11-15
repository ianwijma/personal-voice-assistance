# ElevenLabs streaming TTS — multi-context WebSocket wire reference

Researched 2026-11-16 from the official AsyncAPI spec (`https://elevenlabs.io/docs/asyncapi/api-reference-2.yaml`, channel
`/v1/text-to-speech/{voice_id}/multi-stream-input`), the multi-context guide
(`https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket.md`), the models overview
(`https://elevenlabs.io/docs/overview/models.md`) and the stream endpoint reference (`.../api-reference/text-to-speech/stream.md`).
**[UNVERIFIED]** marks anything not confirmed from an official source. Nothing here has been checked against the real
service (no key).

## 1. Connection and auth

- URL: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input`. Regional hosts use the same path
  (`api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency.elevenlabs.io`, `api.sg.residency.elevenlabs.io`).
- The voice is part of the path, so one socket speaks one voice. Model and format are query parameters, fixed for the socket.
- Auth: header `xi-api-key: <key>` (used here). Alternatives: `authorization` or `single_use_token` query parameters, or
  `xi_api_key` in a context's first message. The key never goes in the query here.
- Query parameters (spec): `model_id` (default `eleven_multilingual_v2`), `language_code`, `enable_logging` (default true),
  `output_format`, `inactivity_timeout` (seconds, default 20, max 180), `sync_alignment` (default false), `auto_mode`
  (default false), `apply_text_normalization`, `seed`, `enable_ssml_parsing` (default false).
- Sent here: `model_id`, `output_format=pcm_<rate>`, `inactivity_timeout=180`, `sync_alignment=true`, `auto_mode=true`, and
  `language_code` only when set.
- Output formats (stream reference): `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_32000`, `pcm_44100`, `pcm_48000`
  (raw signed 16-bit little-endian mono, base64 in JSON), plus mp3/opus/µ-law/A-law variants that are not used here. That
  `pcm_*` is little-endian s16 matches every SDK example; the spec does not state the byte order **[UNVERIFIED]**. The
  adapter carries an odd trailing byte to the next chunk in case a sample is ever split.
- `auto_mode`: the standard-WebSocket reference says it disables the chunk schedule and buffers, "only recommended when
  sending full sentences or phrases". The clause chunker sends whole clauses, so it is on by default
  (`ELEVENLABS_AUTO_MODE`). Its effect with per-clause flushes is **[UNVERIFIED]**: measure with TurnTrace.

## 2. Models

From the models overview, for this endpoint:

| Model | Median latency† | Note |
|---|---|---|
| `eleven_flash_v2_5` | ~100 ms | default here; 32 languages; number normalisation off by default (see 7) |
| `eleven_flash_v2` | ~135 ms | English only |
| `eleven_multilingual_v2` | higher | best quality of the v2 family, not for real-time |
| `eleven_turbo_v2_5`, `eleven_turbo_v2` | — | "outclassed by Flash"; docs recommend Flash |

† "Median, excluding application & network latency." Eleven v4 Turbo (~100 ms, most expressive) is documented as available
through the **Text to Dialogue** WebSocket, not this endpoint, so it is not supported by this adapter.

## 3. Client → server messages

Each is one JSON text frame (spec names).

| Message | Shape | Use here |
|---|---|---|
| Initialise context | `{ "text": " ", "context_id": "<id>", "voice_settings"?, "generation_config"?, "pronunciation_dictionary_locators"? }` | first message of each turn's context; `voice_settings` only when speed/stability are set |
| Send text | `{ "text": "<text> ", "context_id": "<id>", "flush"?: true }` | one per clause, always with `flush: true`. Text "should end with a single space". |
| Flush | `{ "context_id": "<id>", "flush": true, "text"? }` | not used separately (the clause message flushes) |
| Close context | `{ "context_id": "<id>", "close_context": true }` | end of a turn's input, and on interruption. "If it has already been set to flush it will continue flushing." The id may be reused later as a new context (not done here: a fresh UUID per context). |
| Close socket | `{ "close_socket": true }` | not used (the socket is closed with a WebSocket close frame on shutdown) |
| Keep alive | `{ "text": "", "context_id": "<id>" }` | resets the context's inactivity clock; sent while a turn's input is open but quiet (a tool call) |

`voice_settings` (`RealtimeVoiceSettings`): `stability` (default 0.5), `similarity_boost` (0.75), `style` (0),
`use_speaker_boost` (true), `speed` (1, range 0.7–1.2). `generation_config.chunk_length_schedule`: numbers 50–500, default
`[120, 160, 250, 290]` (characters buffered before each generation; bypassed by `flush` and by `auto_mode`).

## 4. Server → client messages

- Audio: `{ "audio": "<base64>", "contextId": "<id>", "alignment": { "chars": [...], "charStartTimesMs": [...], "charDurationsMs": [...] } | null, "normalizedAlignment": {...} | null }`.
- Final: `{ "isFinal": true, "contextId": "<id>" }`, "the final message for the context". The guide's own examples read
  `is_final` instead; both spellings are accepted **[UNVERIFIED]** which one the server sends.
- Errors: **not documented** for this channel. The adapter treats any message with a non-empty `error`, or a `message`
  without `audio` and without `isFinal`, as an error: with a `contextId` it fails that turn, without one it fails every turn
  on the socket. Its `code`, `error` and `message` are shown (redacted). Whether an invalid key is refused at the upgrade
  or with a message and a close frame is **[UNVERIFIED]**; both fail the turn and reconnect with backoff.
- The server uses camelCase `contextId` in its messages and snake_case `context_id` in the client's; both are accepted.

## 5. Contexts, flushing, interruption

- The guide: "Stream text into one context until an interruption occurs, then create a new context and close the existing
  one." One context per turn here; every clause goes to it, flushed, so generation starts at once and later clauses
  synthesise while earlier ones play (prosody is kept within the context).
- Each connection is "limited to 5 concurrent contexts". The adapter counts its open contexts per socket and opens another
  socket only while every open one already has 5 (several devices speaking at once); an extra socket is closed when its
  last turn ends. A context closed on interruption may still count on the server side until it has finished flushing
  **[UNVERIFIED]**.
- Interruption: send `close_context` and drop every later frame for that id on the client (its route is removed). Audio
  already flushed keeps generating server-side ("will continue flushing"), so late chunks are expected.
- End of a turn: after the last clause, `close_context`; every clause was flushed, so nothing is left in the buffer, and the
  server answers `isFinal` after the last audio. If `isFinal` never comes, the turn ends after `drainTimeoutMs` of silence
  (default 5 s): normally if audio arrived, as a `TtsError` if nothing that should have spoken did.
- A context the server ends before the input has ended (`isFinal` early, e.g. its inactivity timeout) is not reused: the
  next clause opens a fresh context; tags stay in turn order.

## 6. Attributing audio to clauses

ElevenLabs sends no per-flush acknowledgement (Cartesia's `flush_done`). With `sync_alignment=true` every audio chunk
carries the characters it speaks (`alignment.chars`, original text; `normalizedAlignment` is the normalised text). The adapter
counts the non-whitespace characters sent per clause and those the chunks cover; a chunk is tagged with the clause its first
character falls in. A chunk without an alignment keeps the previous chunk's clause. Tags never decrease. If the alignment
differs from the text sent (characters the server drops), only the tags shift; no audio is held back or dropped, and a
clause the alignment says got no audio is logged, not failed. Whether alignment chars always match the sent text is
**[UNVERIFIED]**.

## 7. Lifecycle and limits

- `inactivity_timeout`: contexts "timeout after 20 seconds and are closed automatically" by default; up to 180. "Send an
  empty text message on a context to reset the timeout clock." Set to 180 here, with a keep-alive every 30 s of quiet
  during a turn.
- Whether an idle socket with no context is closed after the inactivity timeout, and whether WebSocket pings count, is
  **[UNVERIFIED]**: the socket is pinged every 30 s and reopened after 170 s without input while no turn runs, and
  reconnects with backoff if the server closes it.
- Flash v2.5 does not normalise numbers by default ("phone numbers might be read out in a way that isn't clear");
  `apply_text_normalization=on` enables it at some latency cost. Not set here (the server default applies).
- Concurrency limits per plan are in the models overview ("Concurrency Limit (Flash)"); not handled specially here.
