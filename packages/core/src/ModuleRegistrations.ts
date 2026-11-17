import type { Scope } from "effect"
import type { SharedPart } from "./ModuleApi.ts"
import type { ModuleInstance } from "./ModuleDefinition.ts"

/**
 * What a started part of a module makes live, and when (docs/ARCHITECTURE.md "Module host: registrations").
 *
 * A module runs as **parts**: its shared part (one per generation) and its instances. The host starts a part, then
 * publishes it at the reconciler's switch, then retires it (withdrawn at a later switch, its scope closed after the
 * grace period). Everything a part offers to the rest of the process is a **registration** with that same lifetime:
 * live from the switch that publishes the part, never live for two generations of one module at once, withdrawn at the
 * switch that replaces or stops it, and never live at all for a part that is discarded (its start or a sibling's
 * failed). The host expresses its own offerings this way (services, contributions, tool names and the snapshot's
 * parts); a later PR adds a kind in one place:
 *
 * - **Declared by what a part returns** (P3's module routes on `SharedPart.routes`): add a `Registrar` to the host's
 *   `registrars` list in `ModuleHost.ts`. It is called once when the part has started and returns the part's
 *   registrations of that kind.
 * - **Made by module code while it runs** (P6's job handlers, P4's event subscriptions, later phrase commands and
 *   notification action handlers): the context member gets the part's `PartHandle` in `servicesFor` and calls
 *   `handle.register(...)`. During the part's start the registration is staged; on a live part it is checked and
 *   published at once; on a retired or discarded part it is refused.
 *
 * A registration that points at module code (a handler, a route) is reached only through the table its `publish`
 * fills, so a call that arrives after the switch reaches the new generation, never the withdrawn one.
 */

/** Where a part is in its life. Only a `live` part's registrations are published. */
export type PartState = "starting" | "candidate" | "live" | "retired" | "discarded"

/** One started part (a shared part or an instance), as context members and registrars see it. */
export interface PartHandle {
  readonly moduleId: string
  readonly moduleName: string
  readonly kind: "shared" | "instance"
  /** Unique for every start: two generations of one module never share it. */
  readonly id: number
  readonly state: () => PartState
  /** The part's scope: closed after the grace period once it is retired, at once when it is discarded. */
  readonly scope: Scope.Scope
  /**
   * Add a registration of this part: staged while the part starts (published at its switch, dropped if it is
   * discarded), checked and published at once while it is live, refused once it is retired or discarded.
   */
  readonly register: (registration: Registration) => RegisterResult
}

export type RegisterResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface Registration {
  /** The kind: "service", "contribution", "tool", "route", "job-handler", … */
  readonly kind: string
  /**
   * What it claims within its kind (a service id, a tool name, a route path): a claim another module's live
   * registration of the same kind holds refuses this part with `clash` (a module's own parts never clash).
   */
  readonly claims?: ReadonlyArray<string>
  /** The refusal for a claim already held by module `owner` (its name). */
  readonly clash?: (claim: string, owner: string) => string
  /** A check of its own before the switch: a reason refuses the part (its generation keeps the old one). */
  readonly validate?: () => string | undefined
  /** Inside the switch: synchronous; must not throw (a throw is logged and ignored). */
  readonly publish: () => void
  /** Inside the switch that retires the part: synchronous; must not throw. */
  readonly withdraw: () => void
}

/** A part that has started, with what it returned: its shared part's value, or its instance. */
export interface StartedPart {
  readonly handle: PartHandle
  readonly shared?: SharedPart<unknown>
  readonly instance?: ModuleInstance
}

/** A kind declared by what parts return: called once per started part. */
export type Registrar = (part: StartedPart) => ReadonlyArray<Registration>
