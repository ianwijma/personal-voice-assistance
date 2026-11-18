// Everything `clock.ts`, `weather.ts` and the demo home export, so the two module pull requests that extend the clock
// (core-tools) and the weather (local-info) add exports in their own file, or in new files they re-export from it,
// and never edit this one (docs/MODULES-PLAN.md §3.2; docs/MODULES.md, "What a module pull request may touch").
export * from "./clock.ts"
export * from "./demoHome.ts"
export * from "./weather.ts"
