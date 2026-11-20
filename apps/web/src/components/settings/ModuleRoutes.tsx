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
 * its last calls (time, caller address, status), and the module's route tokens: mint one for a caller and a purpose
 * (the token name its routes accept; the secret is shown once), revoke one. Read through the admin API whether or not
 * the module runs, so a stopped module's tokens can still be seen and revoked; "Refresh" reads it again. Behind a
 * declared reverse proxy (`SERVE_BEHIND_PROXY`) its `lan` routes are marked unreachable.
 */
export function ModuleRoutes({ module: m, api: given }: { readonly module: ModuleInfo; readonly api?: VoiceApi }) {
  const api = useRef(given ?? makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))).current
  const [view, setView] = useState<View | undefined>(undefined)
  const [locked, setLocked] = useState(false)
  const [behindProxy, setBehindProxy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [label, setLabel] = useState("")
  const [purpose, setPurpose] = useState<string | undefined>(undefined)
  const [minted, setMinted] = useState<{ readonly label: string; readonly name: string; readonly secret: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // The routes as the module info lists them; the admin route API lists them all (a module whose projection was
  // too large for one message lists fewer there, `withinModuleFrame`), so its list is shown when it has more.
  const listed = m.routes ?? []
  const routes = view !== undefined && view.routes.length > listed.length ? view.routes : listed
  const tokens = view?.tokens ?? []
  // Purposes: the token names of the routes now, and of tokens already made (a stopped module has no routes).
  const tokenNames = [...new Set([...routes.flatMap((r) => (r.token !== undefined ? [r.token] : [])), ...tokens.map((t) => t.name)])].sort()
  const chosen = purpose !== undefined && tokenNames.includes(purpose) ? purpose : tokenNames[0]
  const routesFor = (name: string) => routes.filter((r) => r.token === name).map((r) => `${r.method} ${r.path}`)

  const load = async () => {
    try {
      const res = await api.request(`module-routes?module=${encodeURIComponent(m.id)}`)
      const body = Schema.decodeUnknownSync(ModuleRoutesResponse)(await res.json())
      setView(body.modules.find((x) => x.moduleId === m.id))
      setLocked(body.tokensLocked)
      setBehindProxy(body.behindProxy)
      setProblem(undefined)
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The routes could not be read.")
    }
  }
  useEffect(() => {
    void load()
  }, [m.id, m.revision, m.state])
  if (routes.length === 0 && tokens.length === 0) return null

  const mint = async (name: string) => {
    if (label.trim() === "") return setProblem("Say who the token is for.")
    setBusy(true)
    try {
      const res = await api.request(`module-routes/${m.id}/tokens`, { method: "POST", body: { name, label: label.trim() } })
      const body = Schema.decodeUnknownSync(MintRouteTokenResponse)(await res.json())
      setMinted({ label: body.token.label, name: body.token.name, secret: body.secret })
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
      {routes.length === 0 && (
        <p className="text-[13px] text-ink-muted" data-testid="routes-stopped">
          {m.name} is not running, so its addresses answer “not found”. Its tokens are kept: revoke any you no longer trust.
        </p>
      )}
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
              {behindProxy && r.guards.includes("lan") && (
                <p className="text-[13px] text-warn" data-testid="route-unreachable">
                  Unreachable: the server is set to be behind a reverse proxy (SERVE_BEHIND_PROXY), so no caller counts as on the home network. Callers from outside use an address that needs a token.
                </p>
              )}
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
                    {tokenNames.length > 1 && <span className="font-mono text-[12px] text-ink-muted" data-testid="route-token-name">{t.name}</span>}
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
                {tokenNames.length > 1 && (
                  <select
                    aria-label="What the new token is for"
                    value={chosen}
                    onChange={(e) => setPurpose(e.target.value)}
                    className="h-8 rounded-md border border-line bg-surface-2/60 px-2 font-mono text-[13px] text-ink"
                    data-testid="route-token-purpose"
                  >
                    {tokenNames.map((n) => (
                      <option key={n} value={n}>{n}{routesFor(n).length > 0 ? ` (${routesFor(n).length} ${routesFor(n).length === 1 ? "address" : "addresses"})` : ""}</option>
                    ))}
                  </select>
                )}
                <Button size="sm" disabled={busy || chosen === undefined} onClick={() => chosen !== undefined && void mint(chosen)}>
                  <Icon name="plus" size={13} />
                  New token
                </Button>
              </div>
              {chosen !== undefined && tokenNames.length > 1 && routesFor(chosen).length > 0 && (
                <p className="text-[12px] text-ink-faint">A “{chosen}” token opens {routesFor(chosen).join(", ")}.</p>
              )}
              {minted !== undefined && (
                <div className="flex flex-col gap-1 rounded-md border border-ok/40 bg-ok/5 px-3 py-2" data-testid="minted-token">
                  <p className="text-[13px] text-ink">The {tokenNames.length > 1 ? `“${minted.name}” ` : ""}token for {minted.label}. Copy it now: it is not shown again.</p>
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
