"use client"
import { useMemo } from "react"
import { decideRisk, decodeRiskPolicy, RISK_CLASSES, riskLanguageOf, riskPageTexts, riskSpoken } from "@pva/protocol"
import { savedValues } from "@/lib/settingsTree.ts"
import { useClientState } from "../../context.tsx"

/**
 * Shared settings › Risk policy, below the policy's form (docs/SETTINGS-UI.md "Risk policy", docs/MODULES.md §4): for
 * each kind of call, what the saved policy does and what the person hears when it is refused, in the household's
 * language (Home › Language: Dutch or English). Made with the server's own functions (`decodeRiskPolicy`,
 * `decideRisk`, `riskSpoken` from `@pva/protocol`), from the saved values, so it shows what the next call gets.
 */
export function RiskPolicyPage() {
  const sections = useClientState((s) => s.sections)
  const values = useMemo(() => savedValues(sections), [sections])
  const language = riskLanguageOf(values.get("HOME_LANGUAGE"))
  const policy = decodeRiskPolicy((key) => values.get(key))
  const words = riskPageTexts(language)
  return (
    <section className="flex flex-col gap-3" data-testid="risk-sentences" lang={language} aria-labelledby="risk-sentences-heading">
      <div className="flex flex-col gap-1">
        <h3 id="risk-sentences-heading" className="text-[15px] font-medium text-ink">{words.heading}</h3>
        <p className="text-[13px] text-ink-muted">{words.intro}</p>
      </div>
      <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
        {RISK_CLASSES.map((cls) => {
          const decision = decideRisk(policy, [cls], cls)
          const spoken = riskSpoken(language, decision)
          return (
            <li key={cls} className="flex flex-col gap-0.5 px-3 py-2" data-testid={`risk-row-${cls}`} data-outcome={decision.outcome}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-[14px] text-ink">{words.classes[cls]}</span>
                <span className="text-[13px] text-ink-muted" data-testid={`risk-outcome-${cls}`}>{words.outcomes[decision.outcome]}</span>
              </div>
              {spoken !== undefined && <p className="text-[13px] italic text-ink-muted" data-testid={`risk-spoken-${cls}`}>“{spoken}”</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
