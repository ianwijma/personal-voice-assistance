import type { ComponentType } from "react"

/**
 * The marks of the providers in the pickers (voices, language models, recognisers) (its rail, its rows, the closed button). Simple letter marks
 * drawn for this UI, never a provider's own logo artwork. To use a real icon for a provider later, give its entry an
 * `icon` (a component drawing into a `size` × `size` box); the letters stay as its fallback. A provider the server
 * adds without an entry here gets the first two letters of its label.
 */
export interface ProviderMarkDef {
  readonly letters: string
  /** Token pair of the mark: `neutral` (ink on surface-2), `you` (mint), `voice` (an amber tile, ink letters). */
  readonly tone: "neutral" | "you" | "voice"
  readonly icon?: ComponentType<{ readonly size: number }>
}

export const voiceProviderMarks: Readonly<Record<string, ProviderMarkDef>> = {
  sherpa: { letters: "PC", tone: "neutral" },
  cartesia: { letters: "Ca", tone: "you" },
  elevenlabs: { letters: "EL", tone: "voice" },
  // Language model accounts and recognisers (docs/MODEL-PICKERS.md): letters too, never a provider's own logo.
  anthropic: { letters: "An", tone: "voice" },
  "claude-subscription": { letters: "Cl", tone: "voice" },
  openrouter: { letters: "OR", tone: "neutral" },
  "home-model": { letters: "Ho", tone: "you" },
  offline: { letters: "Of", tone: "neutral" },
  deepgram: { letters: "DG", tone: "you" }
}

export const providerMarkOf = (id: string, label?: string): ProviderMarkDef =>
  voiceProviderMarks[id] ?? { letters: (label ?? id).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?", tone: "neutral" }
