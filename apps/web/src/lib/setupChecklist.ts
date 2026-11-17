import { ACCOUNTS, accountState, listJoin } from "./assistants.ts"
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

export const setupChecklist = (s: ClientState): ReadonlyArray<ChecklistItem> => {
  const items: Array<ChecklistItem> = []
  const stt = s.engine.engines.find((e) => e.stage === "stt")
  const voice = s.engine.voices.find((v) => v.isDefault)
  const failedStage = (word: string) => s.engine.problems.find((p) => p.stage.toLowerCase().includes(word))

  // Assistants (docs/ASSISTANTS.md §7.1): who answers; the accounts they can use.
  const on = s.assistants.filter((a) => a.on)
  items.push(
    s.assistants.length === 0
      ? { id: "assistants", ok: false, text: "Assistants: none yet, so nobody answers", action: { label: "New assistant…", path: ["assistants", "new", "1"] } }
      : { id: "assistants", ok: true, text: `Assistants: ${listJoin(s.assistants.map((a) => a.name))}${on.length === s.assistants.length ? ", all switched on" : `, ${on.length} switched on`}` }
  )
  const modules = Object.values(s.modules.byId)
  const ready = ACCOUNTS.filter((a) => a.id !== "offline" && accountState(a.id, s.sections, modules).tone === "ok")
  const llmProblem = failedStage("language")
  items.push(
    llmProblem !== undefined
      ? { id: "llm", ok: false, text: `Language model: ${llmProblem.message}`, action: { label: "Fix", path: ["shared", "accounts"] } }
      : ready.length === 0
      ? { id: "llm", ok: false, text: "Language model accounts: none set up (only the offline stand-in)", action: { label: "Set up…", path: ["shared", "accounts"] } }
      : { id: "llm", ok: true, text: `Language model accounts: ${listJoin(ready.map((a) => a.title))}` }
  )
  const sttProblem = failedStage("speech-to-text")
  items.push(
    sttProblem !== undefined || stt === undefined
      ? { id: "stt", ok: false, text: `Speech recognition: ${sttProblem?.message ?? "not running"}`, action: { label: "Fix", path: ["shared", "speech"] } }
      : { id: "stt", ok: true, text: `Speech recognition: ${stt.provider === "sherpa" ? "on this machine" : stt.provider} (${stt.detail})` }
  )
  const voiceProblem = failedStage("voice")
  items.push(
    voiceProblem !== undefined || voice === undefined
      ? { id: "voice", ok: false, text: `Voice: ${voiceProblem?.message ?? "not running"}`, action: { label: "Fix", path: ["shared", "providers"] } }
      : { id: "voice", ok: true, text: `Voice: ${voice.description || voice.name} (${voice.engine})` }
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
