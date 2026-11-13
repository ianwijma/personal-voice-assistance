"use client"
import { useEffect, useState } from "react"
import { Spinner } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"
import type { PageForms } from "./usePageForms.ts"

/**
 * Lift the footer above the on-screen keyboard (iOS Safari keeps `position: sticky` elements behind it): the
 * distance between the layout viewport's bottom and the visual viewport's bottom.
 */
const useKeyboardInset = () => {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  return inset
}

/**
 * The page's sticky footer (docs/SETTINGS-UI.md §3.1, §3.4): Save / Cancel for every form on the page, "Save and
 * reload" when every change needs an engine reload, and the warnings of a save with "Save anyway".
 */
export function PageFooter({ forms }: { readonly forms: PageForms }) {
  const inset = useKeyboardInset()
  const disabled = !forms.dirty || forms.saving || forms.hasLocalErrors
  return (
    <div
      className="sticky bottom-0 z-10 -mx-5 mt-auto border-t border-line bg-surface/95 px-5 pt-3 backdrop-blur-sm sm:-mx-8 sm:px-8"
      style={{ bottom: inset, paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
      data-testid="page-footer"
    >
      {forms.confirming.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/5 px-3 py-2.5" role="alert" data-testid="save-warnings">
          {forms.confirming.map((w, i) => <p key={i} className="text-[13px] text-ink">{w.message}</p>)}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => void forms.save({ confirm: true })} disabled={forms.saving}>
              {forms.saving && <Spinner size={12} />}
              Save anyway
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={forms.dirty ? "primary" : "default"} size="sm" disabled={disabled} onClick={() => void forms.save()}>
          {forms.saving && <Spinner size={13} />}
          Save
        </Button>
        {forms.allReload && (
          <Button type="button" size="sm" disabled={disabled} onClick={() => void forms.save({ reload: true })}>Save and reload</Button>
        )}
        <Button size="sm" variant="quiet" disabled={!forms.dirty || forms.saving} onClick={() => forms.cancel()}>Cancel</Button>
        <span
          className={cx("text-[12px]", forms.saved ? "text-ok" : "text-ink-faint")}
          aria-live="polite"
          data-testid="footer-note"
        >
          {forms.saved ? "Saved" : forms.someReload ? "Applies after an engine reload (about 2 s)." : forms.dirty ? "Unsaved changes" : ""}
        </span>
      </div>
    </div>
  )
}
