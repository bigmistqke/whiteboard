import { createSignal, For, Show, onSettled } from 'solid-js'
import { solid } from '@bigmistqke/whiteboard/solid'
import type { Item } from './index'

/** The lightbox's buttons, as icons: a glyph sits on its font's baseline, not in the middle of the button. */
const Icon = (props: { d: string }) => (
  <svg
    viewBox="0 0 16 16"
    width="18"
    height="18"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={props.d} />
  </svg>
)
const PREV = 'M10 3.5 5.5 8l4.5 4.5'
const NEXT = 'M6 3.5 10.5 8 6 12.5'
const CLOSE = 'M4 4l8 8M12 4l-8 8'

function Gallery(props: { items: Item[]; min: string | null; narrow: boolean }) {
  const [open, setOpen] = createSignal<number | null>(null)
  const current = () => {
    const i = open()
    return i == null ? undefined : props.items[i]
  }
  const step = (d: number) => setOpen(i => (i == null ? i : (i + d + props.items.length) % props.items.length))

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open() == null) return
      if (e.key === 'Escape') setOpen(null)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  return (
    <>
      <div class={['wb-gallery', { 'wb-wide': !props.narrow }]} style={{ '--wb-gallery-min': props.min ?? '240px' }}>
        <For each={props.items}>
          {(item, i) => (
            <figure class="wb-gallery-item">
              <Show when={item.src}>
                <button type="button" class="wb-gallery-thumb" onClick={() => setOpen(i())}>
                  <img src={item.src!} alt={item.alt} loading="lazy" />
                </button>
              </Show>
              <Show when={item.title || item.html}>
                <figcaption>
                  <Show when={item.title}>
                    <h3 innerHTML={item.title!} />
                  </Show>
                  <div innerHTML={item.html} />
                </figcaption>
              </Show>
            </figure>
          )}
        </For>
      </div>
      <Show when={current()}>
        {item => (
          <div class="wb-lightbox" onClick={e => e.target === e.currentTarget && setOpen(null)}>
            <img src={item().src ?? ''} alt={item().alt} />
            <div class="wb-lightbox-caption" innerHTML={item().title ?? ''} />
            <Show when={props.items.length > 1}>
              <button type="button" class="wb-lightbox-prev" aria-label="Previous" onClick={() => step(-1)}>
                <Icon d={PREV} />
              </button>
              <button type="button" class="wb-lightbox-next" aria-label="Next" onClick={() => step(1)}>
                <Icon d={NEXT} />
              </button>
            </Show>
            <button type="button" class="wb-lightbox-close" aria-label="Close" onClick={() => setOpen(null)}>
              <Icon d={CLOSE} />
            </button>
          </div>
        )}
      </Show>
    </>
  )
}

export default solid(Gallery)
