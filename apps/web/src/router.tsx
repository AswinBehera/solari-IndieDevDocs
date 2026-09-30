import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router"
import { Kernel } from "./kernel/Kernel"
import { Lab } from "./lab/Lab"
import { Onboarding } from "./onboarding/Onboarding"
import { Places } from "./places/Places"
import { Samsara } from "./samsara/Samsara"
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

// The root draws nothing of its own: the app's pages sit inside the shell, and
// the share page (P4.8) is read by someone with no account and no business
// seeing the app's navigation.
const root = createRootRoute({ component: Outlet })
const app = createRoute({ getParentRoute: () => root, id: "app", component: Shell })

const routes = [
  createRoute({ getParentRoute: () => app, path: "/", component: TripsHome }),
  createRoute({ getParentRoute: () => app, path: "/onboarding", component: Onboarding }),
  // Lazy: the editor and the map are most of the bundle, and the trips list, the
  // onboarding and the lab have no use for either.
  createRoute({
    getParentRoute: () => app,
    path: "/trips/$tripId",
    component: lazyRouteComponent(() => import("./trip/TripDocument"), "TripDocument"),
  }),
  createRoute({ getParentRoute: () => app, path: "/samsara", component: Samsara }),
  createRoute({ getParentRoute: () => app, path: "/lab", component: Lab }),
  createRoute({ getParentRoute: () => app, path: "/lab/places", component: Places }),
  createRoute({ getParentRoute: () => app, path: "/lab/kernel", component: Kernel }),
]

const share = createRoute({
  getParentRoute: () => root,
  path: "/s/$token",
  component: lazyRouteComponent(() => import("./share/SharePage"), "SharePage"),
})

export const router = createRouter({
  routeTree: root.addChildren([app.addChildren(routes), share]),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
