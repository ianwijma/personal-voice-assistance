/**
 * Fetches speech model presets and the Silero VAD into the models directory.
 * Idempotent: anything already complete is skipped. A hybrid preset fetches
 * both of its models.
 *
 *   pnpm --filter @pva/stt-sherpa download-models [preset...] [--model-dir <dir>]
 *   pnpm --filter @pva/stt-sherpa download-models --list
 *
 * Default preset: parakeet-v2. Needs `tar` with bzip2 support.
 */
import { execFileSync } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { parseArgs } from "node:util"
import {
  archives,
  DEFAULT_PRESET,
  defaultModelDir,
  missingFile,
  modelFiles,
  presetNames,
  presets,
  resolvePresetName,
  VAD_FILE,
  VAD_URL
} from "../src/presets.ts"

const { positionals, values } = parseArgs({
  options: { "model-dir": { type: "string" }, list: { type: "boolean" } },
  allowPositionals: true
})
const modelDir = values["model-dir"] ?? defaultModelDir

if (values.list) {
  for (const name of presetNames) {
    const preset = presets[name]
    const state = missingFile(modelFiles(preset, modelDir)) === undefined ? "installed" : "missing"
    console.log(`${name.padEnd(26)} ${state.padEnd(10)} ${preset.description}`)
  }
  process.exit(0)
}

const names = (positionals.length > 0 ? positionals : [DEFAULT_PRESET]).map((name) => {
  const resolved = resolvePresetName(name)
  if (resolved === undefined) throw new Error(`Unknown preset "${name}"; choose from ${presetNames.join(", ")}`)
  return resolved
})

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
  const preset = presets[name]
  if (!missingFile(modelFiles(preset, modelDir))) {
    console.log(`${name}: present`)
    continue
  }
  for (const { dir, url } of archives(preset)) {
    if (existsSync(join(modelDir, dir))) {
      console.log(`${name}: ${dir} present`)
      continue
    }
    const archive = join(modelDir, `${dir}.tar.bz2`)
    await download(url, archive)
    console.log(`unpacking ${archive}`)
    execFileSync("tar", ["xjf", archive, "-C", modelDir], { stdio: "inherit" })
    rmSync(archive)
  }
  const missing = missingFile(modelFiles(preset, modelDir))
  if (missing) throw new Error(`${name}: ${missing} is not in the archive`)
  console.log(`${name}: ready`)
}
