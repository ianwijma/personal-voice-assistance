import {
  ActionError,
  CurrentJob,
  CurrentPrincipal,
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
  type SpeechTarget,
  Setting,
  ToolError
} from "@pva/core"
import { speakList } from "@pva/language"
import { homeLanguage, isLine, say } from "@pva/module-contracts"
import { Effect, Schema, Semaphore } from "effect"
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
/** The longest spoken answer: a phrase command's answer is cut at 300 characters by the page boundary, and the tools' answers are held to the same bound. */
export const ANSWER_MAX = 300
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

const WHYS = ["offline", "dnd", "cannot-speak", "private", "busy", "failed"] as const
const reasonText = (lang: Lang, why: string): string =>
  say(texts, lang, why === "offline" ? "reasonOffline" : why === "dnd" ? "reasonDnd" : why === "cannot-speak" ? "reasonSpeak" : why === "private" ? "reasonPrivate" : why === "busy" ? "reasonBusy" : "reasonFailed")

/** A name cut to `max` UTF-16 units at a code point boundary, the ellipsis inside the budget. */
export const cutName = (name: string, max: number = NAME_MAX): string => {
  if (name.length <= max) return name
  let out = ""
  for (const ch of name) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}
const list = (lang: Lang, items: ReadonlyArray<string>, max = 3): string => speakList(items, lang, { max }) ?? items.join(", ")

/** One key per device, so a second broadcast replaces a device's card in place instead of using another of the module's places. */
const cardKey = (deviceId: string): string => `b${createHash("sha256").update(deviceId).digest("hex").slice(0, 20)}`

/** The device of whoever made the call: a turn's, a job's origin, a press's. `undefined`: nobody to leave out. */
const originDevice = Effect.gen(function*() {
  const principal = yield* CurrentPrincipal
  if (principal !== undefined) {
    switch (principal._tag) {
      case "turn": return principal.turn.deviceId
      case "job": return principal.job.deviceId
      case "notification": return principal.notification.deviceId
      case "presentation": return principal.presentation.deviceId
      case "local": return undefined
    }
  }
  return (yield* CurrentTurn)?.deviceId ?? (yield* CurrentJob)?.deviceId
})

/** The first answer that fits `ANSWER_MAX`, from the fullest to the most summarised. */
const firstThatFits = (lang: Lang, build: (level: 0 | 1 | 2 | 3) => string): string => {
  for (const level of [0, 1, 2] as const) {
    const text = build(level)
    if (text.length <= ANSWER_MAX) return text
  }
  return build(3)
}

/** "A, B and 3 more" with at most two names, or the count alone at the most summarised level. */
const group = (lang: Lang, level: number, names: ReadonlyArray<string>, key: "announcing" | "alsoShown", extra?: string): string => {
  const keys = key === "announcing" ? ["announcing", "announcingMore", "announcingCount"] as const : ["alsoShown", "alsoShownMore", "alsoShownCount"] as const
  const max = level === 0 ? NAME_MAX : 16
  if (level >= 2) return say(texts, lang, keys[2], { count: names.length })
  const shown = names.slice(0, 2).map((n) => cutName(n, max))
  if (names.length <= 2) return say(texts, lang, keys[0], { devices: list(lang, shown) })
  return say(texts, lang, keys[1], { devices: shown.join(", "), count: names.length - 2 })
}

const breakdown = (lang: Lang, skipped: ReadonlyArray<Delivery>): string => {
  const counts = WHYS.map((w) => [w, skipped.filter((d) => (d.why ?? "failed") === w).length] as const).filter(([, n]) => n > 0)
  return list(lang, counts.map(([w, n]) => `${n} ${reasonText(lang, w)}`), 6)
}

/** The skipped devices: two named with their reason, the rest as a count with the reasons; `level` 3 drops the reasons. */
const skippedGroup = (lang: Lang, level: number, skipped: ReadonlyArray<Delivery>, nameOf: (id: string) => string, none: boolean): string => {
  const head = none ? ["nothing", "nothingMore", "nothingCount"] as const : ["notOn", "notOnMore", "notOnCount"] as const
  const max = level === 0 ? NAME_MAX : 16
  if (level >= 2) return say(texts, lang, head[2], { count: skipped.length, reasons: level === 3 ? "" : breakdown(lang, skipped) }).replace(" ()", "")
  const named = skipped.slice(0, 2).map((d) => `${cutName(nameOf(d.deviceId), max)} (${reasonText(lang, d.why ?? "failed")})`)
  if (skipped.length <= 2) return say(texts, lang, head[0], { devices: list(lang, named) })
  return say(texts, lang, head[1], { devices: named.join(", "), count: skipped.length - 2, reasons: breakdown(lang, skipped.slice(2)) })
}

/** The rooms to choose from, named as far as the answer's bound allows. */
const roomChoice = (lang: Lang, key: "noRoom" | "whichRoom", spoken: string, rooms: ReadonlyArray<string>): string => {
  for (const [count, max] of [[8, 40], [8, 16], [4, 16], [2, 12]] as const) {
    const shown = rooms.slice(0, count).map((r) => cutName(r, max))
    const names = rooms.length > count ? `${shown.join(", ")} ${say(texts, lang, "andMore", { count: rooms.length - count })}` : list(lang, shown, 8)
    const text = say(texts, lang, key, { room: cutName(spoken, 20), rooms: names })
    if (text.length <= ANSWER_MAX) return text
  }
  return say(texts, lang, key, { room: cutName(spoken, 20), rooms: say(texts, lang, "roomCount", { count: rooms.length }) })
}

/** Words that open a destination: a phrase command only ever means the whole house, and never carries one of these. */
const DIRECTED = /^(?:in|to|for|at|naar|voor|bij|op)\s/i

/**
 * One broadcast, for a tool and for the action. What was queued and what was not is read from the handles' deliveries,
 * never assumed; the announcement is not waited for (a tool inside a turn may not: its reply is what it waits for).
 * One at a time (`gate`, the module's shared semaphore), so a newer broadcast's sound and card never end up before an
 * older one's.
 */
const broadcast = (
  ctx: Pick<ModuleServicesV2, "host" | "speech" | "present" | "notify">,
  gate: Semaphore.Semaphore,
  showCard: boolean,
  input: { readonly message?: string; readonly room?: string; readonly wholeHouse?: boolean }
): Effect.Effect<Outcome> =>
  Effect.gen(function*() {
    const lang = homeLanguage(ctx.host.view())
    const origin = yield* originDevice
    const chime = input.message === undefined
    // A chime is a cue with no text (the speech service plays the chime alone).
    const message = chime ? "" : input.message.trim()
    if (!chime && message === "") return { kind: "asked", text: say(texts, lang, "noMessage") } as const
    // A tool's schema has checked this already; an action's words have not been (one line, at most the bound).
    if (!isLine(message, MESSAGE_MAX)) return { kind: "asked", text: say(texts, lang, "badMessage", { max: MESSAGE_MAX }) } as const
    // Said for the whole house (a phrase command): words that open a destination are not a message for everyone.
    if (input.wholeHouse === true && !chime && DIRECTED.test(message)) return { kind: "asked", text: say(texts, lang, "directed") } as const
    // Who asked is who is left out and who is named as the sender: without one, nobody can be left out.
    if (origin === undefined) return { kind: "failed", text: say(texts, lang, "noOrigin") } as const
    return yield* gate.withPermits(1)(deliver(ctx, showCard, lang, origin, chime, message, input.room))
  })

const deliver = (
  ctx: Pick<ModuleServicesV2, "host" | "speech" | "present" | "notify">,
  showCard: boolean,
  lang: Lang,
  origin: string,
  chime: boolean,
  message: string,
  room: string | undefined
): Effect.Effect<Outcome> =>
  Effect.gen(function*() {
    const known = ctx.host.service(Devices)
    if (known === undefined) return { kind: "failed", text: say(texts, lang, "noDevices") } as const
    // Every device is read now and decided again at every call: nothing of the house is kept between broadcasts.
    const all = known.list()
    const spokenRoom = room !== undefined && room.trim() !== "" && !meansEveryone(room) ? room.trim() : undefined
    let roomLabel: string | undefined
    let targets: ReadonlyArray<KnownDevice>
    if (spokenRoom === undefined) {
      targets = all.filter((d) => d.id !== origin)
      if (targets.length === 0) return { kind: "said", text: say(texts, lang, "alone") } as const
    } else {
      const match = matchRoom(all, spokenRoom)
      if (match.kind === "several") return { kind: "asked", text: roomChoice(lang, "whichRoom", spokenRoom, match.rooms) } as const
      if (match.kind === "none") {
        return { kind: "asked", text: match.rooms.length === 0 ? say(texts, lang, "noRooms", { room: cutName(spokenRoom, 20) }) : roomChoice(lang, "noRoom", spokenRoom, match.rooms) } as const
      }
      roomLabel = match.label
      targets = all.filter((d) => d.room !== undefined && d.id !== origin && roomKey(d.room) === match.key)
      if (targets.length === 0) return { kind: "said", text: say(texts, lang, "aloneInRoom", { room: cutName(match.label) }) } as const
    }
    const ordered = [...targets].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const nameOf = (id: string): string => all.find((d) => d.id === id)?.name ?? id

    // The announcement. A room: one call per spelling of its name, `{ room, except: origin }`, so the speech service
    // leaves the origin out and says what it decided for each device. The whole house has no such target, so it is one
    // call per device (at most 64), the origin never among them. `ctx.speech` decides each device now.
    const deliveries: Array<Delivery> = []
    const calls: Array<{ readonly target: SpeechTarget; readonly devices: ReadonlyArray<KnownDevice> }> = []
    let beyond = 0
    if (spokenRoom === undefined) {
      beyond = Math.max(0, ordered.length - MAX_TARGETS)
      for (const d of ordered.slice(0, MAX_TARGETS)) calls.push({ target: { device: d.id }, devices: [d] })
    } else {
      const bySpelling = new Map<string, Array<KnownDevice>>()
      for (const d of ordered) bySpelling.set(d.room!.trim().toLowerCase(), [...(bySpelling.get(d.room!.trim().toLowerCase()) ?? []), d])
      for (const devices of bySpelling.values()) calls.push({ target: { room: devices[0]!.room!, except: origin }, devices })
    }
    for (const call of calls) {
      const result: ReadonlyArray<Delivery> | "unavailable" = yield* ctx.speech.say(call.target, message, { cue: true }).pipe(
        Effect.map((handle): ReadonlyArray<Delivery> | "unavailable" => handle.deliveries),
        Effect.catchTag("SpeechError", (e): Effect.Effect<ReadonlyArray<Delivery> | "unavailable"> =>
          Effect.succeed(e.reason === "unavailable" ? "unavailable" : call.devices.map((d) => ({ deviceId: d.id, queued: false, why: "failed" })))
        )
      )
      if (result === "unavailable") return { kind: "failed", text: say(texts, lang, "unavailable") } as const
      deliveries.push(...result)
    }
    const queued = deliveries.filter((d) => d.queued)
    const skipped = deliveries.filter((d) => !d.queued)

    // The card goes to screens where the message is queued, and to screens that cannot speak it; never to a device
    // that is not connected, nor where do not disturb held the announcement back. The cap is counted before it cuts.
    const eligible = showCard && !chime
      ? deliveries.filter((d) => (d.queued || d.why === "cannot-speak" || d.why === "busy") && known.get(d.deviceId) !== undefined && hasScreen(known.get(d.deviceId)!)).map((d) => d.deviceId)
      : []
    const cardDevices = eligible.slice(0, MAX_CARDS)
    const capped = eligible.length - cardDevices.length
    const shownOn: Array<string> = []
    let cardsRefused = 0
    let cardsDnd = 0
    if (cardDevices.length > 0) {
      const from = known.get(origin)?.name
      const card: Presentation = {
        kind: "card",
        title: roomLabel === undefined ? say(texts, lang, "cardTitle") : say(texts, lang, "cardTitleRoom", { room: cutName(roomLabel) }),
        text: message,
        ...(from !== undefined ? { facts: [{ label: say(texts, lang, "cardFrom"), value: cutName(from) }] } : {}),
        spoken: message
      }
      for (const id of cardDevices) {
        // Do not disturb is read again right before each card: no card is started while it is on (unknown counts as on).
        const dnd = yield* ctx.notify.dnd.get.pipe(Effect.map((d) => d.on), Effect.orElseSucceed(() => true))
        if (dnd) {
          cardsDnd++
          continue
        }
        const outcome = yield* ctx.present.show({ device: id }, card, { lifetime: "transient", key: cardKey(id) }).pipe(
          Effect.map((handle) => handle.outcome.devices.some((s) => s.deviceId === id && s.shown)),
          Effect.catchTag("PresentError", () => Effect.succeed(false))
        )
        if (outcome) shownOn.push(id)
        else cardsRefused++
      }
    }

    const allDnd = queued.length === 0 && skipped.every((d) => d.why === "dnd")
    const body = firstThatFits(lang, (level) => {
      const parts: Array<string> = []
      if (queued.length > 0) {
        parts.push(group(lang, level, queued.map((d) => nameOf(d.deviceId)), "announcing"))
        if (skipped.length > 0) parts.push(skippedGroup(lang, level, skipped, nameOf, false))
      } else if (allDnd) {
        parts.push(say(texts, lang, "nothingDnd"))
      } else {
        parts.push(skippedGroup(lang, level, skipped, nameOf, true))
      }
      if (shownOn.length > 0) parts.push(group(lang, level, shownOn.map(nameOf), "alsoShown"))
      if (cardsRefused > 0) parts.push(shownOn.length === 0 && cardsRefused === cardDevices.length - cardsDnd ? say(texts, lang, "cardsFailed") : say(texts, lang, "cardsSome", { count: cardsRefused }))
      if (cardsDnd > 0) parts.push(say(texts, lang, "cardsDnd", { count: cardsDnd }))
      if (capped > 0) parts.push(say(texts, lang, "cardsCapped", { count: capped, max: MAX_CARDS }))
      if (beyond > 0) parts.push(say(texts, lang, "cut", { count: beyond }))
      return parts.join(" ")
    })
    return { kind: "said", text: body } as const
  })

const actionResult = (outcome: Effect.Effect<Outcome>) =>
  Effect.flatMap(outcome, (o) => (o.kind === "failed" ? Effect.fail(new ActionError({ message: o.text })) : Effect.succeed({ say: o.text })))

const toolResult = (outcome: Outcome) =>
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
  // One broadcast at a time, for tools and actions alike: one semaphore of the module's shared part.
  shared: () => Effect.sync(() => ({ value: { gate: Semaphore.makeUnsafe(1) } })),
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
            broadcast(ctx, ctx.shared.gate, showCard(), { message, ...(room !== undefined ? { room } : {}) }).pipe(Effect.flatMap((o) => toolResult(o)))
        }),
        makeTool({
          name: "broadcast_chime",
          description:
            "Ring the announcement chime on every other device in the house or only in one room. It is the chime alone, with no words. Never on the device that asked.",
          parameters: Schema.Struct({ room: Schema.optionalKey(RoomName) }),
          risk: "change",
          latency: "quick",
          execute: ({ room }) => broadcast(ctx, ctx.shared.gate, showCard(), { ...(room !== undefined ? { room } : {}) }).pipe(Effect.flatMap((o) => toolResult(o)))
        })
      ],
      actions: [
        defineAction({
          id: "send",
          label: "Announce a message to everyone in the house",
          description: "Announce what was said on every other device in the house, with a chime. Only when the words say everyone; for one room the assistant calls broadcast_send with the room.",
          examples: [
            "tell everyone dinner is ready",
            "announce to everyone that the film starts",
            "zeg tegen iedereen dat het eten klaar is",
            "omroepen voor iedereen het eten is klaar"
          ],
          params: { message: Param.text({ label: "Message", after: ["everyone", "iedereen"], maxWords: 8 }) },
          // Words and slots, no language model, and only for the whole house, where the words say so. An utterance that
          // names a room, or any other destination ("announce in the study that …"), is no phrase of it: it goes to the
          // assistant, whose tool call names the room. A message is at most eight words here.
          phrases: {
            en: ["tell everyone {message}", "tell everyone that {message}", "announce to everyone {message}", "announce to everyone that {message}"],
            nl: ["zeg tegen iedereen {message}", "zeg tegen iedereen dat {message}", "omroepen voor iedereen {message}", "omroepen voor iedereen dat {message}"]
          },
          risk: "change",
          offerAsTool: false,
          run: ({ message }) => actionResult(broadcast(ctx, ctx.shared.gate, showCard(), { message, wholeHouse: true }))
        }),
        defineAction({
          id: "chime",
          label: "Ring the chime for everyone in the house",
          description: "Play the announcement chime alone on every other device in the house. For one room the assistant calls broadcast_chime with the room.",
          examples: ["ring the bell for everyone", "sound the chime for everyone", "bel de gong voor iedereen"],
          params: {},
          phrases: {
            en: ["ring the bell for everyone", "sound the chime for everyone"],
            nl: ["bel de gong voor iedereen", "luid de bel voor iedereen"]
          },
          risk: "change",
          offerAsTool: false,
          run: () => actionResult(broadcast(ctx, ctx.shared.gate, showCard(), { wholeHouse: true }))
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
