"use client"
import { Button } from "../ui/controls.tsx"
import { FormFooter } from "./FormFooter.tsx"
import type { PageForms } from "./usePageForms.ts"

/**
 * The page's sticky footer (docs/SETTINGS-UI.md §3.1, §3.4): Save / Cancel for every form on the page, "Save and
 * reload" when every change needs an engine reload, and the warnings of a save with "Save anyway" / "Go back".
 * It is the only place a page says that its changes need an engine reload. While a chosen option's card (Claude
 * subscription) is the way to commit, Save waits and the note points at the card: one obvious way to commit.
 */
export function PageFooter({ forms, commitVia }: {
  readonly forms: PageForms
  /** A chosen option whose card's button is the way to commit it ("Claude subscription"): Save waits for it. */
  readonly commitVia?: string | undefined
}) {
  const disabled = !forms.dirty || forms.saving || forms.hasLocalErrors || commitVia !== undefined
  return (
    <FormFooter
      dirty={forms.dirty}
      saving={forms.saving}
      saveDisabled={disabled}
      // The card's button is the one way to commit: no disabled Save next to a note that points away from it.
      hideSave={commitVia !== undefined}
      onSave={() => void forms.save()}
      onCancel={() => forms.cancel()}
      cancelDisabled={!forms.dirty || forms.saving}
      extra={forms.allReload ? <Button className="max-sm:h-11" disabled={disabled} onClick={() => void forms.save({ reload: true })}>Save and reload</Button> : undefined}
      note={commitVia !== undefined && !forms.saving
        ? `To save this choice, use “Use ${commitVia}” above: it saves, switches it on and reloads.`
        : forms.saved ? "Saved" : forms.someReload ? "Applies after an engine reload (about 2 s; interrupts a reply)." : forms.dirty ? "Unsaved changes" : ""}
      noteTone={forms.saved ? "ok" : "muted"}
      warnings={forms.confirming.map((w) => w.message)}
      onSaveAnyway={() => void forms.save({ confirm: true })}
      onBack={forms.dismissWarnings}
    />
  )
}
