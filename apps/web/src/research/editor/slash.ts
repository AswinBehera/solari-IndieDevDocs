import type { BlockKind } from "@rd/research"
import type { SuggestionProps } from "@tiptap/suggestion"

/**
 * The `/` menu: one item per block kind, and its keyboard state, kept outside
 * React so the Tiptap extension can drive it and a component can draw it.
 */

export interface SlashItem {
  id: BlockKind
  command: string
  description: string
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: "comparables",
    command: "/comparables",
    description: "Games carrying every tag you pick, from Steam's store search",
  },
  {
    id: "store_snapshot",
    command: "/snapshot",
    description: "Price, reviews, tags and AI disclosure for each comparable, with screenshots",
  },
  {
    id: "slop_share",
    command: "/ai-share",
    description: "How many of those store pages disclose generative AI",
  },
  {
    id: "niche_map",
    command: "/breadth",
    description: "How wide the niche is: the lanes one tag narrower and one tag broader",
  },
  {
    id: "review_signals",
    command: "/reviews",
    description: "When players give up, how many refund, and whether reception is slipping",
  },
  {
    id: "decision",
    command: "/decision",
    description: "A design call, with the numbers it rests on attached",
  },
]

export interface SlashState {
  open: boolean
  items: readonly SlashItem[]
  selected: number
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
