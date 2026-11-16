/** The per-browser preferences (src/lib/prefs.ts) beyond what `store.test.tsx` and `characters/choice.test.ts` check: the echo test, and the store that persists them. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPrefsStore, defaultPrefs, parsePrefs } from "@/lib/prefs.ts"

const KEY = "pva.prefs.v1"
const echo = { cancelled: true, residualDb: -42, at: 1700000000000, outputPath: "element" }

describe("parsePrefs: the echo test", () => {
  it("keeps a stored echo test, next to a stored character", () => {
    const p = parsePrefs(JSON.stringify({ echoTest: echo, character: { character: "lips" } }))
    expect(p.echoTest).toEqual(echo)
    expect(p.character).toEqual({ character: "lips" })
  })

  it("drops an echo test that is not an object with a boolean `cancelled`", () => {
    for (const bad of [null, 3, "yes", [], {}, { cancelled: "true" }, { cancelled: 1, residualDb: -1 }]) {
      expect("echoTest" in parsePrefs(JSON.stringify({ echoTest: bad })), JSON.stringify(bad)).toBe(false)
    }
  })

  it("has no echo test and no character in the defaults, and returns the defaults object itself for no storage or garbage", () => {
    expect(defaultPrefs.echoTest).toBeUndefined()
    expect(parsePrefs(null)).toBe(defaultPrefs)
    expect(parsePrefs("{not json")).toBe(defaultPrefs)
  })

  it("survives JSON that is valid but not an object", () => {
    for (const raw of ["null", "3", '"text"', "true", "[]"]) expect(() => parsePrefs(raw), raw).not.toThrow()
    expect(parsePrefs("null")).toEqual(defaultPrefs)
    expect(parsePrefs("3")).toEqual(defaultPrefs)
    expect(parsePrefs("[]")).toEqual(defaultPrefs)
  })

  it("ignores a stored `startHintShown` that is not a boolean", () => {
    expect(parsePrefs(JSON.stringify({ startHintShown: "yes" })).startHintShown).toBe(false)
    expect(parsePrefs(JSON.stringify({ startHintShown: true })).startHintShown).toBe(true)
  })
})

describe("createPrefsStore", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("starts at the defaults, and load() reads what is stored and tells subscribers once", () => {
    localStorage.setItem(KEY, JSON.stringify({ micDeviceId: "usb", shortcuts: false, character: { character: "lips", options: { size: 1.5 } } }))
    const store = createPrefsStore()
    expect(store.get()).toEqual(defaultPrefs)
    let calls = 0
    store.subscribe(() => calls++)
    store.load()
    expect(store.get()).toMatchObject({ micDeviceId: "usb", shortcuts: false, character: { character: "lips", options: { size: 1.5 } } })
    expect(calls).toBe(1)
  })

  it("load() with nothing stored (or the same as now) does not notify", () => {
    const store = createPrefsStore()
    let calls = 0
    store.subscribe(() => calls++)
    store.load()
    store.load()
    expect(calls).toBe(0)
    expect(store.get()).toBe(defaultPrefs)
  })

  it("dispatching a patch merges it into the state and persists the whole preferences under one key", () => {
    const store = createPrefsStore()
    store.dispatch({ micDeviceId: "usb" })
    store.dispatch({ character: { character: "lips" } })
    expect(store.get()).toEqual({ ...defaultPrefs, micDeviceId: "usb", character: { character: "lips" } })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ ...defaultPrefs, micDeviceId: "usb", character: { character: "lips" } })
    // A second browser tab (a fresh store) sees the same.
    const other = createPrefsStore()
    other.load()
    expect(other.get()).toEqual(store.get())
  })

  it("a stored choice round-trips through storage, options included", () => {
    const store = createPrefsStore()
    store.dispatch({ character: { character: "lips", version: "1.0.0", options: { size: 2, ring: true, style: "round" } } })
    const other = createPrefsStore()
    other.load()
    expect(other.get().character).toEqual({ character: "lips", version: "1.0.0", options: { size: 2, ring: true, style: "round" } })
  })

  it("when storage refuses writes (private mode), the preference still holds for this page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })
    const store = createPrefsStore()
    expect(() => store.dispatch({ shortcuts: false })).not.toThrow()
    expect(store.get().shortcuts).toBe(false)
  })

  it("when storage cannot be read, load() keeps the defaults and does not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    const store = createPrefsStore()
    expect(() => store.load()).not.toThrow()
    expect(store.get()).toEqual(defaultPrefs)
  })

  it("old fields that moved to the device profile are dropped on the next write", () => {
    localStorage.setItem(KEY, JSON.stringify({ micDeviceId: "usb", captions: false, prebufferMs: 300 }))
    const store = createPrefsStore()
    store.load()
    store.dispatch({ sinkId: "spk" })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ ...defaultPrefs, micDeviceId: "usb", sinkId: "spk" })
  })
})
