# Why speech recognition is poor from the iPhone, and which STT models to offer

Research note, 2026-11-13. Machine: Linux x86_64, 16 cores, no GPU, `sherpa-onnx-node` 2.0.1, Node 22.

Legend. **[M]** measured on this machine in this study. **[R]** read from a source (linked in §7), not verified here.
Nothing in here was tried on a real iPhone: there is still no recording of the phone's audio. §1.4 specifies the
feature that settles it.

## 0. Summary

1. **The default model is the weakest capable option on anything that is not clean read speech [M].** On a 47-clip set
   (34 English incl. accented and meeting speech, 13 Dutch) with 7 phone-like degradations, Nemotron 3.5 streaming
   (current default) scores a mean WER of 33.7 % English / 33.3 % Dutch; Parakeet-TDT-0.6B v2 scores 13.3 % English;
   Whisper large-v3-turbo scores 15.0 % Dutch. The earlier "7 %" came from five clean read clips; on the *clean* version of the harder English clips the same model gets
   21.4 % (38.5 % on accented conversational speech). The model alone can explain "really bad on the phone".
2. **The streaming plumbing costs accuracy on top of the model [M].** `recognizer.reset()` between segments loses accuracy
   (clean 16.8 → 19.3 % WER, noisy+quiet+reverb 42.9 → 54.8 %, same model), and finalising at 250 ms of silence splits
   turns (clean 17.2 % unsplit → 23.4 % with 250 ms, 58 segments from 34 clips). A fresh stream per segment avoids the
   first; it did not leak without bound in a 200-stream test (RSS plateaus at +270–530 MB).
3. **Level is a real risk but fixable [M].** At peaks of −40 dBFS the VAD misses 31 % of voiced frames and WER doubles
   (17.6 → 35.8 %). A server-side AGC (instant attack, slow release, ≤ +30 dB) plus VAD threshold 0.3 brings −40 dBFS
   back to 16.6 % (18.6 % with AGC alone). Whether the phone really delivers quiet audio is unknown until it is recorded.
4. **The resampler is not the problem [M].** 8/16/22.05/24/32/44.1/48 kHz → 16 kHz: flat to 6.5 kHz (−0.3 dB), −1.8 dB at
   7 kHz, ≥ 53 dB alias rejection above 9 kHz, no drift over 60 s, bit-identical across block sizes, 39.5 dB round-trip SNR.
5. **The most likely iOS-specific cause is voice processing [R].** With `echoCancellation: true` Safari runs the iOS
   voice-processing unit (VPIO); a WebKit engineer says it is no longer used when `echoCancellation` is false. VPIO is
   what band-limits, ducks and changes levels. Settle it with an A/B recording (§1.4); do not guess.
6. **Non-streaming models are far more accurate and, for these sizes, not slow [M].** Parakeet-TDT-0.6B decodes a finished
   2.9 / 5.3 / 13.9 s segment in 0.11 / 0.18 / 0.46 s (median, 4 threads); Whisper turbo needs 1.0 / 1.3 / 2.7 s.
7. **Recommended default: Parakeet-TDT-0.6B v2 (English), decoded once per turn at the 250 ms eager point (§3.2).** Cost
   versus the current streaming finalise (~0.1 s): about +0.01 / +0.08 / +0.36 s for 3 / 5 / 14 s turns. Eager+final texts
   stay identical and the context-loss at joins disappears because the whole turn is decoded at once.
8. **Dutch:** Parakeet Ultra (Moondream's post-trained v3, CC-BY-4.0) and Whisper turbo are the two good options; official
   Parakeet v3 mislabels language on band-limited audio (Dutch telephone-band WER 34.8 % vs Ultra 17.2 %).
9. **Distil-Whisper large-v3.5 is unusable in sherpa-onnx 2.0.1** for short utterances: it repeats the sentence (27 of 231
   English items ≥ 80 % WER). Zipformer-en and FastConformer-en are the worst on this set and cannot do Dutch.
10. **Not measured:** real phone audio, real microphone, false-trigger rate of a lower VAD threshold, Cohere Transcribe,
    Parakeet-unified streaming, SenseVoice, Canary (see §4).

## 1. Part A: the audio path, critically

### 1.1 What the code does (read from the repository)

- Capture: `getUserMedia({channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true})`
  (`apps/web/src/lib/audio/VoiceAudio.ts:36`), one `AudioContext` at the device rate created *before* `getUserMedia`
  (`:110`, `:121`; this matches the workaround for WebKit 275801), `createMediaStreamSource` → `pva-capture` worklet.
- Worklet (`apps/web/worklets/capture.js`, `resampler.js`): mono mix, Blackman-windowed sinc resampler (12 zero crossings,
  cut-off 0.94 × output Nyquist), bypass when the context is already 16 kHz, clip to ±1, round to s16, 320-sample frames.
- Transport: 8-byte header with a u32 sequence number; the server reports `mic_gap` to the client on a sequence gap
  (`SessionHub.ts`, `micSequenceGap`) but logs nothing server-side and keeps no statistics.
- Server (`packages/audio-web/src/WebAudio.ts`): frames go into `Queue.sliding(50)` (`:104`): a consumer more than 1 s
  behind silently loses the *oldest* audio; no counter. When the mic is not routed (`routed()` false: not live, or the
  echo gate suppresses it) a −75 dBFS white-noise floor is substituted (`:62`), so speech in that state is thrown away.
- STT worker (`packages/stt-sherpa/src/worker.mjs`): Silero VAD threshold 0.5, `minSpeechDuration` 0.01 (timing is in the
  TurnDetector, 100 ms), 400 ms pre-roll, one recogniser stream `reset()` after every segment, finalise at 250 ms.
  `maxBacklogMs` 1000 drops audio when the worker is behind.
- Nothing measures the level, the band or the noise floor anywhere on the path. That is the gap.

### 1.2 Suspected causes, ranked

| # | Cause | Likelihood | Evidence | Confirm from a recording | Fix |
|---|---|---|---|---|---|
| 1 | **Model too weak for real-world audio** (accents, noise, reverb, phone band) | **High** | [M] Nemotron-320: 21.4 % clean → 33.7 % mean over 7 conditions; Parakeet v2 10.8 → 13.3 % (§2.3) | Transcripts of the *same* WAV by several models: if only Nemotron is bad, it is the model | Switch default (§3) |
| 2 | **Segmentation + `reset()`** loses context at 250 ms pauses | **High** for conversational speech | [M] §1.3 E2, E4 | Check `segments[]` of the recording: > 1 segment inside a sentence | Decode the whole turn once (non-streaming) or fresh stream per segment, `eagerSilenceMs` ≥ 400 for streaming |
| 3 | **iOS voice processing (VPIO)**: band-limiting, level changes, ducking, artefacts | **Medium-high** (iOS-specific) | [R] WebKit 192932 ("no longer using VPIO if echoCancellation is false"), 179411, 218012, 311451, 326286 | Spectrum roll-off, level, noise floor in the report; A/B take with all three processors off | Offer "processing off" take/option; if better, default to `echoCancellation:false` and handle echo with the existing echo gate / headphones |
| 4 | **Low level** (AGC not active or VPIO attenuation); VAD drops words | **Medium** (unknown real level) | [M] −40 dBFS: WER 17.6 → 35.8 %, 31 % of voiced frames missed | Peak/RMS in the report: peak < −30 dBFS is the danger zone | Server AGC (below), VAD threshold 0.35, show a live level meter |
| 5 | **Narrow band** (Bluetooth HFP 8/16 kHz mic, "wideband" that is really < 3.5 kHz) | **Medium if AirPods/BT**, low on built-in mic | [R] Apple dev list 2018, LiveSwitch guide; [M] 300–3400 Hz costs Nemotron +6 pt, zipformer +29 pt, Parakeet v2 +1.6 pt | `rolloff99Hz` < 4 kHz ⇒ narrowband | Cannot be restored; choose band-robust models (Parakeet v2/Ultra); tell the user to use the phone mic |
| 6 | **Noise / far field / reverb** | **Medium** | [M] noise15: +14–17 pt for Nemotron, +2 for Parakeet v2; reverb +19 pt for Nemotron | SNR estimate, listen to the WAV | Model choice; try processing off (NS artefacts hurt ASR more than steady noise) |
| 7 | Frame loss, bursts, reordering | **Low-medium** | WebSocket is ordered and reliable; but `Queue.sliding(50)` and `maxBacklogMs` drop silently, and a throttled Safari tab can deliver a > 1 s burst | New counters: seq gaps, frames dropped by the sliding queue, max inter-arrival gap | Count and log them; raise the queue to ~250 frames; drop only when the VAD says silence |
| 8 | Sample-rate mismatch inside Safari (context rate vs capture rate after VPIO) | **Low-medium**, cannot be judged from code | [R] WebKit 275801, 239956, 217147 | Report `ctx.sampleRate` and `track.getSettings().sampleRate`; compare `native.wav` (before resampling) with `heard.wav` | Keep ctx created before `getUserMedia` (done); never request `sampleRate` with echo cancellation on |
| 9 | Resampler | **Very low** | [M] §1.3 E5 | Same as 8 | none |
| 10 | Server noise floor substitution | **Low** (−75 dBFS white noise is benign for Silero) but it hides a muted/gated mic | code | Count frames sent as noise floor vs real | Log `micRouted` transitions; show "mic gated" in the UI |
| 11 | VAD threshold 0.5 / min speech 100 ms | **Medium** at low level or noise | [M] E3: thr 0.25 vs 0.5: quiet 29.2 → 27.2 %, noise15 32.6 → 29.9 %, combo 59.8 → 47.5 % | `speechProb` histogram; segments that start late | Threshold 0.35 (not 0.25 until the false-trigger rate is measured) |
| 12 | Safari playback side effects while the mic is open (ducking, crackle on iOS 26.2–27 with EC) | Affects TTS playback, not the transcript | [R] WebKit 218012, 311451, 326286 | n/a | n/a (note for the TTS owner) |

### 1.3 Measurements for Part A (all [M], Nemotron-3.5-320 through the emulated worker unless stated)

Harness: `spike-stt2/work/pipeline.mjs` replicates `worker.mjs` (Silero VAD per 20 ms frame, 400 ms pre-roll, finalise at
the eager threshold with 400 ms padding, `reset()`), clips surrounded by the server's −75 dBFS noise floor.

**E1: input level** (10 English clips; "speech detected" = share of voiced frames the VAD flagged; WER %):

| peak dBFS | −12 | −20 | −30 | −35 | −40 | −45 | −50 |
|---|---|---|---|---|---|---|---|
| as is, thr 0.5 | 17.6 (96 %) | 18.2 (95 %) | 21.8 (91 %) | 24.4 (88 %) | **35.8 (69 %)** | 46.3 (53 %) | 70 (48 %) |
| + AGC | 16.0 | 17.6 | 17.3 | 16.9 | 18.6 | 27.4 | 70 |
| + AGC + thr 0.3 | 17.6 | 16.9 | 17.6 | 19.5 | **16.6** | 24.1 | 64.8 |

(`makeAgc` below. The −50 dBFS column does not improve because the AGC refuses to amplify below −48 dBFS so it does not
pump the −75 dBFS floor. 10 clips ≈ 160 words: ±3 pt noise.)

**E2/E4: segmentation and reset** (all 34 English clips; eager threshold sets where the turn is split):

| eager silence | 250 ms | 400 ms | 600 ms | never split |
|---|---|---|---|---|
| clean WER % (segments) | 23.4 (58) | 20.8 (52) | 19.7 (41) | 17.2 (33) |
| noise15 WER % | 32.6 | 30.3 | 28.8 | 28.4 |

| same model, same clips | clean | combo (−35 dBFS, 7 kHz, reverb, noise 15 dB) |
|---|---|---|
| new stream per clip | 16.8 | 42.9 |
| one stream, `reset()` between clips | 19.3 | 54.8 |

New stream per clip: 200 streams of a 3 s clip, RSS 1055 → 1310 (40) → 1577 (80) → 1576 MB (200) without forced GC;
1324 MB flat with `--expose-gc`. The README's "leaks memory" is not reproduced in this short test; re-run the 5-minute soak
before relying on this.

**E3: VAD threshold** (WER %, eager 250; AGC in brackets): clean 23.4/22.6/22.2 for thr 0.5/0.35/0.25;
quiet (−35 dBFS) 29.2 (25.7) / 29.0 (23.7) / 27.2 (24.7); noise15 32.6 / 31.3 / 29.9; combo 59.8 (44.8) / 51.2 (42.3) / 47.5 (42.7).

**E5: resampler** (the worklet's own `StreamResampler`, 128-sample blocks):

| source rate | gain at 100 Hz–6.5 kHz | 7 kHz | 7.5 kHz | alias of 8.5 / 9 / 10 / 12 kHz tones |
|---|---|---|---|---|
| 22.05, 24, 32, 44.1, 48 kHz | 0.0 dB (−0.3 at 6.5 kHz) | −1.8 | −5.8 | −27.5 / −53.3 / −75.4 / −88 dB |
| 8 kHz (upsampled) | 0.0 (−1.0 at 3.4 kHz) | n/a | n/a | n/a |
| 16 kHz | bypass, exact | | | |

60 s of input gives exactly 960 000 output samples at 44.1/48/24/8 kHz. 128 vs 1024 vs 480-sample blocks: max difference 0.
16 → 48 → 16 kHz and 16 → 44.1 → 16 kHz round trips of speech: 39.5 dB SNR. The 7 kHz droop is harmless for ASR.

### 1.4 The diagnostic feature (specification)

Goal: in one minute, show what the server actually received and what every model makes of it. Put it in Settings →
"Test my microphone".

**Flow.** 1. The page shows a reference sentence (an English Harvard sentence, and a Dutch one; both with a number,
so WER is meaningful). 2. Press **Record 10 s** and read it. 3. The page shows the report card below. 4. Press **Record
again with processing off** (all three constraints `false`) and the two cards sit side by side. Optional third take:
only `echoCancellation:false`, which isolates VPIO.

**Capture.** Add a tap `micTap?: (pcm: Uint8Array) => void` in `WebAudio.micFrame` (before any gain). A
`DiagnosticsRecorder` (new, `apps/assistant/src/serve/`) buffers 10 s of exactly what reaches the recogniser and writes
`data/diagnostics/<iso>-<id>/heard.wav` (16 kHz s16) plus `meta.json`. In the browser, the capture worklet additionally
posts the pre-resample Float32 block at the context rate for the same 10 s; the page uploads it (`PUT /api/diag/<id>/native`)
as `native.wav` (a 48 kHz copy is ~1.9 MB). Comparing the two tells "damage before the page" from "damage in our
resampling/transport".

**Browser facts in `meta.json`.** `navigator.userAgent`, `ctx.sampleRate`, `ctx.baseLatency`, `track.label`,
`track.getSettings()` (`sampleRate`, `channelCount`, `echoCancellation`, `noiseSuppression`, `autoGainControl`: report
what Safari *says*, which may be absent or wrong), the constraints requested, the list of input devices (a label with
"AirPods"/"Bluetooth" is the HFP hint), `playbackActive` during the take.

**Server statistics** (reference implementation in the Appendix; it ran correctly on the degraded test clips: it flagged the
300–3400 Hz clip as NARROWBAND with roll-off 3188 Hz and the −35 dBFS clips as TOO QUIET):

| field | meaning | red flag |
|---|---|---|
| `peakDbfs`, `rmsDbfs`, `speechRmsDbfs` | levels | peak < −30 (too quiet), < −18 (low) |
| `noiseFloorDbfs`, `snrDb` | 10th-percentile frame RMS; speech minus floor | snr < 15 |
| `clippedPct` | share of samples ≥ 0.9995 | > 0.05 % |
| `rolloff99Hz`, `energyAbove3400Pct`, `energyAbove5000Pct` | estimated speech band | roll-off < 4 kHz = narrowband |
| `dcOffset` | mean sample | > 0.01 |
| `speechFramesPct`, Silero probability histogram | VAD view | speech frames < 15 % of a read sentence |
| transport | frames received, seq gaps, frames dropped by the sliding queue, max inter-arrival gap, frames sent as noise floor | any drop or gap > 200 ms |

The same numbers (peak/RMS/floor/roll-off over the last 5 s) should also be logged every 10 s and shown as a live meter,
at no cost; that alone would have shown the problem.

**Transcripts.** For each installed STT preset, run `heard.wav` through the same code path as live (VAD → segments → model,
so the *segmentation* is visible too) and show: transcript, WER against the reference sentence, number of segments, decode
ms. One model is loaded at a time and freed afterwards. Include an audio player for `heard.wav` and a download link. Add
two buttons that re-run the transcripts after "+AGC" and "+10 dB" so the owner can see whether level alone fixes it.

**How to read the result.** Peak < −30 dBFS ⇒ cause 4; roll-off < 4 kHz ⇒ cause 5; processing-off take clearly better ⇒
cause 3; `heard` and `native` differ in spectrum ⇒ cause 8/9; only Nemotron wrong while Parakeet is right ⇒ cause 1; more
than one segment inside the sentence ⇒ cause 2; transport counters non-zero ⇒ cause 7.

## 2. Part B: models

### 2.1 What exists (release `asr-models`, listing fetched 2026-11-13) [R]

Checked at <https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models> (500+ assets). New since the earlier work:
Parakeet-TDT 0.6B **v2/v3/ultra/redux** (int8, offline), **Parakeet-unified-en** (offline and streaming 240/560/1120 ms),
**Nemotron 3.5 streaming** 80/160/320/560/1120 ms, Cohere Transcribe 14-lang (1.7 GB), Qwen3-ASR 0.6B, FunASR-nano, Moonshine
(`*-quantized-2026-02-27`), Whisper tiny→large-v3/turbo/distil, Canary-180M-flash. There is no Dutch-specific streaming model
in the list; the only streaming option with Dutch is Nemotron 3.5.

**Parakeet "ultra" and "redux" are not NVIDIA releases.** They are Moondream derivatives of parakeet-tdt-0.6b-v3 (ultra:
post-trained, same architecture/tokenizer, CC-BY-4.0; redux: 1.58-bit, 178 MB, needs Moondream's kernel) [R]. Their
benchmark numbers are Moondream's own. Ultra was measured here; redux was not.

Downloaded and measured (3.78 GB of archives): Nemotron-3.5 560 ms (the 320 ms one already existed), Parakeet v2, v3, ultra,
Whisper turbo, Whisper small, Whisper distil-large-v3.5, Moonshine base-en. Existing: Nemotron-3.5 320 ms, zipformer-en,
fast-conformer-en 480 ms. Not downloaded (budget): Cohere Transcribe (2 B, Apache-2.0, Dutch listed [R]), Parakeet-unified
streaming, SenseVoice (no Dutch), Canary-180M-flash (en/es/de/fr, no Dutch), Qwen3-ASR, Parakeet redux.

### 2.2 Test set (built here; `spike-stt2/wav/`)

| source | clips | content | licence |
|---|---|---|---|
| repo `models/test-wavs` 0.wav, 1.wav | 2 | LibriSpeech clean, one has 320 ms pauses | CC-BY-4.0 |
| LibriSpeech `test-other` (HF `openslr/librispeech_asr`) | 8 | harder read speech | CC-BY-4.0 |
| EdAcc (HF `edinburghcstr/edacc`, test) | 14 | accented *conversational* English (Scottish, Chinese, Spanish, Latin American, Bulgarian, Indian, Nigerian…), 2.4–11 s | CC-BY-SA-4.0 |
| AMI IHM (HF `edinburghcstr/ami`, test) | 10 | meeting speech, headset, disfluent, some very quiet | CC-BY-4.0 |
| repo FLEURS nl-NL 3 + FLEURS nl_nl test 10 (HF `google/fleurs`) | 13 | Dutch read speech, 6–16 s | CC-BY-4.0 |

34 English clips (526 words) and 13 Dutch clips (263 words): small, so differences under ~3 points are noise. Every clip
is peak-normalised to −6 dBFS, given 300 ms of digital silence each side, then seven conditions (`make-set.mjs`):
`clean`; `tel` (FIR band-pass 300–3400 Hz); `lp7k` (low-pass 7 kHz); `quiet` (peak −35 dBFS); `noise15` (pink noise +
50 Hz hum at 15 dB SNR over active speech); `reverb` (synthetic exponential-decay RIR, RT60 0.5 s plus three early
reflections, level-matched); `combo` (7 kHz low-pass + RT60 0.35 s + 15 dB noise + −35 dBFS peak). Normalisation for WER:
lower case, punctuation removed, hyphens split, UK→US spellings, "for ever", fillers (um, uh, mm…) dropped for English,
digits words 0–10 mapped to digits. Dutch refs are FLEURS's normalised transcription, so numbers and compounds cost
points for every model (Parakeet v3's published FLEURS-nl WER is 7.5 % [R]; 12.4 % here on 13 clips).
Streaming models were fed the whole clip in 20 ms chunks plus 1 s of tail padding on one stream with `reset()`
between clips (the production behaviour); offline models got the whole clip. Whisper got `language` = en/nl; Nemotron
`auto` (hint variants in the file).

### 2.3 Results

**Resources and speed [M]** (4 threads unless noted; decode of a finished segment built from the clean clips; 18
decodes per length after two warm-ups; median / worst ms; "final step" is the streaming tail-padding step with 1 s padding,
the worker uses 0.4 s):

| model | kind | langs | disk MB | RSS load / peak MB | load s | 2.9 s med / worst | 5.3 s | 13.9 s | EN clean | EN tel | EN combo | **EN mean (7)** | NL clean | **NL mean (7)** |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| **parakeet-v2** | offline | en | 631 | 1122 / 1507 | 1.5 | 111 / 116 | 182 / 210 | 459 / 491 | 10.8 | 12.4 | 18.9 | **13.3** | n/a | n/a |
| **parakeet-ultra** | offline | 25 EU | 641 | 1114 / 1507 | 1.4 | 115 / 121 | 184 / 217 | 467 / 500 | 12.5 | 15.8 | 25.3 | **16.5** | 11.6 | **17.0** |
| parakeet-v3 | offline | 25 EU | 641 | 1124 / 1517 | 1.5 | 113 / 122 | 188 / 213 | 512 / 544 | 14.1 | 18.9 | 30.1 | 18.2 | 12.4 | 25.9 |
| **whisper-turbo** | offline | 99 | 990 | 1486 / 2201 | 1.6 | 980 / 1063 | 1272 / 1995 | 2717 / 3054 | 13.7 | 16.4 | 24.5 | **17.7** | 12.7 | **15.0** |
| whisper-distil-v3.5 | offline | en | 940 | 1470 / 2069 | 1.5 | 894 / 916 | 1173 / 1399 | 2366 / 2839 | 19.9 | 20.7 | 23.7 | 18.5 (repeats) | n/a | n/a |
| whisper-small | offline | 99 | 375 int8 | 561 / 1299 | 1.0 | 658 / 718 | 951 / 1280 | 2631 / 3267 | 17.4 | 20.8 | 36.1 | 23.0 | 25.1 | 33.4 |
| moonshine-base-en | offline | en | 135 | 326 / 435 | 0.5 | 41 / 48 | 71 / 263 | 206 / 270 | 17.4 | 25.3 | 44.0 | 26.2 | n/a | n/a |
| nemotron-3.5-560 | stream | 40 | 653 | 1045 / 1071 | 1.0 | 418 / 432 (final 117) | 637 / 748 | 1537 / 1661 | 18.9 | 27.6 | 55.6 | 31.3 | 22.8 | 31.7 |
| **nemotron-3.5-320** (current) | stream | 40 | 653 | 1050 / 1076 | 1.0 | 617 / 706 (final 154) | 956 / 1127 | 2331 / 2498 | 21.4 | 27.8 | 60.2 | 33.7 | 24.0 | 33.3 |
| fast-conformer-en (2 thr) | stream | en | 132 | 303 / 321 | 0.7 | 166 / 177 (final 47) | 252 / 299 | 598 / 672 | 19.7 | 29.7 | 91.5 | 38.2 | n/a | n/a |
| zipformer-en (2 thr) | stream | en | 70 | 214 / 248 | 1.3 | 140 / 157 (final 35) | 217 / 254 | 516 / 581 | 33.6 | 62.4 | 85.5 | 52.6 | n/a | n/a |

For streaming rows the 2.9 / 5.3 / 13.9 s numbers are the whole clip decoded at 20 ms chunks (they overlap with the speech
in live use); only the "final" step is paid after the user stops. Whisper small's archive also holds fp32 files; int8 alone is
375 MB. "Mean (7)" is the unweighted mean of the WER of the seven conditions.

**Thread sensitivity [M]** (median ms for 2.9 / 5.3 / 13.9 s): Parakeet v2 2 threads 171 / 288 / 725, 4 threads 111 / 182 / 459,
8 threads 96 / 140 / 345; Parakeet v3 173/289/738 → 113/188/512 → 97/141/359; Ultra 8 threads 99/143/341; Whisper turbo
2 threads 1584/2003/4023, 4 threads 980/1272/2717, 8 threads 851/1033/2305 (worst 1.8 s). Nemotron-320 8 threads 582/871/2190.
**Concurrency [M]:** Parakeet v2 decoding while a real-time Nemotron stream runs in another process: 115 / 185 / 478 ms
(+4 %), so the hybrid does not make them fight on 16 cores.

**WER by condition, English, all clips [M]** (%):

| model | clean | tel | lp7k | quiet | noise15 | reverb | combo |
|---|--:|--:|--:|--:|--:|--:|--:|
| parakeet-v2 | 10.8 | 12.4 | 10.6 | 12.0 | 12.9 | 15.4 | 18.9 |
| parakeet-ultra | 12.5 | 15.8 | 12.7 | 13.1 | 15.4 | 20.8 | 25.3 |
| parakeet-v3 | 14.1 | 18.9 | 12.9 | 12.0 | 16.8 | 22.4 | 30.1 |
| whisper-turbo | 13.7 | 16.4 | 14.7 | 16.0 | 18.1 | 20.7 | 24.5 |
| whisper-small | 17.4 | 20.8 | 18.5 | 19.9 | 22.2 | 26.3 | 36.1 |
| moonshine-base-en | 17.4 | 25.3 | 17.4 | 16.6 | 27.6 | 35.1 | 44.0 |
| nemotron-3.5-560 | 18.9 | 27.6 | 20.8 | 24.3 | 36.1 | 35.7 | 55.6 |
| nemotron-3.5-320 | 21.4 | 27.8 | 23.9 | 27.0 | 35.3 | 40.2 | 60.2 |
| fast-conformer-en | 19.7 | 29.7 | 21.8 | 34.6 | 27.2 | 42.7 | 91.5 |
| zipformer-en | 33.6 | 62.4 | 34.0 | 47.9 | 40.2 | 64.9 | 85.5 |

**By source, clean / combo [M]:** read speech (libri clean+other, 10 clips): Parakeet v2 2.3 / 6.9, Whisper turbo 2.8 / 9.7,
Ultra 3.2 / 13.9, Nemotron-320 6.0 / 31.5. Accented conversational (EdAcc): v2 18.9 / 30.2, turbo 17.2 / 31.4, Ultra 21.3 /
38.5, Nemotron-320 38.5 / 78.7. Meeting (AMI): v2 14.3 / 24.1, Ultra 16.5 / 27.1, v3 17.3 / 30.1, turbo 27.1 / 39.8, Nemotron-320
24.8 / 83.5. (Whisper is weaker than Parakeet on AMI: it drops disfluent fragments.)

**Dutch, 13 clips [M]** (%): 

| model | clean | tel | lp7k | quiet | noise15 | reverb | combo | mean |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| whisper-turbo | 12.7 | 11.2 | 11.6 | 9.4 | 15.0 | 25.1 | 20.2 | **15.0** |
| parakeet-ultra | 11.6 | 17.2 | 10.5 | 10.5 | 16.1 | 27.3 | 25.5 | **17.0** |
| parakeet-v3 | 12.4 | **34.8** | 13.1 | 16.1 | 19.9 | 41.2 | 44.2 | 25.9 |
| nemotron-3.5-560 (auto / `nl` hint) | 22.8 / 24.0 | 31.1 / 33.3 | | | | | | 31.7 / 32.3 |
| nemotron-3.5-320 | 24.0 | 31.8 | 24.0 | 29.6 | 30.0 | 41.9 | 52.1 | 33.3 |
| whisper-small | 25.1 | 27.0 | 24.7 | 22.8 | 31.8 | 49.4 | 52.8 | 33.4 |

Parakeet v3's failures on telephone-band audio are language confusion, e.g. a Dutch clip came back as English words,
and short English clips as Spanish ("Buenísimo que"); Ultra shows it less (2 of 238 English transcriptions have
foreign-looking text for both v3 and Ultra; v2 and Whisper turbo none). Items with WER ≥ 80 % among English clips of
≥ 5 words (231 per model): v2 9, Whisper turbo 15, v3 18, Ultra 18, Nemotron-320 45, zipformer 92.

**Plug-in emulation, VAD → one decode of the whole turn [M]** (`expB.mjs`: Silero VAD as in the worker, turn buffer from
onset − 400 ms to the 260 ms silence point, one decode; English clips unless noted; "decode" is at the end of the turn):

| model | VAD thr / AGC | clean | noise15 | quiet | combo | decode median / worst ms (turn median 4.5 s) |
|---|---|--:|--:|--:|--:|---|
| parakeet-v2 | 0.5 / off | **11.2** | 14.1 | 14.5 | 29.5 | 163 / 590 |
| parakeet-v2 | 0.35 / AGC | | | 13.7 | 23.2 | 156–172 / 587 |
| parakeet-ultra (EN+NL, 47 clips) | 0.5 / off | 11.2 | 15.9 | 15.3 | 34.6 | 182 / 590 |
| parakeet-ultra | 0.35 / AGC | | | 13.1 | 32.4 | 178–195 / 608 |
| *Nemotron-320 current pipeline (eager 250, EN)* | 0.5 / off | *23.4* | *32.6* | *29.2* | *59.8* | *~100 (finalise)* |

Whole-turn decoding at the eager point gives 12 points lower WER than the current pipeline on clean speech (11.2 vs 23.4 %), about half the errors.
In 34 clips there were 35 pauses > 260 ms inside a turn (clean): each would have triggered a speculative decode that the
next speech discards; the cost is CPU only.

### 2.4 Configuration that was run (sherpa-onnx-node 2.0.1)

```js
const sherpa = require("sherpa-onnx-node")

// Parakeet-TDT 0.6B v2 / v3 / ultra (NeMo transducer, offline). featureDim is passed as 80; the models ran correctly,
// so the real value is taken from the model metadata.
new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: `${dir}/encoder.int8.onnx`, decoder: `${dir}/decoder.int8.onnx`, joiner: `${dir}/joiner.int8.onnx` },
    tokens: `${dir}/tokens.txt`, numThreads: 4, provider: "cpu", debug: 0, modelType: "nemo_transducer"
  },
  decodingMethod: "greedy_search"
})

// Whisper large-v3-turbo / small (language per recogniser: build one per language or rebuild on change)
new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    whisper: { encoder: `${dir}/turbo-encoder.int8.onnx`, decoder: `${dir}/turbo-decoder.int8.onnx`,
               language: "nl" /* "en", "" = auto */, task: "transcribe", tailPaddings: -1 },
    tokens: `${dir}/turbo-tokens.txt`, numThreads: 4, provider: "cpu", debug: 0
  },
  decodingMethod: "greedy_search"
})

// Moonshine (the 2026-02-27 quantized release: `.ort` files, merged decoder)
modelConfig: { moonshine: { encoder: `${dir}/encoder_model.ort`, mergedDecoder: `${dir}/decoder_model_merged.ort` }, tokens: `${dir}/tokens.txt`, ... }

// One utterance (all offline models)
const s = rec.createStream(); s.acceptWaveform({ sampleRate: 16000, samples: float32 }); rec.decode(s); const text = rec.getResult(s).text

// Nemotron 3.5 streaming, any chunk size (same layout): as in presets.ts, featureDim 128, per-stream language
const stream = rec.createStream(); stream.setOption("language", "nl") // "auto" | "en" | "nl" ...
```

Whisper in sherpa-onnx returns lower case without punctuation for turbo and distil here, capitalised punctuated text for
small; irrelevant to WER but visible to the LLM. Whisper distil-large-v3.5 repeats short utterances ("…frightened tones and you
have not found out anything came in quick frightened tones"); `tailPaddings` 0, 200, 800 did not fix it.

The streaming sanity checks, per-condition scoring, the VAD emulation and the AGC are in `spike-stt2/work/` (§7).

AGC proposal (ran in E1/E3; per 20 ms frame, before the VAD and the recogniser):

```js
const makeAgc = ({ target = 0.25, maxGain = 31.6, floor = 0.004, release = 0.9985 } = {}) => {
  let env = 0, gain = 1
  return (frame) => {                       // Float32Array(320), in place
    let p = 0; for (const v of frame) p = Math.max(p, Math.abs(v))
    env = Math.max(p, env * release)        // instant attack, ~6 s release
    if (env > floor) { const want = Math.min(maxGain, Math.max(1, target / env)); gain = want < gain ? want : Math.min(want, gain * 1.02) }
    for (let i = 0; i < frame.length; i++) frame[i] = Math.max(-1, Math.min(1, frame[i] * gain))
  }
}
```

### 2.5 The recommended models: where to get them

All from <https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/> + archive name. Unpack with `tar -xjf` into
`models/`.

| preset | archive (size) | files in the directory | licence |
|---|---|---|---|
| Parakeet v2 | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` (482 MB) | `encoder.int8.onnx` 652 MB, `decoder.int8.onnx` 7 MB, `joiner.int8.onnx` 1.7 MB, `tokens.txt`, `test_wavs/`, `README.md` | CC-BY-4.0 (NVIDIA) |
| Parakeet Ultra | `sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8.tar.bz2` (487 MB) | same four files (joiner 6.4 MB, tokens 94 KB) | CC-BY-4.0 (Moondream, derived from NVIDIA v3) |
| Parakeet v3 (official, not recommended over Ultra) | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (487 MB) | same | CC-BY-4.0 |
| Whisper turbo | `sherpa-onnx-whisper-turbo.tar.bz2` (564 MB) | `turbo-encoder.int8.onnx` 675 MB, `turbo-decoder.int8.onnx` 361 MB, `turbo-tokens.txt`, `test_wavs/` | MIT (OpenAI Whisper) [R] |
| Nemotron 3.5 560 ms | `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2` (475 MB) | `encoder.int8.onnx` 658 MB, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` | OpenMDW-1.1 (NVIDIA) [R] |
| Moonshine base-en | `sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` (111 MB) | `encoder_model.ort`, `decoder_model_merged.ort`, `tokens.txt`, `LICENSE` | MIT for the English models |

Parakeet v2/v3/Ultra take 16 kHz mono audio, output punctuated, cased text; v2 is English only; v3/Ultra detect the language
themselves (25 European languages incl. Dutch).

## 3. Part C: recommendation

### 3.1 Presets for the settings screen

| preset id | label | one line for the person choosing |
|---|---|---|
| `parakeet-v2` **(default)** | Accurate, English | Best English accuracy, replies start about 0.1–0.5 s after you stop speaking. English only. Uses ~1.1 GB RAM. |
| `parakeet-ultra` | Accurate, English + Dutch | Nearly as accurate and as fast, and understands Dutch and 23 more European languages. Picks the language itself, so very poor audio can confuse it. ~1.1 GB. |
| `whisper-turbo` | Best for Dutch in noise | Most robust on Dutch and 99 languages, but slower: +1–2.7 s before the reply starts. ~1.5–2.2 GB. |
| `nemotron-560` | Live words | Shows words while you are still talking and is multilingual, but the least accurate; use when you want the on-screen transcript to run live. ~1.0 GB. |
| `hybrid-nemotron-parakeet` | Live words + accurate answer | Live words from Nemotron while you talk, Parakeet v2 for the final text. ~2.2 GB. |
| `moonshine-base-en` (optional) | Tiny | English only, 135 MB, 0.3 GB RAM, instant; accuracy between Whisper small and Nemotron. For weak hardware. |

If Dutch is spoken often, make `parakeet-ultra` the default instead of `parakeet-v2` (3.2 pt worse on English, but Dutch
17.0 % where v2 has none). Drop `zipformer-en` and `fast-conformer-en` from the choices: they are the worst on this set (38–53 %
mean) and English-only; their 1.5 % on six clean clips says nothing about the phone. Replace `nemotron-3.5` 320 ms by the
560 ms export: more accurate here (31.3 vs 33.7 %) and about a third less CPU per second of audio (1.5 vs 2.3 s for 13.9 s of speech); the cost is interim text arriving up to
240 ms later.

### 3.2 Plugging a non-streaming model into the turn detection

Keep the VAD, the pre-roll and the `TurnDetector` (250 / 600 ms). Only the worker's recogniser side changes:

1. **Turn buffer.** While the VAD says speech (and from onset − 400 ms), append every frame to a growing `Float32Array`
   (cap 30 s for Whisper, 60 s for Parakeet).
2. **`Finalize(frame)` at 250 ms silence:** decode the *whole* buffer, not just the last segment, and answer with a
   *cumulative* turn text. The TurnDetector must treat that answer as replacing, not appending to, `segments`
   (a `TurnInput` variant `TurnText`, or a `cumulative: true` flag on `Segment`). Do not clear the buffer.
3. **Speech resumes** (`TurnResumed`): keep appending; the next eager point decodes the whole buffer again. The discarded
   speculative decode costs only CPU (≤ 0.5 s for a 14 s turn with Parakeet).
4. **`EndOfTurn` at 600 ms:** emit the last text (unchanged semantics: no re-decode) and clear the buffer. Because the
   decode started at 250 ms, a ≤ 5 s turn is finished well before the 600 ms mark.
5. **Interim text:** none from a pure offline preset, or re-decode the growing buffer about every 1 s while speaking
   (Parakeet: 0.18 s for 5 s of audio on 4 threads; total CPU for a 15 s turn ≈ 3.7 s over 15 s, from the table, **not
   measured as a pipeline**). In the hybrid preset the interim and the barge-in `SpeechStarted` come from the streaming
   model, the eager and final text from the offline model; the worker loads both (2.2 GB) and feeds the streaming recogniser
   with a **fresh stream per turn** (§0.2).
6. `tailPaddingMs`, the Nemotron-specific "finalise pads to flush the encoder" logic and the reset-leak workaround are not
   needed for offline models.
7. Add the AGC (§2.4) in front of the VAD and the recogniser, and VAD threshold 0.35, for every preset. The streaming
   presets additionally need a fresh stream per segment and `eagerSilenceMs` 400.

### 3.3 Latency cost of the accurate options [M, derived]

Time from the VAD's speech→silence flip to the eager transcript = 260 ms (threshold rounded to frames) + the decode. Current
streaming: ~100 ms finalise (README; 400 ms padding), so ≈ 0.36 s.

| preset | turn 2.9 s | turn 5.3 s | turn 13.9 s | eager transcript at (median) | vs. now |
|---|---|---|---|---|---|
| Nemotron streaming (now) | ~0.1 | ~0.1 | ~0.1 | 0.36 s | – |
| Parakeet v2 / Ultra (4 thr) | 0.11 | 0.18 | 0.46 | 0.37 / 0.44 / 0.72 s | +0.01 / +0.08 / +0.36 s |
| Parakeet v2 (8 thr) | 0.10 | 0.14 | 0.35 | 0.36 / 0.40 / 0.61 s | 0 / +0.04 / +0.25 s |
| Whisper turbo (4 thr) | 0.98 | 1.27 | 2.72 | 1.24 / 1.53 / 2.98 s | +0.9 / +1.2 / +2.6 s |
| Moonshine base | 0.04 | 0.07 | 0.21 | 0.30 / 0.33 / 0.47 s | −0.06 / −0.03 / +0.11 s |

Worst cases of the same runs are 5–10 % higher (Parakeet 0.12 / 0.21 / 0.49 s; Whisper turbo 1.06 / 2.0 / 3.05 s). Because the
decode runs while the 600 ms commit timer is still counting, EndOfTurn is not delayed for Parakeet turns up to ~5 s. The
accuracy bought: mean English WER 33.7 % → 13.3 % (Parakeet v2) on the hard set; 23.4 → 11.2 % through the real VAD
segmentation on clean speech.

## 4. Unverified

- Real iPhone audio (Safari and Brave on iOS): levels, band, sample rates, VPIO/AGC behaviour, Bluetooth routes. Everything about iOS is read, not measured.
- Whether `echoCancellation:false` is viable for the owner's setup (echo of the assistant's own voice).
- Test set is small (526 EN / 263 NL words); degradations are synthetic (RIR, pink noise, FIR), not recorded phone audio.
- False-trigger rate of VAD thr 0.35/0.25 on background noise/TV/music; the AGC was only tested on single clips, not on a continuous conversation with loud/quiet alternation or with the assistant's TTS leaking in.
- The one-stream-per-segment memory behaviour was tested for 200 short streams in a loop (plateau +270–530 MB), not the 5-minute soak.
- The interim re-decode idea and the hybrid worker are designs; the hybrid concurrency was tested only as two processes.
- Parakeet Ultra's quality claims are the publisher's; its licence (CC-BY-4.0) and provenance were read from the model card and the sherpa README.
- Not tested for budget: Cohere Transcribe (2 B), Parakeet-unified streaming (240/560/1120 ms) and non-streaming, Parakeet redux, SenseVoice, Canary-180M-flash, Qwen3-ASR, Whisper medium/large-v3. Parakeet-unified streaming is the most interesting one: if it matches Parakeet v2 it would give streaming and accuracy in one model.
- Whisper in sherpa returned lower case/no punctuation for turbo in this build; not investigated.
- Dutch numbers are pessimistic for every model (digit/compound normalisation); relative order is what matters.
- Disk sizes are of the unpacked directories; RSS is from `process.memoryUsage()` on one machine.

## 5. Open points for the implementers

- `reset()` accuracy loss may be a sherpa-onnx 2.0.1 bug (encoder cache or decoder state not cleared); worth an upstream issue with the 16.8 vs 19.3 % reproduction (`resetcheck.mjs`).
- Parakeet v3/Ultra language confusion on narrowband audio: pass a language hint if sherpa exposes one for these models (it did not in this API), or prefer v2 for English.

## 6. Sources

iOS / WebKit [R]
- WebKit 218012, Web Audio volume drops after `getUserMedia` (iOS 14–18.6): <https://bugs.webkit.org/show_bug.cgi?id=218012>
- WebKit 275801, distortion with `getUserMedia` + `audioWorklet.addModule` unless the `AudioContext` is created first: <https://bugs.webkit.org/show_bug.cgi?id=275801>
- WebKit 311451, mic open degrades output (lower rate, mono), iOS 26.4/27, NEW: <https://bugs.webkit.org/show_bug.cgi?id=311451>
- WebKit 326286, crackle with echo cancellation on, iOS 26.2–27 (via 311451)
- WebKit 192932, high frequencies filtered; "We are no longer using VPIO if echoCancellation is false" (2023): <https://bugs.webkit.org/show_bug.cgi?id=192932>
- WebKit 179411, `getUserMedia` constraints have no effect: <https://bugs.webkit.org/show_bug.cgi?id=179411>
- WebKit 239956 (VPIO needs equal mic and speaker rates), 217147 (`sampleRate` constraint fails with EC): <https://bugs.webkit.org/show_bug.cgi?id=217147> (titles only)
- WebKit 319706, `getUserMedia` fails after audiomxd reset on iOS 26 (fixed 2026-07/09): <https://bugs.webkit.org/show_bug.cgi?id=319706>
- Apple, `AVAudioSession.CategoryOptions.bluetoothHighQualityRecording` (iOS 26, native only, not in the EU): <https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/bluetoothhighqualityrecording>
- Bluetooth HFP is 16 kHz mono "regardless", content often narrowband: <https://developer.liveswitch.io/liveswitch-cloud/guides/ios-audio-session-management.html>, <https://lists.apple.com/archives/bluetooth-dev/2018/Nov/msg00000.html>

Models [R unless stated]
- sherpa-onnx ASR model release: <https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models> ; NeMo transducer docs: <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html>
- Parakeet-TDT-0.6B v3: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3> (CC-BY-4.0, 25 languages, FLEURS-nl 7.48 %, MUSAN SNR table); v2: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2> (CC-BY-4.0, English, Open ASR 6.05 %)
- Parakeet Ultra (Moondream): <https://huggingface.co/moondream/parakeet-ultra> ; redux: <https://huggingface.co/moondream/parakeet-redux>
- Nemotron 3.5 ASR streaming (OpenMDW-1.1, 19 transcription-ready locales, Dutch FLEURS WER 12.2 % at 320 ms with language id, 12.6 % auto): <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>
- Cohere Transcribe: <https://docs.cohere.com/docs/transcribe> ; Moonshine: <https://github.com/moonshine-ai/moonshine> ; Whisper (MIT): <https://github.com/openai/whisper>
- Test data: <https://huggingface.co/datasets/edinburghcstr/edacc>, <https://huggingface.co/datasets/edinburghcstr/ami>, <https://huggingface.co/datasets/openslr/librispeech_asr>, <https://huggingface.co/datasets/google/fleurs> (via the datasets-server `rows` API)

## 7. Reproduction and leftovers

Scratch directory `/workspace/build-cache/ian/claude-tmp/claude-1000/-home-ian--t3-projects-personal-voice-assistance/1f84cbd0-a497-41a3-93a1-c982868074d2/scratchpad/spike-stt2/`
(not in the repository):

- `work/` scripts: `lib.mjs` (WAV I/O, WER, resampler wrapper), `fetch-hf.mjs`, `make-set.mjs` (degradations), `models.mjs`
  (all model configs), `bench.mjs <model> <time|acc> [threads]`, `score.mjs`, `pipeline.mjs` (worker emulation + AGC),
  `expA.mjs`, `expA2.mjs`, `expB.mjs`, `resampler-test.mjs`, `resetcheck.mjs`, `leak.mjs`, `analyse.mjs`, `loadgen.mjs`.
- `wav/cond/<condition>/*.wav`, `wav/items.json` (references), `results/*.json|log|md` (raw outputs, `summary.md`, `scores.md`).
- Models left in place for reuse, under `spike-stt2/models/` (already unpacked, same layout as §2.5): `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` (631 MB),
  `sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8` (641 MB), `sherpa-onnx-whisper-turbo` (990 MB),
  `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11` (653 MB). Deleted: all downloaded archives, Parakeet v3,
  Whisper small, distil-large-v3.5, Moonshine, and the throw-away Python `soundfile` install that `fetch-hf.mjs` used to decode
  FLAC (`pip install --target pylib soundfile numpy`).

### Appendix: reference analyser (`analyse.mjs`, runs on Int16 16 kHz)

See `spike-stt2/work/analyse.mjs`; outputs `peakDbfs, rmsDbfs, speechRmsDbfs, noiseFloorDbfs, snrDb, clippedSamples,
clippedPct, dcOffset, speechFramesPct, rolloff99Hz, energyAbove3400Pct, energyAbove5000Pct, verdict[]`. Method: 20 ms frame
RMS; noise floor = 10th percentile; speech frames = RMS above max(floor + 12 dB, 90th percentile − 20 dB); 512-point Hann
FFT (50 % overlap) averaged over speech frames; roll-off = frequency holding 99 % of the energy. Validation on the same
speech: clean (roll-off 7906 Hz, peak −6, "fine"), 300–3400 Hz (3188 Hz, NARROWBAND), 7 kHz low-pass (6906 Hz), −35 dBFS
(TOO QUIET), noise at 15 dB (SNR 17.1 dB), combo (TOO QUIET, SNR 16 dB).
