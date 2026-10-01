import { useSyncExternalStore } from "react"
import type { SlashMenu } from "./slash"

/** The `/` menu under the caret. Keyboard lives in `SlashMenu`. */
export function SlashMenuView({ menu }: { menu: SlashMenu }) {
  const state = useSyncExternalStore(menu.subscribe, menu.getState)
  if (!state.open || !state.rect || state.items.length === 0) return null
  return (
    <div
      role="listbox"
      aria-label="Research blocks"
      className="fixed z-30 w-[460px] max-w-[calc(100vw-32px)] rounded-md bg-night p-1.5 text-surface shadow-[0_20px_50px_-20px_rgba(0,0,0,.6)]"
      style={{
        left: Math.min(state.rect.left, window.innerWidth - 476),
        top: state.rect.bottom + 8,
      }}
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
          className={`flex w-full items-center gap-3.5 rounded px-3 py-2 text-left text-sm ${
            i === state.selected ? "bg-night-raised" : "hover:bg-night-raised"
          }`}
        >
          <span className="w-[104px] flex-none font-mono text-marker text-xs">{item.command}</span>
          <span className="text-surface/75">{item.description}</span>
        </button>
      ))}
    </div>
  )
}
