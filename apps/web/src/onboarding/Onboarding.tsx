import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useCreateTrip } from "../trips/api"
import { Failure } from "../trips/TripsHome"
import { type Answers, CITIES, INTERESTS, newTripFrom } from "./answers"

/**
 * First trip, three questions, one sentence (P6.1) — read off the canvas's
 * ONBOARDING screen, where the answers build a sentence rather than fill a form:
 * "I'm going to Bangkok from 14 Nov to 17 Nov, and I care about food and markets."
 *
 * The canvas's third step ends on a banner promising that tonight the OS starts
 * reading the city for these interests. Nothing does that yet (P5.2), so the hint
 * says where the interests actually go.
 */

const HINTS = [
  "Bangkok and Tokyo at alpha.",
  "Dates can change later. Leave them empty if you do not know yet.",
  "They become the document's first line, where you can rewrite them.",
]

const pill = (on: boolean) =>
  `cursor-pointer border-[1.5px] px-3 py-1 font-body text-lg leading-tight ${
    on
      ? "border-accent-pink bg-accent-pink text-white"
      : "border-[#c9c3b4] text-ink hover:border-ink"
  }`

const dateInput =
  "border-accent-pink border-b-2 bg-transparent px-1 font-body text-[0.6em] text-ink focus:outline-none"

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

  const next = () => {
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
                className={dateInput}
                value={answers.start ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, start: e.target.value || null }))}
              />{" "}
              to{" "}
              <input
                type="date"
                aria-label="last day"
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
                {INTERESTS.map((interest) => (
                  <button
                    key={interest}
                    type="button"
                    className={pill(answers.interests.includes(interest))}
                    aria-pressed={answers.interests.includes(interest)}
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
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={next}
            disabled={create.isPending}
            className="bg-ink px-5 py-3 font-medium text-sm text-surface hover:bg-accent-blue disabled:opacity-50"
          >
            {step < 3 ? "Next" : create.isPending ? "Opening…" : "Open the document"}
          </button>
          <span className="text-[13px] text-ink-faint">{HINTS[step - 1]}</span>
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
