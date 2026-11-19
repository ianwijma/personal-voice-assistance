import { ActionError, CurrentJob, CurrentTurn, defineAction, defineModule, makeTool, Param, type Row, Setting, type StoreFailure, ToolError } from "@pva/core"
import { homeLanguage, isLine, type Language, Lists, LISTS_LIMITS, say, StoredText } from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Clock, Effect, Schema } from "effect"
import { type Item, items, listPhrase, lists, MAX_CLEAR, MAX_LIVE_LISTS, MAX_OPEN, MAX_PER_REQUEST, NAME_CHARS, normalise, type Quantity, SHOPPING, TODO, undo, undoIdOf } from "./data.ts"
import { type Engine, isRefusal, listChoice, makeEngine, speak } from "./engine.ts"
import { type SaidItem, sayItem, type SplitMode, splitItems, takeListSuffix } from "./parse.ts"
import { makeListsService } from "./service.ts"
import { texts } from "./texts.ts"
import { tidy } from "./tidy.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Settings

export const settings = {
  splitItems: Setting.choice({
    label: "Split what is said",
    description: "How \"milk, eggs and rice\" is put on a list.",
    options: [
      { value: "known", label: "On commas and \"and\", but not inside names like \"salt and pepper crisps\"" },
      { value: "always", label: "On commas and \"and\", always" },
      { value: "never", label: "Never: one item per request" }
    ],
    default: "known"
  }),
  mergeDuplicates: Setting.boolean({
    label: "Merge items said again",
    description: "\"Add milk\" when milk is on the list adds nothing; an amount is added to the one on the list, and a ticked-off item is put back.",
    default: true
  }),
  keepDoneShoppingHours: Setting.number({
    label: "Keep ticked-off shopping for",
    description: "Ticked-off items of shopping lists stay readable this long, then the daily clean-up removes them.",
    default: 24,
    integer: true,
    min: 1,
    max: 720,
    unit: "hours"
  }),
  keepDoneDays: Setting.number({
    label: "Keep other ticked-off items for",
    description: "Ticked-off items of to-do and other lists stay this long, then the daily clean-up removes them.",
    default: 30,
    integer: true,
    min: 1,
    max: 365,
    unit: "days"
  }),
  readItems: Setting.number({
    label: "Items read out at once",
    description: "How many items \"what's on the list\" names before \"and N more\".",
    default: 5,
    integer: true,
    min: 2,
    max: 10,
    overridable: true
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers

const lineText = (max: number, what: string) => StoredText(max).check(Schema.makeFilter((t: string) => (isLine(t, max) && t.trim() !== "") || `${what}: one line of 1 to ${max} characters`))

/** The conversation's undo row, or none outside a turn (a job, a routine step run by a job). */
const undoKey = Effect.map(CurrentTurn, (turn) => (turn === undefined ? undefined : undoIdOf(turn.conversationId)))

/** A store failure as a spoken sentence: `busy` (try again) or a plain "couldn't". */
const storeSentence = (lang: Language, e: StoreFailure, reading: boolean) =>
  (e._tag === "StoreError" && e.reason === "busy") || e._tag === "StoreConflict" ? speak(lang, "busy") : speak(lang, reading ? "unreadable" : "unsaved")

/** "milk, eggs and 3 more": at most `max` named, worded by `@pva/language`. */
const listOf = (things: ReadonlyArray<string>, lang: Language, max = 5) => speakList(things.slice(0, 100), lang, { max: Math.max(2, max) }) ?? things.slice(0, max).join(", ")

const LIST_MARKERS = ["to", "on", "onto", "in", "into", "op", "aan", "in", "bij"]
const OFF_MARKERS = ["off", "from", "on", "van", "op", "af", "uit"]

// ---------------------------------------------------------------------------------------------------------------------
// The module

export const listsModule = defineModule({
  apiVersion: 2,
  id: "lists",
  name: "Lists",
  description: "Shopping and to-do lists: add, read, tick off and remove items.",
  enabledByDefault: false,
  settings,
  // Version 2: an item's `match` holds its status too (indexed with `since`), so a name finds the open item first.
  storage: { version: 2, collections: [lists, items, undo] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const engine = makeEngine(ctx.store)
      // The two default lists exist from the start, so they always count toward the bound on list rows. The list
      // choices of the typed actions are read synchronously: keep the (at most 50) list rows. A store that is not
      // there or is read-only (a CLI mode) leaves them as they are; every call then says it could not read the lists.
      yield* engine.ensureDefaults.pipe(Effect.ignore)
      yield* engine.loadLists.pipe(Effect.ignore)
      yield* ctx.scheduler.handle("tidy", {
        payload: Schema.Struct({}),
        // It only removes what is old by now: running it twice does no harm.
        idempotent: true,
        timeoutMs: 120_000,
        run: () =>
          Effect.gen(function*() {
            const job = yield* CurrentJob
            if (job === undefined) return yield* Effect.die(new Error("tidy runs only as a job"))
            const s = ctx.settingsFor(undefined)
            const now = yield* Clock.currentTimeMillis
            yield* tidy(engine, { keepDoneShoppingHours: s?.keepDoneShoppingHours ?? 24, keepDoneDays: s?.keepDoneDays ?? 30 }, now, { kind: "job", jobId: job.jobId })
          })
      }).pipe(Effect.orDie)
      // A system job at a quarter past four, the household's time zone.
      yield* ctx.scheduler.schedule({ handler: "tidy", key: "tidy", cron: "15 4 * * *" }).pipe(Effect.orDie)
      return { value: engine, services: [Lists.of(makeListsService(engine))] }
    }),
  start: (ctx) =>
    Effect.sync(() => {
      const engine: Engine = ctx.shared
      const lang = () => homeLanguage(ctx.host.view())
      const mode = ctx.settings.splitItems as SplitMode
      const merge = ctx.settings.mergeDuplicates
      const readItems = ctx.settings.readItems
      // Each list also as the speaker's own ("my shopping list"): there are no personal lists, so that is the
      // household's list, and the answer says so (`listChoice`).
      const listParam = Param.dynamic({ label: "List", options: () => engine.options(lang(), true), optional: true })
      /** The list a list parameter named, and whether it was said as the speaker's own. */
      const chosen = (value: string | undefined) => listChoice(value)
      /** Run one at a time with every other change and count-and-items read of the module (`engine.serial`). */
      const serial = engine.serial
      const actionError = (message: string) => new ActionError({ message })
      const toolError = (message: string) => new ToolError({ message })

      /** What was said, split; a sentence when it cannot be used. */
      const said = (text: string, l: Language): ReadonlyArray<SaidItem> | string => {
        const split = splitItems(text, l, mode)
        switch (split.kind) {
          case "ok":
            return split.items
          case "empty":
            return speak(l, "nothingSaid")
          case "too-many":
            return speak(l, "tooMany", { count: MAX_PER_REQUEST })
          case "too-long":
            return speak(l, "tooLong")
        }
      }

      // -- add ---------------------------------------------------------------------------------------------------------
      const add = defineAction({
        id: "add",
        label: "Add to a list",
        description:
          "Put things on a household list: the shopping list unless another list is named. Pass everything that was said in `items` as one text: it is split on commas and \"and\", and amounts (\"two litres of oat milk\") are read from it. Something already on the list is not added twice. Not for ticking off (lists_complete) or for a new list (lists_create).",
        examples: [
          "add milk to the shopping list",
          "put eggs, bread and two litres of oat milk on the list",
          "add call the plumber to the to-do list",
          "zet melk op de boodschappenlijst",
          "doe brood en twee pakken yoghurt op het lijstje"
        ],
        params: {
          items: Param.text({ label: "What to add", after: ["add", "put", "zet", "doe", "voeg"], maxWords: 40 }),
          list: listParam
        },
        risk: "change",
        latency: "instant",
        run: ({ items: text, list: value }) =>
          serial(Effect.gen(function*() {
            const l = lang()
            yield* engine.loadLists.pipe(Effect.mapError((e) => actionError(storeSentence(l, e, true))))
            const picked = chosen(value)
            // The typed path hands over the rest of the sentence: "milk to the shopping list", "melk op mijn lijstje".
            const named = picked.list === undefined ? takeListSuffix(text.replace(/\s+/g, " ").trim(), LIST_MARKERS, (w) => engine.resolveList(w, l)) : { text, list: picked.list, mine: picked.mine }
            // A list said the way a list is named, that the household does not have: refused, nothing written elsewhere.
            if (named.unknown !== undefined) return yield* Effect.fail(actionError(speak(l, "unknownList", { name: named.unknown, items: listOf(engine.listNames(l), l, 8) })))
            const target = named.list ?? SHOPPING
            const things = said(named.text, l)
            if (typeof things === "string") return yield* Effect.fail(actionError(things))
            const now = yield* Clock.currentTimeMillis
            const key = yield* undoKey
            const result = yield* engine.add(target, things, merge, key, now, l).pipe(Effect.mapError((e) => actionError(storeSentence(l, e, false))))
            const plain = engine.phraseOf(target, l)
            if (isRefusal(result)) {
              return yield* Effect.fail(actionError(result.reason === "full" ? speak(l, "full", { list: plain, count: MAX_OPEN }) : speak(l, "unknownList", { name: plain, items: listOf(engine.listNames(l), l, 8) })))
            }
            // "My shopping list": there are no personal lists, so it went on the household's, and the answer says so.
            const shared = named.mine === true
            const phrase = shared ? say(texts, l, "householdsList", { name: l === "en" ? plain.replace(/^the /, "") : plain }) : plain
            if (result.added.length === 0) return { say: speak(l, shared ? "alreadyShared" : "already", { list: phrase, items: listOf(result.already, l) }) }
            if (result.already.length === 0) return { say: speak(l, shared ? "addedShared" : "added", { list: phrase, items: listOf(result.added, l) }) }
            return { say: speak(l, shared ? "addedAndAlreadyShared" : "addedAndAlready", { list: phrase, items: listOf(result.added, l), already: listOf(result.already, l) }) }
          }))
      })

      // -- read --------------------------------------------------------------------------------------------------------
      const read = defineAction({
        id: "read",
        label: "Read a list",
        description:
          "Say what is on a household list (the shopping list unless another is named): how many things, the first few and how many more. `from` goes on from an item number (\"read the rest\"); `show: done` says what was ticked off.",
        examples: ["what's on the shopping list", "read the to-do list", "what else is on the list", "wat staat er op de boodschappenlijst", "lees de takenlijst voor"],
        params: {
          list: listParam,
          show: Param.choice({ label: "Which items", options: [{ value: "open", label: "still to get or do" }, { value: "done", label: "ticked off" }], default: "open", optional: true }),
          from: Param.number({ label: "From item number", min: 1, max: MAX_OPEN, integer: true, optional: true })
        },
        speculative: true,
        latency: "instant",
        // Under the module's one permit: the count and the items it names come from one state of the list.
        run: ({ list, show, from }) =>
          serial(Effect.gen(function*() {
            const l = lang()
            const target = chosen(list).list ?? SHOPPING
            const phrase = engine.phraseOf(target, l)
            const unreadable = (e: StoreFailure) => actionError(storeSentence(l, e, true))
            const counts = yield* engine.countsOf(target).pipe(Effect.mapError(unreadable))
            const start = from ?? 1
            if (show === "done") {
              if (counts.done === 0) return { say: speak(l, "noneDone", { list: phrase }) }
              if (start > counts.done) return { say: speak(l, "readDonePastEnd", { list: phrase, count: counts.done }) }
              // The newest first, from item `from` on: at most `from - 1 + readItems` rows (≤ 510), page by page.
              const { rows } = yield* engine.scan(target, "done", start - 1 + readItems, "desc").pipe(Effect.mapError(unreadable))
              const named = rows.slice(start - 1).map((r) => sayItem(r.value.text, r.value.quantity, l))
              const words = moreOf(named, counts.done - (start - 1), l)
              return { say: start > 1 ? speak(l, "readDoneFrom", { list: phrase, from: start, items: words }) : speak(l, "readDone", { list: phrase, items: words }) }
            }
            if (counts.open === 0) return { say: speak(l, "empty", { list: phrase }) }
            if (start > counts.open) return { say: speak(l, "readPastEnd", { list: phrase, count: counts.open }) }
            // At most `from - 1 + readItems` rows (≤ 510), page by page: bounded, never the whole store.
            const { rows } = yield* engine.scan(target, "open", start - 1 + readItems).pipe(Effect.mapError(unreadable))
            const shown = rows.slice(start - 1).map((r) => sayItem(r.value.text, r.value.quantity, l))
            const left = counts.open - (start - 1)
            const words = moreOf(shown, left, l)
            if (start > 1) return { say: speak(l, "readFrom", { list: phrase, from: start, items: words }) }
            return { say: counts.open === 1 ? speak(l, "readOne", { list: phrase, items: words }) : speak(l, "readOpen", { list: phrase, count: counts.open, items: words }) }
          }))
      })

      /** The items shown, and "and N more" for the rest of `total`. */
      const moreOf = (shown: ReadonlyArray<string>, total: number, l: Language) => {
        const rest = total - shown.length
        if (rest <= 0 || shown.length === 0) return listOf(shown, l, Math.max(2, shown.length))
        return say(texts, l, "more", { items: shown.join(", "), count: rest })
      }

      // -- complete and remove -----------------------------------------------------------------------------------------
      /** Find each said item: on the named list, or (none named) on the list the first one is found on. */
      const findAll = (text: string, list: string | undefined, done: boolean, l: Language) =>
        Effect.gen(function*() {
          yield* engine.loadLists
          const cleaned = text.replace(/\s+/g, " ").trim()
          const named = list === undefined ? takeListSuffix(cleaned, OFF_MARKERS, (w) => engine.resolveList(w, l)) : { text: cleaned, list }
          if (named.unknown !== undefined) return { kind: "said" as const, sentence: speak(l, "unknownList", { name: named.unknown, items: listOf(engine.listNames(l), l, 8) }) }
          const things = said(named.text.replace(/\s+(?:off|af)$/i, ""), l)
          if (typeof things === "string") return { kind: "said" as const, sentence: things }
          let target = named.list
          const found: Array<Row<Item>> = []
          const missing: Array<string> = []
          // Not found while a scan stopped at its bound: whether it is there is not known, so never "not on the list".
          const unsure: Array<string> = []
          for (const s of things) {
            let hit: { readonly row: Row<Item> | undefined; readonly cut: boolean }
            if (target === undefined) {
              const anywhere = yield* engine.findAnywhere(s.text, done)
              if (anywhere.list !== undefined) target = anywhere.list
              hit = anywhere
            } else hit = yield* engine.find(target, s.text, done)
            const row = hit.row
            if (row !== undefined && !found.some((f) => f.id === row.id)) found.push(row)
            else if (row === undefined) (hit.cut ? unsure : missing).push(s.text)
          }
          return { kind: "found" as const, list: target ?? SHOPPING, found, missing, unsure }
        })

      const tickOrRemove = (to: "done" | "removed") => ({ item, list }: { readonly item: string; readonly list: string | undefined }) =>
        serial(Effect.gen(function*() {
          const l = lang()
          const r = yield* findAll(item, chosen(list).list, to === "removed", l).pipe(Effect.mapError((e) => actionError(storeSentence(l, e, true))))
          if (r.kind === "said") return yield* Effect.fail(actionError(r.sentence))
          const phrase = engine.phraseOf(r.list, l)
          const notOn = [
            ...(r.missing.length > 0 ? [speak(l, "notOnList", { list: phrase, items: listOf(r.missing, l) })] : []),
            ...(r.unsure.length > 0 ? [speak(l, "searchCut", { list: phrase, items: listOf(r.unsure, l) })] : [])
          ].join(" ")
          if (r.found.length === 0) return { say: notOn }
          const now = yield* Clock.currentTimeMillis
          const key = yield* undoKey
          const done = yield* engine.setStatus(r.list, r.found, to, to === "done" ? "complete" : "remove", key, now).pipe(Effect.mapError((e) => actionError(storeSentence(l, e, false))))
          if (isRefusal(done)) return yield* Effect.fail(actionError(speak(l, "unsaved")))
          const names = listOf(r.found.map((f) => f.value.text), l)
          const sentence = speak(l, to === "done" ? "completed" : "removed", { list: phrase, items: names })
          return { say: notOn === "" ? sentence : `${sentence} ${notOn}` }
        }))

      const complete = defineAction({
        id: "complete",
        label: "Tick off on a list",
        description: "Tick things off a household list because they were bought or done (\"I've got the bread\"). They stay readable as ticked off for a while. Several at once: \"bread and milk\". Not for taking something off without doing it (lists_remove).",
        examples: ["I've got the bread", "tick milk off the shopping list", "I called the plumber, tick it off the to-do list", "ik heb de melk gekocht", "vink brood af op de boodschappenlijst"],
        params: { item: Param.text({ label: "What to tick off", after: ["got", "bought", "tick", "check", "cross", "gekocht", "vink", "streep"], maxWords: 30 }), list: listParam },
        risk: "change",
        latency: "instant",
        run: tickOrRemove("done")
      })

      const remove = defineAction({
        id: "remove",
        label: "Take off a list",
        description: "Take things off a household list without ticking them off (\"we don't need eggs after all\"). Several at once: \"eggs and rice\". `lists_undo` puts them back.",
        examples: ["take eggs off the shopping list", "remove rice from the list", "we don't need butter, take it off", "haal eieren van de boodschappenlijst", "verwijder rijst van het lijstje"],
        params: { item: Param.text({ label: "What to take off", after: ["remove", "take", "delete", "haal", "verwijder", "schrap"], maxWords: 30 }), list: listParam },
        risk: "change",
        latency: "instant",
        run: tickOrRemove("removed")
      })

      // -- clear_done --------------------------------------------------------------------------------------------------
      const clearDone = defineAction({
        id: "clear_done",
        label: "Clear what is ticked off",
        description: `Take every ticked-off item off a household list (the shopping list unless another is named); open items stay. At most ${MAX_CLEAR} at a time.`,
        examples: ["clear the ticked-off items", "clear what's done on the to-do list", "haal het afgevinkte van de lijst", "ruim de boodschappenlijst op"],
        params: { list: listParam },
        risk: "change",
        latency: "instant",
        run: ({ list }) =>
          serial(Effect.gen(function*() {
            const l = lang()
            const target = chosen(list).list ?? SHOPPING
            const phrase = engine.phraseOf(target, l)
            const now = yield* Clock.currentTimeMillis
            const key = yield* undoKey
            const r = yield* engine.clear(target, key, now).pipe(Effect.mapError((e) => actionError(storeSentence(l, e, false))))
            if (isRefusal(r)) return yield* Effect.fail(actionError(speak(l, "unsaved")))
            if (r.count === 0) return { say: speak(l, "noneDone", { list: phrase }) }
            return { say: speak(l, r.more ? "clearedSome" : "cleared", { list: phrase, count: r.count }) }
          }))
      })

      // -- undo --------------------------------------------------------------------------------------------------------
      const undoAction = defineAction({
        id: "undo",
        label: "Undo the last list change",
        description: "Reverse the last change made to the lists in this conversation (an add, a tick, a removal, a new or deleted list), within a day.",
        examples: ["undo", "undo that", "no, one item", "maak dat ongedaan", "zet het terug"],
        params: {},
        risk: "change",
        latency: "instant",
        run: () =>
          serial(Effect.gen(function*() {
            const l = lang()
            const now = yield* Clock.currentTimeMillis
            const key = yield* undoKey
            const r = yield* engine.undoLast(key, now).pipe(Effect.mapError((e) => actionError(storeSentence(l, e, false))))
            if (r.result === "nothing" || !("list" in r)) return { say: speak(l, "nothingToUndo") }
            const phrase = listPhrase(r.list, r.row, l)
            if (r.result === "changed") return { say: speak(l, "undoChanged", { list: phrase }) }
            if (r.result === "partly") return { say: speak(l, "undonePartly", { list: phrase }) }
            if ("op" in r && r.op === "create") return { say: speak(l, "undoneCreate", { list: phrase }) }
            if ("op" in r && r.op === "delete") return { say: speak(l, "undoneDelete", { list: phrase }) }
            return { say: speak(l, "undoneList", { list: phrase }) }
          }))
      })

      // -- overview ----------------------------------------------------------------------------------------------------
      const overview = defineAction({
        id: "overview",
        label: "Say which lists there are",
        description: "Name the household's lists with how many open things each has.",
        examples: ["which lists do we have", "what lists are there", "welke lijsten hebben we"],
        params: {},
        speculative: true,
        latency: "instant",
        run: () =>
          serial(Effect.gen(function*() {
            const l = lang()
            const rows = yield* engine.loadLists.pipe(Effect.mapError((e) => actionError(storeSentence(l, e, true))))
            const live = engine.liveLists(rows)
            const entries = live.map((x) => say(texts, l, "overviewEntry", { list: listPhrase(x.id, x.row, l), count: x.row?.open ?? 0 }))
            return { say: speak(l, "overview", { count: live.length, items: listOf(entries, l, 8) }) }
          }))
      })

      // -- tools for the model only ------------------------------------------------------------------------------------
      /** A list named by the model, or a sentence when there is none of that name. */
      const listNamed = (name: string | undefined, l: Language): { readonly id: string } | { readonly sentence: string } => {
        if (name === undefined) return { id: SHOPPING }
        // "My camping list": there are no personal lists, so the household's list of that name.
        const id = engine.resolveList(name.replace(/^\s*(?:my|mijn)\s+/i, ""), l)
        return id === undefined ? { sentence: speak(l, "unknownList", { name, items: listOf(engine.listNames(l), l, 8) }) } : { id }
      }

      const updateTool = makeTool({
        name: "lists_update",
        description:
          "Change one item on a household list: rename it, set or clear its amount (\"make it two\"), set or clear its note, or put a ticked-off item back on the list. Name the item as it is on the list.",
        parameters: Schema.Struct({
          item: lineText(LISTS_LIMITS.textChars, "item").annotate({ description: "The item as it is on the list" }),
          list: Schema.optionalKey(lineText(NAME_CHARS + 20, "list").annotate({ description: "The list's name; default: the list the item is on" })),
          rename: Schema.optionalKey(lineText(LISTS_LIMITS.textChars, "rename").annotate({ description: "Its new text" })),
          amount: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(LISTS_LIMITS.maxAmount)).annotate({ description: "Its new amount" })),
          unit: Schema.optionalKey(StoredText(LISTS_LIMITS.unitChars).check(Schema.makeFilter((t: string) => isLine(t, LISTS_LIMITS.unitChars) || "unit: one short word")).annotate({
            description: "The amount's unit (g, kg, ml, l, pack, bottle, can, jar, bag, box, …); empty for a count"
          })),
          clearAmount: Schema.optionalKey(Schema.Boolean.annotate({ description: "Remove its amount" })),
          note: Schema.optionalKey(StoredText(LISTS_LIMITS.noteChars).check(Schema.makeFilter((t: string) => isLine(t, LISTS_LIMITS.noteChars) || "note: one line")).annotate({
            description: "Its new note; empty removes it"
          })),
          reopen: Schema.optionalKey(Schema.Boolean.annotate({ description: "Put a ticked-off item back on the list" }))
        }),
        risk: "change",
        latency: "instant",
        execute: (input) =>
          serial(Effect.gen(function*() {
            const l = lang()
            const unread = (e: StoreFailure) => toolError(storeSentence(l, e, true))
            yield* engine.loadLists.pipe(Effect.mapError(unread))
            let target: string | undefined
            if (input.list !== undefined) {
              const named = listNamed(input.list, l)
              if ("sentence" in named) return { spoken: named.sentence }
              target = named.id
            }
            const found = target === undefined
              ? yield* engine.findAnywhere(input.item, true).pipe(Effect.mapError(unread))
              : { list: target, ...(yield* engine.find(target, input.item, true).pipe(Effect.mapError(unread))) }
            if (found.row === undefined || found.list === undefined) {
              return { spoken: speak(l, found.cut ? "searchCut" : "notOnList", { list: engine.phraseOf(target ?? SHOPPING, l), items: input.item }) }
            }
            const hit = { list: found.list, row: found.row }
            const row = hit.row
            const quantity: Quantity | null | undefined = input.clearAmount === true
              ? null
              : input.amount !== undefined
              ? (input.unit === "" ? { amount: input.amount } : { amount: input.amount, ...((input.unit ?? row.value.quantity?.unit) !== undefined ? { unit: input.unit ?? row.value.quantity!.unit! } : {}) })
              : input.unit !== undefined && row.value.quantity !== undefined
              ? (input.unit === "" ? { amount: row.value.quantity.amount } : { amount: row.value.quantity.amount, unit: input.unit })
              : undefined
            const change = {
              ...(input.rename !== undefined && input.rename.trim() !== row.value.text ? { text: input.rename.trim() } : {}),
              ...(quantity !== undefined ? { quantity } : {}),
              ...(input.note !== undefined ? { note: input.note.trim() === "" ? null : input.note.trim() } : {}),
              ...(input.reopen === true && row.value.status === "done" ? { reopen: true } : {})
            }
            if (Object.keys(change).length === 0) return { spoken: speak(l, "nothingToChange") }
            const now = yield* Clock.currentTimeMillis
            const key = yield* undoKey
            const done = yield* engine.update(hit.list, row, change, key, now).pipe(Effect.mapError((e) => toolError(storeSentence(l, e, false))))
            const phrase = engine.phraseOf(hit.list, l)
            if (isRefusal(done)) return { spoken: done.reason === "full" ? speak(l, "full", { list: phrase, count: MAX_OPEN }) : speak(l, "unsaved") }
            return { spoken: speak(l, "updated", { list: phrase, items: sayItem(done.value.text, done.value.quantity, l) + (done.value.note !== undefined ? ` (${done.value.note})` : "") }) }
          }))
      })

      const createTool = makeTool({
        name: "lists_create",
        description: `Make a new household list with a name (\"camping packing\", \"gift ideas\"), optionally with its first items, split like lists_add. Every list is seen on every device. At most ${MAX_LIVE_LISTS} lists.`,
        parameters: Schema.Struct({
          name: lineText(NAME_CHARS, "name").annotate({ description: "The list's name, without the word \"list\"" }),
          kind: Schema.optionalKey(Schema.Literals(["shopping", "todo", "generic"]).annotate({ description: "What it is for; default generic" })),
          items: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000)).annotate({ description: "Its first items, as said" }))
        }),
        risk: "change",
        latency: "instant",
        execute: ({ name, kind, items: text }) =>
          serial(Effect.gen(function*() {
            const l = lang()
            const cleanName = name.replace(/\s+/g, " ").trim().replace(/\s+(list|lijst)$/i, "")
            if (normalise(cleanName) === "") return { spoken: speak(l, "badName", { count: NAME_CHARS }) }
            const things = text === undefined || text.trim() === "" ? [] : said(text, l)
            if (typeof things === "string") return { spoken: things }
            const now = yield* Clock.currentTimeMillis
            const key = yield* undoKey
            const r = yield* engine.create(cleanName, kind ?? "generic", things, key, now, l).pipe(Effect.mapError((e) => toolError(storeSentence(l, e, false))))
            if (isRefusal(r)) {
              if (r.reason === "taken") return { spoken: speak(l, "nameTaken", { name: cleanName }) }
              if (r.reason === "too-many") return { spoken: speak(l, "tooManyLists", { count: MAX_LIVE_LISTS }) }
              return { spoken: speak(l, "unsaved") }
            }
            const phrase = engine.phraseOf(r.id, l)
            return { spoken: r.added.length === 0 ? speak(l, "created", { list: phrase }) : speak(l, "createdWith", { list: phrase, items: listOf(r.added, l) }) }
          }))
      })

      const deleteTool = makeTool({
        name: "lists_delete",
        description: "Delete a named household list with everything on it. The shopping list and the to-do list cannot be deleted. lists_undo brings it back the same day.",
        parameters: Schema.Struct({ list: lineText(NAME_CHARS + 20, "list").annotate({ description: "The list's name" }) }),
        risk: "change",
        latency: "instant",
        execute: ({ list }) =>
          serial(Effect.gen(function*() {
            const l = lang()
            yield* engine.loadLists.pipe(Effect.mapError((e) => toolError(storeSentence(l, e, true))))
            const named = listNamed(list, l)
            if ("sentence" in named) return { spoken: named.sentence }
            const phrase = engine.phraseOf(named.id, l)
            if (named.id === SHOPPING || named.id === TODO) return { spoken: speak(l, "cannotDelete", { list: phrase }) }
            const now = yield* Clock.currentTimeMillis
            const key = yield* undoKey
            const r = yield* engine.deleteList(named.id, key, now).pipe(Effect.mapError((e) => toolError(storeSentence(l, e, false))))
            if (isRefusal(r)) return { spoken: speak(l, "unknownList", { name: list, items: listOf(engine.listNames(l), l, 8) }) }
            return { spoken: speak(l, "deleted", { list: phrase }) }
          }))
      })

      return {
        actions: [add, read, complete, remove, clearDone, undoAction, overview],
        tools: [updateTool, createTool, deleteTool],
        instructions:
          "Lists are the household's: everyone sees them on every device. There are no personal lists yet: \"my shopping list\" is the household's, and lists_add says so in its answer. Put everything said in one lists_add call; lists_undo reverses the last list change of this conversation."
      }
    })
})
