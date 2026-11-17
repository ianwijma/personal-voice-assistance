import { Schema } from "effect"

/**
 * What a device can do (docs/VOICE-NODES.md §13, the v1 subset of the module research's capability declaration).
 * Declared by the device in `hello.device.capabilities`, kept by the server and shown by admin. An absent `display`
 * means "no screen"; `display`, `present`, `openUrl`, `notify` and `characters` are added later as optional fields.
 */
export const DeviceCapabilities = Schema.Struct({
  v: Schema.Literal(1),
  /** A voice node: `["speech"]`. */
  speaker: Schema.optionalKey(Schema.Struct({
    media: Schema.Array(Schema.Literals(["speech", "audio", "video"]))
  })),
  /** A voice node: `{}` (it cannot know whether the microphone is far field). */
  microphone: Schema.optionalKey(Schema.Struct({
    farField: Schema.optionalKey(Schema.Boolean)
  }))
})
export type DeviceCapabilities = typeof DeviceCapabilities.Type
