/**
 * Downloading voice presets (docs/SETTINGS-UI.md §5.4) through the shared
 * downloader (`@pva/core/download`). Used by the web UI's Models page and by
 * `scripts/download-models.ts`.
 */
import { type ArchiveSpec, type DownloadOptions, downloadArchives } from "@pva/core/download"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { defaultModelDir, type Preset, presetFiles, presets } from "./Presets.ts"

export { cleanPartials, DownloadError, type DownloadProgress } from "@pva/core/download"

/** What downloading a preset fetches. */
export const presetArchive = (preset: Preset): ArchiveSpec => ({
  name: preset.dir,
  url: preset.url,
  kind: "tar.bz2",
  // Sorted and unique: the speakers of a shared archive expect the same files whichever lexicon they use.
  expect: [...new Set(Object.values(preset.files))].sort().map((f) => `${preset.dir}/${f}`),
  sizeMb: preset.sizeMb,
  diskMb: preset.diskMb
})

export interface PresetDownloadOptions extends Omit<DownloadOptions, "modelDir"> {
  /** Default `<repo>/models`. */
  readonly modelDir?: string
}

/** Download a preset (skipped when its files are there). Only names of `presets` are accepted. */
export const downloadPreset = async (name: string, options: PresetDownloadOptions = {}): Promise<Preset> => {
  const preset = Object.hasOwn(presets, name) ? presets[name] : undefined
  if (preset === undefined) throw new Error(`Unknown preset "${name}". Known: ${Object.keys(presets).join(", ")}`)
  await downloadArchives([presetArchive(preset)], { ...options, modelDir: options.modelDir ?? defaultModelDir })
  return preset
}

export const isInstalled = (name: string, modelDir: string = defaultModelDir): boolean => {
  const preset = Object.hasOwn(presets, name) ? presets[name] : undefined
  return preset !== undefined && Object.values(presetFiles(preset, modelDir)).every((f) => existsSync(f))
}

/**
 * Delete a preset's folder. For an archive several presets share (the Kokoro voices) this deletes all of them: the
 * caller checks that none of them is in use (`archiveVoices`).
 */
export const deletePreset = async (name: string, modelDir: string = defaultModelDir): Promise<{ readonly removed: ReadonlyArray<string> }> => {
  const preset = Object.hasOwn(presets, name) ? presets[name] : undefined
  if (preset === undefined) throw new Error(`Unknown preset "${name}"`)
  await rm(join(modelDir, preset.dir), { recursive: true, force: true })
  return { removed: [preset.dir] }
}
