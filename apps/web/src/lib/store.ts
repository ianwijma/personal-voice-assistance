import { useRef, useSyncExternalStore } from "react"
import { type Action, type ClientState, initialState, reducer } from "./state.ts"

/**
 * A minimal external store: the Effect connection layer and the audio engine
 * dispatch into it; React reads it through `useStoreSelector`, so a component
 * re-renders only when the slice it selects changes.
 */
export interface Store<S, A> {
  readonly get: () => S
  readonly subscribe: (listener: () => void) => () => void
  readonly dispatch: (action: A) => void
}

export const createStore = <S, A>(initial: S, reduce: (s: S, a: A) => S): Store<S, A> => {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch: (action) => {
      const next = reduce(state, action)
      if (next === state) return
      state = next
      for (const l of listeners) l()
    }
  }
}

export type ClientStore = Store<ClientState, Action>

export const createClientStore = (initial: ClientState = initialState): ClientStore => createStore(initial, reducer)

/** Shallow equality for arrays and plain objects, for selectors that build a new value. */
export const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/**
 * Subscribe a component to a slice of the store. The selector's result is
 * cached per store state, and `isEqual` keeps the previous result when a new
 * one is equal (so selectors may build objects or arrays).
 */
export const useStoreSelector = <S, A, T>(
  store: Store<S, A>,
  selector: (s: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T => {
  const cache = useRef<{ state: S; selector: (s: S) => T; value: T } | null>(null)
  const getSnapshot = () => {
    const state = store.get()
    const prev = cache.current
    if (prev !== null && prev.state === state && prev.selector === selector) return prev.value
    const value = selector(state)
    if (prev !== null && isEqual(prev.value, value)) {
      cache.current = { state, selector, value: prev.value }
      return prev.value
    }
    cache.current = { state, selector, value }
    return value
  }
  // The third argument is the server snapshot, used when Next prerenders the page.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
