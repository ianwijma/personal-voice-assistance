# @pva/tts-sherpa

Local, CPU-only `Tts` with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): Piper (fast, the default) and Kokoro (higher quality, slower). Nothing leaves the machine.

## Presets

| Preset | Engine | Rate | Threads | Licence |
|---|---|---|---|---|
| `en_US-lessac-medium` (default) | Piper, fp32 | 22050 Hz | 4 | Trained on the Blizzard 2013 Lessac dataset: **non-commercial (research) use only** |
| `nl_NL-pim-medium` (Dutch) | Piper, fp32 | 22050 Hz | 4 | Dataset CC0; fine-tuned from lessac-medium, so the Lessac terms may carry over |
| `kokoro-af_heart` | Kokoro v1.0, fp32, speaker 3 | 24000 Hz | 8 | Apache-2.0 |
| 24 more Piper voices | Piper, fp32 | 22050 Hz (16000 Hz for "low") | 4 | per voice (`license` in the table) |
| 35 more Kokoro voices (`kokoro-<speaker>`: 27 English, 8 Mandarin) | Kokoro v1.0, fp32, the same archive as `kokoro-af_heart` | 24000 Hz | 8 | Apache-2.0 |

The full list, how each voice was chosen and checked, and what was left out (Kokoro's speakers other than English and Chinese: sherpa-onnx 2.x has no espeak fallback, so it skips their words) are in [docs/VOICE-PROVIDERS.md](../../docs/VOICE-PROVIDERS.md) §3.1.

All Piper presets ship `espeak-ng-data` (GPL-3.0 data files, used for phonemisation); the Kokoro archive does too, but sherpa-onnx 2.x ignores it and uses the archive's lexicons. The int8 builds are not used: on this CPU they are about five times slower than fp32.

Adding a Piper voice is one line in `src/Presets.ts`: `piper("en_GB-alba-medium", "<licence>", piperVoice(...))`. The voice must exist as `vits-piper-<voice>.tar.bz2` in the sherpa-onnx `tts-models` release; pass `{ sampleRate: 16_000 }` for a "low" voice and the real sizes when they are not 68/83 MB. Adding a Kokoro speaker is a `kokoro("<speaker>", <id>, ...)` line; take the id from the archive's `speaker2id` (`presets.test.ts` holds the verified table). All Kokoro presets share one archive: `archiveOwner` (the first in the table, `kokoro-af_heart`) is what is downloaded, listed on the Models page and deleted, and `archiveVoices` lists the presets that come with it.

The real-model test (`test/models.test.ts`) runs once per engine set-up (archive and lexicon), not once per Kokoro speaker.

Kokoro has three engine set-ups (`engineSetup`): American, British and Chinese (US + Chinese lexicons and the Chinese rule FSTs). `makeShared` starts an engine that can also speak the other presets of its set-up, each with its own speaker id per clause; the web UI's previews use it so moving between Kokoro voices does not reload the model. `make` (live turns) is unchanged: one speaker per engine.

## Models

Models live in `<repo>/models/` (git-ignored). Download a preset (idempotent; needs `tar` with bzip2):

```sh
pnpm --filter @pva/tts-sherpa download                    # the default preset
pnpm --filter @pva/tts-sherpa download kokoro-af_heart nl_NL-pim-medium
pnpm --filter @pva/tts-sherpa download all
```

`TTS_SHERPA_MODEL_DIR` changes the directory. If a file is missing, building the layer fails with a `TtsError` naming the file and the download command.

## Usage and configuration

```ts
import * as SherpaTts from "@pva/tts-sherpa"

SherpaTts.layerConfig()                     // Layer<Tts, TtsError | ConfigError>, reads TTS_SHERPA_*
SherpaTts.layerConfig("VOICE_DUTCH_TTS_SHERPA_") // another prefix
SherpaTts.layer({ preset: "kokoro-af_heart", join: { sentencePauseMs: 250 } })
SherpaTts.make(options)                     // Effect<Tts service, TtsError, Scope>
SherpaTts.config(prefix)                    // Config<SherpaTtsOptions>, to merge with other settings
```

| Key (default prefix `TTS_SHERPA_`) | Default | Meaning |
|---|---|---|
| `PRESET` | `en_US-lessac-medium` | preset name |
| `MODEL_DIR` | `<repo>/models` | where archives are unpacked |
| `THREADS` | preset's (4 / 8) | ONNX runtime threads |
| `SPEED` | 1 | speaking rate |
| `TRIM_SILENCE` | true | trim clause edges and insert controlled pauses |
| `CLAUSE_PAUSE_MS` | 150 | silence between clauses after `, ; :` |
| `SENTENCE_PAUSE_MS` | 300 | silence between clauses after `. ! ?` |
| `PAD_MS` | 20 | silence kept next to speech when trimming |
| `CHUNK_MS` | 40 | size of emitted audio chunks |

The model is loaded when the layer is built and the engine process stops when the layer's scope closes. `sampleRate` is the engine's native rate (no resampling here).

## Design

**Isolation: one child process per engine instance.** Piper needs `sherpa-onnx-node` 1.13.8 (2.x removed the espeak phonemiser Piper models need) and Kokoro needs 2.x, so the app may hold two versions of the same native library, while the STT adapter loads 2.x in a worker thread of the main process. The main process never loads sherpa; each engine runs `src/engine-host.mjs` in a forked process (plain JavaScript, forked with an empty `execArgv`, so it works the same under `tsx` and vitest) that loads exactly one version. Audio crosses the IPC channel as `Float32Array` (advanced serialisation). A native crash only kills the child; terminating a worker thread mid-synthesis crashed the whole process in the spike, killing a child is safe. Verified: Piper and Kokoro synthesising at the same time while the main process has 2.0.1 loaded in a worker.

**Failures.** A crash fails the running turn with `TtsError` and a new process starts loading at once. A clause that takes longer than 5 s + 40 ms per character is treated as stuck: the child is killed (same path). A model that fails to load fails the layer.

**Scheduling and interruption.** Each clause is sent to the engine the moment it arrives. The child gets one clause at a time; the queue is in the parent. Synthesis inside a clause cannot be cancelled, so interrupting the consumer returns at once, drops the turn's queued clauses, and discards the audio of the clause in flight when it arrives. The next turn's first clause waits behind at most that one clause (measured below). Audio is tagged by the turn that asked for it, so nothing leaks into a later turn.

**Clause joins.** Every clause is synthesised alone and comes with its own silence (Piper: up to ~70 ms before, 76–186 ms after; untrimmed joins measured 105–230 ms regardless of punctuation). Each clause is trimmed to speech (|x| ≥ 0.01, about −40 dBFS) plus a 20 ms pad, cut edges get a 5 ms fade, and the pause before each clause is set so the total silence at the join is exactly `CLAUSE_PAUSE_MS` or `SENTENCE_PAUSE_MS` depending on how the previous clause ended. Trimming the first clause's leading silence also brings the first audible sound forward by up to ~60 ms. Conversion to s16 and chunking run on typed arrays; chunks are views of one buffer per clause.

## Measurements

`pnpm --filter @pva/tts-sherpa measure [preset ...]` (env `RUNS`, default 10) prints these and writes WAVs to `packages/tts-sherpa/bench-out/`. Measured 2026-11-13 on the development machine (no sound card), 10 runs each, through the full adapter (IPC, trimming, chunking). "First audio" is from handing a one-clause stream to `synthesize` to receiving its first chunk.

| | lessac (Piper) | pim (Piper, Dutch) | af_heart (Kokoro) |
|---|---|---|---|
| model load (layer build) | 501 ms | 718 ms | 1063 ms |
| first audio, short clause (5 words) | 31 / 34 ms | 45 / 48 ms | 204 / 247 ms |
| first audio, medium clause (10–12 words) | 88 / 108 ms | 116 / 126 ms | 587 / 601 ms |
| first audio, long clause (23–24 words) | 175 / 191 ms | 215 / 240 ms | 947 / 971 ms |
| short clause right after interrupting a turn of long clauses (after its first audio) | 198 / 205 ms | 270 / 274 ms | 1157 / 1189 ms |
| short clause right after discarding a turn before any audio | 193 / 206 ms | 261 / 268 ms | 1090 / 1165 ms |
| interrupt call returns | ≤ 1 ms | ≤ 1 ms | ≤ 1 ms |
| main event-loop delay during synthesis (p99 / max) | 1.5 / 2.9 ms | 1.4 / 3.6 ms | 1.1 / 5.1 ms |
| engine process memory (RSS) | 425 MB | 563 MB | 719 MB |
| silences at joins of a 4-clause reply (trimmed) | 300, 150, 300 ms | 300, 150, 300 ms | 300, 150, 300 ms |
| same reply untrimmed | 227, 230, 194 ms | 119, 121, 105 ms | 159, 170, 162 ms |

Cells are median / worst. The after-interrupt rows are the worst case by construction: the abandoned turn has a long clause in flight, so the new clause waits for it (Piper ≈ 175 ms, Kokoro ≈ 950 ms) and then for itself.

## Not verified

- **Nobody has listened to the output.** The machine has no sound card. Joins are checked by measurement only; `bench-out/<preset>.wav` and `bench-out/<preset>.untrimmed.wav` are there to listen to. Whether 150/300 ms pauses sound natural, whether the 0.01 threshold clips soft word endings (e.g. a final "s" or "f") and whether the fades are inaudible all need a listen.
- Speech quality and pronunciation (numbers, names, Dutch) were not judged.
- Measurements come from one machine; another CPU will differ, and the thread counts were tuned on this one.
- Only Linux was tried. Licences were taken from the model cards in the archives, not reviewed by anyone.
