import { cityLanguage, INTEREST_GROUPS, LANGUAGE_NAME, localQuery } from "@dt/travel-pack/interests"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useCreateTrip } from "../trips/api"
import { Failure } from "../trips/TripsHome"
import { type Answers, CITIES, DATE_ORDER, dateProblem, newTripFrom } from "./answers"

/**
 * First trip, three questions, one sentence (P6.1) — read off the canvas's
 * ONBOARDING screen, where the answers build a sentence rather than fill a form:
 * "I'm going to Bangkok from 14 Nov to 17 Nov, and I care about food and markets."
 *
 * The third step's tags are the pack's (`interests.ts`), and each shows what a
 * local would type for it, because that is what the characters on `/samsara`
 * will search: the traveller picks in English and the city is read in its own
 * language. The chosen tags sit in the sentence; the full set sits under it.
 */

const HINTS = [
  "Bangkok knows the most so far. Tokyo is just getting started.",
  "Dates can change later. Leave them empty if you do not know yet.",
  "Our local characters search for these in the city's language. They also become the document's first line.",
]

const pill = (on: boolean) =>
  `cursor-pointer border-[1.5px] px-3 py-1 font-body text-lg leading-tight ${
    on
      ? "border-accent-pink bg-accent-pink text-white"
      : "border-[#c9c3b4] text-ink hover:border-ink"
  }`

/** Today as a date input writes it, in the traveller's own zone. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const dateInput =
  "border-accent-pink border-b-2 bg-transparent px-1 font-body text-[0.6em] text-ink focus:outline-none focus-visible:bg-accent-pink/10"

export function Onboarding() {
  const [step, setStep] = useState(1)
  const [answers, setAnswers] = useState<Answers>({
    city: "Bangkok",
    start: null,
    end: null,
    interests: ["food", "markets"],
  })
  const create = useCreateTrip()
  const navigate = useNavigate()

  const toggle = (interest: string) =>
    setAnswers((a) => ({
      ...a,
      interests: a.interests.includes(interest)
        ? a.interests.filter((i) => i !== interest)
        : [...a.interests, interest],
    }))

  const problem = step >= 2 ? dateProblem(answers, localDay(new Date())) : null

  const next = () => {
    if (problem) return
    if (step < 3) {
      setStep(step + 1)
      return
    }
    create.mutate(newTripFrom(answers), {
      onSuccess: (body) => navigate({ to: "/trips/$tripId", params: { tripId: body.trip.id } }),
    })
  }

  return (
    <main className="flex flex-1 items-center justify-center px-8 py-16">
      <div className="w-full max-w-[760px]">
        <p className="mb-7 font-mono text-[11px] text-ink-faint tracking-[.1em]">
          FIRST TRIP · THREE QUESTIONS · {step} OF 3
        </p>
        <div className="font-display text-[46px] leading-[1.25] tracking-tight [text-wrap:pretty]">
          I’m going to{" "}
          <span className="mx-1.5 inline-flex gap-1.5 align-baseline">
            {CITIES.map((city) => (
              <button
                key={city}
                type="button"
                className={pill(answers.city === city)}
                aria-pressed={answers.city === city}
                onClick={() => setAnswers((a) => ({ ...a, city }))}
              >
                {city}
              </button>
            ))}
          </span>
          {step >= 2 && (
            <span>
              from{" "}
              <input
                type="date"
                aria-label="first day"
                aria-invalid={problem !== null && problem !== DATE_ORDER}
                className={dateInput}
                min={localDay(new Date())}
                value={answers.start ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, start: e.target.value || null }))}
              />{" "}
              to{" "}
              <input
                type="date"
                aria-label="last day"
                aria-invalid={problem === DATE_ORDER}
                className={dateInput}
                value={answers.end ?? ""}
                min={answers.start ?? undefined}
                onChange={(e) => setAnswers((a) => ({ ...a, end: e.target.value || null }))}
              />
              ,{" "}
            </span>
          )}
          {step >= 3 && (
            <>
              <span>and I care about</span>
              <span className="mx-1.5 inline-flex flex-wrap gap-1.5 align-baseline">
                {answers.interests.length === 0 && <span className="text-ink-faint">…</span>}
                {answers.interests.map((interest) => (
                  <button
                    key={interest}
                    type="button"
                    className={pill(true)}
                    aria-label={`Remove ${interest}`}
                    onClick={() => toggle(interest)}
                  >
                    {interest}
                  </button>
                ))}
              </span>
              <span>.</span>
            </>
          )}
        </div>
        {step >= 3 && (
          <InterestPicker city={answers.city} chosen={answers.interests} onToggle={toggle} />
        )}
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={next}
            disabled={create.isPending || problem !== null}
            className="bg-ink px-5 py-3 font-medium text-sm text-surface hover:bg-accent-blue disabled:opacity-50"
          >
            {step < 3 ? "Next" : create.isPending ? "Opening…" : "Open the document"}
          </button>
          {problem ? (
            <span role="alert" className="text-[13px] text-signal-red">
              {problem}
            </span>
          ) : (
            <span className="text-[13px] text-ink-faint">{HINTS[step - 1]}</span>
          )}
        </div>
        {create.isError && (
          <div className="mt-6">
            <Failure error={create.error} />
          </div>
        )}
      </div>
    </main>
  )
}

/**
 * Every tag, grouped, each with the local search it becomes. The local line is
 * the search minus the city's name, which every one of them repeats.
 */
function InterestPicker({
  city,
  chosen,
  onToggle,
}: {
  city: string
  chosen: readonly string[]
  onToggle: (interest: string) => void
}) {
  const lang = cityLanguage(city)
  return (
    <div className="mt-8 flex flex-col gap-3 border-rule border-t pt-6">
      {lang && (
        <p className="font-mono text-[10px] text-ink-faint tracking-[.1em]">
          PICK IN ENGLISH · LOCALS SEARCH IN {LANGUAGE_NAME[lang.language].toUpperCase()}
        </p>
      )}
      {INTEREST_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-wrap items-start gap-1.5">
          <span className="w-14 flex-none pt-1.5 font-mono text-[11px] text-ink-faint">
            {group.label.toUpperCase()}
          </span>
          {group.tags.map((tag) => {
            const on = chosen.includes(tag.id)
            const local = lang
              ? (localQuery(tag.id, city) ?? "").replace(lang.name, "").replace(/\s+/g, " ").trim()
              : ""
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(tag.id)}
                className={`flex flex-col items-start border px-2.5 py-1 text-left leading-tight transition ${
                  on
                    ? "border-accent-pink bg-accent-pink text-white"
                    : "border-[#c9c3b4] text-ink hover:border-ink"
                }`}
              >
                <span className="text-sm">{tag.id}</span>
                {local && (
                  <span
                    lang={lang?.language}
                    className={`text-[11px] ${on ? "text-white/85" : "text-ink-faint"}`}
                  >
                    {local}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
