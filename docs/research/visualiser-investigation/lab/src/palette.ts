/**
 * The app's theme as the contract's `Palette`, plus the CSS variables the lab page uses.
 * Values come from apps/web/src/app/globals.css at build time (see build.mjs), so the lab
 * always matches the app.
 */
import { tokens } from "lab:tokens"
import type { Palette, Rgb } from "./contract.ts"

export type Theme = "dark" | "light"

const rgb = (set: Theme, name: string, fallback: Rgb): Rgb => {
  const t = tokens[set][name]
  return t === undefined ? fallback : [Math.round(t[0] * 255), Math.round(t[1] * 255), Math.round(t[2] * 255)]
}

const make = (set: Theme): Palette => ({
  dark: set === "dark",
  bg: rgb(set, "bg", set === "dark" ? [21, 22, 19] : [246, 244, 239]),
  surface: rgb(set, "surface", [30, 31, 28]),
  line: rgb(set, "line", [60, 61, 57]),
  ink: rgb(set, "ink", [235, 232, 222]),
  inkFaint: rgb(set, "ink-faint", [150, 148, 140]),
  you: rgb(set, "you", [120, 220, 200]),
  voice: rgb(set, "voice", [230, 180, 90]),
  danger: rgb(set, "danger", [230, 90, 70])
})

export const PALETTES: { readonly [T in Theme]: Palette } = { dark: make("dark"), light: make("light") }

/** `--name: rgb(...)` declarations for every token of a theme (alpha tokens as rgba). */
export const cssVariables = (set: Theme): string =>
  Object.entries(tokens[set])
    .map(([name, [r, g, b, a]]) => `--${name}:rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`)
    .join(";")
