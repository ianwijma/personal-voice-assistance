"use client"
import { useEffect, useState } from "react"

/**
 * A link to the other front end (`/` ↔ `/admin/`) that keeps this page's query (`?ws=` chooses the assistant), set
 * after hydration so the static HTML and the first render agree.
 */
export const useHref = (path: string): string => {
  const [href, setHref] = useState(path)
  useEffect(() => setHref(`${path}${window.location.search}`), [path])
  return href
}
