import type { ToolRisk } from "./Module.ts"

/**
 * The risk policy (docs/MODULES-PLAN.md §2 row 5, §4 P1 and P8): what the execution gateway does with a call of each
 * risk class. `allow` runs it; `confirm` and `deny` both refuse it, each with its own sentence for the model (the
 * gateway's "Not run: …"). A tool or action whose every declared class is refused is left out of a turn's tool list
 * and action catalogue (`ExecutionGateway.offers`), and every call is checked again with its validated input, on every
 * path (a model's tool call, a typed action, `host.actions.run`, a job, a notification's action).
 */
export type RiskVerdict = { readonly outcome: "allow" } | { readonly outcome: "confirm" | "deny"; readonly reason: string }

export type RiskPolicy = (risk: ToolRisk) => RiskVerdict

const ALLOWED: RiskVerdict = { outcome: "allow" }
const MESSAGE: RiskVerdict = {
  outcome: "confirm",
  reason: "it would send a message in the owner's name, which needs the owner's confirmation, and this assistant cannot ask for it yet."
}
const MONEY: RiskVerdict = { outcome: "deny", reason: "it would spend money, which this assistant never does." }
const SECURITY: RiskVerdict = { outcome: "deny", reason: "it would act on a lock, an alarm, a door or a gate, which this assistant never does." }

/**
 * The household's default and, in this stack, only policy: `read` and `change` are allowed; `message` needs
 * confirmation, which is not built, so it is refused; `money` and `security` are denied everywhere (a device is not
 * authenticated, so none can be trusted with them). Serve mode, the CLI modes and the module test kit give it to the
 * module host (`ModuleHostOptions.gatewayHooks.riskPolicy`). P8 makes `message` a household setting.
 */
export const defaultRiskPolicy: RiskPolicy = (risk) => {
  switch (risk) {
    case "read":
    case "change":
      return ALLOWED
    case "message":
      return MESSAGE
    case "money":
      return MONEY
    case "security":
      return SECURITY
    default:
      // A class this stack does not know (a module's typo that slipped past its start check) is never allowed.
      return { outcome: "deny", reason: "what it would do is not a risk class this assistant knows." }
  }
}
