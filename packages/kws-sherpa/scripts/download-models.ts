/**
 * Download the keyword-spotting models into <repo>/models (or KWS_MODEL_DIR):
 *
 *   tsx scripts/download-models.ts [gigaspeech-bpe] [zh-en-phone]   (default: both)
 */
import { downloadArchives } from "@pva/core/download"
import { defaultModelDir, isKwsModelName, kwsModels, type KwsModel } from "../src/models.ts"

const names = process.argv.slice(2)
const chosen: Array<KwsModel> = (names.length > 0 ? names : ["gigaspeech-bpe", "zh-en-phone"]).map((n) => {
  if (!isKwsModelName(n)) throw new Error(`Unknown model "${n}"; choose from ${Object.keys(kwsModels).join(", ")}`)
  return kwsModels[n]
})
const byDir = new Map<string, Array<KwsModel>>()
for (const m of chosen) byDir.set(m.dir, [...(byDir.get(m.dir) ?? []), m])
await downloadArchives(
  [...byDir].map(([dir, ms]) => ({
    name: dir,
    url: ms[0]!.url,
    kind: "tar.bz2" as const,
    expect: [...new Set(ms.flatMap((m) => Object.values(m.files).map((f) => `${dir}/${f}`)))],
    sizeMb: ms[0]!.archiveMb,
    diskMb: ms[0]!.archiveMb * 1.3
  })),
  { modelDir: defaultModelDir, onLog: (l) => console.log(l) }
)
console.log(`models in ${defaultModelDir}`)
