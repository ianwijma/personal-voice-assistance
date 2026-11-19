import { macrotask, nameKey } from "@pva/core"
import type { HaEntity, HomeAssistantService } from "@pva/module-contracts"
import { Effect } from "effect"

/**
 * Which media player a room (or a player's own name) means, decided at each call from the Home Assistant provider's
 * cache as it is then: nothing of it is kept. The steps, the first that matches decides:
 *
 * 1. a line of the module's `players` setting whose room is the name (compared as Members compares names: `nameKey`);
 * 2. with `useAreas` on, a Home Assistant area whose name or an alias is the name, and the media players in it: one is
 *    the room's player; of several, the one Music Assistant serves (an entity with the `mass_player_type` attribute) when
 *    exactly one is; otherwise the person is asked which (never the first);
 * 3. a media player whose name, an alias or entity id is the name (so "the kitchen speaker" answers "which one?").
 *
 * **Bounds.** Comparing a name costs about 5 µs (`nameKey` of a 170-character name on the development machine), and a
 * provider may hold 500 areas of 20 aliases and thousands of entities. So the areas and the players are compared in
 * steps of at most `STEP_NAMES` names with a yield to the event loop between them (`macrotask`), and only the first
 * `MAX_PLAYERS` media players (the provider keeps entities in id order) are compared by name. latency.test.ts holds the
 * longest stop of the main thread at the largest cache under 10 ms.
 */
export const STEP_NAMES = 200
export const MAX_PLAYERS = 200

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
  /** Several players, none chosen: their names, for the question. */
  | { readonly kind: "ambiguous"; readonly where: string; readonly names: ReadonlyArray<string> }
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

/** Of the candidates: one, the one Music Assistant serves, or a question. */
const choose = (where: string, candidates: ReadonlyArray<HaEntity>): Resolved => {
  if (candidates.length === 1) return { kind: "player", entity: candidates[0]! }
  const served = candidates.filter(isMusicAssistant)
  if (served.length === 1) return { kind: "player", entity: served[0]! }
  const pool = served.length > 1 ? served : candidates
  return { kind: "ambiguous", where, names: pool.map(playerName) }
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
    const where = text.trim().replace(LEADING_ARTICLE, "")
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
    const players = ha.entities().filter((e) => e.domain === "media_player")
    // 2. Areas, in steps.
    if (useAreas) {
      const areaIds = new Set<string>()
      let areaName: string | undefined
      let counted = 0
      for (const area of ha.areas()) {
        const names = [area.name, ...area.aliases]
        if (names.some((n) => roomKey(n) === key)) {
          areaIds.add(area.id)
          areaName ??= oneLine(area.name, ROOM_CHARS)
        }
        counted += names.length
        if (counted >= STEP_NAMES) {
          counted = 0
          yield* macrotask
        }
      }
      if (areaIds.size > 0) {
        const inArea = players.filter((p) => p.areaId !== undefined && areaIds.has(p.areaId))
        if (inArea.length > 0) return choose(areaName ?? where, inArea)
        // An area of that name without a player: a player may still carry the name (step 3); otherwise it is empty.
        const byName = yield* playersNamed(players, key, text.trim())
        return byName.length > 0 ? choose(where, byName) : { kind: "empty", where: areaName ?? where }
      }
    }
    // 3. A player's own name.
    const byName = yield* playersNamed(players, key, text.trim())
    return byName.length > 0 ? choose(where, byName) : { kind: "unknown", where }
  })

/** The first `MAX_PLAYERS` media players whose name, an alias or id is `key`, compared in steps. */
const playersNamed = (players: ReadonlyArray<HaEntity>, key: string, raw: string): Effect.Effect<ReadonlyArray<HaEntity>> =>
  Effect.gen(function*() {
    const found: Array<HaEntity> = []
    let counted = 0
    for (const p of players.slice(0, MAX_PLAYERS)) {
      const names = [p.name, ...p.aliases]
      if (p.entityId === raw || names.some((n) => roomKey(n) === key)) found.push(p)
      counted += names.length
      if (counted >= STEP_NAMES) {
        counted = 0
        yield* macrotask
      }
    }
    return found
  })
