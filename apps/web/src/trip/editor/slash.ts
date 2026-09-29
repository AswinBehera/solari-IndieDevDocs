import type { SuggestionProps } from "@tiptap/suggestion"

/**
 * The `/` menu's items and its state (P4.2), kept outside React so the Tiptap
 * extension can drive it and a component can draw it.
 *
 * The descriptions are the canvas's, except where the canvas describes something
 * not built: `/link` does not yet turn a video into a Place (P4.7), and `/price`
 * does not yet watch anything (Phase 3), so they say what they do today.
 */

export interface SlashItem {
  id: "place" | "note" | "photo" | "checklist" | "link" | "price"
  command: string
  description: string
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: "place",
    command: "/place",
    description: "Find a place — the ones locals talk about come first",
  },
  { id: "note", command: "/note", description: "A plain note block" },
  {
    id: "photo",
    command: "/photo",
    description: "Upload a photo; where and when it was taken become a pin",
  },
  { id: "checklist", command: "/checklist", description: "Things to do before or during" },
  { id: "link", command: "/link", description: "Paste a URL and keep it with the plan" },
  {
    id: "price",
    command: "/price",
    description: "Paste a hotel link; compare what 7 countries are charged",
  },
]

export interface SlashState {
  open: boolean
  items: readonly SlashItem[]
  selected: number
  /** Where the caret is, for placing the menu under it. */
  rect: DOMRect | null
}

const CLOSED: SlashState = { open: false, items: [], selected: 0, rect: null }

export class SlashMenu {
  private state: SlashState = CLOSED
  private pick: ((item: SlashItem) => void) | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getState = (): SlashState => this.state

  open(props: SuggestionProps<SlashItem>, pick: (item: SlashItem) => void) {
    this.pick = pick
    this.set({ open: true, items: props.items, selected: 0, rect: props.clientRect?.() ?? null })
  }

  update(props: SuggestionProps<SlashItem>, pick: (item: SlashItem) => void) {
    this.pick = pick
    const selected = Math.min(this.state.selected, Math.max(0, props.items.length - 1))
    this.set({ open: true, items: props.items, selected, rect: props.clientRect?.() ?? null })
  }

  /** True when the menu used the key, so the editor must not also act on it. */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.state.open) return false
    const n = this.state.items.length
    if (event.key === "Escape") {
      this.close()
      return true
    }
    if (n === 0) return false
    if (event.key === "ArrowDown") {
      this.set({ ...this.state, selected: (this.state.selected + 1) % n })
      return true
    }
    if (event.key === "ArrowUp") {
      this.set({ ...this.state, selected: (this.state.selected + n - 1) % n })
      return true
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = this.state.items[this.state.selected]
      if (item) this.choose(item)
      return true
    }
    return false
  }

  choose(item: SlashItem) {
    const pick = this.pick
    this.close()
    pick?.(item)
  }

  close() {
    this.pick = null
    this.set(CLOSED)
  }

  private set(s: SlashState) {
    this.state = s
    for (const fn of this.listeners) fn()
  }
}
