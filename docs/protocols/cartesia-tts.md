# Cartesia streaming TTS — WebSocket wire reference

Researched 2026-11-13 from official docs and the `cartesia-ai/cartesia-js` source (`src/internal/lib/tts/ws.ts`, `src/resources/tts.ts`).
**[UNVERIFIED]** marks anything not confirmed from an official source. Doc pages were read through a summarising fetcher, so quoted strings are as returned; re-check anything load-bearing against the page.

## 1. Connection and auth
Source: https://docs.cartesia.ai/api-reference/tts/websocket , SDK `ws.ts`, `internal-base.ts`

- URL: `wss://api.cartesia.ai/tts/websocket`
- API version: `cartesia_version`, current value **`2026-08-14`**. The API reference lists it as a required parameter ("API version, e.g. `2026-08-14`"). The SDK (`ws.ts`) hardcodes `2026-08-14` and sets it as a **query param** `?cartesia_version=2026-08-14`. The REST docs use header `Cartesia-Version: 2026-08-14`. The SDK's Node path sends the header from `getWebSocketConnectHeaders`; that helper was not read, so which Node transport (header or query) is canonical is **[UNVERIFIED]**. Safest: send the query param, and also the `Cartesia-Version` header.
- Auth (server side, Node): the SDK's Node path sends `Authorization: Bearer <api_key>` on the upgrade request. The API reference documents the header as `X-API-Key` ("Use an API key when you're calling from a trusted server."). Both are used by official sources; which is preferred is **[UNVERIFIED]**. Send `X-API-Key`.
- Browser alternatives (not needed here): `?access_token=<short-lived token>`, or SDK-only `?api_key=`.
- Minimal `ws` connect:
  ```ts
  new WebSocket("wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14",
    { headers: { "X-API-Key": key, "Cartesia-Version": "2026-08-14" } })
  ```
- Messages in both directions are JSON text frames. The SDK does `JSON.parse(raw.toString())`.

## 2. Generation request
Source: https://docs.cartesia.ai/api-reference/tts/websocket

Example (from the reference):
```json
{
  "model_id": "sonic-3.6",
  "transcript": "Testing the streaming output.",
  "voice": { "id": "your-voice-id" },
  "language": "en",
  "context_id": "demo-context-001",
  "output_format": { "container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000 },
  "continue": false,
  "add_timestamps": true
}
```

| Field | Req | Values / notes |
|---|---|---|
| `model_id` | yes | `sonic-3.6`, `sonic-3.5`, `sonic-3`, `sonic-latest`; dated snapshots e.g. `sonic-3.6-2026-08-27`, `sonic-3.5-2026-05-04`, `sonic-3-2026-01-12` |
| `transcript` | yes | Text appended to the context. Concatenated verbatim. `""` allowed (see 3). |
| `voice` | yes | Voice id string, or `{ "id": "<id>" }`. Must stay identical within a context. (The buffering guide uses the bare string form.) |
| `output_format` | yes | `{container:"raw", encoding, sample_rate}`. `encoding`: `pcm_f32le`, `pcm_s16le`, `pcm_mulaw`, `pcm_alaw`. `sample_rate`: 8000, 16000, 22050, 24000, 44100, 48000. Must stay identical within a context. **Wanted here: `raw` / `pcm_s16le` / `24000`.** |
| `context_id` | yes | Unique string (UUID suggested). |
| `language` or `locale` | no | Set one, not both. e.g. `en`, `en-GB`. |
| `accent` | no | Multilingual voices only; value from the voice's `accents` field. |
| `normalization` | no | `auto` (default), `off`, or a language/locale code. Inherited from the previous request in the context if omitted. |
| `continue` | no | Default `false`. `true` = more transcript follows. |
| `max_buffer_delay_ms` | no | Integer 0–5000, default 3000. See 3. |
| `flush` | no | boolean; flush the context. See 4. |
| `add_timestamps` | no | word timestamps, default `false` |
| `add_phoneme_timestamps` | no | default `false` |
| `use_normalized_timestamps` | no | `true` = normalized text timestamps, `false` = original |
| `pronunciation_dict_id` | no | string |
| `generation_config` | no | `{ volume: 0.5–2.0 (def 1), speed: 0.6–1.5 (def 1), emotion: "neutral"\|"calm"\|"angry"\|"content"\|"sad" }` |

Models. Sources: https://docs.cartesia.ai/build-with-cartesia/tts-models/latest , `.../older-models`
- Docs: "We recommend using Sonic 3.6 for best results"; `sonic-3.6` tracks the latest stable snapshot, `sonic-3.6-YYYY-MM-DD` is pinned; "Sonic 3.6 is fully backwards compatible with Sonic 3.5". `sonic-preview` is beta, not for production. `sonic-3-2025-10-27` sunsets 2026-10-20 (already past).
- Docs publish **no time-to-first-audio figure** and no statement that 3.5 is faster. The brief says an independent benchmark measured sonic-3.5 faster than sonic-3.6; I could not find that benchmark (searches found no independent 3.5-vs-3.6 TTFA comparison), so treat it as **[UNVERIFIED]** but accept it as a reason to **make `model_id` configurable** (default to `sonic-3.5`, measure both with `TurnTrace`). Note the bare `sonic-3.5` alias appears in the SDK type list but was not on the docs pages I read; the pinned `sonic-3.5-2026-05-04` is documented.

## 3. Incremental text input
Sources: https://docs.cartesia.ai/use-the-api/tts-websocket/contexts , https://docs.cartesia.ai/build-with-cartesia/capability-guides/stream-inputs-using-continuations

Verbatim example from the contexts guide:
```json
{"transcript": "Hello, Sonic!", "continue": true, "context_id": "happy-monkeys-fly"}
{"transcript": " I'm streaming ", "continue": true, "context_id": "happy-monkeys-fly"}
{"transcript": "inputs.", "continue": false, "context_id": "happy-monkeys-fly"}
```
- Contexts are the continuation mechanism. Send every input for one reply with the same `context_id`, the same `voice`, and the same `output_format`. Resend `model_id`/`voice`/`output_format` on each message to be safe (whether later messages may omit them is **[UNVERIFIED]**).
- "Transcripts are concatenated verbatim, so make sure they form a valid transcript when joined together." Chunks need their own spacing: `"Hello, world!"` then `" How are you?"`, not `"How are you?"`. Never split decimals like `1.0` across chunks (affects speed/volume SSML tags).
- End of input: send `continue: false`. "To finish a context, just set `continue` to `false`." If the final text is not known yet, send `{"transcript": "", "continue": false, "context_id": "..."}`.
- Buffering: server holds text "until it's confident it has enough context to generate high-quality speech, or the buffer delay elapses, whichever comes first" (`max_buffer_delay_ms`, default 3000). "Without this buffer, the model would immediately start generating with each input." Text without clear sentence-ending punctuation "may stay in the automatic input buffer until the model sees a clearer boundary or until `max_buffer_delay_ms` elapses."
- Guidance: end complete sentences with `.`, `?`, `!`; put terminal punctuation on the final segment. Set `max_buffer_delay_ms: 0` "only if you already buffer client-side". The docs do not recommend changing it otherwise and say to raise it if choppy.
- Docs give **no recommended clause/chunk size** and no figure for minimum text before audio starts. For lowest TTFA, a reasonable choice is to send whole clauses ending in punctuation, with `max_buffer_delay_ms` lowered; the effect on TTFA and prosody is **[UNVERIFIED]**, so measure it.
- Outputs for a context are returned in input order ("Outputs for a given context will always be in order of the inputs you streamed in").
- `done: true` arrives "only after outputs for the entire context have been returned".
- Context expiry: "Contexts automatically expire 1 second after the last audio output is streamed out." Sending more input on an expired context id "is not supported". So use a fresh `context_id` per assistant reply.
- Multiple contexts may run concurrently on one connection; "billed the same as running each separately".

## 4. Server → client messages
Source: https://docs.cartesia.ai/api-reference/tts/websocket ; SDK `src/resources/tts.ts` types. Every message carries `context_id` (demux on it). All are JSON text frames; there are no binary frames.

Audio chunk (audio is a **base64 string in `data`**, decode to raw bytes; with `pcm_s16le` they are s16le samples):
```json
{ "type": "chunk", "data": "<base64 audio>", "done": false, "status_code": 206, "step_time": 123,
  "context_id": "50dc3b5e-5841-4aa1-9f94-60cfb9aead79" }
```
`step_time` is in ms. SDK types also have an optional `flush_id` on chunks.

Other types (field lists from the API reference; the docs gave no full example payloads for these, so the shapes below are **built from the field lists**, with values illustrative):
- `done` — `{ "type":"done", "done":true, "status_code":200, "context_id":"..." }` (SDK types `done: true`; `status_code` value 200 is **[UNVERIFIED]**).
- `flush_done` — `{ "type":"flush_done", "done":false, "flush_done":true, "flush_id":1, "status_code":200, "context_id":"..." }`. `flush_id` starts at 1 and counts flush commands in that context.
- `timestamps` — `{ "type":"timestamps", "done":false, "status_code":200, "context_id":"...", "word_timestamps": { "words":[...], "start":[...], "end":[...] } }` (seconds).
- `phoneme_timestamps` — same, with `phoneme_timestamps: { phonemes, start, end }`.
- `error` — fields `type`, `title`, `message`, `status_code`; optional `done`, `error_code` (e.g. `model_not_found`), `doc_url`, `request_id`, `context_id`. Example from the page: status 400, `error_code: "model_not_found"`. `context_id` may be absent, so handle connection-level errors without one.

Flush. Source: https://docs.cartesia.ai/use-the-api/tts-websocket/context-flushing-and-flush-i-ds
- To flush: send `continue: true`, `flush: true`, `transcript: ""` and the same `context_id`. Server forces all buffered text to be generated, then replies `flush_done` with an incrementing `flush_id`. Chunks carry the `flush_id` current when their text was submitted. Whether a flush could replace `max_buffer_delay_ms` for latency is **[UNVERIFIED]**; the docs do not say.

## 5. Cancel
Source: https://docs.cartesia.ai/use-the-api/tts-websocket/contexts ; SDK `ws.ts` (`cancelContext` sends `{ cancel: true, context_id }`)
```json
{ "context_id": "happy-monkeys-fly", "cancel": true }
```
- `context_id` must match the context to stop.
- Docs: it "will only halt requests that have not begun generating a response yet", and "Any currently generating request will continue sending responses until completion." So **late `chunk` messages for a cancelled context can still arrive**.
- What the server sends afterwards (an ack, a `done`, or nothing) is **not documented** **[UNVERIFIED]**. The SDK sends no ack wait and simply unregisters the context's queue.
- Implementation consequence (inference, not from docs): on barge-in, immediately stop playback, send the cancel, mark the `context_id` as dead, and **drop every later frame for it on the client**. Do not reuse a cancelled id. Whether closing and reopening the socket stops generation faster is **[UNVERIFIED]**.

## 6. Connection lifecycle and limits
Source: https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts
- Idle timeout: "We close idle TTS WebSocket connections after 5 minutes." Docs recommend reopening for long idles; another page suggests an occasional generation to keep the socket alive. No WebSocket ping/pong or app-level keep-alive message is documented **[UNVERIFIED]** (protocol-level ping frames via `ws` may or may not reset the timer).
- Concurrent generations per account (TTS): Free 2, Pro 3, Startup 5, Scale 15, Enterprise custom. Over the limit, Free fails with `429`; paid plans queue up to 10× the limit, then `429`.
- Parallel TTS WebSocket connections: capped at 10× the concurrency limit; excess opens get `429 Too Many Requests` on connect.
- Per-connection context concurrency limit: not documented **[UNVERIFIED]**.
- Close codes: not documented **[UNVERIFIED]**. The SDK closes with `1000, "OK"` and, on a closed socket, reconnects transparently and discards all context state, since server-side state is lost.
- Recommended reconnect (inference): open the socket eagerly, reopen on `close`/`error` or before the 5-minute idle limit with backoff, and fail in-flight contexts on reconnect rather than resuming them.

## 7. Voices
Sources: https://docs.cartesia.ai/build-with-cartesia/tts-models/latest , https://docs.cartesia.ai/api-reference/voices/list
- Voice id is a UUID string. Docs' recommended stable English voices for voice agents:
  - Skylar (en-US, F): `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4`
  - Daniel (en-US, M): `47c38ca4-5f35-497b-b1a3-415245fb35e1`
  - (also Jacqueline en-US F `9626c31c-bec5-4cca-baa8-f8ba9e84c8bc`; Gemma en-GB F `62ae83ad-4f6a-430b-af41-a9bede9286ca`; Archie en-GB M `ef191366-f52f-447a-a398-ed8c0f2943a1`)
- List: `GET https://api.cartesia.ai/voices` with headers `Cartesia-Version: 2026-08-14` and `Authorization: Bearer <api key>` (keys start `sk_car_`). Query: `language` (e.g. `en`), `gender` (`masculine`|`feminine`|`gender_neutral`), `is_owner`, `limit` (1–100), `starting_after`. Response `{ data: Voice[], has_more, next_page }`.

## 8. Pricing
Source: https://cartesia.ai/pricing (read only through search snippets, **[UNVERIFIED]** against the live page): Sonic TTS costs 1 credit per character (about 750–800 credits per minute of audio); the free plan has 20K credits per month.
