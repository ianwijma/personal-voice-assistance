/**
 * The node's audio: which backend captures and plays (docs/VOICE-NODES.md §7.2, §7.4). The node uses the core audio
 * contract (`AudioInput`, `AudioOutput` from `@pva/core`, docs/ARCHITECTURE.md) and adds `NodeAudioInfo` with the
 * facts the protocol needs (backend names, the player's latency for `playback.started`, device lists).
 *
 * Input and output are chosen separately, so a box without a sound card can run with `--input-wav` and
 * `--output-wav` (`@pva/audio-file`, paced in real time), and a box with only a speaker can replay WAVs into it.
 *
 * Seams:
 * - **WP-1** (`@pva/audio-alsa`): `alsaLayers` below is the one place the ALSA backend plugs in, and
 *   `listDevices` is where both backends' device lists (`arecord -L` / `aplay -L`, `pw-dump`) plug in.
 * - **WP-10**: the profile's `audioInput` / `audioOutput` arrive as `inputDevice` / `outputDevice`; reopening on a
 *   profile change rebuilds these layers.
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { loadInputPcm, makeFileOutput, pacedFrames } from "@pva/audio-file"
import {
  captureCommand,
  defaultOptions as pipeWireDefaults,
  makeAudioInput as pipeWireInput,
  makeAudioOutput as pipeWireOutput,
  playbackCommand
} from "@pva/audio-pipewire"
import { AudioError, AudioInput, AudioOutput } from "@pva/core"
import { Context, Effect, Layer, Stream } from "effect"

export type DeviceBackend = "pipewire" | "alsa"
export type AudioBackendName = DeviceBackend | "file"

/** Protocol 7's `AudioDeviceInfo` (WP-6 moves it to `@pva/protocol`). */
export interface AudioDeviceInfo {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
}

export interface AudioDevices {
  readonly inputs: ReadonlyArray<AudioDeviceInfo>
  readonly outputs: ReadonlyArray<AudioDeviceInfo>
  /** Why the list is incomplete, when it is. */
  readonly note?: string
}

export class NodeAudioInfo extends Context.Service<NodeAudioInfo, {
  readonly input: AudioBackendName
  readonly output: AudioBackendName
  /** The requested player latency, reported as `playback.started.outputLatencyMs` (§4.4). */
  readonly outputLatencyMs: number
  /** Where cues and test tones go (the reply output, or a separate `cue-NNN.wav` series for `--output-wav`). */
  readonly cueOutput: AudioOutput["Service"]
}>()("@pva/node/NodeAudioInfo") {}

export interface NodeAudioOptions {
  /** The device backend for whatever is not a file. */
  readonly backend: DeviceBackend
  /** A WAV/PCM file, or a directory of them (played in name order), instead of the microphone. */
  readonly inputWav?: string | undefined
  /** A directory for `reply-NNN.wav` instead of the speaker. */
  readonly outputWav?: string | undefined
  /** Silence between two input files, so the reply to one can finish before the next. */
  readonly inputGapMs?: number | undefined
  /** Backend device ids (`""` / undefined = the backend's default). WP-10 fills them from the profile. */
  readonly inputDevice?: string | undefined
  readonly outputDevice?: string | undefined
  readonly captureLatencyMs?: number | undefined
  readonly playbackLatencyMs?: number | undefined
}

export const DEFAULT_INPUT_GAP_MS = 12_000

/** The input files of `--input-wav`: the file itself, or every `.wav` / `.pcm` in the directory, sorted by name. */
export const inputFiles = (path: string): ReadonlyArray<string> => {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .filter((f) => /\.(wav|pcm)$/i.test(f))
    .sort()
    .map((f) => join(path, f))
}

/**
 * The files one after another as a microphone would hear them (paced in real time), each followed by `gapMs` of
 * a quiet noise floor, then the noise floor for ever (a microphone never ends; the server's turn detector needs
 * the silence after the last words).
 */
export const fileCapture = (paths: ReadonlyArray<string>, gapMs: number): Stream.Stream<Uint8Array, AudioError> => {
  const files = paths.map((path) =>
    Stream.unwrap(Effect.map(loadInputPcm(path), (pcm) => pacedFrames(pcm, { leadingSilenceMs: 500, trailingSilenceMs: gapMs, noiseFloor: true })))
  )
  return Stream.concat(
    files.reduce((all, s) => Stream.concat(all, s), Stream.empty as Stream.Stream<Uint8Array, AudioError>),
    pacedFrames(new Uint8Array(0), { noiseFloor: true, atEnd: "silence" })
  )
}

const blank = (s: string | undefined) => s === undefined || s === "" ? undefined : s

interface DeviceLayers {
  readonly input: AudioInput["Service"]
  readonly output: AudioOutput["Service"]
  readonly outputLatencyMs: number
}

const pipeWireLayers = (options: NodeAudioOptions): DeviceLayers => {
  const pw = {
    captureTarget: blank(options.inputDevice),
    playbackTarget: blank(options.outputDevice),
    captureLatencyMs: options.captureLatencyMs ?? pipeWireDefaults.captureLatencyMs,
    playbackLatencyMs: options.playbackLatencyMs ?? pipeWireDefaults.playbackLatencyMs
  }
  return {
    input: pipeWireInput(captureCommand(pw)),
    output: pipeWireOutput((rate) => playbackCommand(pw, rate)),
    outputLatencyMs: pw.playbackLatencyMs
  }
}

/**
 * WP-1 seam: the ALSA backend. When `@pva/audio-alsa` lands, this returns its input and output (same contract as
 * audio-pipewire: `arecord` / `aplay`, devices by card name) and `outputLatencyMs` = its buffer time.
 */
const alsaLayers = (_options: NodeAudioOptions): Effect.Effect<DeviceLayers, AudioError> =>
  Effect.fail(new AudioError({ message: "the ALSA backend (@pva/audio-alsa, WP-1) is not part of this build yet; use --audio pipewire" }))

const deviceLayers = (options: NodeAudioOptions): Effect.Effect<DeviceLayers, AudioError> =>
  options.backend === "alsa" ? alsaLayers(options) : Effect.succeed(pipeWireLayers(options))

/** `AudioInput`, `AudioOutput` and `NodeAudioInfo` for these options. Device backends are only built when used. */
export const audioLayer = (options: NodeAudioOptions): Layer.Layer<AudioInput | AudioOutput | NodeAudioInfo, AudioError> =>
  Layer.effectContext(Effect.gen(function*() {
    const needsDevice = options.inputWav === undefined || options.outputWav === undefined
    const device = needsDevice ? yield* deviceLayers(options) : undefined
    const input = options.inputWav !== undefined
      ? AudioInput.of({
        stream: Stream.unwrap(Effect.try({
          try: () => fileCapture(inputFiles(options.inputWav!), options.inputGapMs ?? DEFAULT_INPUT_GAP_MS),
          catch: (cause) => new AudioError({ message: `cannot read ${options.inputWav}`, cause })
        }))
      })
      : device!.input
    const fileOutput = options.outputWav !== undefined
    const output = fileOutput ? makeFileOutput({ directory: options.outputWav! }) : device!.output
    const cueOutput = fileOutput ? makeFileOutput({ directory: options.outputWav!, prefix: "cue" }) : output
    return Context.make(AudioInput, input).pipe(
      Context.add(AudioOutput, output),
      Context.add(NodeAudioInfo, NodeAudioInfo.of({
        input: options.inputWav !== undefined ? "file" : options.backend,
        output: fileOutput ? "file" : options.backend,
        outputLatencyMs: fileOutput ? 0 : device!.outputLatencyMs,
        cueOutput
      }))
    )
  }))

/**
 * WP-1 seam: the devices of a backend for `pva-node devices` (and WP-10's `node.status`). Until the parsers of WP-1
 * land, only "System default" is known.
 */
export const listDevices = (backend: DeviceBackend): Effect.Effect<AudioDevices, AudioError> =>
  Effect.succeed({
    inputs: [{ id: "", name: "System default", isDefault: true }],
    outputs: [{ id: "", name: "System default", isDefault: true }],
    note: `listing ${backend} devices arrives with WP-1 (arecord -L / aplay -L, pw-dump); only the default is shown`
  })
