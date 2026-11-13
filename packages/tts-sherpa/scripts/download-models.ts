// Downloads TTS model archives into the model directory (idempotent).
// Usage: pnpm --filter @pva/tts-sherpa download [preset ...|all]   (default: the default preset)
// Model directory: TTS_SHERPA_MODEL_DIR, else <repo>/models. Needs `tar` with bzip2 support.
import { spawnSync } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { DEFAULT_PRESET, defaultModelDir, presetFiles, presets } from "../src/Presets.ts"

const modelDir = process.env.TTS_SHERPA_MODEL_DIR ?? defaultModelDir
const args = process.argv.slice(2)
const names = args.length === 0 ? [DEFAULT_PRESET] : args.includes("all") ? Object.keys(presets) : args

for (const name of names) {
  const preset = presets[name]
  if (preset === undefined) {
    console.error(`Unknown preset "${name}". Known: ${Object.keys(presets).join(", ")}`)
    process.exit(1)
  }
  const missing = () => Object.values(presetFiles(preset, modelDir)).filter((f) => !existsSync(f))
  if (missing().length === 0) {
    console.log(`${name}: already present in ${join(modelDir, preset.dir)}`)
    continue
  }
  console.log(`${name}: downloading ${preset.url}  (licence: ${preset.license})`)
  const downloads = join(modelDir, ".downloads")
  mkdirSync(downloads, { recursive: true })
  const archive = join(downloads, `${preset.dir}.tar.bz2`)
  if (!existsSync(archive)) {
    const response = await fetch(preset.url)
    if (!response.ok || response.body === null) {
      console.error(`${name}: download failed: HTTP ${response.status}`)
      process.exit(1)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.part`))
    renameSync(`${archive}.part`, archive) // only complete archives are ever kept
  }
  const tar = spawnSync("tar", ["-xjf", archive, "-C", modelDir], { stdio: "inherit" })
  if (tar.status !== 0) {
    console.error(`${name}: extracting ${archive} failed; delete it to download again`)
    process.exit(1)
  }
  const still = missing()
  if (still.length > 0) {
    console.error(`${name}: archive did not contain ${still.join(", ")}`)
    process.exit(1)
  }
  rmSync(archive)
  console.log(`${name}: ready in ${join(modelDir, preset.dir)}`)
}
