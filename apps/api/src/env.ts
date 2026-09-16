/**
 * The Worker's bindings and secrets (ADR-0014, ADR-0016).
 *
 * Every one of these is either a binding Cloudflare injects or a secret set with
 * `wrangler secret put`. None has a default, and none is read anywhere but here —
 * a missing one should fail at the edge of the system with its own name in the
 * message, not three layers down as `undefined`.
 */
export interface Env {
  /** Hyperdrive binding. `.connectionString` points at the pooled Postgres. */
  HYPERDRIVE: { connectionString: string }
  /** Supabase project URL, used to build the JWKS endpoint (ADR-0013). */
  SUPABASE_URL: string
  /**
   * Local development only: the owner id every request is treated as.
   *
   * Set in `.dev.vars`, which `wrangler dev` reads and `wrangler deploy` never
   * uploads. Present means "accept anything as this owner" (`devVerifier`);
   * absent means the real JWT path, which refuses everything without
   * `SUPABASE_URL`. Absence is the safe state, which is why it is the default.
   */
  DEV_OWNER_ID?: string
  /**
   * Fine-grained token, `actions:write` on this repository and nothing else
   * (ADR-0016). The repository is public: this must never be logged, and
   * `workflow_dispatch` must be the only thing it can do.
   */
  GITHUB_TOKEN?: string
  /** `owner/repo`. Separate from the token so a fork cannot dispatch into upstream. */
  GITHUB_REPOSITORY?: string
  /** The workflow file to dispatch, e.g. `worker.yml`. */
  GITHUB_WORKFLOW?: string
  GITHUB_REF?: string
}

export const required = <K extends keyof Env>(env: Env, key: K): NonNullable<Env[K]> => {
  const value = env[key]
  if (value === undefined || value === "") throw new Error(`${String(key)} is not set`)
  return value as NonNullable<Env[K]>
}
