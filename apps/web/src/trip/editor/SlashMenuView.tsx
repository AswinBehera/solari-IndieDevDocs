import { useSyncExternalStore } from "react"
import type { SlashMenu } from "./slash"

/** The `/` menu under the caret, dark as the canvas draws it. Keyboard lives in `SlashMenu`. */
export function SlashMenuView({ menu }: { menu: SlashMenu }) {
  const state = useSyncExternalStore(menu.subscribe, menu.getState)
  if (!state.open || !state.rect || state.items.length === 0) return null
  return (
    <div
      role="listbox"
      aria-label="Postcards"
      className="fixed z-30 w-[420px] max-w-[calc(100vw-32px)] bg-ink p-1.5 text-surface shadow-[0_20px_50px_-20px_rgba(0,0,0,.6)]"
      style={{ left: state.rect.left, top: state.rect.bottom + 8 }}
    >
      {state.items.map((item, i) => (
        <button
          type="button"
          role="option"
          aria-selected={i === state.selected}
          key={item.id}
          // mousedown, not click: a click lets the editor lose its selection first.
          onMouseDown={(e) => {
            e.preventDefault()
            menu.choose(item)
          }}
          className={`flex w-full items-center gap-3.5 px-3 py-[9px] text-left text-sm ${
            i === state.selected ? "bg-accent-blue" : "hover:bg-accent-blue"
          }`}
        >
          <span className="w-[92px] flex-none font-mono text-accent-pink text-xs">
            {item.command}
          </span>
          <span className="text-surface/75">{item.description}</span>
        </button>
      ))}
    </div>
  )
}
