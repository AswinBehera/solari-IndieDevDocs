import { POSTCARD_ATTR } from "@dt/core"
import { parseStayUrl } from "@dt/travel-pack/price/parse"
import {
  type ChecklistItem,
  ChecklistPostcard,
  DealStubs,
  LinkPostcard,
  linkKind,
  MissingPostcard,
  NotePostcard,
  PhotoPostcard,
  PlacePostcard,
  ProviderPricesPostcard,
  providerOf,
} from "@dt/ui"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useState } from "react"
import { type CardStore, useCard } from "../cards"
import { DEAL_HUNTER, type Offer, offersOf, useDeals, useOffers, viewpointOf } from "../offers"
import { frameFor, placeFromPayload, readPlace, snapshotOf } from "../places"

/**
 * One Postcard block in the document: the node holds an id, this draws the card
 * that id names, from the trip's card store, with the edits each kind allows.
 *
 * The store and the city arrive through the node extension's options rather than
 * a React context, for the reason `CardStore` gives.
 */
export interface PostcardNodeOptions {
  store: CardStore | null
  city: string
  /** Read-only views (the share page) draw the same cards with no controls. */
  editable: boolean
}

export function PostcardView({ node, extension, deleteNode }: ReactNodeViewProps) {
  const options = extension.options as PostcardNodeOptions
  const id = String(node.attrs[POSTCARD_ATTR] ?? "")
  return (
    <NodeViewWrapper className="my-[18px]" data-postcard-id={id}>
      {options.store ? (
        <Card id={id} store={options.store} editable={options.editable} onRemove={deleteNode} />
      ) : (
        <MissingPostcard />
      )}
    </NodeViewWrapper>
  )
}

export function Card({
  id,
  store,
  editable,
  onRemove,
}: {
  id: string
  store: CardStore
  editable: boolean
  onRemove?: () => void
}) {
  const card = useCard(store, id)
  const [refreshing, setRefreshing] = useState(false)
  if (!card) return <MissingPostcard {...(editable && onRemove ? { onRemove } : {})} />

  const payload = (card.payload ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "")

  switch (card.kind) {
    case "place": {
      const snap = placeFromPayload(card.payload)
      if (!snap) return <MissingPostcard {...(editable && onRemove ? { onRemove } : {})} />
      const refresh = async () => {
        if (!card.placeId) return
        setRefreshing(true)
        try {
          const fresh = await readPlace(card.placeId)
          const payload = snapshotOf(fresh.place, fresh.evidence, new Date())
          const geo = fresh.place.geo
          await store.patch(
            id,
            { payload, geo, state: card.state === "pinned" ? "pinned" : "fresh" },
            { payload, geo },
          )
        } finally {
          setRefreshing(false)
        }
      }
      const togglePin = () => {
        const state = card.state === "pinned" ? "fresh" : "pinned"
        void store.patch(id, { state }, { state })
      }
      return (
        <PlacePostcard
          id={id}
          place={snap.place}
          evidence={snap.evidence}
          state={card.state}
          bbox={frameFor(snap.place.city, snap.place.geo)}
          {...(editable ? { onRefresh: refresh, onTogglePin: togglePin, refreshing } : {})}
        />
      )
    }
    case "note":
      return (
        <NotePostcard
          id={id}
          text={text("text")}
          {...(editable
            ? { onChange: (t: string) => store.editPayload(id, { ...payload, text: t }) }
            : {})}
        />
      )
    case "checklist": {
      const items = Array.isArray(payload.items) ? (payload.items as ChecklistItem[]) : []
      return (
        <ChecklistPostcard
          id={id}
          items={items}
          {...(editable
            ? {
                onChange: (next: ChecklistItem[]) =>
                  store.editPayload(id, { ...payload, items: next }),
              }
            : {})}
        />
      )
    }
    case "link": {
      const url = text("url")
      const kind = linkKind(url)
      return (
        <LinkPostcard
          id={id}
          url={url}
          kind={kind}
          {...(editable
            ? { onChangeUrl: (u: string) => store.editPayload(id, { ...payload, url: u }) }
            : {})}
        />
      )
    }
    case "photo":
      return (
        <PhotoPostcard
          id={id}
          image={text("image") || null}
          caption={text("caption")}
          geo={card.geo}
          takenAt={card.time ? card.time.start.toISOString() : null}
          {...(editable
            ? { onChangeCaption: (c: string) => store.editPayload(id, { ...payload, caption: c }) }
            : {})}
        />
      )
    case "price":
      return <PriceCardLive id={id} payload={payload} editable={editable} store={store} />
  }
}

interface PriceProps {
  id: string
  payload: Record<string, unknown>
  editable: boolean
  store: CardStore
}

/** The API's own rule, run on paste, so an unsupported link is refused before Check. */
function stayUrlRefusal(url: string): string | null {
  const r = parseStayUrl(url, new Date())
  return r.ok ? null : `${r.reason.charAt(0).toUpperCase()}${r.reason.slice(1)}.`
}

function PriceCardLive({ id, payload, editable, store }: PriceProps) {
  const offers = offersOf(payload)
  const viewpoint = viewpointOf(payload)
  // Written in the new shape whatever the card was saved as, so a legacy
  // `{url, probeId}` becomes one offer the first time it changes.
  const save = (next: Offer[]) => {
    const { url: _u, probeId: _p, ...rest } = payload
    store.editPayload(id, { ...rest, offers: next, viewpoint })
  }
  const { rows, verdict, checking, error, check } = useOffers({
    offers,
    viewpoint,
    editable,
    onChange: save,
  })
  const providers = [
    ...new Set(offers.map((o) => providerOf(o.url)?.id).filter((p): p is string => !!p)),
  ]
  const deals = useDeals(providers)
  return (
    <ProviderPricesPostcard
      id={id}
      viewpoint={viewpoint}
      rows={rows}
      verdict={verdict}
      checking={checking}
      error={error}
      {...(check ? { onCheck: check } : {})}
      {...(editable
        ? {
            onAddUrl: (u: string) => save([...offers, { url: u, probeId: null }]),
            validateUrl: (u: string) =>
              offers.some((o) => o.url === u)
                ? "That link is already on the card."
                : stayUrlRefusal(u),
          }
        : {})}
    >
      {providers.length > 0 && deals.data && (
        <DealStubs
          deals={deals.data.deals}
          searched={deals.data.searched}
          hunter={{ name: DEAL_HUNTER.name, href: `/locals?persona=${DEAL_HUNTER.id}` }}
        />
      )}
    </ProviderPricesPostcard>
  )
}
