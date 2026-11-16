/**
 * What the host needs from a page that jsdom does not have, under test control: `matchMedia` (reduced motion,
 * colour scheme), `requestAnimationFrame` stepped by hand, and `document.hidden`.
 */
import { vi } from "vitest"

export interface Page {
  /** Run `n` animation frames, `ms` apart. */
  readonly frames: (n: number, ms?: number) => void
  /** Move the clock on (`performance.now()` only moves when told), e.g. to simulate an expensive frame. */
  readonly spend: (ms: number) => void
  readonly setReducedMotion: (on: boolean) => void
  readonly setHidden: (hidden: boolean) => void
  readonly restore: () => void
}

export const installPage = (): Page => {
  let queue: Array<{ readonly id: number; readonly cb: FrameRequestCallback }> = []
  let id = 0
  let now = 1000
  const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  const query = (q: string) => {
    let m = media.get(q)
    if (m === undefined) {
      m = { matches: false, listeners: new Set() }
      media.set(q, m)
    }
    return m
  }
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, mm: window.matchMedia }
  const cancelled = new Set<number>()
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.push({ id: ++id, cb })
    return id
  }
  g.cancelAnimationFrame = (n: number) => {
    cancelled.add(n)
  }
  window.matchMedia = ((q: string) => {
    const m = query(q)
    return {
      get matches() {
        return m.matches
      },
      media: q,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => m.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => m.listeners.delete(fn),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true
    }
  }) as unknown as typeof window.matchMedia
  const perf = vi.spyOn(performance, "now").mockImplementation(() => now)
  let hidden = false
  const hiddenSpy = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
  const visSpy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"))
  return {
    frames: (n, ms = 1000 / 60) => {
      for (let i = 0; i < n; i++) {
        now += ms
        const run = queue
        queue = []
        for (const r of run) if (!cancelled.has(r.id)) r.cb(now)
      }
    },
    spend: (ms) => {
      now += ms
    },
    setReducedMotion: (on) => {
      const m = query("(prefers-reduced-motion: reduce)")
      m.matches = on
      for (const l of m.listeners) l()
    },
    setHidden: (h) => {
      hidden = h
      document.dispatchEvent(new Event("visibilitychange"))
    },
    restore: () => {
      g.requestAnimationFrame = saved.raf
      g.cancelAnimationFrame = saved.caf
      window.matchMedia = saved.mm
      perf.mockRestore()
      hiddenSpy.mockRestore()
      visSpy.mockRestore()
    }
  }
}
