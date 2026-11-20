# Model licences

Taken from the files in the model archives and the adapter READMEs; nobody has reviewed them legally.

| Model | Used for | Licence |
|---|---|---|
| Piper `en_US-lessac-medium` (default voice) | TTS | trained on the Blizzard 2013 Lessac dataset: **non-commercial (research) use only**. Fine for a personal assistant; choose another voice for anything commercial. |
| Piper `nl_NL-pim-medium` | TTS (Dutch) | dataset CC0, but fine-tuned from lessac-medium, so the Lessac terms may carry over |
| Kokoro v1.0 `af_heart` | TTS (Kokoro voice) | Apache-2.0 |
| `espeak-ng-data` (shipped with every TTS preset) | phonemisation | GPL-3.0 data files |
| Parakeet-TDT 0.6B v2 (default STT) | STT | CC-BY-4.0 (NVIDIA); attribution required |
| Parakeet Ultra (optional) | STT | CC-BY-4.0 (Moondream, derived from NVIDIA Parakeet v3; not an NVIDIA release) |
| Whisper large-v3-turbo (optional) | STT | MIT (OpenAI) |
| Nemotron 3.5 ASR streaming 0.6B, 320 / 560 ms (optional) | STT | NVIDIA model ([Hugging Face card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)); the archive carries no licence file: **check the card before relying on it** |
| Zipformer streaming en 2023-06-26 | STT | Apache-2.0 (archive README) |
| NeMo FastConformer streaming en | STT | NVIDIA NeMo model; the archive carries no licence file: not checked |
| Silero VAD | voice activity | MIT (Silero project); not stated in the downloaded file |
