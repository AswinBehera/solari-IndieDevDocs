import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./index.css"
import { Lab } from "./lab/Lab"

// TanStack Query is the only cache layer (ADR-0002): no second state library.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Nothing in this app is worth refetching because a window regained focus.
      // Every request costs a query against an account-wide Hyperdrive ceiling
      // (ADR-0016), and the defaults are tuned for apps that do not pay per read.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from index.html")

/**
 * A pathname switch, not a router.
 *
 * There are two pages: the P0.6 dev shell and the Persona Lab. A router is a
 * dependency, a bundle, and a set of conventions the next person has to learn, and
 * all three are bought with one decision — which of two components to render — that
 * a string comparison already makes. The travel UI in Phase 2 will have real
 * navigation and can bring a real router with it; until then this is the honest
 * shape of the problem.
 *
 * `startsWith` rather than `===` so that `/lab/` and a trailing path both land here
 * rather than falling through to the dev shell, which would look like the Lab is
 * missing.
 */
const page = window.location.pathname.startsWith("/lab") ? <Lab /> : <App />

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>{page}</QueryClientProvider>
  </StrictMode>,
)
