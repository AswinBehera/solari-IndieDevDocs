import { type ReactNode, useId } from "react"

/**
 * The Lab's shared markup, and nothing that knows what a persona is.
 *
 * "Rough UI is fine" (P1.7), which is a licence to leave this plain — not a
 * licence to repeat a border radius forty times. These four are the pieces that
 * appear in every section, so they are written once, and the rest of the Lab is
 * allowed to be as blunt as a table.
 */

export function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4">
      <h2 className="font-medium text-sm">{title}</h2>
      {hint && <p className="mt-1 text-neutral-500 text-xs">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/**
 * A label and the control it names, associated by id.
 *
 * The id is generated here rather than asked of the caller, and handed to the
 * control through a render prop, because the alternative — a `<label>` wrapped
 * around `children` — is an association no static check can see. `useId` is also
 * the only correct source for one in a client-rendered tree: a counter would
 * collide between two forms on this page.
 */
export function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1 text-neutral-600 text-xs">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  )
}

export const inputClass =
  "rounded border border-neutral-300 px-2 py-1 text-neutral-900 text-sm focus:border-neutral-500 focus:outline-none"

export const buttonClass =
  "rounded bg-neutral-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-40"

/**
 * Errors are shown, never swallowed.
 *
 * The API's 400s carry the only sentence that explains a refusal — "a and b must
 * be different personas" is the tool telling the operator something true about
 * the comparison — and a UI that renders a red dot instead has thrown away the
 * finding along with the error.
 */
export function Note({ tone, children }: { tone: "error" | "ok" | "muted"; children: ReactNode }) {
  const colour =
    tone === "error" ? "text-red-600" : tone === "ok" ? "text-emerald-700" : "text-neutral-500"
  return <p className={`text-xs ${colour}`}>{children}</p>
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
