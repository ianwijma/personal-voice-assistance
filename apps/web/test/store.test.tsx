import { act, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { defaultPrefs, parsePrefs } from "@/lib/prefs.ts"
import { createStore, shallowEqual, useStoreSelector } from "@/lib/store.ts"

describe("store", () => {
  it("re-renders a component only when its selected slice changes", () => {
    const store = createStore({ a: 1, b: 1 }, (s, patch: Partial<{ a: number; b: number }>) => ({ ...s, ...patch }))
    let renders = 0
    function A() {
      renders++
      const v = useStoreSelector(store, (s) => ({ a: s.a }), shallowEqual)
      return <span data-testid="a">{v.a}</span>
    }
    render(<A />)
    expect(renders).toBe(1)
    act(() => store.dispatch({ b: 2 }))
    expect(renders).toBe(1)
    act(() => store.dispatch({ a: 5 }))
    expect(screen.getByTestId("a")).toHaveTextContent("5")
    expect(renders).toBe(2)
  })

  it("skips listeners when the reducer returns the same state", () => {
    const store = createStore(0, (s, n: number) => (n === 0 ? s : s + n))
    let calls = 0
    store.subscribe(() => calls++)
    store.dispatch(0)
    store.dispatch(2)
    expect(calls).toBe(1)
    expect(store.get()).toBe(2)
  })
})

describe("per-device preferences", () => {
  it("fall back to defaults for missing or invalid entries", () => {
    expect(parsePrefs(null)).toEqual(defaultPrefs)
    expect(parsePrefs("not json")).toEqual(defaultPrefs)
    expect(parsePrefs(JSON.stringify({ micDeviceId: "usb", sinkId: 3, startHintShown: true }))).toEqual({ micDeviceId: "usb", sinkId: "", startHintShown: true, shortcuts: true })
  })

  it("drop the fields that moved to the device profile (protocol 5): the server's values apply", () => {
    const p = parsePrefs(JSON.stringify({ micDeviceId: "usb", interruptMode: "instant", prebufferMs: 300, captions: false, outputPath: "element", echoCancellation: false, latencyReadout: false }))
    expect(p).toEqual({ micDeviceId: "usb", sinkId: "", startHintShown: false, shortcuts: true })
  })

  it("keep the single-key shortcuts switch (default on)", () => {
    expect(parsePrefs(JSON.stringify({ shortcuts: false })).shortcuts).toBe(false)
    expect(parsePrefs(JSON.stringify({ shortcuts: "no" })).shortcuts).toBe(true)
  })
})
