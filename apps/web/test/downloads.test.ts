import { describe, expect, it } from "vitest"
import type { SettingField } from "@pva/protocol"
import { exampleJob, serverExamples } from "@pva/protocol/examples"
import { formatMb, jobPercent } from "@/components/settings/DownloadControl.tsx"
import { optionsToDownload } from "@/components/settings/FieldRow.tsx"
import { initialState, lastJob, reducer, runningJob } from "@/lib/state.ts"

const model: SettingField = {
  type: "choice",
  key: "STT_SHERPA_MODEL",
  label: "Model",
  apply: "reload",
  default: "parakeet-v2",
  options: [
    { value: "parakeet-v2", label: "Parakeet v2", tags: ["local"], download: { tool: "stt-models", target: "parakeet-v2", sizeMb: 484 } },
    { value: "whisper-turbo", label: "Whisper", tags: ["local", "not-downloaded"], download: { tool: "stt-models", target: "whisper-turbo", sizeMb: 565 } }
  ]
}

describe("model downloads in the client", () => {
  it("a chosen option that is not downloaded is offered for download; a downloaded one is not", () => {
    expect(optionsToDownload(model, "parakeet-v2")).toEqual([])
    expect(optionsToDownload(model, "whisper-turbo").map((o) => o.download)).toEqual([{ tool: "stt-models", target: "whisper-turbo", sizeMb: 565 }])
    expect(optionsToDownload(model, undefined)).toEqual([]) // the default
    const voices: SettingField = { ...model, type: "multichoice", default: [] }
    expect(optionsToDownload(voices, ["parakeet-v2", "whisper-turbo"]).map((o) => o.value)).toEqual(["whisper-turbo"])
  })

  it("jobs arrive in the snapshot and as `job` messages; running and last are found by tool and target", () => {
    let s = reducer(initialState, serverExamples.welcome)
    expect(runningJob(s, "stt-models", "whisper-turbo")?.id).toBe(exampleJob.id)
    s = reducer(s, serverExamples.job)
    expect(runningJob(s, "stt-models", "whisper-turbo")).toBeUndefined()
    expect(lastJob(s, "stt-models", "whisper-turbo")?.state).toBe("succeeded")
    expect(s.jobs).toHaveLength(1)
    expect(s.models[0]?.tool).toBe("stt-models")
    expect(s.env?.entries.some((e) => e.movable)).toBe(true)
  })

  it("percent and sizes", () => {
    expect(jobPercent(exampleJob)).toBe(21)
    expect(jobPercent({ ...exampleJob, progress: { done: 5, unit: "bytes" } })).toBeUndefined()
    expect(formatMb(484)).toBe("484 MB")
    expect(formatMb(1039)).toBe("1.0 GB")
  })
})
