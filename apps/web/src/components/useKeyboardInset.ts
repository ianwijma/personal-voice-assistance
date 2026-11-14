"use client"
import { useEffect, useState } from "react"

/**
 * How far the on-screen keyboard covers the page (iOS Safari keeps fixed and sticky elements behind it): the
 * distance between the layout viewport's bottom and the visual viewport's bottom. 0 without a keyboard.
 */
export const useKeyboardInset = () => {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  return inset
}
