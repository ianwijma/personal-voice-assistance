# @pva/node — voice node

A headless thin client for a box with a microphone and a speaker (a Raspberry Pi, a VM, any Linux machine). It
connects to the assistant server as one more voice device over the existing WebSocket protocol, streams the
microphone as 16 kHz mono PCM and plays the replies, reporting playback like a browser does. The server keeps every
engine. Design: [docs/VOICE-NODES.md](../../docs/VOICE-NODES.md).

Status: the WP-3 skeleton (protocol 5). Pairing, credentials, the `voice-node` kind on the server, the pushed node
profile, node status and commands, self-update and on-keyword streaming come in later work packages (WP-4, WP-6,
WP-7, WP-10).

## Run

```sh
# against a server, without a config file (development)
pnpm --filter @pva/node start --server http://127.0.0.1:8787

# with the installed config (/etc/pva-node/node.json: { server, deviceId, credential?, tlsPin? })
pnpm --filter @pva/node start --config /etc/pva-node/node.json

# no sound card: replay WAVs as the microphone and write the replies as WAVs
pnpm --filter @pva/node start --server http://127.0.0.1:8799 --input-wav bench-audio --output-wav node-out

pnpm --filter @pva/node start devices      # the backend's audio devices
pnpm --filter @pva/node start test-tone    # 1 kHz at −20 dBFS for 1 s (--sound wake|lapse|identify)
```

`--help` lists every option. The node prints each turn's `TurnTrace` latency line from `turn.end`, so node numbers
are the same numbers the server logs.

## How it behaves

- **Hello** as `frontend: "voice"` with `device: { id, kind: "voice-node", name }` and `resumeOwner: true`; after
  `welcome` it sends `audio.claim` (`contextSampleRate: 16000`, `outputPath: "direct"`) and `mic.state { live: true }`.
  A server on protocol 5 does not know the `voice-node` kind and treats the node like a voice page without a device.
- **Microphone**: the capture starts the first time the node owns the audio and then runs for the life of the process.
  Frames are sent with sequence numbers from 0 after each claim, only while this connection owns the audio, and are
  dropped (not queued) when more than 500 ms is waiting in the socket, as the web page does.
- **Shared owner (protocol 5)**: when a browser takes the audio the node does not take it back; it claims again once
  nobody holds it. After `sessions_full` (voice sessions, protocol 6) it claims again every 10 s.
- **Replies**: one player per reply (`pw-cat` for PipeWire), frames buffered in memory, never dropped, volume
  `(volume/100)²`. Reports: `playback.started` at the first write (with the player latency), `playback.progress` every
  250 ms (a clock estimate that is clamped to what was written, never decreases and does not count an underrun's idle
  time), `playback.finished` with every sample after the player drained, `playback.stopped { exact: true }` once the
  player is killed on `reply.stop`. A lost connection stops the reply without a report.
- **Cues**: the wake cue on `wake { armed: true }`, the lapse cue when the state goes back to `asleep` with no turn
  started; never over a reply, never reported.
- **Reconnect**: for ever, 0.5 s doubling to 30 s with jitter, reset after a `welcome`; a 4403 (credential refused,
  protocol 7) waits 10 minutes; a 4400 (protocol mismatch) is logged and retried (WP-4 adds the self-update there).

## Audio backends

| Backend | Status |
|---|---|
| `pipewire` (default) | `pw-record` / `pw-cat` through `@pva/audio-pipewire` |
| `alsa` | WP-1 (`@pva/audio-alsa`); `alsaLayers` in `src/audio.ts` is the seam |
| file | `--input-wav` / `--output-wav` through `@pva/audio-file` |

Input and output are chosen separately. Device lists (`devices`) show only the system default until WP-1's parsers
land (`listDevices` in `src/audio.ts`).

## Layout

```
src/main.ts        CLI: run (default), devices, test-tone
src/config.ts      node.json read / write (0600), schema-validated; the WebSocket URL
src/connection.ts  ws client: hello, welcome, ping, reconnect policy (pure), close codes
src/session.ts     the device side of the protocol for one connection
src/playback.ts    reply player with playback reports, volume, cues; PlaybackClock
src/audio.ts       backend choice (pipewire | alsa | file), device listing
src/tones.ts       cue and test-tone generation
src/node.ts        runNode: capture + player for the process, a session per connection
```

Tests (`test/`) run the node against a scripted server speaking the real protocol codecs.
