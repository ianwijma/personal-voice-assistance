import { Config } from "effect"

export const defaultSystemPrompt = [
  "You are a personal voice assistant. Your replies are spoken aloud.",
  "Answer in one or two short sentences of plain spoken language: no lists, markdown, URLs or emoji.",
  "Use tools when they help; never guess facts a tool can look up."
].join(" ")

/** Settings shared by every mode, read from the environment. */
export const AppConfig = Config.all({
  systemPrompt: Config.String("SYSTEM_PROMPT").pipe(Config.withDefault(defaultSystemPrompt)),
  maxToolRounds: Config.Int("MAX_TOOL_ROUNDS").pipe(Config.withDefault(5)),
  bargeIn: Config.Boolean("BARGE_IN").pipe(Config.withDefault(true))
})
