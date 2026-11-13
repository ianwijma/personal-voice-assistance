import type { InterruptMode, OutputPath } from "@pva/protocol"
import { createStore, type Store } from "./store.ts"

/**
 * Per-device preferences, kept in `localStorage` (not on the server: they
 * depend on the device, e.g. headphones on the laptop, speakers on the phone).
 */
export interface Prefs {
  readonly interruptMode: InterruptMode
  /** `""` = the system default. */
  readonly micDeviceId: string
  readonly sinkId: string
  readonly outputPath: OutputPath
  readonly prebufferMs: number
  readonly captions: boolean
  readonly latencyReadout: boolean
  readonly speakReplies: boolean
  readonly startHintShown: boolean
  /** The browser's voice processing on the microphone (re-opened when changed). */
  readonly echoCancellation: boolean
  readonly noiseSuppression: boolean
  readonly autoGainControl: boolean
  readonly echoTest?: { readonly cancelled: boolean; readonly residualDb: number; readonly at: number; readonly outputPath: OutputPath }
}

export const defaultPrefs: Prefs = {
  interruptMode: "confirm",
  micDeviceId: "",
  sinkId: "",
  outputPath: "direct",
  prebufferMs: 60,
  captions: true,
  latencyReadout: true,
  speakReplies: true,
  startHintShown: false,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

const KEY = "pva.prefs.v1"

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Up to half a second: enough to ride out Wi-Fi power-save stalls on a phone. */
export const MAX_PREBUFFER_MS = 500

/** Parse stored preferences leniently: unknown or invalid entries fall back to the defaults. */
export const parsePrefs = (raw: string | null): Prefs => {
  if (raw === null) return defaultPrefs
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>
    const pick = <K extends keyof Prefs>(k: K, ok: (x: unknown) => boolean): Prefs[K] =>
      ok(v[k]) ? (v[k] as Prefs[K]) : defaultPrefs[k]
    const bool = (x: unknown) => typeof x === "boolean"
    const str = (x: unknown) => typeof x === "string"
    const echo = v.echoTest as Prefs["echoTest"] | undefined
    const prefs: Prefs = {
      interruptMode: pick("interruptMode", (x) => x === "instant" || x === "confirm" || x === "manual"),
      micDeviceId: pick("micDeviceId", str),
      sinkId: pick("sinkId", str),
      outputPath: pick("outputPath", (x) => x === "direct" || x === "element"),
      prebufferMs: typeof v.prebufferMs === "number" ? clamp(Math.round(v.prebufferMs), 20, MAX_PREBUFFER_MS) : defaultPrefs.prebufferMs,
      captions: pick("captions", bool),
      latencyReadout: pick("latencyReadout", bool),
      speakReplies: pick("speakReplies", bool),
      startHintShown: pick("startHintShown", bool),
      echoCancellation: pick("echoCancellation", bool),
      noiseSuppression: pick("noiseSuppression", bool),
      autoGainControl: pick("autoGainControl", bool)
    }
    return echo !== undefined && typeof echo === "object" && typeof echo.cancelled === "boolean" ? { ...prefs, echoTest: echo } : prefs
  } catch {
    return defaultPrefs
  }
}

const read = (): Prefs => {
  try {
    return parsePrefs(globalThis.localStorage?.getItem(KEY) ?? null)
  } catch {
    return defaultPrefs
  }
}

export interface PrefsStore extends Store<Prefs, Partial<Prefs>> {
  /** Load from `localStorage` (call once on the client, after hydration). */
  readonly load: () => void
}

export const createPrefsStore = (): PrefsStore => {
  const store = createStore<Prefs, Partial<Prefs>>(defaultPrefs, (s, patch) => {
    const next = { ...s, ...patch }
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
    } catch {
      // Private mode or storage disabled: the preference lasts for this page only.
    }
    return next
  })
  return {
    ...store,
    load: () => {
      const stored = read()
      if (JSON.stringify(stored) !== JSON.stringify(store.get())) store.dispatch(stored)
    }
  }
}
