import { assert, describe, it } from "@effect/vitest"
import { VoiceCatalogError } from "@pva/core"
import { makeToneTts } from "@pva/core/testing"
import { Effect, Exit } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { listVoices, makeVoices, presetFiles, presets } from "../src/index.ts"

const withModelDir = (installed: ReadonlyArray<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "pva-sherpa-voices-"))
  for (const name of installed) {
    for (const file of Object.values(presetFiles(presets[name]!, dir))) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, "x")
    }
  }
  return dir
}

const reasonOf = <A>(exit: Exit.Exit<A, VoiceCatalogError>) => {
  assert.isTrue(Exit.isFailure(exit))
  const reason = (exit as Exit.Failure<A, VoiceCatalogError>).cause.reasons.find((r) => r._tag === "Fail") as unknown as { error: VoiceCatalogError }
  return reason.error.reason
}

describe("voices on this machine", () => {
  it("lists every preset with its install state and description", () => {
    const dir = withModelDir(["en_US-lessac-medium"])
    try {
      const voices = listVoices(dir)
      assert.deepStrictEqual(voices.map((v) => v.id), Object.keys(presets))
      const lessac = voices.find((v) => v.id === "en_US-lessac-medium")!
      assert.deepStrictEqual(lessac.local, { installed: true, sizeMb: 68, diskMb: 83 })
      assert.strictEqual(lessac.language, "en-US")
      assert.strictEqual(voices.find((v) => v.id === "kokoro-af_heart")!.local!.installed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.effect("previews an installed voice through engineFor; the engine's scope ends with the preview", () =>
    Effect.gen(function*() {
      const dir = withModelDir(["en_US-lessac-medium"])
      const tone = makeToneTts({ sampleRate: 22_050, millisPerClause: 100, chunks: 1 })
      const started: Array<string> = []
      let closed = 0
      const voices = makeVoices({
        modelDir: dir,
        engineFor: (preset) =>
          Effect.acquireRelease(Effect.sync(() => {
            started.push(preset)
            return tone.service
          }), () => Effect.sync(() => closed++))
      })
      const audio = yield* voices.preview("en_US-lessac-medium", "Hello. Goodbye.")
      assert.strictEqual(audio.sampleRate, 22_050)
      assert.strictEqual(audio.pcm.length, 2 * 2 * 2_205)
      assert.deepStrictEqual(started, ["en_US-lessac-medium"])
      assert.strictEqual(closed, 1)
      rmSync(dir, { recursive: true, force: true })
    }))

  it.effect("a voice that is not downloaded, or not known, is refused without an engine", () =>
    Effect.gen(function*() {
      const dir = withModelDir([])
      let started = 0
      const voices = makeVoices({
        modelDir: () => dir,
        engineFor: () => Effect.sync(() => {
          started++
          return makeToneTts({ sampleRate: 16_000 }).service
        })
      })
      assert.strictEqual(reasonOf(yield* Effect.exit(voices.preview("kokoro-af_heart", "Hi."))), "not_installed")
      assert.strictEqual(reasonOf(yield* Effect.exit(voices.preview("nope", "Hi."))), "unknown_voice")
      assert.strictEqual(reasonOf(yield* Effect.exit(voices.preview("constructor", "Hi."))), "unknown_voice")
      assert.strictEqual(started, 0)
      rmSync(dir, { recursive: true, force: true })
    }))
})
