/**
 * Downloading recogniser presets (docs/SETTINGS-UI.md §5.4): the archives of
 * the preset table plus the Silero VAD, through the shared downloader
 * (`@pva/core/download`). Used by the web UI's Models page and by
 * `scripts/download-models.ts`.
 */
import { type ArchiveSpec, type DownloadOptions, downloadArchives } from "@pva/core/download"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  archives,
  defaultModelDir,
  isPresetName,
  missingFile,
  modelFiles,
  type Preset,
  type PresetName,
  presetNames,
  presets,
  resolvePresetName,
  VAD_FILE,
  VAD_SIZE_MB,
  VAD_URL
} from "./presets.ts"

export { cleanPartials, DownloadError, type DownloadProgress } from "@pva/core/download"

const vadSpec: ArchiveSpec = { name: VAD_FILE, url: VAD_URL, kind: "file", expect: [VAD_FILE], sizeMb: VAD_SIZE_MB, diskMb: VAD_SIZE_MB }

/** The files of one archive of a preset that must exist after unpacking (relative to the models folder). */
const expected = (preset: Preset, dir: string): ReadonlyArray<string> => {
  const all = modelFiles(preset, "")
  const files = [...Object.values(all.streaming ?? {}), ...Object.entries(all.offline ?? {}).filter(([k]) => k !== "type").map(([, f]) => f)]
  return files.filter((f) => f.startsWith(`${dir}/`))
}

/** What downloading a preset fetches, in order (the VAD model first). */
export const presetArchives = (name: PresetName): ReadonlyArray<ArchiveSpec> => {
  const preset = presets[name] as Preset
  return [
    vadSpec,
    ...archives(preset).map((a): ArchiveSpec => ({
      name: a.dir,
      url: a.url,
      kind: "tar.bz2",
      expect: expected(preset, a.dir),
      sizeMb: a.sizeMb,
      diskMb: a.diskMb
    }))
  ]
}

export interface PresetDownloadOptions extends Omit<DownloadOptions, "modelDir"> {
  /** Default `<repo>/models`. */
  readonly modelDir?: string
}

/** Download a preset (skips what is there). `name` must be a preset name (or a legacy one); anything else is refused. */
export const downloadPreset = async (name: string, options: PresetDownloadOptions = {}): Promise<PresetName> => {
  const resolved = resolvePresetName(name)
  if (resolved === undefined) throw new Error(`Unknown preset "${name}"; choose from ${presetNames.join(", ")}`)
  await downloadArchives(presetArchives(resolved), { ...options, modelDir: options.modelDir ?? defaultModelDir })
  return resolved
}

/** Whether every file of a preset is there. */
export const isInstalled = (name: PresetName, modelDir: string = defaultModelDir): boolean =>
  missingFile(modelFiles(presets[name] as Preset, modelDir)) === undefined

/**
 * Delete a preset's folders that no other installed preset needs (the VAD model stays). Returns the folders removed
 * and the presets that still share the rest.
 */
export const deletePreset = async (
  name: string,
  modelDir: string = defaultModelDir
): Promise<{ readonly removed: ReadonlyArray<string>; readonly sharedWith: ReadonlyArray<PresetName> }> => {
  if (!isPresetName(name)) throw new Error(`Unknown preset "${name}"`)
  const own = archives(presets[name] as Preset).map((a) => a.dir)
  const others = presetNames.filter((n) => n !== name && isInstalled(n, modelDir))
  const sharedWith = others.filter((n) => archives(presets[n] as Preset).some((a) => own.includes(a.dir)))
  const shared = new Set(sharedWith.flatMap((n) => archives(presets[n] as Preset).map((a) => a.dir)))
  const removed = own.filter((dir) => !shared.has(dir))
  for (const dir of removed) await rm(join(modelDir, dir), { recursive: true, force: true })
  return { removed, sharedWith }
}
