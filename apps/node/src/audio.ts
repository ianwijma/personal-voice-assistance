/**
 * The node's audio: which backend captures and plays (docs/VOICE-NODES.md §7.2, §7.4). The node uses the core audio
 * contract (`AudioInput`, `AudioOutput` from `@pva/core`, docs/ARCHITECTURE.md) and adds `NodeAudioInfo` with the
 * facts the protocol needs (backend names, the player's latency for `playback.started`, device lists).
 *
 * Input and output are chosen separately, so a box without a sound card can run with `--input-wav` and
 * `--output-wav` (`@pva/audio-file`, paced in real time), and a box with only a speaker can replay WAVs into it.
 *
 * Backends: PipeWire (`pw-record` / `pw-cat`, `@pva/audio-pipewire`) and ALSA (`arecord` / `aplay`,
 * `@pva/audio-alsa`). `auto` (the default) picks PipeWire where a PipeWire daemon is reachable for this process and
 * ALSA otherwise (headless boxes, and the system service, which has no user session) — `chooseBackend`. Device
 * lists come from `pw-dump` and `arecord -L` / `aplay -L` (`listDevices`).
 *
 * The pushed `soundDevices` (protocol 12) arrive as `inputDevice` / `outputDevice`; `buildAudio` makes the services
 * for one choice again, so `runNode` can reopen the capture and use another output from the next play.
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import {
  captureCommand as alsaCaptureCommand,
  defaultOptions as alsaDefaults,
  listAlsaDevices,
  playbackCommand as alsaPlaybackCommand
} from "@pva/audio-alsa"
import { loadInputPcm, makeFileOutput, pacedFrames } from "@pva/audio-file"
import {
  captureCommand,
  defaultOptions as pipeWireDefaults,
  listPipeWireDevices,
  makeAudioInput as pipeWireInput,
  makeAudioOutput as pipeWireOutput,
  playbackCommand
} from "@pva/audio-pipewire"
import { AudioError, AudioInput, AudioOutput } from "@pva/core"
import type { AudioDeviceInfo } from "@pva/protocol"
import { Context, Effect, Layer, Stream } from "effect"

export type DeviceBackend = "pipewire" | "alsa"
export type BackendChoice = DeviceBackend | "auto"
export type AudioBackendName = DeviceBackend | "file"

export type { AudioDeviceInfo }

/** What `chooseBackend` looks at; injectable for tests. */
export interface BackendProbe {
  readonly env: NodeJS.ProcessEnv
  /** The file exists (a socket counts). */
  readonly exists: (path: string) => boolean
  /** An executable of this name is on `PATH`. */
  readonly onPath: (program: string) => boolean
}

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export const systemProbe: BackendProbe = {
  env: process.env,
  exists: existsSync,
  onPath: (program) => (process.env["PATH"] ?? "").split(delimiter).some((dir) => dir !== "" && isExecutable(join(dir, program)))
}

/**
 * The PipeWire socket this process would connect to: `$PIPEWIRE_RUNTIME_DIR` (else `$XDG_RUNTIME_DIR`) +
 * `$PIPEWIRE_REMOTE` (else `pipewire-0`), as libpipewire resolves it. `undefined` without a runtime directory.
 */
export const pipeWireSocket = (env: NodeJS.ProcessEnv): string | undefined => {
  const remote = env["PIPEWIRE_REMOTE"] ?? "pipewire-0"
  if (remote.startsWith("/")) return remote
  const dir = env["PIPEWIRE_RUNTIME_DIR"] || env["XDG_RUNTIME_DIR"]
  return dir === undefined || dir === "" ? undefined : join(dir, remote)
}

/**
 * The backend rule of docs/VOICE-NODES.md §7.2: PipeWire where it runs, ALSA where it does not. `auto` means
 * PipeWire when `pw-record` and `pw-cat` are installed and this process can reach a PipeWire daemon (its socket in
 * the user's runtime directory exists: a desktop session, or the user unit of a lingering user), else ALSA. The
 * system unit (`User=pva-node`, no session, no `XDG_RUNTIME_DIR`) therefore always gets ALSA; the installer also
 * writes the explicit choice into the unit (`--audio alsa|pipewire`), so `auto` is the fallback for manual runs.
 */
export const chooseBackend = (choice: BackendChoice, probe: BackendProbe = systemProbe): DeviceBackend => {
  if (choice !== "auto") return choice
  const socket = pipeWireSocket(probe.env)
  const pipeWire = socket !== undefined && probe.exists(socket) && probe.onPath("pw-record") && probe.onPath("pw-cat")
  return pipeWire ? "pipewire" : "alsa"
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
  /** Backend device ids (`""` / undefined = the backend's default); `soundDevices` of the pushed setup. */
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

/** The ALSA options for these node options: `""` / unset devices are ALSA's `default` PCM. */
export const alsaOptionsFor = (options: NodeAudioOptions) => ({
  captureDevice: blank(options.inputDevice) ?? alsaDefaults.captureDevice,
  playbackDevice: blank(options.outputDevice) ?? alsaDefaults.playbackDevice,
  captureLatencyMs: options.captureLatencyMs ?? alsaDefaults.captureLatencyMs,
  playbackLatencyMs: options.playbackLatencyMs ?? alsaDefaults.playbackLatencyMs
})

/** ALSA through `@pva/audio-alsa`'s commands, run by the same process plumbing as PipeWire (`makeAudioInput` …). */
const alsaLayers = (options: NodeAudioOptions): DeviceLayers => {
  const alsa = alsaOptionsFor(options)
  return {
    input: pipeWireInput(alsaCaptureCommand(alsa)),
    output: pipeWireOutput((rate) => alsaPlaybackCommand(alsa, rate)),
    outputLatencyMs: alsa.playbackLatencyMs
  }
}

/** What the node plays and records with, for one choice of devices. */
export interface NodeAudio {
  readonly input: AudioInput["Service"]
  readonly output: AudioOutput["Service"]
  readonly info: NodeAudioInfo["Service"]
}

/** The audio services for these options (device backends are only built when used). */
export const buildAudio = (options: NodeAudioOptions): NodeAudio => {
  const needsDevice = options.inputWav === undefined || options.outputWav === undefined
  const device = needsDevice ? (options.backend === "alsa" ? alsaLayers(options) : pipeWireLayers(options)) : undefined
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
  return {
    input,
    output,
    info: NodeAudioInfo.of({
      input: options.inputWav !== undefined ? "file" : options.backend,
      output: fileOutput ? "file" : options.backend,
      outputLatencyMs: fileOutput ? 0 : device!.outputLatencyMs,
      cueOutput
    })
  }
}

/** `AudioInput`, `AudioOutput` and `NodeAudioInfo` for these options. */
export const audioLayer = (options: NodeAudioOptions): Layer.Layer<AudioInput | AudioOutput | NodeAudioInfo, AudioError> =>
  Layer.effectContext(Effect.sync(() => {
    const audio = buildAudio(options)
    return Context.make(AudioInput, audio.input).pipe(Context.add(AudioOutput, audio.output), Context.add(NodeAudioInfo, audio.info))
  }))

/** The programs a backend needs that are not on `PATH` (`node.status.missingTools`). */
export const missingTools = (backend: DeviceBackend, probe: BackendProbe = systemProbe): Array<string> =>
  (backend === "alsa" ? ["arecord", "aplay"] : ["pw-record", "pw-cat", "pw-dump"]).filter((program) => !probe.onPath(program))

/**
 * The devices of a backend for `pva-node devices` (and `node.status`): PipeWire's sources and sinks from
 * `pw-dump` (ids are `node.name`s), ALSA's `default` and `plughw:CARD=…` PCMs from `arecord -L` / `aplay -L`. Each id
 * is what `--input-device` / `--output-device` (and `soundDevices`) take; `""` always
 * means the backend's default. Fails with `AudioError` when the listing program is missing or fails.
 */
export const listDevices = (backend: DeviceBackend): Effect.Effect<AudioDevices, AudioError> =>
  backend === "alsa" ? listAlsaDevices : listPipeWireDevices
