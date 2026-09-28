import { POSTCARD_ATTR, POSTCARD_NODE } from "@dt/core"
import { Extension, mergeAttributes, Node } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion"
import { dayLabel } from "../days"
import { type PostcardNodeOptions, PostcardView } from "./PostcardView"
import type { SlashMenu } from "./slash"
import { SLASH_ITEMS, type SlashItem } from "./slash"

/**
 * The document's one custom block (P4.1): an atom that references a Postcard by id
 * and draws it. Named in `@dt/core` so that the API's counting and the views'
 * filtering agree with what is written here.
 */
export const PostcardNode = Node.create<PostcardNodeOptions>({
  name: POSTCARD_NODE,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { store: null, city: "Bangkok", editable: true }
  },

  addAttributes() {
    return {
      [POSTCARD_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-postcard-id"),
        renderHTML: (attrs) => ({ "data-postcard-id": attrs[POSTCARD_ATTR] }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-postcard-id]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(PostcardView)
  },
})

export interface SlashOptions {
  menu: SlashMenu | null
  /** What choosing an item does; the page owns it because it owns the API calls. */
  onPick: ((item: SlashItem, props: SuggestionProps<SlashItem>) => void) | null
}

/**
 * `/` opens the Postcard menu (P4.2), anywhere a paragraph is being typed.
 *
 * Built on Tiptap's suggestion plugin, which already knows how to track a trigger
 * character, the query typed after it, and the range to replace. The menu itself
 * is a React component outside the editor that reads `SlashMenu`.
 */
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
        items: ({ query }) =>
          SLASH_ITEMS.filter((i) => i.command.slice(1).startsWith(query.toLowerCase())),
        command: ({ props }) => {
          // `props` here is the item; the range and editor arrive through `render`.
          void props
        },
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

/**
 * "Day 2" headings get their date beside them — "SUN 15" — as the canvas draws
 * them, computed from the trip's first day rather than typed, so moving the trip a
 * week moves every label with it. A decoration, not text: it is never saved into
 * the document and never gets out of step with the dates.
 */
export const DayLabels = Extension.create<{ start: () => Date | null }>({
  name: "dayLabels",

  addOptions() {
    return { start: () => null }
  },

  addProseMirrorPlugins() {
    const start = this.options.start
    return [
      new Plugin({
        key: new PluginKey("dayLabels"),
        props: {
          decorations(state) {
            const first = start()
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "heading") return
              const label = dayLabel(node.textContent, first)
              if (!label) return
              decorations.push(
                Decoration.widget(pos + node.nodeSize - 1, () => {
                  const span = document.createElement("span")
                  span.className = "day-label"
                  span.textContent = label
                  span.contentEditable = "false"
                  return span
                }),
              )
            })
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
