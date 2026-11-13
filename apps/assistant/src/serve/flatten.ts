/**
 * Settings files before version 2 kept assistant settings per section
 * (`sections: { listening: { STT_SHERPA_MODEL: … } }`), which tied storage to
 * the layout of the screen. Version 2 keeps them flat by key (the keys are
 * already globally unique environment-variable names). This flattens the old
 * shape, collision-safe: a key saved in two sections keeps the value of the
 * section that owned it in version 1 (else the later one), and the collision
 * is reported (key and sections only, never the values).
 */

/** Which version-1 section declared each key (`sections.ts` before the settings screen). */
const V1_OWNERS: Readonly<Record<string, string>> = {
  SYSTEM_PROMPT: "conversation",
  MAX_TOOL_ROUNDS: "conversation",
  DEFAULT_VOICE: "voices",
  VOICES: "voices",
  LLM_PROVIDER: "language-model",
  ANTHROPIC_MODEL: "language-model",
  ANTHROPIC_API_KEY: "language-model",
  STT_PROVIDER: "speech",
  DEEPGRAM_API_KEY: "speech",
  TTS_PROVIDER: "speech",
  CARTESIA_API_KEY: "speech"
}
const ownerOf = (key: string) => V1_OWNERS[key] ?? (key.startsWith("STT_SHERPA_") || key.startsWith("DEEPGRAM_") || key.startsWith("RECORD_HEARD_AUDIO") ? "listening" : undefined)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const flattenSections = <V>(
  sections: Readonly<Record<string, Readonly<Record<string, V>>>>,
  what: string
): { readonly flat: Readonly<Record<string, V>>; readonly problems: ReadonlyArray<string> } => {
  const flat: Record<string, V> = {}
  const from: Record<string, string> = {}
  const problems: Array<string> = []
  for (const [section, values] of Object.entries(sections)) {
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(flat, key)) {
        flat[key] = value
        from[key] = section
        continue
      }
      if (same(flat[key], value)) continue
      const owner = ownerOf(key)
      const keep = owner === from[key] ? from[key]! : section
      problems.push(
        `${what}: ${key} was saved in two sections (${from[key]}, ${section}) with different values; kept the one from ${keep}`
      )
      if (keep === section) {
        flat[key] = value
        from[key] = section
      }
    }
  }
  return { flat, problems }
}
