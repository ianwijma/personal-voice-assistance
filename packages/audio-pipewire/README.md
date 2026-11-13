# @pva/audio-pipewire

`AudioInput` and `AudioOutput` that spawn PipeWire's command-line tools:

- **Input:** `pw-record --raw --format s16 --rate 16000 --channels 1 --latency 20ms -`, re-framed into 640-byte (20 ms) chunks. Started when the stream is consumed, SIGKILLed when the consumer stops. Any exit of the recorder fails the stream with `AudioError` (stderr included).
- **Output:** one `pw-cat --playback --raw ... -` per `play` call. `play` returns when pw-cat exits after draining its stream; interrupting `play` SIGKILLs it, dropping everything buffered in the pipe, pw-cat and PipeWire. See the comment on `playThrough` for why there is no warm player.

## Options

`layerConfig` reads these from the environment (`layer(options)` takes them directly):

| Variable | Default | Meaning |
|---|---|---|
| `PIPEWIRE_CAPTURE_TARGET` | PipeWire's choice | `node.name` or serial of the source to record from |
| `PIPEWIRE_PLAYBACK_TARGET` | PipeWire's choice | `node.name` or serial of the sink to play to |
| `PIPEWIRE_CAPTURE_LATENCY_MS` | `20` | requested capture node latency (`--latency`) |
| `PIPEWIRE_PLAYBACK_LATENCY_MS` | `20` | requested playback node latency |

## Echo cancellation (for barge-in over open speakers)

Without echo cancellation the microphone hears the assistant and the speech-to-text service reports it as the user speaking. PipeWire's `libpipewire-module-echo-cancel` creates a virtual sink (play through it) and a virtual source (record from it, with the sink's audio removed).

**This snippet is untested** (the development machine has no sound card). Put it in `~/.config/pipewire/pipewire.conf.d/echo-cancel.conf` and restart PipeWire (`systemctl --user restart pipewire`):

```
context.modules = [
  { name = libpipewire-module-echo-cancel
    args = {
      library.name   = aec/libspa-aec-webrtc
      capture.props  = { node.name = "capture.pva-echo-cancel" }
      source.props   = { node.name = "pva-echo-cancel-source" node.description = "PVA echo-cancelled mic" }
      sink.props     = { node.name = "pva-echo-cancel-sink"   node.description = "PVA echo-cancel speaker" }
      playback.props = { node.name = "playback.pva-echo-cancel" }
    }
  }
]
```

Then point the assistant at the two virtual nodes:

```
PIPEWIRE_CAPTURE_TARGET=pva-echo-cancel-source
PIPEWIRE_PLAYBACK_TARGET=pva-echo-cancel-sink
```

Check they exist with `pw-cli ls Node | grep pva-echo-cancel`. All assistant audio must go through the sink, or it cannot be cancelled.

## Tests

Unit tests run stand-in Node scripts (`test/fixtures`) instead of PipeWire. The tests against the real `pw-cat` are opt-in:

```
PVA_PIPEWIRE_LIVE=1 pnpm --filter @pva/audio-pipewire test
```
