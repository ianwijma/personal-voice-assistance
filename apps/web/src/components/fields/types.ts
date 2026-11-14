import type { SecretState, SettingField, SettingValue } from "@pva/protocol"

export interface FieldProps<F extends SettingField = SettingField> {
  readonly field: F
  /** DOM id of the control (the label points at it). */
  readonly id: string
  readonly describedBy: string
  readonly value: SettingValue | undefined
  readonly onChange: (value: SettingValue) => void
  /** Secrets only. */
  readonly secret?: SecretState
  readonly secretDraft?: string | null
  readonly onSecretChange: (value: string | null | undefined) => void
  readonly disabled: boolean
  readonly invalid: boolean
  /** Report a value the field cannot accept yet (e.g. "12a" in a number input): blocks Save. */
  readonly onLocalError: (message: string | undefined) => void
}

export const inputClass =
  "h-10 w-full rounded-md border border-line bg-surface-2/60 px-3 text-base text-ink transition-colors sm:text-[14px] duration-[120ms] placeholder:text-ink-faint hover:border-ink-faint/60 focus-visible:border-you disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger/70"
