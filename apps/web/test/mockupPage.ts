/**
 * Loads one of the clickable mock-ups in docs/mockups/assistants into this jsdom document and runs
 * its script, so tests can click through it. Each test file gets its own document, so load one
 * mock-up per file. jsdom has no matchMedia, ResizeObserver or canvas; they are stubbed with just
 * enough for the mock-ups to start (desktop width, no animation frames).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vitest"

const fakeContext = (): unknown =>
  new Proxy<Record<string | symbol, unknown>>(
    {},
    {
      get: (target, key) => {
        if (key in target) return target[key]
        if (key === "getImageData") return () => ({ data: [0, 0, 0, 0] })
        if (key === "createLinearGradient") return () => ({ addColorStop: () => undefined })
        return () => undefined
      },
      set: (target, key, value) => {
        target[key] = value
        return true
      }
    }
  )

export function loadMockup(name: "admin" | "voice"): void {
  const html = readFileSync(join(import.meta.dirname, `../../../docs/mockups/assistants/${name}.html`), "utf8")
  const open = html.indexOf("<script>")
  const close = html.lastIndexOf("</script>")
  const script = html.slice(open + "<script>".length, close)
  const body = html.slice(html.indexOf(">", html.indexOf("<body")) + 1, open)

  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("matchMedia", matchMedia)
  vi.stubGlobal("ResizeObserver", ResizeObserver)
  vi.stubGlobal("requestAnimationFrame", () => 0)
  vi.stubGlobal("devicePixelRatio", 1)
  Object.assign(window, { matchMedia, ResizeObserver, requestAnimationFrame: () => 0 })
  HTMLCanvasElement.prototype.getContext = fakeContext as unknown as typeof HTMLCanvasElement.prototype.getContext

  document.body.innerHTML = body
  // Indirect eval runs the page script as a classic script against this document's globals.
  ;(0, eval)(script)
}
