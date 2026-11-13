/**
 * Fetches speech model presets and the Silero VAD into the models directory.
 * Idempotent: anything already complete is skipped.
 *
 *   pnpm --filter @pva/stt-sherpa download-models [preset...] [--model-dir <dir>]
 *
 * Default preset: nemotron-3.5. Needs `tar` with bzip2 support.
 */
import { execFileSync } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { parseArgs } from "node:util"
import { defaultModelDir, isPresetName, missingFile, modelFiles, presetNames, presets, VAD_FILE, VAD_URL } from "../src/presets.ts"

const { values, positionals } = parseArgs({ options: { "model-dir": { type: "string" } }, allowPositionals: true })
const modelDir = values["model-dir"] ?? defaultModelDir
const names = positionals.length > 0 ? positionals : ["nemotron-3.5"]
for (const name of names) {
  if (!isPresetName(name)) throw new Error(`Unknown preset "${name}"; choose from ${presetNames.join(", ")}`)
}

const download = async (url: string, file: string) => {
  console.log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`)
  const partial = `${file}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  renameSync(partial, file)
}

mkdirSync(modelDir, { recursive: true })
const vad = join(modelDir, VAD_FILE)
if (existsSync(vad)) console.log(`${VAD_FILE}: present`)
else await download(VAD_URL, vad)

for (const name of names) {
  const preset = presets[name as keyof typeof presets]
  if (!missingFile(modelFiles(preset, modelDir))) {
    console.log(`${name}: present in ${join(modelDir, preset.dir)}`)
    continue
  }
  const archive = join(modelDir, `${preset.dir}.tar.bz2`)
  await download(preset.url, archive)
  console.log(`unpacking ${archive}`)
  execFileSync("tar", ["xjf", archive, "-C", modelDir], { stdio: "inherit" })
  rmSync(archive)
  const missing = missingFile(modelFiles(preset, modelDir))
  if (missing) throw new Error(`${name}: ${missing} is not in the archive`)
  console.log(`${name}: ready`)
}
