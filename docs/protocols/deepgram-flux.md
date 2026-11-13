# Deepgram Flux streaming STT — wire protocol reference

Researched 2026-11-13 from developers.deepgram.com. Raw `ws` client, no SDK.
**Provenance caveat:** the doc pages were read through a summarising fetcher. JSON blocks marked *(doc-derived)* follow the documented field lists and examples but are not guaranteed byte-for-byte. The pages do not publish a literal `Connected` or full-envelope `TurnInfo` payload. Everything tagged **UNVERIFIED** has no official source. Validate against a live connection and `TurnTrace` before depending on it.

## 1. Connection, auth, query parameters
Sources: https://developers.deepgram.com/docs/flux/quickstart · https://developers.deepgram.com/reference/speech-to-text/listen-flux · https://developers.deepgram.com/docs/flux/configuration

```
wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000
Authorization: Token YOUR_DEEPGRAM_API_KEY
```
(The quickstart's `wscat -H "Authorization: Token …"` example is the documented header form.) Browser-style `Sec-WebSocket-Protocol` auth is not documented for Flux: **UNVERIFIED**. With `ws`, pass `{ headers: { Authorization: 'Token …' } }`.

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `flux-general-en`, `flux-general-multi` | none listed | `model=flux` is invalid. |
| `encoding` | `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, `ogg-opus` | none | Required for raw audio. Use `linear16` for s16le. |
| `sample_rate` | 8000, 16000 (recommended), 24000, 44100, 48000 | none | The quickstart lists the values. The API-reference schema gives no range. |
| `eot_threshold` | float 0.5–1.0 | 0.7 | Confidence needed for `EndOfTurn`. 1.0 suppresses natural EOT, leaving only `ForceEndTurn` and the timeout. |
| `eager_eot_threshold` | float 0.3–0.9 | unset = eager disabled | Setting it enables `EagerEndOfTurn` and `TurnResumed`. Must be <= `eot_threshold`, otherwise an error. |
| `eot_timeout_ms` | int 500–60000 | 5000 | Forces `EndOfTurn` after this much silence. The timer resets when speech is detected. |
| `keyterm` | repeatable string | none | Plain terms only. Weights are ignored. Join multi-word terms with `%20` or `+`. Up to 100 terms (stated for Configure). |
| `language_hint` | repeatable string | none | `flux-general-multi` only. Empty values are rejected. Invalid on `flux-general-en`. |
| `numerals` | bool | false | |
| `profanity_filter` | bool | false | |
| `redact` | `numbers`, `aggressive_numbers` | none | Only these two on Flux. |
| `redact_usage` | bool | false | |
| `tag`, `mip_opt_out` | — | none | Schema gives no detail. |

Also invalid per the quickstart: `language=en`. Recommended query for this project: `model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.7&eager_eot_threshold=0.5`. The 0.5 value is a starting point to tune, not a doc recommendation.

## 2. Client → server
Sources: https://developers.deepgram.com/reference/speech-to-text/listen-flux · https://developers.deepgram.com/docs/flux/configure · https://developers.deepgram.com/docs/flux/force-end-turn · https://developers.deepgram.com/docs/flux/close-stream

**Audio:** binary WebSocket frames of raw PCM. Recommended chunk is **80 ms**, which is **2560 bytes** at 16 kHz s16le mono. The quickstart's Python demo sends 1024 bytes (~32 ms). Don't send empty binary frames: an empty payload can cause unexpected closures (https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors, v1-era page).

Control messages are **text frames**:

```json
{ "type": "CloseStream" }
{ "type": "ForceEndTurn" }
```
- `ForceEndTurn` is quoted verbatim from the docs. In a turn it yields `EndOfTurn` with `trigger:"manual"`, and `turn_index` increments. It overrides a pending eager state, with no `TurnResumed`. With no active turn it is ignored and the server sends a `Warning` with code `FORCE_END_TURN_NO_ACTIVE_TURN`. Send it before `CloseStream`, because after `CloseStream` it has no effect.
- `CloseStream`: the server processes the audio already received, emits `Update` messages, then closes **without a WebSocket close status code**. **No `EndOfTurn` is emitted**, so treat the last `Update` as final. No summary metadata object is sent.
- `Configure` *(doc-derived; every field optional, omitted fields keep their current values)*:
```json
{
  "type": "Configure",
  "thresholds": { "eager_eot_threshold": 0.4, "eot_threshold": 0.7, "eot_timeout_ms": 6000 },
  "keyterms": ["product_name"],
  "language_hints": ["en", "es"],
  "numerals": true,
  "redact_usage": true
}
```
  `keyterms` replaces the whole list. `language_hints: []` clears and `null`/omitted leaves unchanged. `redact_usage` can only be turned on. All fields apply atomically. Success returns `ConfigureSuccess` with the full active config (`thresholds`, `keyterms`, `language_hints`, `numerals`, `redact_usage`, `request_id`, `sequence_id`). A semantic failure returns `ConfigureFailure` (`request_id`, `sequence_id`, `code`, `description`, e.g. `UNPARSABLE_CLIENT_MESSAGE` for "eager_eot_threshold cannot be greater than eot_threshold.") and the stream keeps its previous config. A **schema-invalid** Configure (e.g. `"numerals":"true"`) returns `type:"Error"` and **closes the connection**.
- **KeepAlive:** the Flux reference's client-message list does **not** include KeepAlive. See §5.
- `Finalize` appears only in the v1 `/v1/listen` reference. It is not listed for Flux.

## 3. Server → client
Source: https://developers.deepgram.com/reference/speech-to-text/listen-flux (schemas) · https://developers.deepgram.com/docs/flux/state (turn events) · https://github.com/deepgram/deepgram-python-sdk (`ListenV2TurnInfo`)

Message types (`type`): `Connected`, `TurnInfo`, `ConfigureSuccess`, `ConfigureFailure`, `Warning`, `Error`. Every message has `sequence_id` (int ≥ 0, ordering). All but `Error` carry `request_id` (UUID).

- **Connected**: fields `type:"Connected"`, `request_id`, `sequence_id`. No literal payload is published.
- **TurnInfo** fields (required unless noted): `type:"TurnInfo"`, `request_id`, `sequence_id`, `event`, `turn_index` (int, **increments immediately after an `EndOfTurn`**), `audio_window_start`/`audio_window_end` (seconds), `transcript` (string), `words[]` (`{word, confidence, start, end}`), `end_of_turn_confidence` (float; rises as the model grows surer the speaker is done), `trigger` (optional; **only on `EndOfTurn`**; `model` | `manual` | `timeout`; open enum, tolerate unknown values), `languages` (optional; multi model only), `languages_hinted` (optional; only if hints set). The model allows extra fields, so ignore unknown ones.
- `event` ∈ `Update`, `StartOfTurn`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`.
- `Update`: emitted roughly every 0.25 s of transcribed audio (per the state page) unless a state change occurred.
- Per-word confidence is in `words[].confidence`. The turn-level value is `end_of_turn_confidence` (this is turn-end confidence, not transcript confidence).
- **Warning**: `code` (SCREAMING_SNAKE_CASE), `description`. Connection stays open (e.g. `FORCE_END_TURN_NO_ACTIVE_TURN`).
- **Error** (fatal): `type:"Error"`, `sequence_id`, `code`, `description`, no `request_id`. Fatal failures close the socket.

Example *(doc-derived, abbreviated; wrapper fields `type`/`request_id`/`sequence_id` omitted)*:
```json
{"event":"StartOfTurn","turn_index":0,"audio_window_start":0.0,"audio_window_end":0.6,"transcript":"Hi I","words":[{"word":"Hi","confidence":0.95,"start":0.42,"end":0.56}],"end_of_turn_confidence":0.1}
{"event":"Update","turn_index":0,"audio_window_start":0.0,"audio_window_end":0.8,"transcript":"Hi I need to","words":[],"end_of_turn_confidence":0.1}
{"event":"EagerEndOfTurn","turn_index":0,"audio_window_start":0.0,"audio_window_end":1.1,"transcript":"Hi I need to cancel my subscription.","words":[],"end_of_turn_confidence":0.3}
{"event":"TurnResumed","turn_index":0,"audio_window_start":0.0,"audio_window_end":1.2,"transcript":"Hi I need to cancel my subscription please","words":[],"end_of_turn_confidence":0.1}
{"event":"EndOfTurn","turn_index":0,"audio_window_start":0.0,"audio_window_end":1.7,"transcript":"Hi I need to cancel my subscription please.","words":[],"end_of_turn_confidence":0.7,"trigger":"model"}
```
Ordering rules: `TurnResumed` only follows an `EagerEndOfTurn`. If the transcript changes after an eager EOT, `TurnResumed` precedes the `EndOfTurn`. `EagerEndOfTurn` and `TurnResumed` appear only when `eager_eot_threshold` is set. `StartOfTurn` and `EagerEndOfTurn` transcripts are always non-empty.

## 4. Mapping to client events
| Deepgram | Our event | Text to use / caveat |
|---|---|---|
| `TurnInfo` `event:"StartOfTurn"` | `SpeechStarted` | Its transcript is already non-empty ("Hi I"). Echo and background noise can cause false `StartOfTurn` (per the eager-EOT page). |
| `event:"Update"` | `Interim(text)` | `transcript` is the **whole turn so far** (cumulative, grows: "Hi I" → "Hi I need to"). Replace, don't append. You may also emit `Interim` for `StartOfTurn`'s text. |
| `event:"EagerEndOfTurn"` | `EagerEndOfTurn(text)` | Draft only. Never commit a reply before `EndOfTurn`. |
| `event:"TurnResumed"` | `TurnResumed` | Cancel speculative work. The doc says it carries no transcript to act on, though the state-page example shows one; ignore it. Subsequent `Update`s continue the same `turn_index`. |
| `event:"EndOfTurn"` | `EndOfTurn(text)` | Final text. If no `TurnResumed` intervened, it is identical to the preceding eager transcript, so compare strings to confirm a draft is still valid. `trigger` says why (`model`/`manual`/`timeout`). |
| `Warning` | log | Not fatal. |
| `Error` / socket close | error → reconnect | See §5. |
| `ConfigureSuccess`/`ConfigureFailure` | internal | Correlate by order only. No request id is echoed from the client: **UNVERIFIED**. |

Not documented: whether an `EndOfTurn` can arrive without any prior `StartOfTurn` or `Update` (e.g. via `timeout`): **UNVERIFIED**. Implement the mapping defensively, with a turn-state machine keyed on `turn_index`. Eager mode costs roughly 50–70% more LLM calls, per the eager-EOT page.

## 5. Lifecycle, keep-alive, close, reconnect
- **Idle timeout (general, v1-era docs):** the platform terminates the connection if no audio arrives for about 10 s. Source: https://developers.deepgram.com/docs/lower-level-websockets, https://developers.deepgram.com/docs/audio-keep-alive (page is Nova/`/v1/listen`; it says to send `{"type":"KeepAlive"}` as a **text** frame every 3–5 s). Error/close table, https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors (v1-era; Flux not mentioned): 1008 `DATA-0000` undecodable audio; 1011 `NET-0000` no text frame sent to the client within the timeout; 1011 `NET-0001` no audio or text frame received within the timeout (KeepAlive alone doesn't prevent it per that page); 1011 `NET-0002` no-audio timeout (KeepAlive resets this).
- **Flux and KeepAlive: UNVERIFIED / conflicting.** The Flux reference does not list KeepAlive. Unofficial Deepgram Learn posts (found via search, not read in full) say Flux does not acknowledge KeepAlive and one test closed ~10 s after the last audio frame. **Safe design: stream continuous audio, including silence, rather than relying on KeepAlive.** Sending 80 ms silent PCM frames costs billed audio time (billing applies to streamed audio, **UNVERIFIED** whether silence is billed differently). Test a live KeepAlive before relying on it.
- **Max session duration for `/v2/listen`: not documented (UNVERIFIED).** The 2 h limit in the 2026-07-31 changelog (https://developers.deepgram.com/changelog/2026/7/31.md) is for **Voice Agent** sessions (warning `MAXIMUM_SESSION_LENGTH_APPROACHING` at 1 h 55 m, terminal error `MAXIMUM_SESSION_LENGTH_REACHED` at 2 h; KeepAlive doesn't extend it). Don't assume it applies to Flux, but plan a proactive reconnect well inside 2 h as a precaution.
- **Close:** `CloseStream` → server closes with **no status code** (so `ws` reports 1005). Fatal errors arrive as an `Error` message and the socket closes. No Flux-specific close code table exists: **UNVERIFIED**.
- **Reconnect (our recommendation, not from the docs):** treat any close without our own `CloseStream` as unexpected. Back off exponentially with jitter (e.g. 250 ms → 8 s). Reset turn state, because `turn_index`/`sequence_id` restart on a new connection (**UNVERIFIED**, assumed). Emit a synthetic turn abort for any in-flight eager draft. Buffer up to a few hundred ms of PCM in a ring while reconnecting. Don't retry on 401/403 or on config `Error`s (`UNPARSABLE_CLIENT_MESSAGE`). A 429 on upgrade means the concurrency limit was hit.

## 6. Pricing and limits
Sources: https://deepgram.com/pricing · https://developers.deepgram.com/reference/api-rate-limits · https://developers.deepgram.com/docs/working-with-concurrency-rate-limits
- **Price:** Flux English streaming $0.0077/min pay-as-you-go ($0.0065/min Growth). Multilingual $0.0078 / $0.0068. Verify before budgeting, since pricing pages change.
- **Concurrent streams (per project, shared across API keys; per regional endpoint):** Flux: Pay-as-you-go 150, Growth 225 (NA) / 150 (EU, AU, IN), Enterprise up to 300. Self-serve secondary projects are limited to 1 concurrent stream. Exceeding limits returns `429 Too Many Requests`. No request-rate limit for a single long-lived stream is documented.
