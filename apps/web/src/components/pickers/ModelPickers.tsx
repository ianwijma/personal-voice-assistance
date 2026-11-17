"use client"
import type { ModelApply } from "@pva/protocol"
import { llmValue, sttValue } from "@/lib/catalogPicker.ts"
import { CatalogPicker } from "./CatalogPicker.tsx"
import { useModelSource } from "./modelSources.ts"

/**
 * The language model picker and the recogniser picker (docs/MODEL-PICKERS.md): `CatalogPicker` over the model
 * catalogs. The page holds the value (the assistant's `llm.account` + `llm.model`, or `hearing.engine` +
 * `hearing.model`); choosing a row hands back what it applies.
 */

export function LlmModelPicker({ account, model, onApply, id, describedBy, disabled }: {
  readonly account: string
  readonly model: string
  readonly onApply: (apply: Extract<ModelApply, { llm: unknown }>["llm"]) => void
  readonly id?: string
  readonly describedBy?: string
  readonly disabled?: boolean
}) {
  const source = useModelSource("llm")
  return (
    <CatalogPicker
      source={source}
      value={llmValue(account, model)}
      onChange={(_, choice) => {
        if ("apply" in choice && "llm" in choice.apply) onApply(choice.apply.llm)
      }}
      label="Choose a language model"
      {...(id !== undefined ? { id } : {})}
      {...(describedBy !== undefined ? { describedBy } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
    />
  )
}

export function SttModelPicker({ engine, model, onApply, id, describedBy, disabled }: {
  readonly engine: string
  readonly model: string
  readonly onApply: (apply: Extract<ModelApply, { hearing: unknown }>["hearing"]) => void
  readonly id?: string
  readonly describedBy?: string
  readonly disabled?: boolean
}) {
  const source = useModelSource("stt")
  const lists = source.useState().lists
  return (
    <CatalogPicker
      source={source}
      value={sttValue(engine, model, lists)}
      onChange={(_, choice) => {
        if ("apply" in choice && "hearing" in choice.apply) onApply(choice.apply.hearing)
      }}
      label="Choose a speech recognition model"
      {...(engine === "deepgram" ? { fallbackName: "Deepgram" } : {})}
      {...(id !== undefined ? { id } : {})}
      {...(describedBy !== undefined ? { describedBy } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
    />
  )
}
