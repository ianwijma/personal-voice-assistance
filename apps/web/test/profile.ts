import { DEFAULT_DEVICE_PROFILE, type DeviceProfile, type ServerMessageOf } from "@pva/protocol"
import { exampleDeviceSetup } from "@pva/protocol/examples"

/**
 * A `device.setup` message whose audio, caption and interrupt fields are the built-in profile with `patch` on top
 * (what the server sends a voice page when its device's settings change).
 */
export const setupMessage = (patch: Partial<DeviceProfile> = {}): ServerMessageOf<"device.setup"> => {
  const p: DeviceProfile = { ...DEFAULT_DEVICE_PROFILE, ...patch }
  return {
    type: "device.setup",
    ...exampleDeviceSetup,
    interruptMode: p.interruptMode,
    audio: {
      echoCancellation: p.echoCancellation,
      noiseSuppression: p.noiseSuppression,
      autoGainControl: p.autoGainControl,
      speakAloud: true,
      outputPath: p.outputPath,
      prebufferMs: p.prebufferMs
    },
    captions: { captions: p.captions, speakTyped: p.speakReplies }
  }
}
