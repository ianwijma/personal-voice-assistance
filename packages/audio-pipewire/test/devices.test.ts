import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeDeviceInfo, parsePwDump, runToCompletion } from "../src/index.ts"

const sample = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/devices/${name}`, import.meta.url)), "utf8")

describe("parsePwDump", () => {
  it("lists sources and sinks of a desktop with a USB speakerphone and echo-cancel nodes, with the defaults marked", () => {
    const devices = parsePwDump(sample("pw-dump.desktop-usb.json"))
    assert.deepStrictEqual(devices.inputs, [
      { id: "alsa_input.pci-0000_00_1f.3.analog-stereo", name: "Built-in Audio Analog Stereo", isDefault: false },
      { id: "alsa_input.usb-Jabra_SPEAK_410_USB-00.mono-fallback", name: "Jabra SPEAK 410 USB Mono", isDefault: true },
      { id: "pva-echo-cancel-source", name: "PVA echo-cancelled mic", isDefault: false }
    ])
    assert.deepStrictEqual(devices.outputs, [
      { id: "alsa_output.pci-0000_00_1f.3.analog-stereo", name: "Built-in Audio Analog Stereo", isDefault: false },
      { id: "alsa_output.usb-Jabra_SPEAK_410_USB-00.analog-stereo", name: "Jabra SPEAK 410 USB Analog Stereo", isDefault: true },
      { id: "pva-echo-cancel-sink", name: "PVA echo-cancel speaker", isDefault: false }
    ])
  })

  it("reads a real pw-dump from a machine with only the dummy sink (no stream, video or midi nodes listed)", () => {
    const devices = parsePwDump(sample("pw-dump.dev-machine.json"))
    assert.deepStrictEqual(devices.inputs, [])
    assert.deepStrictEqual(devices.outputs, [{ id: "auto_null", name: "Dummy Output", isDefault: true }])
  })

  it("returns nothing, and does not throw, for output that is not pw-dump", () => {
    for (const text of ["", "not json", "null", "{}", "[1,null,\"x\",{\"type\":\"PipeWire:Interface:Node\"}]"]) {
      assert.deepStrictEqual(parsePwDump(text), { inputs: [], outputs: [] }, text)
    }
  })

  it("falls back to node.nick, then node.name, for the label", () => {
    const node = (props: object) => ({ type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Sink", ...props } } })
    const devices = parsePwDump(JSON.stringify([
      node({ "node.name": "a", "node.nick": "Nick" }),
      node({ "node.name": "b" })
    ]))
    assert.deepStrictEqual(devices.outputs.map((d) => d.name), ["Nick", "b"])
  })
})

describe("makeDeviceInfo", () => {
  it("enforces the protocol limits: ids over 200 are dropped, names over 120 are shortened", () => {
    assert.isUndefined(makeDeviceInfo("x".repeat(201), "n", false))
    assert.isUndefined(makeDeviceInfo("  ", "n", false))
    const long = makeDeviceInfo("id", "n".repeat(300), true)
    assert.strictEqual(long?.name.length, 120)
    assert.strictEqual(makeDeviceInfo("id", " ", false)?.name, "id")
  })
})

describe("runToCompletion", () => {
  it.live("returns stdout", () =>
    Effect.gen(function*() {
      const out = yield* runToCompletion({ command: process.execPath, args: ["-e", "process.stdout.write('hi')"] })
      assert.strictEqual(out, "hi")
    }))

  it.live("a non-zero exit fails with AudioError carrying stderr", () =>
    Effect.gen(function*() {
      const error = yield* runToCompletion({ command: process.execPath, args: ["-e", "console.error('no daemon');process.exit(1)"] }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AudioError")
      assert.include(error.message, "no daemon")
    }))

  it.live("a program that hangs is killed after the timeout", () =>
    Effect.gen(function*() {
      const error = yield* runToCompletion({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, 300).pipe(Effect.flip)
      assert.include(error.message, "did not finish within 300 ms")
    }))

  it.live("a missing program fails with AudioError", () =>
    Effect.gen(function*() {
      const error = yield* runToCompletion({ command: "/nonexistent/pw-dump", args: [] }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AudioError")
    }))
})
