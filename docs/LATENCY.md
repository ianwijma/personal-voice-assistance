# Measured latency and memory

How to read the numbers a turn prints and how to run the benchmarks: [RUNNING.md](RUNNING.md#reading-the-latency-line).

## The CLI pipeline

Development machine, 2026-11-13: AMD Ryzen 9 7945HX (16 threads), 30 GB RAM, CPU only, no sound card (file audio backend). Local STT and Piper TTS, `LLM_PROVIDER=fake` with a simulated **300 ms to first token** and 60 tokens/s standing in for a hosted model. 21 turns per row: the five `bench-audio` questions (Piper voice, resampled to 16 kHz) plus two LibriSpeech clips (`models/test-wavs/0.wav`, `1.wav`, which has pauses mid-sentence), three rounds each. Command:

```sh
BENCH_LLM_FIRST_TOKEN_MS=300 STT_SHERPA_MODEL=<model> STT_SHERPA_EAGER_SILENCE_MS=<e> STT_SHERPA_FINAL_SILENCE_MS=<f> \
  pnpm start bench --live --rounds 3 <dir with the 7 files>
```

**With the new default STT** (2026-11-14, same machine; the five `bench-audio` questions, 3 rounds = 15 turns,
`BENCH_LLM_FIRST_TOKEN_MS=300 pnpm start bench --live --rounds 3 bench-audio`), and the previous default
model through the same adapter in the same session (`STT_SHERPA_MODEL=nemotron-320 STT_SHERPA_AGC=false`):

| STT model | eager | eot | 1st token | 1st clause | tts audio | **PLAY median / worst** |
|---|---|---|---|---|---|---|
| `parakeet-v2` (new default) | 397 | 660 | 730 | 746 | 771 | **771 / 1095** |
| `nemotron-320` (previous default model) | 393 | 681 | 716 | 731 | 756 | **757 / 1081** |

+14 ms at the median for these 2–3 s questions (the study predicted +0.01–0.08 s for 3–5 s turns), every
turn speculative and promoted, every transcript right; Nemotron heard "like an Amsterdam" in all three
rounds and returns no final punctuation. Long sentences cost more (a 16 s sentence: about +0.4 s, see the
stt-sherpa README). The table below is the earlier measurement (21 turns including two LibriSpeech clips,
so not directly comparable).

End of user audio → reply playback start, median / worst (ms), with the median of each step (2026-11-13, before the change):

| STT model | eager / final silence | eager | eot | 1st token | 1st clause | tts audio | **PLAY median / worst** |
|---|---|---|---|---|---|---|---|
| `nemotron-3.5` | 250 / 600 (default) | 372 | 641 | 691 | 706 | 729 | **729 / 1100** |
| `nemotron-3.5` | 200 / 600 | 341 | 641 | 655 | 671 | 692 | **701 / 1062** |
| `nemotron-3.5` | 200 / 400 | 344 | 441 | 654 | 671 | 693 | **693 / 1065** |
| `zipformer-en` | 250 / 600 | 344 | 660 | 666 | 683 | 705 | **705 / 1050** |
| `zipformer-en` | 200 / 400 | 285 | 460 | 606 | 622 | 645 | **645 / 992** |

Every turn was speculative and promoted (the eager transcript equalled the final one); the worst case is always the tool turn ("What time is it in Tokyo"), which needs two model calls (2 × 300 ms). Transcripts were right apart from small slips ("like an Amsterdam", "octapuces", zipformer's "T O KYO"); `1.wav` was split by its pauses (`TurnResumed`) in one of three rounds (in two with zipformer at 200 / 400). Zipformer is English only, upper case and unpunctuated, but its finalise is faster and it needs a third of the memory.

How to read it:

- **Turn detection dominates.** About 640 ms of the ~730 ms is waiting for silence: the VAD's hold-over plus the 600 ms final silence. Once `EndOfTurn` arrives, the reply is usually already synthesised (the speculative turn started at `eager`), and plays within 50–90 ms.
- **With a 300 ms model, the final silence is not the bottleneck below ~600 ms:** the speculative reply needs `eager` + 300 ms, about 650–700 ms after the audio ends. Cutting the final silence to 400 ms saved only 8 ms at the median, while making it likelier that a pause mid-sentence ends your turn. An earlier eager end of turn (200 ms) saved about 30 ms. The defaults stay at 250 / 600 ms: 30 ms is small next to the risks, which these clean test clips cannot show. Every pause longer than the eager threshold starts a speculative model request (paid, with a hosted model) and makes the STT finalise a segment, losing context at the join (see the stt-sherpa README). Try `STT_SHERPA_EAGER_SILENCE_MS=200` if your speech has few pauses.
- **The local engines are fast:** first clause → first Piper audio 20–30 ms; the STT's finalise adds about 100 ms (Nemotron) or 30 ms (zipformer) to the eager end of turn.
- **CPU:** during a turn the whole app used about 2 cores at the median and 5.2 at peak (main process with the STT about 2–3.6 cores while you speak, Piper up to 3.8 cores in bursts), out of 16. No contention on this machine; on a 4-core machine try `STT_SHERPA_THREADS=2` and `TTS_SHERPA_THREADS=2` (not measured).

## While a model downloads

Run on the development machine (16 cores) on 2026-11-14: `bench --live --rounds 6` over two test clips
(`models/test-wavs/0.wav`, short; `1.wav`, a long sentence), local Parakeet v2 + Piper, the offline stand-in with
`BENCH_LLM_FIRST_TOKEN_MS=250`, 12 turns each. "During unpack": the real downloader (`downloadArchives`) looping on a
564 MB Whisper archive served from a local HTTP server (download 0.7 s, then `nice -n 10 tar -xjf` for 32 s per round,
so the unpack ran through every turn). Milliseconds from the end of the clip's audio:

| Turns | eager (median) | tts audio − 1st clause (typical) | PLAY median, short clip | PLAY median, long clip | PLAY median / worst, all 12 |
|---|---|---|---|---|---|
| Idle | 27 | 23–31 | 321 | 1269 | **790 / 1442** |
| During unpack | 61 | 23–55 | 353 | 1250 | **812 / 1414** |

Reading: an unpack adds about 30 ms to a short turn (the recogniser's eager decision and the first audio are a little
later) and nothing measurable to a long one (within run-to-run noise); the worst case did not get worse. Not worth
pausing unpacking during a turn, so it is not done. The download phase itself was not measured on its own (locally it
lasts under a second; from GitHub it lasts longer but is network-bound, not CPU-bound). Not run: a download on a
machine with few cores, where the niced bzip2 process competes for the same core as the decoder.

## Through the browser

The same pipeline with the browser as microphone and speaker (2026-11-13, same machine): `pnpm bench:browser` speaks the five `bench-audio` questions twice into the real page in headless Chromium (fake microphone, 48 kHz) against `pnpm start serve` with `BENCH_LLM_FIRST_TOKEN_MS=300`. End of speech is the moment the page sent the last microphone frame of the question; *play* is when the page reported `playback.started` (its player handed the first sample to the audio device); *audible* adds the `outputLatency` the browser reports. For comparison the CLI benchmark was run again right before it with the same ten questions (`BENCH_LLM_FIRST_TOKEN_MS=300 pnpm start bench --live --rounds 2 bench-audio`).

| 10 turns, median / worst (ms) | end of turn | play | audible |
|---|---|---|---|
| CLI (file backend), same session | 651 / 702 | **765 / 1067** | (no device) |
| Browser (headless Chromium) | 663 / 707 | **779 / 1130** | **817 / 1178** |

Every turn was speculative and promoted; the worst is again the Tokyo time question (two model calls). The 729 ms of the table above was a different run (21 turns including two LibriSpeech clips); the turn detector varies by a few tens of ms between runs, so compare rows measured together.

What the browser adds, from the traces:

- **Between the first synthesised audio and `playback.started`: 5–21 ms, median about 11 ms.** That is the WebSocket hop (about 1 ms), the page handing the frame to the player worklet, the worklet waiting for its next render callback (the headless audio device renders 512-frame blocks, 10.7 ms; a real device usually has smaller ones), and the report back. The 60 ms prebuffer costs nothing here: the first clause arrives whole (`startDelayMs` 0 in every turn), so the player starts at once.
- **End of turn about 12 ms later** than in the CLI: the page sends 20 ms frames, and capture runs through the browser's audio processing. The browser's capture latency before the frame is sent is not in these numbers (on a real device typically 10–20 ms).
- **Output latency** as reported by headless Chromium: 29–64 ms, median 44 ms. A real device reports its own (wired: tens of ms; Bluetooth: often 150–250 ms).

No avoidable delay was found in the browser path: the reply audio is sent as soon as it exists, `reply.start` goes out when the turn is promoted, and the player starts on the first chunk. The cost is the device's render block and output latency, which only a real device can measure.

The latency readout in the page (top right, and per reply in the chat) shows the trace from the **end of the turn** (by design, §3.9 of the UI design), so it read 93–174 ms for these turns (about 500 ms for the tool turns), not the ~800 ms from the end of your speech: the ~650 ms the turn detector waits for silence happens before the trace starts.

## Memory footprint

Measured on the development machine during `bench --live` (resident memory):

| Process | Default | Alternatives |
|---|---|---|
| main process (Node, app, STT worker with the model) | 1.3 GB after loading `parakeet-v2`, 1.66 GB after the first minute, then flat | 2.4 GB `hybrid-nemotron-parakeet`; 1.2 GB `nemotron-560` / `nemotron-320`; 1.9–2.7 GB `whisper-turbo`; 430 MB `zipformer-en` |
| Piper engine process (`standard` voice) | 280–590 MB (grows with long replies) | |
| Kokoro engine process (only when a Kokoro voice is chosen, or previewed) | about 700 MB (adapter README) | |
