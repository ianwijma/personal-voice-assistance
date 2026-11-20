# @pva/audio-alsa

`AudioInput` and `AudioOutput` that spawn ALSA's `arecord` / `aplay` (package `alsa-utils`), for headless boxes without PipeWire (Raspberry Pi OS Lite, minimal Debian VMs). The process handling is `@pva/audio-pipewire`'s (`captureStream`, `playThrough`): 20 ms frames, a sliding 3 s buffer, SIGKILL on interrupt, a stall timeout, one player per `play` call. Only the command lines differ.

- **Input:** `arecord -q -D <device> -t raw -f S16_LE -r 16000 -c 1 --buffer-time=… --period-time=… -`
- **Output:** `aplay` with the same flags at the reply's sample rate; it exits after draining at end of input.

## Options (`layerConfig`)

| Variable | Default | Meaning |
|---|---|---|
| `ALSA_CAPTURE_DEVICE` | `default` | PCM to record from. Use card names, e.g. `plughw:CARD=Speaker,DEV=0` (indexes change with USB order; `plughw` resamples to 16 kHz mono) |
| `ALSA_PLAYBACK_DEVICE` | `default` | PCM to play to |
| `ALSA_CAPTURE_LATENCY_MS` | `20` | `--buffer-time` (period = a quarter of it) |
| `ALSA_PLAYBACK_LATENCY_MS` | `20` | same, for playback |

## Device listing

`listAlsaDevices` runs `arecord -L` / `aplay -L` and `parseAlsaList` turns each into `AudioDeviceInfo[]`, keeping `default` and the `plughw:` PCMs. PipeWire's counterpart is `listPipeWireDevices` / `parsePwDump` in `@pva/audio-pipewire`.

## Tests

Stand-in processes (as in audio-pipewire) and recorded listings in `test/fixtures/devices/`: `*.pi.txt` and `*.debian-vm.txt` are hand-written in the real format (no Pi was at hand), `*.dev-machine.txt` is real output. `PVA_ALSA_LIVE=1 pnpm --filter @pva/audio-alsa test` also runs the real `arecord` / `aplay` against ALSA's `null` PCM (needs no sound card).
