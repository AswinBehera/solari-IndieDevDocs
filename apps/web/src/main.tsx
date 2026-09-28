import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { router } from "./router"

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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
