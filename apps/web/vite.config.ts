import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Dev server for `apps/web` (ADR-0002: React + Vite, client-rendered, no SSR).
 *
 * The proxy is the load-bearing part. Without it the browser calls the API
 * cross-origin, which means CORS in development and no CORS in production — the
 * two environments would disagree about something the app cannot see, and the
 * disagreement would surface as a bug on the day of the first deploy. Same-origin
 * `/api/*` here matches same-origin `/api/*` behind Cloudflare.
 *
 * The API's port is 8789 rather than wrangler's default 8787, which collides with
 * tooling that is commonly already listening there. If the API is not running the request
 * fails and the UI says so — which is the correct thing for it to say.
 *
 * `127.0.0.1` rather than `localhost` on purpose: on macOS `localhost` resolves to
 * `::1` first, Vite itself listens on `::1`, and wrangler listens on IPv4. Naming
 * the family here turns a confusing intermittent proxy failure into a non-event.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
})
