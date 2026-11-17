import { Schema } from "effect"
import { VoiceRefSchema } from "./voices.ts"
import type { VoiceRefJson } from "./voices.ts"
import type { DeviceUser } from "./deviceUsers.ts"

/**
 * Looks and voices of assistants and devices (docs/LOOKS-AND-VOICES.md). Pure and browser-safe.
 *
 * A **look** is a character choice in its stored form (docs/CHARACTERS.md §4.4): the character's id, the version its
 * options were saved with, and the option values. The server cannot know which characters exist or what their
 * options are (they live in the web client), so it only bounds the shape; the character host validates the values on
 * every load, and a look naming a character the client does not have shows the baseline and is kept untouched.
 *
 * An assistant has an optional look (absent: the baseline) and one voice. A device (or a device type's defaults) may
 * override either for every assistant that answers on it: `{ from: "assistant" }` follows the assistant,
 * `{ from: "device", … }` is the device's own. These are tagged rather than `null` because device sections resolve
 * with `own ?? typeDefaults ?? builtIn`, and "this device follows the assistant even though browsers do not" must be
 * expressible as an own value.
 */

export const LOOK_ID_CHARS = 64
export const MAX_LOOK_OPTIONS = 64
export const LOOK_VALUE_CHARS = 256

const LookKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LOOK_ID_CHARS))

/** One stored option value: as the character host accepts them (choice.ts `parseValues`). */
export const LookOptionValue = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String.check(Schema.isMaxLength(LOOK_VALUE_CHARS))])
export type LookOptionValue = typeof LookOptionValue.Type

/** A character choice as stored; structurally the web client's `CharacterChoice`. */
export const Look = Schema.Struct({
  character: LookKey,
  /** The character's version when the options were saved. */
  version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(LOOK_ID_CHARS))),
  /** Character option ids and the host-level `$you`, `$voice`, `$sensitivity`. Missing ids take the default. */
  options: Schema.optionalKey(Schema.Record(LookKey, LookOptionValue).check(Schema.isMaxProperties(MAX_LOOK_OPTIONS)))
})
export type Look = typeof Look.Type

/** A device's look: the answering assistant's, or the device's own for every assistant. */
export const DeviceLook = Schema.Union([
  Schema.Struct({ from: Schema.Literal("assistant") }),
  Schema.Struct({ from: Schema.Literal("device"), look: Look })
])
export type DeviceLook = typeof DeviceLook.Type

/** A device's voice: each assistant's own, or the device's own for every assistant. */
export const DeviceVoice = Schema.Union([
  Schema.Struct({ from: Schema.Literal("assistant") }),
  Schema.Struct({ from: Schema.Literal("device"), voice: VoiceRefSchema })
])
export type DeviceVoice = typeof DeviceVoice.Type

export const FOLLOW_ASSISTANT: { readonly from: "assistant" } = { from: "assistant" }

/** The look shown for `assistant` on a device: the device's own, else the assistant's; undefined = the baseline. */
export const lookFor = (device: DeviceLook, assistant: { readonly look?: Look | undefined } | undefined): Look | undefined =>
  device.from === "device" ? device.look : assistant?.look

/** The voice `assistant` speaks with on a device: the device's own, else the assistant's. */
export const voiceFor = (device: DeviceVoice, assistant: { readonly voice: VoiceRefJson }): VoiceRefJson =>
  device.from === "device" ? device.voice : assistant.voice

// -- Who uses a voice (§5.0) -----------------------------------------------------------------------------------------

/** A voice's key, `provider:voiceId` (the catalogue's `VoiceEntry.key`; the same as `voiceKey` in `@pva/core`). */
export const voiceRefKey = (ref: VoiceRefJson): string => `${ref.provider}:${ref.voiceId}`

/** A place that may speak with its own voice: a device type's defaults or one device, with its *effective* voice section. */
export interface VoicePlace {
  readonly user: DeviceUser
  readonly voice: DeviceVoice
}

/** A device type's defaults as a user ("Every browser"). */
export const typeVoiceUser = (kind: string, one: string): DeviceUser => ({ target: { kind: "type", type: kind }, name: `Every ${one}` })

/** One device as a user, by its name (its id when it has none). */
export const deviceVoiceUser = (id: string, name: string): DeviceUser => ({ target: { kind: "device", id }, name: name || id })

/**
 * Who speaks with each voice, by voice key: `assistants`, every assistant by its own voice (switched on or not, even
 * when every device hides it), and `devices`, every place whose effective voice section is its own. The one rule the
 * server (the catalogue's `usedBy`/`usedByDevices`) and the web (which recomputes it from the admin state it already
 * has, so a save shows at once) both use.
 */
export const voiceUsersOf = (
  assistants: Iterable<{ readonly id: string; readonly voice: VoiceRefJson }>,
  places: Iterable<VoicePlace>
): { readonly assistants: ReadonlyMap<string, ReadonlyArray<string>>; readonly devices: ReadonlyMap<string, ReadonlyArray<DeviceUser>> } => {
  const byAssistant = new Map<string, Array<string>>()
  for (const a of assistants) {
    const key = voiceRefKey(a.voice)
    byAssistant.set(key, [...(byAssistant.get(key) ?? []), a.id])
  }
  const byDevice = new Map<string, Array<DeviceUser>>()
  for (const p of places) {
    if (p.voice.from !== "device") continue
    const key = voiceRefKey(p.voice.voice)
    byDevice.set(key, [...(byDevice.get(key) ?? []), p.user])
  }
  return { assistants: byAssistant, devices: byDevice }
}
