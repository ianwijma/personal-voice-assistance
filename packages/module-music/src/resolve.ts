import { macrotask, nameKey } from "@pva/core"
import type { HaArea, HaEntity, HomeAssistantService } from "@pva/module-contracts"
import { Effect } from "effect"

/**
 * Which media player a room (or a player's own name or entity id) means, decided at each call from the Home Assistant
 * provider's cache as it is then. The steps, the first that matches decides:
 *
 * 1. a line of the module's `players` setting whose room is the name (compared as Members compares names: `nameKey`,
 *    and without a leading article);
 * 2. an exposed media player whose entity id is exactly the text, looked up directly;
 * 3. with `useAreas` on, a Home Assistant area whose name or an alias is the name, and the media players in it: one is
 *    the room's player; of several, the one Music Assistant serves (an entity with the `mass_player_type` attribute) when
 *    exactly one is; otherwise the person is asked which (never the first);
 * 4. every exposed media player whose name or an alias is the name: one is it; several, a question.
 *
 * A question names at most `NAMED` players and says how many there are.
 *
 * **Bounds.** Comparing a name costs about 5 µs (`nameKey` of a 170-character name on the development machine), and a
 * provider may hold 500 areas and 5,000 entities, each with 20 aliases. Every area and every media player is compared
 * (none is left out), in steps of at most `STEP_NAMES` (100) names with a yield to the event loop between them
 * (`macrotask`). The compared form of an area's or entity's names is remembered per object (a `WeakMap` on the
 * provider's own objects, so a poll that brings a new object is compared afresh). latency.test.ts holds the longest
 * stop of the main thread at the largest cache under 10 ms.
 */
export const STEP_NAMES = 100

/** The most players a "which one?" question names. */
export const NAMED = 3

/** The longest room or player name the module takes (the server's `MAX_ROOM_CHARS`, the `Playback` contract's bound). */
export const ROOM_CHARS = 60

/** How a player is named when spoken: its Home Assistant name, one line, at most this long. */
export const PLAYER_NAME_CHARS = 60

export interface TableRow {
  readonly room: string
  readonly player: string
}

export type Resolved =
  | { readonly kind: "player"; readonly entity: HaEntity }
  /** The settings name a player for that room that Home Assistant does not expose. */
  | { readonly kind: "missing"; readonly where: string }
  /** Several players, none chosen: how many, and the names of at most `NAMED` of them, for the question. */
  | { readonly kind: "ambiguous"; readonly where: string; readonly count: number; readonly names: ReadonlyArray<string> }
  /** A room or area that is known but has no player. */
  | { readonly kind: "empty"; readonly where: string }
  /** Nothing of that name. */
  | { readonly kind: "unknown"; readonly where: string }
  /** No state from Home Assistant yet (`connection()` is `unknown`): nothing can be resolved. */
  | { readonly kind: "not-yet" }

const LEADING_ARTICLE = /^(the|de|het)\s+/i

/** The name as compared: without a leading article ("the kitchen", "de keuken"). */
export const roomKey = (text: string): string => nameKey(text.trim().replace(LEADING_ARTICLE, ""))

/** Text from Home Assistant made speakable: control and direction characters out, cut at a code point to `max`. */
export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim()
  const points = Array.from(flat)
  return points.length <= max ? flat : `${points.slice(0, max - 1).join("").trimEnd()}…`
}

/** A player as it is said: its name, or the object part of its id when it has none. */
export const playerName = (entity: HaEntity): string => {
  const name = oneLine(entity.name, PLAYER_NAME_CHARS)
  return name !== "" ? name : oneLine(entity.entityId.slice(entity.entityId.indexOf(".") + 1).replace(/_/g, " "), PLAYER_NAME_CHARS)
}

const isMusicAssistant = (e: HaEntity): boolean => Object.hasOwn(e.attributes, "mass_player_type")

/** The compared names of an area or entity, made once per object. */
const keysOf = new WeakMap<HaArea | HaEntity, ReadonlyArray<string>>()
const keys = (o: HaArea | HaEntity): { readonly keys: ReadonlyArray<string>; readonly made: number } => {
  const known = keysOf.get(o)
  if (known !== undefined) return { keys: known, made: 0 }
  const made = [o.name, ...o.aliases].map(roomKey)
  keysOf.set(o, made)
  return { keys: made, made: made.length }
}

/** Every item of `items` whose names include `key`, compared in steps with a yield between them. */
const matching = <T extends HaArea | HaEntity>(items: ReadonlyArray<T>, key: string): Effect.Effect<ReadonlyArray<T>> =>
  Effect.gen(function*() {
    const found: Array<T> = []
    let counted = 0
    for (const item of items) {
      const k = keys(item)
      if (k.keys.includes(key)) found.push(item)
      counted += k.made + 1
      if (counted >= STEP_NAMES) {
        counted = 0
        yield* macrotask
      }
    }
    return found
  })

/** Of the candidates: one, the one Music Assistant serves, or a question naming at most `NAMED` with the count. */
const choose = (where: string, candidates: ReadonlyArray<HaEntity>): Resolved => {
  if (candidates.length === 1) return { kind: "player", entity: candidates[0]! }
  const served = candidates.filter(isMusicAssistant)
  if (served.length === 1) return { kind: "player", entity: served[0]! }
  const pool = served.length > 1 ? served : candidates
  return { kind: "ambiguous", where, count: pool.length, names: pool.slice(0, NAMED).map(playerName) }
}

/**
 * Resolve `text` (a room or a player, as said or as the device's room) to one player. `text` is at most `ROOM_CHARS`
 * and one line (the caller checks).
 */
export const resolvePlayer = (
  ha: HomeAssistantService,
  table: ReadonlyArray<TableRow>,
  useAreas: boolean,
  text: string
): Effect.Effect<Resolved> =>
  Effect.gen(function*() {
    const raw = text.trim()
    const where = raw.replace(LEADING_ARTICLE, "")
    const key = roomKey(text)
    if (key === "") return { kind: "unknown", where }
    // 1. The owner's table: at most 32 lines.
    const row = table.find((r) => roomKey(r.room) === key)
    if (row !== undefined) {
      const entity = ha.entity(row.player)
      if (entity !== undefined && entity.domain === "media_player") return { kind: "player", entity }
      return ha.connection() === "unknown" ? { kind: "not-yet" } : { kind: "missing", where: row.room }
    }
    if (ha.connection() === "unknown") return { kind: "not-yet" }
    // 2. An exact entity id, looked up directly.
    if (raw.startsWith("media_player.")) {
      const entity = ha.entity(raw)
      if (entity !== undefined && entity.domain === "media_player") return { kind: "player", entity }
    }
    const players = ha.entities().filter((e) => e.domain === "media_player")
    // 3. Areas, every one, in steps.
    if (useAreas) {
      const areas = yield* matching(ha.areas(), key)
      if (areas.length > 0) {
        const areaIds = new Set(areas.map((a) => a.id))
        const areaName = oneLine(areas[0]!.name, ROOM_CHARS)
        const inArea = players.filter((p) => p.areaId !== undefined && areaIds.has(p.areaId))
        if (inArea.length > 0) return choose(areaName, inArea)
        // An area of that name without a player: a player may still carry the name (step 4); otherwise it is empty.
        const byName = yield* matching(players, key)
        return byName.length > 0 ? choose(where, byName) : { kind: "empty", where: areaName }
      }
    }
    // 4. Every player's own names, in steps.
    const byName = yield* matching(players, key)
    return byName.length > 0 ? choose(where, byName) : { kind: "unknown", where }
  })
