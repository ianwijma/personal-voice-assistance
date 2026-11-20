/**
 * The node's audio backends (docs/VOICE-NODES.md §7.2): the `auto` rule, the ALSA wiring through `@pva/audio-alsa`
 * and the device lists of both backends. The real `arecord` / `aplay` / `pw-dump` are replaced by stand-in programs
 * on `PATH`, so this runs on a machine without a sound card and checks the exact command lines the node starts.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AudioInput, AudioOutput } from "@pva/core"
import { Effect, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { alsaOptionsFor, audioLayer, type BackendProbe, chooseBackend, listDevices, NodeAudioInfo, pipeWireSocket } from "../src/audio.ts"

const ARECORD_L = `null
    Discard all samples (playback) or generate zero samples (capture)
default
    Default Audio Device
hw:CARD=Speaker,DEV=0
    Jabra SPEAK 410 USB, USB Audio
    Direct hardware device without any conversions
plughw:CARD=Speaker,DEV=0
    Jabra SPEAK 410 USB, USB Audio
    Hardware device with all software conversions
`

const APLAY_L = `${ARECORD_L}plughw:CARD=Headphones,DEV=0
    bcm2835 Headphones, bcm2835 Headphones
    Hardware device with all software conversions
`

const PW_DUMP = JSON.stringify([
  {
    type: "PipeWire:Interface:Metadata",
    props: { "metadata.name": "default" },
    metadata: [
      { key: "default.audio.source", value: { name: "alsa_input.usb-Jabra" } },
      { key: "default.audio.sink", value: { name: "alsa_output.usb-Jabra" } }
    ]
  },
  { type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Source", "node.name": "alsa_input.usb-Jabra", "node.description": "Jabra SPEAK 410 Mono" } } },
  { type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Sink", "node.name": "alsa_output.usb-Jabra", "node.description": "Jabra SPEAK 410 Analog Stereo" } } },
  { type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Sink", "node.name": "hdmi", "node.description": "HDMI" } } }
])

let dir: string
let savedPath: string | undefined

const script = (name: string, body: string) => {
  const path = join(dir, "bin", name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pva-node-audio-"))
  mkdirSync(join(dir, "bin"))
  writeFileSync(join(dir, "arecord-L.txt"), ARECORD_L)
  writeFileSync(join(dir, "aplay-L.txt"), APLAY_L)
  writeFileSync(join(dir, "pw-dump.json"), PW_DUMP)
  // -L lists; anything else records its arguments, then captures (zeros) or plays (stdin to a file).
  script("arecord", `[ "$1" = "-L" ] && exec cat "${dir}/arecord-L.txt"\necho "$@" > "${dir}/arecord.args"\nexec cat /dev/zero`)
  script("aplay", `[ "$1" = "-L" ] && exec cat "${dir}/aplay-L.txt"\necho "$@" > "${dir}/aplay.args"\nexec cat > "${dir}/aplay.out"`)
  script("pw-dump", `exec cat "${dir}/pw-dump.json"`)
  savedPath = process.env["PATH"]
  process.env["PATH"] = `${join(dir, "bin")}:${savedPath ?? ""}`
})

afterAll(() => {
  process.env["PATH"] = savedPath
  rmSync(dir, { recursive: true, force: true })
})

const probe = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>, programs: ReadonlyArray<string>): BackendProbe => ({
  env,
  exists: (path) => files.includes(path),
  onPath: (program) => programs.includes(program)
})

describe("backend choice (auto)", () => {
  const pw = ["pw-record", "pw-cat"]

  it("takes an explicit choice as given", () => {
    expect(chooseBackend("alsa", probe({ XDG_RUNTIME_DIR: "/run/user/1000" }, ["/run/user/1000/pipewire-0"], pw))).toBe("alsa")
    expect(chooseBackend("pipewire", probe({}, [], []))).toBe("pipewire")
  })

  it("is PipeWire when the user's PipeWire socket exists and its tools are installed", () => {
    expect(chooseBackend("auto", probe({ XDG_RUNTIME_DIR: "/run/user/1000" }, ["/run/user/1000/pipewire-0"], pw))).toBe("pipewire")
  })

  it("is ALSA for a system service (no runtime directory), without a running daemon, or without the tools", () => {
    expect(chooseBackend("auto", probe({}, ["/run/user/1000/pipewire-0"], pw))).toBe("alsa")
    expect(chooseBackend("auto", probe({ XDG_RUNTIME_DIR: "/run/user/1000" }, [], pw))).toBe("alsa")
    expect(chooseBackend("auto", probe({ XDG_RUNTIME_DIR: "/run/user/1000" }, ["/run/user/1000/pipewire-0"], ["pw-record"]))).toBe("alsa")
  })

  it("resolves the socket as libpipewire does", () => {
    expect(pipeWireSocket({ XDG_RUNTIME_DIR: "/run/user/7" })).toBe("/run/user/7/pipewire-0")
    expect(pipeWireSocket({ XDG_RUNTIME_DIR: "/run/user/7", PIPEWIRE_RUNTIME_DIR: "/srv/pw" })).toBe("/srv/pw/pipewire-0")
    expect(pipeWireSocket({ XDG_RUNTIME_DIR: "/run/user/7", PIPEWIRE_REMOTE: "other" })).toBe("/run/user/7/other")
    expect(pipeWireSocket({ PIPEWIRE_REMOTE: "/abs/sock" })).toBe("/abs/sock")
    expect(pipeWireSocket({})).toBeUndefined()
  })
})

describe("ALSA backend", () => {
  it("maps the profile's empty device to ALSA's default PCM, a card name through as given", () => {
    expect(alsaOptionsFor({ backend: "alsa" })).toMatchObject({ captureDevice: "default", playbackDevice: "default" })
    expect(alsaOptionsFor({ backend: "alsa", inputDevice: "", outputDevice: "plughw:CARD=Speaker,DEV=0" }))
      .toMatchObject({ captureDevice: "default", playbackDevice: "plughw:CARD=Speaker,DEV=0" })
  })

  it("captures through arecord and plays through aplay on the chosen devices", async () => {
    const layer = audioLayer({ backend: "alsa", inputDevice: "plughw:CARD=Speaker,DEV=0", playbackLatencyMs: 40 })
    const result = await Effect.runPromise(Effect.gen(function*() {
      const input = yield* AudioInput
      const output = yield* AudioOutput
      const info = yield* NodeAudioInfo
      const frames = yield* input.stream.pipe(Stream.take(3), Stream.runCollect)
      yield* output.play(Stream.make(new Uint8Array(4800).fill(7)), 24_000)
      return { frames: frames.map((f) => f.length), info }
    }).pipe(Effect.provide(layer)))
    expect(result.frames).toEqual([640, 640, 640])
    expect(result.info).toMatchObject({ input: "alsa", output: "alsa", outputLatencyMs: 40 })
    expect(readFileSync(join(dir, "arecord.args"), "utf8").trim())
      .toBe("-q -D plughw:CARD=Speaker,DEV=0 -t raw -f S16_LE -r 16000 -c 1 --buffer-time=20000 --period-time=5000 -")
    expect(readFileSync(join(dir, "aplay.args"), "utf8").trim())
      .toBe("-q -D default -t raw -f S16_LE -r 24000 -c 1 --buffer-time=40000 --period-time=10000 -")
    expect(readFileSync(join(dir, "aplay.out")).length).toBe(4800)
  })
})

describe("device lists", () => {
  it("ALSA: default and the plughw PCMs of arecord -L / aplay -L", async () => {
    const list = await Effect.runPromise(listDevices("alsa"))
    expect(list.inputs).toEqual([
      { id: "default", name: "Default Audio Device", isDefault: true },
      { id: "plughw:CARD=Speaker,DEV=0", name: "Jabra SPEAK 410 USB, USB Audio", isDefault: false }
    ])
    expect(list.outputs.map((d) => d.id)).toEqual(["default", "plughw:CARD=Speaker,DEV=0", "plughw:CARD=Headphones,DEV=0"])
  })

  it("PipeWire: sources and sinks of pw-dump with the metadata defaults", async () => {
    const list = await Effect.runPromise(listDevices("pipewire"))
    expect(list.inputs).toEqual([{ id: "alsa_input.usb-Jabra", name: "Jabra SPEAK 410 Mono", isDefault: true }])
    expect(list.outputs).toEqual([
      { id: "alsa_output.usb-Jabra", name: "Jabra SPEAK 410 Analog Stereo", isDefault: true },
      { id: "hdmi", name: "HDMI", isDefault: false }
    ])
  })
})
