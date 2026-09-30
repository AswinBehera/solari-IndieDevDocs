import { BLOCK_ATTR, BLOCK_NODE, FACT_ATTR, FACT_NODE } from "@rd/research"
import { Extension, mergeAttributes, Node } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion"
import { BlockCard } from "./BlockCard"
import { FactChip } from "./FactChip"
import { SLASH_ITEMS, type SlashItem, type SlashMenu } from "./slash"

/**
 * A research block in the document: an atom holding only the block's id. Its
 * parameters, runs and facts live in the database, so the document can be saved on
 * every keystroke without ever carrying (or overwriting) an answer.
 */
export const ResearchBlockNode = Node.create({
  name: BLOCK_NODE,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      [BLOCK_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-block-id"),
        renderHTML: (attrs) => ({ "data-block-id": attrs[BLOCK_ATTR] }),
      },
    }
  },
  parseHTML: () => [{ tag: "div[data-block-id]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes)],
  addNodeView() {
    return ReactNodeViewRenderer(BlockCard)
  },
})

/**
 * A cited fact inside a sentence. Holds the fact's id and nothing else, so the
 * printed value is always the fact's, never a copy the writer could edit.
 */
export const FactChipNode = Node.create({
  name: FACT_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      [FACT_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-fact-id"),
        renderHTML: (attrs) => ({ "data-fact-id": attrs[FACT_ATTR] }),
      },
    }
  },
  parseHTML: () => [{ tag: "span[data-fact-id]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes)],
  addNodeView() {
    return ReactNodeViewRenderer(FactChip, { as: "span" })
  },
})

export interface SlashOptions {
  menu: SlashMenu | null
  onPick: ((item: SlashItem, props: SuggestionProps<SlashItem>) => void) | null
}

/** `/` opens the block menu, anywhere a paragraph is being typed. */
export const SlashCommand = Extension.create<SlashOptions>({
  name: "slashCommand",

  addOptions() {
    return { menu: null, onPick: null }
  },

  addProseMirrorPlugins() {
    const { menu, onPick } = this.options
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("slashCommand"),
        items: ({ query }) => {
          const q = query.toLowerCase()
          return SLASH_ITEMS.filter((i) => i.command.slice(1).startsWith(q) || i.id.startsWith(q))
        },
        command: () => {},
        render: () => ({
          onStart: (props) => menu?.open(props, (item) => onPick?.(item, props)),
          onUpdate: (props) => menu?.update(props, (item) => onPick?.(item, props)),
          onKeyDown: (props: SuggestionKeyDownProps) => menu?.keyDown(props.event) ?? false,
          onExit: () => menu?.close(),
        }),
      }),
    ]
  },
})
