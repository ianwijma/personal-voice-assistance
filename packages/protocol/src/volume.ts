import { Schema } from "effect"

/**
 * The reply volume of a device (docs/MODULES-PLAN.md §4 P7, first version; docs/PHRASES.md "Louder and quieter").
 * Additive within protocol 11: `output.volume` (server → the voice connections of one device) sets the gain of the
 * page's reply output (a gain node after the visualiser's tap: replies, announcements and the page's own cues). A page
 * that does not know the message ignores it (`decodeServerMessage` answers `Unknown`) and plays as before; the server
 * never waits for an answer and needs nothing from the page.
 *
 * The server keeps one level per device in memory (reset to the default at a restart). It sends the level after every
 * `welcome` of a voice connection of that device when it is not the default, and to every voice connection of the
 * device when it changes. A page sets its gain back to the default at every `welcome`, so a server that restarted (and
 * forgot the level) and a page that kept an old one cannot disagree.
 *
 * The same pure step (`stepReplyVolume`) decides on the server and in the web mock.
 */

/** Levels: a gain from `min` to `max` in steps of `step`; `default` is the page's gain before anyone changed it (today's). */
export const REPLY_VOLUME = { min: 0.2, max: 1, step: 0.2, default: 1 } as const

/** A gain level on the wire: a finite number from 0 to 1 (the server only sends the levels of `REPLY_VOLUME`). */
export const ReplyVolumeLevel = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** Server → the voice connections of one device: the reply output's gain. */
export const OutputVolumeMessage = Schema.Struct({
  type: Schema.Literal("output.volume"),
  volume: ReplyVolumeLevel
})
export type OutputVolumeMessage = typeof OutputVolumeMessage.Type

/** A level on the scale: a step of `REPLY_VOLUME`, between its bounds (anything else is moved to the nearest step). */
export const replyVolumeLevel = (level: number): number => {
  if (!Number.isFinite(level)) return REPLY_VOLUME.default
  const steps = Math.round((Math.min(REPLY_VOLUME.max, Math.max(REPLY_VOLUME.min, level)) - REPLY_VOLUME.min) / REPLY_VOLUME.step)
  return Math.round((REPLY_VOLUME.min + steps * REPLY_VOLUME.step) * 100) / 100
}

/**
 * One "louder" or "quieter": the next step in that direction, or the same level with `atLimit` when it is already at
 * the bound (nothing changes then). Pure; the server and the mock use it.
 */
export const stepReplyVolume = (level: number, direction: "louder" | "quieter"): { readonly level: number; readonly atLimit: boolean } => {
  const now = replyVolumeLevel(level)
  const next = replyVolumeLevel(now + (direction === "louder" ? REPLY_VOLUME.step : -REPLY_VOLUME.step))
  return next === now ? { level: now, atLimit: true } : { level: next, atLimit: false }
}
