/**
 * Fetches speech model presets and the Silero VAD into the models directory.
 * Idempotent: anything already complete is skipped. A hybrid preset fetches
 * both of its models. A thin wrapper over `downloadPreset` (src/download.ts),
 * the same code the web UI's Models page runs.
 *
 *   pnpm --filter @pva/stt-sherpa download-models [preset...] [--model-dir <dir>]
 *   pnpm --filter @pva/stt-sherpa download-models --list
 *
 * Default preset: parakeet-v2. Needs `tar` with bzip2 support.
 */
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { downloadPreset } from "../src/download.ts"
import { DEFAULT_PRESET, defaultModelDir, missingFile, modelFiles, presetNames, presets, resolvePresetName, sizeMb } from "../src/presets.ts"

export interface ScriptDeps {
  readonly log?: (line: string) => void
  readonly fetch?: typeof globalThis.fetch
  readonly freeBytes?: (dir: string) => Promise<number>
}

/** Returns the exit code. */
export const main = async (argv: ReadonlyArray<string>, deps: ScriptDeps = {}): Promise<number> => {
  const log = deps.log ?? ((line: string) => console.log(line))
  const { positionals, values } = parseArgs({
    args: [...argv],
    options: { "model-dir": { type: "string" }, list: { type: "boolean" } },
    allowPositionals: true
  })
  const modelDir = values["model-dir"] ?? defaultModelDir

  if (values.list === true) {
    for (const name of presetNames) {
      const preset = presets[name]
      const state = missingFile(modelFiles(preset, modelDir)) === undefined ? "installed" : "missing"
      log(`${name.padEnd(26)} ${state.padEnd(10)} ${String(sizeMb(preset)).padStart(5)} MB  ${preset.description}`)
    }
    return 0
  }

  const names = positionals.length > 0 ? positionals : [DEFAULT_PRESET]
  const unknown = names.find((n) => resolvePresetName(n) === undefined)
  if (unknown !== undefined) {
    log(`Unknown preset "${unknown}"; choose from ${presetNames.join(", ")}`)
    return 1
  }
  for (const name of names) {
    let lastPercent = -10
    try {
      const resolved = await downloadPreset(name, {
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
      log(`${resolved}: ready`)
    } catch (error) {
      log(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  return 0
}

const isScript = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isScript) process.exitCode = await main(process.argv.slice(2))
