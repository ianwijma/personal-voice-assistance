/** The app's two themes as the contract's `Palette`, read from globals.css (as the lab does at build time). */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Palette, Rgb } from "@/characters/contract.ts"
import { parseOklch, themesOf } from "@/lib/contrast.ts"

const css = readFileSync(join(import.meta.dirname, "../../../src/app/globals.css"), "utf8")
const themes = themesOf(css)

const make = (set: "dark" | "light"): Palette => {
  const rgb = (name: string): Rgb => {
    const v = themes[set][name]
    if (v === undefined) throw new Error(`globals.css has no --color-${name} for ${set}`)
    const [r, g, b] = parseOklch(v)
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
  }
  return { dark: set === "dark", bg: rgb("bg"), surface: rgb("surface"), line: rgb("line"), ink: rgb("ink"), inkFaint: rgb("ink-faint"), you: rgb("you"), voice: rgb("voice"), danger: rgb("danger") }
}

export const PALETTES = { dark: make("dark"), light: make("light") } as const
