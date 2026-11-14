/**
 * WCAG 2 contrast of the colour tokens in `globals.css` (oklch → sRGB → relative luminance). Used by
 * `test/contrast.test.ts` so a token that carries text cannot drop below 4.5:1 on a surface it sits on.
 */

export type Rgba = readonly [r: number, g: number, b: number, a: number]

/** `oklch(L C H)` or `oklch(L C H / A)` → sRGB 0..1 (clipped) plus alpha. */
export const parseOklch = (value: string): Rgba => {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)/.exec(value)
  if (m === null) throw new Error(`not an oklch colour: ${value}`)
  const L = Number(m[1])
  const C = Number(m[2])
  const h = (Number(m[3]) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l3 = l_ ** 3
  const m3 = m_ ** 3
  const s3 = s_ ** 3
  const lin = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
  ]
  const enc = (x: number) => {
    const c = Math.min(1, Math.max(0, x))
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  }
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!), m[4] === undefined ? 1 : Number(m[4])]
}

/** `top` painted over an opaque `bottom`. */
export const over = (top: Rgba, bottom: Rgba): Rgba => [
  top[0] * top[3] + bottom[0] * (1 - top[3]),
  top[1] * top[3] + bottom[1] * (1 - top[3]),
  top[2] * top[3] + bottom[2] * (1 - top[3]),
  1
]

const luminance = (c: Rgba): number => {
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

export const contrast = (a: Rgba, b: Rgba): number => {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** The `--color-*` declarations of one CSS block (the first `@theme { … }`, or the light `:root { … }`). */
export const tokensOf = (block: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/--color-([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim()
  return out
}

/** The dark (`@theme`) and light (`prefers-color-scheme: light`) token sets; light inherits what it does not redefine. */
export const themesOf = (css: string): { readonly dark: Record<string, string>; readonly light: Record<string, string> } => {
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ""
  const light = /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? ""
  const dark = tokensOf(theme)
  return { dark, light: { ...dark, ...tokensOf(light) } }
}
