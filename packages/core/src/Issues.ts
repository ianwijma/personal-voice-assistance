import type { HealthIssue as Issue } from "@pva/protocol"

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
    set: (source, issues) => {
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
