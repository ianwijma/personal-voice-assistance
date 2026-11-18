import type { HostView } from "@pva/core"
import type { Connector, Resolver } from "@pva/net"
import { userAgent } from "@pva/net"

/** What a module that fetches takes from its tests: the resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** The User-Agent: the product token, and the owner's contact only when the owner set one (Home › API contact). */
export const agentOf = (view: Pick<HostView, "home">): string => {
  const contact = view.home.HOME_API_CONTACT
  return userAgent(typeof contact === "string" && contact.trim() !== "" ? contact : undefined)
}
