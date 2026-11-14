"use client"
import { DEFAULT_DEVICE_PROFILE } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { PhraseTester } from "../PhraseTester.tsx"
import { ProfileForm } from "../ProfileForm.tsx"

/**
 * Front ends › kind (e.g. "Voice assistant in a browser"): the defaults every device of this kind gets unless the
 * device overrides a field (Devices › device). With the phrase tester under the phrase list.
 */
export function FrontendPage() {
  const client = useClient()
  const kindId = useClientState((s) => s.ui.settingsPath[1])
  const kind = useClientState((s) => s.frontends.find((k) => k.id === kindId) ?? s.frontends[0], shallowEqual)
  const devices = useClientState((s) => s.devices.filter((d) => d.kind === kind?.id).length)
  if (kind === undefined) return <p className="text-[14px] text-ink-muted">The assistant knows no front-end kinds.</p>
  return (
    <div className="flex flex-1 flex-col gap-6">
      <p className="text-[13px] text-ink-muted" data-testid="frontend-scope">
        {devices === 0 ? "No device of this kind has connected yet." : `Applies to ${devices} device${devices === 1 ? "" : "s"}, except where a device has its own value.`}
        {" "}A change reaches running devices at once.
      </p>
      <ProfileForm
        key={kind.id}
        id={`frontend-${kind.id}`}
        fields={kind.fields}
        base={DEFAULT_DEVICE_PROFILE}
        saved={kind.defaults}
        showInherited={false}
        onSave={(patch) => client.updateFrontend(kind.id, patch)}
        afterPhrases={(add, p) => <PhraseTester onAdd={add} phrases={p.draft} savedPhrases={p.saved} />}
      />
    </div>
  )
}
