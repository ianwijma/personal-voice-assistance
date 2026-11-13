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
  it("fall back to defaults for missing, invalid or out-of-range entries", () => {
    expect(parsePrefs(null)).toEqual(defaultPrefs)
    expect(parsePrefs("not json")).toEqual(defaultPrefs)
    const p = parsePrefs(JSON.stringify({ interruptMode: "instant", prebufferMs: 5000, captions: "yes", outputPath: "element" }))
    expect(p).toMatchObject({ interruptMode: "instant", prebufferMs: 500, captions: true, outputPath: "element" })
    // The microphone processing switches: on unless stored as off; anything else falls back to on.
    expect(parsePrefs(JSON.stringify({ echoCancellation: false, noiseSuppression: "no" }))).toMatchObject({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    })
    expect(parsePrefs(JSON.stringify({ interruptMode: "loud" })).interruptMode).toBe("confirm")
  })
})
