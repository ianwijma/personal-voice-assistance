import type { Scope } from "effect"
import { type ModuleRoute, routeProblem } from "./ModuleRoutes.ts"

/**
 * Module HTTP routes' place in the host's lifecycle (docs/UI-AND-MODULES.md §1.11), and nothing else: a generation's
 * routes are checked before its switch (`validate`, may refuse the generation), become live inside the switch
 * (`publish`) and stop being live inside the switch that replaces or withdraws that generation (`withdraw`). `publish`
 * and `withdraw` are synchronous, so a route is only ever live for the published generation. The router, guards,
 * tokens and call log only read `published()`.
 *
 * The host calls it at exactly three points (ModuleHost.ts): `validate` in `startShared` (a candidate shared part),
 * `publish` / `withdraw` in `commit` (the switch), and `withdraw` where demand ends and the shared part is withdrawn
 * (`reconcile`).
 */

/** A route of a published shared part (`ModuleHost.routes`). */
export interface PublishedRoute {
  readonly moduleId: string
  readonly route: ModuleRoute
  /**
   * The scope of the shared part that declared it: it closes when that part is closed (after the grace period of a
   * restart or a stop). The app runs the route's handler in it (`Effect.forkIn`), so no handler outlives its part.
   */
  readonly scope: Scope.Scope
}

/** What a generation brings: its shared part's routes and the scope they run in. */
export interface RouteOwner {
  readonly scope: Scope.Scope
  readonly part: { readonly routes?: ReadonlyArray<ModuleRoute> | undefined }
}

export interface RouteRegistration {
  /** Why this generation's routes cannot be published (a start error), or `undefined`. */
  readonly validate: (owner: RouteOwner) => string | undefined
  /** Make `owner`'s routes the module's live ones (synchronous; replaces whatever was live for it). */
  readonly publish: (moduleId: string, owner: RouteOwner) => void
  /** Take the module's routes down, if they are `owner`'s (synchronous; another generation's are left alone). */
  readonly withdraw: (moduleId: string, owner: RouteOwner) => void
  /** Every live route, catalogue order of first publication. */
  readonly published: () => ReadonlyArray<PublishedRoute>
  /** One module's live routes. */
  readonly of: (moduleId: string) => ReadonlyArray<ModuleRoute>
}

export const makeRouteRegistration = (): RouteRegistration => {
  const live = new Map<string, { readonly owner: RouteOwner; readonly routes: ReadonlyArray<PublishedRoute> }>()
  return {
    validate: (owner) => routeProblem(owner.part.routes),
    publish: (moduleId, owner) => {
      const routes = (owner.part.routes ?? []).map((route) => ({ moduleId, route, scope: owner.scope }))
      if (routes.length === 0) live.delete(moduleId)
      else live.set(moduleId, { owner, routes })
    },
    withdraw: (moduleId, owner) => {
      if (live.get(moduleId)?.owner === owner) live.delete(moduleId)
    },
    published: () => [...live.values()].flatMap((l) => l.routes),
    of: (moduleId) => (live.get(moduleId)?.routes ?? []).map((r) => r.route)
  }
}
