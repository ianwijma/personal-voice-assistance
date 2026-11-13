# @pva/stt-sherpa

`Stt` that runs entirely on this machine, on the CPU: a [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
recogniser (`sherpa-onnx-node` 2.0.1), the Silero VAD and an automatic gain control. Turn detection
(`SpeechStarted`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`) is done here, from the VAD.

## Use

```ts
import * as SherpaStt from "@pva/stt-sherpa"
SherpaStt.layerConfig            // Layer<Stt, SttError | ConfigError>, reads STT_SHERPA_*
SherpaStt.layer({ model: "parakeet-ultra", eagerSilenceMs: 300 })  // Layer<Stt, SttError>
SherpaStt.checkConfig            // fails like layerConfig would for missing model files, without loading anything
```

The model is loaded (and warmed up) when the layer is built (1.5 s for Parakeet, 2.4 s for the hybrid), and
the worker is terminated when the layer's scope closes. One `transcribe` at a time per layer.

| Setting | Default | |
|---|---|---|
| `STT_SHERPA_MODEL` | `parakeet-v2` | preset, see below (`nemotron-3.5` still works: it is `nemotron-320`) |
| `STT_SHERPA_MODEL_DIR` | `<repo>/models` | |
| `STT_SHERPA_THREADS` | preset's | recogniser threads |
| `STT_SHERPA_LANGUAGE` | `auto` | `en`, `nl`, … for Whisper and Nemotron; Parakeet ignores it |
| `STT_SHERPA_EAGER_SILENCE_MS` | 250 | silence before `EagerEndOfTurn` |
| `STT_SHERPA_FINAL_SILENCE_MS` | 600 | silence before `EndOfTurn` |
| `STT_SHERPA_MIN_SPEECH_MS` | 100 | continuous speech before `SpeechStarted` / `TurnResumed` |
| `STT_SHERPA_VAD_THRESHOLD` | 0.5 | Silero speech probability |
| `STT_SHERPA_AGC` | `true` | automatic gain in front of the VAD and the recogniser |
| `STT_SHERPA_AGC_MAX_GAIN_DB` | 30 | the most the gain control may add |

All of them except the directory and the thread count are also in the web UI (Options → Assistant →
Listening), each with an explanation. The options object also takes `tailPaddingMs`, `prerollMs` (400),
`maxBacklogMs` (1000), `maxTurnMs`, `interimMs`, `agc` (`false` or the gain control's own options) and `policy`
(replaces the two silence thresholds).

## Presets: which model to choose

| Preset | Kind | Languages | Accuracy (phone-like EN) | Reply starts after you stop | Memory (process RSS) | Live words |
|---|---|---|---|---|---|---|
| **`parakeet-v2`** (default) | whole turn | English | best: 13 % WER | 0.1–0.5 s later than the turn detector alone | 1.3–1.5 GB | about once a second |
| `parakeet-ultra` | whole turn | 25 European incl. Dutch | 16.5 % EN, 17 % NL | same as v2 | 1.3–1.5 GB | about once a second |
| `whisper-turbo` | whole turn | 99 (set the language) | 17.7 % EN, 15 % NL (best Dutch) | 1–3 s | 1.5–2.2 GB | no |
| `hybrid-nemotron-parakeet` | both | English answers | as `parakeet-v2` | as `parakeet-v2` | 2.2–2.6 GB | yes, word by word |
| `nemotron-560` | streaming | 40 | 31 % | about 0.1 s | 1.0–1.2 GB | yes, word by word |
| `nemotron-320` | streaming | 40 | 34 % (the previous default) | about 0.1 s | 1.0–1.2 GB | yes |
| `zipformer-en` | streaming | English | 53 % (not recommended) | 0.03 s | 0.3–0.4 GB | yes |
| `fast-conformer-en` | streaming | English | 38 % (not recommended) | 0.05 s | 0.4 GB | yes |

Accuracy column: the mean word error rate over seven phone-like conditions of the 34-clip English / 13-clip
Dutch set in [docs/research/stt-quality.md](../../docs/research/stt-quality.md) §2.3 (models run alone).
Through this adapter, see [Measured](#measured). Rules of thumb: English only → `parakeet-v2`; Dutch too →
`parakeet-ultra` (or `whisper-turbo` if replies may start a second later); you want to see your words while
you talk → `hybrid-nemotron-parakeet`; a small machine → `nemotron-560` (accuracy suffers).

Models live in `models/` at the repository root (git-ignored). Fetch them with

```sh
pnpm --filter @pva/stt-sherpa download-models                 # parakeet-v2 + silero_vad.onnx
pnpm --filter @pva/stt-sherpa download-models parakeet-ultra whisper-turbo
pnpm --filter @pva/stt-sherpa download-models hybrid-nemotron-parakeet   # both of its models
pnpm --filter @pva/stt-sherpa download-models --list          # every preset, installed or not
pnpm --filter @pva/stt-sherpa download-models nemotron-560 --model-dir /elsewhere
```

Archives are 0.07–0.56 GB each (Parakeet 482 MB, Whisper turbo 564 MB, Nemotron 475 MB) and unpack to
0.6–1 GB. It skips what is already there. Building the layer without the files fails with an `SttError`
naming the missing file and this command; in serve mode the settings screen refuses such a preset with the
same message and the running recogniser keeps running. The script runs with `tsx`, which this package
resolves from the workspace root.

### Licences

| Preset | Model | Licence |
|---|---|---|
| `parakeet-v2` | [NVIDIA parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), int8 export by sherpa-onnx | CC-BY-4.0 (attribution: NVIDIA) |
| `parakeet-ultra` | [Moondream parakeet-ultra](https://huggingface.co/moondream/parakeet-ultra), post-trained from NVIDIA parakeet-tdt-0.6b-v3; not an NVIDIA release | CC-BY-4.0 (attribution: Moondream, NVIDIA); quality claims are the publisher's |
| `whisper-turbo` | [OpenAI Whisper large-v3-turbo](https://github.com/openai/whisper), int8 export by sherpa-onnx | MIT |
| `nemotron-560`, `nemotron-320` | [NVIDIA Nemotron 3.5 ASR streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) | NVIDIA OpenMDW-1.1 per the model card; the archive carries no licence file: check the card before relying on it |
| `hybrid-nemotron-parakeet` | both of the above | both |
| `zipformer-en` | icefall streaming Zipformer 2023-06-26 | Apache-2.0 |
| `fast-conformer-en` | NVIDIA NeMo streaming FastConformer | CC-BY-4.0 |

Read from the model cards and the sherpa-onnx release notes (2026-11-13), not verified further.

## Design

```
main thread                                          worker thread (src/worker.mjs)
audio chunks ──memcpy into one buffer per batch,──▶  s16 → f32, 20 ms frames
               transferred (not cloned)               AGC (agc.mjs) → Silero VAD ──▶ 0/1 per frame ──┐
                                                      whole turn: the turn's audio (turnAudio.mjs)   │
TurnDetector (pure) ◀── frames / partials / ───────   streaming: an online stream from the onset     │
   │                    segment / cancelled            (400 ms pre-roll)                              │
   ├── Finalize(frame) ──────────────────────────────▶ decode the whole turn (decodeAsync) or        │
   │                                                    finalise the segment ◀──────────────────────┘
   ├── Commit(frame) ────────────────────────────────▶ drop the turn's audio; collect garbage
   └── SttEvents ──▶ Stream
```

- **Worker.** Decode calls block (~55 ms per chunk for Nemotron, 0.1–3 s for a whole turn), so the
  recogniser, the VAD and the gain control run in a `worker_threads` worker. It is plain JavaScript because
  worker threads inherit neither tsx's nor vitest's TypeScript loader. A worker error or exit fails the
  running stream (and every later `transcribe`); it is not restarted.
- **Bounded latency.** The main thread counts frames sent against frames the worker has reported. Beyond
  `maxBacklogMs` it drops audio instead of queueing it and logs a warning. Whole-turn decodes run on the
  thread pool (`decodeAsync`), so the worker keeps reporting VAD decisions while a decode runs and the
  backlog stays near zero even during a 3 s Whisper decode.
- **Turn detection** is `TurnDetector`, a pure state machine over per-frame VAD decisions and transcript
  updates, unit-tested with scripted input. Thresholds come from an `EndOfTurnPolicy`
  (`{ eagerSilenceMs(text), finalSilenceMs(text) }`); a semantic end-of-turn detector can replace
  `fixedSilence(250, 600)` without touching the worker or the models.

### Whole-turn decoding (Parakeet, Whisper)

Non-streaming models are far more accurate on real-world audio, and for these sizes not slow
(stt-quality.md §2.3). They plug into the same events:

1. From the VAD's speech onset (with 400 ms of pre-roll) the worker keeps every frame of the turn, speech
   and pauses, in one preallocated buffer.
2. At `eagerSilenceMs` of silence the detector sends `Finalize`; the worker decodes **the whole turn so
   far** and answers with its text. The detector is in cumulative mode: that answer *replaces* the turn's
   text, and `EagerEndOfTurn` carries it.
3. If the user goes on (`TurnResumed`), the buffer keeps growing, and the next pause decodes the whole turn
   again from its start: no segments are joined, so the context loss at a join is gone.
4. `EndOfTurn` at `finalSilenceMs` carries the last answer unchanged (no re-decode), so the speculative
   text equals the final text whenever the user did not resume, and the speculative reply is promoted. For
   a long turn whose decode is still running at the final threshold, `EndOfTurn` comes when it finishes,
   without an `EagerEndOfTurn` before it.
5. The detector then sends `Commit(frame)`; the worker drops the turn's audio (keeping the onset of a new
   turn that already started after that frame).

- **Speech while a decode runs** is held: the answer arrives with the user speaking, the detector keeps it
  and the next pause decodes again. A `Finalize` decided before the speech (by frame number) is still
  answered; the worker only cancels one whose frame it has already seen speech after.
- **Interim text**: Parakeet re-decodes the turn so far every 1 s of speech (`interimMs`), for the first
  10 s of a turn, only while the VAD says speech and no other decode is queued. That keeps the "say a few
  words" barge-in mode working (it needs words, and with no interims it waited for a pause) and shows live
  words, at the cost of about one extra 0.1–0.25 s decode per second of speech on the thread pool. Whisper
  has none (a decode takes 1–3 s); the hybrid preset takes its live words from Nemotron instead.
- **Bounds**: a turn longer than `maxTurnMs` (30 s for Parakeet, 28 s for Whisper, whose encoder sees at
  most 30 s) is decoded up to the next silence frame (hard cut 5 s later), and the rest becomes a new piece
  whose text is appended. The recogniser's memory grows with the longest input it has decoded, so the cap
  also bounds memory.
- **Noise**: a turn whose speech never reached `minSpeechMs` gets no text in cumulative mode, whatever the
  model made of it (Parakeet sometimes turns a click into "Yeah.").
- **Hybrid**: Nemotron 560 ms with a fresh stream per turn runs beside Parakeet in the same worker, only for
  `Interim`s; partials never resume a turn (Nemotron's text lags the audio and catches up after the pause;
  resumption is the VAD's call), and they are muted from the eager point until the VAD hears speech again.

### Streaming (Nemotron, Zipformer, FastConformer)

Finalising a sherpa stream ends it, and the partial transcript lags the audio by up to a chunk plus the
encoder's right context. So at `eagerSilenceMs` of silence the open **segment** is finalised for real (tail
padding, `inputFinished()`, decode), and `EagerEndOfTurn` carries all finalised segments of the turn joined
with spaces. If the user resumes, `TurnResumed` is sent and the new speech becomes the next segment.
`EndOfTurn` re-decodes nothing.

Changed after the study (stt-quality.md §1.3): each segment gets a **fresh stream** instead of
`recognizer.reset()` on one stream. `reset()` lost accuracy in sherpa-onnx 2.0.1 (clean 16.8 → 19.3 % WER,
noisy 42.9 → 54.8 %, same model) and kept unprocessed frames that leaked into the next turn. A new stream
per segment leaked memory only because V8 rarely collects the small JS wrappers that own the native
memory; the worker now forces a garbage collection once per turn (a few ms, on the worker thread), and RSS
stays flat (see Measured). The tail padding still flushes the last words (Nemotron 320 ms: 400 ms;
560 ms: 640 ms). The join problem remains for streaming models: after a pause longer than
`eagerSilenceMs` mid-sentence, the recogniser restarts without left context. Raise
`STT_SHERPA_EAGER_SILENCE_MS` to 400 for fewer splits, or use a whole-turn or the hybrid preset.

### Level handling: gain control and VAD threshold

Quiet input is a real risk: at peaks of −40 dBFS the VAD missed 31 % of voiced frames and WER doubled
(stt-quality.md §1.3, E1). `agc.mjs` runs per 20 ms frame in front of the VAD and the recogniser: instant
attack, ~13 s release, at most +30 dB, no change while the peak envelope is below −48 dBFS, and it never
turns audio down. One protection beyond the study: the gain is capped so the estimated noise floor (the
quietest 20 ms of the last ~5 s) is never raised above −50 dBFS RMS, so steady noise, a fan, room tone or
the server's −75 dBFS floor cannot be pumped into something the VAD takes for speech. Quiet speech over a
quiet floor still gets up to +25–30 dB. The VAD threshold stays at 0.5: with the gain control on, 0.35
recognised no better on the degraded set and held on longer after the speech (see Measured).

What it cannot tell apart: a quiet echo of the assistant's own voice is speech, and gets the same gain as
quiet speech from you. The echo gate (`Speakers: say a few words` mode) and the browser's echo
cancellation handle echo; see Measured for how much more often a quiet echo is detected with the gain on.

## Measured

MEASURED-PLACEHOLDER

## Is it the audio or the model?

See the main README, "Is it the audio or the model?": serve mode can save every turn as the server heard it
(`RECORD_HEARD_AUDIO`), and `pnpm start compare-models <wav>` runs every installed preset on such a file
through this adapter.

Reproduce the measurements with `pnpm --filter @pva/stt-sherpa measure [--model …] [--rounds 3]
[--soak-minutes 5 --soak-speed 1]` (clean clips), `… measure --model … --set [--conditions …] [--lang en]`
(the degraded set) and `pnpm --filter @pva/stt-sherpa false-triggers` (noise). `--baseline` runs a copy of the
adapter as it was before this change, if present in `src/baseline.tmp/`.

The clean test audio is two LibriSpeech clips from the sherpa-onnx test sets (`0.wav`, `1.wav`) and three
FLEURS Dutch clips, in `models/test-wavs/` with reference texts (`refs.json`, `refs_nl.json`); the degraded
set is the study's, copied to `models/test-wavs/stt-quality/` (`cond/<condition>/*.wav`, `items.json`; from
LibriSpeech, EdAcc, AMI and FLEURS, CC-BY-4.0 / CC-BY-SA-4.0). Neither is downloaded by a script. The
integration tests and the measurement skip with a message when they are missing. Silences between
utterances are white noise at about −70 dBFS, not digital zeros (Silero reports phantom speech on long runs
of exact zeros).

## Not verified

- Nothing here has been tried with a real phone microphone. The degraded set is synthetic (FIR band-pass,
  pink noise, synthetic reverb), not recorded phone audio.
- The gain control was tested on single clips and constructed noise, not on a long conversation with loud
  and quiet speakers alternating, nor with real TTS leaking into a real microphone.
- Whisper turbo returns lower case without punctuation in this sherpa-onnx build (not investigated).
- Parakeet Ultra can mistake the language on very poor audio (no language hint is exposed for it).
