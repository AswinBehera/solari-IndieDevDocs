import { PAPER, tiltStyle } from "@dt/ui"
import { Link } from "@tanstack/react-router"
import type { CSSProperties } from "react"
import { ApiError } from "../api"
import { type TripSummary, useTrips } from "./api"
import { dateRange, statusTag, tripLine } from "./format"

/**
 * Trips Home: every trip the owner has, as a document on a desk.
 *
 * Read off the canvas's TRIPS screen. The one deliberate departure is the line at
 * the foot of each card — the canvas has the OS reporting its nightly harvest
 * there, and nothing runs on a trip's behalf yet (P5.2), so the line says what is
 * true instead. When the daemon exists, that line is where it reports.
 */
export function TripsHome() {
  const trips = useTrips()
  return (
    <main className="mx-auto w-full max-w-[1100px] flex-1 px-6 pt-12 pb-20 sm:px-12">
      <div className="mb-8 flex flex-wrap items-end gap-5">
        <div>
          <p className="mb-2 font-mono text-[11px] text-ink-faint tracking-[.1em]">
            {trips.data
              ? `${trips.data.length} TRIP${trips.data.length === 1 ? "" : "S"}`
              : "TRIPS"}
          </p>
          <h1 className="m-0 font-display font-normal text-[44px] tracking-tight">
            Your documents.
          </h1>
        </div>
        <Link
          to="/onboarding"
          className="ml-auto bg-ink px-[18px] py-[11px] font-medium text-sm text-surface hover:bg-accent-blue"
        >
          New trip
        </Link>
      </div>

      {trips.isPending && <p className="text-ink-faint text-sm">Loading your trips…</p>}
      {trips.isError && <Failure error={trips.error} />}
      {trips.data && trips.data.length === 0 && (
        <p className="text-ink-muted text-sm">
          No trips yet.{" "}
          <Link to="/onboarding" className="text-accent-blue underline decoration-rule">
            Start one
          </Link>{" "}
          — three questions, then a document you type into.
        </p>
      )}
      {trips.data && trips.data.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
          {trips.data.map((t) => (
            <TripCard key={t.trip.id} summary={t} now={new Date()} />
          ))}
        </div>
      )}
    </main>
  )
}

function TripCard({ summary, now }: { summary: TripSummary; now: Date }) {
  const { trip } = summary
  const tag = statusTag(trip.status)
  return (
    <Link
      to="/trips/$tripId"
      params={{ tripId: trip.id }}
      style={tiltStyle(trip.id, 0.6) as CSSProperties}
      className={`block px-6 py-[22px] text-ink ${PAPER}`}
    >
      <div className="flex justify-between font-mono text-[10px] text-ink-faint tracking-[.1em]">
        <span>{dateRange(trip.startDate, trip.endDate)}</span>
        <span className={`border px-1.5 py-0.5 ${tag.className}`}>{tag.label}</span>
      </div>
      <div className="mt-3.5 font-display text-[30px] leading-[1.05] tracking-tight [text-wrap:pretty]">
        {trip.title}
      </div>
      <div className="mt-1.5 text-ink-muted text-sm">{trip.destinationCity}</div>
      <div className="mt-[22px] flex gap-4 font-mono text-[10px] text-ink-muted tracking-[.06em]">
        <span>{summary.postcards} POSTCARDS</span>
        <span>{summary.withGeo} WITH GEO</span>
      </div>
      <div className="mt-3.5 flex items-center gap-2 border-track border-t pt-3 text-[13px] text-accent-blue">
        <span className="inline-block size-2 rounded-full bg-rule" aria-hidden />
        {tripLine(trip.startDate, trip.updatedAt, now)}
      </div>
    </Link>
  )
}

/** A 403 here means sign-up has not run for this login, which is worth saying plainly. */
export function Failure({ error }: { error: Error }) {
  const text =
    error instanceof ApiError && error.status === 403
      ? "This sign-in has no account yet. Locally, `pnpm db:seed` creates the dev one."
      : error instanceof ApiError && error.status === 401
        ? "Not signed in."
        : `Could not load: ${error.message}`
  return <p className="text-signal-red text-sm">{text}</p>
}
