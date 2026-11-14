"use client"
import { useEffect, useState } from "react"

/** The microphones or speakers the browser lists (named once the microphone was allowed), kept up to date. */
export const useMediaDevices = (kind: MediaDeviceKind, refreshKey: unknown): ReadonlyArray<MediaDeviceInfo> => {
  const [devices, setDevices] = useState<ReadonlyArray<MediaDeviceInfo>>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (md === undefined) return
    // Overlapping enumerations (a device change during the first one) can settle out of order: only the
    // latest of this effect, while it is mounted, sets the list.
    let latest = 0
    let disposed = false
    const load = () => {
      const mine = ++latest
      // continuation(identity): only the latest enumeration of this effect, while it is mounted.
      void md.enumerateDevices().then((all) => {
        if (!disposed && mine === latest) setDevices(all.filter((d) => d.kind === kind && d.deviceId !== "" && d.deviceId !== "default"))
      }, () => undefined)
    }
    load()
    md.addEventListener("devicechange", load) // continuation(identity): see `load`; removed on cleanup
    return () => {
      disposed = true
      md.removeEventListener("devicechange", load)
    }
  }, [kind, refreshKey])
  return devices
}
