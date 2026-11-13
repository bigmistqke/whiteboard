import { createSignal, For, Show, onSettled } from 'solid-js'
import { solid } from '@visualize/solid'
import type { Item } from './index'

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
      <div class={['vz-gallery', { 'vz-wide': !props.narrow }]} style={{ '--vz-gallery-min': props.min ?? '240px' }}>
        <For each={props.items}>
          {(item, i) => (
            <figure class="vz-gallery-item">
              <Show when={item.src}>
                <button type="button" class="vz-gallery-thumb" onClick={() => setOpen(i())}>
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
          <div class="vz-lightbox" onClick={e => e.target === e.currentTarget && setOpen(null)}>
            <img src={item().src ?? ''} alt={item().alt} />
            <div class="vz-lightbox-caption" innerHTML={item().title ?? ''} />
            <Show when={props.items.length > 1}>
              <button type="button" class="vz-lightbox-prev" aria-label="Previous" onClick={() => step(-1)}>‹</button>
              <button type="button" class="vz-lightbox-next" aria-label="Next" onClick={() => step(1)}>›</button>
            </Show>
            <button type="button" class="vz-lightbox-close" aria-label="Close" onClick={() => setOpen(null)}>×</button>
          </div>
        )}
      </Show>
    </>
  )
}

export default solid(Gallery)
