import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api } from "../api"
import { labKeys, usePersonas } from "./queries"
import type { Persona, PersonaTier } from "./types"
import { buttonClass, errorText, Field, inputClass, Note, Section } from "./ui"

/**
 * The identities, and the form that mints one.
 *
 * **Health is shown, never filtered.** A `banned` row is the most informative row
 * in the table — it is a source having told us what it thinks of an identity —
 * and a list that quietly dropped it would hide the outcome the Lab exists to
 * make visible. Same reason the route does not filter by health either.
 *
 * The form asks for six fields and no more, because those six are all a new
 * identity actually has. Everything else on the record — profile, sticky address,
 * counters, health — is set by the API to the value of something that has never
 * run, and a form offering to set them would be offering to write a history that
 * did not happen.
 */

/** The create body, exactly — six fields, and the API fills in the rest. */
interface NewPersona {
  name: string
  locality: string
  country: string
  locale: string
  timezoneId: string
  tier: PersonaTier
}

const BLANK: NewPersona = {
  name: "",
  locality: "",
  country: "th",
  locale: "th-TH",
  timezoneId: "Asia/Bangkok",
  tier: "anon",
}

export function Personas() {
  const personas = usePersonas()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<NewPersona>(BLANK)

  const create = useMutation({
    mutationFn: (body: NewPersona) =>
      api<{ persona: Persona }>("/lab/personas", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setForm(BLANK)
      await queryClient.invalidateQueries({ queryKey: labKeys.personas })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate(form)
  }

  const set = (key: keyof NewPersona) => (value: string) => setForm((f) => ({ ...f, [key]: value }))

  return (
    <Section
      title="Personas"
      hint="One identity: a locality, a country, a locale, a timezone. A harvest is always run as one of these."
    >
      {personas.isPending && <Note tone="muted">loading…</Note>}
      {personas.isError && <Note tone="error">{errorText(personas.error)}</Note>}
      {personas.data && personas.data.length === 0 && (
        <Note tone="muted">No personas yet. The form below creates the first one.</Note>
      )}
      {personas.data && personas.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500 text-xs">
              <tr>
                <th className="py-1 pr-3 font-normal">name</th>
                <th className="py-1 pr-3 font-normal">locality</th>
                <th className="py-1 pr-3 font-normal">country</th>
                <th className="py-1 pr-3 font-normal">locale</th>
                <th className="py-1 pr-3 font-normal">tier</th>
                <th className="py-1 pr-3 font-normal">health</th>
                <th className="py-1 pr-3 font-normal">sessions</th>
                <th className="py-1 font-normal">id</th>
              </tr>
            </thead>
            <tbody>
              {personas.data.map((p) => (
                <tr key={p.id} className="border-neutral-100 border-t">
                  <td className="py-1 pr-3">{p.name}</td>
                  <td className="py-1 pr-3">{p.locality}</td>
                  <td className="py-1 pr-3">{p.country}</td>
                  <td className="py-1 pr-3">{p.locale}</td>
                  <td className="py-1 pr-3">{p.tier}</td>
                  <td className="py-1 pr-3">
                    <Health health={p.health} />
                  </td>
                  <td className="py-1 pr-3 tabular-nums">
                    {p.stats.sessions}
                    {p.stats.blocks > 0 && (
                      <span className="text-red-600"> · {p.stats.blocks} blocked</span>
                    )}
                  </td>
                  <td className="py-1 font-mono text-neutral-400 text-xs">{p.id.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        onSubmit={submit}
        className="mt-4 flex flex-wrap items-end gap-3 border-neutral-100 border-t pt-4"
      >
        <Field label="name">
          {(id) => (
            <input
              id={id}
              className={inputClass}
              required
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
              placeholder="Ari local"
            />
          )}
        </Field>
        <Field label="locality">
          {(id) => (
            <input
              id={id}
              className={inputClass}
              required
              value={form.locality}
              onChange={(e) => set("locality")(e.target.value)}
              placeholder="Ari, Bangkok"
            />
          )}
        </Field>
        {/* Lowercase ISO 3166-1 alpha-2, which the API enforces. The input does not
            uppercase it for display: the value that gets sent is the value shown. */}
        <Field label="country">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-16`}
              required
              value={form.country}
              onChange={(e) => set("country")(e.target.value.toLowerCase())}
            />
          )}
        </Field>
        <Field label="locale">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-24`}
              required
              value={form.locale}
              onChange={(e) => set("locale")(e.target.value)}
            />
          )}
        </Field>
        <Field label="timezone">
          {(id) => (
            <input
              id={id}
              className={inputClass}
              required
              value={form.timezoneId}
              onChange={(e) => set("timezoneId")(e.target.value)}
            />
          )}
        </Field>
        <Field label="tier">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={form.tier}
              onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value as PersonaTier }))}
            >
              <option value="anon">anon</option>
              <option value="seeded">seeded</option>
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass} disabled={create.isPending}>
          {create.isPending ? "creating…" : "Create persona"}
        </button>
        {create.isError && <Note tone="error">{errorText(create.error)}</Note>}
      </form>
    </Section>
  )
}

function Health({ health }: { health: Persona["health"] }) {
  const colour =
    health === "healthy"
      ? "text-emerald-700"
      : health === "degraded"
        ? "text-amber-700"
        : "text-red-600"
  return <span className={colour}>{health}</span>
}
