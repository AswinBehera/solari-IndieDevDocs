import {
  CHARACTER_COLOURS,
  CHARACTER_PROPS,
  CHARACTER_SOURCES,
  type CharacterPreset,
} from "@dt/travel-pack/characters"
import { askAs, INTEREST_GROUPS } from "@dt/travel-pack/interests"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api } from "../api"
import { labKeys } from "../lab/queries"
import type { Persona, PersonaTraits } from "../lab/types"
import { errorText } from "../lab/ui"
import { Figure } from "./Figure"

/**
 * The character builder: who they are, where they browse from, what they care
 * about and where they read.
 *
 * **Where a character lives is fixed once they have browsed.** The API refuses to
 * move a persona with sessions behind it (a run from Sydney filed under a Bangkok
 * identity would make the comparison a lie), so the builder locks those fields
 * and says why rather than letting a save fail.
 *
 * **The preview is the real query.** It comes from the same `askAs` the worker
 * calls, so what is shown under the tags is what will be typed into YouTube.
 */

export interface Draft {
  name: string
  title: string
  bio: string
  locality: string
  country: string
  locale: string
  timezoneId: string
  interests: string[]
  sources: string[]
  colour: string
  prop: string
}

export const draftFromPreset = (p: CharacterPreset): Draft => ({
  name: p.name,
  title: p.title,
  bio: p.bio,
  locality: p.locality,
  country: p.country,
  locale: p.locale,
  timezoneId: p.timezoneId,
  interests: [...p.interests],
  sources: [...p.sources],
  colour: p.colour,
  prop: p.prop,
})

export const draftFromPersona = (p: Persona): Draft => ({
  name: p.name,
  title: p.traits?.archetype ?? "",
  bio: p.traits?.bio ?? "",
  locality: p.locality,
  country: p.country,
  locale: p.locale,
  timezoneId: p.timezoneId,
  interests: p.traits?.interests ?? [],
  sources: p.traits?.sources ?? ["youtube.search"],
  colour: p.traits?.look?.colour ?? "#d9d4c7",
  prop: p.traits?.look?.prop ?? "map",
})

/** Languages a character can search in, and the clock that goes with each. */
const LANGUAGES = [
  { locale: "th-TH", label: "Thai", timezoneId: "Asia/Bangkok" },
  { locale: "en-AU", label: "English (Australia)", timezoneId: "Australia/Sydney" },
  { locale: "en-US", label: "English (US)", timezoneId: "America/New_York" },
  { locale: "en-GB", label: "English (UK)", timezoneId: "Europe/London" },
  { locale: "ja-JP", label: "Japanese", timezoneId: "Asia/Tokyo" },
] as const

const EGRESS = [
  { country: "sg", label: "Singapore" },
  { country: "au", label: "Australia" },
  { country: "us", label: "United States" },
  { country: "gb", label: "United Kingdom" },
  { country: "jp", label: "Japan" },
] as const

const TIMEZONES = [...new Set(LANGUAGES.map((l) => l.timezoneId))]

const MAX_INTERESTS = 24

function traitsOf(d: Draft): PersonaTraits {
  return {
    ...(d.title.trim() ? { archetype: d.title.trim().slice(0, 40) } : {}),
    ...(d.bio.trim() ? { bio: d.bio.trim().slice(0, 280) } : {}),
    interests: d.interests,
    sources: d.sources,
    look: { colour: d.colour, prop: d.prop },
  }
}

export function Builder({
  initial,
  persona,
  onCreated,
}: {
  initial: Draft
  persona: Persona | null
  onCreated: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(initial)
  const [custom, setCustom] = useState("")
  const locked = persona !== null && persona.stats.sessions > 0
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)

  const save = useMutation({
    mutationFn: async () => {
      const where = {
        locality: draft.locality.trim(),
        country: draft.country,
        locale: draft.locale,
        timezoneId: draft.timezoneId,
      }
      if (!persona) {
        return api<{ persona: Persona }>("/lab/personas", {
          method: "POST",
          body: JSON.stringify({ name: draft.name.trim(), ...where, traits: traitsOf(draft) }),
        })
      }
      return api<{ persona: Persona }>(`/lab/personas/${encodeURIComponent(persona.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name.trim(),
          ...(locked ? {} : where),
          traits: traitsOf(draft),
        }),
      })
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: labKeys.personas })
      if (!persona) onCreated(res.persona.id)
    },
  })

  const toggle = (list: "interests" | "sources", id: string) =>
    setDraft((d) => {
      const has = d[list].includes(id)
      if (!has && list === "interests" && d.interests.length >= MAX_INTERESTS) return d
      return { ...d, [list]: has ? d[list].filter((x) => x !== id) : [...d[list], id] }
    })

  const addCustom = () => {
    const tag = custom.trim().toLowerCase().slice(0, 60)
    if (tag && !draft.interests.includes(tag)) toggle("interests", tag)
    setCustom("")
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  const known = new Set(INTEREST_GROUPS.flatMap((g) => g.tags.map((t) => t.id)))
  const customTags = draft.interests.filter((i) => !known.has(i))

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
      <div className="flex items-start gap-4">
        <span
          className="flex size-24 flex-none items-end justify-center overflow-hidden rounded-xl"
          style={{ background: draft.colour }}
        >
          <Figure prop={draft.prop} size={92} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input
            aria-label="Name"
            className="w-full border-rule border-b bg-transparent font-display text-3xl focus:border-ink focus:outline-none"
            placeholder="Name"
            required
            maxLength={80}
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
          />
          <input
            aria-label="Who they are"
            className="w-full border-rule border-b bg-transparent text-ink-muted text-sm focus:border-ink focus:outline-none"
            placeholder="Who they are, in a few words"
            maxLength={40}
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </div>
      </div>

      <label className="flex flex-col gap-1 text-ink-muted text-xs">
        Their story
        <textarea
          className="min-h-16 rounded-lg border border-rule bg-surface px-3 py-2 text-ink text-sm focus:border-ink focus:outline-none"
          maxLength={280}
          value={draft.bio}
          onChange={(e) => set("bio", e.target.value)}
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-mono text-[10px] text-ink-faint tracking-[.1em]">LOOK</legend>
        <div className="flex flex-wrap items-center gap-2">
          {CHARACTER_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              aria-pressed={draft.colour === c}
              onClick={() => set("colour", c)}
              className={`size-7 rounded-full ${draft.colour === c ? "ring-2 ring-ink ring-offset-2" : ""}`}
              style={{ background: c }}
            />
          ))}
          <span className="mx-1 h-6 w-px bg-rule" aria-hidden />
          {CHARACTER_PROPS.map((p) => (
            <button
              key={p}
              type="button"
              title={p}
              aria-label={`Carries a ${p}`}
              aria-pressed={draft.prop === p}
              onClick={() => set("prop", p)}
              className={`rounded-lg border ${draft.prop === p ? "border-ink bg-surface" : "border-transparent"}`}
            >
              <Figure prop={p} size={36} />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-mono text-[10px] text-ink-faint tracking-[.1em]">
          WHERE THEY BROWSE FROM
        </legend>
        {locked && (
          <p className="rounded-lg bg-note px-3 py-2 text-ink-muted text-xs">
            {draft.name || "This character"} has already browsed {persona?.stats.sessions} time
            {persona?.stats.sessions === 1 ? "" : "s"}, so where they live is fixed. Moving them
            would mix two identities' results. Hire a new character to browse from somewhere else.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-ink-muted text-xs">
            Neighbourhood
            <input
              className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-ink text-sm disabled:opacity-60"
              required
              disabled={locked}
              value={draft.locality}
              onChange={(e) => set("locality", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-ink-muted text-xs">
            Searches in
            <select
              className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-ink text-sm disabled:opacity-60"
              disabled={locked}
              value={draft.locale}
              onChange={(e) => {
                const lang = LANGUAGES.find((l) => l.locale === e.target.value)
                setDraft((d) => ({
                  ...d,
                  locale: e.target.value,
                  ...(lang ? { timezoneId: lang.timezoneId } : {}),
                }))
              }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.label}
                </option>
              ))}
              {!LANGUAGES.some((l) => l.locale === draft.locale) && (
                <option value={draft.locale}>{draft.locale}</option>
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-ink-muted text-xs">
            Clock
            <select
              className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-ink text-sm disabled:opacity-60"
              disabled={locked}
              value={draft.timezoneId}
              onChange={(e) => set("timezoneId", e.target.value)}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace("_", " ")}
                </option>
              ))}
              {!TIMEZONES.includes(draft.timezoneId as (typeof TIMEZONES)[number]) && (
                <option value={draft.timezoneId}>{draft.timezoneId}</option>
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-ink-muted text-xs">
            Internet exit
            <select
              className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-ink text-sm disabled:opacity-60"
              disabled={locked}
              value={draft.country}
              onChange={(e) => set("country", e.target.value)}
            >
              {EGRESS.map((c) => (
                <option key={c.country} value={c.country}>
                  {c.label}
                </option>
              ))}
              {!EGRESS.some((c) => c.country === draft.country) && (
                <option value={draft.country}>{draft.country.toUpperCase()}</option>
              )}
            </select>
          </label>
        </div>
        <p className="text-ink-faint text-xs">
          There is no Thai exit on our browser provider, so Thai characters connect from Singapore.
          Their language, clock and searches do more to make them local than the address does.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-mono text-[10px] text-ink-faint tracking-[.1em]">
          WHAT THEY CARE ABOUT · {draft.interests.length}/{MAX_INTERESTS}
        </legend>
        {INTEREST_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 flex-none text-ink-faint text-xs">{group.label}</span>
            {group.tags.map((tag) => (
              <Chip
                key={tag.id}
                on={draft.interests.includes(tag.id)}
                colour={draft.colour}
                onClick={() => toggle("interests", tag.id)}
              >
                {tag.id}
              </Chip>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 flex-none text-ink-faint text-xs">Yours</span>
          {customTags.map((tag) => (
            <Chip key={tag} on colour={draft.colour} onClick={() => toggle("interests", tag)}>
              {tag} ×
            </Chip>
          ))}
          <input
            aria-label="Add your own interest"
            className="w-40 rounded-full border border-rule border-dashed bg-transparent px-3 py-0.5 text-xs focus:border-ink focus:outline-none"
            placeholder="add your own…"
            value={custom}
            maxLength={60}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addCustom()
              }
            }}
          />
        </div>
        {draft.interests.length > 0 && <QueryPreview draft={draft} />}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-mono text-[10px] text-ink-faint tracking-[.1em]">
          WHERE THEY READ
        </legend>
        <div className="flex flex-wrap gap-2">
          {CHARACTER_SOURCES.map((s) => (
            <label
              key={s.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                draft.sources.includes(s.id) ? "border-ink bg-surface" : "border-rule"
              } ${s.ready ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
            >
              <input
                type="checkbox"
                disabled={!s.ready}
                checked={draft.sources.includes(s.id)}
                onChange={() => toggle("sources", s.id)}
              />
              <span>{s.label}</span>
              <span className="text-ink-faint text-xs">{s.note}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending || !dirty || !draft.name.trim() || draft.sources.length === 0}
          className="rounded-full bg-ink px-5 py-2 font-medium text-paper text-sm disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : persona ? "Save changes" : "Add to cast"}
        </button>
        {save.isError && <span className="text-signal-red text-xs">{errorText(save.error)}</span>}
        {save.isSuccess && !dirty && <span className="text-signal-green text-xs">Saved.</span>}
      </div>
    </form>
  )
}

function Chip({
  on,
  colour,
  onClick,
  children,
}: {
  on: boolean
  colour: string
  onClick: () => void
  children: string | string[]
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
        on ? "border-ink text-ink" : "border-rule text-ink-muted hover:border-ink-faint"
      }`}
      style={on ? { background: `${colour}55` } : undefined}
    >
      {children}
    </button>
  )
}

/** What each interest becomes when this character types it about Bangkok. */
function QueryPreview({ draft }: { draft: Draft }) {
  return (
    <div className="rounded-lg bg-surface px-3 py-2">
      <p className="font-mono text-[10px] text-ink-faint tracking-[.1em]">
        HOW {draft.name.trim().toUpperCase() || "THEY"} WILL SEARCH BANGKOK
      </p>
      <ul className="mt-1.5 flex flex-col gap-1 text-xs">
        {draft.interests.map((interest) => {
          const asked = askAs(interest, "Bangkok", draft.locale)
          return (
            <li key={interest} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink-muted">{interest}</span>
              <span className="text-ink-faint" aria-hidden>
                →
              </span>
              {asked ? (
                <span className={asked.how === "local" ? "font-medium text-ink" : "text-ink-muted"}>
                  {asked.query}
                </span>
              ) : (
                <span className="text-ink-faint italic">translated into Thai when sent</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
