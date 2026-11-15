// Builds the visualiser lab into ONE self-contained file: visualiser-lab.html (next to lab/)
// (inline CSS and JS, no network requests).
//
//   node docs/research/visualiser-investigation/lab/build.mjs           build once
//   node docs/research/visualiser-investigation/lab/build.mjs --watch   rebuild on changes under lab/src (and globals.css)
//
// Designs are discovered by listing src/designs/*.ts, so authors never edit a shared list.
// A design file that does not compile is left out and shown as an error tile; the rest build.
// esbuild is not a direct dependency: it is resolved from where tsx (a dev dependency of apps/web) lives.
// The output has no timestamps, so an unchanged source rebuilds byte-identically.
import { mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..", "..", "..", "..")
const web = join(root, "apps", "web")
const src = join(here, "src")
const designsDir = join(src, "designs")
const out = process.env.LAB_OUT ?? join(here, "..", "visualiser-lab.html") // LAB_OUT: a private output file, so parallel builds do not overwrite each other
const globalsCss = join(web, "src", "app", "globals.css")
const SIZE_LIMIT = 450 * 1024

const fromWeb = createRequire(join(web, "package.json"))
const esbuild = createRequire(fromWeb.resolve("tsx/package.json"))("esbuild")

/** The app's colour tokens (both themes) via the app's own oklch parser (src/lib/contrast.ts). */
const readTokens = async () => {
  const r = await esbuild.build({ entryPoints: [join(web, "src", "lib", "contrast.ts")], bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent" })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`)
  const themes = mod.themesOf(readFileSync(globalsCss, "utf8"))
  const conv = (set) => Object.fromEntries(Object.entries(set).filter(([, v]) => v.startsWith("oklch(")).map(([k, v]) => [k, mod.parseOklch(v).map((x) => Math.round(x * 1000) / 1000)]))
  return { dark: conv(themes.dark), light: conv(themes.light) }
}

const listDesigns = () =>
  readdirSync(designsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts") && !f.startsWith("_"))
    .map((f) => f.slice(0, -3))
    .sort()

const designsModule = (files, broken) => {
  // `require` (not `import`) so esbuild wraps each design lazily: a throw at load time is caught.
  const lines = ["const designs = []", "const load = (file, get) => { try { designs.push({ file, module: get() }) } catch (e) { designs.push({ file, error: 'Load failed: ' + (e && e.message ? e.message : String(e)) }) } }"]
  for (const f of files) lines.push(`load(${JSON.stringify(f)}, () => require(${JSON.stringify(join(designsDir, f + ".ts"))}))`)
  for (const [f, msg] of broken) lines.push(`designs.push({ file: ${JSON.stringify(f)}, error: ${JSON.stringify(msg)} })`)
  lines.push("export { designs }")
  return lines.join("\n")
}

const build = async () => {
  const t0 = performance.now()
  const tokens = await readTokens()
  let files = listDesigns()
  const broken = new Map()
  let result
  for (let attempt = 0; attempt < 50; attempt++) {
    const plugin = {
      name: "lab-virtual",
      setup(b) {
        b.onResolve({ filter: /^lab:(designs|tokens)$/ }, (a) => ({ path: a.path, namespace: "lab" }))
        b.onLoad({ filter: /.*/, namespace: "lab" }, (a) =>
          a.path === "lab:tokens"
            ? { contents: `export const tokens = ${JSON.stringify(tokens)}`, loader: "js" }
            : { contents: designsModule(files, broken), loader: "js", resolveDir: src }
        )
      }
    }
    try {
      result = await esbuild.build({
        entryPoints: [join(src, "app.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
        legalComments: "none",
        write: false,
        logLevel: "silent",
        plugins: [plugin]
      })
      break
    } catch (e) {
      // Leave out the design files that failed to compile, report them, try again.
      const bad = new Set()
      for (const err of e.errors ?? []) {
        const file = err.location?.file
        const abs = file === undefined ? "" : file.startsWith("/") ? file : join(process.cwd(), file)
        if (abs.startsWith(designsDir + "/")) {
          const id = relative(designsDir, abs).replace(/\.ts$/, "").split("/")[0]
          bad.add(id)
          broken.set(id, `Build failed: ${err.text}${err.location ? ` (${relative(here, abs)}:${err.location.line})` : ""}`)
        }
      }
      if (bad.size === 0) throw e
      files = files.filter((f) => !bad.has(f))
      for (const id of bad) console.warn(`[lab] ${id}.ts left out: ${broken.get(id)}`)
    }
  }
  const css = (await esbuild.transform(readFileSync(join(src, "lab.css"), "utf8"), { loader: "css", minify: true })).code
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visualiser lab</title>
<style>${css}</style>
</head>
<body>
<div id="lab" class="lab"></div>
<script>${js}</script>
</body>
</html>
`
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, html)
  const size = Buffer.byteLength(html)
  const ok = size <= SIZE_LIMIT
  console.log(
    `[lab] ${relative(process.cwd(), out)}: ${(size / 1024).toFixed(1)} KB${ok ? "" : ` (OVER the ${SIZE_LIMIT / 1024} KB limit)`}, ` +
      `${files.length} design${files.length === 1 ? "" : "s"}${broken.size > 0 ? `, ${broken.size} broken` : ""}, ${Math.round(performance.now() - t0)} ms`
  )
  return ok
}

const ok = await build().catch((e) => {
  console.error(e.message ?? e)
  return false
})

if (process.argv.includes("--watch")) {
  let timer = null
  const kick = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void build().catch((e) => console.error(e.message ?? e)), 80)
  }
  watch(src, { recursive: true }, kick)
  watch(globalsCss, kick)
  console.log("[lab] watching lab/src …")
} else if (!ok) {
  process.exitCode = 1
}
