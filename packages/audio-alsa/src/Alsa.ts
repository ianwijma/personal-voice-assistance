import { AudioInput, AudioOutput, type AudioError } from "@pva/core"
import {
  type AudioDeviceInfo,
  captureSampleRate,
  type Command,
  makeAudioInput,
  makeAudioOutput,
  makeDeviceInfo,
  runToCompletion
} from "@pva/audio-pipewire"
import { Config, Effect, Layer } from "effect"

export interface AlsaOptions {
  /**
   * ALSA PCM to record from, e.g. `plughw:CARD=Speaker,DEV=0` (card names, never indexes: indexes change with USB
   * order; `plughw` converts to 16 kHz mono). `default` is whatever the system's ALSA configuration says.
   */
  readonly captureDevice: string
  /** ALSA PCM to play to; same naming. */
  readonly playbackDevice: string
  /** Requested capture buffer in ms (`arecord --buffer-time`). */
  readonly captureLatencyMs: number
  /** Requested playback buffer in ms (`aplay --buffer-time`). */
  readonly playbackLatencyMs: number
}

export const defaultOptions: AlsaOptions = {
  captureDevice: "default",
  playbackDevice: "default",
  captureLatencyMs: 20,
  playbackLatencyMs: 20
}

/** A period is a quarter of the buffer, so the device wakes the process four times per buffer. */
const bufferArgs = (latencyMs: number) => {
  const bufferUs = Math.max(1, Math.round(latencyMs * 1000))
  return [`--buffer-time=${bufferUs}`, `--period-time=${Math.max(1, Math.round(bufferUs / 4))}`]
}

const commonArgs = (device: string, sampleRate: number, latencyMs: number) => [
  "-q",
  "-D", device,
  "-t", "raw",
  "-f", "S16_LE",
  "-r", String(sampleRate),
  "-c", "1",
  ...bufferArgs(latencyMs),
  "-" // stdout (arecord) / stdin (aplay)
]

/** `arecord` writing raw 16 kHz mono s16le to stdout. */
export const captureCommand = (options: AlsaOptions): Command => ({
  command: "arecord",
  args: commonArgs(options.captureDevice, captureSampleRate, options.captureLatencyMs)
})

/** `aplay` reading raw mono s16le at `sampleRate` from stdin; exits after draining at end of input. */
export const playbackCommand = (options: AlsaOptions, sampleRate: number): Command => ({
  command: "aplay",
  args: commonArgs(options.playbackDevice, sampleRate, options.playbackLatencyMs)
})

export const layerInput = (options: AlsaOptions = defaultOptions): Layer.Layer<AudioInput> =>
  Layer.succeed(AudioInput, makeAudioInput(captureCommand(options)))

export const layerOutput = (options: AlsaOptions = defaultOptions): Layer.Layer<AudioOutput> =>
  Layer.succeed(AudioOutput, makeAudioOutput((rate) => playbackCommand(options, rate)))

export const layer = (options: AlsaOptions = defaultOptions): Layer.Layer<AudioInput | AudioOutput> =>
  Layer.mergeAll(layerInput(options), layerOutput(options))

/**
 * Options from the environment: `ALSA_CAPTURE_DEVICE`, `ALSA_PLAYBACK_DEVICE` (default `default`),
 * `ALSA_CAPTURE_LATENCY_MS`, `ALSA_PLAYBACK_LATENCY_MS` (default 20).
 */
export const AlsaConfig: Config.Config<AlsaOptions> = Config.all({
  captureDevice: Config.String("ALSA_CAPTURE_DEVICE").pipe(Config.withDefault(defaultOptions.captureDevice)),
  playbackDevice: Config.String("ALSA_PLAYBACK_DEVICE").pipe(Config.withDefault(defaultOptions.playbackDevice)),
  captureLatencyMs: Config.Int("ALSA_CAPTURE_LATENCY_MS").pipe(Config.withDefault(defaultOptions.captureLatencyMs)),
  playbackLatencyMs: Config.Int("ALSA_PLAYBACK_LATENCY_MS").pipe(Config.withDefault(defaultOptions.playbackLatencyMs))
})

export const layerConfig: Layer.Layer<AudioInput | AudioOutput, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    return layer(yield* AlsaConfig)
  })
)

// --- device listing ----------------------------------------------------------------------------------------------

/** One entry of `arecord -L` / `aplay -L`: a PCM name at column 0, then indented description lines. */
const parseEntries = (text: string): Array<{ readonly name: string; readonly description: ReadonlyArray<string> }> => {
  const entries: Array<{ name: string; description: Array<string> }> = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    if (/^\s/.test(line)) entries[entries.length - 1]?.description.push(line.trim())
    else entries.push({ name: line.trim(), description: [] })
  }
  return entries
}

/**
 * Devices from the output of `arecord -L` (capture) or `aplay -L` (playback; the format is the same). Only what an
 * owner should pick from is kept: `default` and the `plughw:` PCMs (hardware with software conversion, so 16 kHz
 * mono works on any card). Everything else (`hw:` which cannot convert, `front:`, `surround*`, `hdmi:`, `iec958:`,
 * `usbstream:`, `null`, `pulse`, ...) is dropped. The name is the first description line (the card's own name);
 * a device other than 0 of a card gets ` (device N)`. Only `default` is marked as the default. Never throws.
 */
export const parseAlsaList = (text: string): ReadonlyArray<AudioDeviceInfo> => {
  const devices: Array<AudioDeviceInfo> = []
  for (const entry of parseEntries(text)) {
    if (entry.name !== "default" && !entry.name.startsWith("plughw:")) continue
    let label = entry.description[0] ?? entry.name
    const dev = /(?:^|,)DEV=(\d+)/.exec(entry.name)?.[1]
    if (dev !== undefined && dev !== "0") label += ` (device ${dev})`
    const device = makeDeviceInfo(entry.name, label, entry.name === "default")
    if (device !== undefined) devices.push(device)
  }
  return devices
}

export const listCaptureCommand: Command = { command: "arecord", args: ["-L"] }
export const listPlaybackCommand: Command = { command: "aplay", args: ["-L"] }

export interface AlsaDevices {
  readonly inputs: ReadonlyArray<AudioDeviceInfo>
  readonly outputs: ReadonlyArray<AudioDeviceInfo>
}

/** Capture and playback devices (runs `arecord -L` and `aplay -L`). Fails with `AudioError` if alsa-utils is missing. */
export const listAlsaDevices: Effect.Effect<AlsaDevices, AudioError> = Effect.all({
  inputs: Effect.map(runToCompletion(listCaptureCommand), parseAlsaList),
  outputs: Effect.map(runToCompletion(listPlaybackCommand), parseAlsaList)
}, { concurrency: 2 })
