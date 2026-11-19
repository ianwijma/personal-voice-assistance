// The checklist of what is low or missing, shown on a screen (docs/modules/kitchen.md, "On a screen"; docs/PRESENTING.md).
// It shows what `stock_low` answered and nothing more: the same products, the same cut, household data like the spoken
// answer. A tick puts the product on the shopping list by the path the stock answers take (the product's dedupe key on
// the `Lists` service), under the same one-at-a-time rule, and is idempotent: a second tick finds the item on the list.
// Recipes are never shown here, so the allergy rules have nothing to leave out.
import type { ModulePresent, PresentHandle, PresentPress, Presentation, Row } from "@pva/core"
import type { Language } from "@pva/language"
import { say } from "@pva/module-contracts"
import { Effect } from "effect"
import { type Product } from "./data.ts"
import { listText, LOW_SCAN, type Pantry } from "./pantry.ts"
import { texts } from "./texts.ts"

/** The name of the press handler registered in `shared`. */
export const LOW_HANDLER = "low"
/** A checklist holds at most this many items (`MAX_LIST_ITEMS`); a longer list is cut and says so in its title. */
export const SCREEN_ITEMS = 12
/** The longest text of an item (`MAX_LIST_ITEM_CHARS`) and the longest spoken text (`MAX_SPOKEN_CHARS`). */
const ITEM_CHARS = 80
const SPOKEN_CHARS = 300
/** Screens remembered at once: a module may keep at most eight presentations live. */
const MAX_SCREENS = 8
/** An item id a checklist accepts (`LIST_ITEM_ID`). */
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,40}$/u

/** At most `max` UTF-16 units of `text`, cut between characters (never inside a surrogate pair). */
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text
  let out = ""
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

/** The key a device's list is shown under: one list per device, so another device's request never replaces it. */
export const screenKey = (device: string): string => cutText(`low-${device.replace(/[^A-Za-z0-9_.:@/-]/gu, "_")}`, 64)

/** What the stock answer says of the low products: the same sentence whether it is spoken or only shown. */
export const lowSay = (rows: ReadonlyArray<Row<Product>>, cut: boolean, l: Language, max = 6): string => {
  const main = say(texts, l, "low", { list: listText(rows.map((r) => r.value.name), l, cut, max) })
  return cut ? `${main} ${say(texts, l, "lowCut", { count: LOW_SCAN })}` : main
}

/** The sentence the model says where nothing can be shown: the answer itself, with fewer names when it would be too long. */
const spokenOf = (rows: ReadonlyArray<Row<Product>>, cut: boolean, l: Language): string => {
  for (const max of [6, 4, 2, 1]) {
    const s = lowSay(rows, cut, l, max)
    if (s.length <= SPOKEN_CHARS) return s
  }
  return cutText(lowSay(rows, cut, l, 1), SPOKEN_CHARS)
}

/**
 * The checklist for these low products: the first twelve, ticked where they were ticked, with a title that says when
 * there are more (and "at least" when the read itself was cut), so the screen never claims to be the whole list.
 */
export const lowPresentation = (rows: ReadonlyArray<Row<Product>>, cut: boolean, ticked: ReadonlySet<string>, l: Language): Presentation => {
  const usable = rows.filter((r) => ITEM_ID.test(r.id))
  const shown = usable.slice(0, SCREEN_ITEMS)
  const title = !cut && shown.length === rows.length
    ? say(texts, l, "lowScreen")
    : say(texts, l, cut ? "lowScreenAtLeast" : "lowScreenOf", { shown: shown.length, count: rows.length })
  return {
    kind: "list",
    title: cutText(title, 60),
    style: "checklist",
    items: shown.map((r) => ({ id: r.id, text: cutText(r.value.name, ITEM_CHARS), done: ticked.has(r.id) })),
    spoken: spokenOf(rows, cut, l),
    handler: LOW_HANDLER
  }
}

interface Screen {
  readonly handle: PresentHandle
  readonly device: string
  readonly lifetime: "transient" | "pinned"
  /** Products put on the list from this screen: shown ticked while they are still low. */
  readonly ticked: Set<string>
}

export interface Screens {
  /** Show the answer of `stock_low` on the device (a new list replaces the device's earlier one; no ticks yet). */
  readonly show: (device: string, rows: ReadonlyArray<Row<Product>>, cut: boolean, keep: boolean, l: Language) => Effect.Effect<void>
  /** An empty answer: nothing is low, so the device's list is taken down. */
  readonly clear: (device: string) => Effect.Effect<void>
  /** After a change of stock: every list still on a screen is brought into line with what is low now, or taken down. */
  readonly refresh: Effect.Effect<void>
  /** The press handler's work: a tick puts the product on the shopping list. */
  readonly press: (press: PresentPress, l: Language) => Effect.Effect<{ readonly say: string }>
}

/**
 * The lists this module has on screens, by key. A handle acts only on its own show, so an update or a dismissal of a
 * list that ended (it expired, another module's list took the screen, the module restarted) changes nothing; nothing
 * is ever shown again after it ended. After a restart the handles are gone: a transient list is gone with them, and a
 * pinned one stays until it ends, its ticks still work, and the next answer or tick shows it again by its key.
 */
export const makeScreens = (deps: { readonly pantry: Pantry; readonly present: ModulePresent; readonly lang: () => Language }): Screens => {
  const { pantry, present } = deps
  const screens = new Map<string, Screen>()
  const remember = (key: string, screen: Screen) => {
    screens.delete(key)
    screens.set(key, screen)
    // The oldest are forgotten past the bound (their lists simply stop being followed: they end by themselves).
    for (const old of screens.keys()) {
      if (screens.size <= MAX_SCREENS) break
      screens.delete(old)
    }
  }

  const readLow = Effect.suspend(() => pantry.low())

  const show: Screens["show"] = (device, rows, cut, keep, l) =>
    Effect.gen(function*() {
      const key = screenKey(device)
      const lifetime = keep ? "pinned" as const : "transient" as const
      const ticked = new Set<string>()
      const handle = yield* present.show({ device }, lowPresentation(rows, cut, ticked, l), { lifetime, key })
      remember(key, { handle, device, lifetime, ticked })
    }).pipe(Effect.ignoreCause)

  const clear: Screens["clear"] = (device) =>
    Effect.gen(function*() {
      const key = screenKey(device)
      const screen = screens.get(key)
      if (screen === undefined) return
      screens.delete(key)
      yield* screen.handle.dismiss
    }).pipe(Effect.ignoreCause)

  const refresh: Screens["refresh"] = Effect.gen(function*() {
    if (screens.size === 0) return
    const { rows, cut } = yield* readLow
    const l = deps.lang()
    for (const [key, screen] of [...screens]) {
      if (rows.length === 0) {
        screens.delete(key)
        yield* screen.handle.dismiss
        continue
      }
      // What was ticked stays ticked only while the product is still low.
      for (const id of [...screen.ticked]) if (!rows.some((r) => r.id === id)) screen.ticked.delete(id)
      const out = yield* screen.handle.update(lowPresentation(rows, cut, screen.ticked, l))
      if (out === undefined) screens.delete(key)
    }
  }).pipe(Effect.ignoreCause)

  const press: Screens["press"] = (p, l) =>
    Effect.gen(function*() {
      if (p.action !== "tick" || p.item === undefined) return { say: say(texts, l, "tickUnclear") }
      const key = screenKey(p.deviceId)
      const id = p.item
      // Taking an item off the shopping list is the list's own business: it stays as it is.
      if (p.done !== true) return { say: say(texts, l, "untick") }
      const outcome = yield* pantry.putOnList(id)
      let answer: string
      switch (outcome.kind) {
        case "gone":
          answer = say(texts, l, "tickGone")
          break
        case "unreadable":
          answer = say(texts, l, "unreadable")
          break
        case "listed":
          answer = say(texts, l, "listed", { item: outcome.name.charAt(0).toUpperCase() + outcome.name.slice(1) })
          break
        case "already":
          answer = say(texts, l, "tickAlready", { item: outcome.name.charAt(0).toUpperCase() + outcome.name.slice(1) })
          break
        case "off":
          answer = say(texts, l, "listOff", { item: outcome.name })
          break
        case "full":
          answer = say(texts, l, "listFull", { item: outcome.name })
          break
        default:
          answer = say(texts, l, "listFailed", { item: outcome.name })
      }
      // Show what is now: the item ticked when it is on the list, and whatever is no longer low gone. The screen the
      // press came from is the one updated; one that was lost (a restart) is shown again, pinned (a transient list
      // does not survive one). A failure of the screen never changes what the tick did: the answer stands.
      const ok = outcome.kind === "listed" || outcome.kind === "already"
      yield* Effect.gen(function*() {
        const known = screens.get(key)
        const ticked = known?.ticked ?? new Set<string>()
        if (ok) ticked.add(id)
        const { rows, cut } = yield* readLow
        if (rows.length === 0) {
          if (known !== undefined) {
            screens.delete(key)
            yield* known.handle.dismiss
          }
          return
        }
        for (const t of [...ticked]) if (!rows.some((r) => r.id === t)) ticked.delete(t)
        const content = lowPresentation(rows, cut, ticked, l)
        if (known !== undefined) {
          const out = yield* known.handle.update(content)
          if (out === undefined) screens.delete(key)
        } else {
          const lifetime = "pinned" as const
          const handle = yield* present.show({ device: p.deviceId }, content, { lifetime, key })
          remember(key, { handle, device: p.deviceId, lifetime, ticked })
        }
      }).pipe(Effect.ignoreCause)
      return { say: answer }
    })

  return { show, clear, refresh, press }
}
