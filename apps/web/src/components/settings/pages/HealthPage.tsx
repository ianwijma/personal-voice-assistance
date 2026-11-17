"use client"
import { useEffect, useState } from "react"
import type { HealthIssue } from "@pva/protocol"
import { shallowEqual } from "@/lib/store.ts"
import { useClient, useClientState } from "../../context.tsx"
import { Spinner } from "../../ui/Icon.tsx"
import { Button, cx } from "../../ui/controls.tsx"

/**
 * Diagnostics › Health (protocol 9; module-definition-config-and-dependencies.md §C.5): the server's issue registry,
 * the same issues `pnpm start doctor` prints, grouped by the core and each module, each with its fix. "Check again"
 * probes the programs the modules need, judges again which modules can run (starting those that now can), and runs
 * every module's health check and the core checks.
 */

const SEVERITY: Readonly<Record<HealthIssue["severity"], { readonly label: string; readonly dot: string; readonly text: string }>> = {
  error: { label: "Error", dot: "bg-danger", text: "text-danger" },
  warning: { label: "Warning", dot: "bg-warn", text: "text-warn" },
  info: { label: "Note", dot: "bg-line", text: "text-ink-faint" }
}

/** "just now", "3 min ago", "at 14:05". */
const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  return `at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
}

function IssueFix({ fix }: { readonly fix: NonNullable<HealthIssue["fix"]> }) {
  if (fix.kind === "link" && fix.value !== undefined) {
    const external = /^https?:\/\//.test(fix.value)
    return (
      <a
        href={fix.value}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        className="self-start text-[13px] text-voice underline-offset-4 hover:underline"
      >
        {fix.label}
      </a>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[13px]">
      <span className="text-ink-muted">{fix.label}{fix.kind === "command" && fix.value !== undefined ? ":" : ""}</span>
      {fix.kind === "command" && fix.value !== undefined && (
        <code className="block overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-line/70 bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink" data-testid="issue-command">
          {fix.value}
        </code>
      )}
    </div>
  )
}

export function HealthPage() {
  const client = useClient()
  const health = useClientState((s) => s.health)
  const names = useClientState((s) => Object.fromEntries(s.modules.order.map((id) => [id, s.modules.byId[id]?.name ?? id])), shallowEqual)
  const order = useClientState((s) => s.modules.order, shallowEqual)
  const [asked, setAsked] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  if (health === undefined) return <p className="text-[14px] text-ink-muted" data-testid="no-health">This server keeps no health checks.</p>

  const checking = health.checking || asked
  const checkAgain = async () => {
    setAsked(true)
    const result = await client.checkHealth() // continuation(none): this page's own button state
    setAsked(false)
    setNow(Date.now())
    if (!result.ok) client.store.dispatch({ type: "local/toast", message: `Health check: ${result.error?.message ?? "it failed."}`, tone: "error" })
  }

  const count = (s: HealthIssue["severity"]) => health.issues.filter((i) => i.severity === s).length
  const errors = count("error")
  const warnings = count("warning")
  // Core first, then the modules in catalog order (a module the page does not know last).
  const groups = new Map<string, Array<HealthIssue>>()
  for (const issue of health.issues) {
    const key = issue.module ?? ""
    groups.set(key, [...(groups.get(key) ?? []), issue])
  }
  const rank = (key: string) => (key === "" ? -1 : order.includes(key) ? order.indexOf(key) : order.length)
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b))

  return (
    <div className="flex flex-col gap-4" data-testid="health-page">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[14px] text-ink" data-testid="health-summary" aria-live="polite">
          {health.issues.length === 0
            ? "No problems found."
            : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`}
          <span className="text-ink-faint">
            {checking ? " · checking…" : health.checkedAt !== undefined ? ` · checked ${ago(health.checkedAt, now)}` : " · not checked yet"}
          </span>
        </p>
        <Button size="sm" onClick={() => void checkAgain()} disabled={checking} data-testid="health-check">
          {checking && <Spinner size={12} />}Check again
        </Button>
      </div>
      {keys.map((key) => (
        <section key={key || "core"} aria-label={key === "" ? "The assistant itself" : names[key] ?? key} className="flex flex-col gap-2" data-testid="health-group" data-module={key || "core"}>
          <h3 className="label text-ink-faint">{key === "" ? "The assistant itself" : names[key] ?? key}</h3>
          <ul className="flex flex-col gap-2">
            {groups.get(key)!.map((issue) => {
              const sev = SEVERITY[issue.severity]
              return (
                <li key={issue.id} className="flex flex-col gap-1.5 rounded-md border border-line/70 px-3 py-2.5" data-testid="health-issue" data-severity={issue.severity}>
                  <div className="flex items-baseline gap-2">
                    <span aria-hidden="true" className={cx("inline-block size-2 shrink-0 self-center rounded-full", sev.dot)} />
                    <span className={cx("label text-[10px]", sev.text)}>{sev.label}</span>
                    <span className="min-w-0 text-[14px] font-medium text-ink">{issue.title}</span>
                  </div>
                  {issue.detail !== "" && <p className="text-[13px] text-ink-muted">{issue.detail}</p>}
                  {issue.fix !== undefined && <IssueFix fix={issue.fix} />}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
