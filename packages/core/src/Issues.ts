import { HealthIssue, type HealthIssue as Issue } from "@pva/protocol"
import { Schema } from "effect"

/**
 * The issue registry (module-definition §C.5, after Home Assistant's Repairs): every current issue, grouped by the
 * source that reported it. A source replaces all of its issues at once (`set`), so an issue that is fixed disappears
 * at the next check. Sources used by the host: `module:<id>` (requirements, unavailable, a failed start or restart)
 * and `health:<id>` (the module's own `health()`); the app adds `core` (the core checks of `pnpm start doctor`).
 */
export interface IssueRegistry {
  /** Every issue: errors first, then warnings, then information; within a severity in the order of the sources. */
  readonly all: () => ReadonlyArray<Issue>
  /** Replace the issues of `source` (an empty list removes them). Listeners are called only when something changed. */
  readonly set: (source: string, issues: ReadonlyArray<Issue>) => void
  /** Called after every change. Returns an unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

const RANK: Readonly<Record<Issue["severity"], number>> = { error: 0, warning: 1, info: 2 }

const isWireIssue = Schema.is(HealthIssue)
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * An issue made safe for the wire's `HealthIssue`, whatever reported it (a module, the core checks, the app): every
 * bounded text clipped to its limit (id, device and title 200, detail 2000, the fix's label 200 and value 1000). One
 * that still does not fit (an unknown severity or fix kind) is replaced by one that says so, so no source can break
 * the health message or the admin snapshot.
 */
export const wireSafeIssue = (issue: Issue, source: string, index: number): Issue => {
  const fix = issue.fix === undefined ? undefined : {
    kind: issue.fix.kind,
    label: clip(String(issue.fix.label ?? ""), 200),
    ...(issue.fix.value !== undefined ? { value: clip(String(issue.fix.value), 1000) } : {})
  }
  const out: Issue = {
    id: clip(String(issue.id ?? ""), 200),
    ...(issue.module !== undefined ? { module: clip(String(issue.module), 200) } : {}),
    ...(issue.device !== undefined ? { device: clip(String(issue.device), 200) } : {}),
    severity: issue.severity,
    title: clip(String(issue.title ?? ""), 200),
    detail: clip(String(issue.detail ?? ""), 2000),
    ...(fix !== undefined ? { fix } : {})
  }
  if (isWireIssue(out)) return out
  return { id: clip(`${source}.malformed-issue-${index}`, 200), severity: "warning", title: "An issue could not be shown", detail: `${source} reported an issue whose severity or fix kind the page does not know.` }
}

export const makeIssueRegistry = (): IssueRegistry => {
  const bySource = new Map<string, { readonly key: string; readonly issues: ReadonlyArray<Issue> }>()
  const listeners = new Set<() => void>()
  let all: ReadonlyArray<Issue> | undefined
  return {
    all: () => {
      all ??= [...bySource.values()].flatMap((s) => s.issues).map((issue, i) => ({ issue, i }))
        .sort((a, b) => RANK[a.issue.severity] - RANK[b.issue.severity] || a.i - b.i)
        .map(({ issue }) => issue)
      return all
    },
    set: (source, raw) => {
      // Normalised at the boundary, for every source (the host's module sources, `core`, the app's own).
      const issues = raw.slice(0, 200).map((issue, i) => wireSafeIssue(issue, source, i))
      const key = JSON.stringify(issues)
      if ((bySource.get(source)?.key ?? "[]") === key) return
      if (issues.length === 0) bySource.delete(source)
      else bySource.set(source, { key, issues: [...issues] })
      all = undefined
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // A listener must not break the registry.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
