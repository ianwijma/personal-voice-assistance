import { decideRisk, DEFAULT_RISK_POLICY, riskReason } from "@pva/protocol"
import type { ToolRisk } from "./Module.ts"

/**
 * The risk policy (docs/MODULES-PLAN.md §2 rows 5 and 6, §4 P8 "First version"; docs/MODULES.md §4). Since P8 it is a
 * household setting (the admin's Shared settings › Risk policy; flat keys `RISK_READ`, `RISK_CHANGE`, `RISK_MESSAGE`),
 * and its one decision is `decideRisk` in `@pva/protocol`, a pure function of the saved policy, the classes a tool or
 * action declares and the class its risk function gave for the validated input. The execution gateway reads the policy
 * at every decision (`GatewayOptions.policy`) and uses `decideRisk` on every path and for every tool of a turn's list
 * (`riskOffered`). The server, the CLI modes, the module test kit and the web mock use the same functions.
 */
export {
  decideRisk,
  decodeRiskPolicy,
  DEFAULT_RISK_POLICY,
  FIXED_RISK_CLASSES,
  RISK_CLASSES,
  RISK_OUTCOMES,
  RISK_POLICY_KEYS,
  type RiskDecision,
  type RiskLanguage,
  riskLanguageOf,
  riskOffered,
  type RiskOutcome,
  type RiskPolicy,
  riskPolicyKey,
  riskPolicyOf,
  riskReason,
  riskSpoken,
  riskWithheld,
  SETTABLE_RISK_CLASSES
} from "@pva/protocol"

/** P1's form of a policy's answer for one class: `allow`, or a refusal with its English reason for the model. */
export type RiskVerdict = { readonly outcome: "allow" } | { readonly outcome: "confirm" | "deny"; readonly reason: string }

/**
 * P1's default policy as a function of one class, kept for callers that judged a bare class: exactly
 * `decideRisk(DEFAULT_RISK_POLICY, [risk], risk)` with its English reason (`read` and `change` allowed, `message`
 * refused as needing confirmation, `money`, `security` and a string that is no class denied).
 */
export const defaultRiskPolicy = (risk: ToolRisk): RiskVerdict => {
  const decision = decideRisk(DEFAULT_RISK_POLICY, [risk], risk)
  return decision.outcome === "allow" ? { outcome: "allow" } : { outcome: decision.outcome, reason: riskReason("en", decision)! }
}
