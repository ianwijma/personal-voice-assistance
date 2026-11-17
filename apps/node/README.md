# @pva/node — voice node

A headless thin client for a box with a microphone and a speaker (a Raspberry Pi, a VM, any Linux machine). It
connects to the assistant server as one more voice device over the existing WebSocket protocol, streams the
microphone as 16 kHz mono PCM and plays the replies, reporting playback like a browser does. The server keeps every
engine. Design: [docs/VOICE-NODES.md](../../docs/VOICE-NODES.md).

Status: protocol 9 (N3). The node is paired once (`pva-node pair`, run by the installer) and then says `hello` with
its credential; it applies the `sound` and `soundDevices` the server pushes, reports `node.status` and obeys
`node.command`. A protocol 9 server refuses a node that was not paired, so there is no unpaired mode.

## Run

```sh
# development against a server: pair first (admin › Devices › Add voice node gives the code), then run
pnpm --filter @pva/node start pair --server http://127.0.0.1:8787 --code K7QM-2XHP --config ./node.json
pnpm --filter @pva/node start --config ./node.json

# the installed config (/etc/pva-node/node.json: { server, deviceId, credential, name?, tlsPin? }, written by pair)
pnpm --filter @pva/node start --config /etc/pva-node/node.json

# no sound card: replay WAVs as the microphone and write the replies as WAVs
pnpm --filter @pva/node start --config ./node.json --input-wav bench-audio --output-wav node-out

pnpm --filter @pva/node start devices      # the backend's audio devices
pnpm --filter @pva/node start test-tone    # 1 kHz at −20 dBFS for 1 s (--sound wake|lapse|identify)
```

`--help` lists every option. The node prints each turn's `TurnTrace` latency line from `turn.end`, so node numbers
are the same numbers the server logs.

## How it behaves

- **Hello** as `frontend: "voice"` with `device: { id, kind: "voice-node", name, capabilities }`, `resumeOwner: true` and
  `node: { credential, version, bundleSha256?, platform }`; after `welcome` it sends `audio.claim`
  (`contextSampleRate: 16000`, `outputPath: "direct"`) and `mic.state { live: true }`. With a `tlsPin` in `node.json`
  the socket accepts a self-signed server only when its public key has that SHA-256, checked before `hello` is
  sent (a mismatch: no `hello`, a log line, the normal backoff).
- **Pushed settings** (`snapshot.setup`, then every `device.setup`): `sound.volume` and `sound.cues` at once;
  `soundDevices.input` reopens the capture, `soundDevices.output` is used from the next reply or cue. A device that
  does not open falls back to the default one and is reported as `lastError`. The `--volume`, `--no-cues`,
  `--input-device` and `--output-device` flags only set the values the node starts with.
- **`node.status`** after every `welcome` and whenever the status changes (the device lists are polled every 5 s; an
  open failure or a missing tool shows at once), at most once a second: backend, inputs, outputs, what is open,
  missing tools, the last error.
- **`node.command`**: `identify` (always plays), `test-speaker` (a 1 kHz tone, default 1 s, at most 5 s, never over a
  reply), `test-mic` (`node.level` five times a second for the duration, default 10 s, at most 30 s; nothing
  otherwise), `restart` (exit 0, systemd starts it again), `update` (check the manifest now; exit 0 when switched).
- **Microphone**: the capture starts the first time the node owns the audio and then runs for the life of the process.
  Frames are sent with sequence numbers from 0 after each claim, only while this connection owns the audio, and are
  dropped (not queued) when more than 500 ms is waiting in the socket, as the web page does.
- **Own session**: the node is its own device, so only another connection with the same device id (a copied
  `node.json`) can take the audio from it; the node does not fight that, logs "is node.json on two boxes?" and claims
  again once nobody holds it. After the coded error `sessions_full` it claims again every 10 s.
- **Replies**: one player per reply (`pw-cat` for PipeWire), frames buffered in memory, never dropped, volume
  `(volume/100)²`. Reports: `playback.started` at the first write (with the player latency), `playback.progress` every
  250 ms (a clock estimate that is clamped to what was written, never decreases and does not count an underrun's idle
  time), `playback.finished` with every sample after the player drained, `playback.stopped { exact: true }` once the
  player is killed on `reply.stop`. A lost connection stops the reply without a report.
- **Cues**: the wake cue on `wake { armed: true }`, the lapse cue when the state goes back to `asleep` with no turn
  started; never over a reply, never reported.
- **Reconnect**: for ever, 0.5 s doubling to 30 s with jitter, reset after a `welcome`; a 4403 (the credential is
  refused: the node was removed or paired again elsewhere) waits 10 minutes; a 4400 (protocol mismatch) triggers the update check at once.
- **Self-update** (only when running from an installed release): before every connection attempt the node fetches
  `<server>/node/manifest.json`; a different `bundle.sha256` is downloaded, checked (length and SHA-256), stored as
  `releases/<sha256>/pva-node.mjs`, `current` is switched with a rename and the node exits 0 for systemd to restart
  it. The boot guard counts the starts of a new release and rolls it back after three that did not reach `welcome`
  (including a bundle that cannot load); a rolled-back release is never taken again.

## Audio backends

| Backend | Status |
|---|---|
| `pipewire` | `pw-record` / `pw-cat` through `@pva/audio-pipewire`; devices from `pw-dump` (`node.name` ids) |
| `alsa` | `arecord` / `aplay` through `@pva/audio-alsa`; devices from `arecord -L` / `aplay -L` (`default`, `plughw:CARD=…`) |
| file | `--input-wav` / `--output-wav` through `@pva/audio-file` |

`--audio auto` (the default) picks PipeWire when this process can reach a PipeWire daemon (its socket in
`$XDG_RUNTIME_DIR`) and `pw-record` / `pw-cat` are installed, else ALSA; a system service has no user session and
always gets ALSA. The installer writes the explicit choice into the unit. Input and output are chosen separately.
`--input-device` / `--output-device` take the ids `devices` prints; empty means the backend's default.

## Distribution and installation

```sh
pnpm --filter @pva/node bundle     # apps/node/dist: pva-node.mjs, pva-node-boot.mjs, install.sh, manifest.json
```

The server serves `dist/` under `/node/`. On the box, as root:

```sh
curl -fsSL http://assistant.lan:8787/node/install.sh | sh -s -- --server http://assistant.lan:8787 --code K7QM-2XHP
#   --name <name>                suggested device name (the name set in admin wins)
#   --audio auto|alsa|pipewire   --user <desktop user> for PipeWire (a user unit with lingering)
#   --tls-pin sha256:<hex>       self-signed https: SHA-256 of the certificate's public key (SPKI)
#   --runtime <tarball>          offline: the pinned Node tarball (still hash-checked)
#   --upgrade-runtime            only the Node runtime;  --uninstall   remove everything
#   --root <dir>                 stage into a directory, no system changes (tests)
```

| Path | What | Owner |
|---|---|---|
| `/opt/pva-node/runtime/node-v22.x.y-linux-<arch>/`, `runtime/current` | the pinned Node runtime (`scripts/runtime.json`) | root |
| `/opt/pva-node/pva-node-boot.mjs` | the boot guard: start counting and rollback, then loads `releases/current` | root |
| `/opt/pva-node/releases/<sha256>/pva-node.mjs`, `current`, `previous`, `state.json` | the releases | the node's user |
| `/etc/pva-node/node.json` (0600), `install.env` | config; the installer's remembered choices | node's user; root |
| `/var/lib/pva-node/` (0700) | node state | the node's user |
| `/etc/systemd/system/pva-node.service` or `~user/.config/systemd/user/pva-node.service` | the unit (`install/*.service`) | root / user |

Running the installer again keeps what is right (same runtime, same release, existing `node.json`), repairs the rest
and restarts the node. Every download is checked against a SHA-256 before use (the runtime against the pin built into
`install.sh`, the bundle and boot guard against the manifest); a mismatch stops the installer before anything changes.
A Node bump: `node scripts/pin-runtime.mjs 22.x.y`, commit `scripts/runtime.json`.

## Layout

```
src/main.ts        CLI: run (default), devices, test-tone, pair, version
src/config.ts      node.json (credential required) read / write (0600), schema-validated; the WebSocket URL
src/connection.ts  ws client: TLS pin, hello, welcome, ping, reconnect policy (pure), close codes
src/session.ts     the device side of the protocol for one connection (claims, mic, replies, setup, commands)
src/status.ts      node.status: built from the device lists, throttled
src/playback.ts    reply player with playback reports, volume, cues; PlaybackClock
src/audio.ts       backend choice (auto | pipewire | alsa | file), buildAudio for a device choice, device listing
src/tones.ts       cue and test-tone generation
src/node.ts        runNode: capture + player for the process, a session per connection; settings, commands, update hooks
src/update.ts      manifest, verified download, switch (self-update); TLS pin; build version
src/releases.ts    release directories, state, start counting and rollback (plain node:fs)
src/boot.ts        the boot guard (bundled alone into pva-node-boot.mjs)
src/pair.ts        pair --code: POST /node/pair (NodePairRequest / NodePairAnswer), writes node.json
scripts/bundle.mjs the distribution build;  scripts/pin-runtime.mjs  the runtime pins
scripts/serve-dist.mjs  dist/ under /node/ plus a proxy to an assistant (a stand-in for the server's /node/* routes)
install/           install.sh and the two unit templates (filled into dist/install.sh by the build)
```

Tests (`test/`) run the node against a scripted server speaking the real protocol codecs.
