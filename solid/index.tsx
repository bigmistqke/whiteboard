// Solid 2 adapter for whiteboard template clients.
//
//   // client.tsx
//   import { solid, useWhiteboard } from '@bigmistqke/whiteboard/solid'
//   function Chart(props) { const wb = useWhiteboard(); … }
//   export default solid(Chart)
//
// The engine only knows mount(element, props, api); this turns a component into one and exposes
// the api's events and theme as signals through context.
import { createContext, createSignal, onSettled, useContext, type Component } from 'solid-js'
import { render } from '@solidjs/web'
import type { ClientApi, Mount, Theme, WbEvent } from '@bigmistqke/whiteboard/template'

export interface Whiteboard {
  /** this page's id */
  page: string
  /** every event recorded for this page. Reactive. */
  events(): WbEvent[]
  /** the latest event of a type, e.g. the last submit of a form. Reactive. */
  last(type: string): WbEvent | undefined
  /** record an event for this page */
  append: ClientApi['append']
  /** the theme in effect. Reactive. */
  theme(): Theme
}

const WhiteboardContext = createContext<Whiteboard>()

/** The page's events and theme, as signals. Use inside a component passed to solid(). */
export const useWhiteboard = (): Whiteboard => useContext(WhiteboardContext)

/** Turn a Solid component into a template client: `export default solid(MyComponent)`. */
export function solid<Props extends object>(Component: Component<Props>): Mount<Props> {
  return (element: HTMLElement, props: Props, api: ClientApi) =>
    render(() => {
      const [events, setEvents] = createSignal<WbEvent[]>(api.events())
      const [theme, setTheme] = createSignal<Theme>(api.theme())
      onSettled(() => {
        const offEvents = api.onEvents(list => setEvents(() => list))
        const offTheme = api.onTheme(setTheme)
        return () => { offEvents(); offTheme() }
      })
      const value: Whiteboard = {
        page: api.page,
        events,
        last: type => events().findLast(e => e.type === type),
        append: api.append,
        theme,
      }
      return (
        <WhiteboardContext value={value}>
          <Component {...props} />
        </WhiteboardContext>
      )
    }, element)
}
