import { CurrentTurn, type HostView, type ModulePresent, type PresentError, type PresentHandle, type Presentation, type PresentPress, type Row, type StoreFailure } from "@pva/core"
import { homeLanguage, type Language, say } from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Clock, Effect } from "effect"
import { type Item, type ListRow, MAX_PINS, type Pin, pinIdOf, pinKeyOf, pins, SHOPPING, TODO } from "./data.ts"
import { type Engine, isRefusal, speak } from "./engine.ts"
import { sayItem } from "./parse.ts"
import { texts } from "./texts.ts"

// ---------------------------------------------------------------------------------------------------------------------
// The checklist: a list's open items on a screen, with ticks (docs/PRESENTING.md; docs/modules/lists.md "Checklists")

/** The press handler's name (registered in `shared`; the presentation names it). */
export const HANDLER = "lists"
/** The items a checklist shows (the presentation's bound), the longest title, item and spoken fallback. */
export const SHOWN_ITEMS = 12
const TITLE_CHARS = 60
const ITEM_CHARS = 80
const SPOKEN_CHARS = 300
/** The spoken fallback names items while its sentence stays inside this (leaving room for the rest of the sentence). */
const SPOKEN_ITEMS_CHARS = 200
/** A shown checklist stays until it is closed or this long after it last changed (the host's longest lifetime). */
export const PIN_MS = 24 * 3_600_000
/** A checklist closed after a restart (no handle any more) is replaced by an empty one that the host ends after this (its shortest lifetime). */
export const CLOSE_MS = 3_000

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Text from the lists made safe for a presentation: one line, no control or direction characters, no half characters. */
export const oneLine = (text: string): string => text.replace(LONE_SURROGATE, "").replace(NOT_ONE_LINE, " ").replace(/\s+/g, " ").trim()

/** At most `max` UTF-16 units of the text as one line, cut at a character boundary, the last one "…" when it was cut. The one cutting function of the checklist. */
export const cutAt = (text: string, max: number): string => {
  const line = oneLine(text)
  if (line.length <= max) return line
  let end = max - 1
  const c = line.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${line.slice(0, end).trimEnd()}…`
}

/** What a checklist shows of a list now. */
export interface Built {
  readonly presentation: Presentation
  /** What a screen would hold, for comparing with what is shown (a change of any of it is an update). */
  readonly signature: string
  readonly open: number
}

/** The result of putting a checklist on a screen. */
export type Shown =
  | { readonly kind: "shown"; readonly spoken: string }
  | { readonly kind: "not-shown"; readonly spoken: string; readonly why: string | undefined }
  | { readonly kind: "gone" }
  | { readonly kind: "limit" }
  | { readonly kind: "failed" }

/** A list's name as a title: the default lists' names in the household's language, a named list's own. */
const titleOf = (list: string, row: ListRow | undefined, l: Language) =>
  list === SHOPPING ? say(texts, l, "titleShopping") : list === TODO ? say(texts, l, "titleTodo") : row?.name ?? list

const speakOf = (things: ReadonlyArray<string>, lang: Language, max: number) => speakList(things.slice(0, 100), lang, { max: Math.max(2, max) }) ?? things.slice(0, max).join(", ")

/** The items a spoken fallback names (whole items within a character budget) and "and N more" for the rest of the list. */
const spokenWords = (named: ReadonlyArray<string>, total: number, lang: Language, max: number): string => {
  let take = Math.min(named.length, max)
  const fits = (n: number) => named.slice(0, n).reduce((sum, t) => sum + t.length + 2, 0) <= SPOKEN_ITEMS_CHARS
  while (take > 1 && !fits(take)) take--
  const shown = named.slice(0, take)
  const rest = total - shown.length
  return rest <= 0 ? speakOf(shown, lang, Math.max(2, shown.length)) : say(texts, lang, "more", { items: shown.join(", "), count: rest })
}

export const makeChecklists = (ctx: {
  readonly present: ModulePresent
  readonly host: { readonly view: () => HostView }
  readonly settingsFor: (assistantId: string | undefined) => { readonly readItems: number } | undefined
}, engine: Engine) => {
  const lang = () => homeLanguage(ctx.host.view())
  const pinStore = engine.rawStore.collection(pins)
  /** The newest handle of each pin made in this run (a restart forgets them; the host keeps what is pinned). */
  const handles = new Map<string, PresentHandle>()
  /** What each pin was last shown as, so a change that leaves the screen as it is sends nothing. */
  const signatures = new Map<string, string>()

  const readItemsFor = (assistantId: string | undefined) => ctx.settingsFor(assistantId)?.readItems ?? 5

  /** The list as a checklist now, or `undefined` when it is gone or deleted. Under the module's permit. */
  const build = (list: string, l: Language, readItems: number): Effect.Effect<Built | undefined, StoreFailure> =>
    Effect.gen(function*() {
      const row = yield* engine.listStore.get(list)
      const isDefault = list === SHOPPING || list === TODO
      if ((row === undefined && !isDefault) || row?.value.deletedAt !== undefined) return undefined
      const open = row?.value.open ?? 0
      const scanned = yield* engine.scan(list, "open", SHOWN_ITEMS)
      const rows: ReadonlyArray<Row<Item>> = scanned.rows
      // What a screen does not show is counted, never hidden: "(+3 more)" in the title, and the spoken text says it too.
      const more = Math.max(rows.length < open ? open - rows.length : 0, scanned.cut ? 1 : 0)
      const name = titleOf(list, row?.value, l)
      const tail = more > 0 ? say(texts, l, "titleMore", { count: more }) : ""
      const title = `${cutAt(name, TITLE_CHARS - tail.length)}${tail}`
      const items = rows.map((r) => ({ id: r.id, text: cutAt(sayItem(r.value.text, r.value.quantity, l), ITEM_CHARS), done: false }))
      const phrase = engine.phraseOf(list, l)
      const named = rows.map((r) => cutAt(sayItem(r.value.text, r.value.quantity, l), 60))
      const total = Math.max(open, rows.length)
      const words = spokenWords(named, total, l, readItems)
      const spoken = cutAt(open === 0 && rows.length === 0 ? speak(l, "empty", { list: phrase }) : total === 1 ? speak(l, "readOne", { list: phrase, items: words }) : speak(l, "readOpen", { list: phrase, count: total, items: words }), SPOKEN_CHARS)
      const presentation: Presentation = { kind: "list", title, style: "checklist", items, spoken, handler: HANDLER }
      return { presentation, signature: JSON.stringify([title, items, spoken]), open }
    })

  /** Every pin (at most `MAX_PINS`, with a few spare for rows left by a failed removal). */
  const pinRows = pinStore.list({ limit: MAX_PINS * 2 + 1 })

  const upsertPin = (pin: Pin) =>
    engine.rawStore.transaction((tx) => {
      const c = tx.collection(pins)
      const id = pinIdOf(pin.list, pin.device)
      if (c.get(id) === undefined) c.insert(pin, { id })
      else c.update(id, () => pin)
    })
  const removePin = (id: string) =>
    Effect.tap(engine.rawStore.transaction((tx) => void (tx.collection(pins).get(id) !== undefined && tx.collection(pins).remove(id))), () => Effect.sync(() => {
      handles.delete(id)
      signatures.delete(id)
    }))

  type Tried<A> = { readonly ok: A } | { readonly err: PresentError }
  const tried = <A>(effect: Effect.Effect<A, PresentError>): Effect.Effect<Tried<A>> =>
    effect.pipe(Effect.map((ok): Tried<A> => ({ ok })), Effect.catch((err: PresentError) => Effect.succeed<Tried<A>>({ err })))

  /**
   * Show a list as a checklist on a device (again: the same key replaces it in place, on the same page). A device that
   * does not show it keeps nothing: no pin is made. The host bounds what is shown at once (eight of this module), so
   * there are never more pins than that. Under the module's permit.
   */
  const showLocked = (list: string, device: string, l: Language, readItems: number, now: number): Effect.Effect<Shown, StoreFailure> =>
    Effect.gen(function*() {
      const built = yield* build(list, l, readItems)
      if (built === undefined) return { kind: "gone" } as const
      const id = pinIdOf(list, device)
      const result = yield* tried(ctx.present.show({ device }, built.presentation, { lifetime: "pinned", key: pinKeyOf(list, device), expiresInMs: PIN_MS }))
      if ("err" in result) return result.err.reason === "limit" ? ({ kind: "limit" } as const) : ({ kind: "failed" } as const)
      const handle = result.ok
      const here = handle.outcome.devices.find((d) => d.deviceId === device)
      if (here?.shown !== true) {
        // The device cannot show it (no screen, a page that cannot draw a list, offline): nothing is kept for it.
        yield* Effect.ignore(handle.dismiss)
        yield* Effect.ignore(removePin(id))
        return { kind: "not-shown", spoken: built.presentation.spoken, why: here?.why } as const
      }
      const kept = yield* Effect.exit(upsertPin({ list, device, key: pinKeyOf(list, device), until: now + PIN_MS }))
      if (kept._tag === "Failure") {
        yield* Effect.ignore(handle.dismiss)
        return { kind: "failed" } as const
      }
      handles.set(id, handle)
      signatures.set(id, built.signature)
      return { kind: "shown", spoken: built.presentation.spoken } as const
    })

  /**
   * Take a pinned checklist down and forget it. With the handle of this run it is dismissed; after a restart (no handle)
   * it is replaced by an empty one the host ends after `CLOSE_MS`, by the same key. A host that is busy leaves the pin
   * to be closed by the next change or request (`false`).
   */
  const endLocked = (pin: Row<Pin>, l: Language): Effect.Effect<boolean, StoreFailure> =>
    Effect.gen(function*() {
      const handle = handles.get(pin.id)
      if (handle !== undefined) {
        const r = yield* tried(handle.dismiss)
        if ("err" in r && (r.err.reason === "busy" || r.err.reason === "failed")) return false
      } else {
        const listRow = yield* engine.listStore.get(pin.value.list)
        const closing: Presentation = {
          kind: "list",
          title: cutAt(titleOf(pin.value.list, listRow?.value, l), TITLE_CHARS),
          style: "checklist",
          items: [],
          spoken: speak(l, "finalSpoken", { list: engine.phraseOf(pin.value.list, l) }),
          handler: HANDLER
        }
        const r = yield* tried(ctx.present.show({ device: pin.value.device }, closing, { lifetime: "pinned", key: pin.value.key, expiresInMs: CLOSE_MS }))
        if ("err" in r && (r.err.reason === "busy" || r.err.reason === "failed")) return false
      }
      yield* removePin(pin.id)
      return true
    })

  /** Make every pinned checklist equal to its list now: changed ones shown again, deleted ones closed, ended ones forgotten. Under the permit. */
  const refreshLocked = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const l = lang()
    const readItems = readItemsFor(undefined)
    let allDone = true
    for (const pin of yield* pinRows) {
      // The host ends a shown checklist on its own; its row is forgotten with it.
      if (pin.value.until <= now + CLOSE_MS) {
        yield* removePin(pin.id)
        continue
      }
      const step = Effect.gen(function*() {
        const built = yield* build(pin.value.list, l, readItems)
        if (built === undefined) {
          if (!(yield* endLocked(pin, l))) allDone = false
          return
        }
        if (signatures.get(pin.id) === built.signature) return
        const shown = yield* showLocked(pin.value.list, pin.value.device, l, readItems, now)
        if (shown.kind === "failed" || shown.kind === "limit") allDone = false
        if (shown.kind === "gone") yield* endLocked(pin, l)
      })
      // One checklist that cannot be refreshed leaves the others as they are, and is tried again later.
      const exit = yield* Effect.exit(step)
      if (exit._tag === "Failure") allDone = false
    }
    return allDone
  })

  /** The checklists on a device, or of one list. */
  const onDevice = (device: string, list: string | undefined) =>
    Effect.map(pinRows, (rows) => rows.filter((r) => r.value.device === device && (list === undefined || r.value.list === list)))

  const device = Effect.map(CurrentTurn, (turn) => turn?.deviceId)

  /** What a tick on a checklist does: the same change as `lists_complete` makes, by the item's id, once. */
  const press = (p: PresentPress): Effect.Effect<{ readonly say: string }, StoreFailure> =>
    Effect.gen(function*() {
      const l = lang()
      const rows = yield* pinRows
      const pin = rows.find((r) => r.value.key === p.key && r.value.device === p.deviceId)
      if (pin === undefined || p.item === undefined) return { say: speak(l, "pinGone") }
      if (p.done !== true) return { say: speak(l, "tickOnly") }
      const row = yield* engine.itemStore.get(p.item)
      if (row === undefined || row.value.list !== pin.value.list || row.value.status === "removed") {
        yield* refreshLocked
        return { say: speak(l, "itemGone") }
      }
      const phrase = engine.phraseOf(pin.value.list, l)
      // Already ticked off (a second press, or another device's): nothing changes, and it says so.
      if (row.value.status === "done") return { say: speak(l, "alreadyTicked", { items: row.value.text }) }
      const now = yield* Clock.currentTimeMillis
      // The same path as the tool: the item as read, at its rev; a change since is a conflict, and nothing is done twice.
      const done = yield* engine.setStatus(pin.value.list, [row], "done", "complete", undefined, now)
      yield* refreshLocked
      if (isRefusal(done)) return { say: speak(l, "itemGone") }
      return { say: speak(l, "completed", { items: row.value.text, list: phrase }) }
    })

  return {
    readItemsFor,
    build,
    /** Put a list on the asking device as a checklist. */
    show: (list: string, readItems: number) =>
      engine.serial(Effect.gen(function*() {
        const d = yield* device
        if (d === undefined) return { kind: "no-device" } as const
        const now = yield* Clock.currentTimeMillis
        return yield* showLocked(list, d, lang(), readItems, now)
      })),
    /** Close the checklists on the asking device (of one list, or all). `undefined`: none was shown there. */
    hide: (list: string | undefined) =>
      engine.serial(Effect.gen(function*() {
        const d = yield* device
        if (d === undefined) return { kind: "no-device" } as const
        const l = lang()
        const found = yield* onDevice(d, list)
        if (found.length === 0) return { kind: "none" } as const
        let all = true
        for (const pin of found) if (!(yield* endLocked(pin, l))) all = false
        return { kind: all ? "closed" : "failed", count: found.length } as const
      })),
    /** Every pinned checklist follows its list; `false` when one could not be brought up to date (try again later). */
    refresh: engine.serial(refreshLocked),
    /** The press handler's body, under the module's permit (the same one-at-a-time rule as the tools). */
    press: (p: PresentPress) => engine.serial(press(p)),
    pinRows
  }
}

export type Checklists = ReturnType<typeof makeChecklists>
