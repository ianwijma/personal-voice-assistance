import { HealthIssue, type HealthIssue as Issue, MAX_HEALTH_ISSUES } from "@pva/protocol"
import { Schema } from "effect"

/**
 * The issue registry (module-definition §C.5, after Home Assistant's Repairs): every current issue, grouped by the
 * source that reported it. A source replaces all of its issues at once (`set`), so an issue that is fixed disappears
 * at the next check. Sources used by the host: `module:<id>` (requirements, unavailable, a failed start, module code
 * that hung) and `health:<id>` (the module's own `health()`); the app may add its own.
 */
export interface IssueRegistry {
  /**
   * Every issue: errors first, then warnings, then information; within a severity in the order of the sources. At
   * most `MAX_HEALTH_ISSUES` and `ISSUES_BUDGET_BYTES` in all (so the health message fits one frame); what is left
   * out is said in a last issue ("and 12 more").
   */
  readonly all: () => ReadonlyArray<Issue>
  /** Replace the issues of `source` (an empty list removes them). Listeners are called only when something changed. */
  readonly set: (source: string, issues: ReadonlyArray<Issue>) => void
  /** Called after every change. Returns an unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

const RANK: Readonly<Record<Issue["severity"], number>> = { error: 0, warning: 1, info: 2 }

/** The UTF-8 size all issues together may have on the wire (well under the 1 MiB frame, with the rest of a snapshot). */
export const ISSUES_BUDGET_BYTES = 256 * 1024

const isWireIssue = Schema.is(HealthIssue)

// C0 and C1 control characters (ESC included), and the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// The same without the line feed (a multi-line detail keeps its lines).
// eslint-disable-next-line no-control-regex
const CONTROLS_BUT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** One line of text, safe for the wire and a terminal: no control characters or line breaks, spaces collapsed, clipped. */
export const oneLine = (text: unknown, max: number): string => clip(String(text ?? "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim(), max)

/** A block of text: line feeds kept (a carriage return is one), every other control character removed, clipped. */
export const textBlock = (text: unknown, max: number): string =>
  clip(String(text ?? "").replace(/\r\n?/g, "\n").replace(CONTROLS_BUT_LF, " ").replace(/[ \t]+/g, " ").trim(), max)

/**
 * An issue made safe for the wire's `HealthIssue` and for a terminal, whatever reported it: the id, module, device,
 * title and the fix's label and value are one line each; the detail may have line breaks; no other control character
 * survives; every text is clipped to its limit (id, device and title 200, detail 2000, the fix's label 200 and value
 * 1000). One that still does not fit (an unknown severity or fix kind) is replaced by one that says so, so no source
 * can break the health message or the admin snapshot.
 */
export const wireSafeIssue = (issue: Issue, source: string, index: number): Issue => {
  const fix = issue.fix === undefined ? undefined : {
    kind: issue.fix.kind,
    label: oneLine(issue.fix.label, 200),
    ...(issue.fix.value !== undefined ? { value: oneLine(issue.fix.value, 1000) } : {})
  }
  const out: Issue = {
    id: oneLine(issue.id, 200) || `${oneLine(source, 150)}.${index}`,
    ...(issue.module !== undefined ? { module: oneLine(issue.module, 200) } : {}),
    ...(issue.device !== undefined ? { device: oneLine(issue.device, 200) } : {}),
    severity: issue.severity,
    title: oneLine(issue.title, 200),
    detail: textBlock(issue.detail, 2000),
    ...(fix !== undefined ? { fix } : {})
  }
  if (isWireIssue(out)) return out
  return { id: oneLine(`${source}.malformed-issue-${index}`, 200), severity: "warning", title: "An issue that cannot be shown", detail: `${oneLine(source, 200)} reported an issue whose severity, fix kind or module id the page does not know.` }
}

/** At most `max` issues: the first `max - 1` and one that says how many more there are, made by `more`. */
export const boundIssues = (list: ReadonlyArray<Issue>, max: number, more: (count: number) => Issue): ReadonlyArray<Issue> =>
  list.length <= max ? list : [...list.slice(0, max - 1), more(list.length - (max - 1))]

const encoder = new TextEncoder()

export const makeIssueRegistry = (): IssueRegistry => {
  const bySource = new Map<string, { readonly key: string; readonly issues: ReadonlyArray<Issue> }>()
  const listeners = new Set<() => void>()
  let all: ReadonlyArray<Issue> | undefined
  return {
    all: () => {
      if (all !== undefined) return all
      const sorted = [...bySource.values()].flatMap((s) => s.issues).map((issue, i) => ({ issue, i }))
        .sort((a, b) => RANK[a.issue.severity] - RANK[b.issue.severity] || a.i - b.i)
        .map(({ issue }) => issue)
      // Bounded by count and by size, keeping room for the last issue that says what was left out.
      const out: Array<Issue> = []
      let bytes = 0
      for (const issue of sorted) {
        const size = encoder.encode(JSON.stringify(issue)).length
        if (out.length === MAX_HEALTH_ISSUES - 1 || bytes + size > ISSUES_BUDGET_BYTES - 1024) break
        out.push(issue)
        bytes += size
      }
      const left = sorted.length - out.length
      if (left > 0) {
        out.push({ id: "issues.more", severity: "warning", title: `And ${left} more issue${left === 1 ? "" : "s"}`, detail: "Only the first ones fit on this page; fix these and check again." })
      }
      all = out
      return all
    },
    set: (source, raw) => {
      // Normalised at the boundary, for every source (the host's module sources and the app's own).
      const issues = raw.slice(0, MAX_HEALTH_ISSUES).map((issue, i) => wireSafeIssue(issue, source, i))
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
