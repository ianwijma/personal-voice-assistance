/**
 * `pva-node`: the voice node CLI (docs/VOICE-NODES.md §7.4).
 *
 *   pva-node [run]      connect to the assistant and be its microphone and speaker (default)
 *   pva-node devices    list the audio devices of the backend
 *   pva-node test-tone  play a 1 kHz test tone (or a cue) on this box, without a server
 *   pva-node pair       redeem a pairing code and write node.json (install.sh runs it)
 *   pva-node version    print the version, protocol and bundle hash as JSON
 *
 * `run` updates itself from the server when it runs from an installed release (`update.ts`).
 */
import { parseArgs } from "node:util"
import { NodeRuntime } from "@effect/platform-node"
import { AudioOutput } from "@pva/core"
import { PROTOCOL_VERSION } from "@pva/protocol"
import { Effect, Schema, Stream } from "effect"
import { audioLayer, type BackendChoice, buildAudio, chooseBackend, listDevices, NodeAudioInfo } from "./audio.ts"
import { DEFAULT_CONFIG_PATH, type NodeConfig, readConfig } from "./config.ts"
import { DEFAULT_VOLUME, defaultLog, runNode } from "./node.ts"
import { pair } from "./pair.ts"
import { BUILD, detectInstall, NODE_VERSION, parseTlsPin, updaterFor } from "./update.ts"
import { applyGain, volumeGain } from "./playback.ts"
import { asBytes, identifySound, lapseCue, testTone, TONE_RATE, wakeCue } from "./tones.ts"

const usage = `Usage: pva-node [run|devices|test-tone|pair|version] [options]

run (default)
  --config <file>        node config written by pair (default ${DEFAULT_CONFIG_PATH})
  --audio <backend>      auto (default: PipeWire when a PipeWire daemon is reachable, else ALSA), pipewire or alsa
  --input-wav <path>     a WAV/PCM file or a directory of them instead of the microphone
  --input-gap-ms <ms>    silence after each input file (default 12000)
  --output-wav <dir>     write replies as reply-NNN.wav instead of playing them
  --input-device <id>    capture device of the backend until the server's setup says otherwise (default: system default)
  --output-device <id>   playback device of the backend until the server's setup says otherwise (default: system default)
  --volume <0..100>      output volume until the server's setup says otherwise (default ${DEFAULT_VOLUME})
  --no-cues              no wake and lapse sounds until the server's setup says otherwise

devices
  --audio <backend>

test-tone
  --audio <backend>  --output-wav <dir>  --volume <0..100>
  --ms <ms>              tone length (default 1000, at most 5000)
  --sound <name>         tone (default), wake, lapse or identify

pair                     redeem a pairing code from admin and write the config (the server refuses an unpaired node)
  --server <url>  --code <code>  --config <file>  [--tls-pin sha256:<hex>]  [--name <name>]

version                  {"version","protocol","bundleSha256"} as JSON
`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    server: { type: "string" },
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
    code: { type: "string" },
    "tls-pin": { type: "string" },
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
const backendChoice: BackendChoice = values.audio === undefined
  ? "auto"
  : values.audio === "auto" || values.audio === "pipewire" || values.audio === "alsa"
  ? values.audio
  : fail(`unknown --audio ${values.audio} (auto, pipewire or alsa)`)
const backend = chooseBackend(backendChoice)
const volume = int("volume", values.volume, 0, 100, DEFAULT_VOLUME)

const audioOptions = {
  backend,
  inputWav: values["input-wav"],
  outputWav: values["output-wav"],
  inputGapMs: values["input-gap-ms"] === undefined ? undefined : int("input-gap-ms", values["input-gap-ms"], 0, 600_000, 0),
  inputDevice: values["input-device"],
  outputDevice: values["output-device"]
}

const loadConfig = (): Effect.Effect<NodeConfig, unknown> => readConfig(values.config ?? DEFAULT_CONFIG_PATH)

const run = Effect.gen(function*() {
  const config = yield* loadConfig()
  const self = updaterFor(config.server, config.tlsPin, defaultLog)
  defaultLog(`pva-node ${NODE_VERSION} (protocol ${PROTOCOL_VERSION})${"reason" in self ? `; self-update off: ${self.reason}` : ""}`)
  const exit = yield* Effect.scoped(runNode({
    config,
    settings: { volume, cues: values["no-cues"] !== true },
    soundDevices: { input: values["input-device"] ?? "", output: values["output-device"] ?? "" },
    // With WAV files instead of devices there is nothing to reopen: the server's `soundDevices` are ignored.
    ...(audioOptions.inputWav === undefined && audioOptions.outputWav === undefined
      ? { audioFor: (d: { readonly input: string; readonly output: string }) => buildAudio({ ...audioOptions, inputDevice: d.input, outputDevice: d.output }) }
      : {}),
    devices: listDevices(backend),
    ...("updater" in self ? { updates: self.updater } : {})
  }))
  // Exit explicitly: the service manager starts the new (or the previous) release.
  return yield* Effect.sync(() => process.exit(exit.exitCode))
}).pipe(Effect.provide(audioLayer(audioOptions)))

const need = (name: string, value: string | undefined): string => value ?? fail(`${command} needs --${name}`)

const checkPin = (pin: string | undefined) => {
  try {
    parseTlsPin(pin)
  } catch (e) {
    fail((e as Error).message)
  }
  return pin
}

const pairCommand = Effect.gen(function*() {
  const configPath = values.config ?? DEFAULT_CONFIG_PATH
  const config = yield* pair({
    server: need("server", values.server),
    code: need("code", values.code),
    configPath,
    tlsPin: checkPin(values["tls-pin"]),
    name: values.name
  })
  process.stdout.write(`paired as ${config.deviceId}${config.name !== undefined ? ` (${config.name})` : ""}; wrote ${configPath}\n`)
})

const versionCommand = Effect.sync(() => {
  const install = detectInstall()
  process.stdout.write(`${JSON.stringify({
    version: NODE_VERSION,
    protocol: PROTOCOL_VERSION,
    bundled: BUILD !== undefined,
    ...(install._tag !== "Dev" ? { bundleSha256: install.sha256 } : {}),
    installed: install._tag === "Installed"
  })}\n`)
})

const devices = Effect.gen(function*() {
  const list = yield* listDevices(backend)
  process.stdout.write(`Backend: ${backend}${backendChoice === "auto" ? " (auto)" : ""}\n`)
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
  : command === "pair"
  ? pairCommand
  : command === "version"
  ? versionCommand
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
