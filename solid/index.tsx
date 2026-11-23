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
import type { ClientApi, FormStatus, Listener, Mount, Reactive, Theme, WbEvent } from '@bigmistqke/whiteboard'

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
  /** the agents waiting for answers on this page. Reactive. */
  listeners(): Listener[]
  /** the page's named forms and where each stands. Reactive. */
  forms(): FormStatus[]
  /** the agent's messages the reader hasn't read. Reactive. */
  unread(): WbEvent[]
  /** a message's markdown as HTML, rendered by the server (see Api.markdown) */
  markdown: ClientApi['markdown']
  /** a short note in the page's corner (see Api.toast) */
  toast: ClientApi['toast']
}

const WhiteboardContext = createContext<Whiteboard>()

/** The page's events, theme, listeners, forms and unread messages, as signals. Use inside a component passed to solid(). */
export const useWhiteboard = (): Whiteboard => useContext(WhiteboardContext)

/** Turn a Solid component into a template client: `export default solid(MyComponent)`. */
export function solid<Props extends object>(Component: Component<Props>): Mount<Props> {
  return (element: HTMLElement, props: Props, api: ClientApi) =>
    render(() => {
      // each of the api's changing values (Reactive) as a signal, set on each change; what .on
      // returns stops it when the component goes
      // (boxed: a T that is a function would read as createSignal's function form)
      const signal = <T,>(value: Reactive<T>) => {
        const [get, set] = createSignal({ v: value() })
        onSettled(() => value.on(next => set({ v: next })))
        return () => get().v
      }
      const events = signal(api.events)
      const theme = signal(api.theme)
      const listeners = signal(api.listeners)
      const forms = signal(api.forms)
      const unread = signal(api.unread)
      const value: Whiteboard = {
        page: api.page,
        events,
        last: type => events().findLast(e => e.type === type),
        append: api.append,
        theme,
        listeners,
        forms,
        unread,
        markdown: api.markdown,
        toast: api.toast,
      }
      return (
        <WhiteboardContext value={value}>
          <Component {...props} />
        </WhiteboardContext>
      )
    }, element)
}
