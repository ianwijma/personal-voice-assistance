import { type ClientMessage, type DeviceCapabilities, type DeviceLiveState, displayClassOf } from "@pva/protocol"

/**
 * What this browser can do (protocol 11, docs/MODULES-PLAN.md §4 P5; presentation-and-device-capabilities.md §5.2),
 * measured by the page itself: the viewport and pixel ratio, the pointer, colour, whether it can play and record
 * audio, and whether it is a phone tab that can open links. Absent means "cannot". Sent in `hello.device.capabilities`
 * and again with `device.caps` when it changes; the live state (visible, last interaction) at most once a second.
 */

/** Presentation renderers this page has, kind → highest version (P10 fills it). */
export const PRESENT_KINDS: Readonly<Record<string, number>> = {}

/** The parts of the browser the measurement reads (a fake in tests). */
export interface CapabilityEnv {
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly matches: (query: string) => boolean
  readonly userAgent: string
  readonly audioOut: boolean
  readonly microphone: boolean
}

export const browserEnv = (): CapabilityEnv | undefined => {
  if (typeof window === "undefined") return undefined
  return {
    width: Math.round(window.innerWidth),
    height: Math.round(window.innerHeight),
    dpr: window.devicePixelRatio || 1,
    matches: (q) => {
      try {
        return window.matchMedia?.(q).matches === true
      } catch {
        return false
      }
    },
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    audioOut: typeof AudioContext !== "undefined" || typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined",
    microphone: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
  }
}

const clampDpr = (dpr: number) => Math.min(16, Math.max(0.1, Number.isFinite(dpr) ? dpr : 1))

/** The declaration for an environment. */
export const measureCapabilities = (env: CapabilityEnv): DeviceCapabilities => {
  const width = Math.max(0, Math.min(100_000, env.width))
  const height = Math.max(0, Math.min(100_000, env.height))
  const touch = env.matches("(pointer: coarse)") ? "coarse" : env.matches("(pointer: fine)") ? "fine" : "none"
  // `(monochrome)` matches e-ink and other grey-scale screens.
  const colour = !env.matches("(monochrome)")
  const phone = /iPhone|iPod|Android.*Mobile|Mobile.*Firefox/.test(env.userAgent)
  return {
    v: 1,
    display: { class: displayClassOf(width, height), widthPx: width, heightPx: height, dpr: Math.round(clampDpr(env.dpr) * 100) / 100, touch, colour },
    present: { kinds: { ...PRESENT_KINDS } },
    ...(env.audioOut ? { speaker: { media: ["speech", "audio"] as const } } : {}),
    ...(env.microphone ? { microphone: { farField: false } } : {}),
    ...(phone ? { openUrl: true } : {})
  }
}

/** This browser's declaration now, or `undefined` outside a browser. */
export const currentCapabilities = (): DeviceCapabilities | undefined => {
  const env = browserEnv()
  return env === undefined ? undefined : measureCapabilities(env)
}

export const CAPS_MIN_INTERVAL_MS = 1000

export interface CapabilityWatchOptions {
  readonly send: (message: ClientMessage) => boolean
  readonly measure?: () => DeviceCapabilities | undefined
  readonly visible?: () => boolean
  readonly now?: () => number
  /** Where the events come from (default `window` and `document`). */
  readonly target?: Pick<Window, "addEventListener" | "removeEventListener">
  readonly doc?: Pick<Document, "addEventListener" | "removeEventListener">
  readonly setTimer?: (f: () => void, ms: number) => unknown
  readonly clearTimer?: (t: unknown) => void
}

export interface CapabilityWatch {
  /** After a new `welcome`: the declaration went with `hello`; send the live state again (the server starts at visible). */
  readonly resync: () => void
  readonly stop: () => void
}

/**
 * Watch the page: a resize or rotation that changes the declaration, a change of visibility, and touches and keys,
 * sent as `device.caps` at most once a second (the last change wins; nothing is sent when nothing changed).
 */
export const watchCapabilities = (options: CapabilityWatchOptions): CapabilityWatch => {
  const measure = options.measure ?? currentCapabilities
  const visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const target = options.target ?? (typeof window === "undefined" ? undefined : window)
  const doc = options.doc ?? (typeof document === "undefined" ? undefined : document)

  let sentCaps = JSON.stringify(measure())
  let sentVisible = true
  let interaction: number | undefined
  let sentInteraction: number | undefined
  let lastSentAt = -Infinity
  let timer: unknown

  const flush = () => {
    timer = undefined
    const caps = measure()
    const capsText = JSON.stringify(caps)
    const vis = visible()
    const message: { -readonly [K in keyof Extract<ClientMessage, { type: "device.caps" }>]: Extract<ClientMessage, { type: "device.caps" }>[K] } = { type: "device.caps" }
    if (caps !== undefined && capsText !== sentCaps) message.capabilities = caps
    if (vis !== sentVisible || interaction !== sentInteraction) {
      const live: DeviceLiveState = { visible: vis, ...(interaction !== undefined ? { lastInteractionAt: interaction } : {}) }
      message.live = live
    }
    if (message.capabilities === undefined && message.live === undefined) return
    if (!options.send(message)) return // not connected: the next hello carries the declaration, `resync` the rest
    lastSentAt = now()
    if (message.capabilities !== undefined) sentCaps = capsText
    sentVisible = vis
    sentInteraction = interaction
  }
  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimer(flush, Math.max(0, lastSentAt + CAPS_MIN_INTERVAL_MS - now()))
  }
  const onChange = () => schedule()
  const onInteraction = () => {
    interaction = now()
    schedule()
  }
  target?.addEventListener("resize", onChange)
  target?.addEventListener("orientationchange", onChange)
  target?.addEventListener("pointerdown", onInteraction, { passive: true })
  target?.addEventListener("keydown", onInteraction)
  doc?.addEventListener("visibilitychange", onChange)
  return {
    resync: () => {
      sentCaps = JSON.stringify(measure())
      sentVisible = true
      sentInteraction = undefined
      schedule()
    },
    stop: () => {
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      target?.removeEventListener("resize", onChange)
      target?.removeEventListener("orientationchange", onChange)
      target?.removeEventListener("pointerdown", onInteraction)
      target?.removeEventListener("keydown", onInteraction)
      doc?.removeEventListener("visibilitychange", onChange)
    }
  }
}
