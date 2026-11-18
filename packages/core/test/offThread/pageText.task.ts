// A web page read into text with linkedom (the start-up cost of a task that imports it).
import { parseHTML } from "linkedom"

export default (html: string): string => (parseHTML(html).document.body?.textContent ?? "").replace(/\s+/g, " ").trim()
