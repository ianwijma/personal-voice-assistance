import { CurrentTurn, type ModuleHostApi, type ModulePresent, type PresentError, type PresentHandle, type Presentation, PRESENT_MIN_EXPIRY_MS, type PresentPress, type Row, type StoreFailure } from "@pva/core"
import { homeLanguage, type Language, say } from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Clock, Effect, Exit, Queue } from "effect"
import { type Item, type ListRow, type Pin, lists, pinIdOf, pinKeyOf, pins, SHOPPING, signatureOf, TODO } from "./data.ts"
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
/** A shown checklist stays until it is closed or this long after it was shown or its content last changed (the host's longest lifetime). */
export const PIN_MS = 24 * 3_600_000
/** A checklist closed without a handle of this run is replaced by an empty one that the host ends after this (its shortest lifetime). */
export const CLOSE_MS = 3_000
/** How long a pin waits after its n-th failed try: 5 s, 20 s, 80 s, 320 s, then every 10 minutes. */
export const retryIn = (attempts: number): number => Math.min(5_000 * 4 ** Math.max(0, attempts - 1), 600_000)
/** How often the pinned devices are compared with the household's devices (the host sends no signal when one is removed). */
export const MEMBERS_MS = 60_000
/** Pins per read when the pins of a list (or, at a start, all of them) are looked up; the pages go on until the end. */
const PIN_PAGE = 16

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
  /** What a screen holds of it (the title and the items), for comparing with what is shown (a change of either is an update). */
  readonly signature: string
  readonly open: number
  readonly cancelledThrough: number | undefined
}

/** The result of putting a checklist on a screen. */
export type Shown =
  | { readonly kind: "shown"; readonly spoken: string; readonly replaced: string | undefined }
  | { readonly kind: "not-shown"; readonly spoken: string; readonly why: string | undefined }
  | { readonly kind: "gone" }
  | { readonly kind: "limit" }
  | { readonly kind: "failed" }

/** A list's name as a title: the default lists' names in the household's language, a named list's own. */
const titleOf = (list: string, row: ListRow | undefined, l: Language) =>
  list === SHOPPING ? say(texts, l, "titleShopping") : list === TODO ? say(texts, l, "titleTodo") : row?.name ?? list

const speakOf = (things: ReadonlyArray<string>, lang: Language, max: number) => speakList(things.slice(0, 100), lang, { max: Math.max(2, max) }) ?? things.slice(0, max).join(", ")

/** A spoken fallback budgets the complete sentence, naming only whole items and counting everything omitted. */
const spokenList = (named: ReadonlyArray<string>, total: number, lang: Language, max: number, list: string): string => {
  if (total === 0) return speak(lang, "empty", { list })
  for (let take = Math.min(named.length, max); take > 0; take--) {
    const shown = named.slice(0, take)
    const rest = total - shown.length
    const words = rest <= 0 ? speakOf(shown, lang, Math.max(2, shown.length)) : say(texts, lang, "more", { items: shown.join(", "), count: rest })
    const sentence = oneLine(total === 1 ? speak(lang, "readOne", { list, items: words }) : speak(lang, "readOpen", { list, count: total, items: words }))
    if (sentence.length <= SPOKEN_CHARS) return sentence
  }
  return speak(lang, "readUnspoken", { list, count: total })
}

/** A deletion cancels the intent of an older pin, even when undo restored the list's data. */
const cancelled = (row: Row<Pin>, through: number | undefined) => through !== undefined && row.rev <= through

/** What reconciling a pin did: when to look at it again (its end, its next try; none: it is gone), and whether it was taken down. */
export interface Reconciled {
  readonly next: number | undefined
  readonly down: boolean
}

/** What putting a checklist under a device's key did. */
type Put =
  | { readonly kind: "error"; readonly reason: PresentError["reason"] }
  | { readonly kind: "shown" | "offline"; readonly handle: PresentHandle }
  | { readonly kind: "cannot"; readonly handle: PresentHandle; readonly why: string | undefined }
  | { readonly kind: "ended" }

/**
 * The checklists on screens (docs/modules/lists.md "Checklists"). The saved pin is the one state: one row per device,
 * found by its id, saying which list, its key, its end, what was last shown and what is owed. `reconcile(device)` is the
 * one function that does what a pin owes; a worker of `shared` runs it for every pin a change concerns, at a pin's end,
 * at its next try and at a start. A new signal never waits for another pin's retry.
 */
export const makeChecklists = (ctx: {
  readonly present: ModulePresent
  readonly host: Pick<ModuleHostApi, "view">
  readonly settingsFor: (assistantId: string | undefined) => { readonly readItems: number } | undefined
}, engine: Engine) =>
  Effect.gen(function*() {
    const lang = () => homeLanguage(ctx.host.view())
    const pinStore = engine.rawStore.collection(pins)
    /** This run's handle of each device's checklist (a restart forgets them; the host keeps what is pinned). */
    const handles = new Map<string, { readonly handle: PresentHandle; readonly shown: string; readonly until: number }>()
    /** Devices whose checklist this run took down while its row is still there (the row is removed next). */
    const dismissed = new Set<string>()

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
        const named = rows.map((r) => oneLine(sayItem(r.value.text, r.value.quantity, l)))
        const total = Math.max(open, rows.length)
        const spoken = spokenList(named, total, l, readItems, phrase)
        const presentation: Presentation = { kind: "list", title, style: "checklist", items, spoken, handler: HANDLER }
        return { presentation, signature: JSON.stringify([title, items]), open, cancelledThrough: row?.value.pinsCancelledThrough }
      })


    /** What a pin keeps of what was shown: a hash of the household's language, the title and the items. */
    const hashOf = (built: Built, l: Language) => signatureOf(JSON.stringify([l, built.signature]))

    /**
     * A device that is no longer one of the household's known devices (`host.view().devices`, read at each use). Not
     * knowing the devices (none listed: the CLI modes, or before serve mode's session hub is up) is not "removed".
     */
    const removedDevice = (device: string) => {
      const all = ctx.host.view().devices
      return all.length > 0 && !all.some((d) => d.id === device)
    }

    type Tried<A> = { readonly ok: A } | { readonly err: PresentError }
    const tried = <A>(effect: Effect.Effect<A, PresentError>): Effect.Effect<Tried<A>> =>
      effect.pipe(Effect.map((ok): Tried<A> => ({ ok })), Effect.catch((err: PresentError) => Effect.succeed<Tried<A>>({ err })))
    /** A refusal that may pass when tried again (the store was busy or said no); the others will not. */
    const transient = (r: Tried<unknown>) => "err" in r && (r.err.reason === "busy" || r.err.reason === "failed")

    /** Compute what remains at the Presenter call, after every read and write, preserving the fixed end. */
    const put = (device: string, key: string, built: Built, until: number): Effect.Effect<Put> =>
      Effect.gen(function*() {
        const ms = until - (yield* Clock.currentTimeMillis)
        if (ms < PRESENT_MIN_EXPIRY_MS) return { kind: "ended" }
        const r = yield* tried(ctx.present.show({ device }, built.presentation, { lifetime: "pinned", key, expiresInMs: Math.min(ms, PIN_MS) }))
        if ("err" in r) return { kind: "error", reason: r.err.reason }
        const here = r.ok.outcome.devices.find((d) => d.deviceId === device)
        if (here?.shown === true) return { kind: "shown", handle: r.ok }
        // Offline: accepted and kept by the host, which gives it to the page when it reconnects.
        if (here?.why === "offline") return { kind: "offline", handle: r.ok }
        return { kind: "cannot", handle: r.ok, why: here?.why }
      })

    /** A pin's row, written as `value` (made when there is none), in one transaction. Without the change signal. */
    const write = (value: Pin, intent?: () => void) =>
      engine.rawStore.transaction((tx) => {
        const c = tx.collection(pins)
        const id = pinIdOf(value.device)
        if (c.get(id) === undefined) c.insert(value, { id })
        else c.update(id, () => value)
        if (intent !== undefined) tx.afterCommit(() => {
          intent()
          ask(value.device)
        })
      })

    /** The row with work owed (its attempts counted, its next try set), in one write; when to try it next. */
    const owe = (row: Row<Pin>, owed: NonNullable<Pin["owed"]>, now: number, changes: Partial<Pin> = {}) =>
      Effect.gen(function*() {
        const attempts = (row.value.owed === owed ? row.value.attempts ?? 0 : 0) + 1
        const next = now + retryIn(attempts)
        const { device, list, key, until, shown } = { ...row.value, ...changes }
        yield* write({ device, list, key, until, ...(shown !== undefined ? { shown } : {}), owed, attempts, next })
        return next
      })

    /** Remove a pin's row (it was taken down, or ended); a removal that fails leaves the row saying "remove me". */
    const removeRow = (row: Row<Pin>, now: number, down: boolean) =>
      Effect.gen(function*() {
        const removed = yield* Effect.exit(engine.rawStore.transaction((tx) => void tx.collection(pins).remove(row.id, { expectRev: row.rev })))
        if (Exit.isSuccess(removed)) {
          dismissed.delete(row.value.device)
          handles.delete(row.value.device)
          return { next: undefined, down } satisfies Reconciled
        }
        return { next: yield* owe(row, "remove", now), down } satisfies Reconciled
      })

    /**
     * Take a device's checklist down. With this run's handle it is dismissed; without one (a restart forgot it) it is
     * replaced under its key by an empty one that the host ends after `CLOSE_MS`. `false`: try again later.
     */
    const takeDown = (pin: Pin, l: Language): Effect.Effect<boolean, StoreFailure> =>
      Effect.gen(function*() {
        const handle = handles.get(pin.device)
        if (handle !== undefined) {
          const result = yield* tried(handle.handle.dismiss)
          if (transient(result)) return false
          if ("ok" in result && result.ok) return true
          // A replacement may have been accepted before its handle reached us. The old handle cannot close that show.
        }
        // At the fixed end the host has expired the card. Never create another one to close it.
        if ((yield* Clock.currentTimeMillis) >= pin.until) return true
        const listRow = yield* engine.listStore.get(pin.list)
        if ((yield* Clock.currentTimeMillis) >= pin.until) return true
        const closing: Presentation = {
          kind: "list",
          title: cutAt(titleOf(pin.list, listRow?.value, l), TITLE_CHARS),
          style: "checklist",
          items: [],
          spoken: speak(l, "finalSpoken", { list: engine.phraseOf(pin.list, l) }),
          handler: HANDLER
        }
        // A device that is not the household's any more is refused (`invalid`): nothing more can be done for it here.
        return !transient(yield* tried(ctx.present.show({ device: pin.device }, closing, { lifetime: "pinned", key: pin.key, expiresInMs: CLOSE_MS })))
      })

    /**
     * THE reconciliation of one device's pin, from the row and the list as they are now. Under the module's permit.
     *
     * - no row: nothing; taken down already (this run, or the row says so): remove the row;
     * - closed, its list deleted or gone, its device no longer the household's: take it down (unless it has ended), then
     *   remove the row;
     * - at or past its end: remove the row (the host ended it);
     * - its content changed: show it under the key with a new end (24 hours from now); work owed, a retry and a restart
     *   (no handle in this run) show it again with what remains of its end, or leave it to end when that is under the
     *   host's minimum; unchanged with a handle: nothing.
     *
     * A device that cannot show a checklist any more is taken down and forgotten; an offline one keeps its pin (the host
     * gives the presentation back when the page reconnects). A failed step leaves the work owed with a later try.
     */
    const reconcileLocked = (device: string): Effect.Effect<Reconciled, StoreFailure> =>
      Effect.gen(function*() {
        let now = yield* Clock.currentTimeMillis
        const row = yield* pinStore.get(pinIdOf(device))
        if (row === undefined) {
          handles.delete(device)
          dismissed.delete(device)
          return { next: undefined, down: true }
        }
        const pin = row.value
        if (pin.owed === "remove" || dismissed.has(device)) return yield* removeRow(row, now, true)
        const l = lang()
        const content = pin.owed === "dismiss" || removedDevice(device) ? undefined : yield* build(pin.list, l, readItemsFor(undefined))
        const built = cancelled(row, content?.cancelledThrough) ? undefined : content
        now = yield* Clock.currentTimeMillis
        if (built === undefined || now >= pin.until) {
          if ((handles.has(device) || now < pin.until) && !(yield* takeDown(pin, l))) return { next: yield* owe(row, "dismiss", now), down: false }
          dismissed.add(device)
          handles.delete(device)
          return yield* removeRow(row, now, true)
        }
        const shown = hashOf(built, l)
        const changed = pin.shown !== shown
        const accepted = handles.get(device)
        if (!changed && accepted?.shown === shown && accepted.until === pin.until) {
          // An explicit show already got the Presenter decision. Only the worker waits for its bookkeeping write.
          if (pin.owed !== undefined) yield* write({ device, list: pin.list, key: pin.key, until: pin.until, shown })
          return { next: pin.until, down: false }
        }
        const until = changed ? now + PIN_MS : pin.until
        if (!changed && until - now < PRESENT_MIN_EXPIRY_MS) return { next: pin.until, down: false }
        // The row first: a changed content is recorded (new signature, new end, `show` owed) before the screen is touched,
        // so a failed write after a successful show cannot make the retry look like another change.
        let current: Row<Pin> = row
        if (changed) {
          const recorded: Pin = { device, list: pin.list, key: pin.key, until, shown, owed: "show", next: now + retryIn(1) }
          yield* write(recorded)
          current = { ...row, value: recorded }
        }
        const r = yield* put(device, pin.key, built, until)
        if (r.kind === "ended") return { next: until, down: false }
        if (r.kind === "error") return { next: yield* owe(current, "show", now), down: false }
        if (r.kind === "cannot") {
          yield* Effect.ignore(r.handle.dismiss)
          dismissed.add(device)
          handles.delete(device)
          return yield* removeRow(current, now, true)
        }
        handles.set(device, { handle: r.handle, shown, until })
        // Owed work done: cleared without touching the end.
        if (current.value.owed !== undefined) yield* write({ device, list: pin.list, key: pin.key, until, shown })
        return { next: until, down: false }
      })

    // -- the worker: what is asked, and when each pin is due ------------------------------------------------------------

    /** Devices to reconcile now. */
    const asked = new Set<string>()
    /** Lists whose pins are to be reconciled now (looked up by the `list` index). */
    const askedLists = new Set<string>()
    /** Every pin is to be reconciled (a start). */
    let askedAll = false
    /** When a failed lookup of pins is tried again (a new signal tries it at once). */
    let lookupAt: number | undefined
    /** A later signal keeps immediate eligibility even when an older lookup fails. */
    let lookupGeneration = 0
    /** Each known pin's next moment: its end, or its next try. Its keys are the devices with a pin. */
    const due = new Map<string, number>()
    /** Failed reconciliations of a device in a row (when even the row could not be written). */
    const failures = new Map<string, number>()
    const wake = yield* Queue.sliding<void>(1)
    const poke = () => void Queue.offerUnsafe(wake, undefined)

    /** The devices of the pins of one list (`list` given) or of all, a page at a time until the end. */
    const devicesOf = (list: string | undefined) =>
      Effect.gen(function*() {
        const found: Array<string> = []
        let after: Row<Pin> | undefined
        for (;;) {
          const rows = yield* pinStore.list({
            ...(list !== undefined ? { where: { list } } : {}),
            orderBy: { field: "createdAt", direction: "asc" },
            limit: PIN_PAGE,
            ...(after !== undefined ? { after } : {})
          })
          for (const r of rows) found.push(r.value.device)
          if (rows.length === 0) return found
          after = rows[rows.length - 1]
        }
      })

    /** What one reconciliation said about when its pin is due again. */
    const settled = (device: string, exit: Exit.Exit<Reconciled, StoreFailure>, now: number) => {
      if (Exit.isSuccess(exit)) {
        failures.delete(device)
        if (exit.value.next === undefined) due.delete(device)
        else due.set(device, exit.value.next)
        return
      }
      const n = (failures.get(device) ?? 0) + 1
      failures.set(device, n)
      due.set(device, now + retryIn(n))
    }

    const lookups = (now: number) => (askedAll || askedLists.size > 0) && (lookupAt === undefined || lookupAt <= now)

    /** One pass: what is due and asked, each pin on its own (one that fails is tried again later, the others go on). */
    const pass = Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      for (const [d, t] of due) if (t <= now || removedDevice(d)) asked.add(d)
      if (lookups(now)) {
        lookupAt = undefined
        // A signal is consumed before its lookup starts (and put back when the lookup fails): a signal that arrives
        // while the lookup is paused is a new one, which the lookup in progress cannot clear.
        if (askedAll) {
          askedAll = false
          const generation = lookupGeneration
          const all = yield* Effect.exit(devicesOf(undefined))
          if (Exit.isSuccess(all)) for (const d of all.value) asked.add(d)
          else {
            askedAll = true
            if (generation === lookupGeneration) lookupAt = now + retryIn(1)
          }
        }
        for (const list of [...askedLists]) {
          askedLists.delete(list)
          const generation = lookupGeneration
          const found = yield* Effect.exit(devicesOf(list))
          if (Exit.isSuccess(found)) for (const d of found.value) asked.add(d)
          else {
            askedLists.add(list)
            if (generation === lookupGeneration) lookupAt = now + retryIn(1)
          }
        }
      }
      for (const d of [...asked]) {
        asked.delete(d)
        settled(d, yield* Effect.exit(engine.serial(reconcileLocked(d))), now)
        yield* Effect.yieldNow
      }
    })

    /** Waits for a signal, or for the next pin due (its end, its try, the look at the household's devices), whichever is first. */
    const idle = Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      if (asked.size > 0 || lookups(now)) return
      let first = lookupAt
      for (const t of due.values()) if (first === undefined || t < first) first = t
      if (due.size > 0) first = Math.min(first ?? Number.POSITIVE_INFINITY, now + MEMBERS_MS)
      if (first === undefined) yield* Queue.take(wake)
      else if (first > now) yield* Effect.timeoutOption(Queue.take(wake), first - now)
    })

    const worker: Effect.Effect<never> = Effect.forever(Effect.andThen(idle, pass))

    const turnDevice = Effect.map(CurrentTurn, (turn) => turn?.deviceId)

    /** Ask for a device's pin to be reconciled (by the worker, at once). */
    const ask = (device: string) => {
      asked.add(device)
      poke()
    }

    /** What a tick on a checklist does: the same change as `lists_complete` makes, by the item's id, once. */
    const press = (p: PresentPress): Effect.Effect<{ readonly say: string }, StoreFailure> =>
      Effect.gen(function*() {
        const l = lang()
        const row = yield* pinStore.get(pinIdOf(p.deviceId))
        const pin = row?.value
        if (row === undefined || pin === undefined || pin.key !== p.key || pin.owed === "dismiss" || pin.owed === "remove" || p.item === undefined) return { say: speak(l, "pinGone") }
        const list = yield* engine.listStore.get(pin.list)
        if (cancelled(row, list?.value.pinsCancelledThrough)) {
          ask(p.deviceId)
          return { say: speak(l, list?.value.deletedAt !== undefined ? "itemGone" : "pinGone") }
        }
        if (p.done !== true) return { say: speak(l, "tickOnly") }
        const item = yield* engine.itemStore.get(p.item)
        if (item === undefined || item.value.list !== pin.list || item.value.status === "removed") {
          // The screen is behind its list: it is brought up to date by the worker.
          ask(p.deviceId)
          return { say: speak(l, "itemGone") }
        }
        // Already ticked off (a second press, or another device's): nothing changes, and it says so.
        if (item.value.status === "done") return { say: speak(l, "alreadyTicked", { items: item.value.text }) }
        const now = yield* Clock.currentTimeMillis
        // The same path as the tool: the item as read, at its rev; a change since is a conflict, and nothing is done twice.
        // Its commit asks for every pin of the list to be reconciled; the answer is what was committed.
        const done = yield* engine.setStatus(pin.list, [item], "done", "complete", undefined, now, { kind: "ui", deviceId: p.deviceId })
        if (isRefusal(done)) return { say: speak(l, "itemGone") }
        return { say: speak(l, "completed", { items: item.value.text, list: engine.phraseOf(pin.list, l) }) }
      })

    return {
      readItemsFor,
      build,
      /**
       * Put a list on the asking device as its checklist: under the device's one key, so another list there is replaced
       * in place (`replaced` names it). One show and one write; a device that cannot show checklists keeps no pin.
       */
      show: (list: string, readItems: number) =>
        engine.serial(Effect.gen(function*() {
          const device = yield* turnDevice
          if (device === undefined) return { kind: "no-device" } as const
          const now = yield* Clock.currentTimeMillis
          const l = lang()
          const before = yield* pinStore.get(pinIdOf(device))
          const built = yield* build(list, l, readItems)
          if (built === undefined) return { kind: "gone" } as const
          const key = pinKeyOf(device)
          // The row first, with what is wanted and `show` owed, in one write; only then the screen. An interruption or a
          // restart in between leaves a row that reconciliation finishes: a checklist is never on a screen without a row.
          const until = now + PIN_MS
          const shown = hashOf(built, l)
          const recorded: Pin = { device, list, key, until, shown, owed: "show", next: now + retryIn(1) }
          const previousHandle = handles.get(device)
          const wasDismissed = dismissed.has(device)
          const kept = yield* Effect.exit(write(recorded, () => {
            handles.delete(device)
            dismissed.delete(device)
          }))
          if (Exit.isFailure(kept)) return { kind: "failed" } as const
          const r = yield* put(device, key, built, until)
          if (r.kind === "ended") return { kind: "failed" } as const
          if (r.kind === "error") {
            // Refused, so the screen is as it was: the row goes back to what it was (none: removed), or is tried again later.
            const back = yield* Effect.exit(engine.rawStore.transaction((tx) => {
              const c = tx.collection(pins)
              const id = pinIdOf(device)
              if (before === undefined) c.remove(id)
              else {
                const list = tx.collection(lists).get(before.value.list)
                // Compare the old revision before restoring: the write's newer revision must not revive cancelled intent.
                c.update(id, () => cancelled(before, list?.value.pinsCancelledThrough) ? { ...before.value, owed: "dismiss" } : before.value)
              }
              tx.afterCommit(() => {
                if (previousHandle !== undefined) handles.set(device, previousHandle)
                if (wasDismissed) dismissed.add(device)
                ask(device)
              })
            }))
            if (Exit.isFailure(back)) {
              due.set(device, now + retryIn(1))
              poke()
            }
            return r.reason === "limit" ? ({ kind: "limit" } as const) : ({ kind: "failed" } as const)
          }
          const spoken = built.presentation.spoken
          if (r.kind === "cannot") {
            // Nothing is kept for a device that cannot show a checklist (an earlier one under its key is gone with it).
            yield* Effect.ignore(r.handle.dismiss)
            handles.delete(device)
            dismissed.add(device)
            ask(device)
            return { kind: "not-shown", spoken, why: r.why } as const
          }
          handles.set(device, { handle: r.handle, shown, until })
          dismissed.delete(device)
          failures.delete(device)
          // The committing intent already asked the worker. It clears the owed show without holding up this answer.
          const b = before?.value
          const replaced = b !== undefined && b.list !== list && b.owed !== "dismiss" && b.owed !== "remove" && now < b.until ? b.list : undefined
          if (r.kind === "offline") return { kind: "not-shown", spoken, why: "offline" } as const
          return { kind: "shown", spoken, replaced } as const
        })),
      /**
       * Close the asking device's checklist (`list` given: only when it is that list's). One write records the close as
       * owed; then it is done at once, or tried again later (`later`).
       */
      hide: (list: string | undefined) =>
        engine.serial(Effect.gen(function*() {
          const device = yield* turnDevice
          if (device === undefined) return { kind: "no-device" } as const
          const now = yield* Clock.currentTimeMillis
          const row = yield* pinStore.get(pinIdOf(device))
          const pin = row?.value
          if (row === undefined || pin === undefined || pin.owed === "remove" || dismissed.has(device) || now >= pin.until) return { kind: "none" } as const
          if (list !== undefined && pin.list !== list) return { kind: "none" } as const
          yield* write({ device, list: pin.list, key: pin.key, until: pin.until, ...(pin.shown !== undefined ? { shown: pin.shown } : {}), owed: "dismiss" }, () => {})
          const done = yield* Effect.exit(reconcileLocked(device))
          settled(device, done, now)
          poke()
          return { kind: Exit.isSuccess(done) && done.value.down ? "closed" : "later", list: pin.list } as const
        })),
      /** The lists a committed transaction wrote: their pins are reconciled at once. */
      changed: (touched: ReadonlySet<string>) => {
        if (touched.size === 0) return
        for (const list of touched) askedLists.add(list)
        lookupGeneration++
        lookupAt = undefined
        poke()
      },
      /** Reconcile every pin (at a start: what changed while the module was stopped, and this run's handles). */
      reconcileAll: () => {
        askedAll = true
        lookupGeneration++
        lookupAt = undefined
        poke()
      },
      /** The worker, forked in `shared`'s scope. */
      worker,
      /** The press handler's body, under the module's permit (the same one-at-a-time rule as the tools). */
      press: (p: PresentPress) => engine.serial(press(p))
    }
  })

export type Checklists = Effect.Success<ReturnType<typeof makeChecklists>>
