import type { KnownDevice } from "@pva/core"

/** A room's name as compared: case, accents, apostrophes, spacing and a leading article ignored. */
export const roomKey = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:the|de|het|een|a) /, "")

/** Words that mean "everyone": no room (the house). */
const EVERYONE = new Set(["everyone", "everybody", "everywhere", "all", "all rooms", "the house", "house", "the whole house", "whole house", "iedereen", "overal", "alles", "alle kamers", "het huis", "het hele huis", "hele huis"].map(roomKey))

export const meansEveryone = (room: string): boolean => EVERYONE.has(roomKey(room))

const contains = (larger: ReadonlyArray<string>, smaller: ReadonlyArray<string>): boolean => {
  if (smaller.length === 0 || smaller.length > larger.length) return false
  for (let i = 0; i + smaller.length <= larger.length; i++) if (smaller.every((w, j) => larger[i + j] === w)) return true
  return false
}

export type RoomMatch =
  | { readonly kind: "room"; readonly label: string; readonly key: string }
  | { readonly kind: "none"; readonly rooms: ReadonlyArray<string> }
  | { readonly kind: "several"; readonly rooms: ReadonlyArray<string> }

/** The distinct rooms the devices have, by their first spelling, in the order of their names. */
export const roomsOf = (devices: ReadonlyArray<Pick<KnownDevice, "room">>): ReadonlyArray<{ readonly label: string; readonly key: string }> => {
  const seen = new Map<string, string>()
  for (const d of devices) {
    if (d.room === undefined) continue
    const key = roomKey(d.room)
    if (key !== "" && !seen.has(key)) seen.set(key, d.room)
  }
  return [...seen].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The room a spoken name means. An exact match (as compared above) wins; otherwise the rooms whose words contain the
 * spoken words, or that the spoken words contain ("kids room" for "Kids' room upstairs"). Never the first of several:
 * more than one is `several`, and the caller asks.
 */
export const matchRoom = (devices: ReadonlyArray<Pick<KnownDevice, "room">>, spoken: string): RoomMatch => {
  const rooms = roomsOf(devices)
  const key = roomKey(spoken)
  const exact = rooms.find((r) => r.key === key)
  if (exact !== undefined) return { kind: "room", ...exact }
  const words = key.split(" ").filter((w) => w !== "")
  const partial = key.length < 2 ? [] : rooms.filter((r) => {
    const roomWords = r.key.split(" ")
    return contains(roomWords, words) || contains(words, roomWords)
  })
  if (partial.length === 1) return { kind: "room", ...partial[0]! }
  if (partial.length > 1) return { kind: "several", rooms: partial.map((r) => r.label) }
  return { kind: "none", rooms: rooms.map((r) => r.label) }
}
