import { Schema } from "effect"
import { DeviceId, FrontendKindId } from "./frontends.ts"

/**
 * A device (or a device type's defaults, "Every browser") named as a user of something, with the name to show. It
 * has the shape of `DeviceTarget` (devices.ts) but lives here so `voices.ts` and `snapshot.ts` can use it without
 * importing the assistants schemas (docs/LOOKS-AND-VOICES.md §5.0). Additive: old clients ignore the fields that carry it.
 */
export const DeviceUser = Schema.Struct({
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("type"), type: FrontendKindId }),
    Schema.Struct({ kind: Schema.Literal("device"), id: DeviceId })
  ]),
  /** The device's name, or the type's defaults as the UI calls them ("Every browser"). */
  name: Schema.String
})
export type DeviceUser = typeof DeviceUser.Type
