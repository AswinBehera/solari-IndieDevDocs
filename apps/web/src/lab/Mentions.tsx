import { useState } from "react"
import { useMentions } from "./queries"
import type { Mention, ResolutionState } from "./types"
import { asPlaceMention, RESOLUTION_STATES } from "./types"
import { errorText, Field, inputClass, Note, Section } from "./ui"

/**
 * What the extract stage claimed, next to the post it claimed it about (P2.2).
 *
 * **This is not a "places found" column**, which the note on `Lab` forbids. The
 * question this section asks is an engine question — did the extractor read the
 * item correctly — and the only way to answer it is to put the claim and its
 * evidence on one line. A place name with no quote and no link is not reviewable,
 * and a screen that cannot be used to catch the extractor being wrong is not
 * measuring anything. The moment this grows a ranking, a map or a "best of", it
 * has crossed over and should move to the product.
 *
 * **The quote is rendered verbatim and never truncated.** The pack caps it at 200
 * characters precisely so it can be shown whole, and a reviewer comparing a claim
 * against a post needs the span the model actually copied, ellipsis-free — a
 * paraphrase in the middle of a citation is the exact failure this page exists to
 * catch.
 *
 * **Unrecognised payloads are shown, not skipped.** `mentions.payload` is written
 * by whichever pack version ran, so rows predating a schema change genuinely have
 * a different shape. Those render as raw JSON with their version, because a row
 * this screen cannot read is the most interesting row on it.
 */

const SENTIMENT_COLOUR: Record<string, string> = {
  positive: "text-emerald-700",
  mixed: "text-amber-700",
  negative: "text-red-600",
}

export function Mentions() {
  const [resolution, setResolution] = useState<ResolutionState | "">("")
  const [rawItemId, setRawItemId] = useState("")

  const mentions = useMentions({
    domainId: "travel",
    ...(resolution ? { resolution } : {}),
    ...(rawItemId.trim() ? { rawItemId: rawItemId.trim() } : {}),
  })

  return (
    <Section
      title="What the extractor found"
      hint="Newest first, capped at 100. Every row is a claim and the span of text it came from — read them against each other."
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="resolution">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={resolution}
              onChange={(e) => setResolution(e.target.value as ResolutionState | "")}
            >
              <option value="">any</option>
              {RESOLUTION_STATES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="raw item id (one post's mentions)">
          {(id) => (
            <input
              id={id}
              className={`${inputClass} w-80`}
              value={rawItemId}
              onChange={(e) => setRawItemId(e.target.value)}
              placeholder="blank for all"
            />
          )}
        </Field>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {mentions.isPending && <Note tone="muted">loading…</Note>}
        {mentions.error && <Note tone="error">{errorText(mentions.error)}</Note>}
        {mentions.data?.length === 0 && (
          <Note tone="muted">
            No mentions. Either the extract stage has not run over this corpus, or it read every
            item and found nothing to name — which is the ordinary outcome for most of them.
          </Note>
        )}
        {mentions.data?.map((m) => (
          <MentionRow key={m.id} mention={m} />
        ))}
      </div>
    </Section>
  )
}

function MentionRow({ mention }: { mention: Mention }) {
  const place = asPlaceMention(mention.payload)

  return (
    <article className="rounded border border-neutral-200 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {place ? (
          <>
            <span className="font-medium">{place.localName}</span>
            {place.romanName && <span className="text-neutral-500">{place.romanName}</span>}
            <span className="text-neutral-400 text-xs">{place.category}</span>
            {place.dish && <span className="text-neutral-600 text-xs">for {place.dish}</span>}
            {place.priceHint && <span className="text-neutral-500 text-xs">{place.priceHint}</span>}
          </>
        ) : (
          <span className="text-amber-700 text-xs">
            payload does not match this app's schema (pack version {mention.packVersion})
          </span>
        )}
      </div>

      {place ? (
        // `lang` so a browser picks the right font for Thai rather than falling
        // back to whatever happens to have the glyphs.
        <blockquote
          lang={mention.item.languageGuess ?? undefined}
          className="mt-2 border-neutral-200 border-l-2 pl-2 text-neutral-700"
        >
          {place.quote}
        </blockquote>
      ) : (
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-neutral-600 text-xs">
          {JSON.stringify(mention.payload, null, 2)}
        </pre>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-500 text-xs">
        {place && (
          <>
            <span className={SENTIMENT_COLOUR[place.sentiment] ?? "text-neutral-500"}>
              {place.sentiment}
            </span>
            <span>reads {place.creatorReads}</span>
          </>
        )}
        <span>confidence {mention.confidence.toFixed(2)}</span>
        <span>{mention.resolution}</span>
        <span>{mention.item.sourceId}</span>
        {/* The link is the whole review loop: a claim you cannot go and check is
            not evidence, it is an assertion with a number next to it. */}
        <a
          href={mention.item.url}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-neutral-300"
        >
          {mention.item.title ?? "source"}
        </a>
      </div>
    </article>
  )
}
