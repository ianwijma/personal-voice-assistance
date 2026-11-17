import { type DeviceHello, MAX_DEVICE_NAME_CHARS, WEB_VOICE_KIND } from "@pva/protocol"
import { currentCapabilities } from "./capabilities.ts"

/**
 * This browser as a device (docs/FRONTENDS-AND-ACTIVATION.md §2): a stable random id in `localStorage` (shared by
 * every tab of the browser, distinct from the per-tab `clientId`) and a default name from the user agent. The server
 * uses the name only the first time it sees the id; admin can rename the device.
 */

const DEVICE_ID_KEY = "pva.deviceId"
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/

const randomId = (): string => {
  try {
    return `d-${crypto.randomUUID()}`
  } catch {
    return `d-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 40)
  }
}

/** The stored device id, created on first use. Without storage (private mode) a fresh id per page load. */
export const deviceId = (storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string => {
  try {
    const existing = storage?.getItem(DEVICE_ID_KEY)
    if (existing !== null && existing !== undefined && DEVICE_ID.test(existing)) return existing
    const id = randomId()
    storage?.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return randomId()
  }
}

const platformOf = (ua: string): string | undefined => {
  if (/iPhone/.test(ua)) return "iPhone"
  if (/iPad/.test(ua)) return "iPad"
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet"
  if (/CrOS/.test(ua)) return "Chromebook"
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac"
  if (/Windows/.test(ua)) return "Windows"
  if (/Linux/.test(ua)) return "Linux"
  return undefined
}

const browserOf = (ua: string): string | undefined => {
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge"
  if (/OPR\/|Opera/.test(ua)) return "Opera"
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox"
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet"
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome"
  if (/Safari\//.test(ua)) return "Safari"
  return undefined
}

/** "iPhone · Safari", "Mac · Chrome", "Linux · Firefox"; "Browser" when nothing is recognised. */
export const deviceNameFromUserAgent = (ua: string): string => {
  const name = [platformOf(ua), browserOf(ua)].filter((x) => x !== undefined).join(" · ")
  return (name === "" ? "Browser" : name).slice(0, MAX_DEVICE_NAME_CHARS)
}

/** What this browser says about itself in `hello` (protocol 11: with what it can do, measured now). */
export const deviceHello = (): DeviceHello => {
  const capabilities = currentCapabilities()
  return {
    id: deviceId(),
    kind: WEB_VOICE_KIND,
    name: deviceNameFromUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent),
    ...(capabilities !== undefined ? { capabilities } : {})
  }
}
