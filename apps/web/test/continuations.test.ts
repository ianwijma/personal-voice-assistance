// @vitest-environment node
/**
 * Every asynchronous continuation in the audio lifecycle says which ticket it checks (fourth review,
 * finding 2: the third round in a row to find one that escaped the generation and session tickets).
 *
 * A lint over the files that hold the lifecycle, and (fifth review) every file outside them that awaits
 * something and then calls into the client or saves a result (the echo test, the components that await a
 * request): every line that registers a continuation (an
 * `await`, a promise callback, a timer, an event listener, a message or state handler, a promise whose
 * resolver is stored, or a callback handed to code that runs it later) must carry a
 * `continuation(<ticket>)` comment on the line or in the comment block right above it, naming what it
 * checks before it acts:
 *
 * - `generation`: the client's `guard()` (End, a takeover, a failure or a newer Start makes it stale);
 * - `session` / `request`: `VoiceAudio`'s lifecycle tickets (`sessionGuard`, `requestGuard`, `isSession`, `isRequest`);
 * - `link` / `reply`: a playback link or a reply's pending stop, by identity;
 * - `identity`: the object it belongs to is still the current one (`this.ctx === ctx`, `this.mic === stream`);
 * - `route`: the output route and its play attempt are still the ones in force (`VoiceAudio.playAttempt`: an
 *   output-path change or a newer `play()` makes it stale; fifth review, finding 3);
 * - `state`: it acts only on the present state, read when it runs (a preference such as the interrupt mode is
 *   read when it is used, never taken from a snapshot made before the await: fifth review, finding 2);
 * - `none`: it does nothing that could touch a newer session (ignores the outcome, only settles).
 *
 * What it cannot check is whether the code then really checks that ticket: the comment makes the
 * question impossible to skip, and review answers it. A new continuation without one fails here.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const FILES = [
  "src/lib/client.ts",
  "src/lib/audio/VoiceAudio.ts",
  "src/lib/audio/playback.ts",
  "src/lib/audio/lifecycle.ts",
  // Fifth review: outside the lifecycle, but they await and then act.
  "src/lib/echoTest.ts",
  // The settings screen (docs/SETTINGS-UI.md) replaced DeviceTab, AssistantTab, ModuleCard and SettingsForm.
  "src/components/settings/pages/DevicePages.tsx",
  "src/components/settings/ReloadBar.tsx",
  "src/components/settings/ServerPage.tsx",
  "src/components/settings/ModuleHeader.tsx",
  "src/components/settings/usePageForms.ts",
  "src/components/Composer.tsx",
  "src/components/Toasts.tsx"
] as const

const REGISTERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["await", /\bawait\b/],
  ["promise callback", /\.(then|catch|finally)\(/],
  ["timer", /\b(setTimeout|setInterval|queueMicrotask|requestAnimationFrame)\(/],
  ["event listener", /\baddEventListener\(/],
  ["handler", /\.on[a-z]+\s*=(?!=)(?!\s*null\b)/],
  ["stored resolver", /new Promise\b|\.push\(resolve\)/],
  ["callback run later", /new (PlaybackLink|VoiceAudio)\(|\bmakeConnection\(|\brunEchoTest\(|\baudio\.stop\(|\breleaseAudio\([^)]*,[^)]*,/]
]

const ANNOTATION = /continuation\((generation|session|request|link|reply|identity|route|state|none)(\+(generation|session|request|link|reply|identity|route|state))*\)/

interface Site {
  readonly file: string
  readonly line: number
  readonly kind: string
  readonly code: string
  readonly ticket: string | undefined
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)

export const sites = (): ReadonlyArray<Site> => {
  const out: Array<Site> = []
  for (const file of FILES) {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n")
    let inBlock = false
    lines.forEach((text, i) => {
      if (inBlock) {
        if (text.includes("*/")) inBlock = false
        return
      }
      if (/^\s*\/\*/.test(text) && !text.includes("*/")) {
        inBlock = true
        return
      }
      if (isComment(text)) return
      const code = text.replace(/\/\/.*$/, "")
      const kind = REGISTERS.find(([, re]) => re.test(code))?.[0]
      if (kind === undefined) return
      // The annotation: on the line itself, or in the comment block directly above.
      let ticket = ANNOTATION.exec(text)?.[0]
      for (let j = i - 1; ticket === undefined && j >= 0 && isComment(lines[j]!); j--) ticket = ANNOTATION.exec(lines[j]!)?.[0]
      out.push({ file, line: i + 1, kind, code: code.trim(), ticket })
    })
  }
  return out
}

describe("every continuation in the lifecycle names the ticket it checks", () => {
  it("no continuation without a continuation(<ticket>) comment", () => {
    const all = sites()
    expect(all.length).toBeGreaterThan(50) // the lint really looked at the files
    const missing = all.filter((s) => s.ticket === undefined).map((s) => `${s.file}:${s.line} (${s.kind}): ${s.code}`)
    expect(missing).toEqual([])
  })

  it("the lint catches an unannotated continuation (self-test)", () => {
    const code = "    void audio.resume().then(() => dispatch(x))"
    expect(REGISTERS.some(([, re]) => re.test(code))).toBe(true)
    expect(ANNOTATION.test(code)).toBe(false)
    expect(ANNOTATION.test("// continuation(generation): checks g.current()")).toBe(true)
    expect(ANNOTATION.test("// continuation(whatever): no")).toBe(false)
  })
})
