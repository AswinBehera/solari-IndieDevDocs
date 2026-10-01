/**
 * One way to call the API, and one place the token comes from.
 *
 * Every path goes through the same-origin `/api` prefix that `vite.config.ts`
 * proxies, so development and production agree about the origin — a `fetch` here
 * that named `http://127.0.0.1:8788` directly would work on a laptop and break on
 * the first deploy, and nothing in the code would show why.
 *
 * **The token.** Every route except `/health` is authenticated (ADR-0013), and
 * there is no Supabase project yet, so the token here is whatever
 * `localStorage["dt.token"]` holds and `"dev"` when it holds nothing. That is only
 * usable against an API running with `DEV_OWNER_ID` set, which `wrangler deploy`
 * cannot upload — so this falls back to a string a deployed API answers 401 to,
 * rather than to a bypass. When real sign-in lands, this function is where the
 * session token replaces the literal, and no caller changes.
 */

const TOKEN_KEY = "dt.token"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed body, when there was one: a 409 carries the current version in it. */
    readonly body: unknown = null,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? "dev"}`,
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    // The API's own message when it sent one: its 400s are written for a reader
    // ("body is too large"), and replacing them with the status
    // code would throw away the only part of the response worth showing.
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `api returned ${res.status}`, body)
  }
  // A 204 has no body to parse; a DELETE answers with one.
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
