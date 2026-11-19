import {
  ActionError, CurrentJob, CurrentTurn, defineAction, defineModule, makeTool, type ModuleDefinition, Param, type PresentHandle,
  type Presentation, Privacy, type Row, type ScheduleOrigin, Setting, ToolError, type TurnContext
} from "@pva/core"
import {
  describeRRule, type Language, nextOccurrence, parseDateTime, parseDtstart, parseRecurrence, speakDuration, speakList, speakNumber, speakTime
} from "@pva/language"
import { BriefingSectionError, BriefingSections, homeLanguage, say } from "@pva/module-contracts"
import { Clock, Effect, Exit, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import {
  cut, endOfToday, homeZone, Line, localOf, looksLikeCode, matching, momentText, PAGE, Reminder, reminders, SCAN_ROWS, scanRows, shortMoment, TEXT_CHARS, WHEN_CHARS,
  without
} from "./model.ts"
import { texts } from "./texts.ts"

export { Reminder, reminders, SCAN_ROWS, texts }

const DAY = 86_400_000
/** A repeating reminder's occurrence found later than this is not delivered (the moment has passed); the series goes on. */
export const REPEAT_DELIVER_WITHIN_MS = 6 * 3_600_000
/** A reminder found more than this late says so. */
const LATE_NOTE_MS = 2 * 60_000
/** How far ahead a reminder may be set. */
const MAX_AHEAD_MS = 366 * DAY
const RING_EXPIRES_MS = 30 * 60_000
const NORMAL_EXPIRES_MS = DAY
const CARD_MS = 5 * 60_000
/** A delivery that failed on a repeating reminder is tried again this long after. */
const RETRY_MS = 30_000
const LIST_MS = 2 * 60_000

const settings = {
  snoozeMinutes: Setting.number({ label: "Snooze for", description: "Minutes a reminder is put off when someone says snooze.", default: 10, integer: true, min: 1, max: 240, unit: "minutes" }),
  priority: Setting.choice({
    label: "How a reminder arrives",
    description: "A reminder the person asked for at a moment rings on the device it was set on until it is answered; do not disturb keeps it silent. Or only a silent card.",
    default: "ring",
    options: [{ value: "ring", label: "Rings until answered" }, { value: "normal", label: "A silent card" }]
  }),
  keepDays: Setting.number({ label: "Keep finished reminders", description: "Days a finished or cancelled reminder is kept before it is removed.", default: 7, integer: true, min: 1, max: 90, unit: "days" })
}

// ---- what was said ---------------------------------------------------------------------------------------------------

type When =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "repeat"; readonly at: number; readonly rrule: string; readonly dtstart: string; readonly timeZone: string; readonly rule: string | undefined }
  | { readonly kind: "ask"; readonly key: "when" | "whenAmbiguous" | "atTime" | "past" | "tooFar" }

/** A phrase of time: a repeat, or one moment. Never guessed: what is not clear becomes a question. */
export const parseWhen = (text: string, language: Language, zone: string, now: number): When => {
  const rec = parseRecurrence(text, language, { now, timeZone: zone })
  if (rec.kind === "ok") {
    const r = rec.value
    if (r.rrule.length > 100 || r.dtstart.length > 70 || r.timeZone.length > 64) return { kind: "ask", key: "when" }
    return { kind: "repeat", at: r.startInstant, rrule: r.rrule, dtstart: r.dtstart, timeZone: r.timeZone, rule: describeRRule(r.rrule, language, { time: r.start, start: r.start, timeZone: r.timeZone }) }
  }
  if (rec.kind === "ambiguous") return { kind: "ask", key: "whenAmbiguous" }
  const dt = parseDateTime(text, language, { now, timeZone: zone })
  if (dt.kind === "ambiguous") return { kind: "ask", key: "whenAmbiguous" }
  if (dt.kind !== "ok") return { kind: "ask", key: "when" }
  const v = dt.value
  if (v.instant === undefined) return { kind: "ask", key: "atTime" }
  if (v.inPast || v.instant <= now) return { kind: "ask", key: "past" }
  if (v.instant > now + MAX_AHEAD_MS) return { kind: "ask", key: "tooFar" }
  return { kind: "once", at: v.instant }
}

/** A stored repeat in words ("every Monday at seven"), or what it can be said as. */
const ruleText = (rem: Reminder, language: Language): string => {
  if (rem.rrule === undefined || rem.dtstart === undefined) return say(texts, language, "repeating")
  const start = parseDtstart(rem.dtstart)
  if (start === undefined) return say(texts, language, "repeating")
  return describeRRule(rem.rrule, language, { time: start.start, start: start.start, timeZone: start.timeZone }) ?? say(texts, language, "repeating")
}

const nextOf = (rem: Reminder, after: number): number | undefined =>
  rem.rrule === undefined || rem.dtstart === undefined || rem.timeZone === undefined ? undefined : nextOccurrence({ rrule: rem.rrule, dtstart: rem.dtstart, timeZone: rem.timeZone }, after)

/** The moment a reminder is next going to speak: its snooze or its time. */
const upcoming = (rem: Reminder): number => (rem.snoozeAt !== undefined ? (rem.rrule !== undefined ? Math.min(rem.dueAt, rem.snoozeAt) : rem.snoozeAt) : rem.dueAt)
/** Delivered and still waiting for an answer: a one-off whose moment was delivered. */
const isOverdue = (rem: Reminder): boolean => rem.rrule === undefined && rem.notifiedFor === rem.dueAt && rem.snoozeAt === undefined

const originOf = (rem: Reminder): ScheduleOrigin => ({
  ...(rem.assistantId !== undefined ? { assistantId: rem.assistantId } : {}),
  ...(rem.deviceId !== undefined ? { deviceId: rem.deviceId } : {})
})

type Kind = "done" | "snooze"

export const remindersModule = defineModule({
  apiVersion: 2,
  id: "reminders",
  name: "Reminders",
  description: "Reminders at a time or repeating, for the household or for one person.",
  enabledByDefault: false,
  settings,
  storage: { version: 1, collections: [reminders] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const board = ctx.store.collection(reminders)
      /** Every change of a reminder goes one at a time: a tool, a job and a press never read and write over each other. */
      const lock = Semaphore.makeUnsafe(1)
      const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect)
      /** The cards of due reminders this part is showing, so one is taken down when the reminder is answered or changes. */
      const cards = new Map<string, PresentHandle>()
      const lang = () => homeLanguage(ctx.host.view())
      const zone = () => homeZone(ctx.host.view().home)
      const snoozeMs = () => {
        const m = ctx.settingsFor(undefined)?.snoozeMinutes
        return (typeof m === "number" ? m : 10) * 60_000
      }

      const prepareDue = (id: string, rem: Reminder, at: number) =>
        ctx.scheduler.prepare({ handler: "due", key: `due:${id}`, payload: { id, at }, at, late: "run", origin: originOf(rem) })

      const dismissCard = (id: string) =>
        Effect.gen(function*() {
          const handle = cards.get(id)
          cards.delete(id)
          if (handle !== undefined) yield* Effect.ignore(handle.dismiss)
        })
      const endNotification = (id: string) => Effect.ignore(ctx.notify.resolve({ key: `rem:${id}` }))
      const dropJobs = (id: string, keys: ReadonlyArray<string>) =>
        Effect.forEach(keys, (key) => Effect.ignore(ctx.scheduler.cancel({ key: `${key}:${id}` })), { discard: true })

      /** The card of a due reminder, on the device it was set on: its own presentation, with the same two answers. */
      const showCard = (id: string, rem: Reminder, at: number) =>
        Effect.gen(function*() {
          if (rem.deviceId === undefined) return
          const l = lang()
          const owner = rem.owner
          const present: Presentation = {
            kind: "card",
            title: say(texts, l, "notificationTitle"),
            text: rem.text,
            facts: [
              { label: say(texts, l, "cardDue"), value: shortMoment(at, l, zone()) },
              ...(rem.rrule !== undefined ? [{ label: say(texts, l, "cardRepeats"), value: cut(ruleText(rem, l), 60) }] : []),
              { label: say(texts, l, "cardFor"), value: say(texts, l, owner === undefined ? "forHousehold" : "forYou") }
            ],
            spoken: say(texts, l, owner === undefined ? "spokenCard" : "spokenCardPrivate", { text: cut(rem.text, 200) }),
            buttons: [{ id: "done", label: say(texts, l, "labelDone") }, { id: "snooze", label: say(texts, l, "labelSnooze") }],
            handler: "reminders",
            ...(owner !== undefined ? { sensitivity: { personal: owner } } : {})
          }
          yield* dismissCard(id)
          const handle = yield* ctx.present.show({ device: rem.deviceId }, present, { lifetime: "transient", expiresInMs: CARD_MS, key: `due:${id}` })
          cards.set(id, handle)
        }).pipe(Effect.ignore)

      /** The ring or the card on the device the reminder was set on. Priority: `ring` by default, because the person asked for this moment. */
      const deliver = (id: string, rem: Reminder, at: number, lateMs: number) =>
        Effect.gen(function*() {
          const l = lang()
          const now = yield* Clock.currentTimeMillis
          const priority = ctx.settingsFor(undefined)?.priority === "normal" ? "normal" : "ring"
          const late = lateMs > LATE_NOTE_MS ? ` (${say(texts, l, "late", { when: momentText(at, l, zone(), now) })})` : ""
          const request = {
            title: say(texts, l, "notificationTitle"),
            text: cut(`${rem.text}${late}`, 200),
            priority,
            key: `rem:${id}`,
            expiresInMs: priority === "ring" ? RING_EXPIRES_MS : NORMAL_EXPIRES_MS,
            actions: [{ id: "done", label: say(texts, l, "labelDone") }, { id: "snooze", label: say(texts, l, "labelSnooze") }],
            handler: "reminders",
            ...(rem.owner !== undefined ? { owner: rem.owner } : {})
          } as const
          // On the device it was set on; a device that is gone (or none known) means everywhere, never nowhere.
          yield* ctx.notify.send({ ...request, target: rem.deviceId !== undefined ? "origin" : "everywhere" }).pipe(
            Effect.catchTag("NotifyError", (e) => (e.reason === "invalid" && rem.deviceId !== undefined ? ctx.notify.send({ ...request, target: "everywhere" }) : Effect.fail(e)))
          )
          yield* showCard(id, rem, at)
        })

      const actorOf = Effect.gen(function*() {
        const job = yield* CurrentJob
        return job === undefined ? undefined : ({ kind: "job", jobId: job.jobId } as const)
      })

      // ---- jobs ----------------------------------------------------------------------------------------------------

      // One job for the next occurrence of each open reminder, planned again by its handler. It runs however late
      // (`late: "run"`), because the series must go on; it decides inside whether the moment is still worth a ring.
      // Planning the next occurrence replaces this very job (one live job per key), so a retry of this run would never
      // come: a delivery that fails on a repeat is retried by a snooze-style job of its own, and the series goes on.
      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(60)), at: Schema.Int }),
        // Running it again for the same occurrence delivers under the same key (it dedupes) and plans the same next job.
        idempotent: true,
        retries: 5,
        run: ({ id, at }, due) =>
          exclusive(Effect.gen(function*() {
            const actor = yield* actorOf
            const row = yield* board.get(id)
            const rem = row?.value
            // Called off, finished or moved while this job waited: nothing to deliver, nothing to plan.
            if (row === undefined || rem === undefined || rem.state !== "open" || rem.dueAt !== at) return
            const now = yield* Clock.currentTimeMillis
            const write = { ...(actor !== undefined ? { actor } : {}) }
            const next = rem.rrule !== undefined ? nextOf(rem, Math.max(now, due.dueAt)) : undefined
            const worthIt = rem.rrule === undefined || due.lateMs <= REPEAT_DELIVER_WITHIN_MS
            if (next === undefined) {
              // A one-off, or the last occurrence of a series: deliver (a failure fails the run, and it is retried), then note it.
              yield* deliver(id, rem, at, due.lateMs)
              yield* board.update(id, (v) => (v.rrule !== undefined ? { ...without(v, "snoozeAt"), state: "lapsed" as const, endedAt: now } : { ...v, notifiedFor: at }), write)
              return
            }
            const delivered = worthIt ? yield* Effect.exit(deliver(id, rem, at, due.lateMs)) : undefined
            // The next occurrence after now, in one step with this one's retry when its delivery failed.
            const job = yield* prepareDue(id, rem, next)
            const retryAt = now + RETRY_MS
            const retry = delivered !== undefined && Exit.isFailure(delivered)
              ? yield* ctx.scheduler.prepare({ handler: "snooze", key: `snooze:${id}`, payload: { id, at: retryAt }, at: retryAt, late: "run", origin: originOf(rem) })
              : undefined
            yield* ctx.store.transaction((tx) => {
              tx.collection(reminders).update(id, (v) => ({ ...v, dueAt: next, ...(retry !== undefined ? { snoozeAt: retryAt } : {}) }), { expectRev: row.rev, ...write })
              job.writeIn(tx)
              if (retry !== undefined) retry.writeIn(tx)
            })
          })).pipe(Effect.orDie)
      }).pipe(Effect.orDie)

      yield* ctx.scheduler.handle("snooze", {
        payload: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(60)), at: Schema.Int }),
        idempotent: true,
        retries: 5,
        run: ({ id, at }, due) =>
          exclusive(Effect.gen(function*() {
            const actor = yield* actorOf
            const row = yield* board.get(id)
            if (row === undefined || row.value.state !== "open" || row.value.snoozeAt !== at) return
            yield* deliver(id, row.value, at, due.lateMs)
            yield* board.update(id, (v) => (v.snoozeAt === at ? without(v, "snoozeAt") : v), actor !== undefined ? { actor } : {})
          })).pipe(Effect.orDie)
      }).pipe(Effect.orDie)

      // The daily clean-up (04:00): reminders delivered a week ago and never answered lapse, and finished ones older
      // than the setting are removed, oldest first in bounded batches with a yield between them.
      yield* ctx.scheduler.handle("tidy", {
        payload: Schema.Struct({}),
        idempotent: true,
        run: () =>
          Effect.gen(function*() {
            const actor = yield* actorOf
            if (actor === undefined) return yield* Effect.die(new Error("tidy runs only as a job"))
            const keepDays = ctx.settingsFor(undefined)?.keepDays
            const now = yield* Clock.currentTimeMillis
            const removeBefore = now - (typeof keepDays === "number" ? keepDays : 7) * DAY
            const lapseBefore = now - 7 * DAY
            for (let batch = 0; batch < 50; batch++) {
              const stale = yield* exclusive(Effect.gen(function*() {
                const page = yield* board.list({ where: { state: "open" }, orderBy: { field: "dueAt", direction: "asc" }, limit: PAGE })
                const lapse = page.filter((r) => isOverdue(r.value) && r.value.dueAt < lapseBefore)
                yield* ctx.store.transaction((tx) => {
                  for (const r of lapse) tx.collection(reminders).update(r.id, (v) => ({ ...v, state: "lapsed" as const, endedAt: now }), { expectRev: r.rev, actor })
                })
                // Every row of the page lapsed: the next page may have more old ones.
                return page.length === PAGE && lapse.length === page.length
              }))
              if (!stale) break
              yield* Effect.yieldNow
            }
            for (const state of ["done", "cancelled", "lapsed"] as const) {
              for (let batch = 0; batch < 50; batch++) {
                const more = yield* exclusive(Effect.gen(function*() {
                  const page = yield* board.list({ where: { state }, orderBy: { field: "endedAt", direction: "asc" }, limit: PAGE })
                  const old = page.filter((r) => (r.value.endedAt ?? 0) < removeBefore)
                  yield* ctx.store.transaction((tx) => {
                    for (const r of old) tx.collection(reminders).remove(r.id, { actor })
                  })
                  return page.length === PAGE && old.length === page.length
                }))
                if (!more) break
                yield* Effect.yieldNow
              }
            }
          }).pipe(Effect.orDie)
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "tidy", key: "tidy", cron: "0 4 * * *" }).pipe(Effect.orDie)

      // ---- reading -------------------------------------------------------------------------------------------------

      /**
       * The open reminders the asking device may be told of now, soonest first: the household's, and the asking person's own
       * where `Privacy.mayReveal` says so at this moment. Another person's are not looked at (nor counted); the asking
       * person's own that cannot be revealed here are only counted (`withheld`). Says when the read was cut short.
       */
      const readVisible = (turn: TurnContext | undefined) =>
        Effect.gen(function*() {
          const privacy = ctx.host.service(Privacy)
          const person = turn?.person?.id
          const scan = yield* scanRows<Reminder, unknown>((p) => board.list({ where: { state: "open" }, orderBy: { field: "dueAt", direction: "asc" }, ...p }))
          const rows: Array<Row<Reminder>> = []
          let withheld = 0
          for (const row of scan.rows) {
            const owner = row.value.owner
            if (owner === undefined) rows.push(row)
            else if (owner === person) {
              if (privacy?.mayReveal(owner, turn) === true) rows.push(row)
              else withheld++
            }
          }
          return { rows, withheld, cut: scan.cut, person }
        })

      /** Which reminder is meant by its words: exactly one match, else a sentence that asks or says there is none. */
      const pick = (which: string, turn: TurnContext | undefined, l: Language) =>
        Effect.gen(function*() {
          const seen = yield* readVisible(turn)
          const found = matching(seen.rows, which)
          if (found.length === 1) return { row: found[0]! }
          if (found.length === 0) {
            if (seen.cut) return { spoken: say(texts, l, "cutNone", { count: SCAN_ROWS }) }
            return { spoken: `${say(texts, l, "noMatch", { which: cut(which, 60) })}${seen.withheld > 0 ? ` ${say(texts, l, "unreadableHere")}` : ""}` }
          }
          return { spoken: say(texts, l, "ask", { list: speakList(found.slice(0, 4).map((r) => cut(r.value.text, 50)), l, { max: 4 }) ?? "" }) }
        })

      /** The reminder that rang on this device: the one open ring of this module there that may be told here. */
      const ringing = (turn: TurnContext | undefined, l: Language) =>
        Effect.gen(function*() {
          const privacy = ctx.host.service(Privacy)
          const open = yield* ctx.notify.list()
          const here = open.filter((n) => n.key?.startsWith("rem:") === true && (n.deviceId === undefined || n.deviceId === turn?.deviceId) && (n.owner === undefined || privacy?.mayReveal(n.owner, turn) === true))
          if (here.length === 0) return { spoken: say(texts, l, "nothingRang") }
          if (here.length > 1) return { spoken: say(texts, l, "askRang") }
          return { id: here[0]!.key!.slice(4) }
        })

      // ---- answering: done, snooze, cancel -------------------------------------------------------------------------

      /**
       * Done, or snooze, for one reminder, as a tool, a typed action, a notification button or a card's button. Idempotent:
       * a reminder is done once, however many press; a snooze of the same press is not pushed further. The row is read
       * again here, after any wait, and its state decides.
       */
      const answer = (kind: Kind, id: string, by: { readonly pressId?: string; readonly ms?: number; readonly deviceId?: string; readonly endNotification: boolean }) =>
        exclusive(Effect.gen(function*() {
          const l = lang()
          const row = yield* board.get(id)
          if (row === undefined) return say(texts, l, "gone")
          const rem = row.value
          const now = yield* Clock.currentTimeMillis
          const finish = Effect.andThen(dismissCard(id), by.endNotification ? endNotification(id) : Effect.void)
          if (kind === "done") {
            // Already finished (done twice, or cancelled meanwhile): said, and nothing is written again.
            if (rem.state !== "open") return say(texts, l, "doneAgain")
            const repeating = rem.rrule !== undefined && nextOf(rem, now) !== undefined
            yield* board.update(id, (v) => (repeating ? without(v, "snoozeAt", "handled") : { ...without(v, "snoozeAt"), state: "done" as const, endedAt: now }), { expectRev: row.rev })
            yield* dropJobs(id, repeating ? ["snooze"] : ["due", "snooze"])
            yield* finish
            const next = repeating ? nextOf(rem, now) : undefined
            return next !== undefined ? say(texts, l, "doneRepeat", { when: momentText(next, l, zone(), now) }) : say(texts, l, "done")
          }
          if (rem.state !== "open") return say(texts, l, "snoozeEnded")
          const ms = by.ms ?? snoozeMs()
          const said = speakDuration(ms, l, { natural: true }) ?? `${Math.round(ms / 60_000)}`
          // The same press again: it has been put off already, and is not put off further.
          if (by.pressId !== undefined && rem.handled === by.pressId && rem.snoozeAt !== undefined) return say(texts, l, "snoozedAlready")
          const at = now + ms
          const job = yield* ctx.scheduler.prepare({
            handler: "snooze", key: `snooze:${id}`, payload: { id, at }, at, late: "run",
            origin: { ...originOf(rem), ...(by.deviceId !== undefined ? { deviceId: by.deviceId } : {}) }
          })
          yield* ctx.store.transaction((tx) => {
            tx.collection(reminders).update(id, (v) => ({ ...v, snoozeAt: at, ...(by.pressId !== undefined ? { handled: by.pressId } : {}) }), { expectRev: row.rev })
            job.writeIn(tx)
          })
          yield* finish
          return say(texts, l, "snoozed", { duration: said })
        })).pipe(Effect.mapError(() => new Error("not saved")))

      const settle = (kind: Kind, id: string, by: Parameters<typeof answer>[2]) =>
        answer(kind, id, by).pipe(Effect.catch(() => Effect.succeed(say(texts, lang(), "cantNow"))))

      // A button on a due reminder's notification, and on its card: the same two answers, registered in `shared`.
      yield* ctx.notify.handle("reminders", {
        run: (press) =>
          press.key?.startsWith("rem:") !== true
            ? Effect.succeed({ say: say(texts, lang(), "gone") })
            : answer(press.actionId === "snooze" ? "snooze" : "done", press.key.slice(4), { pressId: press.notificationId, deviceId: press.deviceId, endNotification: false }).pipe(
              Effect.map((text) => ({ say: text })),
              Effect.catch(() => Effect.succeed({ say: say(texts, lang(), "cantNow"), keepOpen: true }))
            )
      }).pipe(Effect.orDie)
      yield* ctx.present.handle("reminders", {
        run: (press) =>
          press.key?.startsWith("due:") !== true
            ? Effect.succeed({ say: say(texts, lang(), "gone") })
            : settle(press.action === "snooze" ? "snooze" : "done", press.key.slice(4), { pressId: press.presentationId, deviceId: press.deviceId, endNotification: true }).pipe(Effect.map((text) => ({ say: text })))
      }).pipe(Effect.orDie)

      // ---- the briefing's section ----------------------------------------------------------------------------------

      /**
       * What is coming today, for the asking person: the household's reminders and their own where the privacy rule allows it
       * on the asking device now; their own that it does not allow are only counted. Read from the store, bounded.
       */
      const section = {
        id: "reminders",
        title: "Reminders",
        gather: (request: { readonly turn: TurnContext; readonly language: Language; readonly maxSentences: number; readonly now: number }) =>
          Effect.gen(function*() {
            const l = request.language
            const z = zone()
            const end = endOfToday(request.now, z)
            const seen = yield* readVisible(request.turn)
            const today = seen.rows.filter((r) => upcoming(r.value) >= request.now && upcoming(r.value) < end).sort((a, b) => upcoming(a.value) - upcoming(b.value))
            const personalToday = seen.withheld
            if (today.length === 0 && personalToday === 0) return { _tag: "empty" } as const
            const owner = today.some((r) => r.value.owner !== undefined) ? seen.person : undefined
            if (today.length === 0) return { _tag: "section", sentences: [], priority: "normal", withheld: personalToday } as const
            const items = today.map((r) => {
              const at = localOf(upcoming(r.value), z)
              return say(texts, l, "briefAt", { text: cut(r.value.text, 60), time: speakTime(at, l) ?? `${at.hour}:${String(at.minute).padStart(2, "0")}` })
            })
            const list = speakList(items, l, { max: 3 }) ?? items[0]!
            const count = today.length
            const sentences = [cut(count === 1 ? say(texts, l, "briefOne", { list }) : say(texts, l, "briefMany", { count: speakNumber(count, l, { words: true }) ?? String(count), list }), 300)]
            if (seen.cut && request.maxSentences > 1) sentences.push(say(texts, l, "briefMore"))
            return { _tag: "section", sentences: sentences.slice(0, request.maxSentences), priority: "normal", withheld: personalToday, ...(owner !== undefined ? { owner } : {}) } as const
          }).pipe(Effect.mapError(() => new BriefingSectionError({ reason: "failed", detail: "the reminders could not be read" })))
      }

      return {
        value: { board, exclusive, lang, zone, prepareDue, readVisible, pick, ringing, answer, settle, dismissCard, endNotification, dropJobs, snoozeMs },
        contributions: [BriefingSections.of(section)]
      }
    }),
  start: (ctx) => {
    const sh = ctx.shared
    const failed = (l: Language, key: "unsaved" | "unread" = "unsaved") => new ToolError({ message: say(texts, l, key) })
    const personalQuiet = (owner: string | undefined, turn: TurnContext | undefined) => owner !== undefined && ctx.host.service(Privacy)?.mayReveal(owner, turn) !== true

    const setTool = makeTool({
      name: "reminders_set",
      description:
        "Set a reminder at a time or repeating (\"in ten minutes\", \"tomorrow at five\", \"every Monday at seven\"), for the person asking (scope me, the default when a person is known) or for the household (scope household). It rings on this device. Time reminders only: not 'when I get home', and not for another person. Put the time in `when` and what to be reminded of in `text`.",
      parameters: Schema.Struct({
        text: Line(TEXT_CHARS).annotate({ description: "What to remind of, one short line: \"call mum\"" }),
        when: Line(WHEN_CHARS).annotate({ description: "The time, as said: \"in ten minutes\", \"tomorrow at five\", \"every Monday at seven\"" }),
        scope: Schema.optionalKey(Schema.Literals(["me", "household"]).annotate({ description: "me: only for the person asking; household: for the whole house" }))
      }),
      risk: "change",
      latency: "instant",
      sensitivity: (result) => {
        const owner = (result as { readonly owner?: string }).owner
        return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
      },
      execute: ({ text, when, scope }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const person = turn?.person?.id
          const personal = scope === "me" ? true : scope === "household" ? false : person !== undefined
          // Personal content needs an owner: nobody known is asking, so ask whose, write nothing, repeat nothing.
          if (personal && person === undefined) return { spoken: say(texts, l, "whose") }
          if (looksLikeCode(text)) return { spoken: say(texts, l, "code") }
          const now = yield* Clock.currentTimeMillis
          const z = sh.zone()
          const said = parseWhen(when, l, z, now)
          if (said.kind === "ask") return { spoken: say(texts, l, said.key) }
          const owner = personal ? person : undefined
          const rem: Reminder = {
            text, whose: owner === undefined ? "household" : "personal", state: "open", dueAt: said.at,
            ...(owner !== undefined ? { owner } : {}),
            ...(turn?.deviceId !== undefined ? { deviceId: turn.deviceId } : {}),
            ...(turn?.assistantId !== undefined ? { assistantId: turn.assistantId } : {}),
            ...(person !== undefined ? { setBy: person } : {}),
            ...(said.kind === "repeat" ? { rrule: said.rrule, dtstart: said.dtstart, timeZone: said.timeZone } : {})
          }
          const id = randomUUID()
          const quiet = personalQuiet(owner, turn)
          yield* sh.exclusive(Effect.gen(function*() {
            const job = yield* sh.prepareDue(id, rem, said.at)
            yield* ctx.store.transaction((tx) => {
              tx.collection(reminders).insert(rem, { id })
              job.writeIn(tx)
            })
          })).pipe(Effect.mapError((e) => new ToolError({ message: say(texts, l, "reason" in e && e.reason === "limit" || ("message" in e && /live jobs|limit/i.test(String(e.message))) ? "tooMany" : "unsaved") })))
          const at = momentText(said.at, l, z, now)
          const rule = said.kind === "repeat" ? (said.rule ?? say(texts, l, "repeating")) : ""
          const spoken = said.kind === "once"
            ? say(texts, l, quiet ? "setOncePrivate" : owner === undefined ? "setOnceHousehold" : "setOnce", { when: at, text })
            : say(texts, l, quiet ? "setRepeatPrivate" : owner === undefined ? "setRepeatHousehold" : "setRepeat", { when: at, text, rule })
          return { spoken, ...(owner !== undefined ? { owner } : {}) }
        })
    })

    const listTool = makeTool({
      name: "reminders_list",
      description: "List the open reminders, soonest first: the household's and the asking person's own. Say what it covers; at most five are given, with a count of the rest.",
      parameters: Schema.Struct({}),
      speculative: true,
      latency: "quick",
      sensitivity: (result) => {
        const owner = (result as { readonly owner?: string }).owner
        return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
      },
      execute: () =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const z = sh.zone()
          const seen = yield* sh.readVisible(turn).pipe(Effect.mapError(() => failed(l, "unread")))
          const covers = say(texts, l, seen.person === undefined ? "coversHousehold" : seen.withheld > 0 ? "coversHouseholdHere" : "coversYours")
          if (seen.rows.length === 0) {
            if (seen.cut) return { spoken: say(texts, l, "cutNone", { count: SCAN_ROWS }) }
            if (seen.withheld > 0) return { spoken: say(texts, l, "withheld", { count: seen.withheld }) }
            return { spoken: say(texts, l, seen.person === undefined ? "nothingHousehold" : "nothing") }
          }
          const now = yield* Clock.currentTimeMillis
          const item = (r: Row<Reminder>) => {
            const rem = r.value
            return {
              text: rem.text,
              when: isOverdue(rem) ? say(texts, l, "wasDue", { when: momentText(rem.dueAt, l, z, now) }) : momentText(upcoming(rem), l, z, now),
              ...(rem.rrule !== undefined ? { repeats: ruleText(rem, l) } : {}),
              ...(rem.owner !== undefined ? { personal: true } : {})
            }
          }
          const owner = seen.rows.some((r) => r.value.owner !== undefined) ? seen.person : undefined
          const result = {
            covers,
            count: seen.rows.length,
            reminders: seen.rows.slice(0, 5).map(item),
            more: Math.max(0, seen.rows.length - 5),
            ...(seen.withheld > 0 ? { withheld: say(texts, l, "withheld", { count: seen.withheld }) } : {}),
            ...(seen.cut ? { cut: say(texts, l, "cutRead", { count: SCAN_ROWS }) } : {}),
            ...(owner !== undefined ? { owner } : {})
          }
          const present: Presentation = {
            kind: "list",
            title: say(texts, l, "listTitle"),
            style: "bullets",
            items: seen.rows.slice(0, 12).map((r) => ({ id: r.id, text: cut(`${shortMoment(upcoming(r.value), l, z)} · ${r.value.text}`, 80) })),
            spoken: say(texts, l, "spokenList", { count: seen.rows.length }),
            ...(owner !== undefined ? { sensitivity: { personal: owner } } : {})
          }
          return { forModel: result, present, show: { lifetime: "transient" as const, expiresInMs: LIST_MS, key: "list" } }
        })
    })

    const changeTool = makeTool({
      name: "reminders_change",
      description: "Change one reminder found by its words: new words (`text`), a new time (`when`, one moment or a repeat), or both. If the words match more than one reminder it asks which.",
      parameters: Schema.Struct({
        which: Line(TEXT_CHARS).annotate({ description: "Words that find the reminder: \"call mum\"" }),
        text: Schema.optionalKey(Line(TEXT_CHARS).annotate({ description: "The new words" })),
        when: Schema.optionalKey(Line(WHEN_CHARS).annotate({ description: "The new time, as said" }))
      }),
      risk: "change",
      sensitivity: (result) => {
        const owner = (result as { readonly owner?: string }).owner
        return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
      },
      execute: ({ which, text, when }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          if (text === undefined && when === undefined) return { spoken: say(texts, l, "changeWhat") }
          if (text !== undefined && looksLikeCode(text)) return { spoken: say(texts, l, "code") }
          const z = sh.zone()
          const now = yield* Clock.currentTimeMillis
          const said = when === undefined ? undefined : parseWhen(when, l, z, now)
          if (said?.kind === "ask") return { spoken: say(texts, l, said.key) }
          return yield* sh.exclusive(Effect.gen(function*() {
            const picked = yield* sh.pick(which, turn, l)
            if ("spoken" in picked) return { spoken: picked.spoken }
            const row = picked.row
            const id = row.id
            const rem = row.value
            const next: Reminder = {
              ...without(rem, "notifiedFor", "snoozeAt", "handled", ...(said !== undefined ? (["rrule", "dtstart", "timeZone"] as const) : [])),
              text: text ?? rem.text,
              dueAt: said?.at ?? rem.dueAt,
              ...(said?.kind === "repeat" ? { rrule: said.rrule, dtstart: said.dtstart, timeZone: said.timeZone } : {})
            }
            // A new time replaces the job of the reminder, in the same transaction as the row. Without one, the job and its
            // occurrence stay (a snooze and a delivery noted are kept).
            if (said === undefined) {
              yield* ctx.store.transaction((tx) => {
                tx.collection(reminders).update(id, (v) => ({ ...v, text: next.text }), { expectRev: row.rev })
              })
            } else {
              const job = yield* sh.prepareDue(id, next, said.at)
              yield* ctx.store.transaction((tx) => {
                tx.collection(reminders).update(id, () => next, { expectRev: row.rev })
                job.writeIn(tx)
              })
              yield* sh.dropJobs(id, ["snooze"])
              yield* sh.dismissCard(id)
              yield* sh.endNotification(id)
            }
            const quiet = personalQuiet(rem.owner, turn)
            const owner = rem.owner
            const spoken = quiet
              ? say(texts, l, "changedPrivate")
              : said?.kind === "repeat"
              ? say(texts, l, "changedRepeat", { text: next.text, rule: said.rule ?? say(texts, l, "repeating"), when: momentText(said.at, l, z, now) })
              : say(texts, l, "changed", { text: next.text, when: momentText(upcoming(next), l, z, now) })
            return { spoken, ...(owner !== undefined ? { owner } : {}) }
          }))
        }).pipe(Effect.mapError((e) => (e instanceof ToolError ? e : failed(sh.lang()))))
    })

    const cancelTool = makeTool({
      name: "reminders_cancel",
      description: "Cancel one reminder, found by its words. A repeating reminder is cancelled for good, every occurrence. If the words match more than one reminder it asks which.",
      parameters: Schema.Struct({ which: Line(TEXT_CHARS).annotate({ description: "Words that find the reminder: \"call mum\"" }) }),
      risk: "change",
      sensitivity: (result) => {
        const owner = (result as { readonly owner?: string }).owner
        return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
      },
      execute: ({ which }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          return yield* sh.exclusive(Effect.gen(function*() {
            const picked = yield* sh.pick(which, turn, l)
            if ("spoken" in picked) return { spoken: picked.spoken }
            const { row } = picked
            const now = yield* Clock.currentTimeMillis
            // Marked, not removed: the daily clean-up removes it later, off this turn's path.
            yield* ctx.store.collection(reminders).update(row.id, (v) => ({ ...without(v, "notifiedFor", "snoozeAt"), state: "cancelled" as const, endedAt: now }), { expectRev: row.rev })
            yield* sh.dropJobs(row.id, ["due", "snooze"])
            yield* sh.dismissCard(row.id)
            yield* sh.endNotification(row.id)
            const owner = row.value.owner
            return { spoken: personalQuiet(owner, turn) ? say(texts, l, "cancelledPrivate") : say(texts, l, "cancelled", { text: row.value.text }), ...(owner !== undefined ? { owner } : {}) }
          }))
        }).pipe(Effect.mapError((e) => (e instanceof ToolError ? e : failed(sh.lang()))))
    })

    const doneTool = makeTool({
      name: "reminders_done",
      description: "Mark a reminder done. With `which` (words that find it) it is that reminder; without, it is the one that is ringing or waiting on this device. A repeating reminder goes on with its next time.",
      parameters: Schema.Struct({ which: Schema.optionalKey(Line(TEXT_CHARS).annotate({ description: "Words that find the reminder; leave out for the one that just rang here" })) }),
      risk: "change",
      execute: ({ which }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          let id: string
          if (which === undefined) {
            const found = yield* sh.ringing(turn, l)
            if ("spoken" in found) return { spoken: found.spoken }
            id = found.id
          } else {
            const picked = yield* sh.exclusive(sh.pick(which, turn, l))
            if ("spoken" in picked) return { spoken: picked.spoken }
            id = picked.row.id
          }
          const spoken = yield* sh.answer("done", id, { endNotification: true })
          return { spoken }
        }).pipe(Effect.mapError((e) => (e instanceof ToolError ? e : failed(sh.lang()))))
    })

    const ringingDone = defineAction({
      id: "ringing_done",
      label: "Reminder done",
      description: "The reminder that is ringing or waiting on this device is done. Not for finding a reminder by its words: that is reminders_done.",
      examples: ["done", "that's done", "I've done it", "klaar", "dat is gedaan"],
      params: {},
      risk: "change",
      offerAsTool: false,
      run: () =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const found = yield* sh.ringing(turn, l)
          if ("spoken" in found) return { say: found.spoken }
          return { say: yield* sh.answer("done", found.id, { endNotification: true }) }
        }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, sh.lang(), "cantNow") })))
    })

    const ringingSnooze = defineAction({
      id: "ringing_snooze",
      label: "Snooze the reminder",
      description: "Put off the reminder that is ringing or waiting on this device, for some minutes (the setting's default when none is said).",
      examples: ["snooze", "snooze it for ten minutes", "remind me again in half an hour", "uitstellen", "herinner me over tien minuten nog eens"],
      params: { for: Param.duration({ label: "For how long", optional: true, minMs: 60_000, maxMs: DAY }) },
      risk: "change",
      run: ({ for: ms }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const found = yield* sh.ringing(turn, l)
          if ("spoken" in found) return { say: found.spoken }
          return { say: yield* sh.answer("snooze", found.id, { endNotification: true, ...(ms !== undefined ? { ms } : {}), ...(turn?.deviceId !== undefined ? { deviceId: turn.deviceId } : {}) }) }
        }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, sh.lang(), "cantNow") })))
    })

    return Effect.succeed({
      tools: [setTool, listTool, changeTool, cancelTool, doneTool],
      actions: [ringingDone, ringingSnooze],
      instructions: "Reminders: a task at a moment (a time, or a repeat) is a reminder; a bare duration is a timer; a task without a moment is a list item. Never guess a time that was not said: ask."
    })
  }
})

/** What the app runs from this package (`apps/assistant/src/modules.ts` lists it once): the production definition of each module id. */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [remindersModule]
