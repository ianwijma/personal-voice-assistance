/**
 * Routing a sentence without a wake phrase to one of a device's assistants (docs/ASSISTANTS.md §3.6, WP-14).
 *
 * One System One request per decision, sent with `makeJevClient` (no retries; the device's give-up time is the
 * call's time limit): a Choice over the device's switched-on assistants, each described by its "Handles" text (or its
 * name and purpose when that is empty), plus a companion Noul "does any fit". With one candidate only the Noul is
 * asked. Nothing else is sent: only the sentence and those lines.
 *
 * The shapes are TypeSafe's documented ones (docs/research/typesafe-jev.md §2.2, §2.3); no authenticated request has
 * been made from this project, so they are unverified against the real service.
 */
import type { DecisionRequest, DecisionResponse } from "@pva/core"

/** The assistant is chosen when the Noul says it fits at least this much (§3.6; to be tuned from the traces). */
export const ROUTE_FITS_MIN = 0.5
/** … and the chosen option's own probability is at least this. */
export const ROUTE_CHOICE_MIN = 0.5

/** The question names of the routing request (the model never sees them). */
export const ROUTE_CHOICE_QUESTION = "assistant"
export const ROUTE_FITS_QUESTION = "fits"

/** One assistant TypeSafe may choose (in the device's list order: option order biases the choice). */
export interface RouteCandidate {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly handles: string
}

/** What is sent for one candidate: its Handles, or `name: purpose` (or the name alone) when Handles is empty. */
export const describeCandidate = (c: RouteCandidate): string => {
  const handles = c.handles.trim()
  if (handles !== "") return handles
  const name = c.name.trim() || c.id
  const purpose = c.purpose.trim()
  return purpose === "" ? name : `${name}: ${purpose}`
}

/** The routing request of §3.6 for `utterance` over `candidates` (at least one). */
export const routingRequest = (utterance: string, candidates: ReadonlyArray<RouteCandidate>): DecisionRequest => {
  const options: Record<string, string> = {}
  for (const c of candidates) options[c.id] = describeCandidate(c)
  const fits = {
    type: "noul",
    instructions: "Is the sentence meant for one of the available assistants?",
    role: { kind: "fits" }
  } as const
  return {
    state: { utterance, available_actions: options },
    questions: candidates.length > 1
      ? {
        [ROUTE_CHOICE_QUESTION]: {
          type: "choice",
          instructions: "Which assistant is this sentence meant for?",
          options,
          role: { kind: "action" }
        },
        [ROUTE_FITS_QUESTION]: fits
      }
      : { [ROUTE_FITS_QUESTION]: fits }
  }
}

/** What an answer means for routing. `probability`: the chosen (or best) option's; absent with one candidate. */
export type RouteReading =
  | { readonly outcome: "chosen"; readonly assistant: string; readonly probability?: number; readonly fits: number }
  | { readonly outcome: "none-fits"; readonly best?: string; readonly probability?: number; readonly fits: number }

/**
 * §3.6 "Decision": chosen when `fits ≥ ROUTE_FITS_MIN` and the chosen option's probability `≥ ROUTE_CHOICE_MIN`;
 * with one candidate the Noul alone decides. A missing answer counts as probability 0; a choice that is not one of
 * the candidates counts as none fits.
 */
export const readRouting = (response: DecisionResponse, candidates: ReadonlyArray<RouteCandidate>): RouteReading => {
  const fitsAnswer = response.answers[ROUTE_FITS_QUESTION]
  const fits = fitsAnswer?.type === "noul" ? fitsAnswer.value : 0
  if (candidates.length === 1) {
    const only = candidates[0]!.id
    return fits >= ROUTE_FITS_MIN ? { outcome: "chosen", assistant: only, fits } : { outcome: "none-fits", best: only, fits }
  }
  const choice = response.answers[ROUTE_CHOICE_QUESTION]
  if (choice?.type !== "choice" || !candidates.some((c) => c.id === choice.choice)) return { outcome: "none-fits", fits }
  const probability = choice.probabilities[choice.choice] ?? 0
  return fits >= ROUTE_FITS_MIN && probability >= ROUTE_CHOICE_MIN
    ? { outcome: "chosen", assistant: choice.choice, probability, fits }
    : { outcome: "none-fits", best: choice.choice, probability, fits }
}
