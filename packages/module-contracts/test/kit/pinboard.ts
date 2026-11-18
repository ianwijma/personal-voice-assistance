// The reference module of docs/MODULES.md: real code, small, not in the catalogue. Every part a module PR writes is
// here once: a settings field, a secret, a collection with an index and paging, a tool that reads, a tool that changes
// with a risk class, an action, a scheduled job with its handler, a route, a health check, personal content with an
// owner, and spoken lines in English and Dutch. `pinboard.test.ts` starts it through the test kit and runs every part
// as a turn, a job or an HTTP caller; it passes `checkModule`. The `#region` blocks are quoted in docs/MODULES.md
// (`docs.test.ts` keeps the two the same).
import {
  ActionError,
  CurrentJob,
  CurrentTurn,
  defineAction,
  defineCollection,
  defineModule,
  type HostView,
  makeTool,
  Privacy,
  type Row,
  Setting,
  ToolError
} from "@pva/core"
import { defineTexts, homeLanguage, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema } from "effect"
import { timingSafeEqual } from "node:crypto"

// #region texts
/** Every sentence the module speaks, in both languages, with the same placeholders (checkModule compares them). */
export const texts = defineTexts({
  en: {
    pinned: "Pinned: {text}.",
    pinnedFor: "Pinned for {name}: {text}.",
    empty: "The pinboard is empty.",
    cleared: "Cleared {count} old notes.",
    withheld: "{count} personal notes are not read out here.",
    noPerson: "I don't know who is asking, so I pinned it for everyone."
  },
  nl: {
    pinned: "Vastgeprikt: {text}.",
    pinnedFor: "Vastgeprikt voor {name}: {text}.",
    empty: "Het prikbord is leeg.",
    cleared: "{count} oude briefjes weggehaald.",
    withheld: "{count} persoonlijke briefjes lees ik hier niet voor.",
    noPerson: "Ik weet niet wie het vraagt, dus het hangt er voor iedereen."
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
  indexes: ["pinnedAt"]
})
// #endregion collection

// #region settings
const settings = {
  keepDays: Setting.number({ label: "Keep notes for", description: "Days a note stays pinned.", default: 7, integer: true, min: 1, max: 365, unit: "days" }),
  signingKey: Setting.secret({ label: "Webhook key", description: "When set, the pin address also needs it in the X-Pinboard-Key header." })
}
// #endregion settings

/** The household's language now (Home section), asked at each use: the owner can change it at any time. */
const languageOf = (view: HostView) => homeLanguage(view)

// #region reading
/** Every note, newest first, page by page: a list reads at most `maxListRows(notes)` rows, `after` continues. */
const allNotes = (list: (q: { readonly limit: number; readonly after?: Row<Note> }) => Effect.Effect<ReadonlyArray<Row<Note>>, unknown>) =>
  Effect.gen(function*() {
    const out: Array<Row<Note>> = []
    let after: Row<Note> | undefined
    for (let page = 0; page < 20; page++) {
      const rows = yield* list({ limit: 25, ...(after !== undefined ? { after } : {}) })
      out.push(...rows)
      if (rows.length < 25) break
      after = rows.at(-1)
    }
    return out
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
      settings?.signingKey === undefined
        ? [{ id: "pinboard.no-key", severity: "info" as const, title: "The pin address has no key", detail: "Any LAN caller with a token can pin. Set a webhook key to require it too." }]
        : []
    ),
  // #endregion health
  // #region shared
  shared: (ctx) =>
    Effect.gen(function*() {
      const board = ctx.store.collection(notes)
      // A handler is registered in `shared` (once per module), with a payload schema, idempotent: running it twice is fine.
      yield* ctx.scheduler.handle("expire", {
        payload: Schema.Struct({}),
        idempotent: true,
        run: () =>
          Effect.gen(function*() {
            const keepDays = ctx.settingsFor(undefined)?.keepDays ?? 7
            const job = yield* CurrentJob
            const cutoff = (yield* Clock.currentTimeMillis) - keepDays * 86_400_000
            const old = (yield* allNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "asc" }, ...q }))).filter((r) => r.value.pinnedAt < cutoff)
            // One synchronous transaction; nothing in it awaits, and no store failure is caught inside it.
            yield* ctx.store.transaction((tx) => {
              for (const row of old) tx.collection(notes).remove(row.id, { actor: { kind: "job", jobId: job?.jobId ?? "expire" } })
            })
          })
      }).pipe(Effect.orDie)
      // A system job: cron with minute, hour and day of week only. Scheduling the same key again replaces it.
      yield* ctx.scheduler.schedule({ handler: "expire", key: "expire", payload: {}, cron: "0 4 * * *" }).pipe(Effect.orDie)
      return {
        value: undefined,
        // A route under /api/modules/pinboard/pin: a token of this module AND a LAN caller; a small JSON body.
        routes: [{
          method: "POST" as const,
          path: "pin",
          guards: ["token", "lan"] as const,
          token: "pin",
          bodyLimitBytes: 1_024,
          description: "Pin a household note from a home automation.",
          handler: (request) =>
            Effect.gen(function*() {
              const key = ctx.settings.signingKey
              if (key !== undefined) {
                const given = Buffer.from(request.headers["x-pinboard-key"] ?? "")
                const want = Buffer.from(key)
                if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 401, body: { error: "bad key" } }
              }
              const body = request.body as { readonly text?: unknown } | undefined
              const text = typeof body?.text === "string" ? body.text.trim() : ""
              if (text === "" || !Schema.is(StoredText(200))(text)) return { status: 400, body: { error: "text: 1 to 200 characters of one line" } }
              const row = yield* board.insert({ text, pinnedAt: yield* Clock.currentTimeMillis })
              return { status: 201, body: { id: row.id } }
            })
        }]
      }
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
            const rows = yield* allNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "desc" }, ...q })).pipe(
              Effect.mapError(() => new ToolError({ message: "The pinboard could not be read." }))
            )
            if (rows.length === 0) return { spoken: say(texts, lang, "empty") }
            let owner: string | undefined
            let withheld = 0
            const shown: Array<string> = []
            for (const r of rows) {
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
              ...(owner !== undefined ? { owner } : {})
            }
          })
      })
      // #endregion read-tool
      // #region change-tool
      const pin = makeTool({
        name: "pinboard_pin",
        description: "Pin a short note on the pinboard, for everyone or only for the person asking.",
        parameters: Schema.Struct({
          text: StoredText(200).annotate({ description: "The note, one short line" }),
          forMe: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only for the person asking" }))
        }),
        risk: "change", // it changes household data: declared, never left to be inferred
        execute: ({ text, forMe }) =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            const lang = languageOf(ctx.host.view())
            const person = forMe === true ? turn?.person?.id : undefined
            yield* board.insert({ text, pinnedAt: yield* Clock.currentTimeMillis, ...(person !== undefined ? { owner: person } : {}) }).pipe(
              Effect.mapError(() => new ToolError({ message: "The note could not be pinned." }))
            )
            if (forMe === true && person === undefined) return { spoken: say(texts, lang, "noPerson") }
            return { spoken: say(texts, lang, "pinned", { text }) }
          })
      })
      // #endregion change-tool
      // #region action
      const clear = defineAction({
        id: "clear",
        label: "Clear the pinboard",
        description: "Take down every household note older than a day. Personal notes stay.",
        examples: ["clear the pinboard", "take the old notes down", "maak het prikbord leeg"],
        params: {},
        risk: "change",
        run: () =>
          Effect.gen(function*() {
            const lang = languageOf(ctx.host.view())
            const cutoff = (yield* Clock.currentTimeMillis) - 86_400_000
            const old = (yield* allNotes((q) => board.list({ orderBy: { field: "pinnedAt", direction: "asc" }, ...q })).pipe(
              Effect.mapError(() => new ActionError({ message: "The pinboard could not be read." }))
            )).filter((r) => r.value.owner === undefined && r.value.pinnedAt < cutoff)
            yield* ctx.store.transaction((tx) => {
              for (const row of old) tx.collection(notes).remove(row.id)
            }).pipe(Effect.mapError(() => new ActionError({ message: "The pinboard could not be cleared." })))
            return { say: say(texts, lang, "cleared", { count: old.length }) }
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
