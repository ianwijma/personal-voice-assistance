import { execFile } from "node:child_process"
import { AudioError } from "@pva/core"
import { Effect } from "effect"
import type { Command } from "./Process.ts"

/** One selectable audio device, as sent to admin (`AudioDeviceInfo`, docs/VOICE-NODES.md §4). */
export interface AudioDeviceInfo {
  /** What the backend accepts to open it: a PipeWire `node.name`, an ALSA PCM name. At most 200 characters. */
  readonly id: string
  /** For people. At most 120 characters. */
  readonly name: string
  /** The device the backend would pick when none is named. */
  readonly isDefault: boolean
}

export interface AudioDevices {
  readonly inputs: ReadonlyArray<AudioDeviceInfo>
  readonly outputs: ReadonlyArray<AudioDeviceInfo>
}

export const maxDeviceIdLength = 200
export const maxDeviceNameLength = 120

/** `undefined` when the id cannot be sent (empty or too long); names are shortened with an ellipsis. */
export const makeDeviceInfo = (id: string, name: string, isDefault: boolean): AudioDeviceInfo | undefined => {
  const cleanId = id.trim()
  if (cleanId === "" || cleanId.length > maxDeviceIdLength) return undefined
  const label = name.trim() === "" ? cleanId : name.trim()
  return {
    id: cleanId,
    name: label.length > maxDeviceNameLength ? `${label.slice(0, maxDeviceNameLength - 1)}…` : label,
    isDefault
  }
}

/**
 * Run a program to completion and return its stdout. Fails with `AudioError` when it cannot start, exits
 * non-zero or runs longer than `timeoutMs` (it is then killed). Used for the device-listing commands.
 */
export const runToCompletion = (command: Command, timeoutMs = 5_000): Effect.Effect<string, AudioError> =>
  Effect.callback<string, AudioError>((resume) => {
    const child = execFile(
      command.command,
      [...command.args],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) return resume(Effect.succeed(stdout))
        const killed = (error as { killed?: boolean }).killed === true
        const detail = killed ? `did not finish within ${timeoutMs} ms` : error.message
        const tail = stderr.trim()
        resume(Effect.fail(new AudioError({
          message: `${command.command}: ${detail}${tail === "" ? "" : `: ${tail.slice(-500)}`}`,
          cause: error
        })))
      }
    )
    return Effect.sync(() => void child.kill("SIGKILL"))
  })

// --- pw-dump -----------------------------------------------------------------------------------------------------

const sourceClasses = new Set(["Audio/Source", "Audio/Source/Virtual"])
const sinkClasses = new Set(["Audio/Sink"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/**
 * Sources and sinks from `pw-dump` JSON. A source is a node with `media.class` `Audio/Source` (or
 * `Audio/Source/Virtual`, e.g. an echo-cancel source), a sink one with `Audio/Sink`; the id is `node.name` (what
 * `PIPEWIRE_CAPTURE_TARGET` / `PIPEWIRE_PLAYBACK_TARGET` take), the name `node.description` (else `node.nick`,
 * else `node.name`). The defaults are the `default.audio.source` / `default.audio.sink` entries of the `default`
 * metadata object. Anything that does not look like pw-dump output yields no devices; it never throws.
 */
export const parsePwDump = (json: string): AudioDevices => {
  let objects: unknown
  try {
    objects = JSON.parse(json)
  } catch {
    return { inputs: [], outputs: [] }
  }
  if (!Array.isArray(objects)) return { inputs: [], outputs: [] }

  let defaultSource: string | undefined
  let defaultSink: string | undefined
  for (const object of objects) {
    if (!isRecord(object) || object["type"] !== "PipeWire:Interface:Metadata") continue
    const props = object["props"]
    if (!isRecord(props) || props["metadata.name"] !== "default") continue
    const entries = object["metadata"]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const value = entry["value"]
      const name = isRecord(value) ? str(value["name"]) : undefined
      if (entry["key"] === "default.audio.source") defaultSource = name
      else if (entry["key"] === "default.audio.sink") defaultSink = name
    }
  }

  const inputs: Array<AudioDeviceInfo> = []
  const outputs: Array<AudioDeviceInfo> = []
  for (const object of objects) {
    if (!isRecord(object) || object["type"] !== "PipeWire:Interface:Node") continue
    const info = object["info"]
    const props = isRecord(info) ? info["props"] : undefined
    if (!isRecord(props)) continue
    const mediaClass = str(props["media.class"])
    const nodeName = str(props["node.name"])
    if (mediaClass === undefined || nodeName === undefined) continue
    const label = str(props["node.description"]) ?? str(props["node.nick"]) ?? nodeName
    if (sourceClasses.has(mediaClass)) {
      const device = makeDeviceInfo(nodeName, label, nodeName === defaultSource)
      if (device !== undefined) inputs.push(device)
    } else if (sinkClasses.has(mediaClass)) {
      const device = makeDeviceInfo(nodeName, label, nodeName === defaultSink)
      if (device !== undefined) outputs.push(device)
    }
  }
  return { inputs, outputs }
}

export const pwDumpCommand: Command = { command: "pw-dump", args: [] }

/** Sources and sinks PipeWire knows right now (runs `pw-dump`). Fails with `AudioError` if PipeWire is not running. */
export const listPipeWireDevices: Effect.Effect<AudioDevices, AudioError> = Effect.map(
  runToCompletion(pwDumpCommand),
  parsePwDump
)
