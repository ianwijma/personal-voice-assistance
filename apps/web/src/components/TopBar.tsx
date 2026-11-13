"use client"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "./context.tsx"
import { LatencyReadout } from "./LatencyReadout.tsx"
import { Icon } from "./ui/Icon.tsx"
import { cx, IconButton, ToneDot } from "./ui/controls.tsx"

const STATE_WORD: Record<string, string> = {
  idle: "idle",
  listening: "listening",
  hearing: "hearing you",
  thinking: "thinking",
  speaking: "speaking"
}

export function TopBar() {
  const client = useClient()
  const v = useClientState(
    (s) => ({
      status: s.connection.status,
      attempt: s.connection.attempt,
      everConnected: s.connection.everConnected,
      owner: s.session.role === "owner" && s.audio.phase !== "off",
      ownerPresent: s.session.ownerPresent,
      serverState: s.session.serverState,
      micLive: s.audio.micLive,
      engine: s.engine.state
    }),
    shallowEqual
  )
  let text: string
  let tone: "ok" | "warning" | "error" | "neutral"
  if (v.status === "outdated") {
    text = "page out of date"
    tone = "error"
  } else if (v.status !== "open") {
    text = v.everConnected ? `reconnecting (${v.attempt})…` : "connecting…"
    tone = "warning"
  } else if (v.engine === "failed") {
    text = "engines failed"
    tone = "error"
  } else if (v.engine === "reloading" || v.engine === "starting") {
    text = v.engine === "reloading" ? "reloading engines…" : "starting engines…"
    tone = "warning"
  } else if (!v.owner && v.ownerPresent) {
    text = `${STATE_WORD[v.serverState] ?? v.serverState} · on another device`
    tone = "neutral"
  } else if (!v.owner) {
    text = "ready"
    tone = "neutral"
  } else {
    text = !v.micLive && v.serverState !== "thinking" && v.serverState !== "speaking" ? "mic off" : STATE_WORD[v.serverState] ?? v.serverState
    tone = "ok"
  }
  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-3 px-3 sm:gap-5 sm:px-6">
      <div className="flex min-w-0 items-center gap-2.5 pl-1">
        <ToneDot tone={tone} className={cx("size-2", tone === "warning" && "animate-pulse")} />
        <span className="label hidden text-ink sm:inline">PVA</span>
        <span data-testid="connection-status" className="label truncate text-ink-muted">
          {text}
        </span>
      </div>
      {v.owner && (
        <button
          type="button"
          onClick={client.endAudio}
          className="label hidden h-8 rounded-md px-2.5 text-ink-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-ink sm:inline-flex sm:items-center"
          title="Release the microphone and speaker"
        >
          End
        </button>
      )}
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <LatencyReadout />
        <IconButton
          label="Settings (O)"
          aria-haspopup="dialog"
          onClick={() => client.settings(client.store.get().ui.settingsPath)}
        >
          <Icon name="gear" />
        </IconButton>
      </div>
    </header>
  )
}
