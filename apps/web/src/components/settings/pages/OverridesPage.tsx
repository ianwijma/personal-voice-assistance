"use client"
import { useState } from "react"
import type { EnvEntry } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Button, cx } from "../../ui/controls.tsx"

/**
 * Diagnostics › Settings from outside (docs/SETTINGS-UI.md §4.4): every variable set in `.env` or the process
 * environment, where it is set (file and line), and the page it belongs to. An admin page moves `.env` settings into
 * the saved settings (keys into the vault) with Move, or all at once; the line is commented out of the file and a
 * backup kept. Values are never shown here.
 */
export function OverridesPage() {
  const client = useClient()
  const env = useClientState((s) => s.env)
  const admin = useClientState((s) => s.vault.admin)
  const vault = useClientState((s) => s.vault, shallowEqual)
  const [busy, setBusy] = useState<string | undefined>()
  const [message, setMessage] = useState<{ readonly tone: "ok" | "error"; readonly text: string } | undefined>()
  if (env === undefined) return <p className="text-[14px] text-ink-muted">This assistant does not report its environment.</p>

  const movable = env.entries.filter((e) => e.movable)
  const move = (keys: ReadonlyArray<string>, id: string) => {
    setBusy(id)
    setMessage(undefined)
    void client.moveFromEnv(keys).then((r) => {
      setBusy(undefined)
      setMessage(r.ok
        ? { tone: "ok", text: keys.length === 1 ? `${keys[0]} is now a saved setting; its line in .env is commented out (a backup is next to it).` : `${keys.length} settings moved; their lines in .env are commented out (a backup is next to it).` }
        : { tone: "error", text: r.error?.message ?? "Could not move them." })
    })
  }
  const groups: ReadonlyArray<{ readonly id: string; readonly title: string; readonly note: string; readonly entries: ReadonlyArray<EnvEntry> }> = [
    {
      id: "refused",
      title: "Not read",
      note: "The assistant knows these and does not read them from the environment; each says why. Remove them.",
      entries: env.entries.filter((e) => e.refused !== undefined)
    },
    { id: "movable", title: "In .env, can move into the settings", note: "Move puts the value in the settings (a key goes into the vault) and comments the line out of .env.", entries: movable },
    {
      id: "process",
      title: "From the process environment",
      note: "Exported by the shell or the service that started the assistant. They win over the settings; unset them there to set them here.",
      entries: env.entries.filter((e) => e.origin === "process" && e.kind !== "bootstrap" && e.refused === undefined)
    },
    { id: "bootstrap", title: "Stay in .env", note: "Read before the settings exist (where they are, the address and port, the vault password).", entries: env.entries.filter((e) => e.kind === "bootstrap") },
    { id: "development", title: "For development", note: "Benchmarks, tests and the command-line audio.", entries: env.entries.filter((e) => e.kind === "development" && e.origin === "file") },
    { id: "unknown", title: "Not used by anything", note: "Nothing reads these: often a typo of a setting's name. Remove them from .env.", entries: env.entries.filter((e) => e.kind === "unknown" && e.refused === undefined) }
  ]
  const lockedVault = vault.state === "locked"
  return (
    <div className="flex flex-col gap-6" data-testid="overrides">
      <p className="text-[13px] text-ink-muted">
        {env.files.length === 0 ? "No .env file was read." : <>Read at start: {env.files.map((f) => <span key={f} className="break-all font-mono text-[12px] text-ink">{f} </span>)}</>}
        {" "}Everything else is set on the settings pages; the environment wins over them.
      </p>
      {movable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-2/40 px-3 py-2.5">
          <span className="text-[13px] text-ink">{movable.length} {movable.length === 1 ? "setting is" : "settings are"} still in .env.</span>
          {admin ? (
            <Button size="sm" variant="primary" className="ml-auto" disabled={busy !== undefined} onClick={() => move(movable.map((e) => e.key), "all")} data-testid="move-all">
              Move all to settings
            </Button>
          ) : (
            <span className="ml-auto text-[12px] text-ink-muted"><Icon name="lock" size={13} className="inline" /> Needs the admin login.</span>
          )}
        </div>
      )}
      {lockedVault && movable.some((e) => e.secret) && admin && (
        <p className="text-[13px] text-warn">The key vault is locked: keys can move once it is unlocked.</p>
      )}
      {message !== undefined && (
        <p role={message.tone === "error" ? "alert" : "status"} className={cx("text-[13px]", message.tone === "error" ? "text-danger" : "text-ok")} data-testid="move-result">{message.text}</p>
      )}
      {groups.filter((g) => g.entries.length > 0).map((g) => (
        <section key={g.id} className="flex flex-col gap-2" data-group={g.id}>
          <h3 className="label text-[11px] text-ink-faint">{g.title}</h3>
          <p className="text-[12px] text-ink-muted">{g.note}</p>
          <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
            {g.entries.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5" data-env={e.key}>
                <span className="font-mono text-[13px] text-ink">{e.key}</span>
                {e.secret && <span className="label rounded-sm border border-line px-1 text-[9px] leading-[14px] text-ink-faint">Key</span>}
                <span className="min-w-0 break-all font-mono text-[11px] text-ink-faint">
                  {e.origin === "file" ? `${e.file ?? ".env"}${e.line !== undefined ? `:${e.line}` : ""}` : "process environment"}
                </span>
                {e.refused !== undefined && <span className="basis-full text-[12px] text-warn" data-testid="env-refused">{e.refused}</span>}
                <span className="ml-auto flex items-center gap-3">
                  {e.page !== undefined && (
                    <button type="button" className="text-[12px] text-voice underline-offset-4 hover:underline" onClick={() => client.settings([e.page!.path[0]!, e.page!.path[1]!])}>
                      {e.page.title}
                    </button>
                  )}
                  {e.movable && admin && (
                    <Button size="sm" disabled={busy !== undefined || (e.secret && lockedVault)} onClick={() => move([e.key], e.key)} aria-label={`Move ${e.key} to settings`}>
                      Move
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {env.entries.length === 0 && <p className="text-[14px] text-ink-muted" data-testid="no-overrides">Nothing is set outside the settings.</p>}
    </div>
  )
}
