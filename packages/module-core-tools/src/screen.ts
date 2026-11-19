import { CurrentTurn, type ModulePresent, type PresentHandle, type Presentation } from "@pva/core"
import { Effect } from "effect"

// What the two modules that show something share: one text cut for the screen. Limits of a presentation are in UTF-16
// units (`docs/PRESENTING.md`), so the cut is made inside the limit and never between the halves of a pair (an emoji).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** `text` within `max` units: when it is longer, it ends with "…" at a code point boundary inside the limit. */
export const cutFor = (text: string, max: number): string => {
  if (text.length <= max) return text
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  // The cut would leave the first half of a pair at the end: leave it out.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end).replace(LONE_SURROGATE, "").trimEnd()}…`
}

/** The bounds of a presentation this package fills (docs/PRESENTING.md, "The kinds and their bounds"). */
export const SCREEN = { title: 60, cardText: 300, factValue: 60, listItem: 80, spoken: 300 } as const

/**
 * Shows one presentation at a time on the device that asked, as a call of the module's own (`ctx.present.show("origin")`),
 * so the answer the model and the typed action give is exactly what it was. The newest handle of each asking device is
 * kept, so a later answer that has nothing to show (`undefined`) takes the earlier one down: what is on a screen
 * follows the answer. The map holds at most one handle per device and forgets it when it is dismissed. A transient
 * ends by itself and with the module part, so a restart needs nothing from it; a device that cannot show it, no
 * device on the turn and no Presenter at all (the CLI modes) change nothing about the answer.
 */
export const makeScreen = (present: ModulePresent) => {
  const held = new Map<string, PresentHandle>()
  return (what: Presentation | undefined): Effect.Effect<void> =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const device = turn?.deviceId
      if (device === undefined) return
      const before = held.get(device)
      if (what === undefined) {
        held.delete(device)
        if (before !== undefined) yield* before.dismiss
        return
      }
      held.set(device, yield* present.show("origin", what))
    }).pipe(Effect.ignore)
}
