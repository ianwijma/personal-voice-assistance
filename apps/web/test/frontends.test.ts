import { describe, expect, it } from "vitest"
import { DEFAULT_DEVICE_PROFILE, type ServerMessage } from "@pva/protocol"
import { exampleAdminSnapshot, exampleDevice, exampleFrontend, serverExamples } from "@pva/protocol/examples"
import { CUE_MS, CUE_RATE, wakeCue } from "@/lib/audio/cue.ts"
import { deviceId, deviceNameFromUserAgent } from "@/lib/device.ts"
import { lastSeenText, phraseFromHeard, phraseProblem } from "@/lib/profileForm.ts"
import { buildSettingsTree, parentPath, resolveSettingsPath, typePageId } from "@/lib/settingsTree.ts"
import { type Action, type ClientState, displayPhrase, heardOutcome, initialState, profileOf, reducer, visualState } from "@/lib/state.ts"
import { profileMessage } from "./profile.ts"

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const welcome = serverExamples.welcome
const owner: Action = { type: "local/audio", phase: "running" }

describe("this browser as a device", () => {
  it("keeps one id in storage, and makes a new valid one when the stored one is missing or bad", () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const a = deviceId(storage)
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(deviceId(storage)).toBe(a)
    store.set("pva.deviceId", "bad id!")
    expect(deviceId(storage)).not.toBe("bad id!")
    expect(deviceId(undefined)).toMatch(/^d-/)
  })

  it("names itself from the user agent", () => {
    expect(deviceNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari")
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Mac · Chrome")
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toBe("Android phone · Chrome")
    expect(deviceNameFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Linux · Firefox")
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Windows · Edge")
    expect(deviceNameFromUserAgent("")).toBe("Browser")
  })
})

describe("reducer, protocol 5", () => {
  it("welcome takes the voice part: the engine summary, the device profile and admin access", () => {
    const s = run([welcome])
    expect(s.summary).toEqual(welcome.snapshot.engine)
    expect(s.device).toEqual(welcome.snapshot.device)
    expect(s.admin).toEqual(welcome.snapshot.admin)
    expect(s.adminReady).toBe(false)
  })

  it("device.profile replaces the profile and clears this page's unconfirmed changes", () => {
    let s = run([welcome, profileMessage()])
    s = reducer(s, { type: "local/profile-overlay", patch: { voice: "natural" } })
    expect(profileOf(s).voice).toBe("natural")
    expect(s.device!.profile.voice).toBe("")
    s = reducer(s, profileMessage({ voice: "natural", activation: "wake-phrase" }))
    expect(s.profileOverlay).toEqual({})
    expect(profileOf(s)).toMatchObject({ voice: "natural", activation: "wake-phrase" })
    expect(profileOf(initialState)).toEqual(DEFAULT_DEVICE_PROFILE)
  })

  it("asleep: its own visual state; the phrase alone shows listening until the next state change", () => {
    let s = run([welcome, owner, profileMessage({ activation: "wake-phrase" }), { type: "state", state: "asleep" }])
    expect(visualState(s)).toBe("asleep")
    s = reducer(s, { type: "wake", phrase: "hey jeff", armed: false })
    expect(visualState(s)).toBe("asleep") // a turn follows; nothing to show
    s = reducer(s, { type: "wake", phrase: "hey jeff", armed: true })
    expect(s.woke).toEqual({ phrase: "hey jeff" })
    expect(visualState(s)).toBe("listening")
    s = reducer(s, { type: "state", state: "listening" })
    expect(s.woke).toBeDefined()
    s = reducer(s, { type: "state", state: "hearing" })
    expect(s.woke).toBeUndefined()
    s = reducer(reducer(s, { type: "wake", phrase: "hey jeff", armed: true }), { type: "state", state: "asleep" })
    expect(visualState(s)).toBe("asleep")
  })

  it("admin: the snapshot, live front ends and devices; a session end empties the admin part", () => {
    let s = run([{ ...welcome, snapshot: { ...welcome.snapshot, admin: { enabled: true, loggedIn: true } } }, serverExamples["admin.snapshot"]])
    expect(s.adminReady).toBe(true)
    expect(s.frontends).toEqual(exampleAdminSnapshot.frontends)
    s = reducer(s, { type: "devices", devices: [] })
    expect(s.devices).toEqual([])
    s = reducer(s, { type: "frontends", frontends: [exampleFrontend] })
    expect(s.frontends).toHaveLength(1)
    s = reducer(s, { type: "wake.heard", text: "hey go", at: 1 })
    s = reducer(s, { type: "wake.heard", text: "hey jeff", matched: "hey jeff", accepted: true, at: 2 })
    s = reducer(s, { type: "wake.heard", text: "and tomorrow", accepted: true, at: 3 })
    s = reducer(s, { type: "wake.heard", text: "the tomatoes", accepted: false, at: 4 })
    expect(s.heard).toEqual([
      { text: "hey go", at: 1 },
      { text: "hey jeff", matched: "hey jeff", accepted: true, at: 2 },
      { text: "and tomorrow", accepted: true, at: 3 },
      { text: "the tomatoes", accepted: false, at: 4 }
    ])
    expect(s.heard.map(heardOutcome)).toEqual(["no-match", "matched", "accepted", "ignored"])
    const seq = s.adminSeq
    s = reducer(s, { type: "admin.state", admin: { enabled: true, loggedIn: false, endReason: "idle" } })
    expect(s.adminSeq).toBe(seq + 1)
    expect(s).toMatchObject({ adminReady: false, modules: { order: [] }, sections: [], frontends: [], devices: [], heard: [] })
    expect(s.admin.endReason).toBe("idle")
  })

  it("a reconnect with a valid token keeps the admin data until the new snapshot; an invalid one drops it", () => {
    const loggedIn = { ...welcome, snapshot: { ...welcome.snapshot, admin: { enabled: true, loggedIn: true } } } satisfies ServerMessage
    const s = run([loggedIn, serverExamples["admin.snapshot"]])
    expect(run([loggedIn], s).adminReady).toBe(true)
    const refused = { ...welcome, snapshot: { ...welcome.snapshot, admin: { enabled: true, loggedIn: false, endReason: "token" as const } } }
    expect(run([refused], s)).toMatchObject({ adminReady: false, frontends: [] })
  })

  it("shows phrases with capitals", () => {
    expect(displayPhrase("hey jeff")).toBe("Hey Jeff")
    expect(displayPhrase("hé jev")).toBe("Hé Jev")
  })
})

describe("the phrase checks and the device list", () => {
  it("checks a new phrase against the protocol's bounds and the list", () => {
    const list = ["hey jeff", "hey jev"]
    expect(phraseProblem("", list)).toMatch(/Type a phrase/)
    expect(phraseProblem("  !! ", list)).toMatch(/Type a phrase/)
    expect(phraseProblem("Hey, Jeff!", list)).toBe("That phrase is already in the list.")
    expect(phraseProblem("one two three four five six seven", list)).toBe("Use at most 6 words.")
    expect(phraseProblem("x".repeat(61), list)).toBe("Use at most 60 characters.")
    expect(phraseProblem("hey geoff", Array.from({ length: 12 }, (_, i) => `p${i}`))).toBe("At most 12 phrases.")
    expect(phraseProblem("hey geoff", list)).toBeUndefined()
  })

  it("Add as phrase takes as many words as the longest phrase", () => {
    expect(phraseFromHeard("Hey go, what's the time?", ["hey jeff"])).toBe("hey go")
    expect(phraseFromHeard("OK computer please listen", ["ok computer please"])).toBe("ok computer please")
    expect(phraseFromHeard("Jeff's here", ["jeff"])).toBe("jeff's")
  })

  it("says when a device was seen", () => {
    const now = 10 * 86_400_000
    expect(lastSeenText({ lastSeen: now, connections: 1 }, now)).toBe("Connected now")
    expect(lastSeenText({ lastSeen: now - 20_000, connections: 0 }, now)).toBe("Seen just now")
    expect(lastSeenText({ lastSeen: now - 5 * 60_000, connections: 0 }, now)).toBe("Seen 5 min ago")
    expect(lastSeenText({ lastSeen: now - 3 * 3_600_000, connections: 0 }, now)).toBe("Seen 3 h ago")
    expect(lastSeenText({ lastSeen: now - 86_400_000, connections: 0 }, now)).toBe("Seen 1 day ago")
  })
})

describe("the admin tree: Devices", () => {
  const pages = [
    { group: "devices", id: "all", title: "All devices", order: 0 },
    { group: "devices", id: "device-type", title: "Device type", order: 10, perItem: true },
    { group: "devices", id: "device", title: "Device", order: 100, perItem: true }
  ]
  const tree = buildSettingsTree({ sections: [], modules: [], clientPages: pages, deviceTypes: [{ kind: "web-voice", title: "Browsers" }], devices: [exampleDevice] })

  it("one unlisted defaults page per type and one unlisted page per device next to the list", () => {
    const devices = tree.find((g) => g.slug === "devices")!
    expect(devices.pages.map((p) => [p.id, p.title, p.listed])).toEqual([["all", "All devices", true], [typePageId("web-voice"), "Every browser", false], [exampleDevice.id, exampleDevice.name, false]])
    expect(tree.map((g) => g.slug)).toEqual(["devices", "shared"]) // Shared settings always lists Modules
  })

  it("a device page resolves by its id, and goes back to the list on every screen", () => {
    expect(resolveSettingsPath(tree, ["devices"], false).page?.id).toBe("all") // the only listed page
    expect(resolveSettingsPath(tree, ["devices", exampleDevice.id], true).page?.source).toEqual({ kind: "client", id: "device" })
    expect(resolveSettingsPath(tree, ["devices", typePageId("web-voice")], true).page?.source).toEqual({ kind: "client", id: "device-type" })
    expect(parentPath(tree, ["devices", exampleDevice.id], true)).toEqual(["devices"])
    expect(parentPath(tree, ["devices", exampleDevice.id], false)).toEqual(["devices"])
    expect(parentPath(tree, ["devices", "all"], true)).toBeUndefined()
    expect(parentPath(tree, ["devices"], false)).toEqual([])
  })
})

describe("the wake cue", () => {
  it("is two soft tones under 200 ms that start and end in silence", () => {
    const pcm = wakeCue()
    expect(CUE_MS).toBeLessThan(200)
    expect(pcm.length).toBe(Math.round((CUE_MS * CUE_RATE) / 1000))
    const peak = pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
    expect(peak).toBeGreaterThan(1000)
    expect(peak).toBeLessThan(0.2 * 32767)
    expect(Math.abs(pcm[0]!)).toBeLessThan(50)
    expect(Math.abs(pcm[pcm.length - 1]!)).toBeLessThan(200)
  })
})
