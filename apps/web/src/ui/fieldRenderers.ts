import type { ComponentType } from "react"
import type { SettingField, SettingFieldType } from "@pva/protocol"
import { ActionField } from "@/components/fields/ActionField.tsx"
import { BooleanField } from "@/components/fields/BooleanField.tsx"
import { ComboField } from "@/components/fields/ComboField.tsx"
import { InfoField } from "@/components/fields/InfoField.tsx"
import { RecordsField } from "@/components/fields/RecordsField.tsx"
import { TextListField } from "@/components/fields/TextListField.tsx"
import { ChoiceField } from "@/components/fields/ChoiceField.tsx"
import { MultiChoiceField } from "@/components/fields/MultiChoiceField.tsx"
import { NumberField } from "@/components/fields/NumberField.tsx"
import { SecretField } from "@/components/fields/SecretField.tsx"
import { TextField } from "@/components/fields/TextField.tsx"
import type { FieldProps } from "@/components/fields/types.ts"
import { AssistantVoiceField } from "@/components/voices/AssistantVoiceField.tsx"

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
  multichoice: MultiChoiceField,
  // Protocol 10 (docs/SETTINGS-UI.md §3.2): the extended field types.
  textList: TextListField,
  records: RecordsField,
  combo: ComboField,
  action: ActionField,
  info: InfoField
}

/**
 * Renderers for one setting by its key, in place of its type's: a field whose value has a richer editor than its
 * protocol type (a voice key is a text field to the server, a voice picker here). Locked values, labels, markers and
 * Save stay generic (`FieldRow`). The renderer must accept the field's type.
 */
export const fieldRenderersByKey: Readonly<Record<string, { readonly type: SettingFieldType; readonly component: ComponentType<FieldProps<never>> }>> = {
  ASSISTANT_VOICE: { type: "text", component: AssistantVoiceField as ComponentType<FieldProps<never>> }
}

/** The renderer of a field: by its key when one is registered for its type, else by its type. */
export const rendererFor = (field: SettingField): ComponentType<FieldProps> => {
  const byKey = fieldRenderersByKey[field.key]
  return (byKey !== undefined && byKey.type === field.type ? byKey.component : fieldRenderers[field.type]) as ComponentType<FieldProps>
}
