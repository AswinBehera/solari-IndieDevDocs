import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router"
import { Lab } from "./lab/Lab"
import { Onboarding } from "./onboarding/Onboarding"
import { Places } from "./places/Places"
import { Shell } from "./shell/Shell"
import { TripsHome } from "./trips/TripsHome"

/**
 * The routes, in code rather than file-based.
 *
 * TanStack Router is ADR-0002's choice, and it replaces the pathname switch
 * `main.tsx` held while there were two pages — that file said the travel UI would
 * "bring a real router with it", and this is it. Code-based rather than the
 * file-based generator, because a generator is a build step and a second copy of
 * the route tree on disk, and seven routes read fine as a list.
 */

const root = createRootRoute({ component: Shell })

const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: TripsHome }),
  createRoute({ getParentRoute: () => root, path: "/onboarding", component: Onboarding }),
  // Lazy: the editor and the map are most of the bundle, and the trips list, the
  // onboarding and the lab have no use for either.
  createRoute({
    getParentRoute: () => root,
    path: "/trips/$tripId",
    component: lazyRouteComponent(() => import("./trip/TripDocument"), "TripDocument"),
  }),
  createRoute({ getParentRoute: () => root, path: "/lab", component: Lab }),
  createRoute({ getParentRoute: () => root, path: "/lab/places", component: Places }),
]

export const router = createRouter({ routeTree: root.addChildren(routes) })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
