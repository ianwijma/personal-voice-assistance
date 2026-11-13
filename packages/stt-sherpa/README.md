# @pva/stt-sherpa

`Stt` that runs entirely on this machine, on the CPU: a [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
streaming transducer (`sherpa-onnx-node` 2.0.1) plus the Silero VAD. Turn detection (`SpeechStarted`,
`EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`) is done here, from the VAD.

## Use

```ts
import * as SherpaStt from "@pva/stt-sherpa"
SherpaStt.layerConfig            // Layer<Stt, SttError | ConfigError>, reads STT_SHERPA_*
SherpaStt.layer({ model: "zipformer-en", eagerSilenceMs: 300 })  // Layer<Stt, SttError>
```

The model is loaded (and warmed up) when the layer is built, takes about 1 s for Nemotron, and the worker
is terminated when the layer's scope closes. One `transcribe` at a time per layer.

| Setting | Default | |
|---|---|---|
| `STT_SHERPA_MODEL` | `nemotron-3.5` | preset, see below |
| `STT_SHERPA_MODEL_DIR` | `<repo>/models` | |
| `STT_SHERPA_THREADS` | preset's | recogniser threads |
| `STT_SHERPA_LANGUAGE` | preset's (`auto` for Nemotron) | `en`, `nl`, … for the multilingual model |
| `STT_SHERPA_EAGER_SILENCE_MS` | 250 | silence before `EagerEndOfTurn` |
| `STT_SHERPA_FINAL_SILENCE_MS` | 600 | silence before `EndOfTurn` |
| `STT_SHERPA_MIN_SPEECH_MS` | 100 | continuous speech before `SpeechStarted` / `TurnResumed` |
| `STT_SHERPA_VAD_THRESHOLD` | 0.5 | Silero speech probability |

The options object also takes `tailPaddingMs`, `prerollMs` (400), `maxBacklogMs` (1000) and `policy`
(replaces the two silence thresholds, see below).

## Presets and models

| Preset | Model | Threads | Notes |
|---|---|---|---|
| `nemotron-3.5` | Nemotron 3.5 ASR streaming 0.6B, 320 ms chunks, int8 | 4 | multilingual (Dutch works), punctuated and cased, ~1.2 GB RSS |
| `zipformer-en` | icefall streaming Zipformer 2023-06-26 | 2 | English only, upper case, no punctuation, ~320 MB RSS |
| `fast-conformer-en` | NeMo streaming FastConformer transducer, 480 ms chunks | 2 | English only, lower case, ~400 MB RSS |

A preset (in `src/presets.ts`) names its archive, directory, four files, feature dimension, threads,
default language and tail padding; adding one is an entry of a few lines.

Models live in `models/` at the repository root (git-ignored). Fetch them with

```sh
pnpm --filter @pva/stt-sherpa download-models                 # nemotron-3.5 + silero_vad.onnx
pnpm --filter @pva/stt-sherpa download-models zipformer-en fast-conformer-en
pnpm --filter @pva/stt-sherpa download-models zipformer-en --model-dir /elsewhere
```

It skips what is already there. Building the layer without the files fails with an `SttError` naming the
missing file and this command. The script runs with `tsx`, which this package resolves from the
workspace root; it is not one of its declared dependencies.

## Design

```
main thread                                       worker thread (src/worker.mjs)
audio chunks ──memcpy into one buffer per batch,──▶ s16 → f32, 20 ms frames
               transferred (not cloned)             Silero VAD per frame ──▶ 0/1 per frame ─┐
                                                    recogniser fed only from speech onset   │
TurnDetector (pure) ◀── frames / partials / ─────── (400 ms pre-roll) until the segment     │
   │                    segment / cancelled          is finalised                           │
   └── Finalize(frame) ───────────────────────────▶ pad + inputFinished + decode + reset ◀──┘
   └── SttEvents ──▶ Stream
```

- **Worker.** Decode calls block (~55 ms each for Nemotron), so the recogniser and the VAD run in a
  `worker_threads` worker. It is plain JavaScript because worker threads inherit neither tsx's nor vitest's
  TypeScript loader and this Node build has no type stripping. The main thread does one `memcpy` per batch
  of chunks and the per-frame state machine step; no per-sample work. A worker error or exit fails the
  running stream (and every later `transcribe`), it is not restarted.
- **Bounded latency.** The main thread counts frames sent against frames the worker has reported. Beyond
  `maxBacklogMs` it drops audio instead of queueing it and logs a warning (and how much was dropped once it
  has caught up).
- **One stream.** One recogniser stream for the worker's lifetime, reset between segments (a new stream per
  utterance leaks memory in 2.0.1). The recogniser is fed only from the VAD's speech onset (with 400 ms of
  pre-roll) until the segment is finalised, so silence costs no decoding.
- **Turn detection** is `TurnDetector`, a pure state machine over per-frame VAD decisions and transcript
  updates, unit-tested with scripted input. Thresholds come from an `EndOfTurnPolicy`
  (`{ eagerSilenceMs(text), finalSilenceMs(text) }`); a semantic end-of-turn detector can replace
  `fixedSilence(250, 600)` without touching the worker or the models.

### How the eager transcript is produced

Finalising a sherpa stream ends it, and the partial transcript lags the audio by up to a chunk plus the
encoder's right context. So at `eagerSilenceMs` of silence the open **segment** is finalised for real
(tail padding, `inputFinished()`, decode, `reset`), and `EagerEndOfTurn` carries all finalised segments of
the turn joined with spaces. If the user resumes, `TurnResumed` is sent and the new speech becomes the next
segment of the same turn; at the next pause it is finalised and `EagerEndOfTurn` is sent again with both
segments. `EndOfTurn` at `finalSilenceMs` re-decodes nothing: it carries exactly the last eager text. So
the eager text always equals the final text when the user did not resume, and `EndOfTurn` costs no
decode time.

The price: after a pause longer than `eagerSilenceMs` mid-sentence, the recogniser restarts without the
left context, so casing and punctuation at the join can be off ("…punished Had given her…") and an
occasional word changes. With 250 ms this happened at the ~320 ms pauses inside `1.wav`.

Two details keep it correct:
- `Finalize` names the frame it was decided at. If the VAD saw speech after that frame by the time the
  worker gets the request, it answers "cancelled" and the segment just continues, so a resumed word is
  never cut in half.
- `reset()` keeps frames that did not fill a chunk and decodes them at the start of the next segment, so
  with too little padding the end of one turn leaks into the next ("BROTHEL" … "S GOD AS A…"). Each preset's
  tail padding is (chunk + right context) minus the ≥ 250 ms of real silence already in the stream, found
  by probing: Nemotron 400 ms, zipformer 600 ms, fast-conformer 800 ms. Only padding is left behind.

## Measured

On this machine (16 threads, CPU only), defaults (eager 250 ms, final 600 ms, min speech 100 ms), audio fed in
20 ms chunks at real time, 3 rounds over the test clips with 1.5 s of background noise between them
(`pnpm --filter @pva/stt-sherpa measure --rounds 3 [--soak-minutes 5]`, 2026-11-13):

| | `nemotron-3.5` (EN + NL, 15 turns) | `zipformer-en` (EN, 6 turns) |
|---|---|---|
| speech onset → `SpeechStarted` | median 134 ms (61–159) | median 134 ms (120–135) |
| last speech → `EagerEndOfTurn` | median 722 ms (391–1079) | median 1000 ms (363–1039) |
| last speech → `EndOfTurn` | median 1000 ms (680–1316) | median 1314 ms (679–1355) |
| eager text == final text (normalised) | 15/15 | 6/6 |
| word errors | 25/357 = 7.0 % | 3/198 = 1.5 % |
| main event-loop delay (10 ms timer) | p50 0.1, p99 1.5, max 3.8 ms | p50 0.1, p99 1.5, max 1.7 ms |
| RSS after load / after 5 min of audio (3× speed) | 1217 / 1152 MB, flat from minute 1 | 380 / 327 MB, flat from minute 1 |
| model load + warm-up | ~1.1 s | ~1.3 s |

How to read the latency rows. "Last speech" is the clip's last frame within 25 dB of its loudest, so the
VAD's hold-over after that point is included. `EndOfTurn` is always `finalSilenceMs` after the VAD reports
silence; minus 600 ms, the rows above say the VAD held on for 80 ms after the clean `0.wav` (`EndOfTurn` at
680 ms) and 260–440 ms after the Dutch clips and 715 ms after `1.wav`, whose ends carry breath or background
noise about 30 dB below the speech. Measured from the VAD's speech → silence flip, `EagerEndOfTurn` comes
260 ms (the threshold, rounded up to whole frames) plus the finalise: about 100 ms for Nemotron (400 ms of
padding is two 55 ms decodes) and about 25 ms for zipformer. `0.wav` is the representative clean case:
eager 391–443 ms (Nemotron) / 363–365 ms (zipformer), final 680 ms (both).

Word errors: for Nemotron most come from the Dutch clips (names and numbers: "Angel 2006", "continuümmodel")
and from US spelling ("dishonored", "forever"); 0/14 to 2/14 on the rest. The `1.wav` errors in both
presets come partly from segmentation: its two ~320 ms pauses are longer than the eager threshold, so it
is decoded as two or three segments (the two `TurnResumed` above), and the recogniser loses context at the
join ("…punished Had given…", zipformer's "WHO LOVED WHOSE"). A longer `eagerSilenceMs` trades eager latency
for fewer splits.

Reproduce with `pnpm --filter @pva/stt-sherpa measure [--model zipformer-en] [--rounds 3] [--soak-minutes 5]`.
The test audio is two LibriSpeech clips from the sherpa-onnx test sets (`0.wav`, `1.wav`) and three FLEURS
Dutch clips (nl_nl test split), in `models/test-wavs/` with reference texts (`refs.json`, `refs_nl.json`).
They are not downloaded by the script: `0.wav`/`1.wav` are in the zipformer archive's `test_wavs/` (texts in
`trans.txt`). The integration tests and the measurement skip with a message when they are missing. Silences between
utterances are white noise at about −70 dBFS, not digital zeros (Silero reports phantom speech on long runs
of exact zeros), and each clip is scaled so its loudest 20 ms frame is at −18 dBFS.

## Not verified

- Nothing here has been tried with a live microphone, nor with noisy, far-field or overlapping speech, nor
  with the assistant's own voice playing. All numbers are from clean read speech in WAV files.
- Input level matters: the FLEURS clips at their original level (loudest frame about −40 dBFS) made Silero
  drop out mid-sentence, splitting a turn and losing its first words. A real microphone chain needs a sane
  gain.
- Utterance ends with a soft, noisy tail (`1.wav`) hold the VAD for several hundred ms, which adds directly
  to the end-of-turn latency.
- The backlog-dropping path has not been exercised (the worker always kept up on this 16-thread machine).
- Only Dutch and English were checked for the multilingual model.
