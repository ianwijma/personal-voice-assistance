import { ActionError, CurrentTurn, isModuleStopped, type ModuleHostApi } from "@pva/core"
import {
  type HaEntity,
  HomeAssistant,
  HomeAssistantError,
  type HomeAssistantService,
  isLine,
  type JsonObject,
  type Language,
  providerOffText,
  say,
  useService
} from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Cause, Data, Deferred, Effect, Exit } from "effect"
import { oneLine, playerName, resolvePlayer, ROOM_CHARS, type TableRow } from "./resolve.ts"
import { texts, type TextKey } from "./texts.ts"

/**
 * The module's shared part: every call to a player (it no longer provides `Playback`: docs/modules/media.md §4.3). It keeps no player state and no
 * volume between calls: each answer reads the Home Assistant provider's cache at that moment, and each command is sent
 * whatever that cache says (it may be a minute old), with the service's own answer reported. The one record it keeps is
 * the outcome of recent invocations (`once`), so the same invocation never acts twice.
 */

/** Each call to a player waits at most this long (an action has 5 s in all). */
export const CALL_TIMEOUT_MS = 3_000

/** The longest content id the module sends (Home Assistant takes 2,000; a spoken request is a few words). */
export const QUERY_CHARS = 200

/** The longest title, artist or album the module repeats from Home Assistant. */
export const TITLE_CHARS = 100

/** Finished invocations kept (the oldest goes first): a repeat of one of them gets its first outcome. */
export const INVOCATIONS_KEPT = 256

export type Kind = "artist" | "album" | "track" | "playlist" | "radio"
export type Queue = "now" | "next" | "add"
export type Transport = "pause" | "resume" | "next" | "previous"

const KIND_TEXT: Record<Kind, TextKey> = { artist: "kindArtist", album: "kindAlbum", track: "kindTrack", playlist: "kindPlaylist", radio: "kindRadio" }

const TRANSPORT: Record<Transport, { readonly service: string; readonly asked: TextKey }> = {
  pause: { service: "media_pause", asked: "pauseAsked" },
  resume: { service: "media_play", asked: "resumeAsked" },
  next: { service: "media_next_track", asked: "nextAsked" },
  previous: { service: "media_previous_track", asked: "previousAsked" }
}

/** `play_media`'s `enqueue` for each choice: "now" replaces the queue, so it plays at once whatever the default is. */
const ENQUEUE: Record<Queue, string> = { now: "replace", next: "next", add: "add" }

/** An answer that is not a failure (a question, "nothing of that name"): spoken as it is. */
export class Answer extends Data.TaggedError("Answer")<{ readonly text: string }> {}

/** The provider stopped while a call was out: it may or may not have been carried out. */
class StoppedDuring extends Data.TaggedError("StoppedDuring")<{}> {}

export interface Settings {
  readonly players: ReadonlyArray<TableRow>
  readonly useAreas: boolean
}

/** What a player was doing at the provider's last poll. */
export interface NowPlaying {
  readonly spoken: string
  readonly player: string
  readonly state: "playing" | "paused" | "not playing" | "unavailable" | "unknown"
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly volumePercent?: number
  /** How old the state may be. */
  readonly asOf: string
  readonly stale: boolean
}

/** Whether an invocation's call to Home Assistant has gone out. */
interface Sent {
  value: boolean
}

/** What an invocation came to, kept for its repeats. */
type Outcome = { readonly ok: true; readonly say: string } | { readonly ok: false; readonly message: string }

const PLAYING = new Set(["playing", "buffering"])
const IDLE = new Set(["idle", "off", "standby", "on"])

/** A finite level from 0 to 1 in the player's attributes, else `undefined` (only ever shown, never computed from). */
const cachedLevel = (entity: HaEntity): number | undefined => {
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

/**
 * Text the module refuses to send as a content id. Home Assistant's Music Assistant integration reads one content id
 * several ways (an address with "://", a number as a library id, a path its host can open as a file, anything else as
 * a name to search), so these forms are refused: "://" or a backslash anywhere, a leading "/", "." or "~" or a drive
 * prefix (`address`: an address or a path); a file extension at the end (`form`: a name of that form, "will.i.am" or
 * "Love.exe" too, cannot be looked up safely through this connection); only digits (`digits`). A slash inside a name
 * (AC/DC) is allowed. This narrows what can reach the file branch; it does not prove it unreachable (a relative path
 * without an extension that the host can read is still possible): a name-only lookup is missing below
 * (docs/modules/music.md).
 */
export const queryProblem = (query: string): "address" | "form" | "bad" | "digits" | undefined => {
  const q = query.trim()
  if (q === "" || !isLine(q, QUERY_CHARS)) return "bad"
  if (q.includes("://") || q.includes("\\") || /^[/.~]/.test(q) || /^[A-Za-z]:/.test(q)) return "address"
  if (/\.[A-Za-z0-9]{2,5}$/.test(q)) return "form"
  if (/^\d+$/.test(q)) return "digits"
  return undefined
}

export const makeControl = (host: Pick<ModuleHostApi, "service" | "view">, settings: Settings) =>
  Effect.gen(function*() {
    // -- one bounded record of phrase invocations, by their identity ------------------------------------------------------
    const records = new Map<string, Deferred.Deferred<Outcome>>()
    /**
     * A phrase command's invocation runs once for its identity (assistant, conversation, turn, device, the operation and
     * its input): a repeat, even a concurrent one, gets the first outcome and sends nothing. A run cut short
     * (interrupted, a defect) before its call was sent decided nothing: its record goes, so a replay runs. Cut short
     * after the call was sent, it may have happened: the record stays as "I may already have done that", and a replay
     * sends nothing. Only phrases: a tool or action call made by the model has no identity of its own (the gateway gives
     * its handler no per-call id, and a turn plus an input is not one), so it always runs: "skip two songs" skips twice.
     */
    const once = (operation: string, input: unknown, lang: Language, run: (sent: Sent) => Effect.Effect<string, ActionError | Answer>): Effect.Effect<string, ActionError> =>
      Effect.gen(function*() {
        const sent: Sent = { value: false }
        const outcome: Effect.Effect<Outcome> = run(sent).pipe(
          Effect.map((s): Outcome => ({ ok: true, say: s })),
          Effect.catchTag("Answer", (a) => Effect.succeed<Outcome>({ ok: true, say: a.text })),
          Effect.catchTag("ActionError", (e) => Effect.succeed<Outcome>({ ok: false, message: e.message }))
        )
        const turn = yield* CurrentTurn
        let result: Outcome
        if (turn === undefined || turn.source !== "phrase") result = yield* outcome
        else {
          const key = [operation, turn.assistantId, turn.conversationId, turn.turnId, turn.deviceId, JSON.stringify(input)].join("\u0000")
          const kept = records.get(key)
          if (kept !== undefined) result = yield* Deferred.await(kept)
          else {
            const mine = Deferred.makeUnsafe<Outcome>()
            records.set(key, mine)
            if (records.size > INVOCATIONS_KEPT) records.delete(records.keys().next().value!)
            result = yield* outcome.pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) return Deferred.succeed(mine, exit.value)
                // Sent: it may have happened, so the record stays and a replay sends nothing.
                if (sent.value) return Deferred.succeed(mine, { ok: false, message: say(texts, lang, "mayHaveHappened") })
                return Effect.sync(() => void (records.get(key) === mine && records.delete(key))).pipe(
                  Effect.andThen(Deferred.succeed(mine, { ok: false, message: say(texts, lang, "unfinished") }))
                )
              })
            )
          }
        }
        return result.ok ? result.say : yield* new ActionError({ message: result.message })
      })

    /**
     * One call to one player, within `timeoutMs` (default `CALL_TIMEOUT_MS`); the provider stopping during it is
     * `StoppedDuring`. `sent` is marked right before the call goes out.
     */
    const callPlayer = (ha: HomeAssistantService, entity: HaEntity, service: string, data: JsonObject | undefined, sent: Sent, timeoutMs: number = CALL_TIMEOUT_MS) =>
      Effect.suspend(() => {
        sent.value = true
        return ha.callService({ domain: "media_player", service, target: { entityIds: [entity.entityId] }, ...(data !== undefined ? { data } : {}) })
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new HomeAssistantError({ reason: "timeout", detail: `no answer within ${timeoutMs} ms` }))
        }),
        Effect.catchCause((cause): Effect.Effect<never, HomeAssistantError | StoppedDuring> => {
          if (cause.reasons.some((r) => Cause.isDieReason(r) && isModuleStopped(r.defect))) return Effect.fail(new StoppedDuring())
          return Effect.failCause(cause as Cause.Cause<HomeAssistantError>)
        })
      )

    /** A failed call, worded: what the person can do, never that nothing happened when it may have. */
    const callFailure = (lang: Language, entity: HaEntity, e: HomeAssistantError | StoppedDuring, failedKey: TextKey = "failed", values: Record<string, string> = {}) => {
      const player = playerName(entity)
      const key: TextKey = e._tag === "StoppedDuring" ? "stoppedDuring"
        : e.reason === "not_connected" ? "notConnected"
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
          case "ambiguous": {
            const names = speakList(r.names, lang, { max: Math.max(2, r.names.length) }) ?? r.names.join(", ")
            const where = oneLine(r.where, ROOM_CHARS)
            return yield* new Answer({ text: r.count > r.names.length ? say(texts, lang, "ambiguousMany", { where, names, count: r.count }) : say(texts, lang, "ambiguous", { where, names }) })
          }
          case "empty":
            return yield* new Answer({ text: say(texts, lang, "noPlayer", { where: oneLine(r.where, ROOM_CHARS) }) })
          case "unknown":
            return yield* new Answer({ text: say(texts, lang, "unknownRoom", { where: oneLine(r.where, ROOM_CHARS) }) })
        }
      })

    /** Run `use` with the provider looked up now; the provider being off is a failure that says so. */
    const withHa = <A>(lang: Language, use: (ha: HomeAssistantService) => Effect.Effect<A, ActionError | Answer>) =>
      useService(host, HomeAssistant, use).pipe(
        Effect.catchTag("ProviderOff", () => Effect.fail(new ActionError({ message: providerOffText(lang, "Home Assistant") })))
      )

    const transport = (op: Transport, where: string | undefined, room: string | undefined, lang: Language) =>
      once(op, { where: where ?? null }, lang, (sent) => withHa(lang, (ha) =>
        Effect.gen(function*() {
          const entity = yield* target(ha, where, room, lang)
          const { service, asked } = TRANSPORT[op]
          yield* callPlayer(ha, entity, service, undefined, sent).pipe(Effect.mapError((e) => callFailure(lang, entity, e)))
          return say(texts, lang, asked, { player: playerName(entity) })
        })))

    const play = (
      input: { readonly query: string; readonly kind: Kind; readonly artist?: string | undefined; readonly queue?: Queue | undefined },
      where: string | undefined,
      room: string | undefined,
      lang: Language
    ) =>
      once("play", { ...input, where: where ?? null }, lang, (sent) => withHa(lang, (ha) =>
        Effect.gen(function*() {
          const title = input.query.trim()
          // An artist narrows a song or an album: "Artist - Title", the form Music Assistant's name search takes.
          const given = input.artist?.trim()
          const artist = (input.kind === "track" || input.kind === "album") && given !== undefined && given !== "" ? given : undefined
          const refusal = (p: ReturnType<typeof queryProblem>): Answer | undefined =>
            p === "address" ? new Answer({ text: say(texts, lang, "address") })
            : p === "form" ? new Answer({ text: say(texts, lang, "nameForm") })
            : p === "bad" ? new Answer({ text: say(texts, lang, "badQuery") })
            : undefined
          const titleProblem = queryProblem(title)
          const titleRefused = refusal(titleProblem)
          if (titleRefused !== undefined) return yield* titleRefused
          if (artist !== undefined) {
            // The artist: the address, path, drive and name-form rules; an artist of digits only is a name ("311 - Amber").
            const artistRefused = refusal(queryProblem(artist))
            if (artistRefused !== undefined) return yield* artistRefused
          } else if (titleProblem === "digits") {
            return yield* new Answer({ text: say(texts, lang, input.kind === "track" || input.kind === "album" ? "digitsWhichArtist" : "digitsOnly", { query: title }) })
          }
          const contentId = artist === undefined ? title : `${artist} - ${title}`
          const combinedRefused = refusal(queryProblem(contentId))
          if (combinedRefused !== undefined) return yield* combinedRefused
          const entity = yield* target(ha, where, room, lang)
          const queue = input.queue ?? "now"
          const asked = say(texts, lang, KIND_TEXT[input.kind], { name: artist === undefined ? title : say(texts, lang, "titleBy", { title, artist }) })
          yield* callPlayer(ha, entity, "play_media", { media_content_id: contentId, media_content_type: input.kind, enqueue: ENQUEUE[queue] }, sent).pipe(
            Effect.mapError((e) => callFailure(lang, entity, e, "playFailed", { query: asked }))
          )
          return say(texts, lang, queue === "next" ? "nextQueued" : queue === "add" ? "addQueued" : "playAsked", { player: playerName(entity), query: asked })
        })))

    /** A level (0–100) sets exactly that; up and down send the player's own step. No level is read for a step. */
    const volume = (
      input: { readonly level?: number | undefined; readonly change?: "up" | "down" | undefined },
      where: string | undefined,
      room: string | undefined,
      lang: Language
    ) =>
      once("volume", { ...input, where: where ?? null }, lang, (sent) => withHa(lang, (ha) =>
        Effect.gen(function*() {
          if (input.level === undefined && input.change === undefined) return yield* new Answer({ text: say(texts, lang, "volumeWhich") })
          const entity = yield* target(ha, where, room, lang)
          const player = playerName(entity)
          if (input.level !== undefined) {
            yield* callPlayer(ha, entity, "volume_set", { volume_level: input.level / 100 }, sent).pipe(Effect.mapError((e) => callFailure(lang, entity, e)))
            return say(texts, lang, "volumeSet", { player, percent: input.level })
          }
          yield* callPlayer(ha, entity, input.change === "up" ? "volume_up" : "volume_down", undefined, sent).pipe(Effect.mapError((e) => callFailure(lang, entity, e)))
          return say(texts, lang, input.change === "up" ? "volumeUp" : "volumeDown", { player })
        })))

    const nowPlaying = (where: string | undefined, room: string | undefined, lang: Language) =>
      withHa(lang, (ha) =>
        Effect.gen(function*() {
          const entity = yield* target(ha, where, room, lang)
          const player = playerName(entity)
          const stale = ha.connection() !== "connected"
          const when = say(texts, lang, stale ? "checkedStale" : "checkedRecent")
          const title = text(entity, "media_title")
          const artist = text(entity, "media_artist")
          const album = text(entity, "media_album_name")
          const what = title === undefined ? undefined : artist === undefined ? title : say(texts, lang, "titleBy", { title, artist })
          const level = cachedLevel(entity)
          const state: NowPlaying["state"] = PLAYING.has(entity.state) ? "playing"
            : entity.state === "paused" ? "paused"
            : IDLE.has(entity.state) ? "not playing"
            : entity.state === "unavailable" ? "unavailable"
            : "unknown"
          const sentence = state === "playing" ? (what === undefined ? say(texts, lang, "nowSomething", { when, player }) : say(texts, lang, "nowPlaying", { when, player, what }))
            : state === "paused" ? (what === undefined ? say(texts, lang, "nowPausedSomething", { when, player }) : say(texts, lang, "nowPaused", { when, player, what }))
            : state === "not playing" ? say(texts, lang, "nowNothing", { when, player })
            : state === "unavailable" ? say(texts, lang, "nowUnavailable", { when, player })
            : say(texts, lang, "nowUnknown", { when, player })
          const shows = state === "playing" || state === "paused"
          const result: NowPlaying = {
            spoken: stale ? `${sentence} ${say(texts, lang, "mayBeOld")}` : sentence,
            player,
            state,
            ...(title !== undefined && shows ? { title } : {}),
            ...(artist !== undefined && shows ? { artist } : {}),
            ...(album !== undefined && shows ? { album } : {}),
            ...(level !== undefined && shows ? { volumePercent: percent(level) } : {}),
            asOf: when,
            stale
          }
          return result
        }))

    return { transport, play, volume, nowPlaying }
  })

export type Control = Effect.Success<ReturnType<typeof makeControl>>
