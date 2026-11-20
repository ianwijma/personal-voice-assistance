import type { Effect } from "effect"
import { ServiceKey } from "./ModuleApi.ts"

/**
 * Reports (docs/REPORTS.md): a problem or a feature idea a person told the assistant about. A core service, provided
 * by serve mode through `host.service` (`ModuleHostOptions.coreServices`, like `SessionControl`), because what makes
 * a report useful is what only the host holds: the conversation's history with its tool calls and results, the turn
 * traces, the device, the assistant, the server's version, its recent warnings. A module (the report module) gives
 * the person the way in and passes what they said; the host adds the rest, keeps the report, and sends it to GitHub
 * when the owner says so. Absent in the CLI modes.
 *
 * Given to the report module only (`ModuleHostOptions.moduleCoreServices`; every other module's `host.service(Reports)`
 * is `undefined`), and only within a turn: the host reads the turn from `CurrentTurn` (the gateway's admitted call),
 * never from the module.
 */
export interface ReportInput {
  readonly kind: "problem" | "feature"
  /** One line: the issue's title. */
  readonly title: string
  /** What the person said is wrong or wanted, in their words as far as possible, including what they saw or heard. */
  readonly description: string
  /** What the assistant asked before filing and what the person answered, in order. */
  readonly answers?: ReadonlyArray<{ readonly question: string; readonly answer: string }>
  /**
   * Whether the calling tool was declared to send at once (its `message` class). The host sends at once only when this
   * and the owner's setting both say so; otherwise it keeps a draft.
   */
  readonly send: boolean
}

export interface ReportDrafted {
  readonly id: string
  /**
   * `draft`: kept for the owner to read and send from the admin panel. `sent`: the install sends at once and the
   * issue exists. `failed`: it sends at once and GitHub refused or could not be reached; kept, and can be sent again.
   */
  readonly status: "draft" | "sent" | "failed"
  readonly issueNumber?: number
}

/**
 * The owner's report settings, as the report module holds them (its own settings page: a secret and a switch). The
 * module hands them over from its shared part and takes them back when that part closes (`configure(undefined)`), so
 * the host never keeps a token the module no longer runs with.
 */
export interface ReportsSettings {
  /** The install's GitHub token, from the key vault. Absent: reports are kept, and filed by hand from the admin page. */
  readonly token?: string
  /**
   * Send a new report to GitHub at once, without the owner reading it first (default off). The module declares its
   * tool `message` while this is on (docs/REPORTS.md "Risk"), so the household's risk policy decides whether it runs.
   */
  readonly sendImmediately: boolean
}

export interface ReportsService {
  /**
   * Keep a report with everything known about the current turn's (`CurrentTurn`) conversation. Never fails for want of
   * context: what is not there (no history after a restart, no device) is left out and said so in the report. Outside
   * a turn it dies (a report is made in a turn).
   */
  readonly draft: (input: ReportInput) => Effect.Effect<ReportDrafted>
  /**
   * The owner's settings from the report module (`undefined`: the module stopped; no token, nothing sent at once). The
   * last call wins. A token passed here is used only to file issues and is never logged, stored or shown.
   */
  readonly configure: (settings: ReportsSettings | undefined) => Effect.Effect<void>
}

export const Reports = ServiceKey<ReportsService>("core.reports")
