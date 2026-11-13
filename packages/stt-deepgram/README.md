# @pva/stt-deepgram

`Stt` via Deepgram Flux (`wss://api.deepgram.com/v2/listen`), spoken directly over `ws`. Wire reference: `docs/protocols/deepgram-flux.md`.

## Settings

| Variable | Default | |
|---|---|---|
| `DEEPGRAM_API_KEY` | (required) | sent in the `Authorization` header only |
| `DEEPGRAM_MODEL` | `flux-general-en` | |
| `DEEPGRAM_EOT_THRESHOLD` | 0.7 | confidence for `EndOfTurn` |
| `DEEPGRAM_EAGER_EOT_THRESHOLD` | 0.5 | confidence for `EagerEndOfTurn`; 0 disables it |
| `DEEPGRAM_EOT_TIMEOUT_MS` | 5000 | silence after which a turn ends regardless |
| `DEEPGRAM_URL` | `wss://api.deepgram.com/v2/listen` | ws(s), no user-info; query values are treated as secrets |

## Events

Flux `TurnInfo` events map to the core's `SttEvent`s:

| Flux | Emitted |
|---|---|
| `StartOfTurn` | `SpeechStarted` (once per utterance), then `Interim` if it carries words |
| `Update` with new words | `Interim` |
| `EagerEndOfTurn` | `EagerEndOfTurn` with the transcript so far, **only when there are words** (never an empty one) |
| `TurnResumed` after an emitted `EagerEndOfTurn` | `TurnResumed` |
| `EndOfTurn` | `EndOfTurn` with the final transcript |

**Every utterance for which `SpeechStarted` was emitted ends with exactly one `EndOfTurn`; when no words were recognised its `text` is the empty string** (the contract `packages/core` relies on, 2026-11-14). This holds when Flux ends the turn, when the audio ends mid-utterance (`ForceEndTurn` is sent before `CloseStream`), and when the connection drops (the open utterance is closed with what was heard before the reconnect). An `EndOfTurn` with neither words nor a `SpeechStarted` before it is no utterance and emits nothing; words that arrive without a `StartOfTurn` still end in an `EndOfTurn` carrying them.

## Errors and logs

Every error and log line is built through `src/redact.ts` (identical in each adapter that holds a credential): upstream text is redacted as a whole before anything shortens it, and a catch-all never quotes a runtime's own message (only the error's name).
