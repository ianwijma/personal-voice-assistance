// An RSS or Atom feed's item titles with feedsmith (the start-up cost of a task that imports it).
import { parseFeed } from "feedsmith"

export default (xml: string): ReadonlyArray<string> => {
  const { feed } = parseFeed(xml)
  const items: ReadonlyArray<{ readonly title?: unknown }> = "items" in feed && Array.isArray(feed.items) ? feed.items : "entries" in feed && Array.isArray(feed.entries) ? feed.entries : []
  return items.map((item) => (typeof item.title === "string" ? item.title : ""))
}
