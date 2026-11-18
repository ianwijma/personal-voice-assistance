/**
 * `@pva/module-contracts`: the service and contribution keys modules share (docs/MODULES-PLAN.md §5.2), each with its
 * interface, and the two authoring helpers every module uses (spoken texts in two languages, stored text). Keys the
 * core provides (`People`, `Privacy`, `Devices`, later `SessionControl`, `DeviceControl`) are in `@pva/core`. The fakes
 * for consumers' tests are in `@pva/module-contracts/fakes`. docs/MODULES.md, "Services and contributions between
 * modules", says how to use them.
 */
export * from "./briefing.ts"
export * from "./calendar.ts"
export * from "./common.ts"
export * from "./homeAssistant.ts"
export * from "./lists.ts"
export * from "./mcp.ts"
export * from "./playback.ts"
export * from "./texts.ts"
export * from "./timers.ts"
