import { resolveSettings } from "@pva/core"
import { decodeRiskPolicy, RISK_POLICY_KEYS, type RiskPolicy } from "@pva/protocol"
import { riskSection } from "./sectionDefinitions.ts"

/**
 * THE reader of the household's effective risk policy (P8, review round 1 H1): the `risk` section's own fields resolved
 * exactly as every settings page and reader resolves them (`resolveSettings`: the environment over the saved value over
 * the default; an environment value trimmed and checked against the choices; a saved value of the wrong type or outside
 * the choices read as the field's default), then `decodeRiskPolicy` (`money` and `security` are `deny` whatever is
 * given). Serve mode publishes its result into an in-memory record at start, at every committed save and when the
 * environment changes (`Sections.riskPolicy`); the CLI modes read it once at their start. Pure: it reads nothing but its
 * arguments (no section definitions are built, no file is touched).
 */
export const effectiveRiskPolicy = (sources: {
  /** The saved flat values (`SettingsStore.settings().assistant`). */
  readonly stored: Readonly<Record<string, unknown>>
  /** The environment (only the policy's keys are read). */
  readonly env: Readonly<Record<string, string | undefined>>
}): RiskPolicy => {
  const env: Record<string, string | undefined> = {}
  for (const key of Object.values(RISK_POLICY_KEYS)) if (Object.hasOwn(sources.env, key)) env[key] = sources.env[key]
  const stored: Record<string, unknown> = {}
  for (const key of Object.values(RISK_POLICY_KEYS)) if (Object.hasOwn(sources.stored, key)) stored[key] = sources.stored[key]
  const values = resolveSettings(riskSection.spec, { stored, secrets: {}, env }).form.values
  return decodeRiskPolicy((key) => values[key])
}

/** The policy as flat values of its keys (what the settings `ConfigProvider` serves for them). */
export const riskPolicyValues = (policy: RiskPolicy): Readonly<Record<string, string>> => ({
  [RISK_POLICY_KEYS.read]: policy.read,
  [RISK_POLICY_KEYS.change]: policy.change,
  [RISK_POLICY_KEYS.message]: policy.message,
  [RISK_POLICY_KEYS.money]: policy.money,
  [RISK_POLICY_KEYS.security]: policy.security
})

/** Serve mode's gateway hook (`gatewayHooks.policy`): the record the sections publish, read as a field. */
export const servePolicyReader = (sections: { readonly riskPolicy: () => RiskPolicy }): (() => RiskPolicy) => () => sections.riskPolicy()
