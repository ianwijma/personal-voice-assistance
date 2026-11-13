/**
 * The audio lifecycle at the level of the client (`createAssistantClient`), with a fake
 * `getUserMedia` whose answers the test settles in every order (second review, findings 3–5).
 *
 * Invariants checked after every scenario:
 * - at most one microphone stream is live, and when the page says `running` it is the one
 *   connected to the capture graph;
 * - a superseded or abandoned request never changes the page's phase, never sends anything to the
 *   server and never closes the session that replaced it.
 */
import { encodeServerMessage } from "@pva/protocol"
import { serverExamples } from "@pva/protocol/examples"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Lifecycle } from "../src/lib/audio/lifecycle.ts"
import { createAssistantClient } from "../src/lib/client.ts"
import { flush, installFakeAudio } from "./fakeAudio.ts"

let fake: ReturnType<typeof installFakeAudio>

beforeEach(() => {
  fake = installFakeAudio()
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: async () => ({ release: async () => undefined }) }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const newClient = () => {
  const client = createAssistantClient()
  const sent: Array<{ type: string }> = []
  vi.spyOn(client.connection, "send").mockImplementation((m) => {
    sent.push(m)
    return true
  })
  return { client, sent, phase: () => client.store.get().audio.phase }
}

/** A stand-in socket: the test delivers server messages to the client through `deliver`. */
class FakeSocket {
  static last: FakeSocket | undefined
  readyState = 1
  binaryType = "arraybuffer"
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.last = this
    setTimeout(() => this.onopen?.(), 0)
  }
  send() {}
  close() {}
  deliver(message: unknown) {
    this.onmessage?.({ data: encodeServerMessage(message as never) })
  }
}

/** The client connected (welcome received) through a `FakeSocket`. */
const connected = async (client: ReturnType<typeof createAssistantClient>) => {
  ;(globalThis as any).WebSocket = FakeSocket
  client.connect()
  await new Promise((r) => setTimeout(r, 5))
  FakeSocket.last!.deliver(serverExamples.welcome)
  await flush()
  return FakeSocket.last!
}

const denied = () => new DOMException("denied", "NotAllowedError")
const unavailable = () => new DOMException("no such device", "OverconstrainedError")

/** At most one live stream; when running, it is the connected one. */
const expectConsistent = (phase: string) => {
  const live = fake.liveStreams()
  expect(live.length).toBeLessThanOrEqual(1)
  if (phase === "running") {
    expect(live.length).toBe(1)
    expect(fake.connected()).toBe(live[0])
  }
  if (phase === "off" || phase === "error") expect(live).toEqual([])
}

describe("lifecycle state machine", () => {
  it("follows the documented transitions and refuses the others", () => {
    const l = new Lifecycle()
    expect(l.dispatch("started")).toBeUndefined()
    const a = l.dispatch("start")!
    expect(l.state).toBe("starting")
    l.dispatch("mic-change")
    expect(l.isSession(a)).toBe(true)
    expect(l.isRequest(a)).toBe(false) // superseded request, same session
    l.dispatch("mic-acquired")
    l.dispatch("started")
    expect(l.state).toBe("running")
    l.dispatch("mic-change")
    expect(l.state).toBe("replacing")
    l.dispatch("mic-acquired")
    expect(l.state).toBe("running")
    l.dispatch("end")
    expect(l.isSession(a)).toBe(false)
    expect(l.state).toBe("stopping")
    expect(l.dispatch("mic-acquired")).toBeUndefined()
    l.dispatch("stopped")
    expect(l.state).toBe("idle")
    const b = l.dispatch("start")!
    l.dispatch("track-ended")
    expect(l.state).toBe("failed")
    expect(l.isSession(b)).toBe(false)
  })
})

describe("finding 3: an abandoned Start never overwrites the session that replaced it", () => {
  const outcomes = ["resolve", "reject"] as const
  for (const first of outcomes) {
    for (const second of outcomes) {
      for (const order of [[0, 1], [1, 0]] as const) {
        it(`Start A, End, Start B; A ${first}s, B ${second}s, settling ${order.join(" then ")}`, async () => {
          const { client, sent, phase } = newClient()
          client.startAudio() // A: waits for permission
          client.endAudio()
          await flush()
          client.startAudio() // B
          expect(phase()).toBe("starting")
          const settle = { 0: first, 1: second }
          for (const k of order) {
            const p = fake.pending[k]!
            if (settle[k] === "resolve") p.resolve()
            else p.reject(k === 0 ? denied() : denied())
            await flush()
          }
          await flush()
          if (second === "resolve") {
            expect(phase()).toBe("running")
            expect(client.store.get().audio.error).toBeUndefined()
            expect(fake.liveStreams()).toEqual([fake.pending[1]!.stream])
            expect(sent.filter((m) => m.type === "audio.claim")).toHaveLength(1)
          } else {
            expect(phase()).toBe("error")
            expect(client.store.get().audio.error).toMatch(/permission was denied/)
          }
          expect(fake.pending[0]!.stream.live).toBe(false)
          expectConsistent(phase())
          // Start again: a running page only reclaims, and its phase stays right.
          if (second === "resolve") {
            client.startAudio()
            expect(phase()).toBe("running")
          }
        })
      }
    }
  }

  it("a release that finishes after a new Start does not set the page to off", async () => {
    const { client, phase } = newClient()
    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    client.endAudio() // its close finishes asynchronously
    client.startAudio()
    await flush()
    expect(phase()).toBe("starting")
    fake.pending[1]!.resolve()
    await flush()
    expect(phase()).toBe("running")
    expectConsistent(phase())
  })

  it("a takeover while a microphone change waits: the late permission opens nothing and changes nothing", async () => {
    const { client, sent, phase } = newClient()
    const socket = await connected(client)
    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    client.setPrefs({ micDeviceId: "usb" }) // replacement pending
    await flush()
    socket.deliver(serverExamples.session) // observer, taken_over
    await flush()
    sent.length = 0
    fake.pending[1]!.resolve()
    await flush()
    expect(fake.liveStreams()).toEqual([])
    expect(sent).toEqual([])
    expect(phase()).toBe("off")
    expect(client.store.get().toasts).toEqual([])
  })
})

describe("finding 4: a microphone change during Start does not cancel the session", () => {
  for (const change of ["device", "processing"] as const) {
    for (const first of ["resolve", "reject"] as const) {
      it(`${change} changed while permission is pending; the first answer ${first}s; the latest choice is opened`, async () => {
        const { client, sent, phase } = newClient()
        client.startAudio()
        if (change === "device") client.setPrefs({ micDeviceId: "usb" })
        else client.setPrefs({ echoCancellation: false })
        await flush()
        expect(fake.pending).toHaveLength(1) // no second prompt while the first is pending
        if (first === "resolve") fake.pending[0]!.resolve()
        else fake.pending[0]!.reject(unavailable())
        await flush()
        expect(phase()).toBe("starting")
        expect(fake.pending).toHaveLength(2)
        const audio = fake.pending[1]!.constraints.audio as MediaTrackConstraints
        if (change === "device") expect(audio.deviceId).toEqual({ exact: "usb" })
        else expect(audio.echoCancellation).toBe(false)
        fake.pending[1]!.resolve()
        await flush()
        expect(phase()).toBe("running")
        expect(fake.liveStreams()).toEqual([fake.pending[1]!.stream])
        expect(sent.map((m) => m.type)).toContain("audio.claim")
        expect(client.store.get().toasts).toEqual([])
        expectConsistent(phase())
      })
    }
  }

  it("a change after permission but before the graph is built is applied once the session runs", async () => {
    const { client, phase } = newClient()
    client.startAudio()
    let loaded!: () => void
    const loading = new Promise<void>((r) => (loaded = r))
    ;(fake.contexts[0]!.audioWorklet as { addModule: () => Promise<void> }).addModule = () => loading
    fake.pending[0]!.resolve()
    await flush()
    expect(phase()).toBe("starting") // microphone granted, worklets still loading
    client.setPrefs({ micDeviceId: "usb" })
    await flush()
    expect(fake.pending).toHaveLength(1) // recorded, not opened yet
    loaded()
    await flush()
    expect(phase()).toBe("running")
    expect(fake.pending).toHaveLength(2)
    fake.pending[1]!.resolve()
    await flush()
    expect(fake.liveStreams()).toEqual([fake.pending[1]!.stream])
    expectConsistent(phase())
  })
})

describe("finding 5: a failed microphone replacement never leaves a silent owner", () => {
  const owning = async () => {
    const c = newClient()
    c.client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    c.client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    c.sent.length = 0
    return c
  }

  it("an unavailable microphone: the previous one is opened again, the settings say so, a toast explains", async () => {
    const { client, sent, phase } = await owning()
    client.setPrefs({ micDeviceId: "gone" })
    await flush()
    fake.pending[1]!.reject(unavailable())
    await flush()
    expect(fake.pending).toHaveLength(3)
    expect((fake.pending[2]!.constraints.audio as MediaTrackConstraints).deviceId).toBeUndefined() // the previous: default
    fake.pending[2]!.resolve()
    await flush()
    expect(phase()).toBe("running")
    expect(fake.liveStreams()).toEqual([fake.pending[2]!.stream])
    expect(client.prefs.get().micDeviceId).toBe("")
    expect(client.store.get().toasts.at(-1)?.message).toMatch(/not available.*previous microphone/)
    expect(sent.map((m) => m.type)).not.toContain("audio.release")
    expectConsistent(phase())
  })

  it("nothing can be opened: ownership is released and audio closed (the fatal path)", async () => {
    const { client, sent, phase } = await owning()
    client.setPrefs({ micDeviceId: "gone" })
    await flush()
    fake.pending[1]!.reject(unavailable())
    await flush()
    fake.pending[2]!.reject(new DOMException("busy", "NotReadableError"))
    await flush()
    expect(sent.map((m) => m.type)).toContain("audio.release")
    expect(phase()).toBe("error")
    expect(fake.contexts[0]!.state).toBe("closed")
    expect(client.store.get().toasts).toEqual([]) // the error is on the page, not in a toast as well
    expectConsistent(phase())
  })

  it("a stale failure (End came first) changes nothing", async () => {
    const { client, sent, phase } = await owning()
    client.setPrefs({ micDeviceId: "gone" })
    client.endAudio()
    await flush()
    sent.length = 0
    fake.pending[1]!.reject(unavailable())
    await flush()
    expect(fake.pending).toHaveLength(2) // no fallback attempt for a dead session
    expect(sent).toEqual([])
    expect(phase()).toBe("off")
    expect(client.store.get().toasts).toEqual([])
  })

  it("overlapping changes: only the latest one's failure is handled", async () => {
    const { client, sent, phase } = await owning()
    client.setPrefs({ micDeviceId: "a" })
    client.setPrefs({ micDeviceId: "b" })
    await flush()
    fake.pending[1]!.reject(unavailable()) // superseded: ignored
    fake.pending[2]!.resolve()
    await flush()
    expect(phase()).toBe("running")
    expect(fake.liveStreams()).toEqual([fake.pending[2]!.stream])
    expect(client.prefs.get().micDeviceId).toBe("b")
    expect(client.store.get().toasts).toEqual([])
    expect(sent.map((m) => m.type)).not.toContain("audio.release")
  })
})

describe("unconfirmed: capture that stays muted after an interruption", () => {
  it("a track muted for 1.5 s while the context runs is reopened once; a short mute is not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const { client, phase } = newClient()
    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    const track = fake.pending[0]!.stream.track
    track.setMuted(true)
    vi.advanceTimersByTime(500)
    track.setMuted(false) // a short interruption recovers by itself
    vi.advanceTimersByTime(2000)
    expect(fake.pending).toHaveLength(1)
    track.setMuted(true)
    vi.advanceTimersByTime(1600)
    await flush()
    expect(fake.pending).toHaveLength(2) // reopened
    fake.pending[1]!.resolve()
    await flush()
    expect(phase()).toBe("running")
    expect(fake.liveStreams()).toEqual([fake.pending[1]!.stream])
    // A microphone muted for good is not reopened in a loop.
    fake.pending[1]!.stream.track.setMuted(true)
    vi.advanceTimersByTime(1600)
    await flush()
    expect(fake.pending).toHaveLength(2)
  })
})
