/**
 * Memory and load time of the local speech models (docs/ASSISTANTS.md, "Baseline measurements (WP-0)").
 *
 *   tsx src/bench/baseline.ts [--runs 3] [--model-dir DIR]          every installed recogniser preset and voice engine
 *   tsx src/bench/baseline.ts one stt <preset> [--model-dir DIR]    one fresh-process measurement, one JSON line
 *   tsx src/bench/baseline.ts one tts <preset> [--model-dir DIR]
 *
 * Each measurement runs in a fresh process: RSS before the load, RSS after the load and warm-up (`make` resolves
 * when the model is loaded and warmed up), and the wall-clock time of the load. The recogniser is a worker thread
 * of the process; a voice engine is a child process, so its RSS is read from /proc and added.
 * Models that are not on disk are listed, never downloaded.
 */
import { defaultModelDir as sttDir, installedPresets, make as makeStt, presetNames, type PresetName } from "@pva/stt-sherpa"
import { defaultModelDir as ttsDir, makeWithEngine, presets as voicePresets, presetFiles } from "@pva/tts-sherpa"
import { Effect, type Scope } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const MB = 1024 * 1024
const rssOf = (pid: number): number => {
  const statm = readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")
  return (Number(statm[1]) * 4096) / MB
}
const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Name, files present? for the voice engines: one Piper voice per language and one Kokoro speaker (they share the engine). */
const voiceEngines = (modelDir: string) =>
  ["en_US-lessac-medium", "nl_NL-pim-medium", "kokoro-af_heart"].flatMap((name) => {
    const p = voicePresets[name]
    return p === undefined ? [] : [{ name, installed: Object.values(presetFiles(p, modelDir)).every((f) => existsSync(f)) }]
  })

const measureOne = async (kind: "stt" | "tts", name: string, modelDir: string) => {
  const before = rssOf(process.pid)
  const t0 = performance.now()
  let after: number
  let loadMs: number
  const program = kind === "stt"
    ? Effect.gen(function*() {
      yield* makeStt({ model: name as PresetName, modelDir })
      loadMs = performance.now() - t0
      after = rssOf(process.pid)
    })
    : Effect.gen(function*() {
      const { engine } = yield* makeWithEngine({ preset: name, modelDir })
      loadMs = performance.now() - t0
      after = rssOf(process.pid) + rssOf(engine.pid!)
    })
  await Effect.runPromise(Effect.scoped(program as Effect.Effect<void, unknown, Scope.Scope>))
  return { kind, name, rssBeforeMb: before, rssAfterMb: after!, addedMb: after! - before, loadMs: loadMs! }
}

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1]! : fallback
}

if (args[0] === "one") {
  const result = await measureOne(args[1] as "stt" | "tts", args[2]!, flag("--model-dir", args[1] === "stt" ? sttDir : ttsDir))
  console.log(JSON.stringify(result))
  process.exit(0)
}

const runs = Number(flag("--runs", "3"))
const modelDir = flag("--model-dir", sttDir)
const self = fileURLToPath(import.meta.url)
const items: Array<{ kind: "stt" | "tts"; name: string; installed: boolean }> = [
  ...presetNames.map((name) => ({ kind: "stt" as const, name, installed: installedPresets(modelDir).includes(name) })),
  ...voiceEngines(modelDir).map((v) => ({ kind: "tts" as const, ...v }))
]
for (const item of items) {
  if (!item.installed) {
    console.log(`${item.kind} ${item.name}: not measured (not installed)`)
    continue
  }
  const added: Array<number> = []
  const load: Array<number> = []
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(process.execPath, ["--import", "tsx", self, "one", item.kind, item.name, "--model-dir", modelDir], { encoding: "utf8" })
    const line = r.stdout.trim().split("\n").pop() ?? ""
    try {
      const m = JSON.parse(line) as { addedMb: number; loadMs: number }
      added.push(m.addedMb)
      load.push(m.loadMs)
    } catch {
      console.log(`${item.kind} ${item.name}: run ${i + 1} failed: ${r.stderr.slice(-300)}`)
    }
  }
  if (added.length === 0) continue
  const f = (xs: Array<number>) => xs.map((x) => Math.round(x)).join("/")
  console.log(
    `${item.kind} ${item.name}: addedMb min ${Math.round(Math.min(...added))} median ${Math.round(median(added))} [${f(added)}]; ` +
      `loadMs min ${Math.round(Math.min(...load))} median ${Math.round(median(load))} [${f(load)}]`
  )
}
