// Solid 2 adapter for visualize template clients.
//
//   // client.tsx
//   import { solid, useVisualize } from '@visualize/solid'
//   function Chart(props) { const vz = useVisualize(); … }
//   export default solid(Chart)
//
// The engine only knows mount(element, props, api); this turns a component into one and exposes
// the api's events and theme as signals through context.
import { createContext, createSignal, onSettled, useContext, type Component } from 'solid-js'
import { render } from '@solidjs/web'
import type { ClientApi, Mount, Theme, VzEvent } from '@visualize/engine/template'

export interface Visualize {
  /** this page's id */
  page: string
  /** every form submission recorded for this page. Reactive. */
  events(): VzEvent[]
  /** the latest submission of a named form. Reactive. */
  lastSubmit(form: string): VzEvent | undefined
  /** the theme in effect. Reactive. */
  theme(): Theme
}

const VisualizeContext = createContext<Visualize>()

/** The page's events and theme, as signals. Use inside a component passed to solid(). */
export const useVisualize = (): Visualize => useContext(VisualizeContext)

/** Turn a Solid component into a template client: `export default solid(MyComponent)`. */
export function solid<Props extends object>(Component: Component<Props>): Mount<Props> {
  return (element: HTMLElement, props: Props, api: ClientApi) =>
    render(() => {
      const [events, setEvents] = createSignal<VzEvent[]>(api.events())
      const [theme, setTheme] = createSignal<Theme>(api.theme())
      onSettled(() => {
        const offEvents = api.onEvents(list => setEvents(() => list))
        const offTheme = api.onTheme(setTheme)
        return () => { offEvents(); offTheme() }
      })
      const value: Visualize = {
        page: api.page,
        events,
        lastSubmit: form => events().findLast(e => e.form === form),
        theme,
      }
      return (
        <VisualizeContext value={value}>
          <Component {...props} />
        </VisualizeContext>
      )
    }, element)
}
