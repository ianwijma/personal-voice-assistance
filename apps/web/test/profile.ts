import { DEFAULT_DEVICE_PROFILE, DEVICE_EDITABLE_FIELDS, type DeviceProfile, type ServerMessageOf } from "@pva/protocol"

/** A `device.profile` message: the built-in defaults with `patch` on top (what the server sends a voice page). */
export const profileMessage = (patch: Partial<DeviceProfile> = {}, deviceId = "d-test-device-1"): ServerMessageOf<"device.profile"> => ({
  type: "device.profile",
  deviceId,
  profile: { ...DEFAULT_DEVICE_PROFILE, ...patch },
  editable: [...DEVICE_EDITABLE_FIELDS]
})
