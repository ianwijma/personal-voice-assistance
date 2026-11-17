import type { Scope } from "effect"
import type { SharedPart } from "./ModuleApi.ts"
import type { ModuleInstance } from "./ModuleDefinition.ts"

/**
 * What a started module makes live, and when (docs/ARCHITECTURE.md "Module host: registrations").
 *
 * A module runs as **parts**: its shared part and its instances. The host's worker starts them one module at a time
 * and publishes all of a module's parts together, in one synchronous step, only once every part has started; when the
 * module stops it withdraws all of them in one synchronous step before closing anything. Everything a part offers to
 * the rest of the process is a **registration** with exactly that lifetime: the host's own services, contributions
 * and tool names, and the kinds later PRs add. Only the worker publishes or withdraws; nothing else does.
 *
 * - **Declared by what a part returns** (P3's module routes on `SharedPart.routes`): add a `Registrar` to the host's
 *   `registrars` list in `ModuleHost.ts`. It is called once for each part that started and returns the part's
 *   registrations of that kind.
 * - **Made by module code while it starts** (P6's job handlers, P4's event subscriptions, later phrase commands and
 *   notification action handlers): the context member gets the part's `PartHandle` in `servicesFor` and calls
 *   `handle.register(...)` during `shared` or `start`. The registration is published with the module; a call after the
 *   part has started is refused (there is no registration outside the worker).
 *
 * A registration that points at module code (a handler, a route) is reached only through the table its `publish`
 * fills, so once a module is withdrawn its code is in no table.
 */

/** Where a part is in its life. Only a `live` part's registrations are published. */
export type PartState = "starting" | "live" | "withdrawn" | "closed" | "abandoned"

/** One started part (a shared part or an instance), as context members and registrars see it. */
export interface PartHandle {
  readonly moduleId: string
  readonly moduleName: string
  readonly kind: "shared" | "instance"
  /** Unique for every start: two starts of one module never share it. */
  readonly id: number
  readonly state: () => PartState
  /** The part's scope: closed when the module stops (or its start fails), after its registrations are withdrawn. */
  readonly scope: Scope.Scope
  /**
   * Add a registration of this part, during its start (`shared` or `start`): published with the module, or dropped if
   * the module does not start. Refused once the part has started.
   */
  readonly register: (registration: Registration) => RegisterResult
}

export type RegisterResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface Registration {
  /** The kind: "service", "contribution", "tool", "route", "job-handler", … */
  readonly kind: string
  /**
   * What it claims within its kind (a service id, a tool name, a route path): a claim another module's published
   * registration of the same kind holds refuses this module's start with `clash`.
   */
  readonly claims?: ReadonlyArray<string>
  /** The refusal for a claim already held by module `owner` (its name). */
  readonly clash?: (claim: string, owner: string) => string
  /** A check of its own before anything of the module is published: a reason refuses the start. */
  readonly validate?: () => string | undefined
  /**
   * Make it live: synchronous, and must not throw. A throw is a defect of that kind: the worker withdraws what it
   * published of the module in this step, and the module is down with the reason on the Health page.
   */
  readonly publish: () => void
  /** Take it out again (the module stops): synchronous, and must not throw (a throw is reported, the stop goes on). */
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
