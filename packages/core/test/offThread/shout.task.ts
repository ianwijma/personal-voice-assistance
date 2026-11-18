// Returns its input transformed: a TypeScript task with a type, an interface and a workspace import.
import { normalizePhrase } from "@pva/core"

interface Words {
  readonly text: string
  readonly bytes: Uint8Array
}

export default (input: Words): { readonly loud: string; readonly folded: string; readonly sum: number } => ({
  loud: input.text.toUpperCase(),
  folded: normalizePhrase(input.text),
  sum: input.bytes.reduce((a, b) => a + b, 0)
})
