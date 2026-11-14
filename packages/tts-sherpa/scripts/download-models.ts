// Downloads TTS model archives into the model directory (idempotent), with the same code the web UI's Models page
// runs (`downloadPreset`, src/download.ts).
// Usage: pnpm --filter @pva/tts-sherpa download [preset ...|all] [--model-dir <dir>]   (default: the default preset)
// Model directory: --model-dir, else TTS_SHERPA_MODEL_DIR, else <repo>/models. Needs `tar` with bzip2 support.
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { downloadPreset } from "../src/download.ts"
import { DEFAULT_PRESET, defaultModelDir, presets } from "../src/Presets.ts"

export interface ScriptDeps {
  readonly log?: (line: string) => void
  readonly fetch?: typeof globalThis.fetch
  readonly freeBytes?: (dir: string) => Promise<number>
  /** The environment (for TTS_SHERPA_MODEL_DIR). Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Returns the exit code. */
export const main = async (argv: ReadonlyArray<string>, deps: ScriptDeps = {}): Promise<number> => {
  const log = deps.log ?? ((line: string) => console.log(line))
  const { positionals, values } = parseArgs({ args: [...argv], options: { "model-dir": { type: "string" } }, allowPositionals: true })
  const env = deps.env ?? process.env
  const modelDir = values["model-dir"] ?? (env.TTS_SHERPA_MODEL_DIR || defaultModelDir)
  const names = positionals.length === 0 ? [DEFAULT_PRESET] : positionals.includes("all") ? Object.keys(presets) : positionals
  const unknown = names.find((n) => !Object.hasOwn(presets, n))
  if (unknown !== undefined) {
    log(`Unknown preset "${unknown}". Known: ${Object.keys(presets).join(", ")}`)
    return 1
  }
  for (const name of names) {
    const preset = presets[name]!
    log(`${name}: ${preset.url}  (licence: ${preset.license})`)
    let lastPercent = -10
    try {
      await downloadPreset(name, {
        modelDir,
        onLog: (line) => log(`${name}: ${line}`),
        onProgress: (p) => {
          if (p.total === undefined || p.total === 0) return
          const percent = Math.floor((p.done / p.total) * 100)
          if (percent >= lastPercent + 10) {
            lastPercent = percent
            log(`${name}: ${p.phase} ${percent} %`)
          }
        },
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
        ...(deps.freeBytes !== undefined ? { freeBytes: deps.freeBytes } : {})
      })
      log(`${name}: ready in ${join(modelDir, preset.dir)}`)
    } catch (error) {
      log(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  return 0
}

const isScript = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isScript) process.exitCode = await main(process.argv.slice(2))
