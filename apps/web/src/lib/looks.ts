import type { DeviceLook, DeviceSettings, DeviceVoice, Look, LookOptionValue } from "@pva/protocol"
import { BASELINE_ID } from "../characters/choice.ts"
import type { Character, OptionSpec, OptionValues } from "../characters/contract.ts"
import { COMMON_OPTIONS, isDefault, RESERVED_OPTIONS, resolveOptions, validateValue } from "../characters/options.ts"

/**
 * Editing a look (docs/LOOKS-AND-VOICES.md §2, §4; the stored form of docs/CHARACTERS.md §4.4), pure: no React, no DOM.
 *
 * A look is stored in one canonical form, so editing a value back to what is saved leaves nothing to save:
 * `{ character, version, options }` where `version` is the character's manifest version and `options` holds only the
 * values that differ from their defaults (the character's own options and the host-level `$you`, `$voice`,
 * `$sensitivity`), each validated with `options.ts` (`validateValue`: numbers clamped and snapped, unknown choices
 * and wrong types replaced by the default). Missing ids take the default when the host loads it (§4.4), so a sparse
 * form shows the same look. `options` is left out when nothing differs.
 *
 * An assistant without a look shows the baseline; the editor stores "the baseline with every default" as no look on
 * an assistant (`assistantLook`), so the two never differ. A device's own look is always stored (it is an own value).
 */

/** The host-level settings (`$you`, `$voice`, `$sensitivity`): they apply to every character and carry over on a switch. */
export const HOST_OPTIONS: ReadonlyArray<OptionSpec> = COMMON_OPTIONS

const specsOf = (c: Pick<Character, "options">): ReadonlyArray<OptionSpec> => [...(c.options ?? []), ...HOST_OPTIONS]

/** The baseline look, as the editor shows a missing look. */
export const baselineLook = (baseline: Pick<Character, "id" | "version">): Look => ({ character: baseline.id, version: baseline.version })

/** Every value of `look` for `character`, validated and complete (its own options and the host-level ones). */
export const valuesOf = (character: Pick<Character, "options">, look: Look | undefined): OptionValues => resolveOptions(specsOf(character), look?.options)

/** The canonical look of `character` with `values` (anything else in `values` is dropped). */
export const canonicalLook = (character: Pick<Character, "id" | "version" | "options">, values: { readonly [id: string]: unknown }): Look => {
  const options: Record<string, LookOptionValue> = {}
  for (const spec of specsOf(character)) {
    if (!Object.hasOwn(values, spec.id)) continue
    const v = validateValue(spec, values[spec.id])
    if (!isDefault(spec, v)) options[spec.id] = v
  }
  return { character: character.id, version: character.version, ...(Object.keys(options).length > 0 ? { options } : {}) }
}

/** One option set (a raw value: validated, so a slider's text or a stray type cannot be stored). */
export const setOption = (character: Pick<Character, "id" | "version" | "options">, look: Look | undefined, id: string, raw: unknown): Look =>
  canonicalLook(character, { ...valuesOf(character, look), [id]: raw })

/** One option back to its default. */
export const resetOption = (character: Pick<Character, "id" | "version" | "options">, look: Look | undefined, id: string): Look => {
  const { [id]: _gone, ...rest } = valuesOf(character, look)
  return canonicalLook(character, rest)
}

/** Every option back to its default: the character's own and, with `host`, the host-level ones too. */
export const resetAll = (character: Pick<Character, "id" | "version" | "options">, look: Look | undefined, host: boolean): Look => {
  if (host) return canonicalLook(character, {})
  const values = valuesOf(character, look)
  return canonicalLook(character, Object.fromEntries(HOST_OPTIONS.map((s) => [s.id, values[s.id]])))
}

/** How many of the character's own options differ from their default. */
export const changedCount = (character: Pick<Character, "options">, look: Look | undefined): number => {
  const values = valuesOf(character, look)
  return (character.options ?? []).filter((s) => !isDefault(s, values[s.id])).length
}

/**
 * Switch to `next`, keeping what has the same meaning in every character (docs/CHARACTERS.md §4.4): the host-level
 * settings, and the reserved ids (`size`, `speed`, `glow`, …) that `next` offers with a kind the value fits.
 */
export const switchCharacter = (look: Look | undefined, next: Pick<Character, "id" | "version" | "options">): Look => {
  const stored = look?.options ?? {}
  const keep: Record<string, unknown> = {}
  for (const s of HOST_OPTIONS) if (Object.hasOwn(stored, s.id)) keep[s.id] = stored[s.id]
  for (const s of next.options ?? []) {
    if (!Object.hasOwn(RESERVED_OPTIONS, s.id) || !Object.hasOwn(stored, s.id)) continue
    const v = stored[s.id]
    if ((s.kind === "number" && typeof v === "number") || (s.kind === "toggle" && typeof v === "boolean")) keep[s.id] = v
  }
  return canonicalLook(next, keep)
}

/** The look an assistant stores: none for the baseline with every default (absent = the baseline). */
export const assistantLook = (look: Look | undefined): Look | undefined =>
  look === undefined || (look.character === BASELINE_ID && (look.options === undefined || Object.keys(look.options).length === 0)) ? undefined : look

/** A device look or voice as the lists say it: the device's own (or its type's), else nothing to say. */
export const ownLookOf = (look: DeviceLook): Look | undefined => (look.from === "device" ? look.look : undefined)
export const ownVoiceOf = (voice: DeviceVoice): (DeviceVoice & { from: "device" })["voice"] | undefined => (voice.from === "device" ? voice.voice : undefined)

/** Whether a device's settings fix the look or voice for every assistant. */
export const fixesLook = (s: Pick<DeviceSettings, "look">): boolean => s.look.from === "device"
export const fixesVoice = (s: Pick<DeviceSettings, "voice">): boolean => s.voice.from === "device"
