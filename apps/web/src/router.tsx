import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet } from "@tanstack/react-router"
import { DocsHome } from "./research/DocsHome"
import { Shell } from "./shell/Shell"

/** The routes, in code rather than file-based: two pages read fine as a list. */

const root = createRootRoute({ component: Outlet })
const app = createRoute({ getParentRoute: () => root, id: "app", component: Shell })

const routes = [
  createRoute({ getParentRoute: () => app, path: "/", component: DocsHome }),
  // Lazy: the editor is most of the bundle, and the list of documents has no use for it.
  createRoute({
    getParentRoute: () => app,
    path: "/docs/$docId",
    component: lazyRouteComponent(() => import("./research/ResearchDoc"), "ResearchDoc"),
  }),
]

export const router = createRouter({ routeTree: root.addChildren([app.addChildren(routes)]) })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
