// The api's changing values (Reactive in define.ts): a function for what it is now, `.on` to hear
// each change. Whoever owns the value calls `notify()` after it changed.
import type { Reactive } from '../define.ts'

export function reactive<T>(get: () => T): Reactive<T> & { notify(): void } {
  const listeners = new Set<(value: T) => void>()
  const value = (() => get()) as Reactive<T> & { notify(): void }
  value.on = fn => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }
  value.notify = () => {
    const now = get()
    for (const fn of [...listeners]) fn(now)
  }
  return value
}
