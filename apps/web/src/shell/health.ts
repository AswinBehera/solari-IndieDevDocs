import { useQuery } from "@tanstack/react-query"

interface Health {
  ok: boolean
  service: string
}

/**
 * `/health`, which answers without touching Postgres — so a failure here means the
 * API is down and never means the database is. Unauthenticated, so it goes around
 * `api()` rather than through it.
 */
export function useHealth() {
  return useQuery<Health>({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health")
      if (!res.ok) throw new Error(`api returned ${res.status}`)
      return (await res.json()) as Health
    },
    staleTime: 60_000,
  })
}
