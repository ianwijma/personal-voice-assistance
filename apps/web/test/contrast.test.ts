import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { contrast, over, parseOklch, themesOf } from "../src/lib/contrast.ts"

const css = readFileSync(join(import.meta.dirname, "../src/app/globals.css"), "utf8")
const themes = themesOf(css)

/** Tokens used as text colour (`text-*`) anywhere in the web app. */
const TEXT = ["ink", "ink-muted", "ink-faint", "voice", "you", "ok", "warn", "danger"] as const
const SURFACES = ["bg", "surface", "surface-2"] as const
/** Text on a tinted background, as the components use it (hover of a primary button, selected chips, the reload bar). */
const TINTED: ReadonlyArray<readonly [text: string, tint: string, base: string]> = [
  ["voice", "voice-soft", "surface"],
  ["ink", "voice-soft", "surface"],
  ["ink-muted", "voice-soft", "surface"],
  ["you", "you-soft", "surface-2"],
  // The voice picker's provider marks (ui/voiceProviderMarks.ts), on the popup (surface) and on a hovered row (surface-2).
  ["you", "you-soft", "surface"],
  ["ink", "voice-soft", "surface-2"],
  ["danger", "danger", "surface"] // bg-danger/10 under text-danger: checked below with alpha 0.1
]

describe("colour contrast (WCAG 2, 4.5:1 for text)", () => {
  for (const [name, t] of Object.entries(themes)) {
    const bg = parseOklch(t.bg!)
    const solid = (k: string) => over(parseOklch(t[k]!), bg)
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        it(`${name}: ${text} on ${surface}`, () => {
          expect(contrast(parseOklch(t[text]!), solid(surface))).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
    for (const [text, tint, base] of TINTED) {
      it(`${name}: ${text} on ${tint} over ${base}`, () => {
        const raw = parseOklch(t[tint]!)
        const layer = tint === "danger" ? ([raw[0], raw[1], raw[2], 0.1] as const) : raw
        expect(contrast(parseOklch(t[text]!), over(layer, solid(base)))).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it("reads both themes from globals.css", () => {
    expect(Object.keys(themes.dark)).toEqual(expect.arrayContaining([...TEXT, ...SURFACES]))
    expect(themes.light.ok).not.toBe(themes.dark.ok)
    expect(themes.light.warn).not.toBe(themes.dark.warn)
  })
})

/**
 * Non-text contrast (WCAG 1.4.11, 3:1): what tells a selected / checked control from one that is not, against the
 * colours next to it, as `ui/controls.tsx`, `fields/ChoiceField.tsx`, `fields/MultiChoiceField.tsx` and the voice
 * sheet's radio list draw them. `[indicator, background (token, alpha), base under it]`.
 */
type Layer = readonly [token: string, alpha?: number]
const INDICATORS: ReadonlyArray<readonly [what: string, indicator: string, background: Layer, base: string]> = [
  // Segmented control: the selected segment's 2 px ink-muted edge, against the selected surface inside it and the
  // group's background (surface-2 at 60 %) outside it, on the page and on a panel.
  ["segmented: selected edge vs the selected surface", "ink-muted", ["surface"], "bg"],
  ["segmented: selected edge vs the group (on bg)", "ink-muted", ["surface-2", 0.6], "bg"],
  ["segmented: selected edge vs the group (on surface)", "ink-muted", ["surface-2", 0.6], "surface"],
  // Switch: the thumb against its track, both states; the checked track's mint edge against the page.
  ["switch: checked thumb vs its track (on bg)", "you", ["you-soft"], "bg"],
  ["switch: checked thumb vs its track (on surface)", "you", ["you-soft"], "surface"],
  ["switch: checked edge vs the page", "you", ["bg"], "bg"],
  ["switch: checked edge vs a panel", "you", ["surface"], "bg"],
  ["switch: unchecked thumb vs its track", "ink-faint", ["surface-2"], "bg"],
  // Radio options (voice sheet, choice rows): the ring when not chosen, the thick mint ring when chosen, on the row's
  // background (a chosen row is tinted surface-2 at 60 %).
  ["radio: unchecked ring vs a panel", "ink-faint", ["surface"], "bg"],
  ["radio: unchecked ring vs the page", "ink-faint", ["bg"], "bg"],
  ["radio: checked ring vs a panel", "you", ["surface"], "bg"],
  ["radio: checked ring vs a chosen row", "you", ["surface-2", 0.6], "surface"],
  ["radio: checked ring vs a chosen choice row", "you", ["surface-2", 0.7], "bg"],
  ["choice row: chosen edge vs the page", "ink-muted", ["bg"], "bg"],
  // Checkbox (multichoice): the unchecked box edge and the checked box's mint edge and check.
  ["checkbox: unchecked edge vs its box", "ink-faint", ["surface-2"], "bg"],
  ["checkbox: checked check vs its box", "you", ["you-soft"], "bg"]
]

describe("non-text contrast of state indicators (WCAG 1.4.11, 3:1)", () => {
  for (const [name, t] of Object.entries(themes)) {
    const bg = parseOklch(t.bg!)
    for (const [what, indicator, [token, alpha], base] of INDICATORS) {
      it(`${name}: ${what}`, () => {
        const raw = parseOklch(t[token]!)
        const layer = alpha === undefined ? raw : ([raw[0], raw[1], raw[2], alpha] as const)
        const under = over(parseOklch(t[base]!), bg)
        expect(contrast(parseOklch(t[indicator]!), over(layer, under))).toBeGreaterThanOrEqual(3)
      })
    }
  }
})
