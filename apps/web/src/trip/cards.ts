import type { Postcard } from "@dt/core"
import { useSyncExternalStore } from "react"
import {
  createPostcard,
  type NewPostcardInput,
  type PostcardPatchInput,
  patchPostcard,
} from "../trips/api"

/**
 * The open trip's Postcards, in memory, shared by the editor's node views and the
 * views beside it (map, timeline).
 *
 * A small external store rather than React state or the query cache, because its
 * readers are spread across React roots: Tiptap renders each node view through
 * its own renderer, and handing it a store through the extension's options works
 * wherever it ends up mounted, where a context provider might not reach.
 *
 * **Edits are optimistic.** A card changes on screen at once and the PATCH follows;
 * a failed PATCH puts the card back and says so through `lastError`. Payload edits
 * — typing into a note — are debounced per card, the same way the document is.
 */
export class CardStore {
  private readonly cards = new Map<string, Postcard>()
  private readonly listeners = new Set<() => void>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private revision = 0
  lastError: string | null = null

  constructor(
    private readonly tripId: string,
    initial: readonly Postcard[],
    private readonly payloadDelay = 600,
  ) {
    for (const card of initial) this.cards.set(card.id, card)
  }

  get(id: string): Postcard | undefined {
    return this.cards.get(id)
  }

  all(): Postcard[] {
    return [...this.cards.values()]
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Changes whenever any card does; what a view over all of them subscribes to. */
  getRevision = (): number => this.revision

  async create(input: NewPostcardInput): Promise<Postcard> {
    const card = await createPostcard(this.tripId, input)
    this.put(card)
    return card
  }

  /** Change a card now and save it now. For discrete edits: a pin, a day, a refresh. */
  async patch(id: string, patch: PostcardPatchInput, local: Partial<Postcard>): Promise<void> {
    const before = this.cards.get(id)
    if (!before) return
    this.put({ ...before, ...local })
    try {
      this.put(await patchPostcard(id, patch))
      this.lastError = null
    } catch (e) {
      this.put(before)
      this.lastError = e instanceof Error ? e.message : String(e)
      this.emit()
    }
  }

  /** Change a card's payload now and save it once the typing stops. */
  editPayload(id: string, payload: unknown): void {
    const before = this.cards.get(id)
    if (!before) return
    this.put({ ...before, payload })
    const pending = this.timers.get(id)
    if (pending) clearTimeout(pending)
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        patchPostcard(id, { payload })
          .then(() => {
            this.lastError = null
          })
          .catch((e: unknown) => {
            this.lastError = e instanceof Error ? e.message : String(e)
            this.emit()
          })
      }, this.payloadDelay),
    )
  }

  private put(card: Postcard) {
    this.cards.set(card.id, card)
    this.emit()
  }

  private emit() {
    this.revision++
    for (const fn of this.listeners) fn()
  }
}

/** One card, re-rendering only when it changes. */
export function useCard(store: CardStore, id: string): Postcard | undefined {
  return useSyncExternalStore(store.subscribe, () => store.get(id))
}

/** Every card, for the views that read them all. */
export function useCards(store: CardStore): Postcard[] {
  useSyncExternalStore(store.subscribe, store.getRevision)
  return store.all()
}
