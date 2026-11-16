// Headless screenshot of the built lab (run `pnpm lab` first).
//
//   node docs/research/visualiser-investigation/lab/shot.mjs --design sine-lines --mode hearing --theme dark --out /tmp/sine.png
//   node docs/research/visualiser-investigation/lab/shot.mjs --design sine-lines --matrix loudness --out /tmp/loud.png
//   node docs/research/visualiser-investigation/lab/shot.mjs --out /tmp/gallery.png                      (the whole gallery)
//
// Options:
//   --design <id>        detail view of one design (default: gallery)
//   --mode <mode>        auto | idle | listening | hearing | thinking | speaking (default auto)
//   --theme dark|light   (default dark)
//   --matrix <tab>       modes | loudness | voice | delivery | assistant: shoot that matrix strip
//   --page               shoot the whole lab box instead of just the stage / strip
//   --t <seconds>        wait before the shot (default 2)
//   --width <px>         viewport width (default 1280)
//   --reduced            reduced motion on
//   --user / --agent <register,loudness,delivery>   voice presets, e.g. deep,loud,fast-excited
//   --opt <id=value>     a design option (repeat it): --opt lines=5 --opt glow=0 --opt '$you=#ff00aa' --opt '$sensitivity=1.5'
//                        common settings are $you, $voice, $sensitivity; toggles take 1/0; colours "#rrggbb" or you|voice|ink|inkFaint
//   --panel              shoot the Customise panel instead of the stage
//   --out <png>          output file (default lab-shot.png)
// Console errors and page errors are printed; the exit code is 1 if the page threw.
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const here = dirname(fileURLToPath(import.meta.url))
// Playwright is a devDependency of apps/web only: resolve it from there.
const { chromium } = createRequire(join(here, "..", "..", "..", "..", "apps", "web", "package.json"))("@playwright/test")
const file = process.env.LAB_OUT ?? join(here, "..", "visualiser-lab.html")
const { values: o } = parseArgs({
  options: {
    design: { type: "string" },
    mode: { type: "string", default: "auto" },
    theme: { type: "string", default: "dark" },
    matrix: { type: "string" },
    page: { type: "boolean", default: false },
    t: { type: "string", default: "2" },
    width: { type: "string", default: "1280" },
    reduced: { type: "boolean", default: false },
    user: { type: "string" },
    agent: { type: "string" },
    opt: { type: "string", multiple: true },
    panel: { type: "boolean", default: false },
    out: { type: "string", default: "lab-shot.png" }
  }
})
if (!existsSync(file)) {
  console.error(`${file} is missing: run \`pnpm lab\` first.`)
  process.exit(2)
}

const q = new URLSearchParams()
if (o.design) q.set("design", o.design)
q.set("mode", o.mode)
q.set("theme", o.theme)
if (o.matrix) q.set("matrix", o.matrix)
if (o.reduced) q.set("reduced", "1")
if (o.user) q.set("user", o.user)
if (o.agent) q.set("agent", o.agent)
for (const pair of o.opt ?? []) {
  const i = pair.indexOf("=")
  if (i <= 0) {
    console.error(`--opt wants id=value, got "${pair}"`)
    process.exit(2)
  }
  q.append(`opt.${pair.slice(0, i)}`, pair.slice(i + 1))
}
const url = `${pathToFileURL(file).href}?${q}`

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: Number(o.width), height: o.matrix ? 2600 : 900 }, deviceScaleFactor: 1, colorScheme: o.theme === "light" ? "light" : "dark", reducedMotion: o.reduced ? "reduce" : "no-preference" })
let threw = false
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`[console.${m.type()}] ${m.text()}`)
})
page.on("pageerror", (e) => {
  threw = true
  console.log(`[pageerror] ${e.message}`)
})
await page.goto(url)
await page.waitForTimeout(Number(o.t) * 1000)

const selector = o.page || !o.design ? "#lab" : o.panel ? "[data-shot=customise]" : o.matrix ? "[data-shot=matrix]" : "[data-shot=stage]"
const el = page.locator(selector).first()
if ((await el.count()) === 0) {
  console.error(`Nothing to shoot: ${selector} not found (is "${o.design}" a design id?)`)
  threw = true
} else {
  const out = resolve(o.out)
  await el.screenshot({ path: out })
  console.log(`wrote ${out}`)
}
await browser.close()
process.exitCode = threw ? 1 : 0
