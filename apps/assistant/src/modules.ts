import type { AssistantModule } from "@pva/core"
import { clockModule, weatherModule } from "@pva/modules-builtin"

/** The enabled capabilities. Adding a feature = one line here. */
export const modules: ReadonlyArray<AssistantModule> = [
  clockModule(),
  weatherModule({
    defaultPlace: process.env.WEATHER_DEFAULT_PLACE,
    units: process.env.WEATHER_UNITS === "fahrenheit" ? "fahrenheit" : "celsius"
  })
]
