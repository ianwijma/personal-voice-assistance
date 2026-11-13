import type { ClientState } from "./state.ts"
import type { SettingsPath } from "./settingsTree.ts"

/**
 * The Overview's "Getting started" list (docs/SETTINGS-UI.md §3.7), computed
 * from the snapshot: what works, and what still needs doing, each with the
 * page that fixes it. An open item puts a dot on Overview in the list.
 */
export interface ChecklistItem {
  readonly id: string
  readonly ok: boolean
  readonly text: string
  readonly action?: { readonly label: string; readonly path: SettingsPath }
}

const LLM: Record<string, string> = { fake: "offline stand-in (echoes you)", anthropic: "Claude API", "claude-subscription": "Claude subscription" }

export const setupChecklist = (s: ClientState): ReadonlyArray<ChecklistItem> => {
  const items: Array<ChecklistItem> = []
  const llm = s.engine.engines.find((e) => e.stage === "llm")
  const stt = s.engine.engines.find((e) => e.stage === "stt")
  const voice = s.engine.voices.find((v) => v.isDefault)
  const failedStage = (word: string) => s.engine.problems.find((p) => p.stage.toLowerCase().includes(word))

  const llmProblem = failedStage("language")
  items.push(
    llmProblem !== undefined
      ? { id: "llm", ok: false, text: `Language model: ${llmProblem.message}`, action: { label: "Fix", path: ["language-model", "provider"] } }
      : llm === undefined
      ? { id: "llm", ok: false, text: "Language model: not running", action: { label: "Choose…", path: ["language-model", "provider"] } }
      : llm.provider === "fake"
      ? { id: "llm", ok: false, text: `Language model: ${LLM.fake}`, action: { label: "Choose…", path: ["language-model", "provider"] } }
      : { id: "llm", ok: true, text: `Language model: ${LLM[llm.provider] ?? llm.provider} (${llm.detail})` }
  )
  const sttProblem = failedStage("speech-to-text")
  items.push(
    sttProblem !== undefined || stt === undefined
      ? { id: "stt", ok: false, text: `Speech recognition: ${sttProblem?.message ?? "not running"}`, action: { label: "Fix", path: ["speech", "engine"] } }
      : { id: "stt", ok: true, text: `Speech recognition: ${stt.provider === "sherpa" ? "on this machine" : stt.provider} (${stt.detail})` }
  )
  const voiceProblem = failedStage("voice")
  items.push(
    voiceProblem !== undefined || voice === undefined
      ? { id: "voice", ok: false, text: `Voice: ${voiceProblem?.message ?? "not running"}`, action: { label: "Fix", path: ["voices", "overview"] } }
      : { id: "voice", ok: true, text: `Voice: ${voice.name} (${voice.engine})` }
  )
  items.push(
    s.vault.state === "none"
      ? { id: "vault", ok: false, text: "Keys: stored unencrypted in the project", action: { label: "Protect…", path: ["keys", "access"] } }
      : s.vault.state === "locked"
      ? { id: "vault", ok: false, text: "Key vault: locked", action: { label: "Unlock", path: ["keys", "access"] } }
      : { id: "vault", ok: true, text: "Key vault: unlocked" }
  )
  // Settings still in .env: one Move away from being editable here (docs/SETTINGS-UI.md §4.4).
  const inFile = s.env?.entries.filter((e) => e.movable).length ?? 0
  if (inFile > 0) {
    items.push({
      id: "env",
      ok: false,
      text: `${inFile} ${inFile === 1 ? "setting is" : "settings are"} still in .env (they cannot be changed here)`,
      action: { label: "Move…", path: ["diagnostics", "overrides"] }
    })
  }
  return items
}

/** Open items (a dot on Overview). Only once the engines have started: "starting" is not a problem yet. */
export const openChecklistItems = (s: ClientState): number =>
  s.connection.status !== "open" || s.engine.state === "starting" ? 0 : setupChecklist(s).filter((i) => !i.ok).length
