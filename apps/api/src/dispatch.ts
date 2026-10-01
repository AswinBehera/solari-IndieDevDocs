/**
 * `workflow_dispatch` (ADR-0016, decision 2).
 *
 * Foreground work is dispatched, not scheduled: a user who runs a block and
 * then watches a five-minute cron floor is watching a product that looks dead.
 *
 * Three properties of the GitHub endpoint shape this file, and all three are
 * awkward:
 *
 * - **It returns 204 with no run id.** The run has to be correlated afterwards by
 *   the job id passed as an input, which is why `jobId` is an input rather than
 *   being encoded in the ref or the workflow name.
 * - **It is rate limited**, and a dispatch that fails must not fail the enqueue.
 *   The row is already in Postgres; cron will pick it up late, which is worse than
 *   instant and much better than lost.
 * - **It is asynchronous.** Nothing here waits for the run to start.
 */

export interface Dispatcher {
  /** Resolves to whether the dispatch was accepted. Never throws for a rejection. */
  dispatch(jobId: string): Promise<boolean>
}

export interface GithubDispatchConfig {
  token: string
  /** `owner/repo`. */
  repository: string
  /** The workflow file name, e.g. `worker.yml`. */
  workflow: string
  ref: string
  fetch?: typeof fetch
}

export function githubDispatcher(cfg: GithubDispatchConfig): Dispatcher {
  const doFetch = cfg.fetch ?? fetch
  return {
    async dispatch(jobId) {
      const url = `https://api.github.com/repos/${cfg.repository}/actions/workflows/${cfg.workflow}/dispatches`
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            // GitHub rejects requests without one, and a descriptive agent is what
            // shows up in their abuse tooling if we ever get rate limited.
            "user-agent": "indiedevdocs-api",
          },
          // `inputs` values must be strings; GitHub rejects anything else with a
          // 422 that does not say which field.
          body: JSON.stringify({ ref: cfg.ref, inputs: { jobId } }),
        })
        return res.status === 204
      } catch {
        // Swallowed on purpose. See the header comment: the job row exists, so the
        // worst case of a failed dispatch is cron latency, and throwing here would
        // turn that into a failed request for work that is actually queued.
        return false
      }
    },
  }
}

/** For tests and for local dev, where there is no repository to dispatch into. */
export const noopDispatcher: Dispatcher = {
  async dispatch() {
    return false
  },
}
