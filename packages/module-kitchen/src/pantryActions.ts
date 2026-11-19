// The pantry's typed actions (they run without the language model, from their examples, and the model gets each as
// the tool `kitchen_<id>`) and its two tools for product settings. Each change is one booking (`book`), spoken back
// with its amount so a word misheard is heard at once, and undoable from the same device.
import { ActionError, CurrentTurn, defineAction, makeTool, type ModuleHostApi, type ModuleStore, Param, type Row, type StoreTx, ToolError } from "@pva/core"
import { type Language, metricCupMl, parseQuantity, type Quantity, speakList, usCupMl } from "@pva/language"
import { homeLanguage, isLine, say } from "@pva/module-contracts"
import { Clock, Effect, Schema } from "effect"
import { type BaseUnit, bookings, MAX_AMOUNT, names, type Product, products, scan } from "./data.ts"
import {
  amountText, book, createProduct, drainForgotten, fits, FORGET_NOW, lastKnownText, listText, lowOf, overviewText, type Pantry, type PantrySettings, PRODUCT_PAGE,
  PRODUCT_SCAN, removeProduct, round, saidText, stockSentence, stockText, storeFailureText, undoable
} from "./pantry.ts"
import { texts, type TextKey, unitWords } from "./texts.ts"
import { cleanPhrase, KEY_CHARS, keyOf, readPhrase } from "./words.ts"

/** The most low products one answer reads: four pages of 25. */
export const LOW_SCAN = 100

/** What the pantry's actions read of the module's settings (all shared fields: a change restarts the module). */
export interface KitchenSettings extends PantrySettings {
  readonly cup: "metric" | "us"
}

export interface PantryDeps {
  readonly host: ModuleHostApi
  readonly store: ModuleStore
  readonly pantry: Pantry
  readonly settings: KitchenSettings
}

/** A spoken outcome, or a question: nothing was booked. */
type Outcome =
  | { readonly kind: "say"; readonly key: TextKey; readonly values?: Readonly<Record<string, string | number>> }
  | { readonly kind: "unknown"; readonly item: string }
  | { readonly kind: "booked"; readonly id: string; readonly before: Product; readonly after: Product; readonly created: boolean; readonly main: string }

const sayOf = (key: TextKey, values?: Readonly<Record<string, string | number>>): Outcome => ({ kind: "say", key, ...(values !== undefined ? { values } : {}) })

/** The product a name means, inside a transaction: one indexed read of its key. */
export const lookup = (tx: StoreTx, name: string): Row<Product> | undefined => {
  const key = keyOf(name)
  if (key === "") return undefined
  const [hit] = tx.collection(names).list({ where: { key }, limit: 1 })
  return hit === undefined ? undefined : tx.collection(products).get(hit.value.product)
}

/** An amount said alone ("2 kg", "a kilo", "twee pakken"), in either language. */
export const readAmount = (text: string, lang: Language, cupMl: number): Quantity | undefined => {
  const t = cleanPhrase(text)
  for (const l of [lang, lang === "nl" ? "en" : "nl"] as const) {
    const parsed = parseQuantity(t, l, { cupMl })
    if (parsed.kind === "ok") return parsed.value
  }
  return undefined
}

/** How much a quantity is in base units for this product, or why it is not an amount, or the question to ask. */
type Base =
  | { readonly kind: "ok"; readonly amount: number; readonly unit: BaseUnit }
  | { readonly kind: "rest" }
  | { readonly kind: "some" }
  /** In packages of a product whose package size is not known: no amount can be booked. */
  | { readonly kind: "packUnknown" }
  | { readonly kind: "ask"; readonly key: TextKey; readonly values: Readonly<Record<string, string>> }

const baseOf = (q: Quantity, product: Product | undefined, item: string, lang: Language): Base => {
  if (q.rest) return { kind: "rest" }
  if (q.dimension === "none" || q.dimension === "vague") return { kind: "some" }
  if (q.dimension === "pack") {
    if (product === undefined || q.amount === undefined) return { kind: "ask", key: "packSize", values: { item } }
    if (product.pack === undefined) return { kind: "packUnknown" }
    const amount = round(q.amount * product.pack)
    if (amount > MAX_AMOUNT) return { kind: "ask", key: "tooMuch", values: { item } }
    return { kind: "ok", amount, unit: product.unit }
  }
  if (q.base === undefined) return { kind: "ask", key: "unclear", values: {} }
  if (product !== undefined && product.unit !== q.base.unit) return { kind: "ask", key: "mismatch", values: { item, unit: unitWords[lang][product.unit] } }
  if (q.base.amount > MAX_AMOUNT) return { kind: "ask", key: "tooMuch", values: { item } }
  return { kind: "ok", amount: q.base.amount, unit: q.base.unit }
}

/** A name at the start of a sentence. */
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** A name a person said, as a product's name: one line, at most `KEY_CHARS`, with a key. */
const nameOk = (name: string) => isLine(name, KEY_CHARS) && keyOf(name) !== ""

/** The `what` of an action: free text from the sentence ("a kilo of rice"), one line. */
const whatParam = (label: string, after: ReadonlyArray<string>) => Param.text({ label, after, maxWords: 10 })

export const pantryActions = (deps: PantryDeps) => {
  const { pantry, store, settings } = deps
  const cupMl = settings.cup === "us" ? usCupMl : metricCupMl
  const lang = () => homeLanguage(deps.host.view())
  const deviceOf = Effect.map(CurrentTurn, (t) => t?.deviceId)

  /** Say the outcome of a booking transaction, after it committed, and bring the shopping list into line. */
  const finish = (outcome: Outcome, l: Language) =>
    Effect.gen(function*() {
      if (outcome.kind === "say") return { say: say(texts, l, outcome.key, outcome.values) }
      if (outcome.kind === "unknown") {
        const suggestion = yield* pantry.suggest(outcome.item)
        return { say: suggestion !== undefined ? say(texts, l, "unknownMaybe", { item: outcome.item, suggestion }) : say(texts, l, "unknown", { item: outcome.item }) }
      }
      // A product made by this call was not on the list before it.
      const list = yield* pantry.followList(outcome.id, outcome.created ? undefined : outcome.before, outcome.after.name, settings, l)
      return { say: list === undefined ? outcome.main : `${outcome.main} ${list}` }
    })

  const transact = (l: Language, f: (tx: StoreTx, now: number) => Outcome) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      return yield* store.transaction((tx) => f(tx, now)).pipe(Effect.mapError((e) => new ActionError({ message: storeFailureText(e, l, "unsaved") })))
    })

  /** "Okay." and what there is now, for a change that left the stock unknown. */
  const okayUnsure = (after: Product, l: Language) => `${say(texts, l, "okay")} ${stockSentence(after, l)}`

  const add = defineAction({
    id: "stock_add",
    label: "Add to the pantry",
    description:
      "Book food bought or put away into the pantry, with how much (\"a kilo of rice\", \"six eggs\"). Only with a pantry cue (bought, put in the cupboard, add to the pantry); a bare \"add milk\" is the shopping list, not this.",
    examples: ["I bought a kilo of rice", "add two litres of milk to the pantry", "we got six eggs", "ik heb een kilo rijst gekocht", "voeg twee liter melk toe aan de voorraad"],
    params: { what: whatParam("What and how much", ["bought", "add", "added", "got", "purchased", "kocht", "heb", "voeg"]) },
    risk: "change",
    run: ({ what }) =>
      Effect.gen(function*() {
        const l = lang()
        const device = yield* deviceOf
        const r = readPhrase(what, l, cupMl)
        if (r.kind === "several") return { say: say(texts, l, "several") }
        if (r.kind === "unclear") return { say: say(texts, l, "unclear") }
        if (!nameOk(r.item)) return { say: say(texts, l, "badName") }
        const outcome = yield* transact(l, (tx, now): Outcome => {
          const row = lookup(tx, r.item)
          const item = row?.value.name ?? r.item
          const common = { ...(device !== undefined ? { device } : {}) }
          let base: Base
          let said: string
          if (r.kind === "item") {
            if (row?.value.pack === undefined) return sayOf("howMuchAdd", { item })
            base = { kind: "ok", amount: row.value.pack, unit: row.value.unit }
            said = amountText(row.value.pack, row.value.unit, false, l, item)
          } else {
            base = baseOf(r.quantity, row?.value, item, l)
            said = base.kind === "ok" ? saidText(r.quantity, base.amount, base.unit, l, item) : ""
          }
          if (base.kind === "ask") return sayOf(base.key, base.values)
          if (base.kind === "rest") return sayOf("howMuchAdd", { item })
          // "Some" or packages of an unknown size: something was added, but not how much. Booked, and the stock is unknown.
          if (base.kind === "some" || base.kind === "packUnknown") {
            if (row === undefined) return sayOf("howMuchAdd", { item })
            const b = book(tx, row, { kind: "add", delta: 0, approx: true, said: r.kind === "amount" ? r.quantity.said : "", ...common }, now)
            const main = base.kind === "packUnknown" ? say(texts, l, "packUnknownBooked", { item }) : say(texts, l, "addedSome", { item })
            return { kind: "booked", id: row.id, ...b, created: false, main }
          }
          const target = row ?? createProduct(tx, r.item, base.unit)
          if (!fits(target.value, base.amount)) return sayOf("tooMuch", { item })
          const approx = r.kind === "amount" && r.quantity.approx
          const b = book(tx, target, { kind: "add", delta: base.amount, approx, said: r.kind === "amount" ? r.quantity.said : said, ...common }, now)
          const main = row === undefined
            ? `${say(texts, l, "addedNew", { added: said, item: b.after.name })}${b.after.unknown ? ` ${stockSentence(b.after, l)}` : ""}`
            : `${say(texts, l, "added", { added: said })} ${stockSentence(b.after, l)}`
          return { kind: "booked", id: target.id, ...b, created: row === undefined, main }
        })
        return yield* finish(outcome, l)
      })
  })

  const use = defineAction({
    id: "stock_use",
    label: "Take from the pantry",
    description: "Book food used, eaten or thrown away (\"about 250 grams of rice\", \"some of the cheese\", \"the rest of the milk\"). Never below zero.",
    examples: ["I used about 250 grams of rice", "we used two eggs", "I used some of the cheese", "ik heb ongeveer 250 gram rijst gebruikt", "we hebben twee eieren gebruikt"],
    params: { what: whatParam("What and how much", ["used", "use", "ate", "eaten", "finished", "heb", "hebben"]) },
    risk: "change",
    run: ({ what }) =>
      Effect.gen(function*() {
        const l = lang()
        const device = yield* deviceOf
        const r = readPhrase(what, l, cupMl)
        if (r.kind === "several") return { say: say(texts, l, "several") }
        if (r.kind === "unclear") return { say: say(texts, l, "unclear") }
        const outcome = yield* transact(l, (tx, now): Outcome => {
          const row = lookup(tx, r.item)
          if (row === undefined) return { kind: "unknown", item: r.item }
          const p = row.value
          if (r.kind === "item") return sayOf("howMuchUse", { item: p.name })
          const base = baseOf(r.quantity, p, p.name, l)
          if (base.kind === "ask") return sayOf(base.key, base.values)
          const common = { said: r.quantity.said, ...(device !== undefined ? { device } : {}) }
          const booked = (b: ReturnType<typeof book>, main: string): Outcome => ({ kind: "booked", id: row.id, ...b, created: false, main })
          if (base.kind === "some" || base.kind === "packUnknown") {
            const b = book(tx, row, { kind: "use", delta: 0, approx: true, ...common }, now)
            return booked(b, base.kind === "packUnknown" ? say(texts, l, "packUnknownUsed", { item: p.name }) : say(texts, l, "uncertain", { item: p.name }))
          }
          if (base.kind === "rest") {
            const b = book(tx, row, { kind: "use", delta: -p.stock, approx: false, unknown: false, ...common }, now)
            return booked(b, say(texts, l, "none", { item: p.name }))
          }
          if (base.amount > p.stock) {
            // More than is on record. Known: the record was wrong, and it is none now, said so. Unknown: it was only a
            // last known amount, so it stays unknown.
            if (p.unknown) return booked(book(tx, row, { kind: "use", delta: -p.stock, approx: r.quantity.approx, ...common }, now), "")
            const b = book(tx, row, { kind: "use", delta: -p.stock, approx: false, unknown: false, ...common }, now)
            return booked(b, p.stock === 0 ? say(texts, l, "none", { item: p.name }) : say(texts, l, "overspent", { item: p.name, had: stockText(p, l) }))
          }
          const b = book(tx, row, { kind: "use", delta: -base.amount, approx: r.quantity.approx, ...common }, now)
          if (b.after.unknown) return booked(b, okayUnsure(b.after, l))
          return booked(b, b.after.stock <= 0 ? say(texts, l, "none", { item: p.name }) : say(texts, l, "left", { total: stockText(b.after, l) }))
        })
        const fixed = outcome.kind === "booked" && outcome.main === "" ? { ...outcome, main: okayUnsure(outcome.after, l) } : outcome
        return yield* finish(fixed, l)
      })
  })

  const out = defineAction({
    id: "stock_out",
    label: "Out of something",
    description: "Set a product's stock to none: it ran out (\"we're out of rice\"). Puts it on the shopping list.",
    examples: ["we're out of rice", "we ran out of milk", "there are no eggs left", "we hebben geen rijst meer", "de melk is op"],
    params: { what: whatParam("What ran out", ["of", "no", "geen", "de", "het"]) },
    risk: "change",
    run: ({ what }) =>
      Effect.gen(function*() {
        const l = lang()
        const device = yield* deviceOf
        const r = readPhrase(what, l, cupMl)
        if (r.kind === "several") return { say: say(texts, l, "several") }
        if (r.kind === "unclear") return { say: say(texts, l, "unclear") }
        const outcome = yield* transact(l, (tx, now): Outcome => {
          const row = lookup(tx, r.item)
          if (row === undefined) return { kind: "unknown", item: r.item }
          const b = book(tx, row, { kind: "set", delta: -row.value.stock, approx: false, unknown: false, said: cleanPhrase(what).slice(0, 80), ...(device !== undefined ? { device } : {}) }, now)
          return { kind: "booked", id: row.id, ...b, created: false, main: say(texts, l, "none", { item: row.value.name }) }
        })
        return yield* finish(outcome, l)
      })
  })

  const set = defineAction({
    id: "stock_set",
    label: "Correct the stock",
    description:
      "Say how much of a product there is now, replacing what was on record (\"there's a kilo of rice left\"). An exact amount makes the stock known again; \"about\" keeps it approximate. Also for something not yet in the pantry.",
    examples: ["there is about a kilo of rice left", "we have two litres of milk left", "er is nog ongeveer een kilo rijst", "we hebben nog twee liter melk"],
    params: { what: whatParam("How much of what", ["is", "are", "have", "nog"]) },
    risk: "change",
    run: ({ what }) =>
      Effect.gen(function*() {
        const l = lang()
        const device = yield* deviceOf
        const r = readPhrase(what, l, cupMl)
        if (r.kind === "several") return { say: say(texts, l, "several") }
        if (r.kind === "unclear") return { say: say(texts, l, "unclear") }
        if (!nameOk(r.item)) return { say: say(texts, l, "badName") }
        const outcome = yield* transact(l, (tx, now): Outcome => {
          const row = lookup(tx, r.item)
          const item = row?.value.name ?? r.item
          if (r.kind === "item") return sayOf("howMuchSet", { item })
          const base = baseOf(r.quantity, row?.value, item, l)
          if (base.kind === "ask") return sayOf(base.key, base.values)
          if (base.kind === "packUnknown") return sayOf("packSize", { item })
          if (base.kind !== "ok") return sayOf("howMuchSet", { item })
          const target = row ?? createProduct(tx, r.item, base.unit)
          const approx = r.quantity.approx
          const b = book(tx, target, { kind: "set", delta: round(base.amount - target.value.stock), approx, unknown: approx, said: r.quantity.said, ...(device !== undefined ? { device } : {}) }, now)
          const main = approx
            ? say(texts, l, "setApprox", { total: lastKnownText(b.after, l) })
            : b.after.stock <= 0
            ? say(texts, l, "none", { item: b.after.name })
            : say(texts, l, "setTo", { total: stockText(b.after, l) })
          return { kind: "booked", id: target.id, ...b, created: row === undefined, main }
        })
        return yield* finish(outcome, l)
      })
  })

  const query = defineAction({
    id: "stock_query",
    label: "What is in the pantry",
    description: "How much of one product there is (\"how much rice is left\"), or, with no product, what is in the pantry. Reads; changes nothing.",
    examples: ["how much rice is left", "how much milk do we have", "what's in the pantry", "hoeveel rijst hebben we nog", "wat is er in de voorraad"],
    params: { item: Param.text({ label: "Which product", after: ["much", "many", "hoeveel"], maxWords: 6, optional: true }) },
    speculative: true,
    run: ({ item }) =>
      Effect.gen(function*() {
        const l = lang()
        const unreadable = () => new ActionError({ message: say(texts, l, "unreadable") })
        const name = item === undefined ? "" : cleanPhrase(item)
        if (name === "" || keyOf(name) === "") {
          const { rows, cut } = yield* pantry.all().pipe(Effect.mapError(unreadable))
          // A product of unknown stock is named too, with what was last known: it may be there.
          const shown = rows.filter((r) => r.value.stock > 0 || r.value.unknown)
          const cutNote = cut ? ` ${say(texts, l, "pantryCut", { count: PRODUCT_SCAN })}` : ""
          if (shown.length === 0) return { say: cut ? say(texts, l, "emptyCut", { count: PRODUCT_SCAN }) : say(texts, l, "empty") }
          return { say: `${say(texts, l, "overview", { list: listText(shown.map((r) => overviewText(r.value, l)), l, cut) })}${cutNote}` }
        }
        const row = yield* pantry.find(name).pipe(Effect.mapError(unreadable))
        if (row === undefined) return yield* finish({ kind: "unknown", item: name }, l)
        const p = row.value
        if (p.unknown) return { say: p.stock > 0 ? say(texts, l, "haveUnsure", { item: p.name, total: lastKnownText(p, l) }) : say(texts, l, "haveUnsureNone", { item: p.name }) }
        return { say: p.stock > 0 ? say(texts, l, "have", { total: stockText(p, l) }) : say(texts, l, "haveNone", { item: p.name }) }
      })
  })

  const low = defineAction({
    id: "stock_low",
    label: "What is running low",
    description: "The products below their minimum or out. Reads; changes nothing.",
    examples: ["what are we running low on", "what do we need", "what's running out", "wat is er bijna op", "wat moeten we kopen"],
    params: {},
    speculative: true,
    run: () =>
      Effect.gen(function*() {
        const l = lang()
        const { rows, cut } = yield* scan(pantry.productStore, { where: { low: true }, orderBy: { field: "key", direction: "asc" } }, PRODUCT_PAGE, LOW_SCAN).pipe(
          Effect.mapError(() => new ActionError({ message: say(texts, l, "unreadable") }))
        )
        if (rows.length === 0) return { say: say(texts, l, "lowNone") }
        const main = say(texts, l, "low", { list: listText(rows.map((r) => r.value.name), l, cut) })
        return { say: cut ? `${main} ${say(texts, l, "lowCut", { count: LOW_SCAN })}` : main }
      })
  })

  const undo = defineAction({
    id: "undo",
    label: "Undo the last pantry change",
    description:
      "Reverse the last pantry booking made on this device, when it was made in the last ten minutes and nothing else was booked for that product since. One step only: after an undo there is nothing more to undo; otherwise set the amount instead.",
    examples: ["undo that", "undo the last pantry change", "that was wrong, undo it", "maak dat ongedaan", "draai dat terug"],
    params: {},
    risk: "change",
    run: () =>
      Effect.gen(function*() {
        const l = lang()
        const device = yield* deviceOf
        if (device === undefined) return { say: say(texts, l, "undoNoDevice") }
        const outcome = yield* transact(l, (tx, now): Outcome => {
          const u = undoable(tx, device, now)
          if (u.kind === "nothing") return sayOf("nothingToUndo")
          if (u.kind === "tooOld") return sayOf("undoTooOld", { item: u.product.value.name })
          if (u.kind === "changedSince") return sayOf("undoChanged", { item: u.product.value.name, Item: capital(u.product.value.name) })
          const row = u.product
          const wasOnly = tx.collection(bookings).list({ where: { product: row.id }, orderBy: { field: "at", direction: "asc" }, limit: 2 }).length === 1
          // Nothing was booked for the product since: the reversal is exact, and the stock is known or unknown as it was.
          const b = book(tx, row, { kind: "undo", delta: -u.booking.value.delta, approx: false, unknown: u.booking.value.unknownBefore, device }, now)
          const p = row.value
          // The booking that made the product was its only one, and nothing was set for it: the product goes with it
          // (a misheard "a kilo of ice" leaves nothing behind).
          if (wasOnly && b.after.stock === 0 && !b.after.unknown && p.min === undefined && p.pack === undefined && p.aliases.length === 0) {
            removeProduct(tx, row.id)
            return sayOf("undoneGone", { item: p.name })
          }
          return { kind: "booked", id: row.id, ...b, created: false, main: `${say(texts, l, "undone")} ${stockSentence(b.after, l)}` }
        })
        return yield* finish(outcome, l)
      })
  })

  const keepMinimum = defineAction({
    id: "keep_minimum",
    label: "Keep a minimum in stock",
    description: "Always keep at least this much of a product (\"always keep two kilos of rice\"); below it, it goes on the shopping list.",
    examples: ["always keep two kilos of rice", "keep at least six eggs in the house", "houd altijd twee kilo rijst in huis", "zorg dat er altijd zes eieren zijn"],
    params: { what: whatParam("How much of what", ["keep", "altijd", "minstens"]) },
    risk: "change",
    run: ({ what }) =>
      Effect.gen(function*() {
        const l = lang()
        const r = readPhrase(what, l, cupMl)
        if (r.kind === "several") return { say: say(texts, l, "several") }
        if (r.kind === "unclear") return { say: say(texts, l, "unclear") }
        if (!nameOk(r.item)) return { say: say(texts, l, "badName") }
        const outcome = yield* transact(l, (tx): Outcome => {
          const row = lookup(tx, r.item)
          const item = row?.value.name ?? r.item
          if (r.kind === "item") return sayOf("howMuchMin", { item })
          const base = baseOf(r.quantity, row?.value, item, l)
          if (base.kind === "ask") return sayOf(base.key, base.values)
          if (base.kind === "packUnknown") return sayOf("packSize", { item })
          if (base.kind !== "ok") return sayOf("howMuchMin", { item })
          const target = row ?? createProduct(tx, r.item, base.unit)
          const after: Product = { ...target.value, min: base.amount, low: lowOf(target.value.stock, base.amount) }
          tx.collection(products).update(target.id, () => after)
          return { kind: "booked", id: target.id, before: target.value, after, created: row === undefined, main: say(texts, l, "minimumSet", { min: amountText(base.amount, after.unit, false, l, after.name) }) }
        })
        return yield* finish(outcome, l)
      })
  })

  return [add, use, out, set, query, low, undo, keepMinimum]
}

/** The product settings tools, for the model: change a product's minimum, package size or names, or forget it. */
export const productTools = (deps: PantryDeps) => {
  const { pantry, store, settings } = deps
  const cupMl = settings.cup === "us" ? usCupMl : metricCupMl
  const lang = () => homeLanguage(deps.host.view())
  const Text = (max: number, description: string) =>
    Schema.String.check(Schema.makeFilter((t: string) => (isLine(t, max) && t.trim() !== "") || `one line of 1 to ${max} characters`)).annotate({ description })

  const productSet = makeTool({
    name: "kitchen_product_set",
    description:
      "Change a pantry product's settings: the minimum to keep (below it, it goes on the shopping list), how much one package holds (so \"two bags\" can be booked), or another name it answers to. Give only what changes.",
    parameters: Schema.Struct({
      item: Text(KEY_CHARS, "The product, as it is called in the pantry"),
      minimum: Schema.optionalKey(Text(80, "The least to keep, with its unit: \"2 kg\", \"6\"")),
      noMinimum: Schema.optionalKey(Schema.Boolean.annotate({ description: "Remove the minimum" })),
      package: Schema.optionalKey(Text(80, "How much one package holds, with its unit: \"1 kg\", \"500 ml\", \"12\"")),
      alias: Schema.optionalKey(Text(KEY_CHARS, "Another name for the product (\"rijst\")"))
    }),
    risk: "change",
    execute: (input) =>
      Effect.gen(function*() {
        const l = lang()
        const failed = (e: unknown) => new ToolError({ message: storeFailureText(e, l, "unsaved") })
        type Result = { readonly spoken: string } | { readonly unknown: string } | { readonly booked: { readonly id: string; readonly before: Product; readonly after: Product; readonly details: Array<string> } }
        const result = yield* store.transaction((tx): Result => {
          const row = lookup(tx, input.item)
          if (row === undefined) return { unknown: input.item }
          const p = row.value
          const shown: { min?: string; pack?: string; alias?: string } = {}
          let next: Product = p
          const asBase = (text: string, allowPack: boolean, exact: boolean): number | { readonly spoken: string } => {
            const q = readAmount(text, l, cupMl)
            if (q === undefined) return { spoken: say(texts, l, "unclear") }
            // A package size is exact or it is not kept: "about 900 grams" would turn two bags into an exact amount.
            if (exact && q.approx) return { spoken: say(texts, l, "packApprox", { item: p.name }) }
            const { pack: _pack, ...noPack } = next
            const b = baseOf(q, allowPack ? next : noPack, p.name, l)
            if (b.kind === "ask") return { spoken: say(texts, l, b.key, b.values) }
            if (b.kind === "packUnknown") return { spoken: say(texts, l, "packSize", { item: p.name }) }
            if (b.kind !== "ok" || b.amount <= 0) return { spoken: say(texts, l, "unclear") }
            return b.amount
          }
          if (input.package !== undefined) {
            const pack = asBase(input.package, false, true)
            if (typeof pack !== "number") return pack
            next = { ...next, pack }
            shown.pack = say(texts, l, "detailPack", { pack: amountText(pack, p.unit, false, l) })
          }
          if (input.noMinimum === true) {
            const { min: _min, ...rest } = next
            next = { ...rest, low: lowOf(next.stock, undefined) }
            shown.min = say(texts, l, "detailNoMin")
          } else if (input.minimum !== undefined) {
            const min = asBase(input.minimum, true, false)
            if (typeof min !== "number") return min
            next = { ...next, min, low: lowOf(next.stock, min) }
            shown.min = say(texts, l, "detailMin", { min: amountText(min, p.unit, false, l) })
          }
          if (input.alias !== undefined) {
            const key = keyOf(input.alias)
            if (key === "") return { spoken: say(texts, l, "badName") }
            const taken = tx.collection(names).list({ where: { key }, limit: 1 })[0]
            if (taken !== undefined && taken.value.product !== row.id) return { spoken: say(texts, l, "aliasTaken", { alias: input.alias }) }
            if (taken === undefined) {
              if (next.aliases.length >= 6) return { spoken: say(texts, l, "aliasesFull", { item: p.name }) }
              tx.collection(names).insert({ key, product: row.id })
              next = { ...next, aliases: [...next.aliases, key] }
            }
            shown.alias = say(texts, l, "detailAlias", { alias: input.alias })
          }
          // Said in a fixed order, whatever order they were worked out in (a minimum in packages needs the package first).
          const details = [shown.min, shown.pack, shown.alias].filter((d): d is string => d !== undefined)
          if (details.length === 0) return { spoken: say(texts, l, "productNothing", { item: p.name }) }
          tx.collection(products).update(row.id, () => next, { expectRev: row.rev })
          return { booked: { id: row.id, before: p, after: next, details } }
        }).pipe(Effect.mapError(failed))
        if ("spoken" in result) return result
        if ("unknown" in result) {
          const suggestion = yield* pantry.suggest(result.unknown)
          return { spoken: suggestion !== undefined ? say(texts, l, "unknownMaybe", { item: result.unknown, suggestion }) : say(texts, l, "unknown", { item: result.unknown }) }
        }
        const { id, before, after, details } = result.booked
        const main = say(texts, l, "productSaved", { item: after.name.charAt(0).toUpperCase() + after.name.slice(1), details: speakList(details, l, { max: 4 }) ?? "" })
        const list = yield* pantry.followList(id, before, after.name, settings, l)
        return { spoken: list === undefined ? main : `${main} ${list}` }
      })
  })

  const forget = makeTool({
    name: "kitchen_product_forget",
    description: "Take a product out of the pantry altogether, with its history: for a product that was made by mistake or is no longer kept.",
    parameters: Schema.Struct({ item: Text(KEY_CHARS, "The product, as it is called in the pantry") }),
    risk: "change",
    execute: ({ item }) =>
      Effect.gen(function*() {
        const l = lang()
        const failed = (e: unknown) => new ToolError({ message: storeFailureText(e, l, "unsaved") })
        // The product and its names go at once, with its first bookings; the rest of its history goes in steps of
        // their own, and whatever a restart leaves is finished by the nightly job (its `forgotten` row says so).
        const gone = yield* store.transaction((tx) => {
          const row = lookup(tx, item)
          if (row === undefined) return undefined
          return { id: row.id, name: row.value.name, left: removeProduct(tx, row.id) }
        }).pipe(Effect.mapError(failed))
        if (gone === undefined) {
          const suggestion = yield* pantry.suggest(item)
          return { spoken: suggestion !== undefined ? say(texts, l, "unknownMaybe", { item, suggestion }) : say(texts, l, "unknown", { item }) }
        }
        if (gone.left) yield* drainForgotten(store, gone.id, FORGET_NOW).pipe(Effect.orElseSucceed(() => ({ removed: 0, done: false })))
        return { spoken: say(texts, l, "forgotten", { item: gone.name.charAt(0).toUpperCase() + gone.name.slice(1) }) }
      })
  })

  return [productSet, forget]
}

/** Every product, bounded, for tests and the nightly job. */
export const allProducts = (store: ModuleStore) => scan(store.collection(products), { orderBy: { field: "key", direction: "asc" } }, PRODUCT_PAGE, PRODUCT_SCAN)
