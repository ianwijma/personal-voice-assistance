# @pva/kws-sherpa (WP-5 spike)

A sherpa-onnx keyword spotter (`sherpa-onnx-node` 2.0.1, the version `@pva/stt-sherpa` uses) for the voice node's
`micStreaming: on-keyword` option (docs/VOICE-NODES.md §6). **Spike code**: nothing in the app imports it yet.
Findings, numbers and the go / no-go are in [FINDINGS.md](FINDINGS.md).

## What is here

| File | |
|---|---|
| `src/spotter.ts` | `createSpotter({ model, phrases, keywordsThreshold, keywordsScore })` → `accept(samples) → fires`; the only file that loads the SDK |
| `src/keywords.ts` | plain-text phrase → keyword line (`▁HE Y ▁JE FF :2 #0.1 @hey_jeff`), checked against tokens.txt |
| `src/sentencepiece.ts` | SentencePiece **unigram** encoder for the English model's `bpe.model` (matches the Python `sentencepiece` on 52 phrases, `test/fixtures`) |
| `src/lexicon.ts` | CMUdict lookup for the bilingual phone model (`en.phone`), with overrides (`jev` built in) |
| `src/models.ts` | the model files and URLs |
| `scripts/download-models.ts` | `pnpm --filter @pva/kws-sherpa download-models [gigaspeech-bpe] [zh-en-phone]` |
| `scripts/synth-samples.ts` | the synthetic M4 set (Kokoro, 28 English voices, 3 conditions) |
| `scripts/measure-m4.ts` | M4: load time, CPU / RTF, fire delay, misses, false fires |
| `scripts/pi-m4.sh` | M4 on a Raspberry Pi, with `pidstat` |

## Tests

`pnpm test` runs the tokeniser tests always; the reference-tokeniser comparison and the live spotter tests (the
model's own recordings, one containing the phrase and one not) run when the models are in `<repo>/models` or
`KWS_MODEL_DIR`, and are skipped with a message otherwise.
