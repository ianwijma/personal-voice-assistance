/**
 * `pva-node`: the voice node CLI (docs/VOICE-NODES.md §7.4).
 *
 *   pva-node [run]      connect to the assistant and be its microphone and speaker (default)
 *   pva-node devices    list the audio devices of the backend
 *   pva-node test-tone  play a 1 kHz test tone (or a cue) on this box, without a server
 *
 * Later packages add `pair --code` and `status` (WP-10); `update.ts` is WP-4's.
 */
import { parseArgs } from "node:util"
import { NodeRuntime } from "@effect/platform-node"
import { AudioOutput } from "@pva/core"
import { Effect, Schema, Stream } from "effect"
import { audioLayer, type DeviceBackend, listDevices, NodeAudioInfo } from "./audio.ts"
import { DEFAULT_CONFIG_PATH, defaultDeviceId, type NodeConfig, NodeConfig as NodeConfigSchema, readConfig } from "./config.ts"
import { DEFAULT_VOLUME, defaultLog, runNode } from "./node.ts"
import { applyGain, volumeGain } from "./playback.ts"
import { asBytes, identifySound, lapseCue, testTone, TONE_RATE, wakeCue } from "./tones.ts"

const usage = `Usage: pva-node [run|devices|test-tone] [options]

run (default)
  --config <file>        node config (default ${DEFAULT_CONFIG_PATH})
  --server <url>         instead of --config: the assistant, e.g. http://assistant.lan:8787
  --device-id <id>       with --server: this node's device id (default node-<hostname>)
  --name <name>          with --server: suggested device name (default: the hostname)
  --audio <backend>      pipewire (default) or alsa
  --input-wav <path>     a WAV/PCM file or a directory of them instead of the microphone
  --input-gap-ms <ms>    silence after each input file (default 12000)
  --output-wav <dir>     write replies as reply-NNN.wav instead of playing them
  --input-device <id>    capture device of the backend (default: system default)
  --output-device <id>   playback device of the backend (default: system default)
  --volume <0..100>      output volume (default ${DEFAULT_VOLUME})
  --no-cues              no wake and lapse sounds

devices
  --audio <backend>

test-tone
  --audio <backend>  --output-wav <dir>  --volume <0..100>
  --ms <ms>              tone length (default 1000, at most 5000)
  --sound <name>         tone (default), wake, lapse or identify
`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    server: { type: "string" },
    "device-id": { type: "string" },
    name: { type: "string" },
    audio: { type: "string" },
    "input-wav": { type: "string" },
    "input-gap-ms": { type: "string" },
    "output-wav": { type: "string" },
    "input-device": { type: "string" },
    "output-device": { type: "string" },
    volume: { type: "string" },
    "no-cues": { type: "boolean" },
    ms: { type: "string" },
    sound: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
})

const fail = (message: string): never => {
  process.stderr.write(`${message}\n\n${usage}`)
  process.exit(2)
}

const int = (name: string, raw: string | undefined, min: number, max: number, fallback: number): number => {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : fail(`--${name} must be a whole number from ${min} to ${max}`)
}

if (values.help === true) {
  process.stdout.write(usage)
  process.exit(0)
}

const command = positionals[0] ?? "run"
const backend: DeviceBackend = values.audio === undefined || values.audio === "pipewire"
  ? "pipewire"
  : values.audio === "alsa"
  ? "alsa"
  : fail(`unknown --audio ${values.audio} (pipewire or alsa)`)
const volume = int("volume", values.volume, 0, 100, DEFAULT_VOLUME)

const audioOptions = {
  backend,
  inputWav: values["input-wav"],
  outputWav: values["output-wav"],
  inputGapMs: values["input-gap-ms"] === undefined ? undefined : int("input-gap-ms", values["input-gap-ms"], 0, 600_000, 0),
  inputDevice: values["input-device"],
  outputDevice: values["output-device"]
}

const loadConfig = (): Effect.Effect<NodeConfig, unknown> => {
  if (values.server === undefined) return readConfig(values.config ?? DEFAULT_CONFIG_PATH)
  return Schema.decodeUnknownEffect(NodeConfigSchema)({
    server: values.server,
    deviceId: values["device-id"] ?? defaultDeviceId(),
    ...(values.name !== undefined ? { name: values.name } : {})
  })
}

const run = Effect.gen(function*() {
  const config = yield* loadConfig()
  return yield* Effect.scoped(runNode({ config, settings: { volume, cues: values["no-cues"] !== true } }))
}).pipe(Effect.provide(audioLayer(audioOptions)))

const devices = Effect.gen(function*() {
  const list = yield* listDevices(backend)
  const show = (title: string, items: typeof list.inputs) =>
    `${title}:\n${items.map((d) => `  ${d.isDefault ? "*" : " "} ${d.id === "" ? "(default)" : d.id}  ${d.name}`).join("\n")}`
  process.stdout.write(`${show("Inputs", list.inputs)}\n${show("Outputs", list.outputs)}\n${list.note !== undefined ? `\n${list.note}\n` : ""}`)
})

const tone = Effect.gen(function*() {
  const ms = int("ms", values.ms, 50, 5000, 1000)
  const sound = values.sound ?? "tone"
  const samples = sound === "tone"
    ? testTone(ms)
    : sound === "wake"
    ? wakeCue()
    : sound === "lapse"
    ? lapseCue()
    : sound === "identify"
    ? identifySound()
    : fail(`unknown --sound ${sound}`)
  const output = yield* AudioOutput
  const info = yield* NodeAudioInfo
  defaultLog(`playing ${sound} on ${info.output} at volume ${volume}`)
  yield* output.play(Stream.make(applyGain(asBytes(samples), volumeGain(volume))), TONE_RATE)
}).pipe(Effect.provide(audioLayer(audioOptions)))

const program = command === "run"
  ? run
  : command === "devices"
  ? devices
  : command === "test-tone"
  ? tone
  : fail(`unknown command ${command}`)

NodeRuntime.runMain(
  (program as Effect.Effect<unknown, unknown>).pipe(
    Effect.catch((e) =>
      Effect.sync(() => {
        process.stderr.write(`pva-node: ${e instanceof Error || (typeof e === "object" && e !== null && "message" in e) ? (e as { message: string }).message : String(e)}\n`)
        process.exitCode = 1
      })
    )
  )
)
