"use client"
import { useEffect, useRef, useState } from "react"
import { MintRouteTokenResponse, type ModuleInfo, ModuleRoutesResponse, type RouteCall, type RouteTokenInfo } from "@pva/protocol"
import { Schema } from "effect"
import { resolveWsUrl } from "@/lib/connection.ts"
import { ApiError, apiBaseFor, makeVoiceApi, type VoiceApi } from "@/lib/voiceCatalog.ts"
import { Icon } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"

const GUARD_LABEL: Readonly<Record<string, string>> = { admin: "Admin", token: "Token", lan: "Home network" }

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

type View = ModuleRoutesResponse["modules"][number]

/**
 * What a module exposes over HTTP (protocol 10, docs/UI-AND-MODULES.md §1.11): each route with its guards and limits,
 * its last calls (time, caller address, status), and the module's route tokens: mint one for a caller (the secret is
 * shown once), revoke one. Read through the admin API; "Refresh" reads it again.
 */
export function ModuleRoutes({ module: m, api: given }: { readonly module: ModuleInfo; readonly api?: VoiceApi }) {
  const api = useRef(given ?? makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))).current
  const [view, setView] = useState<View | undefined>(undefined)
  const [locked, setLocked] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [label, setLabel] = useState("")
  const [minted, setMinted] = useState<{ readonly label: string; readonly secret: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const routes = m.routes ?? []
  const tokenNames = [...new Set(routes.flatMap((r) => (r.token !== undefined ? [r.token] : [])))]

  const load = async () => {
    try {
      const res = await api.request(`module-routes?module=${encodeURIComponent(m.id)}`)
      const body = Schema.decodeUnknownSync(ModuleRoutesResponse)(await res.json())
      setView(body.modules.find((x) => x.moduleId === m.id))
      setLocked(body.tokensLocked)
      setProblem(undefined)
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The routes could not be read.")
    }
  }
  useEffect(() => {
    if (routes.length > 0) void load()
  }, [m.id, m.revision])
  if (routes.length === 0) return null

  const mint = async (name: string) => {
    if (label.trim() === "") return setProblem("Say who the token is for.")
    setBusy(true)
    try {
      const res = await api.request(`module-routes/${m.id}/tokens`, { method: "POST", body: { name, label: label.trim() } })
      const body = Schema.decodeUnknownSync(MintRouteTokenResponse)(await res.json())
      setMinted({ label: body.token.label, secret: body.secret })
      setLabel("")
      await load()
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The token was not made.")
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (token: RouteTokenInfo) => {
    if (!window.confirm(`Revoke the token for ${token.label}? Callers using it are refused at once.`)) return
    setBusy(true)
    try {
      await api.request(`module-routes/${m.id}/tokens/${token.id}`, { method: "DELETE" })
      await load()
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The token was not revoked.")
    } finally {
      setBusy(false)
    }
  }

  const callsOf = (path: string, method: string): ReadonlyArray<RouteCall> =>
    view?.routes.find((r) => r.path === path && r.method === method)?.calls ?? []
  return (
    <div className="flex flex-col gap-3" data-testid="module-routes">
      <div className="flex items-center gap-3">
        <h3 className="label text-ink-faint">Web addresses</h3>
        <Button size="sm" variant="quiet" className="ml-auto" onClick={() => void load()}>
          <Icon name="reload" size={13} />
          Refresh
        </Button>
      </div>
      {problem !== undefined && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
      <ul className="flex flex-col gap-3">
        {routes.map((r) => {
          const calls = callsOf(r.path, r.method)
          return (
            <li key={`${r.method} ${r.path}`} className="flex flex-col gap-1.5 rounded-md border border-line/70 px-3 py-2.5" data-testid="module-route">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-[12px] text-ink-muted">{r.method}</span>
                <span className="break-all font-mono text-[13px] text-ink">{r.path}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {r.public ? (
                  <span className="label rounded-sm border border-warn/50 px-1 text-[9px] text-warn">Public</span>
                ) : (
                  r.guards.map((g) => <span key={g} className="label rounded-sm border border-line px-1 text-[9px] text-ink-muted" data-guard={g}>{GUARD_LABEL[g] ?? g}</span>)
                )}
                <span className="text-[12px] text-ink-faint">
                  {r.bodyLimitBytes > 0 ? `body ≤ ${Math.round(r.bodyLimitBytes / 1024)} KB · ` : "no body · "}
                  {r.ratePerMinute.perAddress}/min per caller
                </span>
              </div>
              {r.description !== undefined && <p className="text-[13px] text-ink-muted">{r.description}</p>}
              {calls.length === 0 ? (
                <p className="text-[12px] text-ink-faint">No calls since the server started.</p>
              ) : (
                <table className="w-full text-left text-[12px]">
                  <caption className="sr-only">Last calls of {r.path}</caption>
                  <thead className="text-ink-faint">
                    <tr><th className="font-normal">Time</th><th className="font-normal">Caller</th><th className="font-normal">Status</th></tr>
                  </thead>
                  <tbody className="font-mono text-ink-muted">
                    {calls.slice(0, 5).map((c, i) => (
                      <tr key={i} data-testid="route-call" title={c.note ?? c.token ?? ""}>
                        <td>{time(c.at)}</td>
                        <td className="break-all">{c.address}{c.token !== undefined ? ` · ${c.token}` : ""}</td>
                        <td className={cx(c.status >= 400 ? "text-danger" : "text-ok")}>{c.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          )
        })}
      </ul>
      {tokenNames.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="route-tokens">
          <h4 className="text-[13px] font-medium text-ink">Tokens</h4>
          {locked ? (
            <p className="text-[13px] text-ink-muted">The key vault is locked: unlock it to see, make or revoke tokens. Calls that need a token are refused meanwhile.</p>
          ) : (
            <>
              {(view?.tokens ?? []).length === 0 && <p className="text-[13px] text-ink-faint">No tokens yet.</p>}
              <ul className="flex flex-col gap-1">
                {(view?.tokens ?? []).map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-[13px]" data-testid="route-token">
                    <Icon name="key" size={13} className="text-ink-faint" />
                    <span className="text-ink">{t.label}</span>
                    <span className="text-ink-faint">{t.lastUsedAt !== undefined ? `used ${time(t.lastUsedAt)}` : "not used yet"}</span>
                    <Button size="sm" variant="quiet" className="ml-auto" disabled={busy} onClick={() => void revoke(t)}>Revoke</Button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  aria-label="Who the new token is for"
                  placeholder="Who it is for, e.g. Home Assistant"
                  value={label}
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                  className="h-8 min-w-48 flex-1 rounded-md border border-line bg-surface-2/60 px-2 text-[13px] text-ink placeholder:text-ink-faint"
                />
                <Button size="sm" disabled={busy} onClick={() => void mint(tokenNames[0]!)}>
                  <Icon name="plus" size={13} />
                  New token
                </Button>
              </div>
              {minted !== undefined && (
                <div className="flex flex-col gap-1 rounded-md border border-ok/40 bg-ok/5 px-3 py-2" data-testid="minted-token">
                  <p className="text-[13px] text-ink">The token for {minted.label}. Copy it now: it is not shown again.</p>
                  <code className="break-all font-mono text-[12px] text-ink">{minted.secret}</code>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
