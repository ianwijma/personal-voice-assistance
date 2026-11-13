"use client"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "./context.tsx"
import { Spinner } from "./ui/Icon.tsx"

/** A bar at the top of the stage when the engines failed or are (re)loading. */
export function EngineBanner() {
  const client = useClient()
  const e = useClientState((s) => ({ state: s.engine.state, problems: s.engine.problems, open: s.connection.status === "open" }), shallowEqual)
  if (!e.open || e.state === "ready") return null
  const openOptions = () => client.store.dispatch({ type: "local/ui", patch: { optionsOpen: true, optionsTab: "assistant" } })
  return (
    <div
      role="status"
      data-testid="engine-banner"
      className="absolute inset-x-3 top-2 mx-auto flex max-w-[720px] items-start gap-3 rounded-md border border-line bg-surface px-4 py-2.5 text-[14px] sm:inset-x-6"
    >
      {e.state === "failed" ? (
        <>
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-ink">
            The assistant can't listen right now:{" "}
            <span className="text-ink-muted">{e.problems.map((p) => `${p.stage}: ${p.message}`).join(" · ") || "the engines failed to start."}</span>
          </p>
          <button type="button" onClick={openOptions} className="shrink-0 text-[13px] text-voice underline-offset-4 hover:underline">
            Open options
          </button>
        </>
      ) : (
        <>
          <Spinner className="mt-[3px] text-ink-muted" />
          <p className="text-ink-muted">{e.state === "reloading" ? "Reloading engines…" : "Starting engines…"}</p>
        </>
      )}
    </div>
  )
}
