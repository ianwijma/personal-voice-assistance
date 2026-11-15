"use client"
import { useEffect } from "react"
import type { SettingField } from "@pva/protocol"
import { parseKey } from "@/lib/voicePicker.ts"
import { TextField } from "../fields/TextField.tsx"
import type { FieldProps } from "../fields/types.ts"
import { useCatalogState, useVoiceCatalog } from "./useVoiceCatalog.ts"
import { VoicePicker } from "./VoicePicker.tsx"

const NO_NOTES: ReadonlyArray<string> = []

/**
 * `ASSISTANT_VOICE` (Voices › Voices, docs/VOICE-PROVIDERS.md §6.1) as a voice picker. The choice is a draft like any
 * field: the page's Save sends it (the server's checks, "Save anyway" for a voice whose provider has no key), and the
 * reload bar applies it. An empty value means "the voice the earlier settings give", shown as that voice with
 * "default". A value that is not a voice key (typed into `.env` by hand, say) keeps the plain text field. A value
 * set by the environment never reaches here: the settings row shows it locked.
 */
export function AssistantVoiceField(props: FieldProps<Extract<SettingField, { type: "text" }>>) {
  const { id, describedBy, value, onChange, disabled } = props
  const catalog = useVoiceCatalog()
  const text = typeof value === "string" ? value.trim() : ""
  // Again after every new revision of the field (a save, a reset): what "" resolves to may have changed.
  useEffect(() => void catalog.loadDefault(), [catalog, props.field])
  const fallback = useCatalogState((s) => s.defaultVoice?.key ?? s.selected)
  const notes = useCatalogState((s) => s.defaultVoice?.notes ?? NO_NOTES)
  if (text !== "" && parseKey(text) === undefined) return <TextField {...props} />
  return (
    <div className="flex flex-col gap-2">
      <div>
        <VoicePicker id={id} describedBy={describedBy} value={text} onChange={onChange} disabled={disabled} label="Choose the assistant's voice" {...(fallback !== undefined ? { fallbackKey: fallback } : {})} />
      </div>
      {notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[12px] text-ink-muted" data-testid="voice-notes">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  )
}
