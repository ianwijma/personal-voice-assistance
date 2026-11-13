import type { ComponentType } from "react"
import type { SettingField, SettingFieldType } from "@pva/protocol"
import { BooleanField } from "@/components/fields/BooleanField.tsx"
import { ChoiceField } from "@/components/fields/ChoiceField.tsx"
import { MultiChoiceField } from "@/components/fields/MultiChoiceField.tsx"
import { NumberField } from "@/components/fields/NumberField.tsx"
import { SecretField } from "@/components/fields/SecretField.tsx"
import { TextField } from "@/components/fields/TextField.tsx"
import type { FieldProps } from "@/components/fields/types.ts"

/**
 * One renderer per protocol field type. The mapped type makes a missing
 * renderer a compile error when the protocol gains a field type.
 */
export const fieldRenderers: { readonly [T in SettingFieldType]: ComponentType<FieldProps<Extract<SettingField, { type: T }>>> } = {
  text: TextField,
  secret: SecretField,
  number: NumberField,
  boolean: BooleanField,
  choice: ChoiceField,
  multichoice: MultiChoiceField
}
