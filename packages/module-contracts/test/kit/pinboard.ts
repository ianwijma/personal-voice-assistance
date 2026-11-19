// The reference module of docs/MODULES.md: real code, small, not in the catalogue. Every part a wave A module PR writes
// is here once: a settings field, a secret, a collection with an index and an honest bounded scan, a tool that reads,
// a tool that changes with a risk class and asks whose before it writes, a job scheduled from a turn in the same
// transaction as its row, a daily system job with its handler, an action, a health check, personal content with an
// owner, and every spoken line in English and Dutch. `pinboard.test.ts` starts it through the test kit and runs every
// part as a turn or a job; it passes `checkModule`. The `#region` blocks are quoted in docs/MODULES.md (`docs.test.ts`
// keeps the two the same).
import { ActionError, CurrentJob, CurrentTurn, defineAction, defineCollection, defineModule, type HostView, makeTool, Privacy, type Row, Setting, ToolError } from "@pva/core"
import { defineTexts, homeLanguage, isLine, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"

// #region texts
/** Every sentence the module speaks, failures and questions included, in both languages with the same placeholders. */
export const texts = defineTexts({
  en: {
    pinned: "Pinned: {text}.",
    pinnedUntil: "Pinned for {hours} hours: {text}.",
    pinnedPrivately: "Pinned, only for you.",
    pinnedPrivatelyUntil: "Pinned for {hours} hours, only for you.",
    empty: "The pinboard is empty.",
    cleared: "Cleared {count} old notes.",
    clearedSome: "Cleared {count} old notes; there are more, so say it again.",
    withheld: "{count} personal notes are not read out here.",
    cut: "I read the newest {count} notes; there are more.",
    whose: "Who is the note for? I can't tell who is asking here.",
    unreadable: "The pinboard could not be read.",
    unsaved: "The note could not be pinned.",
    uncleared: "The pinboard could not be cleared."
  },
  nl: {
    pinned: "Vastgeprikt: {text}.",
    pinnedUntil: "Vastgeprikt voor {hours} uur: {text}.",
    pinnedPrivately: "Vastgeprikt, alleen voor jou.",
    pinnedPrivatelyUntil: "Vastgeprikt voor {hours} uur, alleen voor jou.",
    empty: "Het prikbord is leeg.",
    cleared: "{count} oude briefjes weggehaald.",
    clearedSome: "{count} oude briefjes weggehaald; er zijn er meer, zeg het nog eens.",
    withheld: "{count} persoonlijke briefjes lees ik hier niet voor.",
    cut: "Ik heb de nieuwste {count} briefjes gelezen; er zijn er meer.",
    whose: "Voor wie is het briefje? Ik weet hier niet wie het vraagt.",
    unreadable: "Het prikbord kon niet worden gelezen.",
    unsaved: "Het briefje kon niet worden vastgeprikt.",
    uncleared: "Het prikbord kon niet worden leeggemaakt."
  }
})
// #endregion texts

// #region collection
const PERSON_ID = Schema.String.check(Schema.isMaxLength(40), Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/))

/** One pinned note: household data, or personal with its owner (a Members id). */
export const Note = Schema.Struct({
  text: StoredText(200),
  /** Absent: the household's. Present: personal, shown only where `Privacy.mayReveal(owner, device)` says so. */
  owner: Schema.optionalKey(PERSON_ID),
  /** Whose kind of note it is, indexed with `pinnedAt`, so the household's notes can be listed without the personal ones. */
  whose: Schema.Literals(["household", "personal"]),
  /** Epoch ms; indexed, so lists can be ordered by it and read page by page. */
  pinnedAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
})
export type Note = typeof Note.Type

export const notes = defineCollection({
  name: "notes",
  scope: "household",
  schema: Note,
  // The worst legal note is about 700 characters of JSON (checkModule computes it): 800 lets one list read 31 rows.
  maxChars: 800,
  // Indexed values are bounded scalars (a literal, a bounded integer): the store refuses anything else when it is
  // written, and pinboard.test.ts writes a row with each at its largest.
  indexes: ["pinnedAt", ["whose", "pinnedAt"]]
})
// #endregion collection

// #region settings
const settings = {
  keepDays: Setting.number({ label: "Keep notes for", description: "Days a note stays pinned.", default: 7, integer: true, min: 1, max: 365, unit: "days" }),
  printerKey: Setting.secret({ label: "Label printer key", description: "Not used by this example's tools: it shows a secret declared, checked by health and kept out of every result." })
}
// #endregion settings

/** The household's language now (Home section), asked at each use: the owner can change it at any time. */
const languageOf = (view: HostView) => homeLanguage(view)

// #region reading
/** The most notes one answer reads: 20 pages of 25, each one bounded indexed read. A turn never scans further. */
export const SCAN_ROWS = 500
const PAGE = 25

/**
 * The notes in one order, page by page (`after` continues a list), at most `SCAN_ROWS`, and whether there were more:
 * a bounded scan says so when it is cut short, so nothing calls a partial read "every note".
 */
const scanNotes = (list: (q: { readonly limit: number; readonly after?: Row<Note> }) => Effect.Effect<ReadonlyArray<Row<Note>>, unknown>) =>
  Effect.gen(function*() {
    const rows: Array<Row<Note>> = []
    let after: Row<Note> | undefined
    for (let page = 0; page < SCAN_ROWS / PAGE; page++) {
      const got = yield* list({ limit: PAGE, ...(after !== undefined ? { after } : {}) })
      rows.push(...got)
      if (got.length < PAGE) return { rows, cut: false }
      after = got.at(-1)
    }
    const beyond = yield* list({ limit: 1, ...(after !== undefined ? { after } : {}) })
    return { rows, cut: beyond.length > 0 }
  })
// #endregion reading

export const pinboardModule = defineModule({
  apiVersion: 2,
  id: "pinboard",
  name: "Pinboard",
  description: "Short notes pinned for the household or one person, read back on request.",
  enabledByDefault: false,
  settings,
  storage: { version: 1, collections: [notes] },
  // #region health
  health: ({ settings }) =>
    Effect.succeed(
      settings?.printerKey === undefined
        ? [{ id: "pinboard.no-printer-key", severity: "info" as const, title: "No label printer key", detail: "Set one on the module's page to print notes." }]
        : []
    ),
  // #endregion health
  // #region shared
  shared: (ctx) =>
    Effect.gen(function*() {
      const board = ctx.store.collection(notes)
      // Handlers are registered in `shared` (once per module), each with a payload schema. Both are idempotent: running
      // one twice for the same occurrence does no harm, so a run cut short by a restart is simply run again.
      yield* ctx.scheduler.handle("expire", {
        payload: Schema.Struct({}),
        idempotent: true,
        run: () =>
          Effect.gen(function*() {
            const job = yield* CurrentJob
            if (job === undefined) return yield* Effect.die(new Error("expire runs only as a job"))
            const keepDays = ctx.settingsFor(undefined)?.keepDays ?? 7
            const cutoff = (yield* Clock.currentTimeMillis) - keepDays * 86_400_000
            // Oldest first, a bounded batch per transaction, until a batch reaches a note that stays: maintenance work
            // goes on in steps that each take a moment, never in one unbounded read.
            for (let batch = 0; batch < 100; batch++) {
              const scan = yield* scanNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "asc" }, ...q }))
              const old = scan.rows.filter((r) => r.value.pinnedAt < cutoff)
              // One synchronous transaction; nothing in it awaits, and no store failure is caught inside it.
              yield* ctx.store.transaction((tx) => {
                for (const row of old) tx.collection(notes).remove(row.id, { actor: { kind: "job", jobId: job.jobId } })
              })
              if (!scan.cut || old.length < scan.rows.length) return
              yield* Effect.yieldNow
            }
          })
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.handle("unpin", {
        payload: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(200)) }),
        idempotent: true,
        run: ({ id }) =>
          Effect.gen(function*() {
            // A job scheduled from a turn runs with that turn's origin (`CurrentJob`: its assistant, device and person).
            const job = yield* CurrentJob
            if (job === undefined) return yield* Effect.die(new Error("unpin runs only as a job"))
            yield* board.remove(id, { actor: { kind: "job", jobId: job.jobId } })
          })
      }).pipe(Effect.orDie)
      // A system job: cron with minute, hour and day of week only. Scheduling the same key again replaces it.
      yield* ctx.scheduler.schedule({ handler: "expire", key: "expire", cron: "0 4 * * *" }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  // #endregion shared
  start: (ctx) =>
    Effect.gen(function*() {
      const board = ctx.store.collection(notes)
      // #region read-tool
      const read = makeTool({
        name: "pinboard_read",
        description: "Read the notes pinned on the household's pinboard, newest first.",
        parameters: Schema.Struct({}),
        speculative: true, // a plain read: safe to run before the turn is committed; its risk is `read`
        // The result names whose personal note it holds; the gateway checks it against the asking device (P8).
        sensitivity: (result) => {
          const owner = (result as { readonly owner?: string }).owner
          return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
        },
        execute: () =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            // Looked up at each use, never kept: `Privacy` is the core's, and decides at the moment of revealing.
            const privacy = ctx.host.service(Privacy)
            const lang = languageOf(ctx.host.view())
            const scan = yield* scanNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "desc" }, ...q })).pipe(
              Effect.mapError(() => new ToolError({ message: say(texts, lang, "unreadable") }))
            )
            if (scan.rows.length === 0) return { spoken: say(texts, lang, "empty") }
            let owner: string | undefined
            let withheld = 0
            const shown: Array<string> = []
            for (const r of scan.rows) {
              const o = r.value.owner
              // A personal note is read only where the rule allows it now, on the device that will speak it.
              if (o !== undefined && privacy?.mayReveal(o, turn) !== true) {
                withheld++
                continue
              }
              if (o !== undefined) owner ??= o
              shown.push(r.value.text)
            }
            return {
              notes: shown.slice(0, 10),
              more: Math.max(0, shown.length - 10),
              ...(withheld > 0 ? { withheld: say(texts, lang, "withheld", { count: withheld }) } : {}),
              ...(scan.cut ? { cut: say(texts, lang, "cut", { count: SCAN_ROWS }) } : {}),
              ...(owner !== undefined ? { owner } : {})
            }
          })
      })
      // #endregion read-tool
      // #region change-tool
      const pin = makeTool({
        name: "pinboard_pin",
        description: "Pin a short note on the pinboard, for everyone or only for the person asking, optionally for some hours.",
        parameters: Schema.Struct({
          // Stored text, and one line: `StoredText` alone allows a line break, so `isLine` checks the rest.
          text: StoredText(200).check(Schema.makeFilter((t: string) => isLine(t, 200) || "one line, without line breaks")).annotate({ description: "The note, one short line" }),
          forMe: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only for the person asking" })),
          hours: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 72 })).annotate({ description: "Take it down after this many hours" }))
        }),
        risk: "change", // it changes household data: declared, never left to be inferred
        execute: ({ text, forMe, hours }) =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            const lang = languageOf(ctx.host.view())
            const person = turn?.person?.id
            // Personal content needs an owner. Nobody known is asking (a public screen, no default person): ask whose,
            // and write nothing. Never store it as the household's instead, and never repeat the text here.
            if (forMe === true && person === undefined) return { spoken: say(texts, lang, "whose") }
            const owner = forMe === true ? person : undefined
            const note: Note = { text, whose: owner === undefined ? "household" : "personal", pinnedAt: yield* Clock.currentTimeMillis, ...(owner !== undefined ? { owner } : {}) }
            const failed = () => new ToolError({ message: say(texts, lang, "unsaved") })
            // The confirmation repeats a personal note only where it may be revealed: a public screen with a default
            // person knows whose it is, and still must not show it. Asked now, for this device.
            const quiet = owner !== undefined && ctx.host.service(Privacy)?.mayReveal(owner, turn) !== true
            if (hours === undefined) {
              yield* board.insert(note).pipe(Effect.mapError(failed))
              return { spoken: quiet ? say(texts, lang, "pinnedPrivately") : say(texts, lang, "pinned", { text }) }
            }
            // The note and the job that takes it down are written in one transaction: both or neither. The row's id is
            // chosen first, so the job's payload can name it; the job inherits this turn's origin.
            const id = randomUUID()
            const job = yield* ctx.scheduler.prepare({ handler: "unpin", key: `unpin:${id}`, payload: { id }, inMs: hours * 3_600_000 }).pipe(Effect.mapError(failed))
            yield* ctx.store.transaction((tx) => {
              tx.collection(notes).insert(note, { id })
              job.writeIn(tx)
            }).pipe(Effect.mapError(failed))
            return { spoken: quiet ? say(texts, lang, "pinnedPrivatelyUntil", { hours }) : say(texts, lang, "pinnedUntil", { hours, text }) }
          })
      })
      // #endregion change-tool
      // #region action
      const clear = defineAction({
        id: "clear",
        label: "Clear the pinboard",
        description: "Take down household notes older than a day. Personal notes stay.",
        examples: ["clear the pinboard", "take the old notes down", "maak het prikbord leeg"],
        params: {},
        risk: "change",
        run: () =>
          Effect.gen(function*() {
            const lang = languageOf(ctx.host.view())
            const cutoff = (yield* Clock.currentTimeMillis) - 86_400_000
            // The household's notes only, oldest first, through the index on [whose, pinnedAt]: every row read is one
            // the action may take down, so the personal notes it keeps never stand in its way.
            const scan = yield* scanNotes((q) => board.list({ where: { whose: "household" }, orderBy: { field: "pinnedAt", direction: "asc" }, ...q })).pipe(
              Effect.mapError(() => new ActionError({ message: say(texts, lang, "unreadable") }))
            )
            const old = scan.rows.filter((r) => r.value.pinnedAt < cutoff)
            yield* ctx.store.transaction((tx) => {
              for (const row of old) tx.collection(notes).remove(row.id)
            }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, lang, "uncleared") })))
            // Cut short while every note it read was old: there may be more old ones, and saying it again reaches them,
            // because the ones it took down are gone. Otherwise it reached a note that stays, and is done.
            const more = scan.cut && old.length === scan.rows.length
            return { say: say(texts, lang, more ? "clearedSome" : "cleared", { count: old.length }) }
          })
      })
      // #endregion action
      return {
        tools: [read, pin],
        actions: [clear],
        instructions: "Use pinboard_read when asked what is on the pinboard, and pinboard_pin to pin a note."
      }
    })
})
