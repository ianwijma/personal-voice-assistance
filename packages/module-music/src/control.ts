import { ActionError, type ModuleHostApi } from "@pva/core"
import {
  type HaEntity,
  HomeAssistant,
  HomeAssistantError,
  type HomeAssistantService,
  isLine,
  type JsonObject,
  type Language,
  PLAYBACK_LIMITS,
  PlaybackError,
  type PlaybackService,
  providerOffText,
  say,
  useService
} from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Clock, Data, Effect, Semaphore } from "effect"
import { oneLine, playerName, resolvePlayer, ROOM_CHARS, type TableRow } from "./resolve.ts"
import { texts, type TextKey } from "./texts.ts"

/**
 * The module's shared part: every call to a player, the volume, and the `Playback` service. Nothing here keeps a
 * player's state: each answer reads the Home Assistant provider's cache at that moment. The one thing kept is the level
 * this module itself last set on a player (below), because the provider polls and its cache shows a change up to a
 * minute late.
 */

/** Each call to a player waits at most this long (the `Playback` contract's bound; an action has 5 s in all). */
export const CALL_TIMEOUT_MS = PLAYBACK_LIMITS.callTimeoutMs

/**
 * How long a level this module set counts for a relative change ("louder" twice within a poll), when the provider's
 * cache still shows the level it had before: two of the provider's poll intervals. Once the cache shows another level
 * (this one, or someone else's change) the cache is believed again.
 */
export const OWN_LEVEL_MS = 120_000

/** The longest text the module plays by name (Home Assistant takes 2,000; a spoken request is a few words). */
export const QUERY_CHARS = 200

/** The longest title, artist or album the module repeats from Home Assistant. */
export const TITLE_CHARS = 100

export type Kind = "artist" | "album" | "track" | "playlist" | "radio"
export type Queue = "now" | "next" | "add"
export type Transport = "pause" | "resume" | "next" | "previous"

const KIND_TEXT: Record<Kind, TextKey> = { artist: "kindArtist", album: "kindAlbum", track: "kindTrack", playlist: "kindPlaylist", radio: "kindRadio" }

const TRANSPORT: Record<Transport, { readonly service: string; readonly done: TextKey }> = {
  pause: { service: "media_pause", done: "paused" },
  resume: { service: "media_play", done: "resumed" },
  next: { service: "media_next_track", done: "next" },
  previous: { service: "media_previous_track", done: "previous" }
}

/** An answer that is not a failure (a question, "nothing of that name", "it is off"): spoken as it is. */
export class Answer extends Data.TaggedError("Answer")<{ readonly text: string }> {}

export interface Settings {
  readonly players: ReadonlyArray<TableRow>
  readonly useAreas: boolean
  readonly volumeStep: number
}

/** What a player is doing, as the provider's cache says now. */
export interface NowPlaying {
  readonly spoken: string
  readonly player: string
  readonly state: "playing" | "paused" | "not playing" | "unknown"
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly volumePercent?: number
  /** How old the state may be. */
  readonly asOf: string
  readonly stale: boolean
}

const PLAYING = new Set(["playing", "buffering"])
const IDLE = new Set(["idle", "off", "standby", "on"])

/** A finite level from 0 to 1 in the player's attributes, else `undefined`. */
export const cachedLevel = (entity: HaEntity): number | undefined => {
  const v = entity.attributes.volume_level
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined
}

const text = (entity: HaEntity, key: string): string | undefined => {
  const v = entity.attributes[key]
  if (typeof v !== "string") return undefined
  const line = oneLine(v, TITLE_CHARS)
  return line === "" ? undefined : line
}

const percent = (level: number): number => Math.round(level * 100)
const clamp = (level: number): number => Math.min(1, Math.max(0, level))

/** A query the module plays by name: one line, a few words, never an address, a path or a media source. */
export const queryProblem = (query: string): "address" | "bad" | undefined => {
  const q = query.trim()
  if (q === "" || !isLine(q, QUERY_CHARS)) return "bad"
  // Music Assistant takes a content id with "://" as an address, and one that names a file on its server as that
  // file: neither is something a person said, so neither is passed on.
  if (q.includes("://") || /^[/\\~.]/.test(q) || /^[a-z]:[\\/]/i.test(q) || /^media-source:/i.test(q)) return "address"
  return undefined
}

export const makeControl = (host: Pick<ModuleHostApi, "service" | "view">, settings: Settings) =>
  Effect.gen(function*() {
    /** Volume changes go one at a time: the level is read, changed and recorded inside the permit. */
    const serial = yield* Semaphore.make(1)
    /** Per player: the level the module set, the level the cache showed before, and when. */
    const ownLevels = new Map<string, { readonly before: number | undefined; readonly set: number; readonly at: number }>()

    /** The player's present level: the module's own recent setting while the cache has not moved, else the cache's. */
    const presentLevel = (entity: HaEntity, now: number): number | undefined => {
      const cached = cachedLevel(entity)
      const own = ownLevels.get(entity.entityId)
      if (own !== undefined) {
        if (now - own.at <= OWN_LEVEL_MS && cached === own.before) return own.set
        ownLevels.delete(entity.entityId)
      }
      return cached
    }

    const callPlayer = (ha: HomeAssistantService, entity: HaEntity, service: string, data?: JsonObject) =>
      ha.callService({ domain: "media_player", service, target: { entityIds: [entity.entityId] }, ...(data !== undefined ? { data } : {}) }).pipe(
        Effect.timeoutOrElse({
          duration: CALL_TIMEOUT_MS,
          orElse: () => Effect.fail(new HomeAssistantError({ reason: "timeout", detail: `no answer within ${CALL_TIMEOUT_MS} ms` }))
        })
      )

    /** A failed call, worded: what the person can do, never that nothing happened when it may have. */
    const callFailure = (lang: Language, entity: HaEntity, e: HomeAssistantError, failedKey: TextKey = "failed", values: Record<string, string> = {}) => {
      const player = playerName(entity)
      const key: TextKey = e.reason === "not_connected" ? "notConnected"
        : e.reason === "refused" ? "refused"
        : e.reason === "unknown_entity" ? "unknownEntity"
        : e.reason === "invalid" ? "invalid"
        : e.reason === "timeout" ? "timeout"
        : failedKey
      return new ActionError({ message: say(texts, lang, key, { player, ...values }) })
    }

    /** The player a request means: the room or player said, else the asking device's room. */
    const target = (ha: HomeAssistantService, where: string | undefined, room: string | undefined, lang: Language) =>
      Effect.gen(function*() {
        const said = where?.trim()
        const name = said !== undefined && said !== "" ? said : room
        if (name === undefined || name.trim() === "") return yield* new Answer({ text: say(texts, lang, "noRoom") })
        if (!isLine(name, ROOM_CHARS)) return yield* new Answer({ text: say(texts, lang, "badRoom") })
        const r = yield* resolvePlayer(ha, settings.players, settings.useAreas, name)
        switch (r.kind) {
          case "player":
            return r.entity
          case "not-yet":
            return yield* new ActionError({ message: say(texts, lang, "notYet") })
          case "missing":
            return yield* new ActionError({ message: say(texts, lang, "missingPlayer", { where: oneLine(r.where, ROOM_CHARS) }) })
          case "ambiguous":
            return yield* new Answer({ text: say(texts, lang, "ambiguous", { where: oneLine(r.where, ROOM_CHARS), names: speakList(r.names, lang, { max: 4 }) ?? r.names.join(", ") }) })
          case "empty":
            return yield* new Answer({ text: say(texts, lang, "noPlayer", { where: oneLine(r.where, ROOM_CHARS) }) })
          case "unknown":
            return yield* new Answer({ text: say(texts, lang, "unknownRoom", { where: oneLine(r.where, ROOM_CHARS) }) })
        }
      })

    /** A player that can take a command now: not unavailable, and (for transport) not switched off. */
    const usable = (entity: HaEntity, lang: Language, offIsAnswer: boolean) =>
      entity.state === "unavailable" ? Effect.fail(new ActionError({ message: say(texts, lang, "unavailable", { player: playerName(entity) }) }))
      : offIsAnswer && entity.state === "off" ? Effect.fail(new Answer({ text: say(texts, lang, "switchedOff", { player: playerName(entity) }) }))
      : Effect.void

    /** Run `use` with the provider looked up now; the provider being off is a failure that says so. */
    const withHa = <A>(lang: Language, use: (ha: HomeAssistantService) => Effect.Effect<A, ActionError | Answer>) =>
      useService(host, HomeAssistant, use).pipe(
        Effect.catchTag("ProviderOff", () => Effect.fail(new ActionError({ message: providerOffText(lang, "Home Assistant") })))
      )

    const transport = (op: Transport, where: string | undefined, room: string | undefined, lang: Language) =>
      withHa(lang, (ha) =>
        Effect.gen(function*() {
          const entity = yield* target(ha, where, room, lang)
          yield* usable(entity, lang, true)
          const { service, done } = TRANSPORT[op]
          yield* callPlayer(ha, entity, service).pipe(Effect.mapError((e) => callFailure(lang, entity, e)))
          return say(texts, lang, done, { player: playerName(entity) })
        }))

    const play = (input: { readonly query: string; readonly kind: Kind; readonly queue?: Queue | undefined }, where: string | undefined, room: string | undefined, lang: Language) =>
      withHa(lang, (ha) =>
        Effect.gen(function*() {
          const problem = queryProblem(input.query)
          if (problem !== undefined) return yield* new Answer({ text: say(texts, lang, problem === "address" ? "address" : "badQuery") })
          const query = input.query.trim()
          const entity = yield* target(ha, where, room, lang)
          yield* usable(entity, lang, false)
          const enqueue = input.queue === "next" ? { enqueue: "next" } : input.queue === "add" ? { enqueue: "add" } : {}
          yield* callPlayer(ha, entity, "play_media", { media_content_id: query, media_content_type: input.kind, ...enqueue }).pipe(
            Effect.mapError((e) => callFailure(lang, entity, e, "playFailed", { query }))
          )
          const key: TextKey = input.queue === "next" ? "playsNext" : input.queue === "add" ? "added" : "playing"
          const spoken = say(texts, lang, key, { player: playerName(entity), kind: say(texts, lang, KIND_TEXT[input.kind]), query })
          return key === "playing" ? spoken : spoken.charAt(0).toUpperCase() + spoken.slice(1)
        }))

    /**
     * Set a player's volume: `to` a level from 0 to 1, or `by` a step from −1 to 1 from its present level (clamped).
     * One change at a time; the player is read again inside the permit. Answers the level set.
     */
    const setVolume = (ha: HomeAssistantService, entityId: string, change: { readonly to: number } | { readonly by: number }) =>
      serial.withPermits(1)(
        Effect.gen(function*() {
          const entity = ha.entity(entityId)
          if (entity === undefined) return yield* Effect.fail(new HomeAssistantError({ reason: "unknown_entity", detail: "not in the cache" }))
          const now = yield* Clock.currentTimeMillis
          let level: number
          if ("to" in change) level = clamp(change.to)
          else {
            const present = presentLevel(entity, now)
            if (present === undefined) return { unknown: true as const, entity }
            level = clamp(present + change.by)
          }
          level = Math.round(level * 100) / 100
          const before = cachedLevel(entity)
          yield* callPlayer(ha, entity, "volume_set", { volume_level: level }).pipe(
            // It may or may not have happened: the module no longer knows the level it set.
            Effect.tapError(() => Effect.sync(() => void ownLevels.delete(entityId)))
          )
          ownLevels.set(entityId, { before, set: level, at: yield* Clock.currentTimeMillis })
          return { unknown: false as const, entity, level }
        })
      )

    const volume = (input: { readonly level?: number | undefined; readonly change?: "up" | "down" | undefined }, where: string | undefined, room: string | undefined, lang: Language) =>
      withHa(lang, (ha) =>
        Effect.gen(function*() {
          if (input.level === undefined && input.change === undefined) return yield* new Answer({ text: say(texts, lang, "volumeWhich") })
          const entity = yield* target(ha, where, room, lang)
          yield* usable(entity, lang, true)
          const step = settings.volumeStep / 100
          const change = input.level !== undefined ? { to: input.level / 100 } : { by: input.change === "up" ? step : -step }
          const r = yield* setVolume(ha, entity.entityId, change).pipe(Effect.mapError((e) => callFailure(lang, entity, e)))
          if (r.unknown) return yield* new Answer({ text: say(texts, lang, "volumeUnknown", { player: playerName(r.entity) }) })
          return say(texts, lang, "volumeSet", { player: playerName(r.entity), percent: percent(r.level) })
        }))

    const nowPlaying = (where: string | undefined, room: string | undefined, lang: Language) =>
      withHa(lang, (ha) =>
        Effect.gen(function*() {
          const entity = yield* target(ha, where, room, lang)
          const player = playerName(entity)
          const stale = ha.connection() !== "connected"
          const title = text(entity, "media_title")
          const artist = text(entity, "media_artist")
          const album = text(entity, "media_album_name")
          const what = title === undefined ? undefined : artist === undefined ? title : say(texts, lang, "titleBy", { title, artist })
          const level = cachedLevel(entity)
          const state: NowPlaying["state"] = PLAYING.has(entity.state) ? "playing" : entity.state === "paused" ? "paused" : IDLE.has(entity.state) ? "not playing" : "unknown"
          const sentence = state === "playing" ? (what === undefined ? say(texts, lang, "nowSomething", { player }) : say(texts, lang, "nowPlaying", { player, what }))
            : state === "paused" ? (what === undefined ? say(texts, lang, "nowPausedSomething", { player }) : say(texts, lang, "nowPaused", { player, what }))
            : state === "not playing" ? say(texts, lang, "nowNothing", { player })
            : entity.state === "unavailable" ? say(texts, lang, "unavailable", { player })
            : say(texts, lang, "nowUnknown", { player })
          const result: NowPlaying = {
            spoken: stale ? `${sentence} ${say(texts, lang, "stale")}` : sentence,
            player,
            state,
            ...(title !== undefined && state !== "not playing" && state !== "unknown" ? { title } : {}),
            ...(artist !== undefined && state !== "not playing" && state !== "unknown" ? { artist } : {}),
            ...(album !== undefined && state !== "not playing" && state !== "unknown" ? { album } : {}),
            ...(level !== undefined && state !== "unknown" ? { volumePercent: percent(level) } : {}),
            asOf: say(texts, lang, stale ? "stale" : "asOf"),
            stale
          }
          return result
        }))

    /** `Playback` (packages/core/src/Playback.ts): exactly its two operations, for the host's "stop" and volume. */
    const playback: PlaybackService = {
      pause: (room) =>
        Effect.gen(function*() {
          if (!isLine(room, PLAYBACK_LIMITS.roomChars) || room.trim() === "") return yield* new PlaybackError({ reason: "invalid", detail: "room: one line of 1 to 60 characters" })
          return yield* useService(host, HomeAssistant, (ha) =>
            Effect.gen(function*() {
              const r = yield* resolvePlayer(ha, settings.players, settings.useAreas, room)
              if (r.kind === "not-yet") return false // the state is not known yet: nothing is done
              if (r.kind !== "player") return yield* new PlaybackError({ reason: "no_player", detail: r.kind === "ambiguous" ? "several players, none chosen" : r.kind })
              if (!PLAYING.has(r.entity.state)) return false
              yield* callPlayer(ha, r.entity, "media_pause").pipe(Effect.mapError(playbackError))
              return true
            })).pipe(Effect.catchTag("ProviderOff", () => Effect.fail(new PlaybackError({ reason: "failed", detail: "the home-assistant module is off" }))))
        }),
      changeVolume: (room, change) =>
        Effect.gen(function*() {
          if (!isLine(room, PLAYBACK_LIMITS.roomChars) || room.trim() === "") return yield* new PlaybackError({ reason: "invalid", detail: "room: one line of 1 to 60 characters" })
          const ok = "to" in change
            ? typeof change.to === "number" && Number.isFinite(change.to) && change.to >= 0 && change.to <= 1
            : typeof change.by === "number" && Number.isFinite(change.by) && change.by >= -1 && change.by <= 1
          if (!ok) return yield* new PlaybackError({ reason: "invalid", detail: "a level from 0 to 1 (to) or a step from -1 to 1 (by)" })
          return yield* useService(host, HomeAssistant, (ha) =>
            Effect.gen(function*() {
              const r = yield* resolvePlayer(ha, settings.players, settings.useAreas, room)
              if (r.kind === "not-yet") return yield* new PlaybackError({ reason: "by" in change ? "unknown_level" : "failed", detail: "no state from Home Assistant yet" })
              if (r.kind !== "player") return yield* new PlaybackError({ reason: "no_player", detail: r.kind === "ambiguous" ? "several players, none chosen" : r.kind })
              const set = yield* setVolume(ha, r.entity.entityId, change).pipe(Effect.mapError(playbackError))
              if (set.unknown) return yield* new PlaybackError({ reason: "unknown_level", detail: "the player's present level is not known" })
              return set.level
            })).pipe(Effect.catchTag("ProviderOff", () => Effect.fail(new PlaybackError({ reason: "failed", detail: "the home-assistant module is off" }))))
        })
    }

    return { transport, play, volume, nowPlaying, playback }
  })

const playbackError = (e: HomeAssistantError) => new PlaybackError({ reason: e.reason === "timeout" ? "timeout" : "failed", detail: `Home Assistant: ${e.reason}` })

export type Control = Effect.Success<ReturnType<typeof makeControl>>
