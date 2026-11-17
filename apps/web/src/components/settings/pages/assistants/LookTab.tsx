"use client"
import type { Assistant } from "@pva/protocol"
import { assistantLook } from "@/lib/looks.ts"
import { typePageId } from "@/lib/settingsTree.ts"
import { useClientState } from "../../../context.tsx"
import { LookEditor } from "../../../looks/LookEditor.tsx"
import { AField } from "./parts.tsx"
import { SettingsLink, type TabProps } from "./tabs.tsx"

/**
 * Assistant › Look (docs/LOOKS-AND-VOICES.md §4): the character on the voice stage while this assistant answers, and
 * its settings, saved as `look` with the rest of the assistant. A device with a look of its own overrides it; the tab
 * says which ones do, so it is clear what this tab does and does not change.
 */
export function LookTab({ draft }: TabProps) {
  const a = draft.current
  const name = a.name.trim() === "" ? "This assistant" : a.name
  const devices = useClientState((s) => s.devices)
  const types = useClientState((s) => s.deviceTypes)
  // Where this assistant answers but the device shows its own look (its own value, or its type's defaults).
  const fixedTypes = types.filter((t) => t.settings.look.from === "device" && t.settings.assistants.some((x) => x.assistant === a.id))
  // Every device whose effective look is its own and that lists this assistant, except those that take both the look
  // and the assistant list from a type already named above (the type's row stands for them).
  const fixedKinds = new Set(fixedTypes.map((t) => t.kind))
  const fixed = devices.filter((d) =>
    d.settings.look.from === "device" &&
    d.settings.assistants.some((x) => x.assistant === a.id) &&
    !(fixedKinds.has(d.kind) && d.own.look === undefined && d.own.assistants === undefined)
  )
  return (
    <>
      <p className="text-[14px] text-ink-muted" data-testid="look-intro">
        How {name} looks on the voice page while it answers: the character on the stage and its settings. Every device shows this look for {name}, unless the device has a look of its own.
      </p>
      {(fixed.length > 0 || fixedTypes.length > 0) && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2/40 px-3 py-2 text-[13px] text-ink-muted" data-testid="look-overridden">
          <p>
            Not shown on{" "}
            {fixedTypes.map((t, i) => (
              <span key={t.kind}>{i > 0 ? ", " : ""}<SettingsLink path={["devices", typePageId(t.kind)]}>{`every ${t.one} that follows its defaults`}</SettingsLink></span>
            ))}
            {fixedTypes.length > 0 && fixed.length > 0 ? " and on " : ""}
            {fixed.map((d, i) => (
              <span key={d.id}>{i > 0 ? (i === fixed.length - 1 ? " and " : ", ") : ""}<SettingsLink path={["devices", d.id]}>{d.name}</SettingsLink></span>
            ))}
            : {fixed.length + fixedTypes.length === 1 ? "it shows its own look" : "they show their own look"} for every assistant. That is set on the device, under Look.
          </p>
        </div>
      )}
      <AField label="Look" path="look" draft={draft} help="Saved with the assistant. Voice pages showing it change when it is saved.">
        <LookEditor
          value={a.look}
          idPrefix="a-look"
          whose={`${name}'s`}
          onChange={(look) =>
            draft.update((x): Assistant => {
              const next = assistantLook(look)
              const { look: _old, ...rest } = x
              return next === undefined ? rest : { ...rest, look: next }
            }, "look")}
        />
      </AField>
    </>
  )
}
