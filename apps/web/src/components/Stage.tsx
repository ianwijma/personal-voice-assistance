"use client"
import { isOwner, visualState } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { stageOverlays } from "@/ui/voiceRegistry.ts"
import { Captions } from "./Captions.tsx"
import { useClientState } from "./context.tsx"
import { EngineBanner } from "./EngineBanner.tsx"
import { StateLabel } from "./StateLabel.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx } from "./ui/controls.tsx"
import { Visualiser } from "./Visualiser.tsx"

export function Stage() {
  const v = useClientState(
    (s) => ({ state: visualState(s), owner: isOwner(s) && s.audio.phase !== "off", chatOpen: s.ui.chatOpen }),
    shallowEqual
  )
  const overlays = useClientState((s) => stageOverlays.filter((o) => o.when(s)).map((o) => o.id), shallowEqual)
  return (
    <section
      aria-label="Assistant"
      data-testid="stage"
      data-visual-state={v.state}
      className={cx(
        // The line stays at the same height in every state; what is under it flows downward.
        "absolute inset-0 flex flex-col items-center overflow-y-auto overflow-x-hidden pb-32 [overflow-anchor:none] transition-transform duration-[320ms] ease-out",
        // Top padding and the visualiser's height scale with the height (globals.css `stage-pad` / `stage-vis`).
        "stage-pad",
        v.chatOpen && "lg:max-[1439px]:-translate-x-[200px]"
      )}
    >
      <EngineBanner />
      <div className="stage-vis relative w-[calc(100%-32px)] max-w-[720px] shrink-0">
        <Visualiser state={v.state} owner={v.owner} />
        {v.state === "muted" && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-faint" aria-hidden="true">
            <Icon name="micOff" size={22} />
          </div>
        )}
      </div>
      <StateLabel />
      <Captions />
      <div className="mt-6 flex short:mt-3 w-full max-w-[560px] flex-col items-center gap-4 px-4 empty:hidden" data-testid="stage-below">
        {overlays.map((id) => {
          const Overlay = stageOverlays.find((o) => o.id === id)!.component
          return <Overlay key={id} />
        })}
      </div>
    </section>
  )
}
