import {
  ActionError,
  CurrentTurn,
  defineAction,
  defineModule,
  Devices,
  hasScreen,
  type KnownDevice,
  makeTool,
  MAX_LIVE_PER_MODULE,
  type ModuleServicesV2,
  Param,
  type Presentation,
  Setting,
  ToolError
} from "@pva/core"
import { speakList } from "@pva/language"
import { homeLanguage, isLine, say } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { matchRoom, meansEveryone, roomKey } from "./rooms.ts"
import { texts } from "./texts.ts"

/**
 * Broadcast (docs/modules/broadcast.md): say a short message in the assistant's voice, with a chime first, on every
 * other device of the house or in one room, and show it as a card on the screens there. The module stores nothing and
 * schedules nothing: delivery is the notification service's (`ctx.speech`, one decision for do not disturb, a device
 * that cannot speak and privacy) and the presentation service's (`ctx.present`).
 */

/** The longest message: it is spoken and shown as it was said, so it is one short line. */
export const MESSAGE_MAX = 200
/** The longest room name taken from a request. */
export const ROOM_MAX = 40
/** The most devices one broadcast is queued on: one synchronous enqueue each, far below a millisecond. */
export const MAX_TARGETS = 64
/** The most screens one broadcast puts a card on: the Presenter allows a module this many live presentations. */
export const MAX_CARDS = MAX_LIVE_PER_MODULE
const NAME_MAX = 40

const settings = {
  showCard: Setting.boolean({
    label: "Show the message on screens",
    description: "Also put the message on the screens of the devices it is announced on, for half a minute.",
    default: true
  })
}

const Message = Schema.String.check(
  Schema.makeFilter((t: string) => (t.trim() !== "" && isLine(t, MESSAGE_MAX)) || `one line of at most ${MESSAGE_MAX} characters`)
).annotate({ description: "What to announce, exactly as the person said it: one short line, never reworded" })
const RoomName = Schema.String.check(Schema.makeFilter((t: string) => isLine(t, ROOM_MAX) || `one line of at most ${ROOM_MAX} characters`)).annotate({
  description: "The room to announce in, as the person said it. Leave out for every device in the house"
})

type Lang = "en" | "nl"
type Delivery = { readonly deviceId: string; readonly queued: boolean; readonly why?: string | undefined }
type Outcome = { readonly kind: "said" | "asked"; readonly text: string } | { readonly kind: "failed"; readonly text: string }

const reasonText = (lang: Lang, why: string): string =>
  say(texts, lang, why === "offline" ? "reasonOffline" : why === "dnd" ? "reasonDnd" : why === "cannot-speak" ? "reasonSpeak" : why === "private" ? "reasonPrivate" : why === "busy" ? "reasonBusy" : "reasonFailed")

const cut = (name: string): string => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name)
const list = (lang: Lang, items: ReadonlyArray<string>, max = 3): string => speakList(items, lang, { max }) ?? items.join(", ")
/** The rooms to choose from: named up to this many. */
const ROOMS_NAMED = 8

/** One key per device, so a second broadcast replaces a device's card in place instead of using another of the module's places. */
const cardKey = (deviceId: string): string => `b${createHash("sha256").update(deviceId).digest("hex").slice(0, 20)}`

/**
 * One broadcast, for a tool and for the action. What was queued and what was not is read from the handles' deliveries,
 * never assumed; the announcement is not waited for (a tool inside a turn may not: its reply is what it waits for).
 */
const broadcast = (
  ctx: Pick<ModuleServicesV2, "host" | "speech" | "present">,
  showCard: boolean,
  input: { readonly message?: string; readonly room?: string }
): Effect.Effect<Outcome> =>
  Effect.gen(function*() {
    const lang = homeLanguage(ctx.host.view())
    const turn = yield* CurrentTurn
    const chime = input.message === undefined
    const message = chime ? say(texts, lang, "chimeWord") : input.message.trim()
    if (message === "") return { kind: "asked", text: say(texts, lang, "noMessage") } as const
    // A tool's schema has checked this already; an action's words have not been (one line, at most the bound).
    if (!isLine(message, MESSAGE_MAX)) return { kind: "asked", text: say(texts, lang, "badMessage", { max: MESSAGE_MAX }) } as const
    const known = ctx.host.service(Devices)
    if (known === undefined) return { kind: "failed", text: say(texts, lang, "noDevices") } as const
    // Every device is read now and decided again at every call: nothing of the house is kept between broadcasts.
    const all = known.list()
    const origin = turn?.deviceId
    const spokenRoom = input.room !== undefined && input.room.trim() !== "" && !meansEveryone(input.room) ? input.room.trim() : undefined
    let roomLabel: string | undefined
    let targets: ReadonlyArray<KnownDevice>
    if (spokenRoom === undefined) {
      targets = all.filter((d) => d.id !== origin)
      if (targets.length === 0) return { kind: "said", text: say(texts, lang, "alone") } as const
    } else {
      const match = matchRoom(all, spokenRoom)
      if (match.kind === "several") return { kind: "asked", text: say(texts, lang, "whichRoom", { rooms: list(lang, match.rooms.map(cut), ROOMS_NAMED) }) } as const
      if (match.kind === "none") {
        const rooms = match.rooms.map(cut)
        return { kind: "asked", text: rooms.length === 0 ? say(texts, lang, "noRooms", { room: cut(spokenRoom) }) : say(texts, lang, "noRoom", { room: cut(spokenRoom), rooms: list(lang, rooms, ROOMS_NAMED) }) } as const
      }
      roomLabel = match.label
      targets = all.filter((d) => d.room !== undefined && d.id !== origin && roomKey(d.room) === match.key)
      if (targets.length === 0) return { kind: "said", text: say(texts, lang, "aloneInRoom", { room: cut(match.label) }) } as const
    }
    const ordered = [...targets].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const beyond = Math.max(0, ordered.length - MAX_TARGETS)
    const chosen = ordered.slice(0, MAX_TARGETS)
    const nameOf = (id: string): string => cut(all.find((d) => d.id === id)?.name ?? id)

    // The announcement, one device at a time: the origin is never in the list, and `ctx.speech` decides each device now.
    const deliveries: Array<Delivery> = []
    for (const d of chosen) {
      const result: ReadonlyArray<Delivery> | "unavailable" = yield* ctx.speech.say({ device: d.id }, message, { cue: true }).pipe(
        Effect.map((handle): ReadonlyArray<Delivery> | "unavailable" => handle.deliveries),
        Effect.catchTag("SpeechError", (e): Effect.Effect<ReadonlyArray<Delivery> | "unavailable"> =>
          Effect.succeed(e.reason === "unavailable" ? "unavailable" : [{ deviceId: d.id, queued: false, why: "failed" }])
        )
      )
      if (result === "unavailable") return { kind: "failed", text: say(texts, lang, "unavailable") } as const
      deliveries.push(...result)
    }
    const queued = deliveries.filter((d) => d.queued)
    const skipped = deliveries.filter((d) => !d.queued)

    // The card goes to screens where the message is, and to screens that cannot speak it; never under do not disturb or to a
    // device that is not connected (those say nothing and show nothing).
    const cardDevices = showCard && !chime
      ? deliveries
        .filter((d) => (d.queued || d.why === "cannot-speak" || d.why === "busy") && known.get(d.deviceId) !== undefined && hasScreen(known.get(d.deviceId)!))
        .map((d) => d.deviceId)
        .slice(0, MAX_CARDS)
      : []
    const shownOn: Array<string> = []
    let cardsRefused = 0
    if (cardDevices.length > 0) {
      const from = origin === undefined ? undefined : known.get(origin)?.name
      const card: Presentation = {
        kind: "card",
        title: roomLabel === undefined ? say(texts, lang, "cardTitle") : say(texts, lang, "cardTitleRoom", { room: cut(roomLabel) }),
        text: message,
        ...(from !== undefined ? { facts: [{ label: say(texts, lang, "cardFrom"), value: cut(from) }] } : {}),
        spoken: message
      }
      for (const id of cardDevices) {
        const outcome = yield* ctx.present.show({ device: id }, card, { lifetime: "transient", key: cardKey(id) }).pipe(
          Effect.map((handle) => handle.outcome.devices.some((s) => s.deviceId === id && s.shown)),
          Effect.catchTag("PresentError", () => Effect.succeed(false))
        )
        if (outcome) shownOn.push(id)
        else cardsRefused++
      }
    }

    const parts: Array<string> = []
    const items = skipped.map((d) => `${nameOf(d.deviceId)} (${reasonText(lang, d.why ?? "failed")})`)
    if (queued.length > 0) {
      parts.push(say(texts, lang, "announcing", { devices: list(lang, queued.map((d) => nameOf(d.deviceId))) }))
      if (items.length > 0) parts.push(say(texts, lang, "notOn", { devices: list(lang, items) }))
    } else if (skipped.every((d) => d.why === "dnd")) {
      parts.push(say(texts, lang, "nothingDnd"))
    } else {
      parts.push(say(texts, lang, "nothing", { devices: list(lang, items) }))
    }
    if (shownOn.length > 0) parts.push(say(texts, lang, "alsoShown", { devices: list(lang, shownOn.map(nameOf)) }))
    if (cardsRefused > 0) parts.push(shownOn.length === 0 && cardsRefused === cardDevices.length ? say(texts, lang, "cardsFailed") : say(texts, lang, "cardsSome", { count: cardsRefused }))
    if (beyond > 0) parts.push(say(texts, lang, "cut", { count: beyond }))
    return { kind: "said", text: parts.join(" ") } as const
  })

const actionResult = (outcome: Effect.Effect<Outcome>) =>
  Effect.flatMap(outcome, (o) => (o.kind === "failed" ? Effect.fail(new ActionError({ message: o.text })) : Effect.succeed({ say: o.text })))

const toolResult = (lang: Lang, outcome: Outcome) =>
  outcome.kind === "failed" ? Effect.fail(new ToolError({ message: outcome.text })) : Effect.succeed({ spoken: outcome.text })

/**
 * Broadcast, off by default. Its risk class is `change`: speaking inside the house changes something in the house and
 * sends nothing outside it (docs/MODULES.md §4: `message` is for people outside the house).
 */
export const broadcastModule = defineModule({
  apiVersion: 2,
  id: "broadcast",
  name: "Broadcast",
  description: "Announces a message on every device or in one room, with a chime.",
  enabledByDefault: false,
  settings,
  start: (ctx) => {
    const showCard = () => ctx.settings.showCard !== false
    return Effect.succeed({
      instructions:
        "To say something to the house (\"tell everyone dinner is ready\", \"tell the kitchen I'm coming\"), use broadcast_send with the person's own words, never reworded; it never goes to the device asked on.",
      tools: [
        makeTool({
          name: "broadcast_send",
          description:
            "Announce a short message, in the assistant's voice with a chime first, on every other device in the house or only in one room, and show it on screens there. Never on the device that asked. It is queued, not waited for: the answer says where it was queued and where it was not (offline, do not disturb, no speaker). Say the message as the person said it.",
          parameters: Schema.Struct({ message: Message, room: Schema.optionalKey(RoomName) }),
          risk: "change",
          latency: "quick",
          execute: ({ message, room }) =>
            broadcast(ctx, showCard(), { message, ...(room !== undefined ? { room } : {}) }).pipe(Effect.flatMap((o) => toolResult(homeLanguage(ctx.host.view()), o)))
        }),
        makeTool({
          name: "broadcast_chime",
          description:
            "Ring the announcement chime on every other device in the house or only in one room. The chime cannot be played without a line after it, so it is followed by one word (\"Attention.\"). Never on the device that asked.",
          parameters: Schema.Struct({ room: Schema.optionalKey(RoomName) }),
          risk: "change",
          latency: "quick",
          execute: ({ room }) => broadcast(ctx, showCard(), { ...(room !== undefined ? { room } : {}) }).pipe(Effect.flatMap((o) => toolResult(homeLanguage(ctx.host.view()), o)))
        })
      ],
      actions: [
        defineAction({
          id: "send",
          label: "Announce a message to the house or a room",
          description: "Announce what was said on every other device in the house, or only in one room, with a chime.",
          examples: [
            "tell everyone dinner is ready",
            "announce that the film starts",
            "tell the kitchen that I'm coming",
            "zeg tegen iedereen dat het eten klaar is",
            "omroepen het eten is klaar",
            "zeg tegen de keuken dat ik eraan kom"
          ],
          params: {
            message: Param.text({ label: "Message", after: ["everyone", "iedereen", "announce", "omroepen", "that", "dat"], maxWords: 8 }),
            room: Param.text({ label: "Room", after: ["in", "tegen", "naar"], maxWords: 4, optional: true })
          },
          // Words and slots, no language model: a name (the room) is text, and `broadcast` resolves it and asks when it
          // matches none or several. A message is at most eight words here; a longer one goes to the assistant, which
          // calls the tool.
          phrases: {
            en: ["tell everyone {message}", "tell everyone that {message}", "announce {message}", "announce that {message}", "tell the {room} that {message}", "announce in the {room} that {message}"],
            nl: ["zeg tegen iedereen {message}", "zeg tegen iedereen dat {message}", "omroepen {message}", "zeg tegen de {room} dat {message}", "omroepen in de {room} dat {message}"]
          },
          risk: "change",
          offerAsTool: false,
          run: ({ message, room }) => actionResult(broadcast(ctx, showCard(), { message, ...(room !== undefined ? { room } : {}) }))
        }),
        defineAction({
          id: "chime",
          label: "Ring the chime in the house or a room",
          description: "Play the announcement chime (followed by one word) on every other device in the house, or only in one room.",
          examples: ["ring the dinner bell", "sound the chime", "ring the bell in the kitchen", "bel de gong", "bel de gong in de keuken"],
          params: { room: Param.text({ label: "Room", after: ["in"], maxWords: 4, optional: true }) },
          phrases: {
            en: ["ring the dinner bell", "sound the chime", "ring the bell in the {room}"],
            nl: ["bel de gong", "luid de bel", "bel de gong in de {room}"]
          },
          risk: "change",
          offerAsTool: false,
          run: ({ room }) => actionResult(broadcast(ctx, showCard(), { ...(room !== undefined ? { room } : {}) }))
        })
      ]
    })
  }
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<typeof broadcastModule> = [broadcastModule]
