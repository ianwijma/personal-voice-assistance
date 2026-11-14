# WP-5 findings: a keyword spotter on the voice node

Spike for docs/VOICE-NODES.md §6 (`micStreaming: on-keyword`), §9 M4, §11 (the arm64 / tokenisation risk) and §12
WP-5. Date 2026-11-14. Every number below comes from a command listed with it. All of them were measured on **x86**
(AMD Ryzen 9 7945HX, 16 threads, Linux 7.0, Node 22.22.1), **not on a Pi**.

## Verdict: no-go for `on-keyword` now; keep `continuous`

The three technical risks of §11 are cleared: the API is there, arm64 binaries are published, and plain-text
phrases can be turned into model tokens in TypeScript (verified against the reference tokeniser). The cost is also
tiny on x86. **Accuracy fails.** The best setting found misses **21 % of the synthetic wake phrases** (71 / 336),
and **14 % (8 / 56) even for clean "hey jeff" spoken alone**. §6 asks for under 1 in 20 (5 %). The fire comes
**~350 ms** (p50) after the phrase ends, not the 0.1–0.3 s §6 hoped for. With these numbers `on-keyword` would
drop about one wake in five, and the server could not see those misses. So WP-10 should not build `kws.ts` on this
model yet.

What could change the verdict, cheapest first:

1. Run M4 on a Pi with the owner's **own** voice. Synthetic voices are not the owner's, and the result could be
   better or worse. Use `scripts/pi-m4.sh --wakes` with ≥ 50 recordings. If that shows < 5 % misses with < 1 false
   fire per hour on ≥ 3 h of TV audio, this becomes a go: the code here is ready for it.
2. A spotter trained for the phrase: fine-tuning the 3.3 M zipformer on "hey jev" recordings (icefall's KWS
   recipe). That is a project of its own, not a spike.

## 1. Does `sherpa-onnx-node` 2.0.1 have a keyword spotter, and does it ship linux-arm64?

**Yes, on both counts.** The arm64 part is checked by inspecting the files; nothing was run on arm64.

- `node_modules/.pnpm/sherpa-onnx-node@2.0.1/node_modules/sherpa-onnx-node/keyword-spotter.js` exports
  `KeywordSpotter` (`createStream()`, `isReady`, `decode`, `reset`, `getResult` → `{ keyword, start_time, tokens,
  timestamps }`). `sherpa-onnx.js` re-exports it.
- The native addon also takes a second argument, `createKeywordStream(spotter, keywords)`. This is
  `SherpaOnnxCreateKeywordStreamWithKeywords`, which the upstream source at v2.0.1 shows
  (`harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/keyword-spotting.cc`, which `scripts/node-addon-api/src`
  symlinks to). The JS wrapper does not expose it. The config takes `keywordsFile` **or** `keywordsBuf` +
  `keywordsBufSize`, so no file is needed.
- `sherpa-onnx-linux-arm64@2.0.1` is published (`npm view sherpa-onnx-linux-arm64@2.0.1 os cpu` → `linux`,
  `arm64`) and listed in `sherpa-onnx-node`'s `optionalDependencies`. I unpacked the tarball: `file` reports
  `ELF 64-bit LSB shared object, ARM aarch64` for `sherpa-onnx.node`, `libsherpa-onnx-c-api.so` and
  `libonnxruntime.so` (34.6 MB). The highest symbol versions they need are `GLIBC_2.17` and `GLIBCXX_3.4.19`
  (`objdump -T`), so any 64-bit Raspberry Pi OS is new enough. `strings` finds
  `SherpaOnnxCreateKeywordStreamWithKeywords` in both arm64 libraries. **Not verified:** that it loads and runs on
  a Pi, because no arm64 machine or qemu-user was available. `pi-m4.sh` checks it as its first real step.
- The installed package is 40.2 MB unpacked for arm64 (`npm view … dist.unpackedSize`).

## 2. Plain-text keywords: tokenisation, files, sizes, runtime changes

**The spotter does not tokenise.** Each keyword line must already be model tokens. `EncodeBase` in
`sherpa-onnx/csrc/utils.cc` (v2.0.1) splits the line on whitespace, looks each word up in tokens.txt, and reads
`:score`, `#threshold` and `@label`. Any other word is logged as "Cannot find ID for token". Upstream does this
step in Python (`sherpa-onnx-cli text2token` → `sentencepiece` / pypinyin). This package does it in TypeScript.

| Model (release tag `kws-models`) | Tokens | Encoder needed | Archive | Files loaded |
|---|---|---|---|---|
| `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (English, GigaSpeech 10 kh) | 500 SentencePiece pieces (`▁HE Y ▁JE FF`) | `src/sentencepiece.ts`, which reads `bpe.model` | 16.8 MB | int8 encoder 4.8 MB + decoder 1.06 MB + int8 joiner 0.16 MB + tokens.txt 5 kB + bpe.model 245 kB ≈ **6.3 MB** |
| `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` (Chinese + English) | ARPAbet phones for English (`HH EY1 JH EH1 F`) | `src/lexicon.ts`, CMUdict lookup in `en.phone` (126 k words) | 31.4 MB | int8 encoder 4.6 MB + decoder 0.76 MB + int8 joiner 0.09 MB + en.phone 3.3 MB ≈ **8.7 MB** |

- **`bpe.model` is a unigram model, not BPE.** Its `trainer_spec.model_type` is 1. The encoder is therefore a
  Viterbi search, as in sentencepiece's `unigram_model.cc`. It matches the reference Python `sentencepiece`
  (0.2.x, pip) on **52 / 52** phrases (`test/fixtures/sentencepiece-reference.json`, checked by
  `test/sentencepiece.test.ts` when the model is present). The phrases include "hey jeff / jev / geoff",
  apostrophes, digits and the model's own keywords.txt.
- How the phrases tokenise. "hey jeff" → `▁HE Y ▁JE FF`. "hey jev" → `▁HE Y ▁JE V`. "hey geoff" → `▁HE Y ▁G E O FF`,
  so in the BPE model "geoff" is spelled, not pronounced. In the phone model "jeff" and "geoff" are both
  `JH EH1 F`, so they are one keyword. "jev" is not in CMUdict, so it has a built-in override, `JH EH1 V`.
- A word the phone model's lexicon lacks fails with an `OovError` that names the word. A piece that is not in
  tokens.txt fails with an `UnknownTokenError`, for example a digit: the encoder returns it as text, as
  sentencepiece does, rather than letting `<unk>` through. The admin UI could show either error next to the phrase.
- **Runtime phrase changes need a new spotter.** `createStream(keywords)` *appends* the given phrases to the ones
  the spotter was built with (`KeywordSpotterTransducerImpl::CreateStream(keywords)`), so it cannot remove a phrase.
  A spotter cannot be built with no phrases either: `Validate` refuses an empty `keywordsBuf`. Rebuilding costs a
  model load, measured at **336 ms** (gigaspeech) and **400 ms** (zh-en) on x86 for a second spotter with new
  phrases (command in §3). A node can build the new spotter next to the old one and swap them, so no audio is lost.

## 3. Measurements (M4, x86 only)

Test set, from `tsx scripts/synth-samples.ts --out <dir> --tts-model-dir <repo>/models`, using the repo's Kokoro
`kokoro-multi-lang-v1_0` with 28 English voices:

- 336 positives (17.9 min): {hey jeff, hey jev, hey geoff} × {alone, followed by a request after 150 ms} ×
  {0.9×, 1.15× speed}. The phrase end is known exactly.
- 420 near misses (23 min): "Hey chef", "Hey Jess", "A jet flew over", "Hey Siri", ….
- Conditions: clean, pink noise at 15 dB SNR, or another voice's speech 10 dB down.
- Kokoro drops words it lacks, so Jev, Geoff, Jess and Steph were added to its lexicon.
- **Flaw:** the condition was assigned round-robin, and that ended up aligned with wake × kind. Each `byGroup` cell
  is therefore one wake, one kind and one condition, and the per-condition effect cannot be separated.

Real-speech negatives: the repo's `models/test-wavs/stt-quality` set, 0.658 h. It is 47 real-speaker clips (EN
accents and NL, 5.6 min) under 7 degradations, so only 5.6 min of distinct speech. **No TV or podcast audio was
available, and no recordings of the owner** (`data/recordings` is empty).

### Accuracy sweep

All 9 runs in parallel, each one process:

```
tsx scripts/measure-m4.ts --model <m> --score <s> --threshold 0.05,0.1,0.15,0.2,0.25 \
  --samples <synth dir> --negatives <repo>/models/test-wavs/stt-quality
```

The runs hit a 30-minute limit before every threshold finished. Below are the rows that completed, and the best
row per model. Misses are over 336 positives, near-miss fires over 420 clips, and false fires over 0.658 h of
real speech.

| Model | boost | threshold | misses | fire delay after phrase end p50 / p95 | near-miss clips that fired | fires in real speech |
|---|---|---|---|---|---|---|
| gigaspeech-bpe | 1.0 | 0.05–0.10 | 93 (27.7 %) | 397 / 587 ms | 3 | 0 |
| gigaspeech-bpe | **2.0** | **0.05** | **71 (21.1 %)** | **352 / 552 ms** | 9 (2.1 %) | 0 |
| gigaspeech-bpe | 2.0 | 0.20 | 128 (38.1 %) | 349 / 547 ms | 5 | 0 |
| gigaspeech-bpe | 3.0 | 0.05 | 80 (23.8 %) | 351 / 547 ms | 13 | 0 |
| zh-en-phone | 1.0 | 0.05–0.15 | 139 (41.4 %) | 317 / 496 ms | 4 | 0 |
| zh-en-phone | 2.0 | 0.05 | 114 (33.9 %) | 323 / 495 ms | 14 | 0 |
| zh-en-phone-chunk8 | 2.0 | 0.05 | 141 (42.0 %) | 268 / 387 ms | 9 | 0 |
| zh-en-phone-chunk8 | 3.0 | 0.05 | 142 (42.3 %) | 269 / 387 ms | 19 | 0 |

Per cell for gigaspeech, boost 2, threshold 0.05 (hits / 56):

| Cell | Hits |
|---|---|
| hey jeff, alone, clean | 48 |
| hey jeff + request, pink | 47 |
| hey geoff, alone, pink | 47 |
| hey geoff + request, babble | 37 |
| hey jev, alone, babble | 38 |
| hey jev + request, clean | 48 |

The phone model scores best on clean "hey jeff, alone" (54 / 56) but much worse elsewhere: "hey jeff + request,
pink" 24 / 56, "hey geoff" 28 / 56. The near-miss fires are almost all "Hey Jess, come over here" with pink noise,
plus one "Hey, Jen". "Fire delay" is the audio time of the 20 ms frame whose `accept()` returned the fire, minus
the phrase end. Add that frame's compute time (p99 3.6 ms on x86) for wall time.

### Cost

Measured alone, pinned to one core. These commands feed 39.5 min of real speech, as 20 ms frames, as fast as
possible:

```
taskset -c 3 tsx scripts/measure-m4.ts --model <m> --score <s> --threshold <t> --threads 1 \
  --negatives <repo>/models/test-wavs/stt-quality
```

| Model | RTF (wall) | CPU, % of one core at real time | `accept()` per 20 ms frame p50 / p99 / max | load |
|---|---|---|---|---|
| gigaspeech-bpe | 0.011 | 1.1 % | 0.012 / 3.6 / 19.3 ms | 359 ms |
| zh-en-phone | 0.010 | 1.0 % | 0.012 / 3.2 / 17.2 ms | 466 ms |
| zh-en-phone-chunk8 | 0.019 | 1.9 % | 0.013 / 4.5 / 12.4 ms | 462 ms |

Real-time pacing, with `pidstat` next to it:

```
taskset -c 3 tsx scripts/measure-m4.ts --model gigaspeech-bpe --score 2.0 --threshold 0.05 \
  --negatives <synth dir>/neg --realtime-minutes 3
pidstat -u -r -p <pid> 1
```

`process.cpuUsage` gave 2.3 % of one core. `pidstat` %CPU gave median 2 %, p95 3 % and max 5 % (179 one-second
samples). The 3 minutes of near misses produced 1 fire.

Memory of the spotter alone. This is the RSS before and after building the spotter and feeding it 1 s of audio, in
a `tsx -e` one-off that also timed the rebuild of §2:

| Model | RSS before → after | Increase | Notes |
|---|---|---|---|
| gigaspeech-bpe | 110 → 187 MB | +77 MB | |
| zh-en-phone | 97 → 260 MB | +163 MB | mostly the parsed 126 k-word lexicon held in a JS `Map` |

The zh-en increase could be cut by reading only the words in the phrases. The `rssMb` that `measure-m4` reports
also includes the test audio held in memory, so ignore it.

## 4. What still has to be measured on a Pi 4, and how

Nothing above is a Pi number. On a Pi 4 with Raspberry Pi OS Lite 64-bit, Node ≥ 22.18, pnpm, `sudo apt install
sysstat`, and a checkout of this branch:

```
# on any x86 box with the Kokoro model: make the synthetic set and copy it over
pnpm --filter @pva/kws-sherpa synth --out ~/kws-samples && rsync -a ~/kws-samples pi:~/

# on the Pi: record ≥ 50 wakes on the node's mic, the phrase alone, one per file
for i in $(seq -w 1 50); do read -p "say 'hey jev' ($i) "; arecord -f S16_LE -r 16000 -c 1 -d 3 ~/wakes/w$i.wav; done
# ≥ 3 h of TV / podcast audio as WAV: ffmpeg -i show.mkv -ac 1 -ar 16000 ~/tv/show.wav

packages/kws-sherpa/scripts/pi-m4.sh --out ~/m4 --samples ~/kws-samples --wakes ~/wakes --tv ~/tv \
  --model gigaspeech-bpe --score 2.0 --threshold 0.05 --minutes 10
```

It records `system.txt` (model, CPU, temperature and throttling before and after). It then measures:

- `accuracy.json`: misses on the owner's wakes and on the synthetic set, fire delay, false fires per hour of TV,
  RTF, `accept()` p99 and load time, under `/usr/bin/time -v` for max RSS.
- A 10-minute real-time run with `pidstat -u -r -p <pid> 1`, giving median / p95 CPU % and max RSS.

All results go to `~/m4/summary.txt`. Its first real step also proves that the arm64 addon loads.

Still open beyond that script: M5's pre-roll check, and the spotter's behaviour while the node plays a reply
(echo of the TTS into the mic, §6 "Hey Jev over the reply").

## 5. What was built

`packages/kws-sherpa` (spike; nothing imports it):

- tokenisers: `sentencepiece.ts` and `lexicon.ts`
- `keywords.ts`: phrase → keyword line, with `:boost`, `#threshold` and `@label`; deduplication
- `spotter.ts`: thin synchronous wrapper; the only file that loads the SDK
- `models.ts` and `scripts/download-models.ts`
- `scripts/synth-samples.ts`, `scripts/measure-m4.ts` and `scripts/pi-m4.sh`

Tests:

- `test/keywords.test.ts`, run always.
- `test/sentencepiece.test.ts`: the hand-made-model tests run always; the reference comparison runs when the model
  is present.
- `test/spotter.test.ts`, run when the model is present: one of the model's own real recordings contains "light
  up" and fires once; "hey jeff" on the same recording fires nothing.

**Not built, because of the no-go:** the Effect `KeywordSpotter` service (`detect(frames): Stream<{ phrase, at }>`)
and a model download preset in the admin UI. `createSpotter` is the piece they would wrap.
