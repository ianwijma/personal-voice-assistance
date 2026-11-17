import type { OutputPath } from "@pva/protocol"
import { createStore, type Store } from "./store.ts"

/**
 * What this browser keeps for itself in `localStorage`: the microphone and speaker (hardware ids mean nothing on
 * another machine), a one-time hint, whether single-key shortcuts are on and the last echo test. Everything else that used to be per browser
 * (interrupting, audio processing, captions, speaking replies, output path, prebuffer) is the device profile since
 * protocol 5: it comes from the server (the device's `device.setup`) and is edited in admin
 * (docs/FRONTENDS-AND-ACTIVATION.md §2). Old stored values of those fields are ignored and dropped on the next write.
 * So is the stage's character (`character`, a per-browser choice until docs/LOOKS-AND-VOICES.md): the look now
 * belongs to the assistant or the device and arrives in `device.setup`.
 */
export interface Prefs {
  /** `""` = the system default. */
  readonly micDeviceId: string
  readonly sinkId: string
  readonly startHintShown: boolean
  /** The single-key shortcuts (M, C, S, /, ?); switched off in the help dialog (WCAG 2.1.4). Default on. */
  readonly shortcuts: boolean
  readonly echoTest?: { readonly cancelled: boolean; readonly residualDb: number; readonly at: number; readonly outputPath: OutputPath }
}

export const defaultPrefs: Prefs = {
  micDeviceId: "",
  sinkId: "",
  startHintShown: false,
  shortcuts: true
}

const KEY = "pva.prefs.v1"

/** Parse stored preferences leniently: unknown or invalid entries fall back to the defaults. */
export const parsePrefs = (raw: string | null): Prefs => {
  if (raw === null) return defaultPrefs
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>
    const str = (x: unknown): x is string => typeof x === "string"
    const echo = v.echoTest as Prefs["echoTest"] | undefined
    const prefs: Prefs = {
      micDeviceId: str(v.micDeviceId) ? v.micDeviceId : defaultPrefs.micDeviceId,
      sinkId: str(v.sinkId) ? v.sinkId : defaultPrefs.sinkId,
      startHintShown: typeof v.startHintShown === "boolean" ? v.startHintShown : defaultPrefs.startHintShown,
      shortcuts: typeof v.shortcuts === "boolean" ? v.shortcuts : defaultPrefs.shortcuts
    }
    return echo !== undefined && echo !== null && typeof echo === "object" && typeof echo.cancelled === "boolean" ? { ...prefs, echoTest: echo } : prefs
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
