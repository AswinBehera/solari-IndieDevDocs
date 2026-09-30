import { CHARACTER_PRESETS, type CharacterPreset } from "@dt/travel-pack/characters"
import { useEffect, useMemo, useRef, useState } from "react"
import { Compare } from "../lab/Compare"
import { usePersonas } from "../lab/queries"
import type { Persona } from "../lab/types"
import { Builder, type Draft, draftFromPersona, draftFromPreset } from "./Builder"
import { Figure } from "./Figure"
import { Outings } from "./Outings"

/**
 * Samsara, at `/samsara`: the cast of characters the app browses as.
 *
 * **This is the kernel with a face.** Every place in a trip was found by one of
 * these: a browser identity with a neighbourhood, a language, a clock and a
 * habit, sent onto YouTube, Pantip and Maps to ask what a local would ask. The
 * Lab at `/lab` is the same machinery as tables; this page is where a traveller
 * meets it, picks who to send, and sees what they brought back.
 *
 * **Presets are suggestions, not rows.** A preset becomes a persona the first time
 * it is saved, and from then on it is that persona's traits that count; the card
 * is matched back to its preset by `archetype` only to hide the "hire" copy.
 */

type Selection =
  | { kind: "persona"; id: string }
  | { kind: "preset"; index: number }
  | { kind: "new" }

export function Samsara() {
  const personas = usePersonas()
  const cast = personas.data ?? []
  // `?persona=<id>` opens on that character: the price card links here to its deal hunter.
  const [selected, setSelected] = useState<Selection | null>(() => {
    const id = new URLSearchParams(window.location.search).get("persona")
    return id ? { kind: "persona", id } : null
  })

  // A persona made in the Lab with no traits has no look, story or archetype, and
  // led the cast as a lowercase "regular". It stays in the Lab, not the cast.
  const shown = cast.filter((p) => p.traits)

  const hired = useMemo(() => new Set(cast.map((p) => p.traits?.archetype).filter(Boolean)), [cast])
  const presets = CHARACTER_PRESETS.map((preset, index) => ({ preset, index })).filter(
    ({ preset }) => !hired.has(preset.title),
  )

  const current = pick(selected, cast)

  // The editor renders below every card, far under the one just clicked, so a
  // choice looked like it did nothing. Bring it into view on each new choice.
  const editorRef = useRef<HTMLElement>(null)
  const currentKey = current?.key ?? null
  useEffect(() => {
    if (currentKey) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [currentKey])

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-7">
      <header className="max-w-3xl">
        <p className="font-mono text-[10px] text-ink-faint tracking-[.12em]">
          LOCALS · BUILT ON SOLARI
        </p>
        <h1 className="mt-1 font-display text-4xl tracking-tight sm:text-5xl">
          Send someone local
        </h1>
        <p className="mt-3 text-ink-muted text-sm leading-relaxed">
          The local scores on your places come from what these locals found. Each is a real browser
          with a neighbourhood, a language and a clock, sent logged out onto YouTube, Pantip and
          Google Maps to search the way a Bangkok local searches: in Thai. Different locals see
          different cities. Sam, the tourist, searches in English, so you can see what everyone else
          gets.
        </p>
      </header>

      <section aria-labelledby="cast-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="cast-heading" className="font-display text-2xl">
            Your locals
          </h2>
          {personas.isError && (
            <span className="text-signal-red text-xs">Could not load your locals.</span>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((p) => (
            <Card
              key={p.id}
              name={p.name}
              title={p.traits?.archetype ?? p.locality}
              bio={p.traits?.bio ?? `${p.locale} · ${p.locality}`}
              colour={p.traits?.look?.colour ?? "#d9d4c7"}
              prop={p.traits?.look?.prop}
              health={p.health}
              active={selected?.kind === "persona" && selected.id === p.id}
              onClick={() => setSelected({ kind: "persona", id: p.id })}
            />
          ))}
          <NewCard active={selected?.kind === "new"} onClick={() => setSelected({ kind: "new" })} />
        </div>
      </section>

      {presets.length > 0 && (
        <section aria-labelledby="presets-heading">
          <h2 id="presets-heading" className="font-display text-2xl">
            More locals
          </h2>
          <p className="mt-1 text-ink-muted text-sm">
            Start from one of these and change whatever you like.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 lg:grid-cols-4">
            {presets.map(({ preset, index }) => (
              <Card
                key={preset.archetype}
                name={preset.name}
                title={preset.title}
                bio={preset.bio}
                colour={preset.colour}
                prop={preset.prop}
                ghost
                active={selected?.kind === "preset" && selected.index === index}
                onClick={() => setSelected({ kind: "preset", index })}
              />
            ))}
          </div>
        </section>
      )}

      {current && (
        <section
          ref={editorRef}
          aria-label="Local"
          className="scroll-mt-20 grid gap-6 rounded-2xl border border-rule bg-paper p-5 shadow-postcard lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        >
          <Builder
            key={current.key}
            initial={current.draft}
            persona={current.persona}
            onCreated={(id) => setSelected({ kind: "persona", id })}
          />
          {current.persona ? (
            <Outings persona={current.persona} />
          ) : (
            <p className="self-center text-ink-muted text-sm">
              Add this local to send them out searching. Nothing runs until you press the button,
              and each time is at most eight searches.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="compare-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="compare-heading" className="font-display text-2xl">
            Two locals, one question
          </h2>
          <p className="mt-1 text-ink-muted text-sm">
            Pick two of your locals and a search they both made. The overlap is how much of the city
            they share; a low number is the point.
          </p>
        </div>
        <Compare noun="local" />
        <p className="text-ink-faint text-xs">
          The raw tables (drift over a week, what the extractor read, runs by source) are under{" "}
          <a href="/lab" className="underline">
            Searches
          </a>{" "}
          in the Built on Solari footer .
        </p>
      </section>
    </main>
  )
}

function pick(
  selected: Selection | null,
  cast: readonly Persona[],
): { key: string; draft: Draft; persona: Persona | null } | null {
  if (!selected) return null
  if (selected.kind === "persona") {
    const persona = cast.find((p) => p.id === selected.id)
    return persona ? { key: persona.id, draft: draftFromPersona(persona), persona } : null
  }
  if (selected.kind === "preset") {
    const preset = CHARACTER_PRESETS[selected.index] as CharacterPreset
    return { key: `preset:${preset.archetype}`, draft: draftFromPreset(preset), persona: null }
  }
  return { key: "new", draft: draftFromPreset(BLANK), persona: null }
}

const BLANK: CharacterPreset = {
  archetype: "custom",
  name: "",
  title: "",
  bio: "",
  locality: "Bangkok",
  country: "sg",
  locale: "th-TH",
  timezoneId: "Asia/Bangkok",
  interests: [],
  sources: ["youtube.search"],
  colour: "#ffc83d",
  prop: "map",
}

function Card(props: {
  name: string
  title: string
  bio: string
  colour: string
  prop?: string | undefined
  health?: Persona["health"]
  ghost?: boolean
  active: boolean
  onClick: () => void
}) {
  const unwell = props.health === "banned" || props.health === "retired"
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className="group flex flex-col text-left"
    >
      <span
        className={`relative flex aspect-[4/3] items-end justify-center overflow-hidden rounded-2xl transition ${
          props.active ? "ring-4 ring-ink ring-offset-2 ring-offset-surface" : ""
        } ${props.ghost ? "opacity-80 group-hover:opacity-100" : ""} ${unwell ? "grayscale" : ""}`}
        style={{ background: props.colour }}
      >
        <span className="translate-y-2 transition group-hover:translate-y-0">
          <Figure prop={props.prop} size={132} />
        </span>
        {props.ghost && (
          <span className="absolute top-2 right-2 rounded-full bg-paper/90 px-2 py-0.5 font-mono text-[10px] tracking-[.06em]">
            + ADD
          </span>
        )}
        {unwell && (
          <span className="absolute top-2 left-2 rounded-full bg-ink px-2 py-0.5 font-mono text-[10px] text-paper uppercase tracking-[.06em]">
            {props.health}
          </span>
        )}
      </span>
      <span className="mt-2.5 flex items-center gap-2">
        <span className="font-semibold text-[15px]">{props.name || "Unnamed"}</span>
        <span
          className="inline-block size-2 flex-none rounded-full"
          style={{ background: props.colour }}
          aria-hidden
        />
      </span>
      <span className="text-ink-muted text-xs">{props.title}</span>
      <span className="mt-1 line-clamp-2 text-ink-faint text-xs leading-snug">{props.bio}</span>
    </button>
  )
}

function NewCard({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex flex-col text-left"
    >
      <span
        className={`flex aspect-[4/3] items-center justify-center rounded-2xl border-2 border-rule border-dashed text-ink-faint transition hover:border-ink-faint hover:text-ink ${
          active ? "border-ink text-ink" : ""
        }`}
      >
        <span className="font-display text-5xl leading-none">+</span>
      </span>
      <span className="mt-2.5 font-semibold text-[15px]">Make your own</span>
      <span className="text-ink-muted text-xs">A neighbourhood, a language, a habit</span>
    </button>
  )
}
