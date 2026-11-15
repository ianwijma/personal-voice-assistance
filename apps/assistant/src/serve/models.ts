import type { HostResult } from "@pva/core"
import type { JobInfo, ModelSet, ToolId } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { statfs } from "node:fs/promises"
import type { Jobs } from "./jobs.ts"
import type { ModelDirs } from "./sectionDefinitions.ts"

/**
 * The speech models of the web UI's Models pages (docs/SETTINGS-UI.md §5.4):
 * the recogniser's and the voices' presets with size and state, downloads as
 * jobs, and delete. Only names from the packages' preset tables are accepted;
 * nothing a page sends reaches a URL or a path.
 */

export interface PresetDownloader {
  readonly download: (name: string, options: { readonly modelDir: string; readonly signal: AbortSignal; readonly onProgress: (p: SherpaStt.DownloadProgress) => void; readonly onLog: (line: string) => void }) => Promise<unknown>
  readonly remove: (name: string, modelDir: string) => Promise<{ readonly removed: ReadonlyArray<string>; readonly sharedWith?: ReadonlyArray<string> }>
  readonly installed: (name: string, modelDir: string) => boolean
}

export const sherpaDownloaders: Readonly<Record<ToolId, PresetDownloader>> = {
  "stt-models": {
    download: (name, options) => SherpaStt.downloadPreset(name, options),
    remove: (name, dir) => SherpaStt.deletePreset(name, dir),
    installed: (name, dir) => SherpaStt.isPresetName(name) && SherpaStt.isInstalled(name, dir)
  },
  "tts-models": {
    download: (name, options) => SherpaTts.downloadPreset(name, options),
    remove: (name, dir) => SherpaTts.deletePreset(name, dir),
    installed: (name, dir) => SherpaTts.isInstalled(name, dir)
  }
}

interface Item {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly sizeMb: number
  readonly diskMb: number
}

/** The preset tables, as the Models pages list them (recommended first). */
export const presetItems = (tool: ToolId): ReadonlyArray<Item> => {
  if (tool === "stt-models") {
    const demoted = (name: SherpaStt.PresetName) => Number((SherpaStt.presets[name] as SherpaStt.Preset).demoted ?? false)
    return [...SherpaStt.presetNames].sort((a, b) => demoted(a) - demoted(b)).map((name) => {
      const p = SherpaStt.presets[name] as SherpaStt.Preset
      return { id: name, label: p.label, description: p.description, sizeMb: SherpaStt.sizeMb(p), diskMb: SherpaStt.diskMb(p) }
    })
  }
  // One item per archive: the Kokoro voices share one, listed (downloaded, deleted) under its owner preset.
  return Object.values(SherpaTts.presets).filter((p) => SherpaTts.archiveOwner(p.name) === p.name).map((p) => {
    const voices = SherpaTts.archiveVoices(p.name).length
    return {
      id: p.name,
      label: SherpaTts.presetLabel(p),
      description: `${p.engine === "kokoro" ? "Higher quality, slower first audio" : "Fast"}${voices > 1 ? ` · ${voices} voices in one download` : ""} · ${p.sampleRate} Hz · licence: ${p.license}`,
      sizeMb: p.sizeMb,
      diskMb: p.diskMb
    }
  })
}

const titles: Readonly<Record<ToolId, string>> = { "stt-models": "Speech recognition models", "tts-models": "Voice models" }

export interface Models {
  readonly list: () => ReadonlyArray<ModelSet>
  readonly download: (tool: ToolId, target: string) => HostResult & { readonly job?: JobInfo }
  readonly remove: (tool: ToolId, target: string) => Promise<HostResult>
  /** Measure the free space again (after a job; at start). */
  readonly refresh: () => Promise<void>
}

export const makeModels = (options: {
  readonly jobs: Jobs
  readonly dirs: () => ModelDirs
  /** Presets the running engines use (cannot be deleted). */
  readonly inUse: () => { readonly stt: ReadonlySet<string>; readonly tts: ReadonlySet<string> }
  /** After a download ended or a model was deleted: re-announce sections and models. */
  readonly onChange: () => void
  readonly downloaders?: Readonly<Record<ToolId, PresetDownloader>>
  readonly freeBytes?: (dir: string) => Promise<number>
}): Models => {
  const downloaders = options.downloaders ?? sherpaDownloaders
  const freeBytes = options.freeBytes ?? (async (dir: string) => {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  })
  const free = new Map<ToolId, number>()
  const dirOf = (tool: ToolId) => (tool === "stt-models" ? options.dirs().stt : options.dirs().tts)
  const known = (tool: ToolId, target: string) => presetItems(tool).find((i) => i.id === target)

  const refresh = async () => {
    for (const tool of ["stt-models", "tts-models"] as const) {
      try {
        free.set(tool, Math.round((await freeBytes(dirOf(tool))) / 1e6))
      } catch {
        free.delete(tool)
      }
    }
  }

  const list = (): ReadonlyArray<ModelSet> => {
    const used = options.inUse()
    return (["stt-models", "tts-models"] as const).map((tool) => {
      const dir = dirOf(tool)
      const inUse = tool === "stt-models" ? used.stt : used.tts
      const freeMb = free.get(tool)
      return {
        tool,
        title: titles[tool],
        directory: dir,
        ...(freeMb !== undefined ? { freeMb } : {}),
        items: presetItems(tool).map((i) => ({ ...i, installed: downloaders[tool].installed(i.id, dir), inUse: inUse.has(i.id) }))
      }
    })
  }

  return {
    list,
    refresh,
    download: (tool, target) => {
      const item = known(tool, target)
      if (item === undefined) return { ok: false, error: { code: "invalid_settings", message: `There is no model "${target}"` } }
      const dir = dirOf(tool)
      if (downloaders[tool].installed(target, dir)) return { ok: false, error: { code: "busy", message: `${item.label} is already downloaded` } }
      const started = options.jobs.start({
        tool,
        action: "download",
        target,
        label: item.label,
        run: (signal, report) =>
          downloaders[tool].download(target, {
            modelDir: dir,
            signal,
            onLog: report.log,
            onProgress: (p) => {
              report.phase(p.phase)
              if (p.phase !== "check") report.progress(p.done, p.total)
            }
          }).then(() => undefined),
        onEnd: () => {
          void refresh().finally(options.onChange)
        }
      })
      return started.ok ? { ok: true, job: started.job } : { ok: false, error: { code: "busy", message: started.message } }
    },
    remove: async (tool, target) => {
      const item = known(tool, target)
      if (item === undefined) return { ok: false, error: { code: "invalid_settings", message: `There is no model "${target}"` } }
      if (options.jobs.running(tool, target) !== undefined) return { ok: false, error: { code: "busy", message: `${item.label} is still downloading; cancel it first` } }
      if (options.inUse()[tool === "stt-models" ? "stt" : "tts"].has(target)) {
        return { ok: false, error: { code: "busy", message: `${item.label} is in use by the running engines; choose another model and reload first` } }
      }
      const dir = dirOf(tool)
      if (!downloaders[tool].installed(target, dir)) return { ok: false, error: { code: "invalid_settings", message: `${item.label} is not downloaded` } }
      try {
        const result = await downloaders[tool].remove(target, dir)
        if (result.removed.length === 0) {
          const shared = (result.sharedWith ?? []).map((n) => known(tool, n)?.label ?? n).join(", ")
          return { ok: false, error: { code: "busy", message: `Its files are also used by ${shared || "another model"}; delete that one instead` } }
        }
      } catch (error) {
        return { ok: false, error: { code: "internal", message: `Could not delete ${item.label}: ${(error as NodeJS.ErrnoException).code ?? "error"}` } }
      }
      await refresh()
      options.onChange()
      return { ok: true }
    }
  }
}

/** The presets the running engines use, from the engine status (`stt` detail = preset; `tts` detail = `voice: preset`). */
export const presetsInUse = (engines: ReadonlyArray<{ readonly stage: string; readonly provider: string; readonly detail: string }>) => {
  const stt = new Set<string>()
  const tts = new Set<string>()
  for (const e of engines) {
    if (e.provider !== "sherpa") continue
    if (e.stage === "stt") stt.add(SherpaStt.resolvePresetName(e.detail) ?? e.detail)
    if (e.stage === "tts") {
      const name = e.detail.includes(": ") ? e.detail.slice(e.detail.indexOf(": ") + 2) : e.detail
      tts.add(name)
      // A voice of a shared archive (Kokoro) keeps the whole archive in use: it is listed under its owner.
      const owner = SherpaTts.archiveOwner(name)
      if (owner !== undefined) tts.add(owner)
    }
  }
  // A hybrid preset uses the archives of two others: those count as in use too.
  for (const name of [...stt]) {
    if (!SherpaStt.isPresetName(name)) continue
    const own = new Set(SherpaStt.presetArchives(name).map((a) => a.name))
    for (const other of SherpaStt.presetNames) {
      const archives = SherpaStt.presetArchives(other).filter((a) => a.kind === "tar.bz2")
      if (archives.length > 0 && archives.every((a) => own.has(a.name))) stt.add(other)
    }
  }
  return { stt, tts }
}
