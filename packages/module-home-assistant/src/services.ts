import { HVAC_MODES } from "./house.ts"

/**
 * **The services a call may name: an allow-list.** Every service call, a consumer's through the `HomeAssistant`
 * transport and the module's own actions alike, must be one of these, on entities of the service's own domain, with
 * only the data fields listed for it, each a plain value (a number, a boolean, a short text, one of a fixed set) in its
 * range. Anything else is refused before anything is sent: every integration's own services (`zwave_js.*`,
 * `mqtt.publish`, `homeassistant.*`, `script.*`, `automation.*`, `shell_command.*`, `rest_command.*`, `notify.*`, …),
 * a field that is not listed (an entity, device, area, floor or label id among them, at any depth), a nested value, and
 * a target of another domain. The table is shown in docs/modules/home-assistant.md, "The services a call may name".
 */
export type Field =
  | { readonly kind: "number"; readonly min: number; readonly max: number; readonly integer?: true; readonly required?: true }
  | { readonly kind: "boolean"; readonly required?: true }
  | { readonly kind: "text"; readonly max: number; readonly required?: true }
  | { readonly kind: "choice"; readonly values: ReadonlyArray<string>; readonly required?: true }

export interface ServiceRule {
  /** The domain every target entity must have (the service's own). */
  readonly domain: "light" | "switch" | "fan" | "input_boolean" | "cover" | "climate" | "media_player" | "scene"
  readonly fields: Readonly<Record<string, Field>>
  /** What the targets must be beyond their domain: a cover of a blind class; a scene that passes the scene rule. */
  readonly targets?: "blind" | "runnable-scene"
  /** Home Assistant gives a response (`returnResponse` is allowed only here). */
  readonly response?: true
}

const onOff = (domain: ServiceRule["domain"]): Record<string, ServiceRule> => ({
  [`${domain}.turn_on`]: { domain, fields: {} },
  [`${domain}.turn_off`]: { domain, fields: {} },
  [`${domain}.toggle`]: { domain, fields: {} }
})
const mediaText = (max: number, required?: true): Field => ({ kind: "text", max, ...(required ? { required } : {}) })

export const SERVICES: Readonly<Record<string, ServiceRule>> = {
  // Lights: on (with a brightness, only for lights that can be dimmed), off, toggle.
  "light.turn_on": { domain: "light", fields: { brightness_pct: { kind: "number", min: 0, max: 100 } } },
  "light.turn_off": { domain: "light", fields: {} },
  "light.toggle": { domain: "light", fields: {} },
  // Switches, fans and on/off helpers: on, off, toggle.
  ...onOff("switch"),
  ...onOff("fan"),
  ...onOff("input_boolean"),
  // Blinds, curtains, shades, shutters and awnings only.
  "cover.open_cover": { domain: "cover", fields: {}, targets: "blind" },
  "cover.close_cover": { domain: "cover", fields: {}, targets: "blind" },
  "cover.stop_cover": { domain: "cover", fields: {}, targets: "blind" },
  "cover.set_cover_position": { domain: "cover", fields: { position: { kind: "number", min: 0, max: 100, integer: true, required: true } }, targets: "blind" },
  // Thermostats: a temperature (in the installation's unit), a mode.
  "climate.set_temperature": { domain: "climate", fields: { temperature: { kind: "number", min: -100, max: 1_000, required: true } } },
  "climate.set_hvac_mode": { domain: "climate", fields: { hvac_mode: { kind: "choice", values: HVAC_MODES, required: true } } },
  // Media players: what a music module needs (playback, volume, the source, playing and browsing media).
  "media_player.media_play": { domain: "media_player", fields: {} },
  "media_player.media_pause": { domain: "media_player", fields: {} },
  "media_player.media_play_pause": { domain: "media_player", fields: {} },
  "media_player.media_stop": { domain: "media_player", fields: {} },
  "media_player.media_next_track": { domain: "media_player", fields: {} },
  "media_player.media_previous_track": { domain: "media_player", fields: {} },
  "media_player.media_seek": { domain: "media_player", fields: { seek_position: { kind: "number", min: 0, max: 86_400, required: true } } },
  "media_player.volume_up": { domain: "media_player", fields: {} },
  "media_player.volume_down": { domain: "media_player", fields: {} },
  "media_player.volume_set": { domain: "media_player", fields: { volume_level: { kind: "number", min: 0, max: 1, required: true } } },
  "media_player.volume_mute": { domain: "media_player", fields: { is_volume_muted: { kind: "boolean", required: true } } },
  "media_player.select_source": { domain: "media_player", fields: { source: mediaText(200, true) } },
  "media_player.shuffle_set": { domain: "media_player", fields: { shuffle: { kind: "boolean", required: true } } },
  "media_player.repeat_set": { domain: "media_player", fields: { repeat: { kind: "choice", values: ["off", "all", "one"], required: true } } },
  "media_player.play_media": {
    domain: "media_player",
    fields: {
      media_content_id: mediaText(2_000, true),
      media_content_type: mediaText(100, true),
      enqueue: { kind: "choice", values: ["play", "next", "add", "replace"] },
      announce: { kind: "boolean" }
    }
  },
  "media_player.browse_media": { domain: "media_player", fields: { media_content_id: mediaText(2_000), media_content_type: mediaText(100) }, response: true },
  // A scene that passes the scene rule (named by the owner; everything it sets a light, a blind, a thermostat or a media player).
  "scene.turn_on": { domain: "scene", fields: {}, targets: "runnable-scene" }
}

/** Why a call's data does not fit its rule (`undefined`: it fits): `refused` for a field not listed or a value that is not plain, `invalid` for a value out of its range. */
export const checkData = (rule: ServiceRule, data: Readonly<Record<string, unknown>>): { readonly reason: "refused" | "invalid"; readonly detail: string } | undefined => {
  for (const [key, value] of Object.entries(data)) {
    const field = rule.fields[key]
    if (field === undefined) return { reason: "refused", detail: `data field ${JSON.stringify(key.slice(0, 40))} is not one this service takes` }
    if (value === null || typeof value === "object") return { reason: "refused", detail: `data field ${key} is not a plain value` }
    switch (field.kind) {
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max || (field.integer === true && !Number.isInteger(value))) {
          return { reason: "invalid", detail: `data field ${key} must be a number from ${field.min} to ${field.max}` }
        }
        break
      case "boolean":
        if (typeof value !== "boolean") return { reason: "invalid", detail: `data field ${key} must be true or false` }
        break
      case "text":
        if (typeof value !== "string" || value.length > field.max) return { reason: "invalid", detail: `data field ${key} must be a text of at most ${field.max} characters` }
        break
      case "choice":
        if (typeof value !== "string" || !field.values.includes(value)) return { reason: "invalid", detail: `data field ${key} must be one of ${field.values.join(", ")}` }
        break
    }
  }
  for (const [key, field] of Object.entries(rule.fields)) if (field.required === true && !(key in data)) return { reason: "invalid", detail: `data field ${key} is required` }
  return undefined
}
