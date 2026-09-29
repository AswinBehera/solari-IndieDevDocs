import { POSTCARD_ATTR } from "@dt/core"
import { parseStayUrl } from "@dt/travel-pack/price/parse"
import {
  type ChecklistItem,
  ChecklistPostcard,
  LinkPostcard,
  linkKind,
  MissingPostcard,
  NotePostcard,
  PhotoPostcard,
  PlacePostcard,
  PricePostcard,
  PriceTable,
} from "@dt/ui"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { useState } from "react"
import { type CardStore, useCard } from "../cards"
import { frameFor, placeFromPayload, readPlace, snapshotOf } from "../places"
import { usePriceCheck } from "../probe"

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
        >
          {(kind === "booking" || kind === "agoda") && (
            <PriceCheckPanel
              id={id}
              url={url}
              payload={payload}
              editable={editable}
              store={store}
            />
          )}
        </LinkPostcard>
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
    case "price": {
      const url = text("url")
      let host: string | null = null
      try {
        host = url ? (new URL(url).hostname.replace(/^www\./, "").split(".")[0] ?? null) : null
      } catch {
        host = null
      }
      return (
        <PricePostcardLive
          id={id}
          url={url}
          host={host}
          payload={payload}
          editable={editable}
          store={store}
        />
      )
    }
  }
}

interface PriceProps {
  id: string
  url: string
  payload: Record<string, unknown>
  editable: boolean
  store: CardStore
}

/** The probe id lives in the card's own payload, so reopening reads it and spends nothing. */
function useCardProbe({ id, url, payload, editable, store }: PriceProps) {
  const probeId = typeof payload.probeId === "string" ? payload.probeId : null
  return usePriceCheck({
    url,
    probeId,
    editable,
    onStarted: (p) => store.editPayload(id, { ...payload, probeId: p }),
  })
}

/** The API's own rule, run on paste, so an unsupported link is refused before Check. */
function stayUrlRefusal(url: string): string | null {
  const r = parseStayUrl(url, new Date())
  return r.ok ? null : `${r.reason.charAt(0).toUpperCase()}${r.reason.slice(1)}.`
}

function PriceCheckPanel(props: PriceProps) {
  const { check, start } = useCardProbe(props)
  return <PriceTable check={check} {...(start ? { onCheck: start } : {})} />
}

function PricePostcardLive(props: PriceProps & { host: string | null }) {
  const { check, start } = useCardProbe(props)
  return (
    <PricePostcard
      id={props.id}
      url={props.url}
      host={props.host}
      check={check}
      {...(start ? { onCheck: start } : {})}
      {...(props.editable
        ? {
            onChangeUrl: (u: string) =>
              props.store.editPayload(props.id, { ...props.payload, url: u, probeId: null }),
            validateUrl: stayUrlRefusal,
          }
        : {})}
    />
  )
}
