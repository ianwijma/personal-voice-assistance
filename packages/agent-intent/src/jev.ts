import { defineAgent, defaultIntentThresholds, makeIntentAgent, Setting } from "@pva/core"
import { Effect } from "effect"

const threshold = (label: string, value: number, description: string) =>
  Setting.number({ label, description, default: value, min: 0, max: 1, step: 0.05, advanced: true })

/**
 * Jev, the typed-intent agent (docs/AGENTS-AND-INTENTS.md §3.6): recognises
 * which action of the running modules a sentence asks for and runs it, with a
 * short spoken confirmation and no conversational model. Its decision
 * provider is TypeSafe's Jev when that module runs (a key is set), otherwise
 * the offline keyword decider. Sentences it cannot place go to the
 * conversational agent.
 */
export const jevAgent = defineAgent({
  id: "jev",
  name: "Jev",
  kind: "intent",
  description: "Runs commands for your modules (lights, time, weather) without a conversational model. Say \"hey Jev, …\".",
  enabledByDefault: true,
  settings: {
    decider: Setting.choice({
      label: "Decision provider",
      description: "TypeSafe Jev needs its API key (Agents → Decision providers); without it the offline keywords are used.",
      env: "JEV_DECIDER",
      default: "jev-typesafe",
      options: [
        { value: "jev-typesafe", label: "TypeSafe Jev (offline keywords when not available)" },
        { value: "keywords", label: "Offline keywords only" }
      ]
    }),
    onNoMatch: Setting.choice({
      label: "When no command fits",
      default: "fallback",
      options: [
        { value: "fallback", label: "Let the conversational agent answer" },
        { value: "say", label: "Say \"I can't do that.\"" }
      ]
    }),
    speakBeforeDone: Setting.boolean({
      label: "Confirm while the action runs",
      description: "Say \"Living room lights on.\" at once instead of after the action finished (a failure is said afterwards).",
      default: true
    }),
    timeoutMs: Setting.number({
      label: "Decision timeout",
      description: "Longest a decision may take before the conversational agent answers instead.",
      default: 1_200,
      integer: true,
      min: 200,
      max: 5_000,
      step: 100,
      unit: "ms",
      advanced: true
    }),
    pendingSeconds: Setting.number({
      label: "Wait for an answer",
      description: "How long a question (\"Which room?\") waits for its answer.",
      default: 15,
      integer: true,
      min: 5,
      max: 60,
      unit: "s",
      advanced: true
    }),
    fitsAccept: threshold("Accept a command at", defaultIntentThresholds.fitsAccept, "\"Does any command fit?\" at or above this: act."),
    fitsReject: threshold("Not a command below", defaultIntentThresholds.fitsReject, "Below this the sentence is not a command."),
    actionThreshold: threshold("Command certainty", defaultIntentThresholds.action, "Probability of the chosen command needed to act."),
    paramThreshold: threshold("Detail certainty", defaultIntentThresholds.param, "Probability of a chosen detail (room, place) needed; below it Jev asks."),
    compoundThreshold: threshold("Several commands at", defaultIntentThresholds.compound, "At or above this the sentence holds several commands and goes to the conversational agent.")
  },
  start: ({ setStatus, settings }) =>
    Effect.sync(() => {
      const preferred = settings.decider
      const { pending: _pending, ...agent } = makeIntentAgent({
        deciders: preferred === "keywords" ? ["keywords"] : ["jev-typesafe", "keywords"],
        thresholds: {
          ...defaultIntentThresholds,
          fitsAccept: settings.fitsAccept,
          fitsReject: settings.fitsReject,
          action: settings.actionThreshold,
          param: settings.paramThreshold,
          compound: settings.compoundThreshold
        },
        onNoMatch: settings.onNoMatch,
        speakBeforeDone: settings.speakBeforeDone,
        timeoutMs: settings.timeoutMs,
        pendingMs: settings.pendingSeconds * 1_000,
        onDeciderChange: (provider) =>
          setStatus(
            provider === undefined
              ? { text: "No decision provider running: commands go to the conversational agent", tone: "warning" }
              : provider.id === "keywords" && preferred !== "keywords"
              ? { text: "TypeSafe key not set: using offline keyword matching", tone: "warning" }
              : { text: `Deciding with ${provider.name}`, tone: "ok" }
          )
      })
      setStatus({ text: preferred === "keywords" ? "Deciding with offline keywords" : "Deciding with TypeSafe Jev when available", tone: "neutral" })
      return agent
    })
})
