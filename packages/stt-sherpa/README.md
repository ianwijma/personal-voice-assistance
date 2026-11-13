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

`src/worker.mjs` only loads the models; the logic on the worker side is `src/recognizerCore.mjs` (with
`decodeQueue.mjs` and `turnAudio.mjs`), which the test stand-ins (`test/fake-*.mjs`) run with fake models
(`test/fakeModels.mjs`), so boundary cuts, segment checkpoints and the decode-queue bound are tested as they
run in production. Bounds: whole-turn decodes waiting are at most two longest pieces of audio (a decode that
never returns drops the turn, logged); a streaming segment is checkpointed at a 200 ms pause after 5 s (8 s
regardless) and keeps 30 s of frames, so a boundary cut decodes again at most one piece. A checkpoint forced in the
middle of speech (the 8 s one) starts the next stream 2 s before the cut and joins the two texts where their words
match (`reconcile`), because a fresh stream with no left context split or dropped the word at the cut
(`scripts/checkpoint-quality.ts`, results below under Measured).
`scripts/replay-cost.ts` measures what a cut costs the worker with the installed streaming models: all of it,
the piece decoded again up to the boundary and the frames after it fed again to start the next segment
(`stats.replayedFrames` + `stats.refedFrames`). 2026-11-14, worst case (no pause, the next sentence 1 s along):
nemotron-560 0.90 s, nemotron-320 1.31 s, zipformer 0.32 s, fast-conformer 0.35 s (7.4 s replayed + 0.9 s fed
again); with the next sentence 3 s along (more than the main thread's 1 s backlog limit lets the worker get
ahead) 1.13 / 1.77 / 0.36 / 0.43 s. Before the checkpoints a cut decoded the whole kept segment: 4.6 / 5.2 /
1.1 / 1.4 s. The frames fed again are the next sentence's, which must be decoded anyway; they are bounded by how
far the worker is past the boundary when the finalise arrives.

- **Worker.** Decode calls block (~55 ms per chunk for Nemotron, 0.1–3 s for a whole turn), so the
  recogniser, the VAD and the gain control run in a `worker_threads` worker. It is plain JavaScript because
  worker threads inherit neither tsx's nor vitest's TypeScript loader. A worker error or exit fails the
  running stream (and every later `transcribe`); it is not restarted.
- **Bounded latency.** The main thread counts frames sent against frames the worker has reported. Beyond
  `maxBacklogMs` it drops audio instead of queueing it and logs a warning. Whole-turn decodes run on the
  thread pool (`decodeAsync`), so the worker keeps reporting VAD decisions while a decode runs and the
  backlog stays near zero even during a 3 s Whisper decode.
- **Every utterance is closed.** Each utterance that got `SpeechStarted` ends with one `EndOfTurn`; when no
  words were recognised (noise the VAD took for speech, a turn dropped because decoding fell behind, input that
  ended first) its `text` is empty, so a consumer knows the utterance is over and starts nothing. An utterance
  that never got `SpeechStarted` (shorter than `minSpeechMs`) produces no event at all, and `EagerEndOfTurn` is
  never empty. (Until 2026-11-14 an utterance without words ended with no event.) When a turn is dropped while
  its `Finalize` waits behind a stalled decode, that `Finalize` is answered at once with no text, and the
  stalled decode's text, when it comes, is not added to the dropped turn.
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
- **A slow decode** (Whisper, or a long turn) that is still running when the final threshold passes ends the
  turn there: if the user starts the next sentence before the answer arrives, that sentence is a new turn,
  and the finished turn is decoded through the frame where it ended (`Finalize` with `through`), so the new
  speech neither joins it nor is lost. (Before this fix, one Whisper run merged a whole timeline into one turn.)
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

**Streaming checkpoints and accuracy** (`scripts/checkpoint-quality.ts`, 2026-11-14): the English clips of the
quality set longer than 7 s plus two read passages with no pause (24 s, 41 s), 428 words, 159 s, through the
worker logic and the turn detector as in production. Word error rate:

| Model | Whole segment (no checkpoints) | 8 s hard cut (third review) | 8 s cut with 2 s overlap (now) |
|---|---|---|---|
| nemotron-560 | 11.68 % | 11.92 % | 11.68 % |
| nemotron-320 | 12.85 % | 14.49 % | 12.85 % |
| zipformer-en | 16.82 % | 17.52 % | 16.59 % |
| fast-conformer-en | 8.88 % | 9.58 % | 9.11 % |

Checkpoints at pauses changed no word on any clip. The plain 8 s cut split or dropped the word it fell in
("squalid quar | of", "soul in he", "mortals and to | finally": *be* dropped). With the overlap, all 11 joins of
each model were reconciled on matching words; the cost is 2 s decoded twice per forced cut (12 s of 159 s here,
only in speech with no 200 ms pause for 8 s). Cutting at short VAD gaps instead (tried) still split words: Silero
rarely reports a gap inside fluent speech.


On this machine (AMD Ryzen 9 7945HX, 16 threads, CPU only, 30 GB), 2026-11-13/14, through this adapter
(`scripts/measure.ts`, audio fed in 20 ms chunks at real time), with the defaults (eager 250 ms, final
600 ms, VAD 0.5, gain control on). "Previous" is the adapter as it was before this change with its default
(`nemotron-3.5`, VAD 0.5, no gain control, one stream with `reset()`).

**Degraded set** (34 English clips × 7 conditions, 526 words each, from stt-quality.md §2.2; WER normalised
as in the study; one timeline per condition, clips 1.5 s apart, each clip at its own level):

| WER % | clean | tel | lp7k | quiet | noise15 | reverb | combo | **all** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| **`parakeet-v2`** (new default) | 12.2 | 14.3 | 11.6 | 12.5 | 13.9 | 18.9 | 18.9 | **14.6** |
| `nemotron-320` through the new adapter (gain control, fresh streams) | 20.5 | | | 19.1 | | | 42.7 | (27.4 on these 3) |
| previous default, earlier scoring¹ | 27.2 | 34.4 | 28.0 | 30.7 | 35.3 | 45.9 | 55.8 | **36.8** |
| `parakeet-v2`, earlier scoring¹, VAD 0.35 | 11.2 | 15.8 | 12.9 | 19.9 | 14.7 | 17.0 | 40.0 | **18.8** |

¹ The first runs assigned a turn to the clip during which its `EndOfTurn` arrived; a slow `EndOfTurn` after
the next clip had started was credited to that clip (and the first clip counted as missed), which inflates
both rows' errors, most in `quiet` and `combo`. The scorer now assigns a turn by when it started; the new
default's row was re-scored from the saved events. The previous default was not re-run (the study already
establishes the gap: 33.7 % vs 13.3 % mean, models alone). Compare the two "earlier scoring" rows with each
other: 18.8 vs 36.8 %.

Latency on the same set (ms after the clip's last loud frame, medians over all conditions): `parakeet-v2`
speculative 562, final 770 (clean: 440 / 671); previous default (earlier scoring) 494 / 750 (clean:
407 / 670). The speculative text equalled the final text in 155 of 234 turns: a long or resumed turn is
decoded again, and a decode still running at the final threshold gives `EndOfTurn` without an eager event.
68 of 238 clips were split into two turns, by pauses longer than 600 ms in the (conversational) clips.

**VAD threshold, with the gain control on** (`parakeet-v2`, same set, same scoring), 0.5 vs 0.35: WER all
14.6 / 15.0 % (clean 12.2 / 11.2, tel 14.3 / 15.8, quiet 12.5 / 11.0, noise15 13.9 / 14.7, reverb 18.9 / 17.2,
combo 18.9 / 22.4), clips split into two turns 68 / 46; final transcript after the speech, median 770 / 949 ms
(quiet 791 / 1381, noise15 1111 / 1350, combo 1180 / 1690: 0.35 holds on to noisy tails). Same accuracy,
0.2 s faster: 0.5 stays the default, and the gain control does the work for quiet input (quiet 12.5 % here
against 30.7 % for the previous default, earlier scoring).

**Clean clips** (`0.wav`, 18 words; `1.wav`, 48 words with two ~320 ms pauses; 3 rounds):

| | `parakeet-v2` | previous default |
|---|---|---|
| word errors | 0/198 | 25/357 (with the Dutch clips; 7.0 %) |
| `0.wav`: speculative / final after the last loud frame | 506–524 / 679–681 ms | 391–443 / 680 ms |
| `1.wav` (16 s): final | 1585–1968 ms² (one turn, no split) | 1000–1316 ms (split by its pauses) |
| speculative text == final text | every turn that had one | 15/15 |
| main event-loop delay (10 ms timer) | p50 0.1, p99 1.5, max 4.5 ms (max 20–32 ms during the 30-minute set runs, both adapters) | p50 0.1, p99 1.5, max 2.8 ms |

² The 16 s sentence is decoded at the end (0.6 s with 8 threads) after a ~0.7 s VAD hold on its noisy tail:
whole-turn decoding costs about the study's predicted +0.36 s on very long turns, nothing on short ones.

**Memory** (process RSS, `measure --soak-minutes 5`, the clean clips looped; real time for whole-turn
presets, 3× for streaming):

| preset | after load | after 1 min | after 5 min |
|---|--:|--:|--:|
| `parakeet-v2` | 1.28 GB | 1.66 GB | 1.66 GB (flat) |
| `hybrid-nemotron-parakeet` | 1.97 GB | 2.37 GB | 2.38 GB (flat) |
| `nemotron-560` (fresh stream per segment) | 1.20 GB | 1.18 GB | 1.18 GB (flat) |
| previous default | 1.19 GB | 1.16 GB | 1.16 GB |
| `parakeet-ultra` / `whisper-turbo` | 1.31 / 1.87 GB | 1.50 GB / 2.67 GB (after a 30 s turn) | not soaked |

The recogniser's memory grows with the longest input it has decoded (a 3× soak that merged clips into
60 s turns reached 2.96 GB), hence the 30 s cap on a turn's piece.

**Other presets, clean clips, 1 round**: `parakeet-ultra` 6/119 word errors with the Dutch clips;
`nemotron-560` 18/357 (5.0 %, 3 rounds, EN + NL); `hybrid-nemotron-parakeet` 0/198, same latency as
`parakeet-v2`; `whisper-turbo` (language auto): the English and Dutch clips came out right by eye (not
scored: its first scored run hit the slow-decode bug fixed below), final 1.1–3.3 s after the speech.

**False triggers** (`false-triggers`, 60 s of each noise through the real adapter, VAD 0.5 / 0.35 / 0.3, gain
control off / on): the server's −75 dBFS floor, white noise at −55 and −45 dBFS, pink noise at −50, −40 and
−30 dBFS, 50 Hz hum at −35 dBFS and clicks at −20 dBFS gave **no** `SpeechStarted` and no turn in any of the
96 runs. Speech-like noise (six overlapping voices at −45 dBFS RMS) gave 2–6 `SpeechStarted` per minute
without the gain control and 1 with it (the noise cap holds the gain down), and 1–2 false turns per minute
without it, 0 with it. The assistant's own voice played back at −40 or −50 dBFS peak (an echo) is detected
as speech with or without the gain control (12–13 starts per minute either way): echo is the echo gate's
and the browser's job, and the gain control does not make it worse here.

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
