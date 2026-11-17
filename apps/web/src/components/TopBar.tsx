"use client"
import { displayPhrase, visualState } from "@/lib/state.ts"
import { shallowEqual } from "@/lib/store.ts"
import { defaultAssistantId, reachText, topBarName } from "@/lib/voiceSetup.ts"
import { useClient, useClientState } from "./context.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx, IconButton, ToneDot } from "./ui/controls.tsx"
import { PopMenu, type PopMenuItem } from "./voice/PopMenu.tsx"

/**
 * The voice front end's top bar: a status dot, the answering assistant's name (a menu of the device's assistants where
 * the device lets people pick, docs/ASSISTANTS.md §7.2), End, and the settings sheet. The stage says the rest (the engine
 * banner for "not ready", the label under the line has connecting / reconnecting, the stage's notices have outdated,
 * audio errors and audio on another device).
 */
export function TopBar() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      status: s.connection.status,
      owner: s.session.role === "owner" && s.audio.phase !== "off" && s.audio.phase !== "error",
      audioError: s.audio.phase === "error",
      ready: s.summary.ready,
      sheetOpen: s.ui.sheetOpen
    }),
    shallowEqual
  )
  let text: string | undefined
  let tone: "ok" | "warning" | "error" | "neutral"
  if (v.status === "outdated") {
    tone = "error"
  } else if (v.status !== "open") {
    // The label under the line says "Connecting" / "Reconnecting · attempt N": one place only.
    tone = "warning"
  } else if (v.audioError) {
    tone = "error"
  } else if (!v.ready) {
    // The banner on the stage says why: no visible words here, only for assistive technology.
    text = "not ready"
    tone = "warning"
  } else {
    tone = v.owner ? "ok" : "neutral"
  }
  return (
    <header className="stage-legible relative z-20 flex h-14 shrink-0 items-center gap-3 pl-[max(12px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] sm:gap-5 sm:px-6">
      <div className="flex min-w-0 items-center gap-2.5 pl-1" data-testid="connection-status-line">
        <ToneDot tone={tone} className={cx("size-2", tone === "warning" && "animate-pulse")} />
        <AssistantName />
        <span data-testid="connection-status" className="sr-only">
          {text}
        </span>
      </div>
      {v.owner && (
        <button
          type="button"
          onClick={client.endAudio}
          data-testid="end-session"
          className="label ml-auto inline-flex h-11 items-center gap-2 rounded-md border border-line px-3 text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink sm:ml-0 sm:h-8 sm:border-transparent sm:px-2.5"
          title="Release the microphone and speaker"
        >
          <span aria-hidden="true" className="size-2 rounded-[2px] bg-current" />
          End session
        </button>
      )}
      <div className={cx("flex items-center", v.owner ? "max-sm:ml-0 sm:ml-auto" : "ml-auto")}>
        <IconButton
          label="Settings (S)"
          aria-haspopup="dialog"
          aria-expanded={v.sheetOpen}
          data-testid="settings-toggle"
          className="size-11"
          onClick={() => client.store.dispatch({ type: "local/ui", patch: { sheetOpen: !v.sheetOpen } })}
        >
          <Icon name="gear" />
        </IconButton>
      </div>
    </header>
  )
}

/** The answering assistant: a plain name, or a menu to pick who answers without a phrase (`device.pick`). */
function AssistantName() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      name: topBarName(s),
      canPick: s.setup?.canPick === true,
      canAuto: s.setup?.canAuto === true,
      mode: s.setup?.withoutPhrase.mode,
      assistant: defaultAssistantId(s.setup),
      items: s.setup?.assistants.map((a) => ({ value: a.id, title: a.name, detail: reachText(s, a.id, visualState(s) !== "not-started", displayPhrase) })) ?? []
    }),
    (a, b) => shallowEqual({ ...a, items: JSON.stringify(a.items) }, { ...b, items: JSON.stringify(b.items) })
  )
  if (!v.canPick) return <span data-testid="assistant-name" className="label truncate text-ink">{v.name}</span>
  const items: Array<PopMenuItem> = [
    ...v.items.map((i) => ({ ...i, checked: v.mode === "assistant" && v.assistant === i.value, testId: `assistant-${i.value}` })),
    ...(v.canAuto
      ? [{ value: "typesafe", title: "Whichever fits", detail: "Each thing you say goes to the assistant it suits.", checked: v.mode === "typesafe", separator: true, testId: "assistant-typesafe" }]
      : []),
    { value: "", title: "Nobody", detail: "Sleeps until it hears a phrase", checked: v.mode === "nobody", separator: !v.canAuto, testId: "assistant-nobody" }
  ]
  return (
    <PopMenu
      testId="assistant-menu-button"
      label={v.name}
      title="Who answers on this device"
      menuLabel="Assistants on this device"
      note="This decides who answers without a phrase on this device."
      items={items}
      triggerClass="-ml-2 h-11 px-2 text-ink sm:h-8"
      onPick={(value) => {
        // continuation(none): the setup arrives as a push; only a refusal needs saying.
        void client.pickAssistant(value).then((r) => {
          if (!r.ok) client.store.dispatch({ type: "local/toast", message: r.error?.message ?? "The change was not saved.", tone: "error" })
        })
      }}
    >
      {null}
    </PopMenu>
  )
}
